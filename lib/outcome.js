import { observedFromResponse, mergeObserved, tokenAxisCooldownFloor } from "./budget.js";

/**
 * @typedef {Object} AgentState
 * @property {string} state
 * @property {number} [consecutive_failures]
 * @property {number} [cooldown_until]
 * @property {number} [last_used_at]
 */

/**
 * @typedef {Object} Outcome
 * @property {boolean} ok
 * @property {number} [exhaustionResetAt]
 * @property {boolean} [isExhaustion]
 * @property {number} now
 */

/**
 * Compute the new agent state record after an outcome.
 * Pure function – never mutates input.
 *
 * @param {AgentState | undefined} prev
 * @param {Outcome} outcome
 * @returns {AgentState}
 */
export function nextStateAfterOutcome(prev, outcome) {
  const { ok, exhaustionResetAt, isExhaustion, now } = outcome;

  if (ok) {
    return {
      state: 'healthy',
      consecutive_failures: 0,
      checked: now,
      last_used_at: now,
    };
  }

  const preserved = prev?.last_used_at !== undefined ? { last_used_at: prev.last_used_at } : {};

  // LIMITED branch — a rate-limit OR quota exhaustion. This is "temporarily unavailable", NOT a
  // fault: it must NOT advance the failure streak (a busy/rate-limited agent is not a bad agent),
  // and it uses the RESOLVED reset DIRECTLY — no ladder floor (a precise "90s" reset must stay 90s,
  // not be rounded up to 5m). `exhaustionResetAt` is always provided here by resolveExhaustionResetAt
  // (a known reset, or a bounded provider/period fallback); the `??` is only defensive.
  if (isExhaustion) {
    return {
      state: 'quota_exhausted',
      consecutive_failures: prev?.consecutive_failures ?? 0, // unchanged — a limit is not a fault
      cooldown_until: exhaustionResetAt ?? (now + 48 * 3600),
      checked: now,
      ...preserved,
    };
  }

  // TRANSIENT fault (network blip, 5xx, timeout) — the ONLY path that climbs the failure ladder.
  // Escalating cooldown (seconds): 5m → 30m → 2h → 12h → 24h (cap). Success resets the streak.
  const n = (prev?.consecutive_failures ?? 0) + 1;
  const ladderSeconds = [300, 1800, 7200, 43200, 86400][Math.min(n - 1, 4)];
  return {
    state: 'errored_transient',
    consecutive_failures: n,
    cooldown_until: now + ladderSeconds,
    checked: now,
    ...preserved,
  };
}

/**
 * Ids that share ONE quota bucket with `entry`, and therefore go out with it.
 *
 * OpenRouter's free tier is a per-ACCOUNT daily cap, not a per-model one: every
 * `:free` model behind the same key is drawing on the same allowance. The
 * registry models it as many entries, so exhausting one left the rest looking
 * healthy, they were picked in turn, and each burned a round discovering the
 * same cap. Recorded live across four consecutive gate runs, ending in
 * "round2 re-pick found no non-openrouter strong candidates (exit 3), proceeded
 * with 2-voice floor" — the panel spent its retry re-seating an allowance that
 * was already gone.
 *
 * Deliberately narrow. It requires BOTH a provider family whose free tier is
 * account-wide AND a `:free` model on both sides, so a paid sibling on the same
 * key is untouched, and a provider that meters per key (groq's numbered keys are
 * separate allowances) is never collapsed.
 *
 * @param {{id: string, provider?: string, model?: string}} entry
 * @param {Array<{id: string, provider?: string, model?: string}>} agents
 * @returns {string[]} sibling ids, never including `entry.id`
 */
export function sharedQuotaBucketIds(entry, agents = []) {
  const ids = new Set();

  // (a) OpenRouter's account-wide free tier, matched by provider FAMILY.
  // Unchanged, and kept as its own case rather than folded into the declarative
  // rule below, because the family match is what makes it cross-key: the cap
  // belongs to the ACCOUNT, so it has to reach openrouter2's entries as well.
  const ACCOUNT_WIDE_FREE_TIER = /^openrouter/i;
  const isFree = (model) => /:free$/i.test(String(model || ""));
  if (ACCOUNT_WIDE_FREE_TIER.test(String(entry?.provider || "")) && isFree(entry?.model)) {
    for (const a of agents) {
      if (a.id === entry.id) continue;
      if (ACCOUNT_WIDE_FREE_TIER.test(String(a.provider || "")) && isFree(a.model)) ids.add(a.id);
    }
  }

  // (b) `quota_scope: shared` is NOT used here, and that is a correction.
  //
  // It looked like the obvious generalization: the field is declared on 27
  // entries, read by zero lines of code, and the openrouter rule above was
  // hardcoded right next to it. Collapsing every `shared` sibling on the same
  // provider slug would have covered groq, deepseek, ollama-cloud and
  // antigravity in one stroke.
  //
  // Live measurement says no. Auditing the three groq models behind ONE key
  // within the same second returned INDEPENDENT budgets:
  //
  //   groq-gpt-oss-20b     x-ratelimit-remaining-tokens: 7927  (spent 73)
  //   groq-qwen3.6-27b     x-ratelimit-remaining-tokens: 7988  (spent 12)
  //
  // Each bucket decremented by that model's own ping and nothing else. A shared
  // 8000-token window would have shown the second call starting from the first
  // call's remainder. So groq meters tokens per (key, model) — and marking two
  // healthy seats `quota_exhausted` because a third hit its own limit removes
  // capacity that exists, which is a direct hit on "a seat that gets handed out
  // is alive" and on "limits get spent, not admired".
  //
  // `quota_scope: shared` does not say WHICH axis is shared. It is plausibly
  // true of groq's daily `tpd: 200000` while being false of its per-minute
  // window, and this function's effect (a cooldown on every sibling) is only
  // correct for the axis that actually bit. Until an entry can state the axis,
  // inferring the collapse from that field is guessing with a cost.
  //
  // OpenRouter stays because it is not a guess: its own 429 body says
  // "Rate limit exceeded: free-models-per-day", the cap is documented as
  // per-ACCOUNT, and it was recorded costing four consecutive gate rounds.

  return [...ids];
}

// ---------------------------------------------------------------------------
// Long-horizon health: how often has this seat ever actually answered?
// ---------------------------------------------------------------------------
//
// `consecutive_failures` above is a streak, and deliberately blind to
// rate-limits — "a busy agent is not a bad agent" is the right rule and stays.
// But it means the pool had NO long memory at all: an agent that has never once
// answered was ordered exactly like one that always does, and the moment its
// cooldown lapsed it went back to the front of the queue.
//
// Measured over 8079 dispatches: 247 of them went to agents with a lifetime
// success rate under 15%, and four of those agents were at exactly ZERO —
// openrouter-gemma-4-31b-free failed 73 times out of 73, every day, for 40 days,
// because nothing anywhere recorded that it had never worked.
//
// Two mechanisms, kept separate on purpose, because conflating them is how a
// pool quietly empties itself:
//
//   QUARANTINE is a filter, and its bar is deliberately absolute — "has never
//   succeeded, in N tries". It cannot exclude anything that has ever worked, so
//   it cannot mistake an exhausted free tier for a dead model. It clears on any
//   success and on an `audit` verdict of healthy.
//
//   The success RATE is a sort key, never a filter. A seat that works 5% of the
//   time is worth trying after every seat that works 95% of the time, and worth
//   trying before an empty slot — which is what filtering on a rate would have
//   produced on a bad day, and a thinner panel is a worse panel.

// Decay applied to both counters on every attempt. 0.9 means roughly the last
// ten attempts dominate the rate while a long unbroken failure streak stays
// visible underneath — recent enough to react to a provider having a bad hour,
// long enough not to be fooled by one lucky call.
export const HEALTH_DECAY = 0.9;

// Attempts without a single success before a seat is quarantined. Eight is above
// the longest observed run of transient noise that later recovered (five, groq
// during a provider incident on 2026-08-10) and far below the 73 that
// openrouter-gemma-4-31b-free was allowed to burn.
export const QUARANTINE_AFTER_ATTEMPTS = 8;

/**
 * Fold one attempt into an agent's health block. Pure.
 *
 * @param {object|undefined} prev existing state record
 * @param {{ok: boolean, now: number}} attempt
 */
export function trackHealth(prev, { ok, now }) {
  const h = prev?.health || {};
  const attempts = (Number.isFinite(h.attempts) ? h.attempts : 0) * HEALTH_DECAY + 1;
  const successes = (Number.isFinite(h.successes) ? h.successes : 0) * HEALTH_DECAY + (ok ? 1 : 0);
  return {
    // Rounded because this is written to a human-readable JSON file on every
    // dispatch and 3.4867844010000004 helps nobody.
    attempts: Math.round(attempts * 1000) / 1000,
    successes: Math.round(successes * 1000) / 1000,
    // A plain integer, not a decayed one: the quarantine rule needs to count
    // real tries, and a decayed counter never reaches a whole number to compare.
    attempts_since_ok: ok ? 0 : (Number.isFinite(h.attempts_since_ok) ? h.attempts_since_ok : 0) + 1,
    ever_ok: Boolean(h.ever_ok) || ok,
    ...(ok ? { last_ok_at: now } : h.last_ok_at != null ? { last_ok_at: h.last_ok_at } : {}),
  };
}

/**
 * Should this seat be withheld from automatic picking?
 *
 * Returns a reason string, or null. Only ever true for a seat that has never
 * produced a single success — see the note above on why the bar is absolute.
 * An explicit dispatch by id is unaffected: naming an agent is the operator
 * saying they want that agent, and this is a routing default, not a kill switch.
 */
export function quarantineReason(record) {
  const h = record?.health;
  if (!h) return null;
  if (h.ever_ok) return null;
  const tries = Number.isFinite(h.attempts_since_ok) ? h.attempts_since_ok : 0;
  if (tries < QUARANTINE_AFTER_ATTEMPTS) return null;
  return `never answered in ${tries} attempts — run \`external-agents audit\` to re-prove it`;
}

/**
 * Coarse health band for ordering: 0 is best. Coarse on purpose — a fine-grained
 * rate would override the least-recently-used tiebreak that spreads load across
 * keys, and turn "balanced across the live models of a tier" back into "whichever
 * model is marginally luckiest gets everything".
 */
export function healthBand(record) {
  const h = record?.health;
  if (!h || !Number.isFinite(h.attempts) || h.attempts < 1) return 0; // unmeasured rides with the best
  const rate = (Number.isFinite(h.successes) ? h.successes : 0) / h.attempts;
  if (rate >= 0.8) return 0;
  if (rate >= 0.5) return 1;
  if (rate >= 0.2) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// The composition both dispatch surfaces share
// ---------------------------------------------------------------------------
//
// cli.js and server.js each carry their own verdict logic (the CLI knows about
// `needs_auth` from a CLI's own words; the server does not), and the comment in
// both has always said they must never drift. Everything AFTER the verdict —
// folding in what the response taught us, and the health counters — is identical
// by definition, so it lives here once instead of being copied twice and
// updated once.

/**
 * Attach this call's observations to a finished verdict record.
 *
 * @param {object} p
 * @param {object} p.base   the verdict record (from nextStateAfterOutcome or a surface-specific branch)
 * @param {object} p.prev   the record as it was before this dispatch
 * @param {object} p.result the dispatch result (needs responseHeaders / responseBody / output)
 * @param {boolean} p.ok
 * @param {number} p.now epoch seconds
 */
export function withObservations({ base, prev, result, ok, now }) {
  const observed = observedFromResponse({
    headers: result?.responseHeaders,
    bodyText: result?.responseBody ?? result?.output,
    now,
  });
  // NOTHING is carried forward here, deliberately, and `prev` is spread nowhere.
  //
  // Two reasons, and the second one is a bug this used to have. First,
  // nextStateAfterOutcome builds a fresh object on purpose — its success path
  // omits `cooldown_until` and `note` so a recovered agent stops being filtered
  // out of pick — and a blanket `{...prev, ...base}` would put the expired
  // cooldown straight back and strand a working seat.
  //
  // Second: `prev` was read BEFORE the dispatch ran, which may have been minutes
  // ago. Copying its `observed_limits` into the patch made the field explicitly
  // present, and an explicitly-present field is exactly what tells
  // applyCarryForward to leave well alone — so a stale ceiling would overwrite a
  // newer one recorded by a concurrent dispatch to the same agent. Preservation
  // belongs to `writeState`, which re-reads current state under the lock and is
  // therefore the only place that can see the newest value. Emitting only what
  // THIS call learned keeps the two from fighting.
  return {
    ...mergeObserved(base, observed),
    health: trackHealth(prev, { ok, now }),
  };
}

/**
 * The exhaustion reset, with the token-axis floor applied.
 *
 * `resolveExhaustionResetAt` is reactive and precise, and on azure it is precise
 * about the wrong axis: `retry-after: 1` alongside `x-ratelimit-type: Tokens`
 * and `remaining-tokens: 0` describes the request bucket while the token minute
 * is empty. Measured: 21 re-dispatches to an agent inside 60 seconds of its own
 * 429. The floor only ever makes a cooldown longer.
 *
 * @param {number|undefined} resolved what resolveExhaustionResetAt returned
 * @param {Record<string,string>|undefined} headers
 * @param {number} now epoch seconds
 */
export function floorExhaustionReset(resolved, headers, now) {
  const floorS = tokenAxisCooldownFloor(headers, now);
  if (floorS == null) return resolved;
  const floored = now + floorS;
  return resolved == null || resolved < floored ? floored : resolved;
}
