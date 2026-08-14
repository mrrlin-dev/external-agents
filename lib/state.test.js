import test from "node:test";
import assert from "node:assert/strict";
import { deriveDisplayState, mergeAuditState } from "./state.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

test("mergeAuditState clears stale limited cooldown when the new audit result is not limited", () => {
  const merged = mergeAuditState(
    {
      state: "quota_exhausted",
      cooldown_until: 999,
      source: "error_body",
      consecutive_failures: 4,
      last_used_at: 123,
    },
    {
      outcome: "errored_transient",
      note: "prompt too long",
      checked: 200,
    },
  );

  assert.equal(merged.state, "errored_transient");
  assert.equal(merged.note, "prompt too long");
  assert.equal(merged.checked, 200);
  assert.equal(merged.last_used_at, 123);
  assert.equal("cooldown_until" in merged, false);
  assert.equal("source" in merged, false);
  assert.equal(merged.consecutive_failures, 4);
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
