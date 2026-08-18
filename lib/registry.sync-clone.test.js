import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import yaml from "js-yaml";

// Regression: /api/add_provider_key clones a base entry by spreading its
// fields at CLONE time (ui.js). If the base is disabled AFTER a clone already
// exists — exactly what happened to gemini-3.1-pro-preview's google3..google8
// keys when the model lost free-tier access — the clone keeps whatever
// `enabled` it was cloned with (none, i.e. "on") forever, and pickAgents keeps
// seating it. loadRegistry must re-derive a stale clone's `enabled` from its
// base by (provider family, model) on every load.
//
// Runs in a child process: registry.js resolves STATE_DIR from os.homedir()
// at import time, so HOME must be set before the module loads.
function runWithOverlay(overlayAgents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-registry-sync-clone-"));
  const bundledPath = path.join(dir, "bundled.yaml");
  const localDir = path.join(dir, ".local/state/external-agents");
  fs.mkdirSync(localDir, { recursive: true });

  const bundled = {
    schema_version: 1,
    agents: [
      {
        id: "fake-pro-preview",
        provider: "fake",
        model: "fake-pro-preview",
        enabled: false,
        auth: "env:FAKE_API_KEY",
        transports: { generate_new: { url: "https://example.invalid", env: "FAKE_API_KEY", model: "fake-pro-preview" } },
      },
    ],
  };
  fs.writeFileSync(bundledPath, yaml.dump(bundled));
  fs.writeFileSync(path.join(localDir, "agents.local.yaml"), yaml.dump({ schema_version: 1, agents: overlayAgents }));

  const script = `
    import { loadRegistry } from "${new URL("./registry.js", import.meta.url).pathname}";
    const registry = loadRegistry(${JSON.stringify(bundledPath)});
    console.log(JSON.stringify(registry.agents.map((a) => ({ id: a.id, enabled: a.enabled }))));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: dir },
    encoding: "utf-8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("loadRegistry disables a numbered clone that predates its base's disablement", () => {
  const agents = runWithOverlay([
    {
      id: "fake-pro-preview-3",
      provider: "fake3",
      model: "fake-pro-preview",
      // No `enabled` key at all — this is the frozen-at-clone-time snapshot
      // from before the base got `enabled: false`.
      auth: "env:FAKE_API_KEY_3",
      transports: { generate_new: { url: "https://example.invalid", env: "FAKE_API_KEY_3", model: "fake-pro-preview" } },
    },
  ]);
  const clone = agents.find((a) => a.id === "fake-pro-preview-3");
  assert.equal(clone.enabled, false, "a stale clone must inherit its base's disablement");
});

test("loadRegistry does not clobber a clone's own explicit `enabled`", () => {
  const agents = runWithOverlay([
    {
      id: "fake-pro-preview-9",
      provider: "fake9",
      model: "fake-pro-preview",
      enabled: true, // an explicit override some caller set on the clone itself
      auth: "env:FAKE_API_KEY_9",
      transports: { generate_new: { url: "https://example.invalid", env: "FAKE_API_KEY_9", model: "fake-pro-preview" } },
    },
  ]);
  const clone = agents.find((a) => a.id === "fake-pro-preview-9");
  assert.equal(clone.enabled, true, "an explicit `enabled` on the clone entry itself must not be overwritten");
});

test("loadRegistry leaves a clone with no matching base untouched", () => {
  const agents = runWithOverlay([
    {
      id: "orphan-clone-2",
      provider: "orphan2", // no non-numbered "orphan" base exists anywhere
      model: "some-other-model",
      auth: "env:ORPHAN_KEY_2",
      transports: { generate_new: { url: "https://example.invalid", env: "ORPHAN_KEY_2", model: "some-other-model" } },
    },
  ]);
  const clone = agents.find((a) => a.id === "orphan-clone-2");
  assert.equal(clone.enabled, undefined, "a clone with no matching base must be left as-is");
});
