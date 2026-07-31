import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emitPromptSizeWarning, runDispatch } from "./dispatch.js";

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
