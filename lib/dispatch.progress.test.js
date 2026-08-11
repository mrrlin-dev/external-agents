import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aiderExitCode, buildAiderArgs, classifyCliFailure, emptyRunExitCode, emptyRunReason, resolveEnvFrom, emitPromptSizeWarning, parseExhaustionSignal, probeReadOnlyNonWriting, runDispatch, selectTransport, stripAnsi } from "./dispatch.js";

test("stripAnsi removes terminal escape sequences before CLI output is classified", () => {
  const output = "\u001b[31mPlease sign in to use Cursor Agent\u001b[0m";
  assert.equal(stripAnsi(output), "Please sign in to use Cursor Agent");
  assert.deepEqual(classifyCliFailure(output), { needsAuth: true, quotaExhausted: false });
  assert.deepEqual(
    classifyCliFailure("\u001b[33mYou've reached your Cursor Agent request limit\u001b[0m"),
    { needsAuth: false, quotaExhausted: true },
  );
  assert.deepEqual(
    classifyCliFailure("cursor agent: error running in /tmp/worktree"),
    { needsAuth: false, quotaExhausted: false },
  );
  assert.equal(parseExhaustionSignal("You've reached your Cursor Agent request limit").detected, true);
});

test("emitPromptSizeWarning only emits the highest threshold warning", () => {
  const events = [];
  emitPromptSizeWarning("x".repeat(70000), (message, meta) => {
    events.push({ message, meta });
  });

  assert.equal(events.length, 1);
  assert.match(events[0].message, /70000 bytes exceeds 65536 bytes/);
  assert.deepEqual(events[0].meta, {
    type: "prompt_size",
    bytes: 70000,
    threshold: 65536,
  });
});

test("runDispatch streams chunk progress while buffering final output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-progress-"));
  const script = path.join(dir, "emit.mjs");
  fs.writeFileSync(
    script,
    [
      "process.stdout.write('out-1\\n');",
      "process.stderr.write('err-1\\n');",
      "setTimeout(() => process.stdout.write('out-2\\n'), 10);",
      "setTimeout(() => process.stderr.write('err-2\\n'), 20);",
      "setTimeout(() => process.exit(0), 30);",
    ].join("\n"),
  );

  try {
    const progress = [];
    const result = await runDispatch(
      {
        id: "test-agent",
        env: {},
        transports: {
          edit_exists: { cmd: `${process.execPath} ${script}` },
        },
      },
      "ignored prompt",
      {
        timeoutMs: 1000,
        progress: (message, meta) => progress.push({ message, meta }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "out-1\nout-2\n");
    assert.equal(result.stderr, "err-1\nerr-2\n");
    assert.deepEqual(
      progress.map((entry) => entry.meta),
      [
        { type: "stream", stream: "stdout" },
        { type: "stream", stream: "stderr" },
        { type: "stream", stream: "stdout" },
        { type: "stream", stream: "stderr" },
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch strips ANSI sequences from returned stdout and stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-ansi-"));
  const script = path.join(dir, "ansi.mjs");
  fs.writeFileSync(
    script,
    "process.stdout.write('\\x1b[32mOK\\x1b[0m\\n'); process.stderr.write('\\x1b[31mnope\\x1b[0m\\n')",
  );

  try {
    const result = await runDispatch(
      { id: "test-agent", transports: { edit_exists: { cmd: `${process.execPath} ${script}` } } },
      "ignored prompt",
      { timeoutMs: 1000 },
    );
    assert.equal(result.output, "OK\n");
    assert.equal(result.stderr, "nope\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch passes the prompt as the final positional argument", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-args-"));
  const script = path.join(dir, "args.mjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");

  try {
    const prompt = "make the requested change";
    const result = await runDispatch(
      {
        id: "test-agent",
        transports: {
          edit_exists: { cmd: `${process.execPath} ${script}`, effort_flag: "--effort={level}" },
        },
      },
      prompt,
      { timeoutMs: 1000, effort: "high" },
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.output), ["--effort=high", prompt]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAiderArgs passes the prompt via --message, never as a positional", () => {
  // A positional is a FILENAME to aider — the old lane appended the prompt
  // there and aider tried to add a file named after the whole prompt.
  const args = buildAiderArgs(["aider", "--model", "groq/x"], [], "add a subtract fn", "/tmp/wd", {});
  const msgIdx = args.indexOf("--message");
  assert.ok(msgIdx > -1);
  assert.equal(args[msgIdx + 1], "add a subtract fn");
  assert.equal(args.at(-1), "add a subtract fn", "no positional may follow when no files are attached");
  assert.deepEqual(args.slice(0, 2), ["--model", "groq/x"], "registry flags stay first");
});

test("buildAiderArgs keeps aider from dirtying or committing the caller's worktree", () => {
  const args = buildAiderArgs(["aider"], [], "p", "/tmp/wd", {});
  for (const flag of ["--yes-always", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore", "--map-tokens"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf("--map-tokens") + 1], "0");
  assert.ok(!args.includes("--no-git"), "--no-git leaves aider with an empty chat and it silently edits nothing");
  // History files must land outside the caller's cwd.
  for (const flag of ["--chat-history-file", "--input-history-file"]) {
    const value = args[args.indexOf(flag) + 1];
    assert.ok(!value.startsWith("/tmp/wd"), `${flag} must not be written into the dispatch cwd`);
  }
});

test("buildAiderArgs attaches --file paths as positionals so aider can edit them", () => {
  const args = buildAiderArgs(["aider"], [], "p", "/tmp/wd", {
    files: [{ path: "a.ts" }, { path: "sub/b.ts", lines: "10-50" }, { path: "a.ts" }],
  });
  assert.deepEqual(args.slice(-2), ["/tmp/wd/a.ts", "/tmp/wd/sub/b.ts"], "resolved against cwd, deduped, ranges dropped");
});

test("aiderExitCode re-codes aider's exit-0-on-provider-failure as a failure, from either stream", () => {
  const err = "litellm.RateLimitError: GeminiException - quota";
  assert.equal(aiderExitCode(0, true, err, "", []), 1, "provider error on stdout");
  assert.equal(aiderExitCode(0, true, "", err, []), 1, "provider error on stderr counts the same");
  assert.equal(aiderExitCode(0, true, err, "", [{ path: "a.ts" }]), 0, "edits landed despite a retried error");
  assert.equal(aiderExitCode(0, true, "I need to see the file first.", "", []), 0, "a zero-diff answer is still success");
  assert.equal(aiderExitCode(0, false, err, "", []), 0, "other CLIs keep their own exit code");
  assert.equal(aiderExitCode(2, true, err, "", []), 2, "a real non-zero exit is never overwritten");
});

test("selectTransport resolves an explicit read_only via generate_new", () => {
  const entry = {
    id: "http-only",
    transports: {
      generate_new: { url: "https://x/v1/chat/completions" },
      read_only: { via: "generate_new", verified: "by_construction" },
    },
  };
  assert.equal(selectTransport(entry, { transport: "read_only" }), "generate_new");
});

test("selectTransport refuses a read_only that is undeclared or points at a writing transport", () => {
  assert.throws(
    () => selectTransport(
      { id: "gen-only", transports: { generate_new: { url: "https://x" } } },
      { transport: "read_only" },
    ),
    /does not declare it/,
    "an implicit generate_new fallback is no longer accepted — declarations must be explicit",
  );
  assert.throws(
    () => selectTransport(
      { id: "bad-via", transports: { edit_exists: { cmd: "x" }, read_only: { via: "edit_exists" } } },
      { transport: "read_only" },
    ),
    /not a non-writing transport/,
  );
  assert.throws(
    () => selectTransport(
      { id: "dangling", transports: { edit_exists: { cmd: "x" }, read_only: { via: "generate_new" } } },
      { transport: "read_only" },
    ),
    /has no generate_new transport/,
  );
});

test("probeReadOnlyNonWriting verifies a via:generate_new declaration without a canary run", async () => {
  const result = await probeReadOnlyNonWriting({
    id: "http-only",
    transports: {
      generate_new: { url: "https://x/v1/chat/completions" },
      read_only: { via: "generate_new" },
    },
  });
  assert.deepEqual(result, { ok: true, verified: true, basis: "by_construction" });
});

test("emptyRunExitCode fails a CLI run that said nothing and changed nothing", () => {
  const kiro = "Monthly request limit reached\nThe limits reset on 09/01.";
  assert.equal(emptyRunExitCode(0, "", "", []), 1, "nothing on either stream is not a success");
  assert.equal(emptyRunExitCode(0, "", kiro, []), 1, "kiro diagnoses itself on stderr and still returns no answer");
  assert.equal(emptyRunExitCode(0, "   \n\t ", "", []), 1, "whitespace-only counts as empty");
  assert.equal(emptyRunExitCode(0, "", "", [{ path: "a.ts" }]), 0, "silent but edited a file");
  assert.equal(emptyRunExitCode(0, "no", kiro, []), 0, "an answer on stdout wins over noise on stderr");
  assert.equal(emptyRunExitCode(3, "", "", []), 3, "a real non-zero exit is never overwritten");
});

test("resolveEnvFrom maps a sibling credential onto the name a CLI hard-codes", () => {
  process.env.EA_TEST_KEY_2 = "second-key";
  try {
    // The case this exists for: aider only ever reads GEMINI_API_KEY, while the
    // 2nd Google key lives in GEMINI_API_KEY_2.
    assert.deepEqual(
      resolveEnvFrom({ EA_TEST_KEY: "EA_TEST_KEY_2" }, { id: "sibling" }),
      { EA_TEST_KEY: "second-key" },
    );
    // A per-entry env: override is a valid source too.
    assert.deepEqual(
      resolveEnvFrom({ EA_TEST_KEY: "EA_TEST_OVERRIDE" }, { id: "s", env: { EA_TEST_OVERRIDE: "inline" } }),
      { EA_TEST_KEY: "inline" },
    );
    // An unset source is skipped, never exported empty: an absent variable
    // makes the CLI report "no credential", an empty one makes it send
    // `Bearer ` and get an opaque 401.
    assert.deepEqual(resolveEnvFrom({ EA_TEST_KEY: "EA_TEST_MISSING" }, { id: "s" }), {});
    assert.deepEqual(resolveEnvFrom(undefined, { id: "s" }), {});
  } finally {
    delete process.env.EA_TEST_KEY_2;
  }
});

test("runDispatch exports env_from into the child, not into the parent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-envfrom-"));
  const script = path.join(dir, "dump.mjs");
  fs.writeFileSync(script, "process.stdout.write(process.env.EA_TARGET ?? '<unset>')");
  process.env.EA_SOURCE_2 = "sibling-secret";
  try {
    const result = await runDispatch(
      {
        id: "sibling",
        transports: {
          edit_exists: { cmd: `${process.execPath} ${script}`, env_from: { EA_TARGET: "EA_SOURCE_2" } },
        },
      },
      "ignored",
      { timeoutMs: 5000 },
    );
    assert.equal(result.output, "sibling-secret");
    assert.equal(process.env.EA_TARGET, undefined, "the parent process must not be mutated");
  } finally {
    delete process.env.EA_SOURCE_2;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("emptyRunReason distinguishes a diagnosed empty run from a silent one", () => {
  assert.match(emptyRunReason("", "Monthly request limit reached", []), /see stderr/);
  assert.match(emptyRunReason("", "", []), /nothing on stderr/);
  assert.equal(emptyRunReason("answer", "", []), null);
  assert.equal(emptyRunReason("", "", [{ path: "a.ts" }]), null);
});

test("runDispatch refuses to serve a read_only request from an aider entry", () => {
  assert.throws(
    () => runDispatch(
      { id: "aider-entry", transports: { read_only: { cmd: "aider --model groq/x" } } },
      "prompt",
      {},
      "read_only",
    ),
    /aider has no read_only mode/,
  );
});

test("runDispatch reads the read_only command, not edit_exists, when transportKind is 'read_only'", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-ro-kind-"));
  const roScript = path.join(dir, "ro.mjs");
  const editScript = path.join(dir, "edit.mjs");
  fs.writeFileSync(roScript, "process.stdout.write('read-only-ran')");
  fs.writeFileSync(editScript, "process.stdout.write('edit-exists-ran')");

  try {
    const entry = {
      id: "test-agent",
      transports: {
        edit_exists: { cmd: `${process.execPath} ${editScript}` },
        read_only: { cmd: `${process.execPath} ${roScript}` },
      },
    };
    const result = await runDispatch(entry, "ignored", { timeoutMs: 1000 }, "read_only");
    assert.equal(result.output, "read-only-ran");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch throws naming the requested transportKind when that command is missing", () => {
  assert.throws(
    () => runDispatch({ id: "no-ro", transports: { edit_exists: { cmd: "example-cli" } } }, "ignored", {}, "read_only"),
    /no read_only transport for no-ro/,
  );
});

test("probeReadOnlyNonWriting reports verified:true when the canary file is untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-probe-ro-noop-"));
  const script = path.join(dir, "noop.mjs");
  fs.writeFileSync(script, "process.stdout.write('did nothing')");

  try {
    const result = await probeReadOnlyNonWriting({
      id: "noop-agent",
      transports: { read_only: { cmd: `${process.execPath} ${script}` } },
    });
    assert.deepEqual(result, { ok: true, verified: true, latencyMs: result.latencyMs });
    assert.equal(typeof result.latencyMs, "number");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("probeReadOnlyNonWriting reports verified:false when the command mutates the canary file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-probe-ro-writer-"));
  // Simulates the exact failure mode this axis exists to catch: a command
  // whose flags look non-writing but isn't — it overwrites whatever file it
  // is pointed at, in this case probe.txt in its cwd.
  const script = path.join(dir, "writer.mjs");
  fs.writeFileSync(script, "import fs from 'node:fs'; fs.writeFileSync('probe.txt', 'GOODBYE');");

  try {
    const result = await probeReadOnlyNonWriting({
      id: "sneaky-writer",
      transports: { read_only: { cmd: `${process.execPath} ${script}` } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
    assert.match(result.hint, /wrote to the canary file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("probeReadOnlyNonWriting will not certify a command that never ran", async () => {
  // The canary survives a command that could not start, so "unchanged" alone
  // proved nothing: /bin/true and a missing binary both used to come back
  // verified, and so did any real CLI that was quota-gated at the time.
  for (const cmd of ["definitely-not-a-real-binary-xyz", "true"]) {
    const result = await probeReadOnlyNonWriting({ id: "t", transports: { read_only: { cmd } } });
    assert.equal(result.verified, false, `${cmd} must not certify`);
    assert.equal(result.inconclusive, true, `${cmd} is inconclusive, not a proven writer`);
    assert.match(result.hint, /nothing ran/);
  }
  // A command that actually ran and declined is the real pass.
  const ok = await probeReadOnlyNonWriting({
    id: "t", transports: { read_only: { cmd: "echo I-will-not-edit-anything" } },
  });
  assert.equal(ok.verified, true);
});

test("probeReadOnlyNonWriting refuses to probe an entry with no declared read_only command", async () => {
  const result = await probeReadOnlyNonWriting({ id: "none", transports: {} });
  assert.deepEqual(result, { ok: false, verified: false, hint: "no read_only transport declared" });
});

test("runDispatch accepts a bare-string aider edit_exists transport", () => {
  // The 0.33.4 migration error is gone: aider is a supported edit_exists CLI
  // again, and the legacy bare-string form still resolves.
  assert.doesNotThrow(
    () => runDispatch({ id: "legacy", transports: { edit_exists: "aider --model example" } }, "ignored"),
  );
});

test("runDispatch emits heartbeat when the child stays silent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-heartbeat-"));
  const script = path.join(dir, "silent.mjs");
  fs.writeFileSync(
    script,
    [
      "setTimeout(() => process.exit(0), 35);",
    ].join("\n"),
  );

  try {
    const progress = [];
    const result = await runDispatch(
      {
        id: "test-agent",
        env: {},
        transports: {
          edit_exists: { cmd: `${process.execPath} ${script}` },
        },
      },
      "ignored prompt",
      {
        timeoutMs: 1000,
        heartbeatMs: 10,
        progress: (message, meta) => progress.push({ message, meta }),
      },
    );

    // The fixture says nothing and changes nothing, so emptyRunExitCode
    // re-codes its exit 0 to 1 — that is the point of this fixture, and the
    // heartbeat assertions below are what this test is actually about.
    assert.equal(result.exitCode, 1);
    assert.equal(result.output, "");
    // Nothing on either stream, so the reason line is the whole of stderr.
    assert.match(result.stderr, /nothing on stderr/);
    assert.ok(progress.some((entry) => entry.meta?.type === "heartbeat"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch timeout terminates the subprocess group", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-group-"));
  const marker = path.join(dir, "descendant-survived");
  const script = path.join(dir, "parent.mjs");
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 120)`;
  fs.writeFileSync(
    script,
    `import { spawn } from 'node:child_process'; spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
  );

  try {
    const result = await runDispatch(
      { id: "group", transports: { edit_exists: { cmd: `${process.execPath} ${script}` } } },
      "ignored",
      { timeoutMs: 30 },
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(result.exitCode, 124);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
