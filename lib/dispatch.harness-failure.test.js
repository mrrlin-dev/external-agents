import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isHarnessFailure, classifyVerifyResult, shouldPersistOutcome, auditCliEntry } from "./dispatch.js";

// Hermeticity: these fixtures drive real failure paths (audit, read-only probe),
// and the sidecar failure log is a live operator setting — when it is switched
// on, an unguarded suite run appends its fixtures to the operator's OWN
// ~/.local/state/external-agents/failures.jsonl and mixes test noise into the
// data they diagnose with. Measured, not hypothetical: a full-suite run added 8
// rows. Redirecting the sink is enough; the flag itself is left alone so the
// logging code under test still executes.
process.env.EXTERNAL_AGENTS_FAILURE_LOG_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "ea-failure-log-test-")),
  "failures.jsonl",
);


// The incident: `claude-opus-5` sat in state.json as
//   errored_transient — "bash: line 1: env: command not found"
// The registry command for that entry starts with `env -u ANTHROPIC_BASE_URL …`,
// and the probe had been spawned by a process whose PATH did not contain
// /usr/bin. So `claude` was never invoked at all — yet the failure was recorded
// against the agent, and because errored_transient carried no expiry it removed
// the strongest entry in the pool from every subsequent pick, permanently and
// silently.

test("isHarnessFailure recognises a shell that could not execute the command", () => {
  assert.equal(isHarnessFailure("bash: line 1: env: command not found", 127), true);
  // Exit 127 alone is enough — the shell's own "cannot execute" code.
  assert.equal(isHarnessFailure("", 127), true);
  // And the text alone is enough, for shells that exit differently.
  assert.equal(isHarnessFailure("bash: line 1: env: command not found", 1), true);
  assert.equal(isHarnessFailure("sh: cursor-agent: not found", 1), true);
  assert.equal(isHarnessFailure("Error: spawn claude ENOENT", 1), true);
});

test("isHarnessFailure covers the shell dialects that report it differently", () => {
  assert.equal(isHarnessFailure("sh: 1: cursor-agent: not found", 1), true);   // dash
  assert.equal(isHarnessFailure("/bin/sh: claude: not found", 1), true);       // busybox
  assert.equal(isHarnessFailure("zsh: command not found: agy", 1), true);      // zsh word order
});

test("isHarnessFailure does not swallow real agent failures", () => {
  assert.equal(isHarnessFailure("Not logged in. Please run /login", 1), false);
  assert.equal(isHarnessFailure("Monthly request limit reached", 1), false);
  assert.equal(isHarnessFailure("HTTP 429: rate limit exceeded", 1), false);
  assert.equal(isHarnessFailure("exit 0 but response did not include expected marker", 0), false);
  assert.equal(isHarnessFailure("", 1), false);
  assert.equal(isHarnessFailure(null, 1), false);
});

// The expensive direction of a false positive: an agent making a real
// observation about itself gets discarded as "our probe broke", the stale
// verdict is kept, and the actual problem never reaches state.json. A bare
// ": not found" anywhere in the output used to be enough to trigger it, so
// these must stay negative.
test("a real agent error that merely mentions something not found is not a harness failure", () => {
  assert.equal(isHarnessFailure("Error: config.json: not found", 1), false);
  assert.equal(isHarnessFailure("Model gpt-x: not found on this account", 1), false);
  assert.equal(isHarnessFailure("repository: not found", 1), false);
});

test("a harness failure classifies as probe_error and is never persisted", () => {
  assert.equal(classifyVerifyResult({ ok: false, harnessError: true }), "probe_error");
  assert.equal(shouldPersistOutcome("probe_error"), false);

  // Everything else still records what it observed.
  for (const outcome of ["healthy", "needs_auth", "quota_exhausted", "rate_limited", "model_unavailable", "errored_transient"]) {
    assert.equal(shouldPersistOutcome(outcome), true);
  }
});

test("quota and auth outrank a harness failure — those are real observations", () => {
  // Precedence matters: if a CLI actually answered and said "not logged in",
  // that is a fact about the agent even if the text happens to trip a pattern.
  assert.equal(classifyVerifyResult({ ok: false, needsAuth: true, harnessError: false }), "needs_auth");
  assert.equal(classifyVerifyResult({ ok: false, quotaExhausted: true }), "quota_exhausted");
});

test("auditCliEntry reports a missing binary as a probe error, not an agent verdict", async () => {
  const entry = {
    id: "definitely-not-installed",
    provider: "test",
    transports: { edit_exists: { cmd: "ea-no-such-binary-9f3c --print" } },
  };
  const v = await auditCliEntry(entry);
  assert.equal(v.ok, false);
  assert.equal(v.harnessError, true);
  assert.match(v.hint, /says nothing about the agent/);
  assert.equal(classifyVerifyResult(v), "probe_error");
});
