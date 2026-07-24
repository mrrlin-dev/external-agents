// Quota/rate-limit RESET resolution.
//
// When an agent is exhausted we want cooldown_until to reflect the REAL reset, not a blind guess.
// This module is the single place that turns "the call that just failed" into a reset epoch
// (seconds). It is REACTIVE ONLY — it reads the failing response (headers + body) and, when the
// provider gives nothing usable, a per-provider period policy. It NEVER makes an extra/predictive
// API call.
//
// Precedence (first hit wins):
//   1. Response HEADERS from the failed HTTP call (most precise): retry-after,
//      x-ratelimit-reset-{requests,tokens}, anthropic-ratelimit-*-reset, x-ratelimit-reset.
//   2. Explicit reset in the BODY text: Google RetryInfo retryDelay, "Resets in Xh Ym",
//      "Retry-After: N", "reset in N seconds", "try again in ...".
//   3. Period policy when only a coarse period is known: monthly → +7d (billing-cycle date is
//      unknown, so a week is a safe re-check); daily → next midnight (Pacific for Google, which is
//      when its free-tier quota actually resets; UTC otherwise).
//   4. null → caller leaves it to the escalating failure ladder (lib/outcome.js).

// Google free-tier daily quotas reset at midnight America/Los_Angeles.
const GOOGLE_DAILY_TZ = "America/Los_Angeles";

/** Parse a duration string like "1m26.4s", "6m0s", "185ms", "41s", "2h30m", "90", "38.5s" → seconds. */
export function parseDurationToSeconds(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(parseFloat(s)); // bare number = seconds
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    switch (m[2].toLowerCase()) {
      case "ms": total += n / 1000; break;
      case "s": total += n; break;
      case "m": total += n * 60; break;
      case "h": total += n * 3600; break;
    }
  }
  return matched ? Math.ceil(total) : null;
}

/** Offset (ms) of `date` in `tz`, via Intl parts (DST-correct). */
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? 0 : p.hour), +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** Epoch (seconds) of the next 00:00 in `tz` after `nowMs`. */
export function nextMidnightEpoch(nowMs, tz = "UTC") {
  const now = new Date(nowMs);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, mo, d] = ymd.split("-").map(Number);
  // Next calendar day 00:00 as a naive wall-clock, then convert that wall time in `tz` → UTC.
  const nextWallUtc = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  const off = tzOffsetMs(new Date(nextWallUtc), tz);
  return Math.floor((nextWallUtc - off) / 1000);
}

/** Coarse period from an exhaustion message. */
export function parsePeriod(text) {
  const t = String(text || "");
  if (/\bmonth(ly)?\b|per\s*month|\/\s*month/i.test(t)) return "monthly";
  if (/\bdaily\b|per\s*day|\/\s*day|perday|requests?perday/i.test(t)) return "daily";
  return null;
}

const HEADER_KEYS_DURATION = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"];
const HEADER_KEYS_ABS = ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset"];

function headerGet(headers, key) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(key);
  // plain object (case-insensitive)
  const found = Object.keys(headers).find((k) => k.toLowerCase() === key);
  return found ? headers[found] : null;
}

/** Reset epoch (seconds) from response headers, or null. Takes the LATEST (max) reset found. */
export function parseResetFromHeaders(headers, nowMs = Date.now()) {
  if (!headers) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const candidates = [];

  // Retry-After: integer seconds OR an HTTP-date.
  const ra = headerGet(headers, "retry-after");
  if (ra != null) {
    const raStr = String(ra).trim();
    if (/^\d+$/.test(raStr)) candidates.push(nowSec + parseInt(raStr, 10));
    else {
      const t = Date.parse(raStr);
      if (!Number.isNaN(t)) candidates.push(Math.floor(t / 1000));
    }
  }

  // OpenAI / Groq: x-ratelimit-reset-* as a duration ("6m0s", "1m26.4s", "185ms").
  for (const k of HEADER_KEYS_DURATION) {
    const secs = parseDurationToSeconds(headerGet(headers, k));
    if (secs != null) candidates.push(nowSec + secs);
  }

  // Anthropic: absolute RFC3339 reset timestamps.
  for (const k of HEADER_KEYS_ABS) {
    const v = headerGet(headers, k);
    if (v != null) {
      const t = Date.parse(String(v));
      if (!Number.isNaN(t)) candidates.push(Math.floor(t / 1000));
    }
  }

  // OpenRouter: X-RateLimit-Reset as unix seconds or milliseconds.
  const orReset = headerGet(headers, "x-ratelimit-reset");
  if (orReset != null && /^\d+$/.test(String(orReset).trim())) {
    const n = parseInt(String(orReset).trim(), 10);
    candidates.push(n > 1e12 ? Math.floor(n / 1000) : n); // ms vs s heuristic
  }

  const future = candidates.filter((c) => c > nowSec);
  return future.length ? Math.max(...future) : null;
}

/** Explicit reset epoch (seconds) parsed from the response BODY text, or null. */
export function parseResetFromBody(text, nowMs = Date.now()) {
  const t = String(text || "");
  const nowSec = Math.floor(nowMs / 1000);

  // Google RetryInfo: "retryDelay": "41s"
  const rd = t.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?s(?:\d+ms)?|\d+(?:\.\d+)?(?:ms|m|h))"?/i);
  if (rd) { const s = parseDurationToSeconds(rd[1]); if (s != null) return nowSec + s; }

  // "Resets in Xh Ym" (Groq-style body)
  const m1 = t.match(/Resets? in\s+(\d+)h(?:\s*(\d+)m)?/i);
  if (m1) return nowSec + parseInt(m1[1], 10) * 3600 + (m1[2] ? parseInt(m1[2], 10) * 60 : 0);

  // "Retry-After: N" embedded in text
  const m2 = t.match(/Retry-After:\s*(\d+)/i);
  if (m2) return nowSec + parseInt(m2[1], 10);

  // "reset in N seconds"
  const m3 = t.match(/reset in\s+(\d+)\s+seconds?/i);
  if (m3) return nowSec + parseInt(m3[1], 10);

  // "try again in 12h34m" / "in 5 minutes" / "in 30s"
  const m4 = t.match(/try again in\s+([0-9hms.\s]+?)(?:[.,)]|$)/i);
  if (m4) { const s = parseDurationToSeconds(m4[1]); if (s != null) return nowSec + s; }
  const m5 = t.match(/in\s+(\d+)\s+minutes?/i);
  if (m5) return nowSec + parseInt(m5[1], 10) * 60;

  // "try again at <absolute date>" — GPT/codex prints an EXACT reset, e.g.
  // "try again at Jul 29th, 2026 7:20 PM." Strip the ordinal suffix (Date.parse chokes on "29th")
  // then parse; no timezone in the message → interpreted as local, which is what the CLI shows.
  const m6 = t.match(/try again at\s+(.+?)\s*\.?\s*$/im);
  if (m6) {
    const cleaned = m6[1].replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
    const ts = Date.parse(cleaned);
    if (!Number.isNaN(ts)) return Math.floor(ts / 1000);
  }

  return null;
}

const SEVEN_DAYS = 7 * 24 * 3600;

/**
 * Clamp a parsed reset epoch: a past/skewed value → null (fall back); a far-future value → capped at
 * now+7d UNLESS the exhaustion was explicitly monthly (then 7d is already the intended value).
 */
export function clampResetAt(resetAt, nowMs = Date.now(), isMonthly = false) {
  if (resetAt == null) return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (resetAt <= nowSec) return null; // past / clock skew → treat as unknown
  if (isMonthly) return resetAt;
  return Math.min(resetAt, nowSec + SEVEN_DAYS);
}

/**
 * Provider fallback cooldown for a `limited` outcome with NO parsed reset. Bounded + recheck-biased:
 * explicit monthly → +7d; google daily-style → min(next Pacific midnight, now+24h); else → now+48h.
 */
export function providerFallbackResetAt({ period, provider = "", nowMs = Date.now() } = {}) {
  const nowSec = Math.floor(nowMs / 1000);
  if (period === "monthly") return nowSec + SEVEN_DAYS;
  if (period === "daily" || provider === "google") {
    return provider === "google"
      ? Math.min(nextMidnightEpoch(nowMs, GOOGLE_DAILY_TZ), nowSec + 24 * 3600)
      : Math.min(nextMidnightEpoch(nowMs, "UTC"), nowSec + 24 * 3600);
  }
  return nowSec + 48 * 3600; // default: not a week — a truly-daily-but-unparsed limit should recheck sooner
}

/**
 * Resolve the cooldown reset epoch (seconds) for a `limited` outcome (rate-limit OR quota) from the
 * ACTUAL failing response. ALWAYS returns a usable epoch (a `limited` outcome is a real "come back
 * later", so there is always a value): a precise known reset when we can read one, otherwise a
 * bounded provider/period fallback. No predictive API calls.
 * @param {{text?: string, headers?: any, provider?: string, nowMs?: number}} input
 * @returns {number} reset epoch in seconds.
 */
export function resolveExhaustionResetAt({ text = "", headers = null, provider = "", nowMs = Date.now() } = {}) {
  const period = parsePeriod(text);
  // 1. Precise KNOWN reset — headers (HTTP) beat body text (CLI). Clamp: past→null (fall through),
  //    far-future→now+7d unless the limit was explicitly monthly.
  const known = parseResetFromHeaders(headers, nowMs) ?? parseResetFromBody(text, nowMs);
  const clamped = clampResetAt(known, nowMs, period === "monthly");
  if (clamped != null) return clamped;
  // 2. A pure RATE-LIMIT (agent merely busy) with no parsed reset → short default, NOT the long
  //    quota fallback: rate-limit wording present but no quota/usage/period wording.
  const t = String(text);
  const isRateLimitOnly =
    /rate.?limit|too many requests|\b429\b/i.test(t) &&
    !/quota|usage limit|month|per day|\/day|credit|balance|resource[ _]?exhausted/i.test(t) &&
    !period;
  if (isRateLimitOnly) return Math.floor(nowMs / 1000) + 60;
  // 3. Otherwise (quota with no parsed reset) → bounded provider/period fallback.
  return providerFallbackResetAt({ period, provider, nowMs });
}
