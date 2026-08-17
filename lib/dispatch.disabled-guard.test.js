import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Regression: `external-agents dispatch <id>` used to bypass pickAgents'
// kill-switch filter entirely — naming a disabled entry's id directly still
// ran it, which is exactly how a provider the operator turned off (e.g. after
// a corporate network policy started blocking it) kept getting live traffic.
// This must refuse BEFORE touching any credential or network — a fresh, empty
// HOME (no keys.env, no state.json) proves the refusal doesn't depend on either.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "cli.js");

// gemini-3.1-pro-preview: bundled with `enabled: false` and no
// `enable_on_credential`, so it stays disabled regardless of HOME/credentials.
const DISABLED_AGENT_ID = "gemini-3.1-pro-preview";

test("cli.js dispatch refuses a registry-disabled agent before touching credentials or network", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-disabled-"));
  try {
    const r = spawnSync(process.execPath, [cliPath, "dispatch", DISABLED_AGENT_ID, "hello"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: dir },
      encoding: "utf-8",
    });
    assert.notEqual(r.status, 0, "a disabled agent must not dispatch successfully");
    assert.match(r.stderr, /agent disabled/i);
    assert.match(r.stderr, new RegExp(DISABLED_AGENT_ID));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.js dispatch honors a state.json override that explicitly re-enables a registry-disabled agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-reenabled-"));
  try {
    const stateDir = path.join(dir, ".local", "state", "external-agents");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ [DISABLED_AGENT_ID]: { enabled: true } }),
    );
    const r = spawnSync(process.execPath, [cliPath, "dispatch", DISABLED_AGENT_ID, "hello"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: dir },
      encoding: "utf-8",
    });
    // Past the kill-switch guard now — it fails for an unrelated reason
    // (no GEMINI_API_KEY in this empty HOME), not because it was refused as disabled.
    assert.doesNotMatch(r.stderr, /agent disabled/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
