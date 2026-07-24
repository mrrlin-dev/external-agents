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
