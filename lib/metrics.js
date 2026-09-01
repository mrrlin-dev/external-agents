import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDispatchRows, getRetentionDays } from "./dispatch-log.js";

// ---------------------------------------------------------------------------
// Did the change help?
//
// This module exists because of a specific embarrassment: a seat was audited,
// its ceiling recorded, and 21 impossible dispatches a day should have stopped
// - and the only way to check was to hand-write a `jq` pipeline. A claim that
// something improved, with no way to check it, is a claim nobody should accept,
// including from yourself.
//
// Two pieces, and they answer different questions.
//
//   compare()  - "was it better after than before", from the raw rows. Exact,
//                and limited to what the dispatch log still holds (30 days).
//   rollup()   - one row per (day, agent), so the comparison survives the
//                retention window. ~150 bytes a row, 33 agents, i.e. under
//                2 MB a year, against raw rows that would be ~22 MB and gone
//                after a month anyway.
//
// The daily file is a SUMMARY, not a second copy: no prompt sizes, no error
// text, no timestamp finer than a day. It cannot answer "what happened at
// 10:55" - the raw log does that while it still has the rows - and it is not a
// place to put anything the raw log redacts.
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), ".local", "state", "external-agents");
const DEFAULT_DAILY = path.join(STATE_DIR, "daily.jsonl");

export function getDailyPath() {
  const override = process.env.EXTERNAL_AGENTS_DAILY_FILE;
  return override && override.trim() ? override.trim() : DEFAULT_DAILY;
}

const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/** Fixture rows are guaranteed failures and would poison every rate below. */
const FIXTURE = /^test-/;

// ---------------------------------------------------------------------------
// Cached input is real input, and it is not priced like fresh input.
//
// A cache WRITE costs about 1.25x a base input token; a cache READ about 0.1x.
// That is why the two are stored separately and summed separately, and why
// there are two different right answers about a dispatch:
//
//   how many tokens moved   -> in + write + read + out, all 1:1. They were all
//                              processed. Weighting them here would understate
//                              throughput.
//   what it would have cost -> in + 1.25*write + 0.1*read + out. Weighting is
//                              the whole point; counting a cache read as full
//                              price overstates the bill tenfold.
//
// Measured on a real `claude --print --output-format json` run: input_tokens 10,
// cache_creation 16104, cache_read 21675. Recording only `input_tokens` reported
// 0.03% of the input. That is what this replaces.
// ---------------------------------------------------------------------------
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Every token the seat actually processed, unweighted. */
export function totalTokens(a = {}) {
  return (a.tokens_in || 0) + (a.tokens_out || 0) + (a.cache_read || 0) + (a.cache_write || 0);
}

/** The same work priced as if it had all been fresh input/output. */
export function billableTokens(a = {}) {
  return (a.tokens_in || 0)
    + (a.tokens_out || 0)
    + (a.cache_write || 0) * CACHE_WRITE_MULTIPLIER
    + (a.cache_read || 0) * CACHE_READ_MULTIPLIER;
}

function blank() {
  return { n: 0, ok: 0, timeout: 0, error: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, duration_ms: 0 };
}

function fold(acc, r) {
  acc.n += 1;
  if (r.outcome === "success") acc.ok += 1;
  else if (r.outcome === "timeout") acc.timeout += 1;
  else acc.error += 1;
  acc.tokens_in += r.tokens_in || 0;
  acc.tokens_out += r.tokens_out || 0;
  acc.cache_read += r.cache_read || 0;
  acc.cache_write += r.cache_write || 0;
  acc.duration_ms += r.duration_ms || 0;
  return acc;
}

export function readDaily(file = getDailyPath()) {
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); } catch { return []; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return rows;
}

/**
 * Fold every day the raw log still covers into the daily file.
 *
 * Idempotent, and that is the whole design: a day present in the raw log is
 * RECOMPUTED and overwrites whatever the daily file had for it, so running this
 * twice an hour and running it once a week produce the same file. Days older
 * than the raw log are left exactly as they are - they are the only copy left.
 *
 * Which means: as long as this runs at least once inside the retention window,
 * no day is ever lost. Miss a month and that month is simply gone, the same way
 * it is gone from the raw log. This is a summary of what was observed, not a
 * promise that everything was.
 */
export function rollup({ rows = readDispatchRows(), file = getDailyPath() } = {}) {
  const byKey = new Map();
  for (const r of readDaily(file)) byKey.set(`${r.day} ${r.agent_id}`, r);

  const fresh = new Map();
  for (const r of rows) {
    if (!r || !Number.isFinite(r.ts) || !r.agent_id) continue;
    if (FIXTURE.test(String(r.agent_id))) continue;
    const key = `${dayOf(r.ts)} ${r.agent_id}`;
    let acc = fresh.get(key);
    if (!acc) {
      acc = { day: dayOf(r.ts), agent_id: r.agent_id, provider: r.provider ?? null, ...blank() };
      fresh.set(key, acc);
    }
    fold(acc, r);
  }
  for (const [key, acc] of fresh) byKey.set(key, acc);

  const out = [...byKey.values()].sort((a, b) => (a.day === b.day
    ? String(a.agent_id).localeCompare(String(b.agent_id))
    : String(a.day).localeCompare(String(b.day))));

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, out.map((r) => JSON.stringify(r)).join("\n") + (out.length ? "\n" : ""), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`external-agents: daily rollup write failed: ${e.message}`);
    return { days: 0, rows: out.length, written: false };
  }
  return { days: new Set(out.map((r) => r.day)).size, rows: out.length, written: true };
}

function summarise(entries) {
  const total = blank();
  const byAgent = new Map();
  for (const e of entries) {
    total.n += e.n; total.ok += e.ok; total.timeout += e.timeout; total.error += e.error;
    total.tokens_in += e.tokens_in; total.tokens_out += e.tokens_out; total.duration_ms += e.duration_ms;
    total.cache_read += e.cache_read || 0; total.cache_write += e.cache_write || 0;
    const a = byAgent.get(e.agent_id) || { agent_id: e.agent_id, ...blank() };
    a.n += e.n; a.ok += e.ok; a.timeout += e.timeout; a.error += e.error;
    a.tokens_in += e.tokens_in; a.tokens_out += e.tokens_out; a.duration_ms += e.duration_ms;
    a.cache_read += e.cache_read || 0; a.cache_write += e.cache_write || 0;
    byAgent.set(e.agent_id, a);
  }
  return { total, byAgent };
}

/** Success rate, or null when there is nothing to divide by. */
export const rate = (s) => (s.n > 0 ? s.ok / s.n : null);

/**
 * Two equal windows either side of one instant.
 *
 * `at` is the moment something changed. The window after it runs to `now`, and
 * the window before it is the SAME LENGTH ending at `at` - comparing four hours
 * against three weeks is how you prove anything you like.
 *
 * Raw rows are used when the earlier window still falls inside the dispatch
 * log's retention, and the daily rollup otherwise. The source is returned,
 * never guessed at silently, because the two are not equivalent: the rollup
 * buckets by calendar day, so a window that starts mid-day is widened to that
 * day's boundary and the answer is coarser than it looks.
 */
export function compare({ at, now = Math.floor(Date.now() / 1000), windowS, rows = null, dailyFile = getDailyPath(), retentionDays } = {}) {
  if (!Number.isFinite(at)) throw new Error("compare: `at` must be an epoch-seconds number");
  const asked = Number.isFinite(windowS) && windowS > 0 ? windowS : Math.max(1, now - at);
  // CLAMPED to the time that has actually elapsed since `at`, so both windows
  // are the same length. Asking for six hours either side of something that
  // happened ninety minutes ago cannot give you six hours of "after", and
  // quietly returning 6h-before against 1.5h-after is the unequal comparison
  // this function exists to refuse. You get 1.5h either side and the return
  // value says so.
  const span = Math.max(1, Math.min(asked, now - at));
  const before = { from: at - span, to: at };
  const after = { from: at, to: at + span };

  const raw = rows ?? readDispatchRows();
  const usable = raw.filter((r) => r && Number.isFinite(r.ts) && r.agent_id && !FIXTURE.test(String(r.agent_id)));

  // Which source can answer for the EARLIER window decides it, and the test is
  // retention, not "is there a row that old".
  //
  // Keying off the oldest row present was the first attempt and it is wrong in
  // the ordinary case: a quiet Sunday inside the window makes the oldest row
  // younger than the window start, the check concludes the log does not reach
  // back, and a perfectly answerable question gets silently downgraded to
  // whole-day buckets. Retention is a property of the file, not of how busy the
  // pool happened to be.
  const retentionS = (Number.isFinite(retentionDays) ? retentionDays : getRetentionDays()) * 86400;

  let source, beforeEntries, afterEntries;
  if (before.from >= now - retentionS) {
    source = "dispatch-log";
    const bucket = (w) => {
      const m = new Map();
      for (const r of usable) {
        if (r.ts < w.from || r.ts >= w.to) continue;
        const a = m.get(r.agent_id) || { agent_id: r.agent_id, ...blank() };
        fold(a, r);
        m.set(r.agent_id, a);
      }
      return [...m.values()];
    };
    beforeEntries = bucket(before);
    afterEntries = bucket(after);
  } else {
    // The raw log no longer reaches back far enough. Fall back to whole days.
    source = "daily-rollup";
    const daily = readDaily(dailyFile);
    const inWindow = (w) => daily.filter((e) => {
      const start = Math.floor(Date.parse(`${e.day}T00:00:00Z`) / 1000);
      return start + 86400 > w.from && start < w.to;
    });
    beforeEntries = inWindow(before);
    afterEntries = inWindow(after);
  }

  const b = summarise(beforeEntries);
  const a = summarise(afterEntries);
  const agents = [];
  for (const id of new Set([...b.byAgent.keys(), ...a.byAgent.keys()])) {
    const bs = b.byAgent.get(id) || blank();
    const as = a.byAgent.get(id) || blank();
    agents.push({
      agent_id: id,
      before: { ...bs, rate: rate(bs) },
      after: { ...as, rate: rate(as) },
      // null rather than 0 when either side is empty: "no data" and "no change"
      // are different answers and only one of them is a result.
      delta: rate(bs) == null || rate(as) == null ? null : rate(as) - rate(bs),
    });
  }
  agents.sort((x, y) => (y.after.n + y.before.n) - (x.after.n + x.before.n));

  return {
    at, now,
    window_s: span,
    // Surfaced rather than swallowed: a caller that asked for a wider window
    // needs to know it did not get one, and why.
    requested_window_s: asked,
    window_clamped: span < asked,
    source,
    before: { ...before, ...b.total, rate: rate(b.total) },
    after: { ...after, ...a.total, rate: rate(a.total) },
    delta: rate(b.total) == null || rate(a.total) == null ? null : rate(a.total) - rate(b.total),
    agents,
  };
}


// ---------------------------------------------------------------------------
// The saved estimate.
//
// Lives here rather than in the dashboard because it is arithmetic with
// contested assumptions, and arithmetic with contested assumptions is the kind
// that has to be testable. A design review took a single number apart; what
// survived is a RANGE, its components, and one count that needs no
// counterfactual at all.
//
// WHAT THIS NUMBER CANNOT KNOW, and the reason it is a range rather than a
// figure: it assumes demand is perfectly inelastic - that every free token is
// a paid token avoided. Much of this pool's traffic would never have been
// bought at frontier prices (four-voice consensus panels, retries, audits,
// probes), and that is induced consumption, not displaced spend. Nothing in
// the dispatch log distinguishes the two, so the upper bound is an upper bound
// in the strict sense and the caller must say so.
//
// Weighting tokens by seat capability was considered and rejected: the
// candidate coefficients moved the total by at most 13.6% on measured traffic
// and had no calibration behind them, which is more invented error than the
// uniform weighting it would have replaced.
// ---------------------------------------------------------------------------

function fold1(acc, a) {
  acc.dispatches += a.count || 0;
  acc.tokens += totalTokens(a);
  acc.billable += billableTokens(a);
  // Input side only, cache tiers already weighted. Reusing billableTokens with
  // tokens_out omitted keeps one definition of "what input costs" - duplicating
  // the multipliers here is how the two halves drift apart.
  acc.billableIn += billableTokens({ tokens_in: a.tokens_in, cache_read: a.cache_read, cache_write: a.cache_write });
  acc.out += a.tokens_out || 0;
  return acc;
}

function priced(acc, anchor) {
  const M = 1_000_000;
  // Low: one blended rate, the original conservative figure.
  // High: input and output at their real, separate rates (~5x apart).
  // The spread between them is the honest width of the answer.
  const low = (acc.billable / M) * anchor.blended_per_m;
  const high = (acc.billableIn / M) * anchor.input_per_m + (acc.out / M) * anchor.output_per_m;
  return {
    dispatches_free: acc.dispatches,
    tokens_free: acc.tokens,
    tokens_free_billable: acc.billable,
    saved_low: Math.min(low, high),
    saved_high: Math.max(low, high),
  };
}

const emptyAcc = () => ({ dispatches: 0, tokens: 0, billable: 0, billableIn: 0, out: 0 });

/**
 * @param {Array<[string, object]>} freeAgents  [id, aggregate] for free-tagged seats
 * @param {{blended_per_m:number, input_per_m:number, output_per_m:number}} anchor
 * @param {(id: string) => string} [tierOf]  optional: returns "strong" | "weak"
 *
 * With `tierOf`, the same totals are ALSO returned split by seat capability, in
 * `by_tier`. That split is deliberately a decomposition and not a coefficient.
 *
 * A capability coefficient - counting a weak seat's token as some fraction of a
 * strong one's - was proposed and rejected: it folds a judgement invisibly into
 * a single figure, and there is nothing to calibrate it against. Showing the two
 * tiers side by side carries the same information and invents no number: a
 * reader who thinks a weak-seat token is worth a tenth of a strong one can apply
 * that belief to a figure they can see, and a reader who disagrees is not
 * silently overruled.
 *
 * Measured on this pool, weak seats were 14.4% of volume, so the split is mostly
 * a statement about where the pool's value actually sits.
 */
export function savedEstimate(freeAgents, anchor, tierOf = null) {
  const entries = Array.isArray(freeAgents) ? freeAgents : [];
  const all = emptyAcc();
  const tiers = { strong: emptyAcc(), weak: emptyAcc() };
  let sawTier = false;
  for (const [id, a] of entries) {
    if (!a) continue;
    fold1(all, a);
    if (!tierOf) continue;
    // Anything that is not explicitly weak is counted as strong, so an entry
    // whose tier is missing or misspelled inflates nothing: it lands in the
    // bucket that gets the full rate anyway, which is the same treatment the
    // undecomposed total gives it.
    const tier = tierOf(id) === "weak" ? "weak" : "strong";
    fold1(tiers[tier], a);
    sawTier = true;
  }
  const out = priced(all, anchor);
  if (sawTier) {
    out.by_tier = { strong: priced(tiers.strong, anchor), weak: priced(tiers.weak, anchor) };
  }
  return out;
}
