import test from "node:test";
import assert from "node:assert/strict";
import { deriveDisplayState, mergeAuditState, effectiveCooldownUntil, auditCooldown, ERRORED_TRANSIENT_TTL_S, applyCarryForward, NEWEST_WINS_FIELDS} from "./state.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { displayPath } from "./credentials.js";

test("deriveDisplayState marks expired quota cooldowns as need_check", () => {
  const derived = deriveDisplayState({
    state: "quota_exhausted",
    cooldown_until: 100,
    note: "provider said come back later",
  }, 101);

  assert.equal(derived.state, "need_check");
  assert.equal(derived.stale_state, "quota_exhausted");
  assert.match(derived.note, /Cooldown expired; run probe/);
  assert.equal(derived.cooldown_until, 100);
});

test("deriveDisplayState leaves active cooldowns untouched", () => {
  const active = {
    state: "rate_limited",
    cooldown_until: 200,
  };

  assert.deepEqual(deriveDisplayState(active, 199), active);
});

test("deriveDisplayState flips to need_check exactly at cooldown expiry", () => {
  const derived = deriveDisplayState({
    state: "errored_transient",
    cooldown_until: 200,
  }, 200);

  assert.equal(derived.state, "need_check");
  assert.equal(derived.stale_state, "errored_transient");
});

test("deriveDisplayState leaves healthy records untouched", () => {
  const healthy = {
    state: "healthy",
    cooldown_until: 100,
  };

  assert.deepEqual(deriveDisplayState(healthy, 999), healthy);
});

test("mergeAuditState clears stale limited cooldown when the new audit result carries none", () => {
  const merged = mergeAuditState(
    {
      state: "quota_exhausted",
      cooldown_until: 999,
      source: "error_body",
      consecutive_failures: 4,
      last_used_at: 123,
    },
    {
      outcome: "needs_auth",
      note: "key revoked",
      checked: 200,
    },
  );

  assert.equal(merged.state, "needs_auth");
  assert.equal(merged.note, "key revoked");
  assert.equal(merged.checked, 200);
  assert.equal(merged.last_used_at, 123);
  assert.equal("cooldown_until" in merged, false);
  assert.equal("source" in merged, false);
  assert.equal(merged.consecutive_failures, 4);
});

// errored_transient moved into the cooldown-carrying set. Before that it was
// the one non-healthy verdict with no expiry at all, which meant a single
// transient failure removed an agent from pick permanently — the pool then
// degraded silently, because nothing anywhere says "this entry stopped being
// offered". The stale cooldown from the previous outcome must not be inherited
// either: it belonged to a different verdict and a different reset time.
test("mergeAuditState gives errored_transient its own expiry rather than inheriting or omitting one", () => {
  const merged = mergeAuditState(
    { state: "quota_exhausted", cooldown_until: 999, source: "error_body", last_used_at: 123 },
    { outcome: "errored_transient", note: "prompt too long", checked: 200 },
  );

  assert.equal(merged.state, "errored_transient");
  assert.equal(merged.cooldown_until, 200 + ERRORED_TRANSIENT_TTL_S);
  assert.equal(merged.source, "fallback_ttl");
  assert.equal(merged.last_used_at, 123);
});

test("effectiveCooldownUntil derives an expiry for legacy errored_transient records", () => {
  // Records written before errored_transient carried a cooldown have no
  // cooldown_until field at all. Reading the raw field would keep filtering
  // them out of pick forever, so the expiry is derived from `checked` instead
  // — which is what makes the fix apply without rewriting state.json.
  assert.equal(
    effectiveCooldownUntil({ state: "errored_transient", checked: 1000 }),
    1000 + ERRORED_TRANSIENT_TTL_S,
  );
  // An explicit cooldown always wins over the derived one.
  assert.equal(
    effectiveCooldownUntil({ state: "errored_transient", checked: 1000, cooldown_until: 5 }),
    5,
  );
  // Other states get no free expiry: needs_auth and model_unavailable are
  // standing conditions, not moments, and must stay binding until re-probed.
  assert.equal(effectiveCooldownUntil({ state: "needs_auth", checked: 1000 }), null);
  assert.equal(effectiveCooldownUntil({ state: "model_unavailable", checked: 1000 }), null);
  assert.equal(effectiveCooldownUntil(null), null);
});

test("deriveDisplayState surfaces a legacy errored_transient record as need_check once derived expiry passes", () => {
  const rec = { state: "errored_transient", checked: 1000, note: "boom" };
  assert.equal(deriveDisplayState(rec, 1000 + ERRORED_TRANSIENT_TTL_S - 1).state, "errored_transient");
  const expired = deriveDisplayState(rec, 1000 + ERRORED_TRANSIENT_TTL_S);
  assert.equal(expired.state, "need_check");
  assert.equal(expired.stale_state, "errored_transient");
});

test("auditCooldown is the single source of truth for which outcomes expire", () => {
  assert.deepEqual(auditCooldown("healthy", {}, 100), { cooldown_until: undefined, source: undefined });
  assert.deepEqual(auditCooldown("needs_auth", {}, 100), { cooldown_until: undefined, source: undefined });
  assert.deepEqual(auditCooldown("model_unavailable", {}, 100), { cooldown_until: undefined, source: undefined });
  // A parsed reset from the provider's own error body beats our flat guess.
  assert.deepEqual(auditCooldown("rate_limited", { reset_at: 777 }, 100), { cooldown_until: 777, source: "error_body" });
  assert.deepEqual(auditCooldown("quota_exhausted", {}, 100), { cooldown_until: 3700, source: "fallback_ttl" });
  // No provider reports a reset for a generic failure, so this is always ours.
  assert.deepEqual(
    auditCooldown("errored_transient", { reset_at: 777 }, 100),
    { cooldown_until: 100 + ERRORED_TRANSIENT_TTL_S, source: "fallback_ttl" },
  );
});

test("mergeAuditState preserves cooldown metadata for limited outcomes", () => {
  const merged = mergeAuditState(
    { state: "errored_transient", last_used_at: 123 },
    {
      outcome: "rate_limited",
      note: "Retry-After: 90",
      checked: 200,
      cooldown_until: 290,
      source: "error_body",
    },
  );

  assert.equal(merged.state, "rate_limited");
  assert.equal(merged.cooldown_until, 290);
  assert.equal(merged.source, "error_body");
  assert.equal(merged.last_used_at, 123);
});

test("mergeAuditState resets consecutive failures on healthy audit results", () => {
  const merged = mergeAuditState(
    { state: "errored_transient", consecutive_failures: 6, cooldown_until: 999, source: "fallback_ttl" },
    {
      outcome: "healthy",
      note: "verified",
      checked: 200,
    },
  );

  assert.equal(merged.state, "healthy");
  assert.equal(merged.consecutive_failures, 0);
  assert.equal("cooldown_until" in merged, false);
  assert.equal("source" in merged, false);
});

// Regression: a probe result must not silently revert the operator kill
// switch. Every writeState caller but /api/toggle builds its patch from a
// fresh observation, and the per-id merge is a REPLACE — so `probe` used to
// drop `enabled`. For a registry-disabled entry (deepseek) that turned it
// back OFF right after a key had enabled it.
// Runs in a child process: state.js resolves its state dir from os.homedir()
// at import time, so HOME has to be set before the module loads.
test("writeState preserves `enabled` when a patch does not mention it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-state-enabled-"));
  try {
    const script = `
      import { writeState, readState } from "${new URL("./state.js", import.meta.url).pathname}";
      writeState({ a: { enabled: true } });
      writeState({ a: { state: "healthy", note: "probed", checked: 1 } });
      const afterProbe = readState().a;
      writeState({ a: { state: "healthy", enabled: false } });
      console.log(JSON.stringify({ afterProbe, afterExplicit: readState().a }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: dir },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
    const { afterProbe, afterExplicit } = JSON.parse(r.stdout);
    assert.equal(afterProbe.enabled, true, "probe result wiped the toggle");
    assert.equal(afterProbe.state, "healthy");
    // ...and an explicit `enabled` in the patch still wins.
    assert.equal(afterExplicit.enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: enableAgentsAwaitingCredential is a ONE-TIME bootstrap flip for
// an entry the operator has never touched — it must not re-fire and clobber
// an explicit operator disable just because `set-credential` runs again for
// the same env var (key rotation, a repeated setup pass, a second Claude
// session bootstrapping credentials). Reproduced live before this fix: with
// the old guard (`current[a.id]?.enabled === true`), disabling via /api/toggle
// and then re-running set-credential flipped `enabled` straight back to true.
test("enableAgentsAwaitingCredential does not re-enable an entry the operator explicitly disabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-state-enable-on-cred-"));
  try {
    const script = `
      import { enableAgentsAwaitingCredential, writeState, readState } from "${new URL("./state.js", import.meta.url).pathname}";
      const agents = [{ id: "fake-deepseek", enabled: false, enable_on_credential: true, auth: "env:FAKE_DEEPSEEK_KEY" }];

      const firstRun = enableAgentsAwaitingCredential("FAKE_DEEPSEEK_KEY", agents);
      const afterBootstrap = readState()["fake-deepseek"];

      // Operator explicitly disables it via /api/toggle's write shape.
      writeState({ "fake-deepseek": { ...readState()["fake-deepseek"], enabled: false } });
      const afterDisable = readState()["fake-deepseek"];

      // set-credential runs again for the same env var (e.g. key rotation).
      const secondRun = enableAgentsAwaitingCredential("FAKE_DEEPSEEK_KEY", agents);
      const afterSecondRun = readState()["fake-deepseek"];

      console.log(JSON.stringify({ firstRun, afterBootstrap, afterDisable, secondRun, afterSecondRun }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: dir },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
    const { firstRun, afterBootstrap, afterDisable, secondRun, afterSecondRun } = JSON.parse(r.stdout);

    assert.deepEqual(firstRun, ["fake-deepseek"], "fresh install must still auto-enable on first credential");
    assert.equal(afterBootstrap.enabled, true);
    assert.equal(afterDisable.enabled, false, "operator disable must persist immediately");
    assert.deepEqual(secondRun, [], "a repeat set-credential call must not re-flip an operator-disabled entry");
    assert.equal(afterSecondRun.enabled, false, "explicit disable must survive a second set-credential run for the same key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Raised in review: if a path could ever write `errored_transient` without a
// `checked` timestamp, the derived expiry would be null and the record would
// block forever — reintroducing the very bug this replaced. Both real writers
// set at least one field (outcome.js writes cooldown_until AND checked;
// mergeAuditState guarantees a cooldown even when the caller omits checked),
// so this covers the hand-edited / foreign-written case.
test("an errored_transient record with neither cooldown nor timestamp is treated as expired, not binding", () => {
  assert.equal(effectiveCooldownUntil({ state: "errored_transient" }), 0);
  assert.equal(deriveDisplayState({ state: "errored_transient" }, 1).state, "need_check");
});

test("mergeAuditState still stamps a cooldown for errored_transient when the caller omits checked", () => {
  const merged = mergeAuditState({}, { outcome: "errored_transient", note: "boom" });
  assert.ok(merged.cooldown_until > 0, "must never leave an errored_transient record open-ended");
  assert.equal(merged.source, "fallback_ttl");
});

// Raised in review: the `limited` branch spreads `existing` wholesale, so a
// field belonging to the PREVIOUS outcome could in principle survive the
// transition. Cooldown metadata is the case that would actually matter, since
// pick reads it.
test("no cooldown metadata from a previous outcome survives into errored_transient", () => {
  const merged = mergeAuditState(
    { state: "rate_limited", cooldown_until: 999999, source: "error_body", consecutive_failures: 2, last_used_at: 7 },
    { outcome: "errored_transient", note: "5xx", checked: 500 },
  );
  assert.equal(merged.cooldown_until, 500 + ERRORED_TRANSIENT_TTL_S);
  assert.equal(merged.source, "fallback_ttl");
  // The failure streak and last use are history, not outcome metadata: they
  // must survive, or outcome.js's escalating ladder loses its counter.
  assert.equal(merged.consecutive_failures, 2);
  assert.equal(merged.last_used_at, 7);
});

// --- carry-forward: a verdict must not erase a measurement -----------------

test('applyCarryForward keeps observed_limits and health across a verdict-only write', () => {
  // Reproduced live: a dispatch recorded `observed_limits {tpm: 5000}` for
  // azure-kimi-k2-5-safe and 38 seconds later a concurrent write from a build
  // that did not know the field existed replaced the record wholesale. The
  // measurement was gone and `pick` went back to guessing.
  const current = {
    a: {
      state: 'healthy',
      enabled: false,
      observed_limits: { tpm: 5000, window_s: 60, seen_at: 100 },
      observed_budget: { remaining_tokens: 0, seen_at: 100 },
      health: { attempts: 6, successes: 0, attempts_since_ok: 6, ever_ok: false },
    },
  };
  const patch = { a: { state: 'errored_transient', checked: 200, cooldown_until: 400 } };
  const merged = applyCarryForward({ ...current, ...patch }, current, patch);

  assert.deepEqual(merged.a.observed_limits, { tpm: 5000, window_s: 60, seen_at: 100 });
  assert.deepEqual(merged.a.health, { attempts: 6, successes: 0, attempts_since_ok: 6, ever_ok: false });
  assert.equal(merged.a.enabled, false, 'the original case still holds');
  assert.equal(merged.a.state, 'errored_transient', 'the verdict itself is not touched');
  assert.equal(merged.a.cooldown_until, 400);
  assert.equal(
    Object.prototype.hasOwnProperty.call(merged.a, 'observed_budget'),
    false,
    'a budget describes one 60s window and expires on its own — carrying it would keep a dead number alive',
  );
});

test('applyCarryForward respects a patch that names a carried field explicitly', () => {
  const current = { a: { observed_limits: { tpm: 5000 }, health: { ever_ok: false }, enabled: false } };
  const patch = { a: { observed_limits: { tpm: 12000 }, health: { ever_ok: true }, enabled: true } };
  const merged = applyCarryForward({ ...current, ...patch }, current, patch);
  assert.deepEqual(merged.a.observed_limits, { tpm: 12000 }, 'a newer measurement wins');
  assert.equal(merged.a.health.ever_ok, true);
  assert.equal(merged.a.enabled, true);
});

test('applyCarryForward leaves an id it has never seen alone', () => {
  const patch = { fresh: { state: 'healthy' } };
  const merged = applyCarryForward({ ...patch }, {}, patch);
  assert.deepEqual(merged, { fresh: { state: 'healthy' } });
});

// --- newest-wins: a patch is not automatically newer than what is on disk ----

test('applyCarryForward keeps the NEWER observation when a slow writer lands late', () => {
  // Raised by a consensus reviewer and confirmed: every writer builds its
  // observation from the call that just finished, so it is fresh when BUILT —
  // but acquireLock waits up to ten seconds. A dispatch that returned at T=100
  // can be blocked until T=106 and write its seen_at:100 observation on top of
  // one made at T=105 by a concurrent dispatch to the same agent.
  const current = {
    a: {
      state: 'healthy',
      observed_limits: { tpm: 8000, seen_at: 105 },
      observed_budget: { remaining_tokens: 4000, seen_at: 105 },
    },
  };
  const patch = {
    a: {
      state: 'healthy',
      observed_limits: { tpm: 5000, seen_at: 100 },
      observed_budget: { remaining_tokens: 0, seen_at: 100 },
    },
  };
  const merged = applyCarryForward({ ...current, ...patch }, current, patch);

  assert.equal(merged.a.observed_limits.tpm, 8000, 'the newer ceiling survives');
  assert.equal(
    merged.a.observed_budget.remaining_tokens,
    4000,
    'and the newer budget — a stale remaining_tokens: 0 would strand a healthy seat for the whole TTL',
  );
});

test('applyCarryForward lets a genuinely newer patch through', () => {
  const current = { a: { observed_limits: { tpm: 5000, seen_at: 100 }, observed_budget: { remaining_tokens: 0, seen_at: 100 } } };
  const patch = { a: { observed_limits: { tpm: 12000, seen_at: 200 }, observed_budget: { remaining_tokens: 9000, seen_at: 200 } } };
  const merged = applyCarryForward({ ...current, ...patch }, current, patch);
  assert.equal(merged.a.observed_limits.tpm, 12000);
  assert.equal(merged.a.observed_budget.remaining_tokens, 9000);
});

test('applyCarryForward treats an undated on-disk observation as no evidence about now', () => {
  // Hand-edited or foreign-written. The same rule effectiveCooldownUntil applies
  // to a verdict that cannot say when it applied.
  const current = { a: { observed_limits: { tpm: 5000 } } };
  const patch = { a: { observed_limits: { tpm: 12000, seen_at: 200 } } };
  const merged = applyCarryForward({ ...current, ...patch }, current, patch);
  assert.equal(merged.a.observed_limits.tpm, 12000, 'the dated patch stands');
});

test('applyCarryForward prefers a dated on-disk value over an undated patch', () => {
  const current = { a: { observed_limits: { tpm: 8000, seen_at: 105 } } };
  const patch = { a: { observed_limits: { tpm: 5000 } } };
  const merged = applyCarryForward({ ...current, ...patch }, current, patch);
  assert.equal(merged.a.observed_limits.tpm, 8000);
});

test('observed_budget is still not RESTORED onto a write that is silent about it', () => {
  // Newest-wins and carry-forward are different lists for different reasons: a
  // budget describes one 60s window and expires on its own, so reviving it onto
  // an unrelated verdict write would only keep a dead number alive longer.
  const current = { a: { observed_budget: { remaining_tokens: 0, seen_at: 100 } } };
  const patch = { a: { state: 'healthy', checked: 200 } };
  const merged = applyCarryForward({ ...current, ...patch }, current, patch);
  assert.equal(Object.prototype.hasOwnProperty.call(merged.a, 'observed_budget'), false);
});

// ---------------------------------------------------------------------------
// A home directory on a work machine is usually somebody's full name, and this
// repo shipped it to npm for several releases inside a dashboard screenshot.
// Every path the tool prints goes through displayPath now.
// ---------------------------------------------------------------------------
test("displayPath folds the home directory back to ~", () => {
  assert.equal(displayPath("/Users/someone/.local/state/x/keys.env", "/Users/someone"),
    `~${path.sep}.local/state/x/keys.env`);
  assert.equal(displayPath("/Users/someone", "/Users/someone"), "~");
  // A trailing separator on home must not produce `~//…`.
  assert.equal(displayPath("/Users/someone/x", "/Users/someone/"), `~${path.sep}x`);
});

test("displayPath only folds on a segment boundary", () => {
  // The prefix match that made `/Users/alice-backup` into `~-backup`.
  assert.equal(displayPath("/Users/alice-backup/f", "/Users/alice"), "/Users/alice-backup/f");
  assert.equal(displayPath("/etc/passwd", "/Users/alice"), "/etc/passwd");
});

test("displayPath is inert on anything that is not a usable path", () => {
  assert.equal(displayPath("", "/Users/a"), "");
  assert.equal(displayPath(null, "/Users/a"), null);
  assert.equal(displayPath(undefined, "/Users/a"), undefined);
  assert.equal(displayPath("/Users/a/x", ""), "/Users/a/x");
});

// A headers-only patch carries `{tpm, axis_seen_at:{tpm}}` and nothing else, by
// design — withObservations emits only what THIS call learned. Newest-wins used
// to compare one `seen_at` for the whole object, so that patch replaced the
// stored record wholesale and the input ceiling learned from an earlier 413 went
// with it. That is the mechanism that let a successful audit probe undo a
// body-learned ITPM 7000; the axes have to be reconciled one at a time.
test('applyCarryForward reconciles observed limits per axis, not per record', () => {
  const current = {
    'groq-qwen': {
      observed_limits: {
        itpm: 7000, otpm: 1000,
        axis_seen_at: { itpm: 1000, otpm: 1000 },
        source: 'error_body', seen_at: 1000,
      },
    },
  };
  const patch = {
    'groq-qwen': {
      observed_limits: {
        tpm: 8000,
        axis_seen_at: { tpm: 2000 },
        source: 'headers', seen_at: 2000,
      },
    },
  };
  const merged = applyCarryForward({ ...patch }, current, patch);
  const limits = merged['groq-qwen'].observed_limits;
  assert.equal(limits.itpm, 7000, 'the input ceiling must survive a headers-only patch');
  assert.equal(limits.otpm, 1000, 'and so must the output allowance');
  assert.equal(limits.tpm, 8000, 'while the newly learned combined ceiling lands');
  assert.deepEqual(limits.axis_seen_at, { itpm: 1000, otpm: 1000, tpm: 2000 });
});

test('applyCarryForward keeps the newer value when both sides know an axis', () => {
  const current = {
    a: { observed_limits: { itpm: 7000, axis_seen_at: { itpm: 5000 }, seen_at: 5000 } },
  };
  const patch = {
    a: { observed_limits: { itpm: 6000, axis_seen_at: { itpm: 1000 }, seen_at: 1000 } },
  };
  const merged = applyCarryForward({ ...patch }, current, patch);
  assert.equal(merged.a.observed_limits.itpm, 7000, 'the stale patch must not win');
  assert.equal(merged.a.observed_limits.axis_seen_at.itpm, 5000);
});
