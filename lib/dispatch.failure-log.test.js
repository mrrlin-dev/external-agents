import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAny, redactionEnv } from "./dispatch.js";
import { readFailures, getFailureLogPath, getConfigPath } from "./failure-log.js";

// The unit tests in failure-log.test.js drive recordFailure directly. This one
// proves the WIRING: a real dispatch that really fails must land in the real
// sink, at the real path, with the raw output attached. Those are separate
// claims and the second is the one that silently rots when a return shape in
// dispatch.js changes.
//
// It writes to a scratch sink, not the operator's real log. Two reasons, and
// the second is the one that bites: test files run in parallel processes, so a
// shared append-only file makes "the rows added since I started" a race — and
// once the operator has the flag on for real, every other dispatch test in this
// suite starts appending to it too. The real path is asserted separately, at
// the bottom, where it costs nothing.

// Must AWAIT inside the try. A synchronous `return fn()` restores the variable
// the moment the promise is created, i.e. long before the dispatch it is meant
// to be governing reaches recordFailure — which reads the env at write time.
// The first draft of this helper did exactly that, and every assertion below
// passed for the wrong reason.
async function withFailureLog(value, fn) {
  const saved = process.env.EXTERNAL_AGENTS_FAILURE_LOG;
  process.env.EXTERNAL_AGENTS_FAILURE_LOG = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.EXTERNAL_AGENTS_FAILURE_LOG;
    else process.env.EXTERNAL_AGENTS_FAILURE_LOG = saved;
  }
}
const withFailureLogOn = (fn) => withFailureLog("1", fn);

const SINK = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "ea-fl-sink-")),
  "failures.jsonl",
);
process.env.EXTERNAL_AGENTS_FAILURE_LOG_FILE = SINK;

// The same courtesy for the OTHER sink. Every runAny below writes an aggregate
// row too, and that one is unconditional — no flag turns it off. Until this
// override existed those rows went to the operator's real dispatch log: three
// fixture ids × 119 suite runs = 357 rows of guaranteed-failure noise, which
// doctor.js then had to subtract back out with a `/^test-/` filter. Redirect it
// for the same reason the sink above is redirected, and for one more: the
// fixtures here fail on purpose, so leaving them in the real log actively
// misreports the health of the pool.
const DISPATCH_SINK = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "ea-dl-sink-")),
  "dispatch-log.jsonl",
);
process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE = DISPATCH_SINK;

function dispatchRowsFor(agentId) {
  let raw;
  try { raw = fs.readFileSync(DISPATCH_SINK, "utf-8"); } catch { return []; }
  return raw.split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.agent_id === agentId);
}

function rowsFor(agentId) {
  return readFailures(0).filter((r) => r.agent_id === agentId);
}

// A registry `cmd` is whitespace-split, not shell-parsed, so a quoted `sh -c
// '…'` one-liner cannot be expressed as one. Real entries are `binary --flags`;
// a script on disk is the faithful stand-in.
function scriptEntry(id, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ea-fl-bin-${id}-`));
  const file = path.join(dir, "fake-agent.sh");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return {
    id,
    provider: "test",
    model: "test-model",
    transports: { edit_exists: { cmd: `${file} --print` } },
    _scriptDir: dir,
  };
}

test("a failing CLI dispatch is recorded whole, with argv and both raw streams", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ea-fl-e2e-"));
  // Prints to both streams, then fails — the shape a real CLI error takes.
  const entry = scriptEntry("test-failing-cli", "echo BANNER\necho REAL_ERROR_HERE >&2\nexit 42");
  await withFailureLogOn(() => runAny(entry, "do the thing", { cwd, provenance: false }));

  const [row] = rowsFor("test-failing-cli");
  assert.ok(row, "the failing dispatch produced no failure-log row");
  assert.equal(row.stage, "dispatch");
  assert.equal(row.outcome, "error");
  assert.equal(row.exit_code, 42);
  assert.match(row.raw.stderr, /REAL_ERROR_HERE/);
  assert.match(row.raw.stdout, /BANNER/);
  assert.match(row.reason, /REAL_ERROR_HERE/);
  // The argv is the point of the exercise: it is what the aggregate log has
  // never carried, and what a model needs to spot a wrong flag.
  assert.match(row.command.cmd, /fake-agent\.sh$/);
  assert.ok(Array.isArray(row.command.argv));
  assert.equal(row.command.cwd, cwd);
  // Default config: the prompt is a byte count, never the text.
  assert.equal(row.prompt_text, undefined);
  assert.ok(row.command.argv.some((a) => /prompt elided/.test(a)));

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(entry._scriptDir, { recursive: true, force: true });
});

test("a successful dispatch writes nothing to the failure log", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ea-fl-e2e-ok-"));
  // Has to answer on stdout: an exit-0 run that produced neither output nor a
  // file change is failed on purpose by emptyRunExitCode, and would be logged
  // — correctly, but that is not what this test is about.
  const entry = scriptEntry("test-succeeding-cli", "echo ok");
  const result = await withFailureLogOn(() => runAny(entry, "do the thing", { cwd, provenance: false }));
  assert.equal(result.exitCode, 0, `expected success, got stderr: ${result.stderr}`);
  assert.equal(rowsFor("test-succeeding-cli").length, 0);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(entry._scriptDir, { recursive: true, force: true });
});

test("with the flag off, the same failure writes nothing", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ea-fl-e2e-off-"));
  const entry = scriptEntry("test-failing-cli-off", "exit 9");
  await withFailureLog("0", () => runAny(entry, "do the thing", { cwd, provenance: false }));
  assert.equal(rowsFor("test-failing-cli-off").length, 0);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(entry._scriptDir, { recursive: true, force: true });
});

test("by default the sink and the flag live in the operator's state dir, not the package", () => {
  const stateDir = path.join(os.homedir(), ".local", "state", "external-agents");
  const override = process.env.EXTERNAL_AGENTS_FAILURE_LOG_FILE;
  delete process.env.EXTERNAL_AGENTS_FAILURE_LOG_FILE;
  try {
    // The point of the state dir: `npm i -g …@latest` replaces the package
    // directory and leaves this one alone, so the switch survives the upgrade.
    assert.ok(getFailureLogPath().startsWith(stateDir), getFailureLogPath());
    assert.ok(getConfigPath().startsWith(stateDir), getConfigPath());
  } finally {
    process.env.EXTERNAL_AGENTS_FAILURE_LOG_FILE = override;
  }
});


// ---------------------------------------------------------------------------
// A per-entry `env:` credential is applied to the SUBPROCESS ONLY, so the parent
// never holds it and `redact()`'s value layer — which blanks the exact strings
// this process is carrying — cannot see it. Both sinks fell back to
// `process.env` and would have written such a key down verbatim if the CLI
// echoed it back. Nothing bundled uses `env:`, so this was a property to fix,
// not an incident to clean up.
//
// The secret below is deliberately shapeless: no `sk-`, no `gsk_`, no `AIza`.
// A key-shaped value would be caught by the PATTERN layer and the test would
// pass with the fix reverted, proving nothing.
// ---------------------------------------------------------------------------

const ENTRY_ONLY_SECRET = "zzTopSecretValueFromEntryEnv9911";

function entryEnvScript(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ea-fl-env-${id}-`));
  const file = path.join(dir, "fake-agent.sh");
  // Echo the injected credential back the way a CLI does when it rejects it.
  fs.writeFileSync(file, '#!/bin/sh\necho "auth failed for key $MY_ENTRY_API_KEY" >&2\nexit 7\n', { mode: 0o755 });
  return {
    id,
    provider: "test",
    model: "test-model",
    env: { MY_ENTRY_API_KEY: ENTRY_ONLY_SECRET },
    transports: { edit_exists: { cmd: `${file} --print` } },
    _scriptDir: dir,
  };
}

test("a credential injected only into the child's env is redacted from BOTH sinks", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ea-fl-env-e2e-"));
  const entry = entryEnvScript("test-entry-env-leak");
  assert.ok(!process.env.MY_ENTRY_API_KEY, "the parent must not hold it — that is the whole point");

  await withFailureLogOn(() => runAny(entry, "do the thing", { cwd, provenance: false }));

  const [failure] = rowsFor("test-entry-env-leak");
  assert.ok(failure, "no failure-log row");
  assert.ok(!JSON.stringify(failure).includes(ENTRY_ONLY_SECRET), "sidecar leaked the entry-env credential");
  assert.match(failure.raw.stderr, /«redacted:MY_ENTRY_API_KEY»/);

  const [aggregate] = dispatchRowsFor("test-entry-env-leak");
  assert.ok(aggregate, "no dispatch-log row");
  assert.ok(!JSON.stringify(aggregate).includes(ENTRY_ONLY_SECRET), "dispatch log leaked the entry-env credential");
  assert.match(aggregate.error_preview, /«redacted:MY_ENTRY_API_KEY»/);
  // Redacted, not destroyed: the diagnosis has to survive.
  assert.match(aggregate.error_preview, /auth failed for key/);

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(entry._scriptDir, { recursive: true, force: true });
});

test("redactionEnv merges the entry's env over the parent's, and is inert for a bare entry", () => {
  const entry = { id: "t", env: { MY_ENTRY_API_KEY: ENTRY_ONLY_SECRET }, transports: { edit_exists: { cmd: "x" } } };
  assert.equal(redactionEnv(entry, "edit_exists").MY_ENTRY_API_KEY, ENTRY_ONLY_SECRET);
  assert.equal(redactionEnv(entry, "edit_exists").PATH, process.env.PATH, "the parent's env is still there");
  assert.equal(redactionEnv({ id: "t" }, "edit_exists").MY_ENTRY_API_KEY, undefined);
  assert.equal(redactionEnv(null), process.env);
});
