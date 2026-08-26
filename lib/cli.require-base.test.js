import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

// --require-base turns "which version of the project is this?" from a note in
// the prompt into a precondition. It exists because a worker pointed at a stale
// worktree produces an accurate report about code that is no longer there, and
// that report is indistinguishable from a fabricated one unless somebody
// notices the checkout by hand.
//
// Every case here must fail BEFORE dispatch, so none of them touch the network.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "cli.js");

// Any real, enabled agent id: the gate runs before transport selection, so
// which one it is never matters.
const AGENT_ID = "groq-gpt-oss-20b";

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf-8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  const commit = (name, body, message) => {
    fs.writeFileSync(path.join(dir, name), body);
    git("add", name);
    git("commit", "-qm", message);
  };
  return { dir, git, commit };
}

function dispatch(args, homeDir) {
  return spawnSync(process.execPath, [cliPath, "dispatch", AGENT_ID, ...args, "hello"], {
    encoding: "utf-8",
    cwd: repoRoot,
    env: { ...process.env, HOME: homeDir },
    timeout: 30000,
  });
}

test("--require-base refuses a checkout that does not contain the base", () => {
  const { dir, git, commit } = makeRepo("ea-reqbase-stale-");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ea-reqbase-home-"));
  try {
    commit("a.txt", "one", "base");
    git("branch", "-q", "release");        // marks the base
    commit("b.txt", "two", "newer work");  // main moves past it
    // A branch cut BEFORE the base, so it genuinely does not contain it.
    git("checkout", "-q", "-b", "stale", "HEAD~1");
    git("branch", "-qf", "release", "main");

    const res = dispatch(["--cwd", dir, "--require-base", "release"], home);
    assert.equal(res.status, 6);
    assert.match(res.stderr, /refusing to dispatch/);
    assert.match(res.stderr, /does not contain release/);
    // The message has to say why it matters, not just that a check failed.
    assert.match(res.stderr, /different version of this project/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("--require-base names an unresolvable ref rather than reporting a mismatch", () => {
  const { dir, commit } = makeRepo("ea-reqbase-noref-");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ea-reqbase-noref-home-"));
  try {
    commit("a.txt", "one", "base");
    // The common real case: origin/main was never fetched into this checkout.
    const res = dispatch(["--cwd", dir, "--require-base", "origin/main"], home);
    assert.equal(res.status, 6);
    assert.match(res.stderr, /does not resolve/);
    assert.match(res.stderr, /fetch it first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("--require-base without --cwd is a usage error, not a silent pass", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ea-reqbase-nocwd-"));
  try {
    const res = spawnSync(process.execPath, [cliPath, "dispatch", AGENT_ID, "--require-base", "main", "hello"], {
      encoding: "utf-8",
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      timeout: 30000,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--require-base needs --cwd/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("--require-base outside a git repository is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-reqbase-nongit-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ea-reqbase-nongit-home-"));
  try {
    const res = dispatch(["--cwd", dir, "--require-base", "main"], home);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /not inside a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a checkout that contains the base passes the gate", () => {
  const { dir, git, commit } = makeRepo("ea-reqbase-ok-");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ea-reqbase-ok-home-"));
  try {
    commit("a.txt", "one", "base");
    git("branch", "-q", "release");
    commit("b.txt", "two", "work on top of the base");

    // Being AHEAD of the base is fine — the base is a floor, not an equality
    // check.
    //
    // `--transport edit_exists` is here to stop the run immediately after the
    // gate, on a deterministic argument-building error, so the suite never
    // makes a live API call: an agent id plus an inherited provider key in the
    // environment would otherwise be a real dispatch from a unit test.
    const args = ["--require-base", "release", "--transport", "edit_exists"];
    const res = dispatch(["--cwd", dir, ...args], home);
    assert.notEqual(res.status, 6);
    assert.doesNotMatch(res.stderr, /refusing to dispatch/);
    assert.doesNotMatch(res.stderr, /--require-base/);

    // Asserting the gate PASSED, rather than merely that nothing complained,
    // needs the contrast: identical arguments against a checkout that does not
    // contain the base must be refused. Without this the test would still pass
    // if the gate had silently stopped running at all.
    const stale = makeRepo("ea-reqbase-ok-contrast-");
    try {
      stale.commit("a.txt", "one", "unrelated root");
      stale.git("branch", "-q", "release");
      stale.commit("b.txt", "two", "newer");
      stale.git("checkout", "-q", "-b", "off-base", "HEAD~1");
      stale.git("branch", "-qf", "release", "main");
      const refused = dispatch(["--cwd", stale.dir, ...args], home);
      assert.equal(refused.status, 6);
    } finally {
      fs.rmSync(stale.dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
