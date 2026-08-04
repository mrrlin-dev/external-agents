import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import yaml from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledRegistry = yaml.load(fs.readFileSync(path.join(repoRoot, "agents.yaml"), "utf-8"));

test("bundled edit_exists transports use direct CLIs while generate_new remains available", () => {
  const agents = bundledRegistry.agents;
  const editCommands = agents
    .map((agent) => agent.transports?.edit_exists)
    .filter(Boolean)
    .map((transport) => typeof transport === "string" ? transport : transport.cmd);

  assert.ok(editCommands.length > 0);
  assert.ok(editCommands.every((command) => typeof command === "string" && command.trim()));
  assert.ok(agents.some((agent) => agent.transports?.generate_new));

  for (const id of ["codex", "claude-opus-4-8"]) {
    const agent = agents.find((candidate) => candidate.id === id);
    assert.ok(agent, `${id} must remain a bundled direct-CLI edit agent`);
    assert.ok(agent.transports?.edit_exists, `${id} must declare edit_exists`);
  }
});
