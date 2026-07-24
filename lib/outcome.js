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

  // FAILURE branch
  const n = (prev?.consecutive_failures ?? 0) + 1;
  // Escalating cooldown ladder (seconds): 5m → 30m → 2h → 12h → 24h (cap).
  // Deliberately aggressive — a provider that fails even once is parked 5m, and
  // a repeat-failer drops out for a full day, so pick stops re-serving a known-
  // bad agent to the consensus panel. Success resets the streak (see above).
  const ladderSeconds = [300, 1800, 7200, 43200, 86400][Math.min(n - 1, 4)];
  const ladderUntil = now + ladderSeconds;
  const cooldown_until = Math.max(ladderUntil, exhaustionResetAt ?? 0);

  const state = isExhaustion ? 'quota_exhausted' : 'errored_transient';

  const result = {
    state,
    consecutive_failures: n,
    cooldown_until,
    checked: now,
  };

  // Preserve last_used_at from previous record if present
  if (prev?.last_used_at !== undefined) {
    result.last_used_at = prev.last_used_at;
  }

  return result;
}
