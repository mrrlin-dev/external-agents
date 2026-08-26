import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// `list_agents` used to leak `enabled` only as a side effect of spread order —
// a state record's flag happening to land on top of the registry entry's — so
// reading it correctly required knowing the two-layer kill-switch rule. Worse,
// a switched-off entry whose key is present still probes `healthy`, so a client
// reading only `state` concluded an agent was available that dispatch would
// then refuse. Both facts are now stated outright.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "server.js");

// Bundled with `enabled: false` and no `enable_on_credential`, so it stays off
// regardless of HOME or credentials.
const DISABLED_AGENT_ID = "gemini-3.1-pro-preview";

async function listAgents() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mcp-list-enabled-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    env: { ...process.env, HOME: dir },
    stderr: "pipe",
  });
  const client = new Client({ name: "list-agents-test", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: "list_agents", arguments: {} });
    return JSON.parse(res.content[0].text);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("list_agents states enabled and dispatchable outright", async () => {
  const agents = await listAgents();
  assert.ok(agents.length > 0);

  for (const a of agents) {
    assert.equal(typeof a.enabled, "boolean", `${a.id} must report enabled explicitly`);
    assert.equal(typeof a.dispatchable, "boolean", `${a.id} must report dispatchable explicitly`);
    // The whole point: nothing may claim to be dispatchable while switched off,
    // because dispatch refuses a disabled entry even when named by id.
    if (!a.enabled) {
      assert.equal(a.dispatchable, false, `${a.id} is disabled but reported dispatchable`);
    }
  }

  const disabled = agents.find((a) => a.id === DISABLED_AGENT_ID);
  assert.ok(disabled, `${DISABLED_AGENT_ID} missing from list_agents`);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.dispatchable, false);
});
