import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendDispatchRow,
  readDispatchRows,
  getDispatchLogPath,
  getRetentionDays,
  getMaxFileBytes,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_FILE_BYTES,
} from "./dispatch-log.js";

const DAY = 86400;
const NOW_MS = 1_788_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const daysAgo = (n) => NOW_S - n * DAY;

// Pruning ignores anything under 1 MiB, so a test that wants it to happen has to
// put a real megabyte on disk. `pad` is inert filler in a field nothing reads.
const PAD = "x".repeat(2000);
function bulk(file, count, ts) {
  const line = (i) => JSON.stringify({ ts, agent_id: `bulk-${i}`, outcome: "success", pad: PAD });
  fs.appendFileSync(file, Array.from({ length: count }, (_, i) => line(i)).join("\n") + "\n");
}

function scratch(name = "dispatch-log.jsonl") {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ea-dl-test-")), name);
}

// --- where it lives --------------------------------------------------------

test("by default the log lives in the operator's state dir, not the package", () => {
  const saved = process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE;
  delete process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE;
  try {
    const stateDir = path.join(os.homedir(), ".local", "state", "external-agents");
    assert.ok(getDispatchLogPath().startsWith(stateDir), getDispatchLogPath());
    assert.equal(path.basename(getDispatchLogPath()), "dispatch-log.jsonl");
  } finally {
    if (saved === undefined) delete process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE;
    else process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE = saved;
  }
});

test("the path is resolved at write time, not at import time", () => {
  // The whole point of the override: a module-level const computed from
  // homedir() would already be frozen by the time a test sets the variable.
  const saved = process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE;
  const file = scratch();
  process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE = file;
  try {
    appendDispatchRow({ ts: 1, agent_id: "late-binding", outcome: "success" });
    assert.equal(readDispatchRows(file).length, 1);
  } finally {
    if (saved === undefined) delete process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE;
    else process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE = saved;
  }
});

// --- retention: age, not size ---------------------------------------------

test("rows older than the retention window are dropped, newer ones kept", () => {
  const file = scratch();
  bulk(file, 400, daysAgo(60));   // well past due — triggers the prune
  bulk(file, 400, daysAgo(40));   // outside 30d — dropped
  bulk(file, 400, daysAgo(5));    // inside 30d — kept
  assert.ok(fs.statSync(file).size > 1024 * 1024, "fixture must clear the 1 MiB floor");

  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });

  const rows = readDispatchRows(file);
  assert.equal(rows.filter((r) => r.ts === daysAgo(60)).length, 0, "60d rows must be gone");
  assert.equal(rows.filter((r) => r.ts === daysAgo(40)).length, 0, "40d rows must be gone");
  assert.equal(rows.filter((r) => r.ts === daysAgo(5)).length, 400, "5d rows must survive");
  assert.equal(rows.at(-1).agent_id, "fresh");
});

test("the window is not trimmed on every append — hysteresis, or a steady-state log rewrites itself constantly", () => {
  const file = scratch();
  // Oldest row is 33 days old: past the 30-day window, inside the 6-day grace.
  bulk(file, 700, daysAgo(33));
  const before = fs.statSync(file).size;
  assert.ok(before > 1024 * 1024);

  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });

  assert.equal(readDispatchRows(file).filter((r) => r.ts === daysAgo(33)).length, 700,
    "a row inside the grace band must not trigger a rewrite");
});

test("a log entirely inside the window is left alone however large", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(2));
  const before = fs.readFileSync(file, "utf-8");
  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  assert.ok(fs.readFileSync(file, "utf-8").startsWith(before), "nothing old to drop, so nothing rewritten");
});

test("a small log is never rewritten, however old", () => {
  const file = scratch();
  appendDispatchRow({ ts: daysAgo(400), agent_id: "ancient", outcome: "success" }, { file, now: NOW_MS });
  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  assert.deepEqual(readDispatchRows(file).map((r) => r.agent_id), ["ancient", "fresh"]);
});

test("the byte ceiling is a backstop when a burst outruns the age rule", () => {
  const file = scratch();
  // Everything is inside the window, so age drops nothing; only the ceiling can.
  bulk(file, 700, daysAgo(1));
  const saved = console.error;
  const lines = [];
  console.error = (m) => lines.push(String(m));
  try {
    appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" },
      { file, now: NOW_MS, maxFileBytes: 200 * 1024 });
  } finally {
    console.error = saved;
  }
  assert.ok(fs.statSync(file).size <= 200 * 1024 + 512);
  // Newest survive, oldest go.
  assert.equal(readDispatchRows(file).at(-1).agent_id, "fresh");
  // And it says so — a silent truncation is exactly what this module avoids.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /kept the newest \d+ of \d+ rows/);
});

test("a row with no usable timestamp is kept rather than guessed at", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  fs.appendFileSync(file, JSON.stringify({ agent_id: "no-ts", outcome: "success" }) + "\n");
  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  assert.ok(readDispatchRows(file).some((r) => r.agent_id === "no-ts"));
});

test("retention and the ceiling default to 30 days / 32 MiB and the env can move both", () => {
  const savedR = process.env.EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS;
  const savedB = process.env.EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES;
  delete process.env.EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS;
  delete process.env.EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES;
  try {
    assert.equal(getRetentionDays(), DEFAULT_RETENTION_DAYS);
    assert.equal(DEFAULT_RETENTION_DAYS, 30);
    assert.equal(getMaxFileBytes(), DEFAULT_MAX_FILE_BYTES);
    assert.equal(DEFAULT_MAX_FILE_BYTES, 32 * 1024 * 1024);

    process.env.EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS = "7";
    assert.equal(getRetentionDays(), 7);
    process.env.EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES = "4096";
    assert.equal(getMaxFileBytes(), 4096);

    // Junk falls back rather than disabling retention by accident.
    for (const junk of ["not-a-number", "-1", "0", ""]) {
      process.env.EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS = junk;
      process.env.EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES = junk;
      assert.equal(getRetentionDays(), DEFAULT_RETENTION_DAYS, junk);
      assert.equal(getMaxFileBytes(), DEFAULT_MAX_FILE_BYTES, junk);
    }
  } finally {
    if (savedR === undefined) delete process.env.EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS;
    else process.env.EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS = savedR;
    if (savedB === undefined) delete process.env.EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES;
    else process.env.EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES = savedB;
  }
});

test("a prune never leaves a half-written log behind", () => {
  const file = scratch();
  bulk(file, 400, daysAgo(60));
  bulk(file, 400, daysAgo(3));
  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  // Every surviving line parses, and no .tmp is left in the directory.
  const raw = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
  for (const line of raw) JSON.parse(line);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")), []);
});

// --- the trigger, and the prune lock ---------------------------------------
//
// Raised in review: several processes append to this file, so nothing
// guarantees the first line is the oldest row. Measured on the real log it
// always is (8486 rows, five concurrent servers, 41 days, zero backwards steps
// in `ts`) — these cover the case that measurement cannot promise.

test("an out-of-order head still triggers the prune — the oldest row in the window wins", () => {
  const file = scratch();
  // A recent row FIRST, the overdue rows behind it. Reading line 1 alone would
  // conclude there is nothing to do.
  fs.writeFileSync(file, JSON.stringify({ ts: NOW_S, agent_id: "out-of-order", outcome: "success" }) + "\n");
  bulk(file, 700, daysAgo(60));
  bulk(file, 200, daysAgo(2));

  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });

  assert.equal(readDispatchRows(file).filter((r) => r.ts === daysAgo(60)).length, 0,
    "overdue rows behind a fresh first line must still be pruned");
});

test("a held lock makes an append skip the prune rather than race it", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  // A live holder: this very process.
  fs.writeFileSync(`${file}.prune.lock`, String(process.pid));
  try {
    appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
    assert.equal(readDispatchRows(file).filter((r) => r.ts === daysAgo(60)).length, 700,
      "another process is pruning; this one must leave the file alone");
    // The row itself is still logged — skipping the prune must not skip the write.
    assert.equal(readDispatchRows(file).at(-1).agent_id, "fresh");
  } finally {
    fs.rmSync(`${file}.prune.lock`, { force: true });
  }
});

test("a lock whose holder is gone is stolen, not obeyed forever", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  const lock = `${file}.prune.lock`;
  // A pid that cannot be running: the kernel refuses to allocate 0 to a process.
  fs.writeFileSync(lock, "2147483646");

  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });

  assert.equal(readDispatchRows(file).filter((r) => r.ts === daysAgo(60)).length, 0);
  assert.ok(!fs.existsSync(lock), "the stale lock must not be left behind either");
});

test("a LIVE holder's lock is not stolen while a prune could plausibly still be running", () => {
  // The bug three reviewers found in the age-only rule, kept as a regression
  // test. `wx` stamps mtime once and a synchronous prune cannot refresh it, so
  // an age threshold anywhere near a prune's duration makes a slow prune look
  // abandoned, lets a second process delete its lock, and puts both of them into
  // the same file. Ten minutes is ~22000x a measured 27 ms prune and still well
  // inside the belt below: liveness is what decides here, not the clock.
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  const lock = `${file}.prune.lock`;
  fs.writeFileSync(lock, String(process.pid));
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, tenMinutesAgo, tenMinutesAgo);

  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });

  assert.equal(readDispatchRows(file).filter((r) => r.ts === daysAgo(60)).length, 700,
    "a ten-minute-old lock held by a running process is a slow prune, not an abandoned one");
  assert.ok(fs.existsSync(lock), "and it must still be held");
  fs.rmSync(lock, { force: true });
});

test("a live holder's lock is NEVER stolen, however old — it is reported instead", () => {
  // Liveness has one blind spot: the OS recycles pids, so a lock can name a live
  // process unrelated to this package and wedge retention forever. Closed by
  // shouting rather than by guessing — an age rule here would be the round-2 bug
  // again, just with a bigger number.
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  const lock = `${file}.prune.lock`;
  fs.writeFileSync(lock, String(process.pid));
  const ancient = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(lock, ancient, ancient);

  const saved = console.error;
  const lines = [];
  console.error = (m) => lines.push(String(m));
  try {
    appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  } finally {
    console.error = saved;
  }

  assert.equal(readDispatchRows(file).filter((r) => r.ts === daysAgo(60)).length, 700,
    "a live holder keeps its lock at any age");
  assert.ok(fs.existsSync(lock));
  assert.ok(lines.some((l) => /retention is blocked/.test(l)), lines.join(" | "));
  // Quoted: a state dir under a path with a space would otherwise print an `rm`
  // that removes the wrong thing when pasted.
  assert.ok(lines.some((l) => l.includes(`rm ${JSON.stringify(lock)}`)), "and it must say how to clear it");
  fs.rmSync(lock, { force: true });
});

test("a lock with no holder recorded is stealable — a crash between create and write", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  fs.writeFileSync(`${file}.prune.lock`, "");
  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  assert.equal(readDispatchRows(file).filter((r) => r.ts === daysAgo(60)).length, 0);
});

test("a temp file orphaned by a crash is swept, a fresh one is not", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  const orphan = `${file}.tmp.deadbeef00`;
  const recent = `${file}.tmp.aliveaaaa0`;
  fs.writeFileSync(orphan, "junk");
  fs.writeFileSync(recent, "junk");
  const ancient = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(orphan, ancient, ancient);

  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });

  assert.ok(!fs.existsSync(orphan), "an hours-old temp file is litter");
  assert.ok(fs.existsSync(recent), "a fresh one may belong to a prune running right now");
  fs.rmSync(recent, { force: true });
});

test("a rename that fails leaves the original log intact and no temp behind", () => {
  // The atomicity claim, made testable: `rename` is what makes a reader never
  // see a half-written log, so the failure to exercise is the rename itself.
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  bulk(file, 100, daysAgo(1));
  const before = fs.readFileSync(file, "utf-8");

  const realRename = fs.renameSync;
  const saved = console.error;
  const lines = [];
  console.error = (m) => lines.push(String(m));
  fs.renameSync = () => { throw new Error("EXDEV simulated"); };
  try {
    appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  } finally {
    fs.renameSync = realRename;
    console.error = saved;
  }

  assert.ok(fs.readFileSync(file, "utf-8").startsWith(before), "the original must survive untouched");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")), [],
    "and the temp file must be cleaned up");
  assert.ok(lines.some((l) => /could not be pruned/.test(l)), lines.join(" | "));
});

test("a completed prune leaves no lock and no temp file", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  bulk(file, 100, daysAgo(1));
  appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  const litter = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp") || f.includes(".lock"));
  assert.deepEqual(litter, []);
});

test("a prune that cannot read the file says so instead of failing open", () => {
  const file = scratch();
  bulk(file, 700, daysAgo(60));
  const saved = console.error;
  const lines = [];
  console.error = (m) => lines.push(String(m));
  const realRead = fs.readFileSync;
  fs.readFileSync = (f, ...rest) => {
    if (f === file) throw new Error("EIO simulated");
    return realRead(f, ...rest);
  };
  try {
    appendDispatchRow({ ts: NOW_S, agent_id: "fresh", outcome: "success" }, { file, now: NOW_MS });
  } finally {
    fs.readFileSync = realRead;
    console.error = saved;
  }
  assert.ok(lines.some((l) => /could not be pruned/.test(l)), lines.join(" | "));
  // The append still happened — the prune is best-effort, the row is not.
  assert.equal(realRead(file, "utf-8").trim().split("\n").at(-1).includes("fresh"), true);
});

// --- reading ---------------------------------------------------------------

test("a missing log reads as no rows, not as an error", () => {
  assert.deepEqual(readDispatchRows(path.join(os.tmpdir(), "ea-dl-nope", "absent.jsonl")), []);
});

test("a torn last line from a killed append is skipped, not fatal", () => {
  const file = scratch();
  appendDispatchRow({ ts: 1, agent_id: "whole", outcome: "success" }, { file });
  fs.appendFileSync(file, '{"ts":2,"agent_id":"tor');
  assert.deepEqual(readDispatchRows(file).map((r) => r.agent_id), ["whole"]);
});

// --- redaction -------------------------------------------------------------

test("a secret echoed back in error_preview is redacted before it reaches disk", () => {
  const file = scratch();
  const env = { GROQ_API_KEY_2: "gsk_liveKeyMaterial0123456789" };
  const written = appendDispatchRow({
    ts: 1,
    agent_id: "leaky",
    outcome: "error",
    error_preview: "401 Unauthorized: key gsk_liveKeyMaterial0123456789 is revoked",
  }, { file, env });

  assert.ok(!written.error_preview.includes("gsk_liveKeyMaterial0123456789"));
  assert.match(written.error_preview, /«redacted:GROQ_API_KEY_2»/);
  // And on disk, not just in the returned object.
  assert.ok(!fs.readFileSync(file, "utf-8").includes("gsk_liveKeyMaterial0123456789"));
  // The diagnostic half survives — a preview redacted into uselessness would
  // just push people back to the raw sidecar.
  assert.match(readDispatchRows(file)[0].error_preview, /401 Unauthorized/);
});

test("the serialised line is a backstop for fields this module does not model", () => {
  const file = scratch();
  const env = { OPENROUTER_API_KEY: "sk-or-v1-abcdefghijklmnopqrstuvwxyz" };
  appendDispatchRow({
    ts: 1,
    agent_id: "future-field",
    outcome: "error",
    // Not error_preview: something a later caller added and did not route
    // through the field-level pass.
    some_new_field: "boom: sk-or-v1-abcdefghijklmnopqrstuvwxyz",
  }, { file, env });
  assert.ok(!fs.readFileSync(file, "utf-8").includes("sk-or-v1-abcdefghijklmnopqrstuvwxyz"));
});

test("a success row carries no preview at all", () => {
  const file = scratch();
  appendDispatchRow({ ts: 1, agent_id: "fine", outcome: "success" }, { file });
  assert.equal(readDispatchRows(file)[0].error_preview, undefined);
});

// --- permissions -----------------------------------------------------------

test("a pre-existing world-readable log is narrowed to 0600 on the next write", () => {
  const file = scratch();
  fs.writeFileSync(file, "");
  fs.chmodSync(file, 0o644);
  appendDispatchRow({ ts: 1, agent_id: "a", outcome: "success" }, { file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a fresh log is created 0600", () => {
  const file = scratch();
  appendDispatchRow({ ts: 1, agent_id: "a", outcome: "success" }, { file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// --- best-effort -----------------------------------------------------------

test("an unwritable log costs one stderr line, not the dispatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-dl-bad-"));
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  const saved = console.error;
  const lines = [];
  console.error = (m) => lines.push(String(m));
  try {
    const r = appendDispatchRow({ ts: 1, agent_id: "a" }, { file: path.join(blocker, "log.jsonl") });
    assert.equal(r, null);
  } finally {
    console.error = saved;
  }
  assert.equal(lines.length, 1);
  // "telemetry" made a local disk error read like a failed upload. Nothing in
  // the dispatch path sends this anywhere.
  assert.match(lines[0], /dispatch-log write failed/);
  assert.ok(!/telemetry/i.test(lines[0]), lines[0]);
});
