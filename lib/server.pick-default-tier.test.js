import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadRegistry } from "./registry.js";

// Integration coverage for the MCP `pick_agents` tool's tier default
// (server.js): an omitted filter.tier used to fall through to pickAgents with
// no tier restriction at all, relying on preference_order (set only on
// weak/free entries by convention, not by code) to happen to land cheap. This
// proves the default is now enforced in code, over the real stdio transport
// with a fresh, empty HOME so it holds independent of credentials or prior
// local state.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "server.js");
const REGISTRY = loadRegistry(path.join(repoRoot, "agents.yaml"));
const tierOf = (id) => REGISTRY.agents.find((a) => a.id === id)?.tier;

test("MCP pick_agents defaults to tier=weak when filter.tier is omitted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mcp-pick-tier-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    env: { ...process.env, HOME: dir },
    stderr: "pipe",
  });
  const client = new Client({ name: "pick-default-tier-test", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "pick_agents", arguments: { n: 4 } });
    const { picked } = JSON.parse(result.content[0].text);
    assert.ok(picked.length > 0, "expected at least one candidate from a fresh registry");
    for (const id of picked) {
      assert.equal(tierOf(id), "weak", `${id} was picked by a tier-omitted call but is tier=${tierOf(id)}`);
    }
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP pick_agents still honors an explicit filter.tier='strong'", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mcp-pick-tier-strong-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    env: { ...process.env, HOME: dir },
    stderr: "pipe",
  });
  const client = new Client({ name: "pick-explicit-strong-test", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "pick_agents",
      arguments: { n: 4, filter: { tier: "strong" } },
    });
    const { picked } = JSON.parse(result.content[0].text);
    assert.ok(picked.length > 0, "expected at least one strong candidate from a fresh registry");
    for (const id of picked) {
      assert.equal(tierOf(id), "strong", `${id} was picked by an explicit tier='strong' call but is tier=${tierOf(id)}`);
    }
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
