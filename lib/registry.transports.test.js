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

test("bundled read_only transports never reuse their entry's edit_exists command verbatim", () => {
  // A read_only cmd identical to edit_exists is definitionally not read-only —
  // this is the exact class of unverified claim the axis exists to prevent.
  const agents = bundledRegistry.agents;
  for (const agent of agents) {
    const ro = agent.transports?.read_only;
    const editCmd = agent.transports?.edit_exists;
    if (!ro) continue;
    const roCmd = typeof ro === "string" ? ro : ro.cmd;
    const editCmdStr = typeof editCmd === "string" ? editCmd : editCmd?.cmd;
    assert.notEqual(roCmd, editCmdStr, `${agent.id}'s read_only cmd must differ from its edit_exists cmd`);
  }
});

test("kiro and the anthropic CLI entries declare a read_only command", () => {
  const agents = bundledRegistry.agents;
  for (const id of ["kiro", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]) {
    const agent = agents.find((candidate) => candidate.id === id);
    assert.ok(agent, `${id} must remain bundled`);
    const ro = agent.transports?.read_only;
    assert.ok(ro, `${id} must declare a read_only transport`);
    assert.ok(typeof (typeof ro === "string" ? ro : ro.cmd) === "string" && (typeof ro === "string" ? ro : ro.cmd).trim());
  }
});

test("the anthropic CLI read_only commands don't claim effort support (untested with their trailing --)", () => {
  // runDispatch appends the effort flag right before the prompt — i.e. AFTER
  // this cmd's trailing `--`, which was confirmed to swallow the prompt
  // entirely rather than erroring loudly. Do not add effort fields here until
  // that interaction is fixed and verified; a silent prompt loss is worse
  // than declining to offer effort tuning on the reviewer path.
  const agents = bundledRegistry.agents;
  for (const id of ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]) {
    const ro = agents.find((a) => a.id === id).transports.read_only;
    assert.equal(ro.effort_levels, undefined, `${id}'s read_only cmd must not declare effort_levels`);
  }
});
