import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, formatReport, providerFamilyOf, SUCCESS_FLOOR, IDLE_FLOOR, BURST_GAP_S } from './doctor.js';

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
  const state = { 'unmeasured': { observed_limits: { tpm: 5000, axis_seen_at: { tpm: NOW }, seen_at: NOW } } };
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
  const state = { unmeasured: { observed_limits: { tpm: 5000, axis_seen_at: { tpm: NOW - 10 }, seen_at: NOW - 10 } } };
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

// --- goal 5 for seats no header can reach ---------------------------------

test('observed_allowance measures what a seat served between running out twice', () => {
  // A subscription CLI has no rate-limit headers, so its ceiling cannot be
  // observed the way an HTTP seat's can — but whatever it served between two
  // exhaustions IS the allowance, in the provider's own accounting.
  const rows = [
    { ts: NOW - 200000, agent_id: 'cli', provider: 'p', outcome: 'quota_exhausted' },
    { ts: NOW - 190000, agent_id: 'cli', provider: 'p', outcome: 'success', tokens_in: 100, tokens_out: 50 },
    { ts: NOW - 180000, agent_id: 'cli', provider: 'p', outcome: 'success', tokens_in: 200, tokens_out: 25 },
    { ts: NOW - 100, agent_id: 'cli', provider: 'p', outcome: 'quota_exhausted' },
  ];
  const f = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW })
    .findings.find((x) => x.id === 'observed_allowance');
  assert.ok(f);
  assert.equal(f.goal, 5);
  assert.equal(f.severity, 'low', 'reported, never gated on');
  assert.match(f.evidence[0], /^cli: 2 dispatches, 375 tokens/);
});

test('observed_allowance needs two periods, not one exhaustion', () => {
  const rows = [
    { ts: NOW - 5000, agent_id: 'cli', provider: 'p', outcome: 'success', tokens_in: 10, tokens_out: 10 },
    { ts: NOW - 100, agent_id: 'cli', provider: 'p', outcome: 'quota_exhausted' },
  ];
  const r = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW });
  assert.equal(r.findings.some((f) => f.id === 'observed_allowance'), false);
});

test('a burst of 429s is one event hit repeatedly, not two periods', () => {
  // Measured before the token-axis cooldown floor landed: 21 re-dispatches
  // inside 60s of a single 429. Counting those as period boundaries would report
  // an "allowance" of whatever fit between two retries.
  const rows = [
    { ts: NOW - 120, agent_id: 'cli', provider: 'p', outcome: 'error', http_status: 429 },
    { ts: NOW - 90, agent_id: 'cli', provider: 'p', outcome: 'success', tokens_in: 5, tokens_out: 5 },
    { ts: NOW - 60, agent_id: 'cli', provider: 'p', outcome: 'error', http_status: 429 },
  ];
  const r = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW });
  assert.equal(r.findings.some((f) => f.id === 'observed_allowance'), false, `gap under ${BURST_GAP_S}s`);
});

test('an allowance whose tokens were never reported still counts dispatches', () => {
  // Every CLI seat looked like this before lib/cli-usage.js.
  const rows = [
    { ts: NOW - 200000, agent_id: 'cli', provider: 'p', outcome: 'quota_exhausted' },
    { ts: NOW - 190000, agent_id: 'cli', provider: 'p', outcome: 'success' },
    { ts: NOW - 100, agent_id: 'cli', provider: 'p', outcome: 'quota_exhausted' },
  ];
  const f = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW })
    .findings.find((x) => x.id === 'observed_allowance');
  assert.match(f.evidence[0], /1 dispatches, tokens unknown/);
});

test('spend separates measured tokens from an honest unknown', () => {
  const rows = [
    { ts: NOW - 10, agent_id: 'measured', provider: 'p', outcome: 'success', tokens_in: 10, tokens_out: 20 },
    { ts: NOW - 10, agent_id: 'blind', provider: 'p', outcome: 'success' },
    { ts: NOW - 10, agent_id: 'blind', provider: 'p', outcome: 'error' },
  ];
  const { spend } = runChecks({ rows, registry, state: {}, since: SINCE, now: NOW });
  assert.deepEqual(spend.measured, { dispatches: 1, tokens_in: 10, tokens_out: 20, tokens_unknown: 0 });
  assert.equal(spend.blind.tokens_unknown, 1, 'the success with no tokens');
  assert.equal(spend.blind.dispatches, 2);
  assert.equal(spend.blind.tokens_in, 0);
});

test("a seat whose provider reports no limits is a separate, quieter finding", () => {
  // Same shape as unmeasured_seat, different remedy: this one has already had
  // the only automatic fix applied and it did not take, so telling the operator
  // to run `audit` again every morning is a fix that cannot be applied.
  const reg = { agents: [{ id: "silent", provider: "p", transports: { generate_new: { url: "https://x" } } }] };
  const st = { silent: { limits_unreported: { seen_at: 1 } } };

  const f = runChecks({ rows: [], registry: reg, state: st, since: SINCE, now: NOW })
    .findings.find((x) => x.id === "unmeasurable_seat");
  assert.ok(f, "a probed-but-silent seat must be reported");
  assert.equal(f.severity, "low");
  assert.match(f.remedy, /token_limits/);
  assert.ok(f.evidence.some((e) => e.includes("silent")));

  // And it must NOT also be counted as never-probed.
  const both = runChecks({ rows: [], registry: reg, state: st, since: SINCE, now: NOW })
    .findings.filter((x) => x.id === "unmeasured_seat");
  assert.deepEqual(both, [], "one seat, one finding");
});

test("a seat nobody has probed keeps the audit remedy", () => {
  const reg = { agents: [{ id: "fresh", provider: "p", transports: { generate_new: { url: "https://x" } } }] };
  const f = runChecks({ rows: [], registry: reg, state: {}, since: SINCE, now: NOW })
    .findings.find((x) => x.id === "unmeasured_seat");
  assert.ok(f);
  assert.equal(f.remedy, "external-agents audit");
  assert.equal(runChecks({ rows: [], registry: reg, state: {}, since: SINCE, now: NOW })
    .findings.filter((x) => x.id === "unmeasurable_seat").length, 0);
});

test("a seat with a real ceiling is neither", () => {
  const reg = { agents: [{ id: "known", provider: "p", token_limits: { tpm: 8000 }, transports: { generate_new: { url: "https://x" } } }] };
  // Even with a stale marker on it, a ceiling settles the question.
  const st = { known: { limits_unreported: { seen_at: 1 } } };
  const ids = runChecks({ rows: [], registry: reg, state: st, since: SINCE, now: NOW })
    .findings.map((x) => x.id);
  assert.ok(!ids.includes("unmeasured_seat"));
  assert.ok(!ids.includes("unmeasurable_seat"));
});

// ---------------------------------------------------------------------------
// `never_answered` used to assert a cause it could not know: every
// non-quarantined case was reported as "a regression in the counters or in the
// pick filter, NOT a provider problem". The first time it fired unattended that
// sentence was false — the seat was HTTP 429 free-models-per-day, an ordinary
// exhausted free tier. A daily job must not call that a regression every
// morning, so the cause is now read from the state the last audit wrote.
// ---------------------------------------------------------------------------

const silentRows = (id, n) => Array.from({ length: n }, () => row({ agent_id: id, outcome: "error" }));
const neverAnswered = (state, id = "silent", n = 11) =>
  runChecks({ rows: silentRows(id, n), registry: { agents: [] }, state, since: SINCE, now: NOW })
    .findings.find((f) => f.id === "never_answered");

test("an exhausted free tier is reported as supply, not as a regression", () => {
  for (const st of ["rate_limited", "quota_exhausted"]) {
    const f = neverAnswered({ silent: { state: st, cooldown_until: NOW + 3600 } });
    assert.ok(f, st);
    assert.equal(f.severity, "low", `${st} must not shout`);
    assert.ok(/supply and not a defect/.test(f.detail), f.detail);
    assert.ok(!/regression/.test(f.detail), `${st}: must not claim a regression — it was measured false`);
    assert.equal(f.remedy, null, "nothing to run; it comes back on its own");
    assert.ok(f.evidence.some((e) => e.startsWith("cooldown_until=")), "the reset time is the useful fact");
  }
});

test("a credential or registry problem stays high and names the fix", () => {
  for (const st of ["needs_auth", "model_unavailable", "not_installed"]) {
    const f = neverAnswered({ silent: { state: st, provider: "groq" } });
    assert.equal(f.severity, "high", st);
    assert.ok(/configuration problem/.test(f.detail), f.detail);
    assert.match(f.remedy, /audit --provider groq/);
  }
});

test("the counters ARE the suspect when nothing else explains the failures", () => {
  const f = neverAnswered({ silent: { state: "healthy" } });
  assert.equal(f.severity, "high");
  assert.ok(/regression in the counters/.test(f.detail), "the original diagnosis survives where it holds");
  // And it still says how to rule out the boring explanation first.
  assert.ok(/rate_limited or quota_exhausted/.test(f.detail), f.detail);
  assert.match(f.remedy, /external-agents audit/);
});

test("an unknown state is reported honestly rather than guessed at", () => {
  const f = neverAnswered({});
  assert.equal(f.severity, "high");
  assert.ok(f.evidence.includes("state=unknown"));
});

test("a quarantined seat stays quiet — the mechanism did its job", () => {
  const f = neverAnswered({ silent: { state: "healthy", health: { attempts: 30, successes: 0, attempts_since_ok: 30, ever_ok: false } } });
  assert.equal(f.severity, "low");
  assert.ok(/mechanism worked/.test(f.detail));
});
