import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_TEMP_RETENTION_DAYS,
  TEMP_DIR_PREFIXES,
  runGenerate,
  sweepDispatchTemp,
} from "./dispatch.js";

// A dispatch workdir exists to hold the generated file. It used to be created
// before the request was even sent, so every dispatch that produced no file left
// an empty directory behind — a missing key, a 429, a timeout, an empty
// completion. Two thirds of the `ea-gen-*` directories on one developer machine
// were empty for exactly this reason.

// Counts only the directories THIS FILE's fixtures could have created.
//
// It used to count every `ea-gen-*` directory in the OS temp dir, which is a
// machine-global counter — and `node --test` runs test FILES in parallel
// processes. Any other file's dispatch creating or sweeping a workdir between a
// `before` and its matching assertion changed the number for reasons that had
// nothing to do with the test, so it failed roughly one full-suite run in ten
// while passing 5/5 in isolation. Scoping the count to the fixture's own agent
// id keeps exactly the property under test — "this dispatch created no directory"
// — and makes it immune to whatever else is running.
function countGenDirs(agentId) {
  const prefix = `ea-gen-${agentId}-`;
  try {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).length;
  } catch {
    return 0;
  }
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const entry = (port, id = "tempdir-fixture") => ({
  id,
  model: "fixture",
  transports: { generate_new: { url: `http://127.0.0.1:${port}`, model: "fixture" } },
});

test("a failed generate leaves no workdir behind", async () => {
  const before = countGenDirs("tempdir-fixture");
  await withServer(
    (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
    },
    async (port) => {
      const result = await runGenerate(entry(port), "reply");
      assert.equal(result.exitCode, 1);
      assert.equal(result.workdir, null, "a dispatch that wrote nothing must not claim a workdir");
      assert.deepEqual(result.files, []);
    },
  );
  assert.equal(countGenDirs("tempdir-fixture"), before, "a failed dispatch created a directory it never used");
});

test("an empty completion leaves no workdir behind either", async () => {
  const before = countGenDirs("tempdir-fixture");
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    },
    async (port) => {
      const result = await runGenerate(entry(port), "reply");
      assert.equal(result.exitCode, 1);
      assert.equal(result.workdir, null);
    },
  );
  assert.equal(countGenDirs("tempdir-fixture"), before);
});

test("a missing credential leaves no workdir behind", async () => {
  const before = countGenDirs("no-key");
  const result = await runGenerate(
    {
      id: "no-key",
      model: "fixture",
      transports: {
        generate_new: {
          url: "http://127.0.0.1:1/never-reached",
          model: "fixture",
          env: "EA_TEST_KEY_THAT_IS_NOT_SET",
        },
      },
    },
    "reply",
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not set/);
  assert.equal(result.workdir, null);
  assert.equal(countGenDirs("no-key"), before);
});

test("a successful generate still creates its workdir and writes the file", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
    },
    async (port) => {
      const result = await runGenerate(entry(port), "reply");
      try {
        assert.equal(result.exitCode, 0);
        assert.ok(result.workdir, "a successful dispatch must report where it wrote");
        assert.deepEqual(result.files, [{ path: "generated.md", bytes: 5 }]);
        assert.equal(fs.readFileSync(path.join(result.workdir, "generated.md"), "utf-8"), "hello");
      } finally {
        if (result.workdir) fs.rmSync(result.workdir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The sweep. It deletes recursively, so what it REFUSES to touch matters more
// than what it removes.
// ---------------------------------------------------------------------------

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ea-sweep-root-"));
}

function age(p, days) {
  const t = new Date(Date.now() - days * 86400_000);
  fs.utimesSync(p, t, t);
}

test("the sweep removes only its own prefixes, and only when stale", () => {
  const root = makeTempRoot();
  try {
    const stale = [];
    for (const prefix of TEMP_DIR_PREFIXES) {
      const d = path.join(root, `${prefix}old`);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "generated.md"), "x".repeat(100));
      age(d, 10);
      stale.push(d);
    }
    // Fresh one of ours: a dispatch could be using it right now.
    const fresh = path.join(root, "ea-gen-running");
    fs.mkdirSync(fresh);
    // Somebody else's directory, stale — never ours to delete.
    const foreign = path.join(root, "some-other-tool-cache");
    fs.mkdirSync(foreign);
    age(foreign, 90);

    const result = sweepDispatchTemp({ tmpDir: root, maxAgeDays: 3 });

    assert.equal(result.removed, TEMP_DIR_PREFIXES.length);
    assert.equal(result.failed, 0);
    assert.ok(result.bytes >= 400, `expected the reported size to include the files, got ${result.bytes}`);
    for (const d of stale) assert.equal(fs.existsSync(d), false, `${d} should have been swept`);
    assert.equal(fs.existsSync(fresh), true, "a directory inside the retention window must survive");
    assert.equal(fs.existsSync(foreign), true, "a directory this package did not create must never be touched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep skips a symlink instead of following it", () => {
  const root = makeTempRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ea-sweep-outside-"));
  try {
    const treasure = path.join(outside, "keep-me.txt");
    fs.writeFileSync(treasure, "important");

    // A symlink wearing one of our prefixes, old enough to qualify. Following
    // it would delete a directory the sweep has no business touching.
    const link = path.join(root, "ea-gen-symlink");
    fs.symlinkSync(outside, link);
    age(link, 30);

    const result = sweepDispatchTemp({ tmpDir: root, maxAgeDays: 1 });

    assert.equal(result.removed, 0, "a symlink is not a workdir and must not be swept");
    assert.equal(fs.existsSync(treasure), true, "the sweep followed a symlink out of its own directory");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the sweep ignores a plain file wearing one of the prefixes", () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, "ea-gen-not-a-directory");
    fs.writeFileSync(file, "stray");
    age(file, 30);
    const result = sweepDispatchTemp({ tmpDir: root, maxAgeDays: 1 });
    assert.equal(result.removed, 0);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the sweep never throws on an unreadable or missing root", () => {
  const result = sweepDispatchTemp({ tmpDir: path.join(os.tmpdir(), "ea-sweep-does-not-exist-9f3c") });
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 0);
});

test("retention is configurable, and a negative window is refused rather than obeyed", () => {
  const root = makeTempRoot();
  try {
    const d = path.join(root, "ea-gen-recent");
    fs.mkdirSync(d);
    age(d, 2);

    // Default window keeps a 2-day-old directory.
    assert.equal(sweepDispatchTemp({ tmpDir: root }).removed, 0);
    assert.equal(fs.existsSync(d), true);

    // A nonsensical window must not be read as "delete everything".
    assert.equal(sweepDispatchTemp({ tmpDir: root, maxAgeDays: -1 }).removed, 0);
    assert.equal(sweepDispatchTemp({ tmpDir: root, maxAgeDays: Number.NaN }).removed, 0);
    assert.equal(fs.existsSync(d), true);

    // A tighter window collects it.
    assert.equal(sweepDispatchTemp({ tmpDir: root, maxAgeDays: 1 }).removed, 1);
    assert.equal(fs.existsSync(d), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the retention default is stated, not implied", () => {
  assert.equal(DEFAULT_TEMP_RETENTION_DAYS, 3);
  assert.equal(sweepDispatchTemp({ tmpDir: makeTempRoot() }).retention_days, 3);
});

// Raised in review: with a zero window the cutoff is `now`, so anything created
// a moment ago qualifies — including the workdir of a dispatch in flight. The
// footgun is not really "somebody types 0" either: the window is read as
// `Number(process.env.X || DEFAULT)`, and while an empty string falls through to
// the default, `" "` is truthy and `Number(" ")` is 0. A stray space in a shell
// export would have been enough.
//
// Fixed with a floor rather than by banning zero, so the guarantee holds for
// every window instead of only for sensible ones.
test("no window, however aggressive, deletes something younger than the minimum age", () => {
  const root = makeTempRoot();
  try {
    const brandNew = path.join(root, "ea-gen-in-flight");
    fs.mkdirSync(brandNew);
    age(brandNew, 1 / 1440); // one minute old

    const older = path.join(root, "ea-gen-abandoned");
    fs.mkdirSync(older);
    age(older, 1 / 24); // one hour old, past the floor

    for (const maxAgeDays of [0, 0.0001]) {
      const result = sweepDispatchTemp({ tmpDir: root, maxAgeDays });
      assert.equal(
        fs.existsSync(brandNew),
        true,
        `maxAgeDays=${maxAgeDays} swept a directory a dispatch could still be writing to`,
      );
      assert.ok(result.removed <= 1);
    }
    assert.equal(fs.existsSync(older), false, "a directory past the floor should still be collected");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the whitespace environment value that motivated the floor cannot wipe live workdirs", () => {
  const root = makeTempRoot();
  const previous = process.env.EXTERNAL_AGENTS_TEMP_RETENTION_DAYS;
  try {
    process.env.EXTERNAL_AGENTS_TEMP_RETENTION_DAYS = " ";
    // Number(" ") === 0 and " " is truthy, so the `||` default does not save us.
    const live = path.join(root, "ea-gen-live");
    fs.mkdirSync(live);
    sweepDispatchTemp({ tmpDir: root });
    assert.equal(fs.existsSync(live), true);
  } finally {
    if (previous === undefined) delete process.env.EXTERNAL_AGENTS_TEMP_RETENTION_DAYS;
    else process.env.EXTERNAL_AGENTS_TEMP_RETENTION_DAYS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Review asked whether `dirSizeBytes` can follow a symlink loop. It cannot, but
// the reason lives in Dirent rather than in our code, so it is pinned here: a
// symlink reports neither isDirectory() nor isFile(), so neither branch of the
// walk takes it.
test("size reporting does not follow symlinks, including a loop back to an ancestor", () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, "ea-gen-with-links");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "generated.md"), "x".repeat(10));
    fs.symlinkSync(dir, path.join(dir, "loop"));          // points at itself
    fs.symlinkSync(os.tmpdir(), path.join(dir, "escape")); // points out of the tree
    age(dir, 10);

    const result = sweepDispatchTemp({ tmpDir: root, maxAgeDays: 1 });

    assert.equal(result.removed, 1);
    assert.equal(result.bytes, 10, "only the real file should be counted");
    assert.equal(fs.existsSync(os.tmpdir()), true, "the symlink target must survive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
