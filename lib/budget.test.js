import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRateLimitHeaders,
  resolveResetEpoch,
  parseStatedLimit,
  observedFromResponse,
  mergeObserved,
  effectiveTokenCeiling,
  budgetBlocks,
  tokenAxisCooldownFloor,
  BUDGET_TTL_S,
  OBSERVED_LIMIT_TTL_S,
} from './budget.js';

// The real header set azure-kimi-k2-5-safe returned on 2026-08-31, verbatim from
// failures.jsonl. This entry declared no limits at all and failed 47% of the
// time; every number needed to prevent that is in here.
const AZURE_429 = {
  'retry-after': '1',
  'retry-after-ms': '0',
  'x-ratelimit-limit-requests': '5',
  'x-ratelimit-limit-tokens': '5000',
  'x-ratelimit-remaining-requests': '4',
  'x-ratelimit-remaining-tokens': '0',
  'x-ratelimit-renewalperiod-requests': '60',
  'x-ratelimit-renewalperiod-tokens': '60',
  'x-ratelimit-reset-requests': '12',
  'x-ratelimit-reset-tokens': '0',
  'x-ratelimit-type': 'Tokens',
};

const GROQ_429 = {
  'retry-after': '7.66',
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-requests': '997',
  'x-ratelimit-remaining-tokens': '6200',
  'x-ratelimit-reset-tokens': '7.66s',
};

// OpenRouter's unsuffixed pair. It counts REQUESTS against an account-wide
// 50/day free cap — reading it as a token ceiling would gate every prompt over
// 50 tokens, which is the whole pool.
const OPENROUTER_429 = {
  'x-ratelimit-limit': '50',
  'x-ratelimit-remaining': '0',
  'x-ratelimit-reset': '1788220800000',
};

test('resolveResetEpoch disambiguates the four shapes providers actually send', () => {
  const now = 1_788_000_000;
  assert.equal(resolveResetEpoch('7.66s', now), now + 8);          // groq duration
  assert.equal(resolveResetEpoch('12', now), now + 12);            // azure bare seconds
  assert.equal(resolveResetEpoch('1788220800000', now), 1_788_220_800); // openrouter epoch ms
  assert.equal(resolveResetEpoch('1788220800', now), 1_788_220_800);    // epoch seconds
  assert.equal(resolveResetEpoch('2026-08-31T16:00:00Z', now), 1_788_192_000); // anthropic ISO
  assert.equal(resolveResetEpoch(null, now), null);
  assert.equal(resolveResetEpoch('', now), null);
});

test('parseRateLimitHeaders reads azure, groq and openrouter without confusing the axes', () => {
  const now = 1000;
  const az = parseRateLimitHeaders(AZURE_429, now);
  assert.equal(az.limit_tokens, 5000);
  assert.equal(az.remaining_tokens, 0);
  assert.equal(az.window_tokens_s, 60);
  assert.equal(az.limited_axis, 'tokens');

  const gq = parseRateLimitHeaders(GROQ_429, now);
  assert.equal(gq.limit_tokens, 8000);
  assert.equal(gq.remaining_tokens, 6200);

  // The bare openrouter pair must land on REQUESTS, never on tokens.
  const or = parseRateLimitHeaders(OPENROUTER_429, now);
  assert.equal(or.limit_tokens, null, 'x-ratelimit-limit is not a token ceiling');
  assert.equal(or.limit_requests, 50);
  assert.equal(or.remaining_requests, 0);
});

test('parseRateLimitHeaders returns null when there is nothing to measure', () => {
  assert.equal(parseRateLimitHeaders(null), null);
  assert.equal(parseRateLimitHeaders({ 'content-type': 'application/json' }, 1000), null);
});

test('parseRateLimitHeaders accepts a Headers instance as well as a plain object', () => {
  const h = new Headers({ 'x-ratelimit-limit-tokens': '8000' });
  assert.equal(parseRateLimitHeaders(h, 1000).limit_tokens, 8000);
});

test('parseStatedLimit reads the ceiling out of a groq 413 body', () => {
  // Verbatim from a recorded 413 — the single most reliable teacher in the
  // system, because it reports the TRUE token count of a prompt we estimated.
  const body = 'Request too large for model `openai/gpt-oss-120b` in organization `org_x` '
    + 'service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 10098, '
    + 'please reduce your message size and try again.';
  assert.deepEqual(parseStatedLimit(body), { limit: 8000, requested: 10098 });
  assert.equal(parseStatedLimit('nothing here'), null);
  assert.equal(parseStatedLimit(null), null);
});

test('parseStatedLimit reads an ITPM ceiling, which gates the prompt just as TPM does', () => {
  // Verbatim from a recorded 413. Some groq models report the input budget
  // separately as ITPM instead of the combined TPM; both bound the prompt.
  const body = 'Request too large for model `qwen/qwen3.6-27b` in organization `org_x` '
    + 'service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Requested 8128, '
    + 'please reduce your message size and try again.';
  assert.deepEqual(parseStatedLimit(body), { limit: 7000, requested: 8128 });
});

test('parseStatedLimit ignores an OTPM ceiling, which bounds max_tokens and not the prompt', () => {
  // Verbatim from a recorded 429. OTPM is the OUTPUT allowance: reading it as
  // the input ceiling wrote tpm=1000 over a real 7000 on two live seats, and
  // `pick` then size-gated them at a seventh of what they could actually hold.
  // The remedy is to reduce max_tokens, not the prompt, so this teaches nothing
  // about how large a prompt may be.
  const body = 'Request too large for model `qwen/qwen3.6-27b` in organization `org_x` '
    + 'service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1434. '
    + "The request's expected output tokens exceed the enforced limit; reduce max_tokens.";
  assert.equal(parseStatedLimit(body), null);
});

test('parseStatedLimit reads the INPUT clause of a body that names several axes', () => {
  // Consensus round 1, raised independently by three reviewers: a whole-body
  // OTPM guard throws away a perfectly good input ceiling the moment the two
  // axes are named in one message. The axis belongs to the CLAUSE, not the body.
  const body = 'Request too large for model `qwen/qwen3.6-27b` on input tokens per minute '
    + '(ITPM): Limit 7000, Requested 8128; on output tokens per minute (OTPM): Limit 1000, '
    + 'Requested 1434.';
  assert.deepEqual(parseStatedLimit(body), { limit: 7000, requested: 8128 });
});

test('parseStatedLimit skips a leading OTPM clause to reach the input one behind it', () => {
  // Order must not decide it either.
  const body = 'on output tokens per minute (OTPM): Limit 1000, Requested 1434; '
    + 'on tokens per minute (TPM): Limit 8000, Requested 10098.';
  assert.deepEqual(parseStatedLimit(body), { limit: 8000, requested: 10098 });
});

test('parseStatedLimit attributes an axis named AFTER the limit, not only before it', () => {
  // Consensus round 2: a backwards-only window reads the introducer of the FIRST
  // clause as empty and accepts an output limit as an input ceiling — the exact
  // corruption this function exists to prevent, just in a different word order.
  const body = 'Limit 1000, Requested 1434 on OTPM; Limit 7000, Requested 8128 on ITPM';
  assert.deepEqual(parseStatedLimit(body), { limit: 7000, requested: 8128 });
});

test('parseStatedLimit binds each limit to its NEAREST axis marker', () => {
  // The marker that qualifies a limit is the one closest to it. Anything else
  // lets a neighbouring clause's axis leak across the separator.
  const trailing = 'Limit 1000, Requested 1434 on OTPM';
  assert.equal(parseStatedLimit(trailing), null);
  const leading = 'on output tokens per minute (OTPM): Limit 1000, Requested 1434; '
    + 'on input tokens per minute (ITPM): Limit 7000, Requested 8128';
  assert.deepEqual(parseStatedLimit(leading), { limit: 7000, requested: 8128 });
});

test('parseStatedLimit still reads an untagged body, as non-groq providers send', () => {
  // No axis marker anywhere: the only limit stated is the one that applies.
  assert.deepEqual(
    parseStatedLimit('Request too large: Limit 5000, Requested 6000'),
    { limit: 5000, requested: 6000 },
  );
});

test('observedFromResponse does not let an OTPM body overwrite a real header ceiling', () => {
  // The exact shape that poisoned the ledger: groq answers 429 with correct
  // headers AND an OTPM body. Prose wins over headers by design, so the guard
  // has to be in the parse, not in the merge.
  const headers = {
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-limit-requests': '1000',
  };
  const bodyText = 'Request too large for model `qwen/qwen3.6-27b` on output tokens per minute '
    + '(OTPM): Limit 1000, Requested 1434.';
  const o = observedFromResponse({ headers, bodyText, now: 1000 });
  assert.equal(o.observed_limits.tpm, 8000);
  assert.equal(o.observed_limits.source, 'headers');
});

test('observedFromResponse splits a long-lived ceiling from a short-lived budget', () => {
  const o = observedFromResponse({ headers: AZURE_429, now: 1000 });
  assert.equal(o.observed_limits.tpm, 5000);
  assert.equal(o.observed_limits.window_s, 60);
  assert.equal(o.observed_limits.source, 'headers');
  // Never `rpm`: groq sends limit-requests as a per-DAY number beside a
  // per-MINUTE token limit, and nothing in the response says which is which.
  assert.equal(o.observed_limits.rpm, undefined);
  assert.equal(o.observed_limits.request_limit, 5);
  assert.equal(o.observed_limits.request_window, 'unknown');
  assert.equal(o.observed_budget.remaining_tokens, 0);
  assert.equal(o.observed_budget.seen_at, 1000);
});

test('observedFromResponse prefers the stated ceiling over the header one', () => {
  // The prose number came from the request that actually got measured.
  const o = observedFromResponse({
    headers: { 'x-ratelimit-limit-tokens': '9999' },
    bodyText: 'TPM: Limit 8000, Requested 10098',
    now: 1000,
  });
  assert.equal(o.observed_limits.tpm, 8000);
  assert.equal(o.observed_limits.source, 'error_body');
});

test('observedFromResponse is null when the response taught nothing', () => {
  assert.equal(observedFromResponse({ headers: {}, bodyText: 'ok', now: 1 }), null);
  assert.equal(observedFromResponse({}), null);
});

// ---------------------------------------------------------------------------
// A provider that answers with no rate-limit headers has told us something, and
// treating it as "we have never asked" gave `doctor` a finding whose only remedy
// was to ask again. Measured on one provider in this pool: 23 response headers,
// all vendor plumbing, not one `x-ratelimit-*`.
// ---------------------------------------------------------------------------

test('a response that answers with no rate-limit headers is recorded as unreported', () => {
  const o = observedFromResponse({ headers: { 'content-type': 'application/json', 'x-vendor-requestid': 'abc' }, bodyText: 'ok', now: 7 });
  assert.ok(o, 'a real answer must teach something');
  assert.equal(o.observed_limits, undefined, 'no ceiling was reported, so none is invented');
  assert.deepEqual(o.limits_unreported, { seen_at: 7 });
});

test('an empty header map is not an answer — a CLI transport must not be marked', () => {
  assert.equal(observedFromResponse({ headers: {}, bodyText: 'ok', now: 1 }), null);
  assert.equal(observedFromResponse({ bodyText: 'ok', now: 1 }), null);
});

test('a response that DOES report a ceiling is never marked unreported', () => {
  const o = observedFromResponse({ headers: { 'x-ratelimit-limit-tokens': '8000' }, now: 3 });
  assert.equal(o.observed_limits.tpm, 8000);
  assert.equal(o.limits_unreported, undefined);
});

test('a ceiling arriving later retires the unreported marker', () => {
  const prev = mergeObserved({ state: 'healthy' }, observedFromResponse({ headers: { 'content-type': 'x' }, now: 10 }));
  assert.deepEqual(prev.limits_unreported, { seen_at: 10 });

  const next = mergeObserved(prev, observedFromResponse({ headers: { 'x-ratelimit-limit-tokens': '5000' }, now: 20 }));
  assert.equal(next.observed_limits.tpm, 5000);
  assert.equal(next.limits_unreported, undefined, 'the provider evidently does report limits after all');
});

test('the marker never overwrites the provenance of a real measurement', () => {
  const prev = { observed_limits: { tpm: 5000, source: 'headers', seen_at: 100 } };
  const next = mergeObserved(prev, observedFromResponse({ headers: { 'content-type': 'x' }, now: 200 }));
  assert.equal(next.observed_limits.tpm, 5000, 'the ceiling survives');
  assert.equal(next.observed_limits.source, 'headers', 'and so does where it came from');
  assert.equal(next.limits_unreported, undefined, 'a measured seat is not "unreported"');
});

test('mergeObserved keeps the half of the picture the new response did not carry', () => {
  const prev = {
    state: 'healthy',
    observed_limits: { tpm: 5000, window_s: 60, source: 'headers', seen_at: 100 },
  };
  // A 413 body states the ceiling but carries no window.
  const merged = mergeObserved(prev, observedFromResponse({ bodyText: 'Limit 4000, Requested 9000', now: 200 }));
  assert.equal(merged.observed_limits.tpm, 4000, 'newer ceiling wins');
  assert.equal(merged.observed_limits.window_s, 60, 'window survives from the earlier observation');
  assert.equal(merged.state, 'healthy', 'unrelated fields untouched');
});

test('mergeObserved REPLACES a budget rather than merging two moments together', () => {
  const prev = { observed_budget: { remaining_tokens: 0, remaining_requests: 9, seen_at: 100 } };
  const merged = mergeObserved(prev, { observed_budget: { remaining_tokens: 5000, seen_at: 200 } });
  assert.equal(merged.observed_budget.remaining_tokens, 5000);
  assert.equal(
    Object.prototype.hasOwnProperty.call(merged.observed_budget, 'remaining_requests'),
    false,
    'half of an old snapshot spliced onto a new one describes a moment that never happened',
  );
});

test('effectiveTokenCeiling: observation beats declaration in both directions', () => {
  const now = 10_000;
  // azure-kimi-k2-5-safe: declared nothing, really has 5000. 45 impossible dispatches.
  assert.deepEqual(
    effectiveTokenCeiling({ id: 'a' }, { observed_limits: { tpm: 5000, seen_at: now } }, null, now),
    { tpm: 5000, source: 'observed_headers' },
  );
  // groq-llama-3.3-70b: assumed 8000, succeeded 59 times above it.
  assert.deepEqual(
    effectiveTokenCeiling(
      { id: 'b', token_limits: { tpm: 8000 } },
      { observed_limits: { tpm: 12_000, seen_at: now } },
      null,
      now,
    ),
    { tpm: 12_000, source: 'observed_headers' },
  );
});

test('effectiveTokenCeiling falls back to declared, then inherited, then nothing', () => {
  const now = 10_000;
  assert.equal(effectiveTokenCeiling({ token_limits: { tpm: 8000 } }, {}, null, now).tpm, 8000);
  assert.equal(effectiveTokenCeiling({}, {}, { tpm: 250_000 }, now).tpm, 250_000);
  assert.deepEqual(effectiveTokenCeiling({}, {}, null, now), { tpm: null, source: 'none' });
});

test('effectiveTokenCeiling ignores an observation older than its TTL', () => {
  const now = 10_000_000;
  const stale = { observed_limits: { tpm: 5000, seen_at: now - OBSERVED_LIMIT_TTL_S - 1 } };
  const r = effectiveTokenCeiling({ token_limits: { tpm: 8000 } }, stale, null, now);
  assert.equal(r.tpm, 8000);
  assert.equal(r.source, 'declared');
});

test('budgetBlocks: silence is permission', () => {
  const now = 1000;
  assert.equal(budgetBlocks(undefined, 5000, now), null, 'no record');
  assert.equal(budgetBlocks({}, 5000, now), null, 'no budget block');
  // A stale zero must not be able to empty the pool.
  assert.equal(
    budgetBlocks({ observed_budget: { remaining_tokens: 0, seen_at: now - BUDGET_TTL_S } }, 5000, now),
    null,
    'expired snapshot is about the past, not about now',
  );
});

test('budgetBlocks skips a seat whose fresh budget cannot hold the prompt', () => {
  const now = 1000;
  const rec = { observed_budget: { remaining_tokens: 1200, seen_at: now - 5 } };
  assert.match(String(budgetBlocks(rec, 5000, now)), /1200 tokens left/);
  assert.equal(budgetBlocks(rec, 900, now), null, 'fits, so it is allowed');
  // No estimate given → the token axis has nothing to compare and must not guess.
  assert.equal(budgetBlocks(rec, null, now), null);
});

test('budgetBlocks honours a reset that has already passed', () => {
  const now = 1000;
  const rec = { observed_budget: { remaining_tokens: 0, reset_tokens_at: now - 1, seen_at: now - 5 } };
  assert.equal(budgetBlocks(rec, 5000, now), null, 'the window turned over');
});

test('budgetBlocks catches an account-wide request cap with no size estimate at all', () => {
  const now = 1000;
  const rec = { observed_budget: { remaining_requests: 0, seen_at: now - 5 } };
  assert.match(String(budgetBlocks(rec, null, now)), /0 requests left/);
});

test('tokenAxisCooldownFloor ignores retry-after:1 when it is the TOKEN axis that is empty', () => {
  const now = 1000;
  // The measured bug: `retry-after: 1` is true about the request bucket and
  // irrelevant — the token minute has nothing in it. Taking it literally caused
  // 21 re-dispatches inside 60s of an agent's own 429.
  assert.equal(tokenAxisCooldownFloor(AZURE_429, now), 60);
});

test('tokenAxisCooldownFloor prefers the token axis own reset when it is in the future', () => {
  const now = 1000;
  const headers = { ...AZURE_429, 'x-ratelimit-reset-tokens': '45' };
  assert.equal(tokenAxisCooldownFloor(headers, now), 45);
});

test('tokenAxisCooldownFloor stays silent when tokens are not the exhausted axis', () => {
  const now = 1000;
  assert.equal(tokenAxisCooldownFloor(GROQ_429, now), null, '6200 tokens still available');
  assert.equal(tokenAxisCooldownFloor({ 'retry-after': '1' }, now), null, 'no token evidence at all');
  assert.equal(tokenAxisCooldownFloor(null, now), null);
});

test('tokenAxisCooldownFloor falls back to a minute when the provider will not say', () => {
  assert.equal(tokenAxisCooldownFloor({ 'x-ratelimit-remaining-tokens': '0' }, 1000), 60);
});
