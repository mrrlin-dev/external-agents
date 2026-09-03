import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trackHealth,
  quarantineReason,
  healthBand,
  withObservations,
  floorExhaustionReset,
  nextStateAfterOutcome,
  sharedQuotaBucketIds,
  QUARANTINE_AFTER_ATTEMPTS,
} from './outcome.js';
import { pickAgents, explainEmptyPick, formatEmptyPick, BYTES_PER_TOKEN } from './pick.js';

// --- health counters --------------------------------------------------------

test('trackHealth records a success and clears the failure run', () => {
  const prev = { health: { attempts: 4, successes: 0, attempts_since_ok: 4, ever_ok: false } };
  const h = trackHealth(prev, { ok: true, now: 1000 });
  assert.equal(h.attempts_since_ok, 0);
  assert.equal(h.ever_ok, true);
  assert.equal(h.last_ok_at, 1000);
  assert.ok(h.successes > 0);
});

test('trackHealth counts a failure run as whole attempts, not decayed ones', () => {
  let rec = {};
  for (let i = 1; i <= 5; i++) rec = { health: trackHealth(rec, { ok: false, now: 1000 + i }) };
  assert.equal(rec.health.attempts_since_ok, 5, 'the quarantine rule needs real tries to count');
  assert.equal(rec.health.successes, 0);
  assert.equal(rec.health.ever_ok, false);
});

test('trackHealth never forgets that an agent once worked', () => {
  let rec = { health: trackHealth({}, { ok: true, now: 1000 }) };
  for (let i = 0; i < 40; i++) rec = { health: trackHealth(rec, { ok: false, now: 2000 + i }) };
  assert.equal(rec.health.ever_ok, true);
  assert.equal(rec.health.last_ok_at, 1000);
  assert.equal(quarantineReason(rec), null, 'a bad streak is not proof of a dead model');
});

// --- quarantine -------------------------------------------------------------

test('quarantine holds until the bar is actually reached', () => {
  let rec = {};
  for (let i = 1; i < QUARANTINE_AFTER_ATTEMPTS; i++) {
    rec = { health: trackHealth(rec, { ok: false, now: 1000 + i }) };
    assert.equal(quarantineReason(rec), null, `must not fire at ${i} attempts`);
  }
  rec = { health: trackHealth(rec, { ok: false, now: 2000 }) };
  assert.match(String(quarantineReason(rec)), /never answered in 8 attempts/);
});

test('quarantine says nothing about an unmeasured agent', () => {
  assert.equal(quarantineReason(undefined), null);
  assert.equal(quarantineReason({}), null);
});

// --- ordering ---------------------------------------------------------------

test('healthBand keeps unmeasured agents with the best, and sorts the rest coarsely', () => {
  assert.equal(healthBand(undefined), 0, 'unmeasured rides with the best');
  assert.equal(healthBand({ health: { attempts: 10, successes: 9.5 } }), 0);
  assert.equal(healthBand({ health: { attempts: 10, successes: 6 } }), 1);
  assert.equal(healthBand({ health: { attempts: 10, successes: 3 } }), 2);
  assert.equal(healthBand({ health: { attempts: 10, successes: 0.5 } }), 3);
});

// --- the regression this nearly shipped ------------------------------------

test('withObservations does NOT resurrect a cooldown the verdict deliberately dropped', () => {
  // nextStateAfterOutcome's success path omits cooldown_until on purpose, so a
  // recovered agent stops being filtered out of pick. A blanket
  // `{...prev, ...nextRec}` would put the expired cooldown straight back and
  // strand a working seat forever — caught in review, pinned here.
  const prev = {
    state: 'quota_exhausted',
    cooldown_until: 9_999_999,
    note: 'HTTP 429 Too Many Requests',
    observed_limits: { tpm: 5000, seen_at: 500 },
  };
  const base = nextStateAfterOutcome(prev, { ok: true, now: 1000 });
  const rec = withObservations({ base, prev, result: { responseHeaders: null }, ok: true, now: 1000 });

  assert.equal(rec.state, 'healthy');
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'cooldown_until'), false, 'cooldown must stay gone');
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'note'), false, 'stale note must stay gone');
  assert.equal(
    Object.prototype.hasOwnProperty.call(rec, 'observed_limits'),
    false,
    'the ledger is NOT re-emitted here — writeState carries it forward under the lock, '
    + 'because `prev` was read before the dispatch and may already be stale',
  );
  assert.equal(rec.health.ever_ok, true);
});

test('withObservations emits only what THIS call learned, so a stale prev cannot win a race', () => {
  // Copying prev.observed_limits into the patch made the field explicitly
  // present, and an explicit field is what tells applyCarryForward to stand
  // aside — so a ceiling read minutes ago would overwrite one a concurrent
  // dispatch had just measured.
  const prev = { observed_limits: { tpm: 5000, seen_at: 1 } };
  const rec = withObservations({
    base: { state: 'healthy' },
    prev,
    result: { responseHeaders: null },
    ok: true,
    now: 1000,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'observed_limits'), false);

  const learned = withObservations({
    base: { state: 'healthy' },
    prev,
    result: { responseHeaders: { 'x-ratelimit-limit-tokens': '12000' } },
    ok: true,
    now: 1000,
  });
  assert.equal(learned.observed_limits.tpm, 12000, 'a fresh measurement is emitted and wins');
});

test('withObservations folds a fresh observation onto the new verdict', () => {
  const prev = { health: { attempts: 2, successes: 2, ever_ok: true, attempts_since_ok: 0 } };
  const rec = withObservations({
    base: { state: 'healthy', checked: 1000 },
    prev,
    result: {
      responseHeaders: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '6200' },
    },
    ok: true,
    now: 1000,
  });
  assert.equal(rec.observed_limits.tpm, 8000);
  assert.equal(rec.observed_budget.remaining_tokens, 6200);
  assert.equal(rec.state, 'healthy');
});

test('floorExhaustionReset only ever lengthens a cooldown', () => {
  const now = 1000;
  const azure = {
    'retry-after': '1',
    'x-ratelimit-type': 'Tokens',
    'x-ratelimit-remaining-tokens': '0',
    'x-ratelimit-renewalperiod-tokens': '60',
    'x-ratelimit-reset-tokens': '0',
  };
  assert.equal(floorExhaustionReset(now + 1, azure, now), now + 60, 'a 1s cooldown is raised');
  assert.equal(floorExhaustionReset(now + 3600, azure, now), now + 3600, 'a longer one is left alone');
  assert.equal(floorExhaustionReset(undefined, azure, now), now + 60, 'and it can supply one');
  assert.equal(floorExhaustionReset(now + 1, {}, now), now + 1, 'no token evidence, no change');
});

// --- shared quota buckets ---------------------------------------------------

const AGENTS = [
  { id: 'groq-a', provider: 'groq', model: 'a', quota_scope: 'shared' },
  { id: 'groq-b', provider: 'groq', model: 'b', quota_scope: 'shared' },
  { id: 'groq2-a', provider: 'groq2', model: 'a', quota_scope: 'shared' },
  { id: 'gem', provider: 'google', model: 'g', quota_scope: 'per_model' },
  { id: 'or-1', provider: 'openrouter', model: 'x:free', quota_scope: 'shared' },
  { id: 'or2-1', provider: 'openrouter2', model: 'y:free', quota_scope: 'shared' },
];

test('quota_scope shared does NOT collapse siblings — measured, not assumed', () => {
  // Auditing groq's three models behind one key in the same second returned
  // INDEPENDENT budgets (remaining_tokens 7927 vs 7988, each decremented only by
  // its own ping). So groq meters per (key, model), and cooling down two healthy
  // seats because a third hit its own limit would remove capacity that exists.
  // `quota_scope: shared` never says which AXIS is shared, so it cannot drive a
  // per-sibling cooldown.
  const ids = sharedQuotaBucketIds(AGENTS[0], AGENTS);
  assert.deepEqual(ids, [], 'a shared groq entry drags nobody down');
});

test('openrouter free tier still collapses across keys, because the cap is per ACCOUNT', () => {
  const ids = sharedQuotaBucketIds(AGENTS[4], AGENTS);
  assert.ok(ids.includes('or2-1'), 'family match is deliberate here');
});

test('a per_model entry drags nobody down with it', () => {
  assert.deepEqual(sharedQuotaBucketIds(AGENTS[3], AGENTS), []);
});

// --- pick ------------------------------------------------------------------

const REG = {
  agents: [
    { id: 'small', provider: 'p1', model: 'm1', tier: 'strong', transports: { generate_new: { url: 'u' } } },
    { id: 'big', provider: 'p2', model: 'm2', tier: 'strong', transports: { generate_new: { url: 'u' } } },
  ],
};

test('pick refuses a seat whose OBSERVED ceiling cannot hold the prompt', () => {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    small: { state: 'healthy', observed_limits: { tpm: 5000, seen_at: now } },
    big: { state: 'healthy', observed_limits: { tpm: 200_000, seen_at: now } },
  };
  // 40 KB ≈ 10k tokens: impossible on the 5000 seat, fine on the other. This is
  // exactly the azure-kimi-k2-5-safe case that failed 45 times.
  const picked = pickAgents(REG, state, { n: 2, filter: { prompt_bytes: 40_000 } });
  assert.deepEqual(picked, ['big']);
});

test('pick refuses a seat whose observed BUDGET is spent, even with room in the ceiling', () => {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    small: { state: 'healthy', observed_budget: { remaining_tokens: 100, seen_at: now } },
    big: { state: 'healthy' },
  };
  assert.deepEqual(pickAgents(REG, state, { n: 2, filter: { prompt_bytes: 40_000 } }), ['big']);
});

test('pick withholds a quarantined seat and keeps the rest', () => {
  const state = {
    small: { state: 'healthy', health: { attempts: 8, successes: 0, attempts_since_ok: 8, ever_ok: false } },
    big: { state: 'healthy' },
  };
  assert.deepEqual(pickAgents(REG, state, { n: 2 }), ['big']);
});

test('pick orders by health band before least-recently-used', () => {
  // `small` is the least recently used, so plain LRU would seat it first — and
  // did, three times faster than a working seat, because failures return quickly.
  const state = {
    small: { state: 'healthy', last_used_at: 1, health: { attempts: 10, successes: 0.5, ever_ok: true } },
    big: { state: 'healthy', last_used_at: 9999, health: { attempts: 10, successes: 10, ever_ok: true } },
  };
  assert.deepEqual(pickAgents(REG, state, { n: 2 }), ['big', 'small'], 'healthy first, but both still offered');
});

test('pick keeps LRU as the tiebreak inside one health band', () => {
  const state = {
    small: { state: 'healthy', last_used_at: 1, health: { attempts: 10, successes: 10, ever_ok: true } },
    big: { state: 'healthy', last_used_at: 9999, health: { attempts: 10, successes: 9.9, ever_ok: true } },
  };
  assert.deepEqual(pickAgents(REG, state, { n: 2 }), ['small', 'big'], 'load still spreads across live seats');
});

test('an unmeasured pool is unaffected by any of this', () => {
  assert.equal(pickAgents(REG, {}, { n: 2 }).length, 2);
});

// --- an empty pick has to be able to say why ------------------------------

test('explainEmptyPick attributes each entry to the FIRST filter that rejected it', () => {
  // Raised in review as "the quarantine filter can empty the pool". It can — and
  // so could the cooldown filter long before any of this. So an empty pool is a
  // state to DESCRIBE, not one to paper over by re-offering seats that failed
  // eight times running. What was missing was the description: `pick` exited 3
  // with no output, and "all cooled down" / "all quarantined" / "your prompt is
  // bigger than every seat" are three problems with three different remedies.
  const reg = {
    agents: [
      { id: 'off', provider: 'alpha', model: 'ma', tier: 'strong', enabled: false, transports: { generate_new: { url: 'u' } } },
      { id: 'cold', provider: 'beta', model: 'mb', tier: 'strong', transports: { generate_new: { url: 'u' } } },
      { id: 'quarantined', provider: 'gamma', model: 'mc', tier: 'strong', transports: { generate_new: { url: 'u' } } },
      { id: 'toobig', provider: 'delta', model: 'md', tier: 'strong', token_limits: { tpm: 100 }, transports: { generate_new: { url: 'u' } } },
      { id: 'nobudget', provider: 'epsilon', model: 'me', tier: 'strong', transports: { generate_new: { url: 'u' } } },
    ],
  };
  const now = Math.floor(Date.now() / 1000);
  const state = {
    cold: { state: 'quota_exhausted', cooldown_until: now + 3600 },
    quarantined: { state: 'healthy', health: { attempts_since_ok: 9, ever_ok: false } },
    nobudget: { state: 'healthy', observed_budget: { remaining_tokens: 1, seen_at: now } },
  };
  const explain = explainEmptyPick(reg, state, { filter: { prompt_bytes: 40_000 } });

  assert.equal(explain.total, 5);
  assert.equal(explain.reasons['switched off'], 1);
  assert.equal(explain.reasons['cooling down (quota_exhausted)'], 1);
  assert.equal(explain.reasons['quarantined (never answered)'], 1);
  // Stated via the ratio, not as a literal: the funnel attribution is what this
  // test is about, and a magic number here re-pins the ratio by accident.
  const needs = Math.ceil(40_000 / BYTES_PER_TOKEN);
  assert.equal(explain.reasons[`prompt too large (needs ${needs} tokens)`], 1);
  assert.equal(explain.reasons['no budget left this window'], 1);
});

test('formatEmptyPick renders one actionable line', () => {
  const line = formatEmptyPick({ total: 53, reasons: { 'cooling down (quota_exhausted)': 17, 'switched off': 10 } });
  assert.match(line, /no candidates out of 53 entries/);
  assert.match(line, /17 cooling down \(quota_exhausted\); 10 switched off/);
});

test('an unmeasured seat is still offered — silence is permission, and doctor reports it instead', () => {
  // codex and the other CLI transports genuinely have no numeric ceiling (a
  // subscription allowance, not a tpm). Excluding them for lack of a measurement
  // would remove real capacity; `doctor`'s unmeasured_seat check is where that
  // gap gets surfaced.
  const reg = { agents: [{ id: 'cli', provider: 'p', model: 'm', tier: 'strong', transports: { edit_exists: { cmd: 'x' } } }] };
  assert.deepEqual(pickAgents(reg, {}, { n: 1, filter: { prompt_bytes: 90_000_000 } }), ['cli']);
});

test('a token ceiling is inherited by VOICE, so sibling keys of one model share it', () => {
  // Caught by the fixture above using p1..p5, which providerFamily collapses to
  // one family: `toobig`'s tpm was then correctly inherited by every sibling.
  // Pinning that here, because it is the behaviour that stops an oversized prompt
  // being handed to a clone of the seat that just refused it.
  const reg = {
    agents: [
      { id: 'base', provider: 'fam', model: 'shared-model', tier: 'strong', token_limits: { tpm: 100 }, transports: { generate_new: { url: 'u' } } },
      { id: 'clone', provider: 'fam2', model: 'shared-model', tier: 'strong', transports: { generate_new: { url: 'u' } } },
      { id: 'other', provider: 'fam', model: 'different-model', tier: 'strong', transports: { generate_new: { url: 'u' } } },
    ],
  };
  const picked = pickAgents(reg, {}, { n: 3, filter: { prompt_bytes: 40_000 } });
  assert.deepEqual(picked, ['other'], 'the clone inherits the ceiling; an unrelated model does not');
});
