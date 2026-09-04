// Observed rate limits and remaining budget, read off the provider's own headers.
//
// The registry's `token_limits` is a GUESS about somebody's account: a docs page
// read once, a third-party tracker, a note written by hand. The response headers
// are a MEASUREMENT of *this* key, right now, and every provider that matters
// sends them on every response — success included.
//
// Measured over 8079 dispatches (2026-07-22..08-31) before this module existed:
//   * 4 of 52 registry entries declared `tpm` at all.
//   * 251 HTTP 413s, every one of them groq, every one of them predictable —
//     `Limit 8000, Requested 10098` is in the error body.
//   * azure-kimi-k2-5-safe declared NOTHING and its headers say
//     `x-ratelimit-limit-tokens: 5000`, `renewalperiod: 60`. Every review prompt
//     sent to it was arithmetically impossible. 47% failure rate.
//   * groq-llama-3.3-70b had 59 SUCCESSES above 8000 estimated tokens — so a
//     family-wide constant of 8000 would have been wrong in the other direction.
//     Per-key truth is the only thing that is right for both of them.
//
// So: headers are captured on every path, normalized here, and stored per agent.
// `pick` reads the observation before the declaration. Nothing has to be
// maintained by hand, and a key whose tier changes re-teaches the pool by itself.

import { parseDurationToSeconds } from "./quota-reset.js";

// How long an observed BUDGET snapshot ("you have 1200 tokens left") stays
// usable. A budget is a statement about a window; once the window has turned
// over the statement is not wrong, it is simply about the past.
//
// Deliberately short. The failure mode this guards is the expensive one: a
// `remaining_tokens: 0` seen ten minutes ago on a 60-second window would take a
// perfectly healthy seat out of rotation, which is the same "stale verdict
// quietly shapes a whole session's routing" bug that ERRORED_TRANSIENT_TTL_S
// exists to prevent in state.js. When in doubt, forget the budget and let the
// call decide.
export const BUDGET_TTL_S = 120;

// How long an observed LIMIT ("your ceiling is 5000 tokens") stays usable.
// Orders of magnitude longer than a budget, because a ceiling is a property of
// the account tier, not of the minute — it changes when somebody upgrades a
// plan, not while a panel is running.
export const OBSERVED_LIMIT_TTL_S = 30 * 86400;

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

function hasAnyHeader(headers) {
  if (!headers) return false;
  if (typeof headers.forEach === "function" && typeof headers.get === "function") {
    let n = 0;
    headers.forEach(() => { n += 1; });
    return n > 0;
  }
  return Object.keys(headers).length > 0;
}

function headerGet(headers, ...keys) {
  if (!headers) return null;
  // Header objects reach us in two shapes: a plain object built by
  // Object.fromEntries (already lowercased by fetch) and, in tests, a Headers
  // instance. Normalize by lowercasing the lookup on a plain-object scan rather
  // than trusting either.
  const get = typeof headers.get === "function" ? (k) => headers.get(k) : null;
  for (const key of keys) {
    if (get) {
      const v = get(key);
      if (v != null && v !== "") return v;
      continue;
    }
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === key && v != null && v !== "") return v;
    }
  }
  return null;
}

/**
 * Absolute epoch (seconds) a reset header points at, or null.
 *
 * Providers express "when does this refill" in four mutually incompatible ways
 * and none of them says which one it is using:
 *   - a duration      groq        `x-ratelimit-reset-tokens: 7.66s`
 *   - bare seconds    azure       `x-ratelimit-reset-tokens: 12`
 *   - epoch millis    openrouter  `x-ratelimit-reset: 1788220800000`
 *   - an ISO stamp    anthropic   `anthropic-ratelimit-tokens-reset: 2026-…Z`
 * Disambiguated by magnitude and shape, in that order. A value large enough to
 * be an epoch is treated as one; anything else is a duration from now.
 */
export function resolveResetEpoch(raw, now) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const bare = num(s);
  if (bare != null && /^\d+(\.\d+)?$/.test(s)) {
    // 1e12 and up is unambiguously epoch-millis; 1e9 and up epoch-seconds.
    // Below that no real reset window reaches, so it is a duration.
    if (bare >= 1e12) return Math.floor(bare / 1000);
    if (bare >= 1e9) return Math.floor(bare);
    return now + Math.ceil(bare);
  }
  const dur = parseDurationToSeconds(s);
  return dur == null ? null : now + dur;
}

/**
 * Normalize whatever rate-limit headers a provider sent into one shape.
 *
 * Returns null when the response carried nothing usable — most CLI transports
 * and Ollama, which is fine: absence of a measurement is not a measurement of
 * zero, and every consumer below treats null as "no opinion".
 *
 * @param {Record<string,string>|Headers|null} headers
 * @param {number} now epoch seconds
 */
export function parseRateLimitHeaders(headers, now = Math.floor(Date.now() / 1000)) {
  if (!headers) return null;

  const limitTokens = num(headerGet(headers, "x-ratelimit-limit-tokens", "anthropic-ratelimit-input-tokens-limit"));
  const remainingTokens = num(headerGet(headers, "x-ratelimit-remaining-tokens", "anthropic-ratelimit-input-tokens-remaining"));
  const limitRequests = num(headerGet(headers, "x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"));
  const remainingRequests = num(headerGet(headers, "x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"));

  // OpenRouter's unsuffixed pair. It counts REQUESTS (measured: `x-ratelimit-limit: 50`
  // against an account-wide 50/day free cap), so it must never be read as a token
  // ceiling — doing so would gate every prompt over 50 tokens.
  const bareLimit = num(headerGet(headers, "x-ratelimit-limit"));
  const bareRemaining = num(headerGet(headers, "x-ratelimit-remaining"));

  const windowTokens = num(headerGet(headers, "x-ratelimit-renewalperiod-tokens"));
  const windowRequests = num(headerGet(headers, "x-ratelimit-renewalperiod-requests"));

  const resetTokens = resolveResetEpoch(
    headerGet(headers, "x-ratelimit-reset-tokens", "anthropic-ratelimit-input-tokens-reset"),
    now,
  );
  const resetRequests = resolveResetEpoch(
    headerGet(headers, "x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset", "x-ratelimit-reset"),
    now,
  );
  const retryAfter = resolveResetEpoch(headerGet(headers, "retry-after"), now);

  // Azure says which axis it rejected on. Nobody else does, so this stays
  // optional and is only ever used to make a cooldown longer, never shorter.
  const typeRaw = headerGet(headers, "x-ratelimit-type");
  const limitedAxis = typeRaw ? String(typeRaw).trim().toLowerCase() : null;

  const parsed = {
    limit_tokens: limitTokens,
    remaining_tokens: remainingTokens,
    limit_requests: limitRequests ?? bareLimit,
    remaining_requests: remainingRequests ?? bareRemaining,
    window_tokens_s: windowTokens,
    window_requests_s: windowRequests,
    reset_tokens_at: resetTokens,
    reset_requests_at: resetRequests,
    retry_after_at: retryAfter,
    limited_axis: limitedAxis,
    seen_at: now,
  };
  const hasAnything = Object.entries(parsed).some(
    ([k, v]) => v != null && k !== "seen_at",
  );
  return hasAnything ? parsed : null;
}

/**
 * `Limit 8000, Requested 10098` — the provider stating the exact ceiling in prose.
 *
 * Groq's 413 body carries both numbers, which makes a rejected oversized request
 * the single most reliable teacher in the system: it is the one response that
 * reports the true token count of a prompt we only ever estimated. Every one of
 * the 251 recorded 413s says it. Parsing it turns the most expensive class of
 * failure into the measurement that prevents the next one.
 *
 * But only when the clause is about the INPUT. Groq writes three different
 * ceilings in this one shape, and only two of them bound a prompt:
 *
 *   TPM  — combined tokens per minute.        Bounds the prompt.  Read it.
 *   ITPM — input tokens per minute.           Bounds the prompt.  Read it.
 *   OTPM — output tokens per minute.          Bounds `max_tokens`. IGNORE it.
 *
 * The OTPM message even says so — "reduce max_tokens (or the request's expected
 * output)", never "reduce your message size". Reading it as an input ceiling
 * wrote tpm=1000 over a true 7000 on two live seats, and because a stated limit
 * outranks a header, that wrong number then outranked the correct 8000 groq had
 * sent in the very same response. Nothing failed to point at it: `pick` simply
 * stopped seating anything over ~1000 tokens on seats that could hold seven
 * times that, which is the quiet failure this whole module exists to prevent.
 *
 * The axis belongs to the CLAUSE, not to the body: a message naming both axes
 * still states a real input ceiling, and rejecting the whole string on the mere
 * presence of "OTPM" would throw it away. So each `Limit N, Requested M` is
 * judged by the text that introduces it, and the first input-bearing one wins.
 * A body with no axis marker at all — every non-groq provider seen so far —
 * states one limit and it is the applicable one.
 *
 * NOTE: the OTPM number IS a real limit, just not this one's. If a `max_tokens`
 * gate is ever built it wants exactly the clause skipped here; it should read
 * the axis rather than resurrect the old undifferentiated match.
 */
const STATED_LIMIT_RE = /Limit\s+(\d+)\s*,\s*Requested\s+(\d+)/gi;
const OUTPUT_AXIS_RE = /\bOTPM\b|\boutput tokens per minute\b/i;

export function parseStatedLimit(text) {
  const s = String(text || "");
  const re = new RegExp(STATED_LIMIT_RE.source, STATED_LIMIT_RE.flags);
  let m;
  let clauseStart = 0;
  while ((m = re.exec(s)) !== null) {
    // The window from the end of the previous limit to the start of this one is
    // the clause that introduces it — where the provider names the axis.
    const introducer = s.slice(clauseStart, m.index);
    clauseStart = m.index + m[0].length;
    if (OUTPUT_AXIS_RE.test(introducer)) continue;
    const limit = Number(m[1]);
    const requested = Number(m[2]);
    if (!Number.isFinite(limit) || !Number.isFinite(requested) || limit <= 0) continue;
    return { limit, requested };
  }
  return null;
}

/**
 * Turn one dispatch's response into the state fragment it taught us.
 *
 * Two blocks, on purpose, with very different lifetimes:
 *   observed_limits — the ceiling. Long-lived, overwrites the registry guess.
 *   observed_budget — what is left of it. Short-lived, expires by BUDGET_TTL_S.
 *
 * Merging rather than replacing matters: a 429 body tells us the ceiling but its
 * headers may omit the window, while a success three seconds earlier had the
 * window and no ceiling. Neither response alone is the whole picture.
 */
export function observedFromResponse({ headers, bodyText, now = Math.floor(Date.now() / 1000) } = {}) {
  const parsed = parseRateLimitHeaders(headers, now);
  const stated = parseStatedLimit(bodyText);
  // "The provider answered" means it sent headers, not that a caller passed an
  // empty map. A real HTTP response always carries something (content-type at
  // the very least); `{}` is what a CLI transport and a synthetic caller look
  // like, and neither has told us anything about limits.
  const answered = hasAnyHeader(headers);
  if (!parsed && !stated && !answered) return null;

  const out = {};

  // ---- the ceiling -----------------------------------------------------
  // `limit_tokens` is a PER-REQUEST ceiling as well as a per-window one: groq
  // rejects `Requested 10098` against `Limit 8000` outright, before any window
  // accounting, which is exactly the check `pick` needs to make. The prose
  // number wins when both exist — it came from the request that actually got
  // measured, not from a header describing a bucket.
  const tpm = stated?.limit ?? parsed?.limit_tokens ?? null;
  const window_s = parsed?.window_tokens_s ?? null;
  // Named `request_limit`, NOT `rpm`, because the window is genuinely unknown
  // and the two are not interchangeable: groq sends
  // `x-ratelimit-limit-requests: 1000` meaning one thousand per DAY, next to
  // `x-ratelimit-limit-tokens: 8000` meaning eight thousand per MINUTE, with
  // nothing in the response saying which is which. Calling it `rpm` would read
  // as a per-minute allowance a hundred times larger than it is, and the first
  // change to gate on it would be badly wrong. Recorded for the operator to see;
  // deliberately not gated on until a provider states the window.
  const request_limit = parsed?.limit_requests ?? null;
  if (tpm != null || request_limit != null) {
    out.observed_limits = {
      ...(tpm != null ? { tpm } : {}),
      ...(request_limit != null ? { request_limit, request_window: "unknown" } : {}),
      ...(window_s != null ? { window_s } : {}),
      source: stated ? "error_body" : "headers",
      seen_at: now,
    };
  }

  // ---- what is left of it ---------------------------------------------
  if (parsed && (parsed.remaining_tokens != null || parsed.remaining_requests != null)) {
    out.observed_budget = {
      ...(parsed.remaining_tokens != null ? { remaining_tokens: parsed.remaining_tokens } : {}),
      ...(parsed.remaining_requests != null ? { remaining_requests: parsed.remaining_requests } : {}),
      ...(parsed.reset_tokens_at != null ? { reset_tokens_at: parsed.reset_tokens_at } : {}),
      ...(parsed.reset_requests_at != null ? { reset_requests_at: parsed.reset_requests_at } : {}),
      seen_at: now,
    };
  }

  // A provider that answered and said nothing about its limits has told us
  // something, and until now that something was thrown away as `null` — which
  // reads identically to "we have never asked".
  //
  // The difference matters at the point where somebody is handed a remedy.
  // `doctor` used to tell the operator to run `external-agents audit` for every
  // seat with no ceiling; for a provider that reports no rate-limit headers at
  // all that instruction can never work, so the finding returns unchanged on
  // every run with a fix that is impossible to apply — the exact "noise in a
  // daily job" this file's own header warns about. Measured on qwencloud
  // (DashScope): 23 response headers, all `x-dashscope-*`/envoy, not one
  // `x-ratelimit-*`, while the same probe reads a ceiling off azure and groq.
  //
  // Kept OUT of `observed_limits` on purpose. That block is merged field by
  // field, so writing `source: "absent"` into it would overwrite the provenance
  // of a real measurement while leaving its `tpm` in place — a record claiming a
  // number came from nowhere.
  if (!out.observed_limits && answered) out.limits_unreported = { seen_at: now };

  return Object.keys(out).length > 0 ? out : null;
}

/** Merge an observation into an existing record without losing the other half of it. */
export function mergeObserved(prev, observed) {
  if (!observed) return prev ?? {};
  const base = prev ?? {};
  const retired = observed.observed_limits && base.limits_unreported ? { limits_unreported: undefined } : {};
  return {
    ...base,
    ...retired,
    ...(observed.observed_limits
      ? { observed_limits: { ...(base.observed_limits || {}), ...observed.observed_limits } }
      : {}),
    // A ceiling arriving retires the "this provider reports nothing" marker: the
    // provider evidently does report something, and a stale marker would keep
    // steering the operator to a hand-declared limit they no longer need.
    ...(observed.limits_unreported && !base.observed_limits ? { limits_unreported: observed.limits_unreported } : {}),
    // A budget REPLACES rather than merges: half of an old snapshot spliced onto
    // half of a new one describes a moment that never happened.
    ...(observed.observed_budget ? { observed_budget: observed.observed_budget } : {}),
  };
}

/**
 * The token ceiling to gate a prompt against, and where it came from.
 *
 * Observation beats declaration. That ordering is the whole point of this module:
 * `groq-llama-3.3-70b` succeeded 59 times above the 8000 its family was assumed
 * to have, and `azure-kimi-k2-5-safe` failed 45 times below a ceiling nobody had
 * written down. One rule gets both right, and neither needed a human to notice.
 *
 * A declared limit is still used when nothing has been observed yet — a fresh
 * install has no measurements and must not therefore be unlimited.
 */
export function effectiveTokenCeiling(entry, record, inheritedLimits, now = Math.floor(Date.now() / 1000)) {
  const obs = record?.observed_limits;
  if (obs && Number.isFinite(obs.tpm) && now - (obs.seen_at ?? 0) < OBSERVED_LIMIT_TTL_S) {
    return { tpm: obs.tpm, source: obs.source === "error_body" ? "observed_body" : "observed_headers" };
  }
  const declared = entry?.token_limits || inheritedLimits || null;
  if (declared && Number.isFinite(declared.tpm)) return { tpm: declared.tpm, source: "declared" };
  return { tpm: null, source: "none" };
}

/**
 * Does this seat's remaining budget still hold `needTokens`?
 *
 * Returns a reason string when the seat should be skipped, or null to allow it.
 * Silence is permission: a seat with no measurement, or a measurement whose
 * window has already turned over, is NOT blocked. Only a fresh observation that
 * positively says "there is not enough left" removes a candidate — the opposite
 * would let one stale zero empty the pool.
 */
export function budgetBlocks(record, needTokens, now = Math.floor(Date.now() / 1000)) {
  const b = record?.observed_budget;
  if (!b) return null;
  if (now - (b.seen_at ?? 0) >= BUDGET_TTL_S) return null;

  if (Number.isFinite(b.remaining_tokens) && Number.isFinite(needTokens)) {
    const resetPassed = b.reset_tokens_at != null && now >= b.reset_tokens_at;
    if (!resetPassed && b.remaining_tokens < needTokens) {
      return `observed budget has ${b.remaining_tokens} tokens left, needs ${needTokens}`;
    }
  }
  if (Number.isFinite(b.remaining_requests) && b.remaining_requests <= 0) {
    const resetPassed = b.reset_requests_at != null && now >= b.reset_requests_at;
    if (!resetPassed) return "observed budget has 0 requests left";
  }
  return null;
}

/**
 * Cooldown floor for a rate-limit response, in seconds from now.
 *
 * The bug this fixes, measured: azure returns `retry-after: 1` together with
 * `x-ratelimit-type: Tokens`, `remaining-tokens: 0`, `renewalperiod-tokens: 60`.
 * The `1` is true about the REQUEST bucket and irrelevant — the token minute has
 * nothing left in it. Taking it literally produced a one-second cooldown, an
 * instant re-pick, and another 429: 21 re-dispatches to an agent within 60s of
 * its own rate-limit response.
 *
 * So when the provider names TOKENS as the exhausted axis, the floor is that
 * axis's own window, never the request bucket's retry-after. Returns null when
 * the headers give no reason to raise anything, leaving the existing
 * resolveExhaustionResetAt precedence untouched.
 */
export function tokenAxisCooldownFloor(headers, now = Math.floor(Date.now() / 1000)) {
  const parsed = parseRateLimitHeaders(headers, now);
  if (!parsed) return null;

  const tokensExhausted =
    parsed.limited_axis === "tokens" ||
    (parsed.remaining_tokens != null && parsed.remaining_tokens <= 0);
  if (!tokensExhausted) return null;

  // Prefer the token axis's own reset, then its declared window. A reset of 0
  // ("already refilled") is not evidence that the minute is over — azure sends
  // `reset-tokens: 0` alongside `remaining-tokens: 0` — so it falls through to
  // the window.
  if (parsed.reset_tokens_at != null && parsed.reset_tokens_at > now) {
    return parsed.reset_tokens_at - now;
  }
  if (Number.isFinite(parsed.window_tokens_s) && parsed.window_tokens_s > 0) {
    return parsed.window_tokens_s;
  }
  // Tokens are gone and the provider will not say for how long. A per-minute
  // window is the near-universal shape for a token bucket, so one minute is the
  // honest floor: long enough that the retry is not guaranteed to fail, short
  // enough that it cannot shape a session.
  return 60;
}
