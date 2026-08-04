import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { classifyCliFailure } from "./dispatch.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "cli.js");
const AGENT_IDS = [
  "cursor-agent", "opencode", "kiro", "codex", "codex-gpt-5.4-mini",
  "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5",
];
const ENABLED = /^(1|true|yes)$/i.test(process.env.EXTERNAL_AGENTS_CLI_SMOKE || "");

function dispatchSmoke(agentId, cwd) {
  const marker = `OK ${agentId}`;
  const prompt = `Do not modify any files. Reply in one short line: ${marker}.`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "dispatch", agentId, "--json", "--transport", "edit_exists", "--cwd", cwd, prompt], {
      cwd: repoRoot,
      env: { ...process.env, EXTERNAL_AGENTS_TIMEOUT_MS: "30000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 35000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr, marker });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, marker });
    });
  });
}

test("bundled direct CLI agents have an opt-in read-only dispatch smoke test", { skip: !ENABLED && "set EXTERNAL_AGENTS_CLI_SMOKE=1 to run real local CLI dispatches", timeout: 300000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ea-cli-smoke-"));
  try {
    for (const agentId of AGENT_IDS) {
      const result = await dispatchSmoke(agentId, cwd);
      let payload;
      try { payload = JSON.parse(result.stdout); } catch {}
      const preview = `${result.stderr}\n${payload?.text || ""}`;
      const classified = classifyCliFailure(preview);
      const observed = result.code === 124 ? "timeout"
        : result.code === 4 ? "quota_exhausted"
        : classified.needsAuth ? "needs_auth"
        : classified.quotaExhausted ? "quota_exhausted"
        : result.code === 0 ? "success"
        : /command not found|ENOENT|not installed/i.test(preview) ? "not_installed"
        : "error";
      t.diagnostic(`${agentId}: ${observed}`);
      if (observed === "success") {
        assert.match(payload?.text || "", new RegExp(`OK\\s+${agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      }
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
