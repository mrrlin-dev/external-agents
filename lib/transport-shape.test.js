import assert from "node:assert/strict";
import { test } from "node:test";

import { getTransportConfig } from "./dispatch.js";
import { probeInstalled } from "./state.js";

// Regression guard for 0.33.1.
//
// 0.33.0 converted several `edit_exists` transports from the legacy bare
// command string to a map ({ cmd, effort_levels, effort_flag, ... }) so they
// could declare reasoning-effort support. Two call sites still read the field
// directly instead of going through the normalizer, and broke on the map form:
//
//   - state.js  → realBinaryOf(object) threw "cmd.trim is not a function"
//   - dispatch.js auditCliEntry → interpolated the object into a bash string,
//     producing `[object Object]: command not found`
//
// Both forms must behave identically everywhere.

const BARE = { auth: "cli:demo", transports: { edit_exists: "demo --print" } };
const MAP = {
  auth: "cli:demo",
  transports: {
    edit_exists: { cmd: "demo --print", effort_levels: ["low", "high"], effort_flag: "--effort {level}" },
  },
};

test("getTransportConfig normalizes both edit_exists forms to a cmd string", () => {
  assert.equal(getTransportConfig(BARE, "edit_exists").cmd, "demo --print");
  assert.equal(getTransportConfig(MAP, "edit_exists").cmd, "demo --print");
  assert.equal(getTransportConfig({ transports: {} }, "edit_exists"), null);
});

test("getTransportConfig preserves effort metadata on the map form only", () => {
  assert.deepEqual(getTransportConfig(MAP, "edit_exists").effort_levels, ["low", "high"]);
  assert.equal(getTransportConfig(BARE, "edit_exists").effort_levels, undefined);
});

test("probeInstalled does not throw on the map form and agrees with the bare form", () => {
  // The binary "demo" does not exist, so both must report not_installed rather
  // than throwing. Before the fix, the map form threw a TypeError here.
  const bare = probeInstalled(BARE);
  const map = probeInstalled(MAP);
  assert.equal(bare.state, map.state);
  assert.equal(map.state, "not_installed");
});

test("probeInstalled still reports a missing transport", () => {
  const { state } = probeInstalled({ auth: "cli:demo", transports: {} });
  assert.equal(state, "errored_transient");
});

test("probeInstalled walks past an env prefix on both forms", () => {
  const envBare = { auth: "cli:demo", transports: { edit_exists: "env -u FOO demo --print" } };
  const envMap = { auth: "cli:demo", transports: { edit_exists: { cmd: "env -u FOO demo --print" } } };
  // Must resolve the real binary ("demo", absent) rather than "env" (always present).
  assert.equal(probeInstalled(envBare).state, "not_installed");
  assert.equal(probeInstalled(envMap).state, "not_installed");
});
