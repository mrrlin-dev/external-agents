import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { repoProvenance, formatProvenanceHeader } from "./dispatch.js";

// A worker sent at a --cwd used to be told nothing about which version of the
// project that directory held. The concrete failure: a checkout sitting a few
// hundred commits behind, a review that accurately described code no longer
// present upstream, and a reader who concluded the model had fabricated it.
// These tests pin the facts that make that distinguishable.

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf-8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}

function commit(git, dir, name, body, message) {
  fs.writeFileSync(path.join(dir, name), body);
  git("add", name);
  git("commit", "-qm", message);
}

test("repoProvenance returns null outside a git repository", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-prov-nongit-"));
  try {
    assert.equal(repoProvenance(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repoProvenance reports branch, head and cleanliness", () => {
  const { dir, git } = makeRepo("ea-prov-basic-");
  try {
    commit(git, dir, "a.txt", "one", "first commit");
    const prov = repoProvenance(dir);
    assert.equal(prov.branch, "main");
    assert.equal(prov.detached, false);
    assert.equal(prov.subject, "first commit");
    assert.equal(prov.head.length, 40);
    assert.equal(prov.short, prov.head.slice(0, 12));
    assert.equal(prov.dirty, false);
    assert.equal(prov.dirty_files, 0);

    fs.writeFileSync(path.join(dir, "b.txt"), "scratch");
    const dirty = repoProvenance(dir);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.dirty_files, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repoProvenance works from a subdirectory of the repo", () => {
  const { dir, git } = makeRepo("ea-prov-subdir-");
  try {
    commit(git, dir, "a.txt", "one", "first commit");
    fs.mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
    const prov = repoProvenance(path.join(dir, "nested", "deeper"));
    assert.equal(prov.branch, "main");
    assert.equal(fs.realpathSync(prov.root), fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The whole point of the exercise: "behind" has to be a number the caller can
// see, because "195 behind" is what separates a stale review from a fabricated
// one — and a local task branch usually declares no upstream at all, so the
// comparison has to fall back to the remote's default branch.
test("repoProvenance counts drift against an inferred origin default branch", () => {
  const { dir: originDir, git: originGit } = makeRepo("ea-prov-origin-");
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-prov-clone-"));
  try {
    commit(originGit, originDir, "a.txt", "one", "base commit");

    spawnSync("git", ["clone", "-q", originDir, cloneDir], { encoding: "utf-8" });
    const cloneGit = (...a) => spawnSync("git", ["-C", cloneDir, ...a], { encoding: "utf-8" });
    cloneGit("config", "user.email", "t@t.t");
    cloneGit("config", "user.name", "t");
    cloneGit("config", "commit.gpgsign", "false");

    // A local branch with no upstream configured — the shape a task worktree
    // normally has, and the shape that used to make drift invisible.
    cloneGit("checkout", "-q", "-b", "task/local");
    assert.equal(repoProvenance(cloneDir).ahead, 0);
    assert.equal(repoProvenance(cloneDir).behind, 0);

    // Two commits upstream that this checkout has fetched but not merged.
    commit(originGit, originDir, "b.txt", "two", "upstream one");
    commit(originGit, originDir, "c.txt", "three", "upstream two");
    cloneGit("fetch", "-q", "origin");

    const prov = repoProvenance(cloneDir);
    assert.equal(prov.upstream_inferred, true);
    assert.match(prov.upstream, /^origin\//);
    assert.equal(prov.behind, 2);
    assert.equal(prov.ahead, 0);

    const header = formatProvenanceHeader(prov);
    assert.match(header, /2 behind/);
    // The counts come from refs on disk, so the header must not imply it just
    // checked with the remote.
    assert.match(header, /last fetch/);
    assert.match(header, /declares no upstream/);
  } finally {
    fs.rmSync(originDir, { recursive: true, force: true });
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }
});

test("repoProvenance flags a detached HEAD instead of printing a branch name", () => {
  const { dir, git } = makeRepo("ea-prov-detached-");
  try {
    commit(git, dir, "a.txt", "one", "first commit");
    commit(git, dir, "b.txt", "two", "second commit");
    const first = spawnSync("git", ["-C", dir, "rev-parse", "HEAD~1"], { encoding: "utf-8" }).stdout.trim();
    git("checkout", "-q", first);

    const prov = repoProvenance(dir);
    assert.equal(prov.detached, true);
    assert.equal(prov.branch, null);
    assert.match(formatProvenanceHeader(prov), /detached HEAD/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatProvenanceHeader is empty when there is nothing to report", () => {
  assert.equal(formatProvenanceHeader(null), "");
  assert.equal(formatProvenanceHeader({ root: "/tmp/x" }), "");
});

test("formatProvenanceHeader states facts, not instructions about git", () => {
  const { dir, git } = makeRepo("ea-prov-tone-");
  try {
    commit(git, dir, "a.txt", "one", "first commit");
    const header = formatProvenanceHeader(repoProvenance(dir));
    assert.match(header, /REPOSITORY STATE/);
    assert.match(header, /first commit/);
    assert.match(header, /worktree: clean/);
    // A worker told to go fix its branch stops working on the actual task, so
    // the header must never carry a git imperative. ("checkout" as a noun is
    // fine and does appear — it is the thing being described.)
    assert.doesNotMatch(header, /\bgit\s+(rebase|pull|fetch|checkout|merge|reset)\b/i);
    assert.doesNotMatch(header, /\byou (must|should|need to)\b/i);
    // Trailing blank line keeps it from running into the file context that
    // follows it in the prompt.
    assert.ok(header.endsWith("\n\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Found in self-review: `dirty` used to be derived from a reader that collapses
// "no output" and "the command failed" into the same null, so a git that
// errored or timed out on a huge tree reported the worktree as CLEAN. That is
// the exact failure this whole header exists to prevent — stating a fact
// nobody observed — so unknown must be representable and must not read as clean.
test("an undeterminable worktree state is reported as unknown, never as clean", () => {
  const unknown = {
    root: "/tmp/x", branch: "main", detached: false,
    head: "a".repeat(40), short: "aaaaaaaaaaaa", subject: "s",
    upstream: null, ahead: null, behind: null,
    dirty: null, dirty_files: null,
  };
  const header = formatProvenanceHeader(unknown);
  assert.match(header, /worktree: could not be determined/);
  assert.doesNotMatch(header, /worktree: clean/);

  // A successful check with no output is genuinely clean, and must still say so.
  assert.match(formatProvenanceHeader({ ...unknown, dirty: false, dirty_files: 0 }), /worktree: clean/);
  assert.match(formatProvenanceHeader({ ...unknown, dirty: true, dirty_files: 3 }), /3 uncommitted change\(s\)/);
});

test("a repository with no commits yields no header rather than a half-filled one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-prov-empty-"));
  try {
    spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"], { encoding: "utf-8" });
    const prov = repoProvenance(dir);
    assert.equal(prov.head, null);
    assert.equal(prov.dirty, null);
    assert.equal(formatProvenanceHeader(prov), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
