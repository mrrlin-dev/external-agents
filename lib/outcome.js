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
  const ACCOUNT_WIDE_FREE_TIER = /^openrouter/i;
  const isFree = (model) => /:free$/i.test(String(model || ""));
  if (!ACCOUNT_WIDE_FREE_TIER.test(String(entry?.provider || "")) || !isFree(entry?.model)) return [];
  return agents
    .filter((a) => a.id !== entry.id)
    .filter((a) => ACCOUNT_WIDE_FREE_TIER.test(String(a.provider || "")) && isFree(a.model))
    .map((a) => a.id);
}
