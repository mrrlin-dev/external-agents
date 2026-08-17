import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Integration coverage for the MCP `dispatch` tool's kill-switch guard
// (server.js), the counterpart to cli.js's subprocess test in
// lib/dispatch.disabled-guard.test.js. Spawns the real server over its real
// stdio transport with a fresh, empty HOME — no keys.env, no state.json — so
// the refusal is proven independent of credentials or prior local state.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "server.js");

// gemini-3.1-pro-preview: bundled with `enabled: false` and no
// `enable_on_credential`, so it stays disabled regardless of HOME/credentials.
const DISABLED_AGENT_ID = "gemini-3.1-pro-preview";

test("MCP dispatch tool refuses a registry-disabled agent before touching credentials or network", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mcp-dispatch-disabled-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    env: { ...process.env, HOME: dir },
    stderr: "pipe",
  });
  const client = new Client({ name: "kill-switch-test", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await assert.rejects(
      client.callTool({ name: "dispatch", arguments: { agent_id: DISABLED_AGENT_ID, prompt: "hello" } }),
      /agent disabled/i,
    );
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
