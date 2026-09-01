import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rollup, readDaily, compare, rate, getDailyPath } from "./metrics.js";

// Point the default sink at a scratch file before anything can touch the real
// one. The dispatch log needed exactly this fix (357 fixture rows in the
// operator's log over 119 suite runs); a second summary file is not going to
// repeat it.
process.env.EXTERNAL_AGENTS_DAILY_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "ea-metrics-default-")),
  "daily.jsonl",
);

const DAY = 86400;
// 2026-08-20T00:00:00Z, so `dayOf` lands on a stable calendar day in UTC.
const D0 = Math.floor(Date.parse("2026-08-20T00:00:00Z") / 1000);
const at = (dayOffset, hour = 12) => D0 + dayOffset * DAY + hour * 3600;

function scratch() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ea-metrics-")), "daily.jsonl");
}
const row = (o) => ({ ts: at(0), agent_id: "a", provider: "p", outcome: "success", duration_ms: 10, ...o });

// --- rollup ----------------------------------------------------------------

test("rollup folds rows into one row per day and agent", () => {
  const file = scratch();
  rollup({
    file,
    rows: [
      row({ ts: at(0, 1), agent_id: "a", outcome: "success", tokens_in: 5 }),
      row({ ts: at(0, 23), agent_id: "a", outcome: "error" }),
      row({ ts: at(0, 3), agent_id: "b", outcome: "timeout" }),
      row({ ts: at(1, 3), agent_id: "a", outcome: "success" }),
    ],
  });
  const out = readDaily(file);
  assert.equal(out.length, 3, "two agents on day 0, one on day 1");
  const a0 = out.find((r) => r.day === "2026-08-20" && r.agent_id === "a");
  assert.deepEqual(
    { n: a0.n, ok: a0.ok, error: a0.error, tokens_in: a0.tokens_in },
    { n: 2, ok: 1, error: 1, tokens_in: 5 },
  );
  const b0 = out.find((r) => r.agent_id === "b");
  assert.equal(b0.timeout, 1);
  assert.equal(b0.ok, 0);
});

test("rollup excludes test fixtures — they fail on purpose and would poison every rate", () => {
  const file = scratch();
  rollup({ file, rows: [row({ agent_id: "test-failing-cli", outcome: "error" }), row({ agent_id: "real" })] });
  assert.deepEqual(readDaily(file).map((r) => r.agent_id), ["real"]);
});

test("rollup is idempotent — running it twice produces the same file", () => {
  const file = scratch();
  const rows = [row({ ts: at(0, 1) }), row({ ts: at(0, 2), outcome: "error" })];
  rollup({ file, rows });
  const once = fs.readFileSync(file, "utf-8");
  rollup({ file, rows });
  rollup({ file, rows });
  assert.equal(fs.readFileSync(file, "utf-8"), once, "a day is recomputed, never accumulated onto itself");
});

test("a day already rolled up is REPLACED, not kept, when more of it arrives", () => {
  // The realistic case: doctor runs at noon and folds half a day, then runs
  // again at midnight. Keeping the first row would freeze the day at noon and
  // every later comparison would read a day that never happened.
  const file = scratch();
  rollup({ file, rows: [row({ ts: at(0, 1) })] });
  assert.equal(readDaily(file)[0].n, 1);

  rollup({ file, rows: [row({ ts: at(0, 1) }), row({ ts: at(0, 20), outcome: "error" })] });
  const [only] = readDaily(file);
  assert.equal(only.n, 2, "the fuller version of the day must win");
  assert.equal(only.ok, 1);
  assert.equal(only.error, 1);
});

test("rollup keeps days the raw log no longer covers — they are the only copy left", () => {
  const file = scratch();
  rollup({ file, rows: [row({ ts: at(0), agent_id: "old" })] });
  // The raw log has since been pruned and only knows about a later day.
  rollup({ file, rows: [row({ ts: at(5), agent_id: "new" })] });
  const days = readDaily(file).map((r) => `${r.day}/${r.agent_id}`);
  assert.deepEqual(days, ["2026-08-20/old", "2026-08-25/new"]);
});

test("rollup leaves no temp file behind and writes 0600", () => {
  const file = scratch();
  rollup({ file, rows: [row({})] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")), []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("rollup on an empty log writes an empty file rather than failing", () => {
  const file = scratch();
  const r = rollup({ file, rows: [] });
  assert.equal(r.rows, 0);
  assert.deepEqual(readDaily(file), []);
});

test("getDailyPath honours the override and otherwise lives in the state dir", () => {
  const saved = process.env.EXTERNAL_AGENTS_DAILY_FILE;
  delete process.env.EXTERNAL_AGENTS_DAILY_FILE;
  try {
    assert.ok(getDailyPath().startsWith(path.join(os.homedir(), ".local", "state", "external-agents")));
    process.env.EXTERNAL_AGENTS_DAILY_FILE = "/tmp/x/daily.jsonl";
    assert.equal(getDailyPath(), "/tmp/x/daily.jsonl");
  } finally {
    if (saved === undefined) delete process.env.EXTERNAL_AGENTS_DAILY_FILE;
    else process.env.EXTERNAL_AGENTS_DAILY_FILE = saved;
  }
});

// --- compare ---------------------------------------------------------------

test("compare measures two equal windows either side of the instant", () => {
  const change = at(2);
  const now = change + 2 * 3600;
  const rows = [
    // before: 1 of 3
    row({ ts: change - 3600, outcome: "error" }),
    row({ ts: change - 1800, outcome: "error" }),
    row({ ts: change - 900, outcome: "success" }),
    // after: 3 of 3
    row({ ts: change + 600 }), row({ ts: change + 1200 }), row({ ts: change + 1800 }),
    // outside both windows, must be ignored
    row({ ts: change - 10 * 3600, outcome: "error" }),
  ];
  const c = compare({ at: change, now, rows });
  assert.equal(c.window_s, 2 * 3600);
  assert.equal(c.before.n, 3);
  assert.equal(c.after.n, 3);
  assert.equal(c.before.rate, 1 / 3);
  assert.equal(c.after.rate, 1);
  assert.ok(Math.abs(c.delta - 2 / 3) < 1e-9);
});

test("a window wider than the time elapsed is clamped so both sides stay equal", () => {
  const change = at(2);
  const now = change + 3600; // only an hour has passed
  const c = compare({ at: change, now, windowS: 6 * 3600, rows: [row({ ts: change + 60 })] });
  assert.equal(c.window_s, 3600, "clamped to the elapsed hour");
  assert.equal(c.requested_window_s, 6 * 3600);
  assert.equal(c.window_clamped, true);
  assert.equal(c.before.to - c.before.from, c.after.to - c.after.from, "the two windows must be the same length");
});

test("an unclamped window says so", () => {
  const change = at(2);
  const c = compare({ at: change, now: change + 10 * 3600, windowS: 3600, rows: [] });
  assert.equal(c.window_clamped, false);
  assert.equal(c.window_s, 3600);
});

test("delta is null when one side has no dispatches — no data is not no change", () => {
  const change = at(2);
  const c = compare({ at: change, now: change + 3600, rows: [row({ ts: change + 60 })] });
  assert.equal(c.before.n, 0);
  assert.equal(c.before.rate, null);
  assert.equal(c.delta, null);
  const only = c.agents.find((a) => a.agent_id === "a");
  assert.equal(only.delta, null, "and per-agent too");
});

test("compare excludes fixtures on both sides", () => {
  const change = at(2);
  const now = change + 3600;
  const c = compare({
    at: change, now,
    rows: [row({ ts: change - 60, agent_id: "test-x", outcome: "error" }), row({ ts: change + 60, agent_id: "real" })],
  });
  assert.equal(c.before.n, 0);
  assert.deepEqual(c.agents.map((a) => a.agent_id), ["real"]);
});

test("compare falls back to the daily rollup once the window predates retention", () => {
  const file = scratch();
  const change = at(10);
  const now = change + DAY;
  // Retention of one day: the before-window (the day before `change`) has
  // already been pruned out of the raw log, and only the rollup remembers it.
  rollup({ file, rows: [row({ ts: at(9), outcome: "error" }), row({ ts: at(9, 13), outcome: "error" })] });
  const c = compare({ at: change, now, rows: [row({ ts: change + 3600 })], dailyFile: file, retentionDays: 1 });
  assert.equal(c.source, "daily-rollup");
  assert.equal(c.before.n, 2);
  assert.equal(c.before.rate, 0);
});

test("a quiet stretch does not demote the source — retention decides, not the oldest row", () => {
  // The first version keyed off the oldest row present, so a window whose early
  // half happened to be idle looked like a window the log could not reach, and
  // an answerable question was silently downgraded to whole-day buckets.
  const change = at(10);
  const now = change + 3600;
  const rows = [row({ ts: change - 60, outcome: "error" }), row({ ts: change + 60 })];
  const c = compare({ at: change, now, rows, dailyFile: scratch(), retentionDays: 30 });
  assert.equal(c.source, "dispatch-log", "an hour-old window is well inside a 30-day retention");
  assert.equal(c.before.n, 1);
});

test("compare refuses a non-numeric instant rather than inventing one", () => {
  assert.throws(() => compare({ at: undefined, rows: [] }), /epoch-seconds/);
  assert.throws(() => compare({ at: "yesterday", rows: [] }), /epoch-seconds/);
});

test("rate is null on an empty bucket, not zero", () => {
  assert.equal(rate({ n: 0, ok: 0 }), null);
  assert.equal(rate({ n: 4, ok: 1 }), 0.25);
});
