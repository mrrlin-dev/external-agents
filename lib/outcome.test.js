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
  assert.strictEqual(r1.cooldown_until, now + 300);

  // 3rd consecutive failure: prev had 2 failures
  const prev = { consecutive_failures: 2, state: 'errored_transient' };
  const r3 = nextStateAfterOutcome(prev, { ok: false, now });
  assert.strictEqual(r3.consecutive_failures, 3);
  assert.strictEqual(r3.cooldown_until, now + 7200);
  assert.strictEqual(r3.state, 'errored_transient');
});

test('cap at 86400 seconds for 5th+ failure', () => {
  const prev = { consecutive_failures: 9, state: 'errored_transient' };
  const now = 2000;
  const next = nextStateAfterOutcome(prev, { ok: false, now });
  assert.strictEqual(next.consecutive_failures, 10);
  assert.strictEqual(next.cooldown_until, now + 86400);
  assert.strictEqual(next.state, 'errored_transient');
});

test('LIMITED: uses resetAt directly and does NOT advance the fault streak (H1/H3/H4)', () => {
  const now = 1000;
  const prev = { consecutive_failures: 3, last_used_at: 500 };
  const next = nextStateAfterOutcome(prev, {
    ok: false, now, isExhaustion: true, exhaustionResetAt: now + 100000,
  });
  assert.strictEqual(next.state, 'quota_exhausted');
  assert.strictEqual(next.consecutive_failures, 3); // UNCHANGED — a limit is not a fault
  assert.strictEqual(next.cooldown_until, now + 100000);
  assert.strictEqual(next.last_used_at, 500);
});

test('LIMITED: a precise SHORT reset is used directly, NOT floored to the 5m ladder (H2)', () => {
  const now = 1000;
  const next = nextStateAfterOutcome(undefined, {
    ok: false, now, isExhaustion: true, exhaustionResetAt: now + 90,
  });
  assert.strictEqual(next.cooldown_until, now + 90); // not now + 300
  assert.strictEqual(next.consecutive_failures, 0);  // undefined prev → 0, unchanged
});

test('a TRANSIENT fault after a LIMITED park starts the fault streak at 1 (H4)', () => {
  const now = 1000;
  const afterLimited = nextStateAfterOutcome(undefined, {
    ok: false, now, isExhaustion: true, exhaustionResetAt: now + 7 * 24 * 3600,
  });
  assert.strictEqual(afterLimited.consecutive_failures, 0);
  const afterTransient = nextStateAfterOutcome(afterLimited, { ok: false, now: now + 10, isExhaustion: false });
  assert.strictEqual(afterTransient.consecutive_failures, 1); // not inheriting the quota park
  assert.strictEqual(afterTransient.state, 'errored_transient');
  assert.strictEqual(afterTransient.cooldown_until, now + 10 + 300);
});

test('ladder wins when exhaustionResetAt is sooner', () => {
  const now = 1000;
  const prev = { consecutive_failures: 3 }; // will cause 4th -> 43200 ladder
  const exhaustionResetAt = now + 10;        // much sooner
  const next = nextStateAfterOutcome(prev, {
    ok: false,
    now,
    isExhaustion: false,
    exhaustionResetAt,
  });
  // ladder = 43200, so cooldown_until = now+43200
  assert.strictEqual(next.consecutive_failures, 4);
  assert.strictEqual(next.cooldown_until, now + 43200);
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
