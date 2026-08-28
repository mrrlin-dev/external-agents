import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Regression: `external-agents probe <id>` (and its MCP twin, probe_agent in
// server.js) never checked the kill switch at all — unlike `dispatch <id>`
// (lib/dispatch.disabled-guard.test.js) and bulk `audit` (which skips disabled
// entries by default, see cli.js cmdAudit), naming a disabled entry's id
// directly still probed it and wrote a fresh state next to an entry the
// operator switched off. Refuse the same way dispatch does, before touching
// any credential or network.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "cli.js");

// gemini-3.1-pro-preview: bundled with `enabled: false` and no
// `enable_on_credential`, so it stays disabled regardless of HOME/credentials.
const DISABLED_AGENT_ID = "gemini-3.1-pro-preview";

test("cli.js probe refuses a registry-disabled agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-probe-disabled-"));
  try {
    const r = spawnSync(process.execPath, [cliPath, "probe", DISABLED_AGENT_ID], {
      cwd: repoRoot,
      env: { ...process.env, HOME: dir },
      encoding: "utf-8",
    });
    assert.notEqual(r.status, 0, "a disabled agent must not probe successfully");
    assert.match(r.stderr, /agent disabled/i);
    assert.match(r.stderr, new RegExp(DISABLED_AGENT_ID));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.js probe honors a state.json override that explicitly re-enables a registry-disabled agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-probe-reenabled-"));
  try {
    const stateDir = path.join(dir, ".local", "state", "external-agents");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ [DISABLED_AGENT_ID]: { enabled: true } }),
    );
    const r = spawnSync(process.execPath, [cliPath, "probe", DISABLED_AGENT_ID], {
      cwd: repoRoot,
      env: { ...process.env, HOME: dir },
      encoding: "utf-8",
    });
    // Past the kill-switch guard now — it proceeds to an actual liveness probe
    // instead of being refused as disabled.
    assert.doesNotMatch(r.stderr, /agent disabled/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
