import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveDispatchWorkdir, parseGitPorcelain, listChangedFiles } from "./dispatch.js";

test("resolveDispatchWorkdir without cwd creates a fresh temp dir (external:false)", () => {
  const { workdir, external } = resolveDispatchWorkdir("agent-x", {});
  try {
    assert.equal(external, false);
    assert.ok(fs.statSync(workdir).isDirectory(), "temp workdir exists and is a directory");
    assert.ok(workdir.startsWith(os.tmpdir()), "temp workdir is under os.tmpdir()");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("resolveDispatchWorkdir with an existing cwd uses it verbatim (external:true)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-cwd-test-"));
  try {
    const { workdir, external } = resolveDispatchWorkdir("agent-x", { cwd: dir });
    assert.equal(external, true);
    assert.equal(workdir, path.resolve(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDispatchWorkdir throws when cwd does not exist", () => {
  const missing = path.join(os.tmpdir(), "ea-cwd-does-not-exist-abc123");
  assert.throws(() => resolveDispatchWorkdir("agent-x", { cwd: missing }), /does not exist/);
});

test("resolveDispatchWorkdir throws when cwd is a file, not a directory", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ea-cwd-file-")), "f.txt");
  fs.writeFileSync(file, "x");
  try {
    assert.throws(() => resolveDispatchWorkdir("agent-x", { cwd: file }), /not a directory/);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("parseGitPorcelain parses modified, untracked, and renamed entries", () => {
  const text = [
    " M lib/dispatch.js",
    "?? new-file.txt",
    "A  staged.js",
    'R  old-name.js -> new-name.js',
  ].join("\n");
  const files = parseGitPorcelain(text);
  assert.deepEqual(
    files.map((f) => f.path),
    ["lib/dispatch.js", "new-file.txt", "staged.js", "new-name.js"],
  );
  assert.equal(files[0].status, "M");
  assert.equal(files[1].status, "??");
});

test("parseGitPorcelain ignores blank lines", () => {
  assert.deepEqual(parseGitPorcelain("\n\n"), []);
});

test("listChangedFiles reports staged + untracked files in a real git repo", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ea-git-repo-"));
  try {
    const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf-8" });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "hello");
    git("add", "tracked.txt");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "world");
    const changed = listChangedFiles(repo).map((f) => f.path).sort();
    assert.deepEqual(changed, ["tracked.txt", "untracked.txt"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("listChangedFiles returns [] for a non-git directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-nongit-"));
  try {
    assert.deepEqual(listChangedFiles(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
