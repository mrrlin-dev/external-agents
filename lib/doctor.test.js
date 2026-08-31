import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, formatReport, providerFamilyOf, SUCCESS_FLOOR, IDLE_FLOOR } from './doctor.js';

const NOW = 1_788_200_000;
const SINCE = NOW - 86400;

const registry = {
  agents: [
    { id: 'groq-a', provider: 'groq', model: 'ma', tier: 'weak', quota_scope: 'shared',
      token_limits: { tpm: 8000, rpd: 1000 }, transports: { generate_new: { url: 'u' } } },
    { id: 'unmeasured', provider: 'azure', model: 'mz', tier: 'strong',
      transports: { generate_new: { url: 'u' } } },
    { id: 'cli-only', provider: 'anthropic', model: 'default', tier: 'strong',
      transports: { edit_exists: { cmd: 'claude' } } },
  ],
};

const row = (o) => ({ ts: NOW - 100, outcome: 'success', provider: 'groq', agent_id: 'groq-a', ...o });

test('a clean window produces no findings and exits 0', () => {
  // 60 of a 1000/day request allowance is 6%, above IDLE_FLOOR — so this window
  // is clean on all five goals rather than merely quiet.
  const rows = Array.from({ length: 60 }, () => row({}));
  const state = { 'unmeasured': { observed_limits: { tpm: 5000, seen_at: NOW } } };
  const r = runChecks({ rows, registry, state, since: SINCE, now: NOW });
  assert.deepEqual(r.findings, []);
  assert.equal(formatReport(r).exitCode, 0);
  assert.match(formatReport(r).text, /no findings/);
});

test('test fixtures are excluded so they cannot move any threshold', () => {
  // Measured: the fixtures contributed 174 guaranteed failures to a 1472 total.
  const rows = [
    ...Array.from({ length: 25 }, () => row({})),
    ...Array.from({ length: 50 }, () => row({ agent_id: 'test-failing-cli', outcome: 'error' })),
  ];
  const r = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW });
  assert.equal(r.totals.dispatches, 25);
  assert.equal(r.findings.some((f) => f.id === 'success_rate'), false);
});

test('a 413 is a high-severity finding, because the ledger should make it unreachable', () => {
  const rows = [...Array.from({ length: 30 }, () => row({})), row({ http_status: 413, outcome: 'error' })];
  const r = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW });
  const f = r.findings.find((x) => x.id === 'oversized_dispatch');
  assert.ok(f);
  assert.equal(f.severity, 'high');
  assert.equal(f.goal, 2);
  assert.match(f.remedy, /audit --provider groq/);
  assert.equal(formatReport(r).exitCode, 1);
});

test('an agent that never answers is high severity only when quarantine did NOT catch it', () => {
  const rows = Array.from({ length: 9 }, () => row({ agent_id: 'groq-a', outcome: 'error' }));

  const missed = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW })
    .findings.find((f) => f.id === 'never_answered');
  assert.equal(missed.severity, 'high', 'the mechanism itself regressed');

  const caught = runChecks({
    rows,
    registry,
    state: { 'groq-a': { health: { attempts_since_ok: 9, ever_ok: false } } },
    since: SINCE,
    now: NOW,
  }).findings.find((f) => f.id === 'never_answered');
  assert.equal(caught.severity, 'low', 'quarantine worked; these are the attempts it took');
});

test('unmeasured seats are reported, and only HTTP ones', () => {
  const r = runChecks({ rows: [], registry, state: {}, since: SINCE, now: NOW });
  const f = r.findings.find((x) => x.id === 'unmeasured_seat');
  assert.ok(f, 'the azure entry declares nothing');
  assert.equal(f.evidence.length, 1);
  assert.match(f.evidence[0], /^unmeasured \[azure\]/);
  assert.ok(!f.evidence.join().includes('cli-only'), 'a CLI seat has no headers to read');
});

test('an observed ceiling clears the unmeasured finding', () => {
  const state = { unmeasured: { observed_limits: { tpm: 5000, seen_at: NOW - 10 } } };
  const r = runChecks({ rows: [], registry, state, since: SINCE, now: NOW });
  assert.equal(r.findings.some((f) => f.id === 'unmeasured_seat'), false);
});

test('a disabled seat is not reported as unmeasured — nothing will dispatch to it', () => {
  const state = { unmeasured: { enabled: false } };
  const r = runChecks({ rows: [], registry, state, since: SINCE, now: NOW });
  assert.equal(r.findings.some((f) => f.id === 'unmeasured_seat'), false);
});

test('success rate is only judged once there is enough of a window to judge', () => {
  const few = Array.from({ length: 10 }, () => row({ outcome: 'error' }));
  const r1 = runChecks({ rows: few, registry, state: {}, since: SINCE, now: NOW });
  assert.equal(r1.findings.some((f) => f.id === 'success_rate'), false, '10 dispatches is not a trend');

  const many = Array.from({ length: 40 }, (_, i) => row({ outcome: i < 10 ? 'success' : 'error' }));
  const r2 = runChecks({ rows: many, registry, state: {}, since: SINCE, now: NOW });
  const f = r2.findings.find((x) => x.id === 'success_rate');
  assert.ok(f);
  assert.ok(r2.totals.success_rate < SUCCESS_FLOOR);
});

test('idle capacity is reported only where a per-key rpd is actually known', () => {
  // groq declares rpd 1000 and one key here → 1000/day allowed, 1 used.
  const r = runChecks({ rows: [row({})], registry, state: {}, since: SINCE, now: NOW });
  const f = r.findings.find((x) => x.id === 'idle_bucket');
  assert.ok(f, 'groq declares an rpd, so it can be measured');
  assert.equal(f.goal, 5);
  assert.equal(f.severity, 'low');
  // azure declares no rpd, so it must not appear with a made-up denominator.
  assert.equal(r.findings.filter((x) => x.id === 'idle_bucket').length, 1);
});

test('a family under token pressure is never called idle', () => {
  // groq has request headroom to spare and is throttled by an 8000-token minute.
  // Calling that spare capacity and routing more work at it is how the 413s
  // happened in the first place.
  const rows = [row({}), row({ http_status: 429, outcome: 'error' })];
  const r = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW });
  assert.equal(r.findings.some((f) => f.id === 'idle_bucket'), false);
  assert.equal(r.by_family.groq.token_pressure, 1);
});

test('rows outside the window are ignored', () => {
  const rows = [row({ ts: SINCE - 1, http_status: 413, outcome: 'error' })];
  const r = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW });
  assert.equal(r.totals.dispatches, 0);
  assert.equal(r.findings.some((f) => f.id === 'oversized_dispatch'), false);
});

test('formatReport fails the run on high only, so a low finding cannot train you to mute it', () => {
  const lowOnly = runChecks({ rows: [row({})], registry, state: {}, since: SINCE, now: NOW });
  assert.ok(lowOnly.findings.length > 0);
  assert.equal(lowOnly.findings.every((f) => f.severity !== 'high'), true);
  assert.equal(formatReport(lowOnly).exitCode, 0);
});

test('providerFamilyOf collapses numbered keys onto one family', () => {
  assert.equal(providerFamilyOf('google9'), 'google');
  assert.equal(providerFamilyOf('groq2'), 'groq');
  assert.equal(providerFamilyOf('openrouter'), 'openrouter');
  assert.equal(providerFamilyOf(undefined), '');
});

test('thresholds are exported so a report can be read against them', () => {
  assert.ok(SUCCESS_FLOOR > 0 && SUCCESS_FLOOR < 1);
  assert.ok(IDLE_FLOOR > 0 && IDLE_FLOOR < 1);
});
