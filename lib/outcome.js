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
  const ladderSeconds = [60, 300, 1800, 7200, 43200][Math.min(n - 1, 4)];
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
