import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyCliFailure, emitPromptSizeWarning, parseExhaustionSignal, runDispatch, stripAnsi } from "./dispatch.js";

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

test("runDispatch rejects a legacy aider transport with a migration error", () => {
  assert.throws(
    () => runDispatch({ id: "legacy", transports: { edit_exists: "aider --model example" } }, "ignored"),
    /legacy aider transport is no longer supported/,
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

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "");
    assert.equal(result.stderr, "");
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
