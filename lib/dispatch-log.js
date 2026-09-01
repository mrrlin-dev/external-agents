import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "./failure-log.js";

// ---------------------------------------------------------------------------
// Dispatch log — one small row per call, always on, bounded by AGE.
//
// This is the AGGREGATE sink, and it is deliberately the opposite of the
// failure sidecar next door: on by default, no prompt text, no raw streams,
// ~300 bytes a row. Every defect fixed in this area was found by reading it and
// none was found by reading code, so it stays on. What it must not do is hoard.
//
// WHY AGE AND NOT SIZE
//
// The obvious retention is what failures.jsonl does: rotate at N bytes, keep one
// old generation. It was written that way first and then thrown away, because
// every question anyone asks this file is a question about TIME — `get_stats
// --since`, `doctor --since 24h`, `doctor`'s measured-allowance window. A byte
// cap satisfies those only by coincidence of traffic rate: a quiet month hoards
// a year of dead rows, a busy week drops the far end of a window somebody is
// still asking about. Nothing errors in either direction, which is what makes it
// the wrong axis.
//
// NOT a reason, though it was claimed as one in review: the 30-day
// OBSERVED_LIMIT_TTL_S in budget.js. That TTL is checked against
// `observed_limits.seen_at` in state.json (budget.js effectiveTokenCeiling) and
// never reads this file, so retention here cannot expire a ceiling.
//
// So: keep the last 30 days. The byte cap survives only as a backstop against a
// runaway that outruns the age rule inside one window.
//
// Dropping the second generation drops a trap with it. When a rotated file
// exists, every reader has to know about it, and a reader that does not returns
// FEWER ROWS rather than an error — the first rotation would quietly truncate
// every window reaching past it and look exactly like a quiet month. One file,
// one reader, nothing to forget.
//
// WHAT PRUNING COSTS. It rewrites the file, so a row appended by another process
// between the read and the rename is lost — several `external-agents` servers
// share this file on one machine. That is why the trigger has hysteresis below:
// pruning happens every few days, not on every append at steady state, and a
// best-effort telemetry sink can afford to lose a handful of rows that rarely.
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), ".local", "state", "external-agents");
const DEFAULT_LOG = path.join(STATE_DIR, "dispatch-log.jsonl");

/** How much history is worth keeping. Long enough to cover the 30-day ledger. */
export const DEFAULT_RETENTION_DAYS = 30;

// Backstop only: bounds a burst that outruns the age rule inside one window.
// Under normal traffic (~62 KiB/day measured) age prunes long before this.
export const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;

// Below this the file is not worth rewriting whatever its age — a few thousand
// rows cost nothing to keep and nothing to read.
const PRUNE_FLOOR_BYTES = 1024 * 1024;

/**
 * Where rows are written. `EXTERNAL_AGENTS_DISPATCH_LOG_FILE` moves it.
 *
 * The override is not a convenience. Without one this package's own test suite
 * had nowhere else to go: fixtures that dispatch on purpose and fail on purpose
 * appended to the operator's real log, 357 rows of `test-*` over 119 suite runs
 * on the machine this was written on, and doctor.js grew a `/^test-/` filter to
 * subtract them back out. The sibling log had this exact defect and it was fixed
 * the same way (see `EXTERNAL_AGENTS_FAILURE_LOG_FILE`).
 */
export function getDispatchLogPath() {
  const override = process.env.EXTERNAL_AGENTS_DISPATCH_LOG_FILE;
  return override && override.trim() ? override.trim() : DEFAULT_LOG;
}

function positiveEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getRetentionDays() {
  return positiveEnv("EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
}

export function getMaxFileBytes() {
  return positiveEnv("EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES", DEFAULT_MAX_FILE_BYTES);
}

/**
 * The smallest `ts` in the first 8 KiB, read without loading the file.
 *
 * This is the trigger test, so it runs on the dispatch path and has to stay
 * cheap: one open and one 8 KiB read, next to a call that took seconds.
 *
 * It reads the MINIMUM over that window rather than line 1 alone. Several
 * processes append to this file concurrently, so nothing guarantees the first
 * line is the oldest — though in practice it is: 8486 rows written by five
 * concurrent servers over 41 days contained zero backwards steps in `ts`, which
 * is what O_APPEND plus a timestamp taken immediately before the write buys you.
 * A window of ~25 rows costs the same syscall and stops the trigger resting on
 * that. If ordering ever were pathological enough to hide an overdue row past
 * the window — or if the head is unparseable and this returns null — age never
 * gets a vote and the byte ceiling below is the only thing bounding the file. It
 * then keeps the newest rows that fit and says so on stderr, which is a coarser
 * outcome than the age pass and is meant to be legible as one.
 */
function oldestTs(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString("utf-8").split("\n");
    // The final element is a partial line unless the read ended exactly on a
    // newline; either way it is not safe to parse, so it is dropped.
    lines.pop();
    let min = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ts;
      try { ts = JSON.parse(line)?.ts; } catch { continue; }
      if (Number.isFinite(ts) && (min == null || ts < min)) min = ts;
    }
    return min;
  } catch {
    return null; // no file, or nothing parseable at the head — do not prune on a guess
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

// A prune rewrites the file, so two of them at once would clobber each other.
// One single-holder lock makes that impossible; it is NOT taken on append,
// deliberately. Locking the hot path would put a syscall and a contention point
// on every dispatch, and a process dying mid-dispatch would stall every other
// server's logging — a far worse failure than the one it prevents.
//
// What stays unprotected is an append landing inside the rewrite window. That
// row is lost. Measured rather than waved at: a prune of the real 2.5 MB log
// takes 27 ms, traffic is ~206 rows/day, and hysteresis makes prunes about six
// days apart — roughly one lost row every 250 years. Best-effort telemetry can
// pay that; it could not pay a lock on every append.
//
// STALENESS IS DECIDED BY LIVENESS, AND ONLY BY LIVENESS. An age rule was tried
// twice and rejected twice, by four reviewers between them, for a reason worth
// keeping written down: `openSync(lock, "wx")` stamps mtime once at creation and
// a synchronous prune cannot refresh it, so ANY age threshold is a promise that
// no prune will ever be slower than the number chosen. A prune slower than that
// watches a second process declare its lock stale, delete it, and start pruning
// the same file. Raising the number does not fix the race; it makes it rarer and
// much harder to find. So the lock records its holder's pid and is broken only
// when that process is gone.
//
// That leaves one hole, and it is closed by shouting rather than by guessing: a
// pid the OS has recycled onto an unrelated long-lived process reads as alive
// forever, which would wedge retention silently and let the log grow without
// bound — precisely the failure this module exists to prevent. So a lock held
// far longer than any prune could take is reported to the operator, with the
// command to clear it, and never stolen. A rare manual step is a fair price for
// a lock that is actually a lock.
const STUCK_LOCK_WARN_MS = 60 * 60_000;
const STALE_TEMP_MS = 60 * 60_000;

function holderIsGone(lock) {
  let raw;
  try { raw = fs.readFileSync(lock, "utf-8"); } catch { return false; }
  const pid = Number.parseInt(raw, 10);
  // No parseable pid means no live claim to respect. The window this covers is
  // real: `wx` creates the file and the pid is written a microsecond later, so a
  // process killed in between leaves an empty lock. Refusing to break that would
  // wedge retention permanently over a crash nobody can see.
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0); // signal 0 tests for existence without delivering anything
    return false;
  } catch (e) {
    return e.code === "ESRCH"; // EPERM means alive and owned by somebody else
  }
}

/**
 * Run `fn` as the file's only pruner, or not at all.
 *
 * Mutual exclusion is between PRUNERS, and that is the whole of the claim. It
 * does not order appends, and it does not make a prune atomic with respect to
 * one — an append landing inside the rewrite is still lost, at the rate given
 * above. Returns whether `fn` ran.
 */
function withPruneLock(file, fn) {
  const lock = `${file}.prune.lock`;
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (holderIsGone(lock)) {
      fs.unlinkSync(lock);
    } else if (age > STUCK_LOCK_WARN_MS) {
      console.error(
        `external-agents: dispatch log retention is blocked — ${lock} has been held `
        + `for ${Math.round(age / 60_000)} minutes by a process that is still running. `
        + `No prune of this file can run until it is released. If that process is not `
        + `pruning (a recycled pid), remove the lock: rm ${JSON.stringify(lock)}`,
      );
    }
  } catch { /* no lock file, which is the normal case */ }
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
    fs.writeSync(fd, String(process.pid));
  } catch {
    return false; // somebody else is pruning; this append just skips it
  }
  try {
    fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* already reaped */ }
  }
  return true;
}

// A crash between writing the temp file and renaming it leaves the temp behind.
// Nothing reads it — the reader opens exactly one path — but a package whose
// point is that it does not litter the operator's state directory should not
// leave litter. Swept here rather than on append: this runs once per prune.
function sweepStaleTemps(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp.`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > STALE_TEMP_MS) fs.unlinkSync(full);
    } catch { /* raced with another sweep */ }
  }
}

/**
 * Drop rows older than the retention window, rewriting the file in place.
 *
 * HYSTERESIS is the point of `graceDays`. Prune the moment the oldest row falls
 * outside the window and the steady state is pathological: the oldest row is
 * always exactly at the boundary, so every single append rewrites the whole
 * file. Waiting until it is `graceDays` past due means a rewrite every
 * `graceDays` instead, and the file holds between `retentionDays` and
 * `retentionDays + graceDays` — 30 to 36 at the default.
 *
 * The grace is a fifth of the window, floored at one whole day, so the bound
 * holds at every retention value: at 30 days it is 6, at 7 days it is 1, and at
 * 1 day the floor makes it 1, i.e. a rewrite a day at worst. There is no
 * retention setting for which this degenerates to rewriting on every append.
 */
function pruneIfNeeded(file, { retentionDays, maxFileBytes, now }) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < PRUNE_FLOOR_BYTES) return;

  const nowS = Math.floor(now / 1000);
  const cutoff = nowS - retentionDays * 86400;
  const graceDays = Math.max(1, Math.round(retentionDays * 0.2));
  const overdue = nowS - (retentionDays + graceDays) * 86400;

  const oldest = oldestTs(file);
  const tooOld = oldest != null && oldest < overdue;
  const tooBig = size >= maxFileBytes;
  if (!tooOld && !tooBig) return;

  withPruneLock(file, () => {
    sweepStaleTemps(file);
    prune(file, { cutoff, maxFileBytes });
  });
}

function prune(file, { cutoff, maxFileBytes }) {
  let kept = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let ts;
      try { ts = JSON.parse(line)?.ts; } catch { continue; } // torn line: drop it here
      // A row with no usable timestamp cannot be judged on age, so it is kept —
      // the byte backstop below is what stops those accumulating.
      if (Number.isFinite(ts) && ts < cutoff) continue;
      kept.push(line);
    }
  } catch (e) {
    // Failing open here means the file stays over its limits indefinitely, and
    // this module's whole point is that nothing about its bounds is silent.
    console.error(`external-agents: dispatch log could not be pruned: ${e.message}`);
    return;
  }

  // Backstop. Age alone did not get under the ceiling, so take the newest rows
  // that fit and say so — a silent truncation here is the thing this whole
  // module is trying not to do.
  let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l, "utf-8") + 1, 0);
  if (bytes > maxFileBytes) {
    const fitted = [];
    let used = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const cost = Buffer.byteLength(kept[i], "utf-8") + 1;
      if (used + cost > maxFileBytes) break;
      used += cost;
      fitted.push(kept[i]);
    }
    fitted.reverse();
    console.error(
      `external-agents: dispatch log still exceeded ${maxFileBytes} bytes after the `
      + `age pass; kept the newest ${fitted.length} of ${kept.length} rows`,
    );
    kept = fitted;
    bytes = used;
  }

  // `rename` within a directory is atomic, so a reader never sees a half-written
  // log: until the rename lands, `file` is still the original. That is the whole
  // claim — it is NOT a claim that a crash leaves nothing behind. A crash between
  // the write and the rename leaves the temp file, which is what sweepStaleTemps
  // above is for. The name is random rather than pid-based: two prunes in one
  // process would share a pid, and the lock is a guard, not a proof.
  const tmp = `${file}.tmp.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`external-agents: dispatch log could not be pruned: ${e.message}`);
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Append one row. Best-effort by construction: a log that can fail a dispatch
 * is worse than no log, so every error here is swallowed after one line on
 * stderr.
 *
 * Returns the row as written (redacted), or null on failure.
 */
export function appendDispatchRow(row, options = {}) {
  const file = options.file || getDispatchLogPath();
  const env = options.env || process.env;
  try {
    const out = { ...row };
    // `error_preview` is the only free-text field in the row: the last 400
    // characters of a provider's stderr or response body, captured verbatim.
    // Measured over 1675 real previews on the machine this was written for,
    // `redact` changed none of them — so this is insurance against a channel
    // that CAN carry a key (a CLI echoing `--api-key …` back in a usage error,
    // a provider quoting the Authorization header it rejected), not a fix for
    // an observed leak. It costs one pass over 400 bytes on the failure path.
    if (out.error_preview) out.error_preview = redact(String(out.error_preview), env);

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    pruneIfNeeded(file, {
      retentionDays: options.retentionDays ?? getRetentionDays(),
      maxFileBytes: options.maxFileBytes ?? getMaxFileBytes(),
      now: options.now ?? Date.now(),
    });
    // `mode` on appendFileSync applies at CREATION only, so a file that already
    // exists keeps whatever mode it has — including one an earlier version of
    // this package, or an operator, left world-readable. One stat per dispatch
    // is nothing next to being wrong about who can read this.
    try {
      const st = fs.statSync(file);
      if ((st.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
    } catch { /* not created yet — appendFileSync's mode covers that case */ }
    // Backstop over the serialised line, same as the failure sink: it covers
    // the fields this module does not model, including one a future caller adds
    // and forgets to route through the pass above.
    fs.appendFileSync(file, redact(JSON.stringify(out), env) + "\n", { mode: 0o600 });
    return out;
  } catch (e) {
    // Not "telemetry". Nothing is sent anywhere — this is a local append, and
    // the word made a disk error read like a failed upload.
    console.error(`external-agents: dispatch-log write failed: ${e.message}`);
    return null;
  }
}

/**
 * Every row on disk, in the order it was written, for callers that filter by
 * `ts`. One file: see the note above on why there is no second generation.
 *
 * Accepts a path string for the callers that passed one positionally.
 */
export function readDispatchRows(options = {}) {
  const opts = typeof options === "string" ? { file: options } : (options || {});
  const file = opts.file || getDispatchLogPath();
  let raw;
  try { raw = fs.readFileSync(file, "utf-8"); } catch { return []; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line from a killed append */ }
  }
  return rows;
}
