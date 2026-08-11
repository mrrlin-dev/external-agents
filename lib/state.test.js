import test from "node:test";
import assert from "node:assert/strict";
import { deriveDisplayState } from "./state.js";
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
