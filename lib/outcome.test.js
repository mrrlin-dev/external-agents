import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStateAfterOutcome } from './outcome.js';

test('success resets state and drops cooldown_until', () => {
  const prev = {
    state: 'errored_transient',
    consecutive_failures: 3,
    cooldown_until: 9999,
    last_used_at: 500,
  };
  const outcome = { ok: true, now: 1000 };

  const next = nextStateAfterOutcome(prev, outcome);

  assert.strictEqual(next.state, 'healthy');
  assert.strictEqual(next.consecutive_failures, 0);
  assert.strictEqual(next.checked, 1000);
  assert.strictEqual(next.last_used_at, 1000);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(next, 'cooldown_until'),
    false
  );
  // prev unchanged
  assert.strictEqual(prev.consecutive_failures, 3);
  assert.strictEqual(prev.cooldown_until, 9999);
});

test('ladder climbs correctly', () => {
  const now = 1000;

  // 1st failure (no prev)
  const r1 = nextStateAfterOutcome(undefined, { ok: false, now });
  assert.strictEqual(r1.state, 'errored_transient');
  assert.strictEqual(r1.consecutive_failures, 1);
  assert.strictEqual(r1.cooldown_until, now + 60);

  // 3rd consecutive failure: prev had 2 failures
  const prev = { consecutive_failures: 2, state: 'errored_transient' };
  const r3 = nextStateAfterOutcome(prev, { ok: false, now });
  assert.strictEqual(r3.consecutive_failures, 3);
  assert.strictEqual(r3.cooldown_until, now + 1800);
  assert.strictEqual(r3.state, 'errored_transient');
});

test('cap at 43200 seconds for 5th+ failure', () => {
  const prev = { consecutive_failures: 9, state: 'errored_transient' };
  const now = 2000;
  const next = nextStateAfterOutcome(prev, { ok: false, now });
  assert.strictEqual(next.consecutive_failures, 10);
  assert.strictEqual(next.cooldown_until, now + 43200);
  assert.strictEqual(next.state, 'errored_transient');
});

test('exhaustion reset honored when later than ladder', () => {
  const now = 1000;
  const exhaustionResetAt = now + 100000;
  const next = nextStateAfterOutcome(undefined, {
    ok: false,
    now,
    isExhaustion: true,
    exhaustionResetAt,
  });
  // ladder would be 60 for first fail, but exhaustionResetAt is larger
  assert.strictEqual(next.state, 'quota_exhausted');
  assert.strictEqual(next.consecutive_failures, 1);
  assert.strictEqual(next.cooldown_until, exhaustionResetAt);
});

test('ladder wins when exhaustionResetAt is sooner', () => {
  const now = 1000;
  const prev = { consecutive_failures: 3 }; // will cause 4th -> 7200 ladder
  const exhaustionResetAt = now + 10;        // much sooner
  const next = nextStateAfterOutcome(prev, {
    ok: false,
    now,
    isExhaustion: false,
    exhaustionResetAt,
  });
  // ladder = 7200, so cooldown_until = now+7200 = 8200
  assert.strictEqual(next.consecutive_failures, 4);
  assert.strictEqual(next.cooldown_until, now + 7200);
  assert.strictEqual(next.state, 'errored_transient'); // isExhaustion false
});

test('does not mutate the previous record', () => {
  const prev = {
    state: 'errored_transient',
    consecutive_failures: 5,
    cooldown_until: 99999,
  };
  Object.freeze(prev); // ensure no accidental mutation
  assert.doesNotThrow(() => {
    nextStateAfterOutcome(prev, { ok: false, now: 5000 });
  });
  assert.strictEqual(prev.consecutive_failures, 5);
  assert.strictEqual(prev.cooldown_until, 99999);
});
