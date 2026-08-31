import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

import { aiderExitCode, auditCliEntry, buildAiderArgs, declaredRepoRelPaths, outOfScopeChanges, outOfScopeReason, scopeBaseline, classifyCliFailure, classifyDispatchFailure, emptyRunExitCode, emptyRunReason, resolveEnvFrom, emitPromptSizeWarning, MAX_TOTAL_FILE_BYTES, parseExhaustionSignal, probeReadOnlyNonWriting, runDispatch, selectTransport, stripAnsi } from "./dispatch.js";

// Wall-clock budget for the fixtures below that are expected to RUN TO
// COMPLETION. Each spawns a fresh `node` (~100-300ms cold on an idle machine,
// but comfortably over 1s when the box is loaded -- a parallel test run, a
// build, a concurrent `git` operation), so a tight budget makes these fail as
// exit code 124 on CPU contention rather than on any product behaviour.
// Generous on purpose: a passing run never waits this long, the budget only
// bounds a genuine hang. The deliberate timeout tests keep their own tight
// budgets inline.
const SPAWN_TIMEOUT_MS = 10_000;

// Liveness of a process we did not spawn ourselves. ESRCH is the only answer
// that means "gone"; EPERM means it exists but belongs to someone else, and is
// deliberately reported as alive — a test must never pass because it lacked the
// permission to look.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}

// Poll until a condition holds, or fail with a message that says what was being
// waited for.
//
// The two process-group tests below used to assert against fixed sleeps: spawn a
// descendant that writes a marker file after 120-250ms, kill the group, sleep a
// bit longer, assert the marker is absent. That encodes a race in both
// directions. Too slow and the kill lands after the marker is already written,
// so a working process-group kill reports a failure (this is what made
// "forwards parent SIGTERM" go red in a loaded full-suite run while passing 3/3
// in isolation). Too slow the OTHER way and the descendant has not even booted
// by the time the assertion runs, so a BROKEN group kill reports success.
//
// Waiting for a PID to stop existing has neither failure mode: it is the thing
// "terminates the process group" actually claims, the deadline only bounds a
// genuine hang, and a passing run never waits for it.
async function waitFor(predicate, { timeoutMs, message }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

test("context-window failures do not masquerade as quota exhaustion", () => {
  const output = 'litellm.RateLimitError: Ollama_chatException - {"error":"prompt too long; exceeded max context length by 286082 tokens"}';
  assert.deepEqual(classifyCliFailure(output), { needsAuth: false, quotaExhausted: false });
  assert.equal(parseExhaustionSignal(output).detected, false);
});

test("classifyDispatchFailure produces the same exhaustion decision for context-window and real quota errors", () => {
  const contextWindow = classifyDispatchFailure(
    'litellm.APIConnectionError: {"error":"input is too long; context length exceeded"}',
  );
  assert.equal(contextWindow.isExhaustion, false);
  assert.equal(contextWindow.exhaustionSignal.detected, false);
  assert.equal(contextWindow.cliFailure.quotaExhausted, false);

  const quota = classifyDispatchFailure("You've reached your Cursor Agent request limit");
  assert.equal(quota.isExhaustion, true);
  assert.equal(quota.exhaustionSignal.detected, true);
  assert.equal(quota.cliFailure.quotaExhausted, true);
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
        timeoutMs: SPAWN_TIMEOUT_MS,
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
      { timeoutMs: SPAWN_TIMEOUT_MS },
    );
    assert.equal(result.output, "OK\n");
    assert.equal(result.stderr, "nope\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditCliEntry inserts prompt_flag immediately before the prompt, like runDispatch does", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-prompt-flag-"));
  const script = path.join(dir, "echoargv.mjs");
  const argvFile = path.join(dir, "argv.json");
  fs.writeFileSync(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2))); process.stdout.write("OK\\n")`,
  );

  try {
    const result = await auditCliEntry({
      id: "agy-like-agent",
      transports: {
        edit_exists: { cmd: `${process.execPath} ${script} --model fake`, prompt_flag: "--print" },
      },
    });
    assert.equal(result.ok, true);
    // Without prompt_flag inserted here, the probe's prompt would trail
    // --model's value with no --print at all — the exact gap that let agy
    // boot its full interactive TUI (and crash for lack of a TTY) instead of
    // answering in --print mode.
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf-8"));
    assert.deepEqual(argv.slice(-2), ["--print", "reply exactly OK"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditCliEntry keeps scanning past an unrelated leading '{' to find the real JSON error body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-json-leading-brace-"));
  const script = path.join(dir, "leadingbrace.mjs");
  fs.writeFileSync(
    script,
    "process.stderr.write('Loading {module}...\\nError: {\\n  \"message\": \"real error behind the decoy brace\"\\n}\\n'); process.exit(1);",
  );

  try {
    const result = await auditCliEntry({
      id: "test-agent",
      transports: { edit_exists: { cmd: `${process.execPath} ${script}` } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.hint, "real error behind the decoy brace");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditCliEntry handles a plain-string `error` field, not just `error.message`", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-string-error-"));
  const script = path.join(dir, "stringerr.mjs");
  fs.writeFileSync(
    script,
    "process.stderr.write('{\"error\": \"plain string error message\"}\\n'); process.exit(1);",
  );

  try {
    const result = await auditCliEntry({
      id: "test-agent",
      transports: { edit_exists: { cmd: `${process.execPath} ${script}` } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.hint, "plain string error message");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditCliEntry pulls the message out of a trailing multi-line JSON error body instead of a bare '}'", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-json-err-"));
  const script = path.join(dir, "jsonerr.mjs");
  fs.writeFileSync(
    script,
    "process.stderr.write('Error: {\\n  \"name\": \"UnknownError\",\\n  \"data\": {\\n    \"message\": \"Unexpected server error. Check server logs for details.\",\\n    \"ref\": \"err_e7b6fea2\"\\n  }\\n}\\n'); process.exit(1);",
  );

  try {
    const result = await auditCliEntry({
      id: "test-agent",
      transports: { edit_exists: { cmd: `${process.execPath} ${script}` } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.hint, "Unexpected server error. Check server logs for details.");
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
      { timeoutMs: SPAWN_TIMEOUT_MS, effort: "high" },
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.output), ["--effort=high", prompt]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch inserts prompt_flag immediately before the prompt instead of leaving it bare", async () => {
  // Regression test: agy's --print/--prompt consumes the NEXT token as its
  // own value (confirmed live) — with --print left bare in `cmd` and the
  // prompt appended as a plain trailing positional (the default below),
  // --print swallows whatever flag comes next as "the prompt" and the model
  // never sees the real one, while the process still exits 0. prompt_flag
  // tells runDispatch to place that flag directly before the prompt instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-promptflag-"));
  const script = path.join(dir, "args.mjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");

  try {
    const prompt = "what does this flag do";
    const result = await runDispatch(
      {
        id: "agy-like-agent",
        transports: {
          edit_exists: {
            cmd: `${process.execPath} ${script} --dangerously-skip-permissions --model gemini-3.6-flash-high`,
            prompt_flag: "--print",
          },
        },
      },
      prompt,
      { timeoutMs: SPAWN_TIMEOUT_MS },
    );

    assert.equal(result.exitCode, 0);
    const args = JSON.parse(result.output);
    assert.deepEqual(args, [
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3.6-flash-high",
      "--print",
      prompt,
    ]);
    assert.equal(args.at(-2), "--print", "the prompt flag must sit directly before the prompt");
    assert.equal(args.at(-1), prompt, "the real prompt, not a flag string, must be --print's value");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch omits prompt_flag entirely for CLIs that never declared one (no behavior change)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-noflag-"));
  const script = path.join(dir, "args.mjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");

  try {
    const prompt = "make the requested change";
    const result = await runDispatch(
      { id: "claude-like-agent", transports: { edit_exists: { cmd: `${process.execPath} ${script} --print --model claude-opus-4-8` } } },
      prompt,
      { timeoutMs: SPAWN_TIMEOUT_MS },
    );
    assert.deepEqual(JSON.parse(result.output), ["--print", "--model", "claude-opus-4-8", prompt]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAiderArgs passes the prompt via --message, never as a positional", () => {
  // A positional is a FILENAME to aider — the old lane appended the prompt
  // there and aider tried to add a file named after the whole prompt.
  const args = buildAiderArgs(["aider", "--model", "groq/x"], [], "add a subtract fn", "/tmp/wd", {
    files: [{ path: "a.ts" }],
  });
  const msgIdx = args.indexOf("--message");
  assert.ok(msgIdx > -1);
  assert.equal(args[msgIdx + 1], "add a subtract fn");
  assert.ok(
    !args.slice(0, msgIdx).includes("add a subtract fn"),
    "the prompt must never appear as a bare positional",
  );
  assert.deepEqual(args.slice(0, 2), ["--model", "groq/x"], "registry flags stay first");
});

test("buildAiderArgs refuses a dispatch that declares no files", () => {
  // `--file` is optional for edit_exists in general, because a direct CLI can
  // search its --cwd. aider cannot — it has no search tool. It used to paper
  // over that by scraping filenames out of the prompt, which is exactly the
  // defect the scope allowlist closes, so with the allowlist in place a
  // no-files aider run can only start on an empty chat and exit 0 having
  // changed nothing. Refuse up front rather than reproduce the silent failure
  // the pre-0.33.4 lane was retired for.
  for (const options of [{}, { files: [] }]) {
    assert.throws(
      () => buildAiderArgs(["aider"], [], "p", "/tmp/wd", options),
      /aider needs at least one --file/,
    );
  }
});

test("buildAiderArgs keeps aider from dirtying or committing the caller's worktree", () => {
  const args = buildAiderArgs(["aider"], [], "p", "/tmp/wd", { files: [{ path: "a.ts" }] });
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

test("buildAiderArgs refuses an aggregate file attachment over MAX_TOTAL_FILE_BYTES", () => {
  // Regression test: confirmed live that ~25 individually-small files (well
  // under any per-file cap) can together push one dispatch from ~131k to
  // ~594k tokens, and the provider silently truncated the request instead of
  // erroring — a needle planted mid-file came back "NOT_FOUND" while the
  // dispatch still reported outcome:success. aider reads these files itself
  // (only paths are passed, not content) and has no per-file or aggregate
  // cap of its own, so refuse up front rather than let aider silently work
  // from a truncated view of the request.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-bigfiles-"));
  try {
    const perFileBytes = 40 * 1024; // under MAX_FILE_BYTES (256KB), well over the aggregate cap combined
    const fileCount = Math.ceil((MAX_TOTAL_FILE_BYTES + perFileBytes) / perFileBytes);
    const files = [];
    for (let i = 0; i < fileCount; i++) {
      const name = `f${i}.txt`;
      fs.writeFileSync(path.join(dir, name), "x".repeat(perFileBytes));
      files.push({ path: name });
    }
    assert.throws(
      () => buildAiderArgs(["aider"], [], "p", dir, { files }),
      /aggregate cap/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAiderArgs allows a file set at or under the aggregate cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-okfiles-"));
  try {
    const name = "small.txt";
    fs.writeFileSync(path.join(dir, name), "x".repeat(1024));
    const args = buildAiderArgs(["aider"], [], "p", dir, { files: [{ path: name }] });
    assert.ok(args.includes(path.join(dir, name)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAiderArgs writes .aiderignore with * and anchored negations for each attached file", () => {
  // Create a temp git repo (directory form) to simulate a real repository.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-gitroot-"));
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const workdir = path.join(repoDir, "subdir");
  fs.mkdirSync(workdir, { recursive: true });

  // Create two files in the repo.
  const file1 = path.join(repoDir, "pkg", "a.ts");
  const file2 = path.join(repoDir, "pkg", "b.ts");
  fs.mkdirSync(path.dirname(file1), { recursive: true });
  fs.writeFileSync(file1, "export const a = 1;");
  fs.writeFileSync(file2, "export const b = 2;");

  try {
    const args = buildAiderArgs(["aider"], [], "prompt", workdir, {
      files: [{ path: file1 }, { path: file2 }],
    });

    // --aiderignore flag should be present
    const ignoreIdx = args.indexOf("--aiderignore");
    assert.ok(ignoreIdx > -1, "--aiderignore flag missing");
    const ignorePath = args[ignoreIdx + 1];
    assert.ok(ignorePath.startsWith(path.join(os.tmpdir(), "external-agents-aider-")), "ignore file should be in historyDir");

    // Read the ignore file and verify contents
    const content = fs.readFileSync(ignorePath, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines[0], "*", "first line must be * to empty tracked-file list");
    assert.ok(lines.includes("!/pkg/a.ts"), "negation for pkg/a.ts missing");
    assert.ok(lines.includes("!/pkg/b.ts"), "negation for pkg/b.ts missing");
    assert.equal(lines.length, 3, "exactly three lines: * and two negations");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("buildAiderArgs uses git-root-relative negations when workdir is a subdirectory", () => {
  // The negation paths must be relative to the git root, not the cwd.
  // If workdir is repo/subdir and the file is repo/pkg/target.js, the
  // negation must be !/pkg/target.js, not !/subdir/../pkg/target.js or
  // any cwd-relative form.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-subdir-"));
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const workdir = path.join(repoDir, "deep", "nested", "cwd");
  fs.mkdirSync(workdir, { recursive: true });

  const targetFile = path.join(repoDir, "pkg", "target.js");
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, "export const x = 1;");

  try {
    const args = buildAiderArgs(["aider"], [], "prompt", workdir, {
      files: [{ path: targetFile }],
    });

    const ignoreIdx = args.indexOf("--aiderignore");
    assert.ok(ignoreIdx > -1);
    const ignorePath = args[ignoreIdx + 1];
    const content = fs.readFileSync(ignorePath, "utf-8");
    assert.ok(content.includes("!/pkg/target.js"), "negation must be git-root-relative with leading /");
    assert.ok(!content.includes("deep/nested"), "must not contain cwd-relative path components");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("buildAiderArgs recognizes a .git file (worktree form) as a git root", () => {
  // A git worktree has a .git FILE pointing to the main repo's .git dir.
  // This must be detected the same as a .git directory.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-worktree-"));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-worktree-wt-"));

  // Simulate worktree: .git is a file containing "gitdir: /path/to/main/.git"
  fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${repoDir}/.git\n`);
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

  const targetFile = path.join(worktreeDir, "src", "main.ts");
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, "export const main = 1;");

  try {
    const args = buildAiderArgs(["aider"], [], "prompt", worktreeDir, {
      files: [{ path: targetFile }],
    });

    const ignoreIdx = args.indexOf("--aiderignore");
    assert.ok(ignoreIdx > -1, "should detect .git file as git root");
    const ignorePath = args[ignoreIdx + 1];
    const content = fs.readFileSync(ignorePath, "utf-8");
    assert.ok(content.includes("!/src/main.ts"), "negation should be worktree-root-relative");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("buildAiderArgs does not pass --aiderignore when no git root exists", () => {
  // Without a git repo, aider has no tracked-file list, so the bug cannot
  // fire. We skip the ignore file entirely (fail open).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-nogit-"));
  const workdir = path.join(dir, "sub");
  fs.mkdirSync(workdir, { recursive: true });

  const targetFile = path.join(workdir, "file.ts");
  fs.writeFileSync(targetFile, "export const x = 1;");

  try {
    const args = buildAiderArgs(["aider"], [], "prompt", workdir, {
      files: [{ path: targetFile }],
    });

    assert.ok(!args.includes("--aiderignore"), "should not pass --aiderignore without git root");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAiderArgs does not pass --aiderignore when an attached file is outside the git root", () => {
  // If any file lies outside the git root, we cannot express it as a
  // negation (gitignore patterns cannot match outside the repo). Skip the
  // ignore file entirely — fail open rather than breaking the dispatch.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-outside-"));
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const workdir = path.join(repoDir, "sub");
  fs.mkdirSync(workdir, { recursive: true });

  const insideFile = path.join(repoDir, "inside.ts");
  const outsideFile = path.join(os.tmpdir(), "outside.txt"); // outside the repo
  fs.writeFileSync(insideFile, "inside");
  fs.writeFileSync(outsideFile, "outside");

  try {
    const args = buildAiderArgs(["aider"], [], "prompt", workdir, {
      files: [{ path: insideFile }, { path: outsideFile }],
    });

    assert.ok(!args.includes("--aiderignore"), "should not pass --aiderignore when any file is outside git root");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
});

test("buildAiderArgs resolves symlinked paths before deciding a file is outside the git root", () => {
  // Regression: the containment test compared a realpath-resolved cwd against
  // unresolved --file paths, so it reported a false "outside the repo" and
  // silently skipped the allowlist. macOS makes this the common case rather
  // than an exotic one — os.tmpdir() is `/var/folders/…`, a symlink to
  // `/private/var/folders/…`.
  const realRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-symlink-"));
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-symlink-link-"));
  const link = path.join(linkDir, "repo-link");
  fs.symlinkSync(realRepo, link);
  fs.mkdirSync(path.join(realRepo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(realRepo, "target.ts"), "export const t = 1;");

  try {
    // cwd reached through the symlink, the file named by its real path.
    const args = buildAiderArgs(["aider"], [], "prompt", link, {
      files: [{ path: path.join(realRepo, "target.ts") }],
    });

    const ignoreIdx = args.indexOf("--aiderignore");
    assert.ok(ignoreIdx > -1, "the allowlist must survive a symlinked cwd");
    const content = fs.readFileSync(args[ignoreIdx + 1], "utf-8");
    assert.ok(content.includes("!/target.ts"), `expected an anchored negation, got ${JSON.stringify(content)}`);
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.rmSync(realRepo, { recursive: true, force: true });
  }
});

test("buildAiderArgs escapes glob metacharacters in negation paths", () => {
  // Filenames containing *, ?, [, ], or trailing space must be escaped in
  // the negation lines so gitignore matches them literally.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-globescape-"));
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const workdir = path.join(repoDir, "sub");
  fs.mkdirSync(workdir, { recursive: true });

  // Filenames with glob metacharacters
  const file1 = path.join(repoDir, "file[1].ts");
  const file2 = path.join(repoDir, "file*.ts");
  const file3 = path.join(repoDir, "file?.ts");
  const file4 = path.join(repoDir, "file]with[bracket.ts");
  const file5 = path.join(repoDir, "trailing-space ");
  fs.writeFileSync(file1, "1");
  fs.writeFileSync(file2, "2");
  fs.writeFileSync(file3, "3");
  fs.writeFileSync(file4, "4");
  fs.writeFileSync(file5, "5");

  try {
    const args = buildAiderArgs(["aider"], [], "prompt", workdir, {
      files: [
        { path: file1 },
        { path: file2 },
        { path: file3 },
        { path: file4 },
        { path: file5 },
      ],
    });

    const ignoreIdx = args.indexOf("--aiderignore");
    assert.ok(ignoreIdx > -1);
    const ignorePath = args[ignoreIdx + 1];
    const content = fs.readFileSync(ignorePath, "utf-8");

    // Each negation should have metacharacters escaped with backslash
    assert.ok(content.includes("!/file\\[1\\].ts"), "brackets must be escaped");
    assert.ok(content.includes("!/file\\*.ts"), "asterisk must be escaped");
    assert.ok(content.includes("!/file\\?.ts"), "question mark must be escaped");
    assert.ok(content.includes("!/file\\]with\\[bracket.ts"), "nested brackets must be escaped");
    assert.ok(content.includes("!/trailing-space\\ "), "trailing space must be escaped");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("aiderExitCode re-codes aider's exit-0-on-provider-failure as a failure, from either stream", () => {
  const err = "litellm.RateLimitError: GeminiException - quota";
  assert.equal(aiderExitCode(0, true, err, "", []), 1, "provider error on stdout");
  assert.equal(aiderExitCode(0, true, "", err, []), 1, "provider error on stderr counts the same");
  // `bytes` is now load-bearing: a file is evidence of work only if it has
  // content, because a 0-byte file aider touched into existence defeated this
  // guard and reported a rate-limited run as success. The fixture states what it
  // always meant — an edit that landed — rather than relying on mere presence.
  assert.equal(aiderExitCode(0, true, err, "", [{ path: "a.ts", bytes: 120 }]), 0, "edits landed despite a retried error");
  assert.equal(aiderExitCode(0, true, err, "", [{ path: "a.ts", bytes: 0 }]), 1, "a touched-but-empty file is not an edit");
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
    const result = await runDispatch(entry, "ignored", { timeoutMs: SPAWN_TIMEOUT_MS }, "read_only");
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
    () => runDispatch(
      { id: "legacy", transports: { edit_exists: "aider --model example" } },
      "ignored",
      // aider now requires a declared file, so give it one: this test is about
      // transport RESOLUTION, not about the no-files guard above.
      { files: [{ path: "a.ts" }] },
    ),
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
        timeoutMs: SPAWN_TIMEOUT_MS,
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
  const pidFile = path.join(dir, "descendant.pid");
  const script = path.join(dir, "parent.mjs");
  // The descendant does nothing but stay alive. Whether the group kill reached
  // it is read from the process table, not inferred from a file it may or may
  // not have got round to writing.
  const childCode = "setInterval(() => {}, 1000);";
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  let descendantPid = null;
  try {
    // 1.5s, not 30ms. The old budget could fire the timeout before the fixture
    // had even spawned its descendant, in which case there was nothing for the
    // group kill to reach and the test passed without exercising it at all.
    // This has to be long enough that a descendant provably exists first.
    const result = await runDispatch(
      { id: "group", transports: { edit_exists: { cmd: `${process.execPath} ${script}` } } },
      "ignored",
      { timeoutMs: 1500 },
    );
    assert.equal(result.exitCode, 124);

    // Proves the fixture got far enough to be a real test of the group kill.
    assert.ok(fs.existsSync(pidFile), "fixture never spawned a descendant, so the group kill was never exercised");
    descendantPid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

    await waitFor(() => !processAlive(descendantPid), {
      timeoutMs: SPAWN_TIMEOUT_MS,
      message: `descendant ${descendantPid} survived the timeout's process-group kill`,
    });
  } finally {
    if (descendantPid && processAlive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch removes parent signal handlers after completion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-signal-cleanup-"));
  const script = path.join(dir, "ok.mjs");
  fs.writeFileSync(script, "process.stdout.write('ok');");

  const beforeSigterm = process.listenerCount("SIGTERM");
  const beforeSigint = process.listenerCount("SIGINT");
  const beforeMaxListeners = process.getMaxListeners();
  try {
    const result = await runDispatch(
      { id: "cleanup", transports: { edit_exists: { cmd: `${process.execPath} ${script}` } } },
      "ignored",
      { timeoutMs: 1000 },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(process.listenerCount("SIGTERM"), beforeSigterm);
    assert.equal(process.listenerCount("SIGINT"), beforeSigint);
    assert.equal(process.getMaxListeners(), beforeMaxListeners);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDispatch forwards parent SIGTERM to the subprocess group", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dispatch-parent-signal-"));
  const started = path.join(dir, "agent-started");
  const pidFile = path.join(dir, "descendant.pid");
  const agentScript = path.join(dir, "agent.mjs");
  const runnerScript = path.join(dir, "runner.mjs");
  // Stays alive and does nothing else; survival is read from the process table.
  const childCode = "setInterval(() => {}, 1000);";
  fs.writeFileSync(
    agentScript,
    [
      "import fs from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));`,
      // Written LAST, so seeing it guarantees the pid file is already there and
      // the test never reads a half-written fixture.
      `fs.writeFileSync(${JSON.stringify(started)}, 'yes');`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  fs.writeFileSync(
    runnerScript,
    [
      `import { runDispatch } from ${JSON.stringify(new URL("./dispatch.js", import.meta.url).href)};`,
      // A long dispatch timeout on purpose. At 1000ms the dispatch's OWN
      // timeout raced the SIGTERM this test sends: on a loaded box the runner
      // could time out, tear down and exit before the signal ever arrived, and
      // the test then failed for the absence of a message about a signal that
      // was delivered to a dead process. Termination here must come from the
      // signal and nothing else.
      `const result = await runDispatch({ id: "parent-signal", transports: { edit_exists: { cmd: ${JSON.stringify(`${process.execPath} ${agentScript}`)} } } }, "ignored", { timeoutMs: 60_000 });`,
      "console.log(JSON.stringify({ exitCode: result.exitCode, stderr: result.stderr }));",
    ].join("\n"),
  );

  let stdout = "";
  let stderr = "";
  const runner = spawn(process.execPath, [runnerScript], { stdio: ["ignore", "pipe", "pipe"] });
  runner.stdout.on("data", (d) => { stdout += d; });
  runner.stderr.on("data", (d) => { stderr += d; });

  let descendantPid = null;
  try {
    // Booting two `node` processes: generous, because it bounds a hang and
    // nothing else. A passing run leaves this loop in a few hundred ms.
    await waitFor(() => fs.existsSync(started), {
      timeoutMs: SPAWN_TIMEOUT_MS,
      message: "agent fixture did not start",
    });
    descendantPid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.equal(processAlive(descendantPid), true, "descendant should be running before the signal is sent");

    process.kill(runner.pid, "SIGTERM");

    const closed = await Promise.race([
      new Promise((resolve) => runner.on("close", (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("runner did not exit after SIGTERM")), SPAWN_TIMEOUT_MS),
      ),
    ]);

    // The grandchild is reachable only through the process GROUP — that is the
    // whole claim under test. It has no timer of its own to race, so this waits
    // for the only thing that settles the question.
    await waitFor(() => !processAlive(descendantPid), {
      timeoutMs: SPAWN_TIMEOUT_MS,
      message: `descendant ${descendantPid} survived the forwarded SIGTERM`,
    });

    assert.equal(closed.code, 0);
    assert.match(stdout + stderr, /received SIGTERM/);
  } finally {
    if (!runner.killed) runner.kill("SIGKILL");
    if (descendantPid && processAlive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("scopeBaseline returns [] when cwd is not in a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-scopebaseline-nogit-"));
  try {
    assert.deepEqual(scopeBaseline(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scopeBaseline returns [] for a clean repo", () => {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-scopebaseline-clean-")));
  spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  try {
    assert.deepEqual(scopeBaseline(repoDir), []);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("scopeBaseline records path, status and a non-null hash for a modified tracked file", () => {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-scopebaseline-modified-")));
  spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  // Modify the tracked file after commit
  fs.writeFileSync(path.join(repoDir, "tracked.txt"), "modified");

  try {
    const baseline = scopeBaseline(repoDir);
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0].path, "tracked.txt");
    assert.equal(baseline[0].status, "M");
    assert.ok(baseline[0].hash !== null && typeof baseline[0].hash === "string" && baseline[0].hash.length === 64, "hash must be non-null sha256 hex");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("declaredRepoRelPaths maps absolute and relative paths to root-relative POSIX paths from a subdirectory cwd", () => {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-declaredpaths-subdir-")));
  spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "root-file.ts"), "x");
  fs.mkdirSync(path.join(repoDir, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "pkg", "nested.ts"), "y");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  // Dispatch cwd is a subdirectory of the repo root
  const workdir = path.join(repoDir, "pkg");

  try {
    const declared = declaredRepoRelPaths(workdir, [
      { path: path.join(repoDir, "root-file.ts") },           // absolute
      { path: "nested.ts" },                                   // relative to workdir
      { path: path.join(repoDir, "pkg", "nested.ts") },       // absolute duplicate
    ]);
    // Every path comes out repo-root-relative with POSIX separators, so the
    // relative `nested.ts` (resolved against the pkg/ cwd) and the absolute
    // pkg/nested.ts collapse to ONE entry. That collapse is the point: the set
    // is compared against `git status --porcelain`, which only ever speaks in
    // root-relative paths, so a cwd-relative leftover would never match and
    // its declared file would be misreported as out of scope.
    assert.deepEqual(
      Array.from(declared).sort(),
      ["pkg/nested.ts", "root-file.ts"],
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("outOfScopeChanges returns [] when the only changed file is declared", () => {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-oos-declared-")));
  spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "declared.txt"), "initial");
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "initial");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  // Modify only the declared file
  fs.writeFileSync(path.join(repoDir, "declared.txt"), "changed");

  const baseline = scopeBaseline(repoDir);
  const post = [{ path: "declared.txt", status: "M" }];
  const declared = new Set(["declared.txt"]);

  try {
    assert.deepEqual(outOfScopeChanges(baseline, post, declared, repoDir), []);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("outOfScopeChanges flags an undeclared file that became newly dirty", () => {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-oos-newdirty-")));
  spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "declared.txt"), "initial");
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "initial");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  // Baseline is clean
  const baseline = scopeBaseline(repoDir);

  // Modify an undeclared file after baseline
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "changed");
  const post = [{ path: "undeclared.txt", status: "M" }];
  const declared = new Set(["declared.txt"]);

  try {
    const oos = outOfScopeChanges(baseline, post, declared, repoDir);
    assert.equal(oos.length, 1);
    assert.equal(oos[0].path, "undeclared.txt");
    assert.equal(oos[0].status, "M");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("outOfScopeChanges flags an undeclared file that was already dirty in baseline and then changed content while keeping status M (hash comparison)", () => {
  // This is the critical hash-comparison case: a file that was ALREADY dirty
  // before the dispatch (status M in baseline) gets modified AGAIN during the
  // dispatch. Its porcelain status stays "M", so a path+status check alone
  // would miss it. The hash must differ to catch the second edit.
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-oos-hashchange-")));
  spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "declared.txt"), "initial");
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "initial");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  // Make undeclared.txt dirty BEFORE the dispatch (pre-existing edit)
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "pre-existing-edit");

  // Capture baseline — undeclared.txt is now M with hash of "pre-existing-edit"
  const baseline = scopeBaseline(repoDir);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].path, "undeclared.txt");
  assert.equal(baseline[0].status, "M");
  const baselineHash = baseline[0].hash;

  // During dispatch, the file is modified AGAIN (status still M, but content differs)
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "pre-existing-edit PLUS dispatch-edit");
  const post = [{ path: "undeclared.txt", status: "M" }];
  const declared = new Set(["declared.txt"]);

  try {
    const oos = outOfScopeChanges(baseline, post, declared, repoDir);
    assert.equal(oos.length, 1, "must flag the second edit even though status is unchanged");
    assert.equal(oos[0].path, "undeclared.txt");
    // Verify the post-run hash actually differs from baseline
    const postHash = createHash("sha256").update("pre-existing-edit PLUS dispatch-edit").digest("hex");
    assert.notEqual(postHash, baselineHash);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("outOfScopeChanges does NOT flag an undeclared file that was already dirty and is unchanged", () => {
  // Mirror of the hash-change case: a pre-existing dirty file that the dispatch
  // does NOT touch must not be flagged. Otherwise every dispatch run in a
  // worktree with pre-existing edits would fail this check.
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-oos-unchanged-")));
  spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "declared.txt"), "initial");
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "initial");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

  // Make undeclared.txt dirty BEFORE the dispatch
  fs.writeFileSync(path.join(repoDir, "undeclared.txt"), "pre-existing-edit");

  const baseline = scopeBaseline(repoDir);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].path, "undeclared.txt");
  const baselineHash = baseline[0].hash;

  // Dispatch runs but does NOT touch undeclared.txt
  const post = [{ path: "undeclared.txt", status: "M" }];
  const declared = new Set(["declared.txt"]);

  try {
    const oos = outOfScopeChanges(baseline, post, declared, repoDir);
    assert.deepEqual(oos, [], "pre-existing dirty file untouched by dispatch must not be flagged");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("outOfScopeReason returns null for empty array", () => {
  assert.equal(outOfScopeReason([]), null);
});

test("outOfScopeReason returns a summary containing the path and 'outside the declared --file scope'", () => {
  const reason = outOfScopeReason([{ path: "pkg/secret.ts", status: "M" }]);
  assert.ok(typeof reason === "string");
  assert.match(reason, /pkg\/secret\.ts/);
  assert.match(reason, /outside the declared --file scope/);
});

test("outOfScopeReason caps at 10 names and reports (+N more)", () => {
  const many = Array.from({ length: 13 }, (_, i) => ({ path: `file${i}.ts`, status: "M" }));
  const reason = outOfScopeReason(many);
  // Should name first 10
  for (let i = 0; i < 10; i++) {
    assert.match(reason, new RegExp(`file${i}\\.ts`));
  }
  // Should not name 11th, 12th, 13th
  for (let i = 10; i < 13; i++) {
    assert.ok(!reason.includes(`file${i}.ts`), `file${i}.ts should not appear by name`);
  }
  // Should report (+3 more)
  assert.match(reason, /\(\+3 more\)/);
});

test("buildAiderArgs lets the repo's own .aiderignore veto a declared file", () => {
  // Regression: passing --aiderignore REPLACES the repo's own .aiderignore, so a
  // repo that says "never let an agent touch secrets.env" had that policy
  // silently overridden the moment a caller declared that path. Verified live
  // before the fix: the file was added to the chat and its contents reached the
  // provider, where plain aider had refused it. The repo's rules must therefore
  // come LAST, since in gitignore the later pattern wins.
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ea-aider-repopolicy-")));
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "secrets.env"), "SECRET=x");
  fs.writeFileSync(path.join(repoDir, "ok.js"), "export const ok = 1;");
  fs.writeFileSync(path.join(repoDir, ".aiderignore"), "# repo policy\nsecrets.env\n!never-widen.js\n");

  try {
    const forbidden = buildAiderArgs(["aider"], [], "p", repoDir, { files: [{ path: "secrets.env" }] });
    const forbiddenBody = fs.readFileSync(forbidden[forbidden.indexOf("--aiderignore") + 1], "utf-8");
    assert.deepEqual(
      forbiddenBody.trimEnd().split("\n"),
      ["*", "!/secrets.env", "secrets.env"],
      "the repo's rule must follow our negation so it can still veto it",
    );

    // A repo negation is dropped rather than carried over: our baseline already
    // ignores everything, so a `!` line from the repo could only WIDEN what is
    // visible, which is precisely what this file exists to prevent.
    assert.ok(!forbiddenBody.includes("never-widen.js"), "repo negations must not be carried over");

    // An unrelated repo rule must not disturb a declared file it does not name.
    const allowed = buildAiderArgs(["aider"], [], "p", repoDir, { files: [{ path: "ok.js" }] });
    const allowedBody = fs.readFileSync(allowed[allowed.indexOf("--aiderignore") + 1], "utf-8");
    assert.deepEqual(allowedBody.trimEnd().split("\n"), ["*", "!/ok.js", "secrets.env"]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
