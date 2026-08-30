import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

import { firstFailureReason } from "./dispatch.js";
import { sharedQuotaBucketIds } from "./outcome.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "cli.js");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ea-pool-findings-"));
}

test("the overlay lock creates its own state directory on a clean machine", () => {
  // Found while testing the fix above: withLocalOverlayLock opened the lock file
  // without ensuring its directory existed, so on a machine where nothing had
  // written state yet, add-model died with ENOENT on the lock.
  const home = tmpHome();
  const res = spawnSync(process.execPath, [
    cliPath, "add-model", "--id", "clean-machine-entry", "--provider", "testprov",
    "--url", "https://example.invalid/v1", "--model", "m", "--env", "TEST_API_KEY",
  ], { encoding: "utf-8", cwd: repoRoot, env: { ...process.env, HOME: home }, timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(home, ".local/state/external-agents/agents.local.yaml")));
});

test("add-model writes the explicit read_only declaration its own dispatcher requires", () => {
  // The root cause. `pick --transport read_only` seated a locally added entry
  // and `dispatch --transport read_only` refused it, because add-model created
  // the entry with generate_new alone. It was the ONLY entry of 52 in the
  // resolved registry missing the declaration — and it was locally added, which
  // is exactly what that says about where entries come from.
  const home = tmpHome();
  const res = spawnSync(process.execPath, [
    cliPath, "add-model",
    "--id", "test-http-entry",
    "--provider", "testprov",
    "--url", "https://example.invalid/v1/chat/completions",
    "--model", "test-model",
    "--env", "TEST_API_KEY",
  ], { encoding: "utf-8", cwd: repoRoot, env: { ...process.env, HOME: home }, timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);

  const overlay = yaml.load(
    fs.readFileSync(path.join(home, ".local/state/external-agents/agents.local.yaml"), "utf-8"),
  );
  const entry = overlay.agents.find((a) => a.id === "test-http-entry");
  assert.ok(entry, "entry was not written");
  assert.deepEqual(entry.transports.read_only, { via: "generate_new", verified: "by_construction" });
});

test("a transport refusal exits gracefully and is recorded, instead of throwing a stack trace", () => {
  // Before: an uncaught Error escaped selectTransport, so the process died with
  // a Node stack trace and exit 1 — all a caller could report was "rc=1" — and
  // because the throw happened before any dispatch, the sidecar failure log
  // (which exists to capture pre-dispatch refusals) recorded nothing at all.
  const home = tmpHome();
  const stateDir = path.join(home, ".local/state/external-agents");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "agents.local.yaml"), yaml.dump({
    schema_version: 1,
    agents: [{
      id: "edit-only-entry",
      provider: "testprov",
      model: "test-model",
      tier: "strong",
      auth: "env:TEST_API_KEY",
      transports: { edit_exists: { cmd: "example-cli --write" } },
    }],
  }));
  const failureLog = path.join(stateDir, "failures.jsonl");
  const res = spawnSync(process.execPath, [
    cliPath, "dispatch", "edit-only-entry", "--transport", "read_only", "hello",
  ], {
    encoding: "utf-8",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      EXTERNAL_AGENTS_FAILURE_LOG: "1",
      EXTERNAL_AGENTS_FAILURE_LOG_FILE: failureLog,
    },
    timeout: 30000,
  });

  assert.equal(res.status, 4, `expected a graceful refusal exit, got ${res.status}: ${res.stderr}`);
  assert.ok(!/^\s+at /m.test(res.stderr), `a stack trace escaped:\n${res.stderr}`);
  const refusal = JSON.parse(res.stderr.trim().split("\n").pop());
  assert.equal(refusal.outcome, "transport_refused");
  assert.deepEqual(refusal.declared_transports, ["edit_exists"]);

  const rows = fs.readFileSync(failureLog, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const row = rows.find((r) => r.agent_id === "edit-only-entry");
  assert.ok(row, "the refusal left no row in the failure log");
  assert.equal(row.stage, "precheck");
  assert.equal(row.outcome, "refused");
  assert.equal(row.requested_transport, "read_only");
});

test("a benign stderr warning never becomes the failure reason", () => {
  // Three recorded failures carried `Warning: Input is not a terminal (fd=0).`
  // as their reason. The filter for it already existed and was applied to the
  // error preview — just not here.
  const reason = firstFailureReason({
    exitCode: 1,
    stderr: "litellm.APIError: provider refused the request\nWarning: Input is not a terminal (fd=0).\n",
    output: "",
  });
  assert.match(reason, /provider refused the request/);
  assert.doesNotMatch(reason, /not a terminal/);
});

test("a benign line is still reported when it is genuinely all there is", () => {
  // The filter strips noise from the reason, it does not invent silence: with
  // nothing else to say, the caller still gets the exit code rather than a lie.
  const reason = firstFailureReason({
    exitCode: 3,
    stderr: "Warning: Input is not a terminal (fd=0).\n",
    output: "",
  });
  assert.match(reason, /exit 3/);
});

test("an account-wide free tier goes out as one bucket, and only that bucket", () => {
  // OpenRouter's free tier is one per-account daily cap across every :free
  // model, so exhausting one exhausts them all. The registry models them as
  // separate entries, so the rest kept looking healthy and were picked in turn
  // to rediscover the same cap — four consecutive gate runs, ending in a re-pick
  // that found no non-openrouter candidate and proceeded on the 2-voice floor.
  const agents = [
    { id: "or-a-free", provider: "openrouter", model: "x/a:free" },
    { id: "or-b-free", provider: "openrouter2", model: "y/b:free" },
    { id: "or-paid", provider: "openrouter", model: "y/b" },
    { id: "groq-1", provider: "groq", model: "openai/gpt-oss-120b" },
    { id: "groq-2", provider: "groq2", model: "openai/gpt-oss-120b" },
  ];
  assert.deepEqual(sharedQuotaBucketIds(agents[0], agents), ["or-b-free"]);
  // A paid model on the same key is metered separately and must not be dragged down.
  assert.deepEqual(sharedQuotaBucketIds(agents[2], agents), []);
  // groq's numbered keys are separate allowances — collapsing them would take a
  // healthy seat out of the pool for no reason.
  assert.deepEqual(sharedQuotaBucketIds(agents[3], agents), []);
});

test("--help on a subcommand prints help instead of running it", () => {
  // `pick --help` printed nothing and performed a real pick, returning an agent
  // id. Anything probing for a flag that way read the id, concluded the flag was
  // absent, and silently dropped it — which is how the consensus runner kept
  // sending oversized prompts after the sizing filter had shipped.
  const res = spawnSync(process.execPath, [cliPath, "pick", "--help"], {
    encoding: "utf-8", cwd: repoRoot, env: { ...process.env, HOME: tmpHome() }, timeout: 30000,
  });
  const out = res.stdout + res.stderr;
  assert.match(out, /external-agents CLI — subcommands:/);
  assert.doesNotMatch(res.stdout, /^\S+-\S+$/m, "an agent id was printed — the subcommand ran");
});

test("the sizing flags are documented in the printed help, not only in source comments", () => {
  // Shell-side feature detection reads the help TEXT. A flag documented only in
  // a source comment is, to that caller, a flag that does not exist.
  const res = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf-8", cwd: repoRoot, env: { ...process.env, HOME: tmpHome() }, timeout: 30000,
  });
  assert.match(res.stdout + res.stderr, /--prompt-bytes/);
});
