import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExhaustionResetAt } from "./quota-reset.js";
import { isAgentEnabled } from "./pick.js";
import { recordFailure, readFailureLogConfig } from "./failure-log.js";

export function getTransportConfig(agentEntry, transport) {
  const value = agentEntry?.transports?.[transport];
  if (!value) return null;
  if (typeof value === "string") return { cmd: value };
  if (typeof value === "object") return value;
  return null;
}

/**
 * Resolve a per-entry env override map. Value may be:
 *   - a literal string → used as-is
 *   - "@file:<path>"   → read file, strip trailing whitespace; `~/` is expanded
 * Unresolvable @file: entries produce a warning and are omitted.
 */
function resolveEntryEnv(envMap) {
  if (!envMap || typeof envMap !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(envMap)) {
    if (typeof v !== "string") continue;
    if (v.startsWith("@file:")) {
      let p = v.slice("@file:".length);
      if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
      try {
        out[k] = fs.readFileSync(p, "utf-8").trim();
      } catch (e) {
        console.error(`dispatch: WARN — could not read ${p} for env ${k}: ${e.message}`);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resolve a `files` array into a context block prepended to the prompt.
 *
 * Each entry is one of:
 *   - { path: "relative/or/absolute" }           → read entire file
 *   - { path: "...", lines: "10-50" }             → read line range
 *   - { path: "...", lines: "10-50", label: "..." } → custom label in the block
 *
 * Paths are resolved relative to `basedir` (typically cwd or repo root).
 * Required for `generate_new`, whose HTTP model cannot read the repository;
 * optional for `edit_exists`, whose direct CLI can inspect `cwd` itself.
 * Missing/unreadable files produce a warning line instead of failing the dispatch.
 *
 * options.baseFromCwd === false tells the containment error that `basedir` was not
 * chosen by the caller but fell back to process.cwd(), which is the usual cause —
 * the message then names the missing cwd instead of just reporting "outside basedir".
 *
 * Returns the assembled context string (empty string if no files or all unreadable).
 */
const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file — keeps prompt within provider token limits
// Aggregate cap across ALL attached files combined. MAX_FILE_BYTES alone lets
// N individually-small files sum past any real context window — confirmed
// live: 25 files well under 256KB each still pushed one dispatch from ~131k
// to ~594k tokens, and the provider silently truncated rather than erroring
// (no text for any error-sniffing regex to catch), so prevention here is the
// only fix that actually works. ~512KB is a conservative ~128k-token budget
// at a ~4-bytes/token estimate, matching the smallest real context window in
// this registry (gpt-oss-120b's ~131k) rather than the largest.
export const MAX_TOTAL_FILE_BYTES = 512 * 1024;

export function resolveFileContext(files, basedir, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return "";
  const strictContainment = options.strictContainment === true;

  const resolvedBase = fs.existsSync(basedir || process.cwd())
    ? fs.realpathSync(path.resolve(basedir || process.cwd()))
    : path.resolve(basedir || process.cwd());
  const blocks = [];
  let totalBytes = 0;
  for (const entry of files) {
    if (!entry || typeof entry.path !== "string") continue;

    const filePath = path.isAbsolute(entry.path)
      ? entry.path
      : path.resolve(resolvedBase, entry.path);

    // Containment: resolved real path must be under basedir.
    // This prevents ../traversal and exfiltration of secrets via generate_new.
    let realPath;
    try {
      realPath = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
    } catch (e) {
      blocks.push(`<!-- FILE ${entry.path}: unresolvable (${e.code || e.message}) -->`);
      continue;
    }
    if (!realPath.startsWith(resolvedBase + path.sep) && realPath !== resolvedBase) {
      if (strictContainment) {
        throw new Error(
          `runAny: cannot attach file ${entry.path}: resolves to ${realPath}, outside basedir ${resolvedBase}` +
            (options.baseFromCwd === false ? " — pass cwd (the repo root) alongside files; without it paths resolve against the current process cwd" : ""),
        );
      }
      blocks.push(`<!-- FILE ${entry.path}: outside basedir, skipped -->`);
      continue;
    }

    let content;
    try {
      const stat = fs.statSync(realPath);
      if (stat.size > MAX_FILE_BYTES) {
        blocks.push(`<!-- FILE ${entry.path}: ${stat.size} bytes exceeds ${MAX_FILE_BYTES} byte cap, skipped -->`);
        continue;
      }
      if (totalBytes + stat.size > MAX_TOTAL_FILE_BYTES) {
        blocks.push(`<!-- FILE ${entry.path}: skipped — attaching it would push the combined attached-file total past the ${MAX_TOTAL_FILE_BYTES} byte aggregate cap (many small files can blow the context budget just as badly as one big one) -->`);
        continue;
      }
      content = fs.readFileSync(realPath, "utf-8");
      totalBytes += stat.size;
    } catch (e) {
      blocks.push(`<!-- FILE ${entry.path}: unreadable (${e.code || e.message}) -->`);
      continue;
    }

    let linesApplied = false;
    if (entry.lines) {
      const m = String(entry.lines).match(/^(\d+)-(\d+)$/);
      if (m) {
        const start = Math.max(1, parseInt(m[1], 10));
        const end = parseInt(m[2], 10);
        if (end >= start) {
          const allLines = content.split("\n");
          const sliced = allLines.slice(start - 1, end);
          if (sliced.length > 0) {
            content = sliced.map((l, i) => `${start + i}\t${l}`).join("\n");
            linesApplied = true;
          } else {
            blocks.push(`<!-- FILE ${entry.path}: lines ${entry.lines} out of range (file has ${allLines.length} lines) -->`);
            continue;
          }
        } else {
          blocks.push(`<!-- FILE ${entry.path}: invalid range ${entry.lines} (end < start) -->`);
          continue;
        }
      } else {
        blocks.push(`<!-- FILE ${entry.path}: malformed lines "${entry.lines}", reading full file -->`);
      }
    }

    const label = entry.label || entry.path;
    const lineNote = linesApplied ? ` (lines ${entry.lines})` : "";
    blocks.push(`--- FILE: ${label}${lineNote} ---\n${content}\n--- END FILE ---`);
  }

  if (blocks.length === 0) return "";
  return "=== ATTACHED FILE CONTEXT ===\n\n" + blocks.join("\n\n") + "\n\n=== END FILE CONTEXT ===\n\n";
}

function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
      const relPath = rel ? path.join(rel, name) : name;
      const absPath = path.join(dir, relPath);
      const st = fs.statSync(absPath);
      if (st.isDirectory()) walk(relPath);
      else out.push({ path: relPath, bytes: st.size });
    }
  };
  try { walk(""); } catch {}
  return out;
}

/**
 * Resolve the working directory a CLI (edit_exists) agent runs in.
 *
 *  - options.cwd given  → the caller owns an existing directory (e.g. a git
 *    worktree). We run the agent IN it and mark it `external` so the caller is
 *    responsible for its lifecycle — we never create or delete it, and we do
 *    NOT enumerate it wholesale (see listChangedFiles vs listFiles).
 *  - options.cwd absent → a fresh temp dir per call, isolated and collectable.
 *
 * Throws a clear error when a supplied cwd is missing or is not a directory,
 * so a caller typo fails loudly instead of silently editing the wrong place.
 */
// Every temp-directory prefix this package creates. Kept in one place because
// the sweep below must never delete anything it did not make: an unrecognised
// prefix in the OS temp dir belongs to somebody else.
export const TEMP_DIR_PREFIXES = [
  "ea-gen-",                 // runGenerate: the generated file
  "ea-dispatch-",            // runDispatch: a CLI's working directory
  "ea-probe-ro-",            // probeReadOnlyNonWriting: the canary
  "external-agents-aider-",  // buildAiderArgs: aider's chat history
];

// Three days. The disk cost is trivial — measured at 9 MB across 2446
// directories — so this is not really about space. The `ea-gen-*` directories
// hold `generated.md`: the model's complete response, in plain text. On a
// machine used for code review that is the reviewed source and the review
// itself, sitting unencrypted in the OS temp directory until the system gets
// round to reclaiming it, which on macOS took about a month.
export const DEFAULT_TEMP_RETENTION_DAYS = 3;

// A negative window (or a value that is not a number at all, e.g. a typo in the
// environment variable) disables the sweep rather than being coerced into
// something destructive.
//
// Small windows, including zero, are honoured — but never past MIN_TEMP_AGE_MS.
// The floor that makes "a dispatch running right now cannot lose its workdir"
// true for EVERY window rather than only for sensible ones.
//
// Raised in review, and the concrete footgun is worse than "somebody types 0":
// the window is read as `Number(process.env.X || DEFAULT)`, and while an empty
// string falls through to the default, a string of SPACES does not — `" "` is
// truthy, `Number(" ")` is 0, and the cutoff becomes `now`. A stray space in a
// shell export would then sweep the workdir of a dispatch that started a
// moment ago.
//
// Two ways to fix that. Ban zero, which is what review proposed, or keep the
// window honest and refuse to delete anything recent whatever the window says.
// The second states the property we actually want — nothing that could still be
// in use is removed — and it keeps an aggressive window usable for someone who
// deliberately wants one.
export const MIN_TEMP_AGE_MS = 15 * 60_000;

/**
 * Remove this package's stale temp directories.
 *
 * Deliberately conservative, because it deletes recursively:
 *   - only direct children of the temp directory, never a nested walk;
 *   - only names carrying one of OUR prefixes;
 *   - only real directories — a symlink is skipped, never followed, so a
 *     planted link cannot redirect the delete somewhere else;
 *   - only entries older than the retention window, so a dispatch running right
 *     now cannot have its workdir pulled out from under it.
 *
 * Never throws: this is housekeeping attached to another command, and a
 * permission error on one stray directory must not fail that command.
 */
export function sweepDispatchTemp(options = {}) {
  const days = options.maxAgeDays ?? Number(
    process.env.EXTERNAL_AGENTS_TEMP_RETENTION_DAYS || DEFAULT_TEMP_RETENTION_DAYS,
  );
  const result = { removed: 0, bytes: 0, failed: 0, retention_days: days };
  if (!Number.isFinite(days) || days < 0) return result;

  const root = options.tmpDir || os.tmpdir();
  const now = options.now ?? Date.now();
  // Whichever is EARLIER: the configured window, or the minimum age floor.
  // An entry must be older than both to qualify.
  const cutoff = Math.min(now - days * 86400_000, now - MIN_TEMP_AGE_MS);

  let entries;
  let rootDev;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
    rootDev = fs.statSync(root).dev;
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!TEMP_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const full = path.join(root, entry.name);
    // Defence in depth, not a fix for a live hole: review argued that a name
    // like `ea-gen-../escape` would let path.join out of the temp directory,
    // and it cannot — a directory entry name is incapable of containing a path
    // separator, so readdir can never return one (verified: `mkdir
    // "ea-gen-../escape"` fails with ENOENT). The check stays anyway because
    // this is the only recursive delete in the package, and an invariant worth
    // relying on is worth stating where the delete happens rather than leaving
    // a reader to recall a POSIX guarantee.
    if (path.dirname(path.resolve(full)) !== path.resolve(root)) continue;
    try {
      // lstat, not stat: a symlink must be identified as a symlink and skipped
      // rather than resolved to whatever it points at.
      const st = fs.lstatSync(full);
      if (!st.isDirectory()) continue;
      // A different device means a different filesystem is mounted here, and
      // whatever is on it was not put there by us. `rmSync` does not stop at a
      // mount boundary, so without this the sweep would recurse into it.
      //
      // Raised in review as a bind-mount attack, which it is not in any useful
      // sense: bind mounts need root on Linux and do not exist on macOS at all,
      // and an attacker holding root does not need this function. The check
      // earns its place on the accident instead — anything mounted under the
      // temp directory whose name happens to match a prefix — and it costs one
      // stat of the root plus a field comparison.
      if (rootDev != null && st.dev !== rootDev) continue;
      if (st.mtimeMs >= cutoff) continue;
      result.bytes += dirSizeBytes(full);
      // There is a window between the checks above and this delete, and Node
      // offers no "remove only if unchanged". Raised in review and left as is:
      // closing it would need an fd-relative unlink API that does not exist
      // here, while the exposure is already narrow — every name comes from
      // mkdtemp, so it is unique and never reused, and the minimum-age floor
      // means nothing recent enough to be replaced mid-sweep is eligible.
      fs.rmSync(full, { recursive: true, force: true });
      result.removed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

// Best-effort size, for reporting only. A directory that vanishes mid-walk (a
// concurrent sweep, the OS reclaiming it) contributes nothing rather than
// throwing.
//
// Symlink-safe without needing an explicit check, which review asked about: a
// Dirent reflects lstat, so `isDirectory()` and `isFile()` are BOTH false for a
// symlink — including one pointing at its own ancestor. Neither branch is taken
// and the walk cannot loop or leave the tree. Pinned by a test, because that is
// a property of Dirent rather than of anything written here.
function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch { /* gone */ }
  }
  return total;
}

export function resolveDispatchWorkdir(agentId, options = {}) {
  if (options.cwd != null && options.cwd !== "") {
    const cwd = String(options.cwd);
    let st;
    try {
      st = fs.statSync(cwd);
    } catch {
      throw new Error(`runDispatch: cwd does not exist: ${cwd}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`runDispatch: cwd is not a directory: ${cwd}`);
    }
    return { workdir: path.resolve(cwd), external: true };
  }
  return {
    workdir: fs.mkdtempSync(path.join(os.tmpdir(), `ea-dispatch-${agentId}-`)),
    external: false,
  };
}

/**
 * Parse `git status --porcelain` (v1) output into {path, status} entries.
 * Status is the leading 2-char code; for renames ("R  old -> new") the NEW
 * path is reported. Best-effort: quoted/escaped exotic paths are passed
 * through as-is.
 */
export function parseGitPorcelain(text) {
  const files = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const p = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    files.push({ path: p, status });
  }
  return files;
}

/**
 * List files an agent changed in an EXTERNAL cwd, via git. Enumerating the
 * whole tree (listFiles) would return the entire repo/worktree; the diff is
 * what the caller actually wants. Returns [] when cwd is not a git repo or git
 * is unavailable.
 */
export function listChangedFiles(cwd) {
  try {
    const res = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf-8" });
    if (res.status !== 0 || typeof res.stdout !== "string") return [];
    return parseGitPorcelain(res.stdout);
  } catch {
    return [];
  }
}

/**
 * sha256 of a file's bytes, or null when it cannot be read (a deletion, or a
 * path that is a directory). Used only to compare one file against itself
 * across a dispatch, so the algorithm choice is immaterial.
 */
function fileHash(abs) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Snapshot of a worktree's dirty state, taken BEFORE a dispatch spawns, so the
 * changes that dispatch made can later be told apart from the ones the caller
 * already had.
 *
 * WHY the hash and not just the porcelain status — a file that was ALREADY
 * modified before the dispatch keeps status `M` when it is modified again, so
 * a path+status comparison cannot see the second edit. Only baseline-dirty
 * files are hashed, and this repo's own rules say a dispatch starts from a
 * clean worktree, so in practice that is nothing.
 *
 * `git status --porcelain` reports paths relative to the REPOSITORY ROOT
 * regardless of the cwd it runs from, so every path here is root-relative.
 */
export function scopeBaseline(cwd) {
  const gitRoot = realpathOrSelf(findGitRoot(cwd));
  if (!gitRoot) return [];
  return listChangedFiles(cwd).map(({ path: rel, status }) => ({
    path: rel,
    status,
    hash: fileHash(path.join(gitRoot, rel)),
  }));
}

/**
 * The changes a dispatch made that it was never authorised to make.
 *
 * WHY this exists — aider's own write guard cannot be closed from the outside.
 * `allowed_to_edit()` (base_coder.py:2190) lets the model write a path that was
 * never declared: an existing one goes through
 * `confirm_ask("Allow edits to file that has not been added to the chat?")`
 * (~2225) and a missing one through `confirm_ask("Create new file?")` (~2208),
 * and `--yes-always` answers YES to both because neither call sets
 * `explicit_yes_required`. That guard consults only `git_ignored_file()`
 * (gitignore) and never `ignored_file()`, so the .aiderignore scope allowlist
 * that closes the READ side has no effect here. Proven by driving aider's API
 * directly: with the allowlist active and nothing addable,
 * `allowed_to_edit('undeclared.js')` still returned True and
 * `allowed_to_edit('invented/new.js')` created the file on disk.
 *
 * Dropping `--yes-always` is not an alternative: `io.confirm_ask` falls back to
 * `res = default` on the EOFError that non-tty stdin raises, and both prompts
 * default to yes.
 *
 * So the containment has to be checked after the fact, here. A post-run entry
 * counts as out of scope when it is not one of the declared paths AND it
 * differs from the baseline — unseen before, a changed status, or the same
 * status over different bytes.
 *
 * `declaredRelPaths` is a Set of repo-root-relative POSIX paths, the same basis
 * porcelain reports in.
 */
export function outOfScopeChanges(baseline, post, declaredRelPaths, cwd) {
  const gitRoot = realpathOrSelf(findGitRoot(cwd));
  if (!gitRoot) return [];

  const byPath = new Map(baseline.map((entry) => [entry.path, entry]));
  const out = [];
  for (const entry of post) {
    if (declaredRelPaths.has(entry.path)) continue;
    const before = byPath.get(entry.path);
    if (!before) {
      out.push(entry);
    } else if (before.status !== entry.status) {
      out.push(entry);
    } else if (before.hash !== fileHash(path.join(gitRoot, entry.path))) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * The declared `--file` list as repo-root-relative POSIX paths — the basis
 * `git status --porcelain` reports in, so the two can be compared directly.
 *
 * Resolution mirrors buildAiderArgs (absolute stays, relative resolves against
 * the dispatch cwd) and then realpath-normalises both sides, because comparing
 * a resolved git root against unresolved file paths is exactly what made the
 * allowlist silently fail open on macOS.
 */
export function declaredRepoRelPaths(workdir, files) {
  const out = new Set();
  const gitRoot = realpathOrSelf(findGitRoot(workdir));
  if (!gitRoot) return out;
  for (const entry of files ?? []) {
    if (!entry || typeof entry.path !== "string") continue;
    const abs = realpathOrSelf(
      path.isAbsolute(entry.path) ? entry.path : path.resolve(workdir, entry.path),
    );
    out.add(path.relative(gitRoot, abs).split(path.sep).join("/"));
  }
  return out;
}

/**
 * Why a run that otherwise succeeded is being failed, for the telemetry
 * preview. Caps the list so one runaway dispatch cannot write an unbounded
 * line into the log.
 */
export function outOfScopeReason(outOfScope) {
  if (!outOfScope?.length) return null;
  const names = outOfScope.map((entry) => entry.path);
  const shown = names.slice(0, 10);
  const more = names.length - shown.length;
  return `changed ${names.length} file(s) outside the declared --file scope: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

const EXHAUSTION_RE = /quota|rate.?limit|429|too many requests|insufficient balance|resource[ _]?exhausted|usage limit|credits exhausted|(?:agent|request) limit (?:has been )?reached|you(?:'|’)?ve (?:reached|hit).{0,60}(?:limit|quota)/i;
const CONTEXT_WINDOW_RE = /prompt too long|max context length|context length exceeded|ContextWindowExceeded|context window exceeded|too many tokens|input is too long|request is too large/i;

// Known-benign stderr noise that carries no diagnostic value but tends to
// land at the very end of a CLI's output — exactly where the error preview
// slice looks (see errorPreview below). Confirmed source for the ollama line:
// aider's litellm `ollama_chat` backend shells out to `ollama show <model>`
// for context-window auto-detection, inheriting the parent's stdin:"ignore",
// so it always prints this warning whether or not the dispatch itself failed.
// Stripped only from the preview text, never from the raw stored stderr, so
// the underlying log is untouched — this only stops the noise from burying
// the real failure reason in the last-400-chars slice.
const BENIGN_STDERR_LINE_RE = /^\s*Warning: Input is not a terminal \(fd=\d+\)\.?\s*$/im;

export function stripBenignStderrNoise(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => !BENIGN_STDERR_LINE_RE.test(line))
    .join("\n");
}

export function stripAnsi(text) {
  return String(text ?? "")
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><~])/g, "")
    .replace(/\u001B[\]\^_].*?(?:\u0007|\u001B\\)/gs, "");
}

// Concurrent dispatches each add temporary parent-signal listeners.
function reserveProcessSignalListenerSlots(count) {
  const current = process.getMaxListeners();
  if (current === 0) return () => {};
  process.setMaxListeners(current + count);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = process.getMaxListeners();
    if (now !== 0) process.setMaxListeners(Math.max(0, now - count));
  };
}

export function classifyCliFailure(text) {
  const preview = stripAnsi(text);
  const isContextWindowFailure = CONTEXT_WINDOW_RE.test(preview);
  return {
    needsAuth: /not logged in|please run \/login|authorizationrequired|authentication failed|unauthenticated|401 unauthorized|please (?:sign |log )?in to use (?:cursor(?: agent)?)|cursor(?: agent)?.{0,80}(?:sign|log) in|please authenticate|no authentication token/i.test(preview),
    // "Individual quota reached" is Antigravity CLI's (agy) own wording —
    // distinct from "quota exhausted"/"agent limit reached" already covered
    // below, so it needs its own alternative or agy's 429s misclassify as
    // errored_transient (no reset_at recorded, no cooldown skip in pick()).
    // Scoped to "individual quota reached" specifically (not a bare "quota
    // reached") per consensus review: a generic pattern risks misclassifying
    // an unrelated future provider message that merely contains that
    // substring, e.g. "monthly quota reached its cap" from a paid plan.
    quotaExhausted: !isContextWindowFailure &&
      /monthly.{0,20}(request )?limit reached|usage limit|quota exhausted|individual quota reached|hit your usage limit|(?:agent|request) limit (?:has been )?reached|you(?:'|’)?ve (?:reached|hit).{0,60}(?:limit|quota)|rate.?limit|too many requests/i.test(preview),
  };
}

export function parseExhaustionSignal(text) {
  const detected = EXHAUSTION_RE.test(text) && !CONTEXT_WINDOW_RE.test(text);

  let reset_at;
  if (detected) {
    const m1 = text.match(/Resets in (\d+)h(?:(\d+)m)?/i);
    if (m1) {
      const h = parseInt(m1[1], 10);
      const m = m1[2] ? parseInt(m1[2], 10) : 0;
      reset_at = Math.floor(Date.now() / 1000) + h * 3600 + m * 60;
    }

    if (reset_at === undefined) {
      const m2 = text.match(/Retry-After:\s*(\d+)/i);
      if (m2) {
        reset_at = Math.floor(Date.now() / 1000) + parseInt(m2[1], 10);
      }
    }

    if (reset_at === undefined) {
      const m3 = text.match(/reset in (\d+) seconds/i);
      if (m3) {
        reset_at = Math.floor(Date.now() / 1000) + parseInt(m3[1], 10);
      }
    }
  }

  return { detected, reset_at };
}

export function classifyDispatchFailure(text) {
  const cliFailure = classifyCliFailure(text);
  const exhaustionSignal = parseExhaustionSignal(text);
  return {
    cliFailure,
    exhaustionSignal,
    isExhaustion: !!exhaustionSignal.detected || cliFailure.quotaExhausted,
  };
}

/**
 * A one-line answer to "why did this fail", for the sidecar log's `reason`.
 *
 * Not a classification — `classification` on the same record carries that. This
 * is the line a human scanning the file wants to read first, so it prefers the
 * structured facts we are sure of (a spawn errno, an HTTP status, a timeout)
 * and only falls back to guessing at output when there is nothing better. The
 * full text is right there in `raw`, so this never has to be complete.
 */
export function firstFailureReason(result) {
  if (result?.spawnError?.code) {
    return `could not execute the command: ${result.spawnError.code} (${result.spawnError.message})`;
  }
  if (result?.exitCode === 124 || result?.timedOut) return "timed out waiting for the agent to finish";
  if (result?.networkError?.code) return `network error: ${result.networkError.code}`;
  if (result?.status && result.status >= 400) {
    return `HTTP ${result.status}` + (result.modelUnavailable ? " — provider says the model does not exist" : "");
  }
  // stderr first and separately, not concatenated with stdout: a CLI that
  // prints a banner to stdout and its exception to stderr would otherwise have
  // the banner win, because it is the last line of the joined text. The error
  // stream is where the error is; stdout is only the fallback for the CLIs
  // that print everything there.
  const line = _lastMeaningfulLine(stripAnsi(result?.stderr || ""))
    || _lastMeaningfulLine(stripAnsi(result?.output || ""));
  if (line) return line.slice(0, 300);
  return `exit ${result?.exitCode ?? "?"} with no output`;
}

export function emitPromptSizeWarning(prompt, progress) {
  if (typeof progress !== "function") return;
  const bytes = Buffer.byteLength(prompt || "", "utf-8");
  let threshold;
  if (bytes > 65536) threshold = 65536;
  else if (bytes > 49152) threshold = 49152;
  else if (bytes > 32768) threshold = 32768;
  if (!threshold) return;

  progress(
    `dispatch: WARNING — prompt size ${bytes} bytes exceeds ${threshold} bytes`,
    { type: "prompt_size", bytes, threshold },
  );
}

export function isAiderCommand(tokens) {
  return tokens[0] === "aider";
}

/**
 * `env_from: { TARGET: SOURCE }` — copy the credential in `SOURCE` into the
 * child's `TARGET`, for CLIs that hard-code the env var name they read.
 *
 * This is what makes a provider's 2nd, 3rd, Nth key usable on a CLI transport.
 * `add_provider_key` clones a provider into numbered siblings whose credential
 * lands in a derived name (`GEMINI_API_KEY` → `GEMINI_API_KEY_2` → `_3` …).
 * An HTTP transport reads that name straight from the entry, but aider takes
 * its key name from LiteLLM's fixed table and will only ever look at
 * `GEMINI_API_KEY` — so every sibling past the first silently authenticated as
 * the FIRST key, or not at all. Naming the mapping in the registry fixes that
 * without teaching the dispatcher any provider-specific rules.
 *
 * Values are read through resolveAgentEnv, so a per-entry `env:` override and
 * `@file:~/...` refs work here too. A source that resolves to nothing is
 * skipped rather than exported empty: an unset variable makes the CLI report
 * its own "no credential" error, while an empty one makes it send `Bearer ` and
 * get an opaque 401.
 */
export function resolveEnvFrom(envFrom, agentEntry) {
  if (!envFrom || typeof envFrom !== "object") return {};
  const out = {};
  for (const [target, source] of Object.entries(envFrom)) {
    if (typeof source !== "string") continue;
    const value = resolveAgentEnv(agentEntry, source);
    if (typeof value === "string" && value !== "") out[target] = value;
  }
  return out;
}

/**
 * Flags that make aider safe to spawn from a dispatcher. Every one of these
 * fixes a failure observed in the pre-0.33.4 aider lane, so none is cosmetic:
 *
 *   --yes-always            the 0.86 spelling; bare `--yes` is gone, and
 *                           without it aider blocks on its first confirmation.
 *   --no-auto-commits       aider otherwise commits on the caller's branch.
 *   --no-dirty-commits      ... and commits the caller's unrelated work too.
 *   --no-gitignore          aider appends `.aider*` to the repo's .gitignore
 *                           unasked, which dirties a worktree that the caller
 *                           is required to hand back clean.
 *   --no-check-update       network call on every spawn.
 *   --no-analytics          no telemetry from a dispatched worker.
 *   --no-show-model-warnings  unknown-model warnings are a prompt in disguise.
 *   --no-stream             ANSI spinner frames corrupt captured stdout.
 *   --map-tokens 0          disables the repo map. On a 1.5k-file repo the
 *                           initial scan costs ~15s and ~9k tokens of prompt
 *                           per dispatch; with explicit file arguments the map
 *                           buys nothing, and it is what writes the
 *                           `.aider.tags.cache.v4/` directory into cwd.
 *
 * NOT included: `--no-git`. The old lane passed it, and that alone is why the
 * lane never worked — with git disabled and no file arguments, aider starts
 * with an empty chat ("I am not sharing any files that you can edit yet"), so
 * the model can only ask for the file contents back. Every such dispatch
 * exited 0 having changed nothing.
 */
const AIDER_HEADLESS_FLAGS = [
  "--yes-always",
  "--no-auto-commits",
  "--no-dirty-commits",
  "--no-gitignore",
  "--no-check-update",
  "--no-analytics",
  "--no-show-model-warnings",
  "--no-stream",
  "--map-tokens", "0",
  // aider's `offer_url` asks "Open documentation url for more info?" on a
  // model warning, a missing key, a quota error or a version bump — and
  // `--yes-always` answers YES, so a dispatched worker pops browser tabs on
  // the operator's desktop. These two flags remove the release-notes and
  // URL-detection prompts; AIDER_BROWSER_ENV below neutralises the rest.
  "--no-show-release-notes",
  "--no-detect-urls",
];

/**
 * Python's `webbrowser` module treats $BROWSER as the command to launch, so
 * pointing it at `true` turns every remaining `webbrowser.open()` inside aider
 * into a no-op. Belt to AIDER_HEADLESS_FLAGS' braces: the flags remove the
 * prompts we know about, this removes the ability to open a tab at all.
 */
const AIDER_BROWSER_ENV = { BROWSER: "true" };

/**
 * realpath that tolerates a path which does not exist yet — a declared file
 * aider is being asked to create resolves only as far as its parent directory.
 * Returns the input unchanged when nothing can be resolved, so callers can
 * always compare like with like.
 */
function realpathOrSelf(p) {
  if (!p) return p;
  try {
    return fs.realpathSync(p);
  } catch { /* not on disk yet — fall through to resolving the parent */ }
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return p;
  }
}

/**
 * Walks up from `startDir` looking for the git root — the first ancestor that
 * contains a `.git` entry. A worktree's `.git` is a FILE, not a directory, so
 * both count.
 */
function findGitRoot(startDir) {
  let cur = path.resolve(startDir);
  const stop = path.parse(cur).root;
  for (;;) {
    try {
      fs.statSync(path.join(cur, ".git"));
      return cur;
    } catch { /* keep walking */ }
    if (cur === stop) return null;
    cur = path.dirname(cur);
  }
}

/**
 * Escapes the gitignore glob metacharacters so a pattern matches a filename
 * literally. A trailing space is also escaped — gitignore strips unescaped
 * trailing whitespace.
 */
function escapeGitignoreGlob(rel) {
  return rel.replace(/[\\*?[\]]/g, (ch) => `\\${ch}`).replace(/ $/, "\\ ");
}

/**
 * Writes a temp `.aiderignore` that narrows aider's view of the repo to exactly
 * the files the caller declared, and returns its path (or null when no ignore
 * file should be passed).
 *
 * WHY this exists — aider attaches files nobody asked for. Its
 * `preproc_user_input()` (base_coder.py:917) runs `check_for_file_mentions()`
 * over our own `--message` prompt before the first request. That scan
 * (base_coder.py:1714) tokenises the prompt on whitespace and matches every
 * word against the ENTIRE git-tracked file list, on a full relative path OR on
 * a BARE BASENAME whose only guard is containing one of `/ \ . _ -` — so every
 * `foo.js` or `AGENTS.md` named in a prompt qualifies. Each hit goes to
 * `confirm_ask("Add file to the chat?")`, which our `--yes-always` answers YES,
 * and the whole file is attached. It runs again on the model's reply
 * (base_coder.py:1561), so it compounds per round. aider has no flag to turn
 * this off.
 *
 * Two failures observed live, both reproduced deterministically:
 *   - context blow-up: one dispatch went from a 131k model limit to 594k tokens
 *     and failed every litellm retry;
 *   - undisclosed egress: a file that was never passed had its full contents,
 *     including a secret, sent to a third-party provider.
 *
 * Neither existing guard can stop it. `--map-tokens 0` disables the repo MAP,
 * which is a different code path. MAX_TOTAL_FILE_BYTES accounts only for the
 * files WE pass, so auto-attached files never enter that accounting — which is
 * why capping our own list did not close this.
 *
 * How the ignore file works:
 *   `*`   empties aider's tracked-file list (repo.py:486 filters
 *         get_tracked_files() through ignored_file()), so
 *         get_addable_relative_files() is empty and no mention can resolve.
 *   `!/…` negations are MANDATORY, not decoration: base_coder.py:455 gates
 *         explicitly-passed files through ignored_file() too, so without them
 *         aider silently drops the caller's files and exits 0 having changed
 *         nothing — the exact pre-0.33.4 failure this lane was fixed for.
 *
 * Paths are git-root-relative because repo.normalize_path() (repo.py:496)
 * matches the pathspec against paths relative to the git root, not to the
 * dispatch cwd — verified from a subdirectory. The leading `/` anchors each
 * negation to one exact path; a bare `foo.js` would re-include every
 * same-named file at any depth.
 *
 * This cannot block the caller's own edits: allowed_to_edit()
 * (base_coder.py:2190) returns True for files already in the chat BEFORE any
 * ignore check, and consults only git_ignored_file(), never ignored_file().
 */
export function buildAiderIgnoreFile(workdir, absFiles, historyDir) {
  // No git root means no tracked-file list, so the mention scan has nothing to
  // match against and the bug cannot fire. Pass nothing.
  const gitRoot = realpathOrSelf(findGitRoot(workdir));
  if (!gitRoot) return null;

  // Both sides of the containment test must be realpath-resolved or it reports
  // a false "outside the repo" and silently drops the protection. macOS makes
  // this the common case, not an exotic one: os.tmpdir() hands back
  // `/var/folders/…`, a symlink to `/private/var/folders/…`, so a caller whose
  // cwd came from process.cwd() (already resolved) and whose --file paths were
  // built from os.tmpdir() (not) would disagree on every path.
  const resolved = absFiles.map(realpathOrSelf);

  // A path outside the git root cannot be expressed as a negation relative to
  // it. Fail OPEN rather than write an ignore file that would silently drop
  // that file from the chat — but say so, because a silent fail-open here
  // means the caller believes it has scope containment when it does not.
  for (const abs of resolved) {
    if (abs !== gitRoot && !abs.startsWith(gitRoot + path.sep)) {
      console.error(
        `external-agents: ${abs} is outside the git root ${gitRoot}; skipping the aider scope allowlist, so aider may attach undeclared repo files to this request.`,
      );
      return null;
    }
  }

  const lines = ["*"];
  for (const abs of resolved) {
    const rel = path.relative(gitRoot, abs).split(path.sep).join("/");
    lines.push(`!/${escapeGitignoreGlob(rel)}`);
  }

  // Passing --aiderignore REPLACES the repo's own .aiderignore, so a repo that
  // says "never let an agent touch secrets.env" would have that policy silently
  // overridden the moment a caller declared that path — verified: the file was
  // added to the chat and its contents reached the provider, where before this
  // change aider refused it. The repo's rules go LAST because in gitignore the
  // later pattern wins, so they can veto one of our negations.
  //
  // Only its non-negation patterns are carried over. A `!` line from the repo
  // could only ever WIDEN what is visible, and widening is exactly what this
  // file exists to prevent — our baseline already ignores everything, so a repo
  // negation adds nothing but risk.
  for (const raw of readRepoAiderIgnore(gitRoot)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    lines.push(line);
  }

  const ignorePath = path.join(historyDir, ".aiderignore");
  fs.writeFileSync(ignorePath, `${lines.join("\n")}\n`);
  return ignorePath;
}

/**
 * The repo's own `.aiderignore` rules, or [] when it has none. Read from the git
 * root because that is where aider's own default looks (args.py:422).
 */
function readRepoAiderIgnore(gitRoot) {
  try {
    return fs.readFileSync(path.join(gitRoot, ".aiderignore"), "utf-8").split("\n");
  } catch {
    return [];
  }
}

/**
 * aider takes the prompt via `--message`, not as a positional — a positional
 * is read as a FILENAME to add to the chat. It also needs the files it may
 * edit named up front: unlike codex or cursor-agent it has no search tool, so
 * anything not in the chat is invisible to it and it will invent a new file
 * instead of editing the existing one.
 *
 * `options.files` (the dispatcher's `--file` flag) therefore does double duty
 * on this transport: runAny still inlines the contents into the prompt for
 * every other transport, but here the paths are also handed to aider so its
 * SEARCH/REPLACE edits land on the real files.
 *
 * History files are redirected into a temp dir. Left at their defaults aider
 * writes `.aider.chat.history.md` and `.aider.input.history` into cwd, which
 * is the "local aider junk" that a caller then has to clean out of a worktree.
 */
export function buildAiderArgs(parts, effortParts, prompt, workdir, options = {}) {
  // `--file` is documented as OPTIONAL for edit_exists (see cli.js usage)
  // because a direct CLI can search the --cwd itself. aider is the one entry
  // for which that is false: it has no search tool, so a file not named up
  // front is invisible to it.
  //
  // Until the scope allowlist above, aider papered over this by scraping
  // filenames out of the prompt — the very defect that allowlist closes. With
  // the allowlist in place a no-files aider dispatch can only start with an
  // empty chat and exit 0 having changed nothing, which is exactly the silent
  // failure the pre-0.33.4 lane was retired for. Refuse up front instead, the
  // same way the aggregate byte cap below refuses rather than degrading: a
  // caller that wants a file created should declare its path, which aider
  // touches into existence without a confirmation.
  if (!(options.files?.length > 0)) {
    throw new Error(
      "buildAiderArgs: aider needs at least one --file. It has no search tool, so with no declared files it starts with an empty chat and exits 0 having changed nothing. Declare the files it may edit (a path that does not exist yet is created).",
    );
  }

  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-agents-aider-"));
  const fileArgs = [];
  let totalBytes = 0;
  for (const entry of options.files ?? []) {
    if (!entry || typeof entry.path !== "string") continue;
    const abs = path.isAbsolute(entry.path) ? entry.path : path.resolve(workdir, entry.path);
    // A range like `foo.ts:10-50` is a prompt-context hint; aider always takes
    // the whole file. Attach it once, whole.
    if (!fileArgs.includes(abs)) {
      fileArgs.push(abs);
      // aider reads these files itself (we only pass paths, not content), and
      // unlike resolveFileContext there is no per-file or aggregate cap here
      // at all — confirmed live: ~25 individually-small files pushed one
      // dispatch from ~131k to ~594k tokens, and the provider silently
      // truncated instead of erroring, so the resulting "success" was
      // actually a response to a request the model never fully saw. Refuse
      // up front instead of degrading silently: aider needs every file it
      // might edit visible in the chat (it has no search tool), so dropping
      // some rather than erroring would just fail differently and more
      // confusingly later.
      try {
        totalBytes += fs.statSync(abs).size;
      } catch { /* unreadable path — let aider itself report that */ }
      if (totalBytes > MAX_TOTAL_FILE_BYTES) {
        throw new Error(
          `buildAiderArgs: attached files total ${totalBytes} bytes, over the ${MAX_TOTAL_FILE_BYTES} byte aggregate cap — aider would silently receive a truncated view of a request this large instead of erroring. Trim the file list.`,
        );
      }
    }
  }
  // Narrow aider's view of the repo to exactly `fileArgs` before it ever sees
  // the prompt — see buildAiderIgnoreFile for why this is not optional.
  const aiderIgnorePath = buildAiderIgnoreFile(workdir, fileArgs, historyDir);

  return [
    ...parts.slice(1),
    ...effortParts,
    ...AIDER_HEADLESS_FLAGS,
    "--chat-history-file", path.join(historyDir, "chat.md"),
    "--input-history-file", path.join(historyDir, "input.txt"),
    ...(aiderIgnorePath ? ["--aiderignore", aiderIgnorePath] : []),
    "--message", prompt,
    ...fileArgs,
  ];
}

/**
 * aider exits 0 even when the provider call failed outright — a 429 from
 * Gemini prints `litellm.RateLimitError` to stdout and the process still
 * returns 0 with nothing edited. Reported verbatim that is the exact
 * silent-success failure the read_only axis was introduced to stop, so a run
 * that changed no file AND printed a provider error is re-coded as a failure.
 *
 * Deliberately narrow: a run that changed nothing and printed no error is left
 * alone, because "the prompt asked a question" is a legitimate zero-diff
 * outcome that the caller should see as success.
 */
const AIDER_PROVIDER_ERROR_RE = /litellm\.\w*Error|RateLimitError|AuthenticationError|BadRequestError|APIConnectionError|ContextWindowExceeded/i;

export function aiderExitCode(code, isAider, stdout, stderr, files) {
  if (!isAider || code !== 0) return code;
  if (files.length > 0) return code;
  // Both streams: aider prints litellm's exception to stdout in the runs
  // observed here, but nothing guarantees that — LiteLLM and its provider
  // SDKs log to stderr in other paths, and a diagnosis the classifier can
  // already read off stderr must not be invisible to the exit code.
  return AIDER_PROVIDER_ERROR_RE.test(stdout) || AIDER_PROVIDER_ERROR_RE.test(stderr) ? 1 : code;
}

/**
 * A CLI dispatch exists to return text or to change files. `kiro` exits 0
 * having done neither — reported verbatim that is `outcome: success` for work
 * that never happened, the same silent-success class the read_only axis was
 * introduced to stop.
 *
 * Applies to every CLI transport, not just aider.
 *
 * Only STDOUT counts as "the agent answered", and that asymmetry is deliberate
 * rather than an oversight: `result.output` — the value every caller reads as
 * the agent's reply — is stdout. A run whose stdout is empty has returned
 * nothing usable no matter how much it wrote to stderr. kiro is exactly that
 * shape: its "Monthly request limit reached" notice goes to stderr, stdout
 * stays empty.
 *
 * stderr still decides WHY it failed, not WHETHER: it is passed through so the
 * distinction between a diagnosed failure (a quota notice the classifier can
 * name) and a silent one (nothing on either stream) is visible here and in the
 * returned reason, instead of both collapsing into a bare exit 1.
 *
 * Whitespace-only output counts as empty; any real answer, however short, is
 * left alone, because "no" is a legitimate reply.
 */
export function emptyRunExitCode(code, stdout, stderr, files) {
  if (code !== 0) return code;
  if (files.length > 0) return code;
  if (stdout.trim() !== "") return code;
  return 1;
}

/**
 * Why an otherwise-successful run is being re-coded as a failure, for the
 * telemetry preview. `runAny` only captures a preview on failure, and for
 * these runs the usual source (the tail of stderr) is often empty too.
 */
export function emptyRunReason(stdout, stderr, files) {
  if (files.length > 0 || stdout.trim() !== "") return null;
  return stderr.trim() !== ""
    ? "exited 0 with no output and no file changes; see stderr"
    : "exited 0 with no output, no file changes, and nothing on stderr";
}

export function runDispatch(agentEntry, prompt, options = {}, transportKind = "edit_exists") {
  const timeoutMs = options.timeoutMs ?? Number(process.env.EXTERNAL_AGENTS_TIMEOUT_MS || 500000);
  const cliTransport = getTransportConfig(agentEntry, transportKind);
  const cliCmd = cliTransport?.cmd;
  if (!cliCmd || typeof cliCmd !== "string") {
    throw new Error(`runDispatch: no ${transportKind} transport for ${agentEntry.id}`);
  }

  const parts = cliCmd.trim().split(/\s+/);
  const cmd = parts[0];
  if (isAiderCommand(parts) && transportKind !== "edit_exists") {
    throw new Error(
      `runDispatch: aider has no ${transportKind} mode; it can only edit in place`,
    );
  }
  const effortFlag = options.effort && cliTransport?.effort_flag
    ? cliTransport.effort_flag.replace("{level}", options.effort)
    : null;
  const effortParts = effortFlag ? effortFlag.trim().split(/\s+/) : [];

  // Where the agent runs: a caller-supplied cwd (e.g. a git worktree, edited
  // in place) or a fresh isolated temp dir. Throws on a bad cwd before spawn.
  const { workdir, external } = resolveDispatchWorkdir(agentEntry.id, options);

  // aider can write outside the files it was given (see outOfScopeChanges for
  // why that cannot be prevented, only detected). Snapshot the worktree's
  // existing dirt BEFORE the child runs, so the caller's own uncommitted work
  // is never mistaken for something the dispatch did.
  const writeScopeBaseline = isAiderCommand(parts) && external ? scopeBaseline(workdir) : null;

  // Some CLIs (e.g. agy) don't treat the OS-level spawn cwd as their working
  // directory/workspace — they need it named explicitly via a flag. cwd_flag
  // carries a `{cwd}` placeholder for that case; most entries omit it and
  // rely on `spawn`'s `cwd` option below like kiro/opencode/cursor-agent do.
  const cwdFlag = cliTransport?.cwd_flag
    ? cliTransport.cwd_flag.replace("{cwd}", workdir)
    : null;
  const cwdParts = cwdFlag ? cwdFlag.trim().split(/\s+/) : [];

  // Direct CLIs receive the prompt as a final positional argument and can
  // inspect cwd themselves. aider is the exception on both counts — see
  // buildAiderArgs. A second exception: agy's `--print`/`--prompt` is NOT a
  // bare boolean like claude's `--print` — it consumes the very next token as
  // its own value. Confirmed live: `agy --print --dangerously-skip-permissions
  // --model M --add-dir D "real prompt"` hands `--print` the LITERAL STRING
  // "--dangerously-skip-permissions" as its prompt (the model answers a
  // question about that flag, never seeing "real prompt" at all) — yet exits
  // 0, so the dispatch trailer reports success for a request the model never
  // received. `prompt_flag` (set on agy's registry entries, alongside
  // `cwd_flag`) names the flag that must sit immediately before the prompt
  // instead of it being a bare trailing positional.
  const promptFlagParts = cliTransport?.prompt_flag
    ? [cliTransport.prompt_flag]
    : [];
  const args = isAiderCommand(parts)
    ? buildAiderArgs(parts, effortParts, prompt, workdir, options)
    : [...parts.slice(1), ...effortParts, ...cwdParts, ...promptFlagParts, prompt];

  // Per-entry env overrides — applied ONLY to the subprocess, never to parent.
  const entryEnv = resolveEntryEnv(agentEntry.env);
  const aliasEnv = resolveEnvFrom(cliTransport?.env_from, agentEntry);
  const childEnv = isAiderCommand(parts)
    ? { ...process.env, ...AIDER_BROWSER_ENV, ...entryEnv, ...aliasEnv }
    : { ...process.env, ...entryEnv, ...aliasEnv };
  const progress = typeof options.progress === "function" ? options.progress : null;
  const heartbeatMs = options.heartbeatMs ?? 5000;

  // What was actually executed. Returned on every path (success included, so
  // the shape never depends on the outcome) because the single most common
  // cause of a puzzling CLI failure is the command line itself — a flag the
  // registry entry spells differently than this version of the tool expects,
  // a prompt that never reached the binary, a model id the CLI does not know.
  // The sidecar failure log is the only consumer today; it redacts before it
  // writes, so the prompt positional and any credential-bearing flag are
  // handled there rather than here.
  const commandDescriptor = {
    cmd,
    argv: args,
    cwd: workdir,
    external,
    transport_kind: transportKind,
    // Names only — never values. Which variables this child was handed is the
    // diagnostic fact ("it ran without GROQ_API_KEY set"); the contents are
    // exactly what must not land in a file meant to be pasted elsewhere.
    env_overrides: [...Object.keys(entryEnv || {}), ...Object.keys(aliasEnv || {})],
  };

  return new Promise((resolve) => {
    const start = Date.now();
    // stdio: ["ignore", "pipe", "pipe"] — close child stdin immediately.
    // Without this, CLIs like `claude --print` wait 3s for possible piped
    // input, then print "Warning: no stdin data received in 3s" which
    // pollutes stderr and shows up as an error_preview even on success.
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd: workdir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let parentSignal = null;
    let lastActivityAt = start;

    let timer;
    let heartbeat;
    let forceKillTimer;
    const terminate = (signal) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch { /* fall through to the direct child */ }
      }
      child.kill(signal);
    };
    const forceKillSoon = () => {
      if (!forceKillTimer) forceKillTimer = setTimeout(() => terminate("SIGKILL"), 2000);
    };
    const signalHandlers = [];
    const releaseSignalListenerSlots = reserveProcessSignalListenerSlots(2);
    const onParentSignal = (signal) => {
      if (parentSignal) return;
      parentSignal = signal;
      timedOut = true;
      stderr += `\ndispatch: received ${signal}; terminating child process group\n`;
      terminate("SIGTERM");
      forceKillSoon();
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => onParentSignal(signal);
      process.once(signal, handler);
      signalHandlers.push([signal, handler]);
    }
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      releaseSignalListenerSlots();
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceKillSoon();
    }, timeoutMs);
    heartbeat = progress
      ? setInterval(() => {
          if (Date.now() - lastActivityAt < heartbeatMs) return;
          progress(`dispatch: waiting for ${transportKind} response`, {
            type: "heartbeat",
            elapsedMs: Date.now() - start,
          });
        }, heartbeatMs)
      : null;

    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      lastActivityAt = Date.now();
      progress?.(chunk, { type: "stream", stream: "stdout" });
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      lastActivityAt = Date.now();
      progress?.(chunk, { type: "stream", stream: "stderr" });
    });

    child.on("close", (code) => {
      cleanup();
      const cleanStdout = stripAnsi(stdout);
      const cleanStderr = stripAnsi(stderr);
      // External cwd (worktree/repo): report only what changed via git, never
      // the whole tree. Temp cwd: enumerate everything the agent produced.
      const files = external ? listChangedFiles(workdir) : listFiles(workdir);
      const emptyReason = timedOut ? null : emptyRunReason(cleanStdout, cleanStderr, files);

      // Did aider write outside what it was given? Declared paths are made
      // repo-root-relative through the SAME realpath normalisation as the
      // allowlist — comparing a resolved root against unresolved --file paths
      // would make every declared file look out of scope and fail every run.
      const outOfScope = writeScopeBaseline
        ? outOfScopeChanges(
            writeScopeBaseline,
            files,
            declaredRepoRelPaths(workdir, options.files),
            workdir,
          )
        : [];
      const scopeReason = timedOut ? null : outOfScopeReason(outOfScope);

      const baseExitCode = timedOut
        ? 124
        : emptyRunExitCode(
            aiderExitCode(code, isAiderCommand(parts), cleanStdout, cleanStderr, files),
            cleanStdout,
            cleanStderr,
            files,
          );

      resolve({
        command: commandDescriptor,
        timedOut,
        output: cleanStdout,
        // Surface why an exit-0-but-empty run is being failed. Without this the
        // caller sees a bare exit 1 and an empty stderr, which reads as a
        // dispatcher bug rather than as the agent having done nothing. The
        // out-of-scope note rides the same channel for the same reason.
        stderr: [
          cleanStderr,
          emptyReason ? `dispatch: ${emptyReason}` : null,
          scopeReason ? `dispatch: ${scopeReason}` : null,
        ].filter(Boolean).join("\n"),
        // A diff wider than the declared scope is not a result the caller can
        // trust, so it fails — but only ever by promoting a 0. Never overwrite
        // a real failure code with this one; the underlying error matters more.
        exitCode: baseExitCode === 0 && scopeReason ? 1 : baseExitCode,
        durationMs: Date.now() - start,
        workdir,
        external,
        files,
        // The offending entries, so a caller can inspect rather than re-derive
        // them. Never reverted here: rewriting a caller's worktree is a far
        // worse failure than the one being reported.
        outOfScope,
      });
    });

    child.on("error", (err) => {
      cleanup();
      resolve({
        command: commandDescriptor,
        spawnError: { code: err.code, syscall: err.syscall, message: err.message },
        output: stripAnsi(stdout),
        stderr: stripAnsi(stderr + "\n" + err.message),
        exitCode: 1,
        durationMs: Date.now() - start,
        workdir,
        external,
        files: [],
      });
    });
  });
}

export function resolveEscalation(registry, sourceAgentId, state = {}) {
  const source = registry.agents.find((a) => a.id === sourceAgentId);
  if (!source) return null;
  return registry.agents.find(
    (a) => a.id !== sourceAgentId && a.provider === source.provider && a.tier === "strong"
      && isAgentEnabled(a, state)
  ) || null;
}

/**
 * Pure-generation transport: hits an OpenAI-compatible /chat/completions
 * endpoint via native fetch, dumps the response content into a file in a
 * fresh temp workdir. NO agentic loop, NO tool use — the model outputs text,
 * we write text. Great for "generate the content of this file from spec"
 * tasks where an edit-oriented CLI pipeline gets in the way.
 *
 * Registry shape expected:
 *   transports:
 *     generate:
 *       url:   "https://…/chat/completions"    # OpenAI-compat endpoint
 *       env:   "GEMINI_API_KEY"                # env var holding the Bearer key
 *       model: "gemini-3.5-flash"              # OPTIONAL — falls back to agentEntry.model
 *       output_filename: "generated.md"        # OPTIONAL — default "generated.md"
 */
// Lightweight credential verifier — a real API round-trip that proves the key
// works, without the workdir/JSONL overhead of runGenerate. Used by the UI's
// paste-and-save flow to give the operator immediate feedback ("✓ verified"
// vs "invalid key — 401") instead of just "env var is set".
//
// Returns { ok: true, latencyMs } on 2xx, or { ok: false, status, hint } on
// anything else. Times out at 10s (verification is a UX detail, not a job).
// Resolve a credential the way probe/dispatch expect it — per-entry `env:` override
// wins over process.env; `@file:~/...` refs resolve to file contents. Returns
// undefined when nothing usable is found.
function resolveAgentEnv(agentEntry, envName) {
  const override = agentEntry.env && agentEntry.env[envName];
  if (typeof override === "string") {
    if (override.startsWith("@file:")) {
      let p = override.slice("@file:".length);
      if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
      try { return fs.readFileSync(p, "utf-8").trim(); } catch { return undefined; }
    }
    return override;
  }
  return process.env[envName];
}

export async function verifyCredential(agentEntry) {
  const g = agentEntry.transports?.generate_new;
  if (!g || !g.url) return { ok: false, hint: "no generate_new transport to verify against" };
  // Every non-ok exit from this function goes through here, so the raw body a
  // hint clips to 200 characters is preserved once, in one place, instead of
  // at each of the six returns below.
  const logVerifyFailure = (v, rawBody, extra = {}) => {
    recordFailure({
      stage: "verify_credential",
      agent_id: agentEntry.id,
      provider: agentEntry.provider,
      model: g.model || agentEntry.model,
      transport: "generate_new",
      outcome: v.modelUnavailable ? "model_unavailable" : (v.status === 401 || v.status === 403 ? "needs_auth" : (v.status === 429 ? "rate_limited" : "error")),
      reason: v.hint,
      http_status: v.status ?? null,
      duration_ms: v.latencyMs ?? null,
      request: { url: g.url, model: g.model || agentEntry.model, env: g.env || null },
      ...extra,
      raw: { body: rawBody || null },
    });
    return v;
  };
  const envName = g.env;
  const apiKey = envName && envName !== "OLLAMA_UNUSED_KEY" ? resolveAgentEnv(agentEntry, envName) : null;
  if (envName && envName !== "OLLAMA_UNUSED_KEY" && !apiKey) {
    return logVerifyFailure({ ok: false, hint: `env var ${envName} not set` }, null);
  }
  const model = g.model || agentEntry.model;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const start = Date.now();
  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(g.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - start;
    if (resp.ok) return { ok: true, latencyMs };
    const text = await resp.text().catch(() => "");
    // Model-not-available is a specific class the caller needs to distinguish
    // from bad-credentials — the key is FINE, but this specific model isn't
    // exposed on the account. Consumers write state.<id>.state = "model_unavailable"
    // so pick/banner can skip without demoting the whole provider.
    const isModelMissing =
      resp.status === 404 ||
      /model.{0,80}(does not exist|not found|not available|decommissioned|deprecated|no longer supported|has been retired)/i.test(text) ||
      /model_not_found|model_decommissioned|model_deprecated/i.test(text);
    if (isModelMissing) {
      return logVerifyFailure({
        ok: false,
        status: resp.status,
        modelUnavailable: true,
        hint: "model not available on this account (" + resp.status + ")",
        latencyMs,
      }, text);
    }
    // 402 / insufficient balance / payment required — key is valid but the
    // model tier requires a paid plan. Same effect for pick/dispatch as
    // model_unavailable (skip it), but the UX hint is different so the
    // operator knows upgrading billing would unlock it.
    const isPaymentRequired =
      resp.status === 402 ||
      /payment.{0,20}required|insufficient.{0,20}balance|please.{0,20}recharge|billing.{0,20}required/i.test(text);
    if (isPaymentRequired) {
      return logVerifyFailure({
        ok: false,
        status: resp.status,
        modelUnavailable: true,
        hint: "paid plan required for this model (" + resp.status + ")",
        latencyMs,
      }, text);
    }
    // 429 rate limit — resolve the REAL reset from the failing response: rate-limit reset headers
    // (retry-after / x-ratelimit-reset-* / anthropic-ratelimit-*-reset / x-ratelimit-reset) first,
    // then body text, then provider period policy. No extra/predictive call — only what this 429
    // already carried.
    if (resp.status === 429) {
      const reset_at = resolveExhaustionResetAt({
        text,
        headers: resp.headers,
        provider: agentEntry.provider,
        nowMs: Date.now(),
      });
      return logVerifyFailure({
        ok: false,
        status: resp.status,
        hint: `HTTP ${resp.status}` + (text ? ": " + text.slice(0, 200) : ""),
        latencyMs,
        reset_at,
      }, text, { reset_at });
    }
    return logVerifyFailure({
      ok: false,
      status: resp.status,
      hint: resp.status === 401 || resp.status === 403
        ? "invalid API key (server returned " + resp.status + ")"
        : `HTTP ${resp.status}` + (text ? ": " + text.slice(0, 200) : ""),
      latencyMs,
    }, text);
  } catch (e) {
    return logVerifyFailure(
      { ok: false, hint: e.name === "AbortError" ? "timeout after 10s" : e.message },
      null,
      { network_error: { name: e?.name, code: e?.cause?.code || e?.code, message: e?.message } },
    );
  } finally {
    clearTimeout(timer);
  }
}

// Canonical classification of a verifyCredential() result into a state.json
// state string. Single source of truth for /api/audit, /api/set_credential,
// and /api/add_provider_key — before this, only /api/audit had the full
// precedence (401/403/explicit needsAuth -> needs_auth, 429 -> rate_limited,
// everything else failing -> errored_transient); the other two collapsed
// every non-modelUnavailable failure (429, 5xx, timeouts, network errors)
// into needs_auth, which locked freshly-added valid keys whenever the
// post-add verify ping merely hit a rate limit.
export function classifyVerifyResult(v) {
  if (v.ok) return "healthy";
  // The probe's own environment broke, so it observed nothing about the agent.
  // Callers must NOT persist this — see shouldPersistOutcome.
  if (v.harnessError) return "probe_error";
  if (v.modelUnavailable) return "model_unavailable";
  if (v.quotaExhausted) return "quota_exhausted";
  if (v.needsAuth) return "needs_auth";
  if (v.status === 401 || v.status === 403) return "needs_auth";
  if (v.status === 429) return "rate_limited";
  return "errored_transient";
}

// An audit outcome is a claim about the AGENT. "probe_error" is a claim about
// us — the probe never reached the agent — so writing it to state.json would
// record a fact we did not observe, and (because a non-healthy record blocks
// pick until it expires) would take a working agent out of rotation on the
// strength of our own broken shell. Callers check this before writeState.
export function shouldPersistOutcome(outcome) {
  return outcome !== "probe_error";
}

// Did the PROBE fail, or did the AGENT? auditCliEntry runs its command through
// `bash -c` with the parent's environment, and when that parent is a GUI-spawned
// MCP server or dashboard its PATH can be down to almost nothing. The registry
// commands that begin with `env -u ANTHROPIC_BASE_URL … claude --print` then die
// as `bash: line 1: env: command not found` — /usr/bin/env is not on PATH — and
// the old code classified that as errored_transient, i.e. "the agent is sick".
// It wasn't. `claude` was never invoked. The verdict then stuck (no cooldown was
// recorded for errored_transient) and quietly removed the strongest entry in the
// pool from every subsequent pick.
//
// 127 is the shell's own "I could not execute that" exit code and is the
// reliable half of this. The text patterns cover shells that exit differently,
// and they are anchored on purpose.
//
// An earlier version matched a bare `: not found` anywhere in the output. That
// is too broad in the one direction that costs something: an agent reporting
// `Error: config.json: not found` is making a real observation about itself,
// and swallowing it as "our probe broke" means the stale verdict is kept and
// the real one is thrown away. So the not-found form now has to look like a
// SHELL said it — `sh: 1: foo: not found`, `bash: line 1: env: command not
// found`, `/bin/sh: x: not found` — rather than merely containing the words.
// `command not found` stays unanchored: no CLI emits that phrase about its own
// data, and zsh puts it in a different word order (`command not found: foo`).
//
// The two wildcards in the shell pattern are length-bounded rather than open
// `[^\n]*`. This input is CLI output — up to 8KB of it, occasionally on a
// single line — and two unbounded greedy classes separated by literals
// backtrack quadratically on a long line that does not match. A shell's
// "not found" preamble is short by construction, so 200 characters is far more
// than the real case needs and turns the worst case from tens of millions of
// steps into tens of thousands.
const HARNESS_FAILURE_PATTERNS = [
  /\bcommand not found\b/i,
  /^[^\n]{0,200}\b(?:ba|z|k|da|a)?sh\b[^\n]{0,200}:\s*not found\b/im,
  /\bENOENT\b/,
  /\bexecvp\b/i,
];
export function isHarnessFailure(text, exitCode) {
  if (exitCode === 127) return true;
  const s = String(text || "");
  return HARNESS_FAILURE_PATTERNS.some((re) => re.test(s));
}

export async function runGenerate(agentEntry, prompt, options = {}) {
  const g = getTransportConfig(agentEntry, "generate_new");
  if (!g || typeof g !== "object") {
    throw new Error(`runGenerate: no generate transport for ${agentEntry.id}`);
  }
  if (!g.url) throw new Error(`runGenerate: transports.generate_new.url missing for ${agentEntry.id}`);
  const envName = g.env;
  let apiKey; // optional — Ollama and some local endpoints need no auth
  if (envName && envName !== "OLLAMA_UNUSED_KEY") {
    apiKey = resolveAgentEnv(agentEntry, envName);
    if (!apiKey) {
      return {
        output: "",
        stderr: `env var ${envName} not set`,
        exitCode: 1,
        durationMs: 0,
        workdir: null,
        files: [],
        request: { url: g.url, model: g.model || agentEntry.model, env: envName, env_present: false },
      };
    }
  }

  const model = g.model || agentEntry.model;
  if (!model) throw new Error(`runGenerate: no model set for ${agentEntry.id}`);

  // Mirrors runDispatch's commandDescriptor: what was sent, minus the secret.
  // `env_present` rather than the key itself — "the request went out with no
  // Authorization header" and "the header was wrong" are different failures
  // and the log has to be able to tell them apart without holding the key.
  const requestDescriptor = {
    url: g.url,
    model,
    env: envName || null,
    env_present: Boolean(apiKey),
    effort: options.effort || null,
    effort_param: g.effort_param || null,
  };

  const filename = g.output_filename || "generated.md";
  // Created only when there is something to put in it.
  //
  // This directory exists to hold the generated file, but it used to be made up
  // front, before the request was even sent — so every dispatch that produced
  // no file left an empty one behind: a missing key, a 429, a timeout, a
  // non-JSON body, an empty completion. Measured on one developer machine, 909
  // of 1427 `ea-gen-*` directories were empty, i.e. two thirds of them recorded
  // nothing except that a dispatch had failed. The OS does reclaim them, but
  // only after about a month.
  //
  // `workdir` stays in the returned shape and is simply `null` when nothing was
  // written. That is the honest answer, and a caller reading it already has to
  // cope with `files: []` on exactly these paths.
  let workdir = null;
  const ensureWorkdir = () =>
    (workdir ??= fs.mkdtempSync(path.join(os.tmpdir(), `ea-gen-${agentEntry.id}-`)));

  const timeoutMs = options.timeoutMs ?? Number(process.env.EXTERNAL_AGENTS_TIMEOUT_MS || 500000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  const progress = typeof options.progress === "function" ? options.progress : null;
  const heartbeatMs = options.heartbeatMs ?? 5000;
  const heartbeat = progress
    ? setInterval(() => {
        progress("dispatch: waiting for generate_new response", {
          type: "heartbeat",
          elapsedMs: Date.now() - start,
        });
      }, heartbeatMs)
    : null;

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const body = {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    };
    if (options.effort) {
      if (g.effort_param === "nested") {
        body.reasoning = { effort: options.effort };
      } else {
        body.reasoning_effort = options.effort;
      }
    }
    const resp = await fetch(g.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const bodyText = await resp.text();
    if (heartbeat) clearInterval(heartbeat);
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    if (!resp.ok) {
      // Detect "model does not exist on this account/tier" as a distinct
      // condition from "bad key" / "rate limit". Callers (state writer) use
      // this to mark the entry as model_unavailable so pick/banner skip it,
      // instead of the normal error path that just increments failure count.
      const modelMissing =
        resp.status === 404 ||
        /model.{0,40}(does not exist|not found|not available)/i.test(bodyText) ||
        /model_not_found/i.test(bodyText);
      return {
        output: bodyText,
        stderr: `HTTP ${resp.status} ${resp.statusText}`,
        exitCode: 1,
        durationMs,
        workdir,
        files: [],
        status: resp.status,
        modelUnavailable: modelMissing || undefined,
        request: requestDescriptor,
        // The provider's own words, untouched. Everything downstream of here
        // clips this to a preview or a hint; the sidecar log wants all of it,
        // because the actionable half of a provider error ("model X was
        // decommissioned, use Y") is regularly past the clip.
        responseBody: bodyText,
        // Rate-limit and retry-after headers are the whole reason to keep
        // these; cookies are the one class that is both useless here and
        // credential-bearing, so they never enter the record.
        responseHeaders: Object.fromEntries(
          [...resp.headers].filter(([k]) => !/^set-cookie$/i.test(k)),
        ),
      };
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return {
        output: bodyText, stderr: "non-JSON response", exitCode: 1, durationMs, workdir, files: [],
        status: resp.status, request: requestDescriptor, responseBody: bodyText,
      };
    }
    const content = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage || {};
    if (typeof content !== "string" || content.trim() === "") {
      return {
        output: "",
        stderr: "empty generated output",
        exitCode: 1,
        durationMs,
        workdir,
        files: [],
        tokens_in: usage.prompt_tokens,
        tokens_out: usage.completion_tokens,
        status: resp.status,
        request: requestDescriptor,
        // An empty completion is the case where the envelope IS the evidence:
        // a refusal in an unexpected field, a finish_reason of content_filter,
        // a choices array the provider returned empty.
        responseBody: bodyText,
      };
    }
    fs.writeFileSync(path.join(ensureWorkdir(), filename), content);

    return {
      output: content,
      stderr: "",
      exitCode: 0,
      durationMs,
      workdir,
      files: [{ path: filename, bytes: Buffer.byteLength(content, "utf-8") }],
      tokens_in: usage.prompt_tokens,
      tokens_out: usage.completion_tokens,
      status: resp.status,
      request: requestDescriptor,
    };
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const timedOut = err?.name === "AbortError";
    return {
      output: "",
      // A fetch failure collapses to a two-word message ("fetch failed") with
      // the real reason — DNS, TLS, ECONNREFUSED — hidden one level down in
      // `cause`. Unwrapped here so the log records the answer, not the label.
      stderr: [err?.message || String(err), err?.cause?.message, err?.cause?.code]
        .filter(Boolean).join(" — "),
      exitCode: timedOut ? 124 : 1,
      durationMs,
      workdir,
      files: [],
      request: requestDescriptor,
      timedOut,
      networkError: { name: err?.name, code: err?.cause?.code || err?.code, message: err?.message },
    };
  }
}

/**
 * Route to the right runner based on which transport the agent declares.
 *
 * Selection order:
 *   1. If options.transport is explicitly "generate_new" or "edit_exists", use that (error
 *      if the entry doesn't declare it). This is how callers override.
 *   2. If options.transport is explicitly "read_only": use a declared `read_only`
 *      CLI command if present; otherwise, if the entry's only capability is
 *      `generate_new`, that HTTP transport is read-only by construction (an
 *      LLM completion call has no filesystem access) and satisfies the request
 *      as-is. An entry that declares only `edit_exists` — and no `read_only` —
 *      does NOT satisfy a read_only request: it errors rather than silently
 *      running the write-capable command. That silent fallback is the exact
 *      failure this transport kind exists to prevent (see kiro's edit_exists
 *      trusting only fs_read: the label promised write, the command couldn't,
 *      and the mismatch was invisible until someone checked git diff).
 *   3. Otherwise, a supplied cwd prefers an edit_exists CLI when available.
 *      Without that preference, generate_new remains the default and
 *      edit_exists is its fallback.
 *
 * Always appends one JSONL row to ~/.local/state/external-agents/dispatch-log.jsonl
 * regardless of outcome, so get_stats can aggregate. Telemetry is best-effort.
 */
const DISPATCH_LOG = path.join(os.homedir(), ".local", "state", "external-agents", "dispatch-log.jsonl");

function logDispatch(row) {
  try {
    fs.mkdirSync(path.dirname(DISPATCH_LOG), { recursive: true, mode: 0o700 });
    fs.appendFileSync(DISPATCH_LOG, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch (e) {
    console.error(`external-agents: telemetry write failed: ${e.message}`);
  }
}

export function selectTransport(agentEntry, options = {}) {
  const forced = options.transport;
  if (forced === "generate_new") {
    if (!getTransportConfig(agentEntry, "generate_new")) {
      throw new Error(`runAny: transport 'generate_new' requested but not declared for ${agentEntry?.id}`);
    }
    return "generate_new";
  }
  if (forced === "edit_exists") {
    if (!getTransportConfig(agentEntry, "edit_exists")) {
      throw new Error(`runAny: transport 'edit_exists' requested but not declared for ${agentEntry?.id}`);
    }
    return "edit_exists";
  }
  if (forced === "read_only") {
    const ro = getTransportConfig(agentEntry, "read_only");
    // `via:` delegates the read-only role to another declared transport. Only
    // generate_new is an acceptable target: an HTTP completion call has no
    // filesystem access at all, so it is read-only by construction. Pointing
    // `via` at edit_exists is exactly the write-capable fallback this axis
    // exists to prevent, so it is rejected rather than honoured.
    if (ro?.via) {
      if (ro.via !== "generate_new") {
        throw new Error(
          `runAny: ${agentEntry?.id} declares read_only via '${ro.via}', which is not a non-writing transport — only 'generate_new' may back a read_only declaration`,
        );
      }
      if (!getTransportConfig(agentEntry, "generate_new")) {
        throw new Error(
          `runAny: ${agentEntry?.id} declares read_only via 'generate_new' but has no generate_new transport`,
        );
      }
      return "generate_new";
    }
    if (ro) return "read_only";
    throw new Error(
      `runAny: transport 'read_only' requested but ${agentEntry?.id} does not declare it — refusing to fall back to a write-capable transport`,
    );
  }
  if (options.cwd != null && options.cwd !== "" && getTransportConfig(agentEntry, "edit_exists")) {
    return "edit_exists";
  }
  if (getTransportConfig(agentEntry, "generate_new")) return "generate_new";
  if (getTransportConfig(agentEntry, "edit_exists")) return "edit_exists";
  throw new Error(`runAny: no known transport for ${agentEntry?.id ?? "<unknown>"}`);
}

// ---------------------------------------------------------------------------
// Repository provenance
//
// A dispatch with --cwd hands a worker a directory and tells it nothing about
// WHICH version of the project that directory holds. That gap has a specific,
// repeatable failure mode: the caller means "review the current code", the cwd
// happens to sit on a stale branch a couple hundred commits behind, and the
// worker faithfully reports on code that no longer exists upstream. The report
// reads like a hallucination. It isn't — the worker was honest and the
// checkout was wrong — but the only way to tell those two apart afterwards is
// to notice it by hand, and by then a correct review has already been thrown
// away as fabricated.
//
// Both directions of that are fixed here: the worker is TOLD what it is looking
// at, and the caller gets the same facts back in the result and the telemetry
// row, so a suspect review can be checked against the commit it actually saw
// instead of being argued about.
//
// Everything is best-effort and read-only. A missing git, a detached HEAD, a
// repo with no upstream — each degrades to a field being absent, never to a
// failed dispatch. Knowing where you are is a courtesy to the worker; refusing
// to work without it is the caller's explicit choice (--require-base).
// ---------------------------------------------------------------------------
// Two readers, and the difference between them is the whole point.
//
// gitLine collapses "empty output" and "the command failed" into null, which is
// right for a value that is either present or absent (a branch name, an
// upstream). It is WRONG for `status --porcelain`, where empty output is itself
// the answer — a clean tree — and indistinguishable from a git that timed out
// or errored. Reporting "clean" because the check failed would state a fact we
// did not observe, in a header whose entire purpose is not doing that. So
// gitRun keeps the two apart and the caller reports `dirty: null` for unknown.
function gitRun(cwd, args) {
  try {
    const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: 5000 });
    if (res.error || res.status !== 0) return { ok: false, out: "" };
    return { ok: true, out: (res.stdout || "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

function gitLine(cwd, args) {
  const res = gitRun(cwd, args);
  return res.ok && res.out !== "" ? res.out : null;
}

export function repoProvenance(cwd) {
  if (!cwd) return null;
  const root = findGitRoot(cwd);
  if (!root) return null;

  const head = gitLine(root, ["rev-parse", "HEAD"]);
  // A repo with no commits yet: there is nothing to name, so every downstream
  // consumer keys off the absent `head` and the header renders as empty.
  if (!head) return { root, detached: false, head: null, dirty: null, dirty_files: null };

  // `--abbrev-ref HEAD` returns the literal "HEAD" on a detached checkout,
  // which is a fact worth reporting rather than a branch name worth printing.
  const branchRaw = gitLine(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detached = branchRaw === "HEAD" || branchRaw == null;
  let upstream = gitLine(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  // A local task branch usually has no upstream at all, and that is exactly the
  // case the incident this exists for came from: nothing to compare against, so
  // "195 commits behind" was invisible. Fall back to the remote's default
  // branch (origin/HEAD, else origin/main) purely as a reference point, and
  // flag it as our guess rather than the branch's declared upstream.
  let upstreamInferred = false;
  if (!upstream) {
    const originHead = gitLine(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    const fallback = originHead
      || (gitLine(root, ["rev-parse", "--verify", "--quiet", "origin/main"]) ? "origin/main" : null);
    if (fallback) { upstream = fallback; upstreamInferred = true; }
  }

  let ahead = null, behind = null;
  if (upstream) {
    // Counts against the recorded upstream WITHOUT fetching: a dispatch must
    // not touch the network or mutate the caller's repo. So this is drift
    // since the last fetch, not drift from the true remote — which is still
    // the difference between "195 behind" and knowing nothing at all.
    const counts = gitLine(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const m = counts && counts.match(/^(\d+)\s+(\d+)$/);
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
  }

  const status = gitRun(root, ["status", "--porcelain"]);
  return {
    root,
    branch: detached ? null : branchRaw,
    detached,
    head,
    short: head.slice(0, 12),
    subject: gitLine(root, ["log", "-1", "--pretty=%s"]),
    committed_at: gitLine(root, ["log", "-1", "--pretty=%cI"]),
    upstream: upstream || null,
    upstream_inferred: upstreamInferred,
    ahead,
    behind,
    // null = we could not tell (git errored, or timed out on a huge tree), NOT
    // "clean". A `status --porcelain` that succeeds with no output IS clean.
    dirty: status.ok ? status.out !== "" : null,
    dirty_files: status.ok ? status.out.split("\n").filter(Boolean).length : null,
  };
}

// The block prepended to the prompt. Deliberately plain text with no
// instruction in it beyond the facts: a worker that is told what it is reading
// can flag a mismatch itself, and one that is given orders about branches will
// start reasoning about git instead of about the task it was sent to do.
export function formatProvenanceHeader(prov) {
  if (!prov || !prov.head) return "";
  const lines = [
    "<!-- REPOSITORY STATE — the working directory you were given, as it stands right now.",
    "     These are facts about the checkout, not instructions. If what you read on disk",
    "     contradicts what the request assumes, say so and name this commit. -->",
    `repo:   ${prov.root}`,
    `branch: ${prov.detached ? `(detached HEAD)` : prov.branch}`,
    `commit: ${prov.short}${prov.subject ? ` — ${prov.subject}` : ""}${prov.committed_at ? ` (${prov.committed_at})` : ""}`,
  ];
  if (prov.upstream) {
    const drift = (prov.ahead == null || prov.behind == null)
      ? "comparison unavailable"
      : (prov.ahead === 0 && prov.behind === 0)
      ? "in sync"
      : `${prov.ahead} ahead, ${prov.behind} behind`;
    // The caveat matters: these counts come from refs on disk. If nobody has
    // fetched recently, "in sync" means "in sync with what we last heard".
    lines.push(
      `vs ${prov.upstream}${prov.upstream_inferred ? " (this branch declares no upstream; comparing against the remote default)" : ""}: ` +
      `${drift} (as of the last fetch — not re-checked)`,
    );
  } else {
    lines.push("upstream: none configured for this branch");
  }
  lines.push(
    `worktree: ${
      prov.dirty == null
        ? "could not be determined (git status did not complete)"
        : prov.dirty
        ? `${prov.dirty_files} uncommitted change(s)`
        : "clean"
    }`,
  );
  return lines.join("\n") + "\n\n";
}

export async function runAny(agentEntry, prompt, options = {}) {
  const transport = selectTransport(agentEntry, options);
  let result;

  // Resolve explicitly attached context and prepend it to the prompt. This is
  // required for generate_new (HTTP models have no filesystem access), but
  // optional for edit_exists because direct CLIs can inspect cwd.
  if (options.files?.length && !options.cwd) {
    console.error("dispatch: WARNING — files provided without cwd; paths will resolve against server process.cwd() and may fail containment");
  }
  const fileContext = resolveFileContext(options.files, options.cwd || process.cwd(), {
    strictContainment: true,
    baseFromCwd: Boolean(options.cwd),
  });

  // Only when the caller named a cwd. Without one the worker is in a throwaway
  // temp dir or has no filesystem at all, and stamping THIS process's repo onto
  // the prompt would describe a tree the worker cannot see.
  //
  // Note this fires for generate_new too, even though that transport ignores
  // cwd for execution: an HTTP model given `--cwd` almost always also gets
  // `--file` excerpts resolved against it, and naming the commit those excerpts
  // were cut from is exactly the fact that was missing. `provenance: false`
  // opts out entirely.
  const provenance = options.cwd && options.provenance !== false
    ? repoProvenance(options.cwd)
    : null;
  const provenanceHeader = formatProvenanceHeader(provenance);

  // Ahead of the file context: the first thing the worker reads should be what
  // it is looking at, before it starts reading the thing itself.
  const fullPrompt = provenanceHeader + fileContext + prompt;
  emitPromptSizeWarning(fullPrompt, options.progress);

  if (transport === "generate_new") {
    result = await runGenerate(agentEntry, fullPrompt, options);
  } else if (transport === "read_only") {
    result = await runDispatch(agentEntry, fullPrompt, options, "read_only");
  } else {
    result = await runDispatch(agentEntry, fullPrompt, options, "edit_exists");
  }

  // Telemetry — one row per dispatch, best-effort. Failures also capture a
  // short (400 char) preview of stderr / API response body so the UI can show
  // WHY a call failed instead of the blind "error" it used to log. Success
  // rows never include the preview — no telemetry of prompt content. Take the
  // LAST 400 chars, not the first: CLI-transport tools (codex, claude-opus-5,
  // etc) print a startup banner + the echoed prompt FIRST, and the actual
  // error/exception only appears near the end right before the process exits.
  const failed = result.exitCode !== 0;
  const errorPreview = failed
    ? stripBenignStderrNoise(result.stderr || result.output || "").slice(-400)
    : undefined;
  // A "model does not exist" verdict must self-demote the entry so the
  // banner + pick both skip it in future rounds. Writing state.<id>.state
  // = "model_unavailable" — a permanent marker only lifted by a manual
  // re-probe (which will only succeed if the provider now hosts the model).
  if (result.modelUnavailable) {
    try {
      // Import lazily to avoid a cycle with state.js.
      const { writeState } = await import("./state.js");
      writeState({
        [agentEntry.id]: {
          state: "model_unavailable",
          note: `provider says model does not exist (HTTP ${result.status || "?"})`,
          checked: Math.floor(Date.now() / 1000),
        },
      });
    } catch { /* best-effort */ }
  }
  // CLI-transport auth detection — subscription CLIs (claude, codex,
  // cursor-agent, kiro-cli) don't fit the HTTP 401/403 shape verifyCredential
  // catches. Their auth failures show up as stderr strings like "Not logged in",
  // "Please run /login", "AuthorizationRequired". Map those to state=needs_auth
  // so audit/UI show the actionable status instead of a generic "error".
  if (failed && !result.modelUnavailable) {
    const { needsAuth: isAuthFail, quotaExhausted: isQuotaFail } = classifyCliFailure(
      (result.stderr || result.output || "").toString(),
    );
    if (isAuthFail || isQuotaFail) {
      try {
        const { writeState } = await import("./state.js");
        const current = (await import("./state.js")).readState()[agentEntry.id] || {};
        writeState({
          [agentEntry.id]: {
            ...current,
            state: isAuthFail ? "needs_auth" : "quota_exhausted",
            note: isAuthFail
              ? "CLI reports not authenticated — run login flow for this CLI"
              : "CLI monthly/usage limit hit — quota resets per provider",
            checked: Math.floor(Date.now() / 1000),
          },
        });
      } catch { /* best-effort */ }
    }
  }
  // Sidecar failure log — opt-in, off unless the operator set the flag. The
  // row below is the AGGREGATION record: deliberately small, error text clipped
  // to 400 characters. This is the DIAGNOSIS record: only failures, but whole —
  // full stdout, full stderr, the argv, the HTTP body, the classification that
  // was drawn from them. Written so it can be handed to a model as-is.
  if (failed) {
    const failText = `${result.stderr || ""}\n${result.output || ""}`;
    const cliFailure = classifyCliFailure(failText);
    recordFailure({
      stage: "dispatch",
      agent_id: agentEntry.id,
      provider: agentEntry.provider,
      model: agentEntry.model,
      transport,
      outcome: result.exitCode === 124 ? "timeout" : "error",
      reason: firstFailureReason(result),
      exit_code: result.exitCode,
      http_status: result.status ?? null,
      duration_ms: result.durationMs,
      timed_out: result.exitCode === 124 || result.timedOut === true,
      classification: {
        needs_auth: cliFailure.needsAuth,
        quota_exhausted: cliFailure.quotaExhausted,
        model_unavailable: result.modelUnavailable === true,
        harness_failure: isHarnessFailure(failText, result.exitCode),
        exhaustion: parseExhaustionSignal(failText),
      },
      command: result.command ?? null,
      request: result.request ?? null,
      response_headers: result.responseHeaders ?? null,
      spawn_error: result.spawnError ?? null,
      network_error: result.networkError ?? null,
      // What the worker was given and what it left behind. An empty `files`
      // beside an exit 0 is its own diagnosis, and it is invisible in the
      // aggregate log.
      workdir: result.workdir ?? null,
      files: result.files ?? null,
      out_of_scope: result.outOfScope?.length ? result.outOfScope : null,
      prompt_bytes: Buffer.byteLength(fullPrompt || "", "utf-8"),
      file_context_bytes: fileContext ? Buffer.byteLength(fileContext, "utf-8") : 0,
      attached_files: options.files?.map((f) => (typeof f === "string" ? f : f.path)) ?? null,
      effort: options.effort ?? null,
      repo: provenance
        ? { head: provenance.head, branch: provenance.branch, behind: provenance.behind, dirty: provenance.dirty }
        : null,
      prompt_text: fullPrompt,
      raw: {
        stdout: result.output || null,
        stderr: result.stderr || null,
        body: result.responseBody || null,
      },
    });
  }
  logDispatch({
    ts: Math.floor(Date.now() / 1000),
    agent_id: agentEntry.id,
    provider: agentEntry.provider,
    model: agentEntry.model,
    transport,
    outcome: result.exitCode === 0 ? "success" : (result.exitCode === 124 ? "timeout" : "error"),
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    tokens_in: result.tokens_in ?? null,
    tokens_out: result.tokens_out ?? null,
    prompt_bytes: Buffer.byteLength(fullPrompt || "", "utf-8"),
    file_context_bytes: fileContext ? Buffer.byteLength(fileContext, "utf-8") : 0,
    http_status: result.status ?? null,
    error_preview: errorPreview,
    // Which commit this answer is about. Logged so a disputed result can be
    // checked against the tree the worker actually saw, months later, without
    // anyone having to remember what the cwd was pointing at.
    repo_head: provenance?.head ?? null,
    repo_branch: provenance?.branch ?? null,
    repo_behind: provenance?.behind ?? null,
    repo_dirty: provenance ? provenance.dirty : null,
  });

  return { ...result, transport, provenance };
}

export function getStats(sinceIso) {
  if (!fs.existsSync(DISPATCH_LOG)) return { total: 0, by_agent: {}, by_transport: {}, span: {} };
  const raw = fs.readFileSync(DISPATCH_LOG, "utf-8");
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  const since = sinceIso ? Math.floor(Date.parse(sinceIso) / 1000) : 0;
  const filtered = rows.filter((r) => (r.ts || 0) >= since);
  const by_agent = {};
  const by_transport = {};
  let first = Infinity, last = 0;
  for (const r of filtered) {
    const a = (by_agent[r.agent_id] ??= {
      count: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0,
      outcomes: {}, transports: {},
      // Error from the CHRONOLOGICALLY LAST dispatch, only if that dispatch
      // failed. Cleared (set to null) the moment a later success arrives —
      // an agent that failed once yesterday and has succeeded 4 times since
      // must not keep showing yesterday's stderr in the UI. _lastTs tracks
      // the max timestamp seen so far, independent of outcome, so out-of-order
      // log rows (rare, but the file is append-only across processes) can't
      // regress an already-cleared error back in.
      last_error: null,
      _lastTs: 0,
    });
    a.count++;
    a.tokens_in += r.tokens_in || 0;
    a.tokens_out += r.tokens_out || 0;
    a.duration_ms += r.duration_ms || 0;
    a.outcomes[r.outcome] = (a.outcomes[r.outcome] || 0) + 1;
    a.transports[r.transport] = (a.transports[r.transport] || 0) + 1;
    if ((r.ts || 0) >= a._lastTs) {
      a._lastTs = r.ts || 0;
      a.last_error = r.outcome === "success" ? null : {
        ts: r.ts,
        outcome: r.outcome,
        http_status: r.http_status ?? null,
        error_preview: r.error_preview || null,
      };
    }
    const t = (by_transport[r.transport] ??= { count: 0, tokens_in: 0, tokens_out: 0 });
    t.count++; t.tokens_in += r.tokens_in || 0; t.tokens_out += r.tokens_out || 0;
    if (r.ts < first) first = r.ts;
    if (r.ts > last) last = r.ts;
  }
  // Drop the internal ordering cursor before returning — it's bookkeeping,
  // not part of the public per-agent shape.
  for (const a of Object.values(by_agent)) delete a._lastTs;
  return {
    total: filtered.length,
    by_agent,
    by_transport,
    span: filtered.length ? { first_ts: first, last_ts: last } : {},
  };
}

// Probe a CLI-transport entry by actually invoking the CLI headless with a
// tiny prompt, then regex-classifying stderr/output. Shared by `external-agents
// audit` and the UI's per-row Verify button. Same signal-detection order as
// runAny's post-dispatch classifier: quota/auth checked BEFORE exit code so
// exit-0-with-error-text CLIs (claude --print without OAuth, kiro-cli quota
// screen) don't false-positive as healthy.
export async function auditCliEntry(entry) {
  const cliTransport = getTransportConfig(entry, "edit_exists");
  const cmd = cliTransport?.cmd;
  if (!cmd) return { ok: false, hint: "no edit_exists transport" };
  const start = Date.now();
  // The rolling 4000-char window below is right for a hint and wrong for a
  // diagnosis: a CLI that prints a banner, echoes the prompt, then throws is
  // routinely past it, and the throw is the half that gets dropped. When the
  // sidecar log is on the window widens to its raw cap; when it is off nothing
  // changes and the probe keeps its original memory profile.
  const failureLog = readFailureLogConfig();
  const keepBytes = failureLog.enabled ? failureLog.max_raw_bytes : 4000;
  // Mirror runDispatch's prompt_flag handling: agy's --print consumes the
  // very next token as its own value, so without prompt_flag inserted
  // immediately before the prompt here, agy gets no --print at all and boots
  // its full interactive TUI instead — which then crashes for lack of a real
  // controlling terminal ("bubbletea: could not open TTY"). That reads as a
  // health/quota problem in the audit output; it is actually just a missing
  // flag on this probe's own command line.
  const promptFlag = cliTransport.prompt_flag ? `${cliTransport.prompt_flag} ` : "";
  const shellCommand = `${cmd} ${promptFlag}"reply exactly OK"`;
  return new Promise((rawResolve) => {
    const child = spawn("bash", ["-c", shellCommand], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); if (out.length > keepBytes) out = out.slice(-keepBytes); });
    child.stderr.on("data", (d) => { err += d.toString(); if (err.length > keepBytes) err = err.slice(-keepBytes); });
    // One funnel for all nine resolve paths below, so no verdict can be added
    // later that quietly escapes the log.
    const resolve = (v) => {
      if (!v.ok) {
        recordFailure({
          stage: "audit",
          agent_id: entry.id,
          provider: entry.provider,
          model: entry.model,
          transport: "edit_exists",
          outcome: v.quotaExhausted ? "quota_exhausted"
            : v.needsAuth ? "needs_auth"
            : v.harnessError ? "harness_error"
            : "error",
          reason: v.hint,
          exit_code: v.exit_code ?? null,
          duration_ms: v.latencyMs ?? null,
          timed_out: v.timed_out === true,
          command: { cmd, shell: shellCommand, transport_kind: "edit_exists" },
          classification: {
            needs_auth: v.needsAuth === true,
            quota_exhausted: v.quotaExhausted === true,
            harness_failure: v.harnessError === true,
          },
          reset_at: v.reset_at ?? null,
          raw: { stdout: out || null, stderr: err || null },
        }, { config: failureLog });
      }
      rawResolve(v);
    };
    // 20s used to be the whole budget here, and it isn't enough: measured
    // cold-start latency for `opencode run --auto` on this machine ranged
    // 7s-62s across five back-to-back calls with nothing else changed — no
    // model swap, no network hiccup, just CLI startup variance. At 20s that is
    // a coin-flip SIGKILL, not a health check: the process is killed mid-reply,
    // stdout comes back empty, and the dashboard reports errored_transient for
    // an agent that would have answered fine given a few more seconds. 90s
    // covers the observed worst case with headroom while staying well under
    // runDispatch's real-dispatch timeout (500s default) — this probe should
    // fail faster than an actual task, not as fast as it can.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (timedOut) return resolve({ ok: false, hint: `timed out after ${Math.round(latencyMs / 1000)}s waiting for a reply`, latencyMs, timed_out: true, exit_code: code });
      const preview = stripAnsi(err + "\n" + out).trim();
      const classified = classifyCliFailure(preview);
      const isQuota = classified.quotaExhausted;
      const isAuth = classified.needsAuth || /invalid.{0,20}api key|oauth.{0,20}(revoked|expired)|revoked/i.test(preview);
      if (isQuota) {
        return resolve({
          ok: false,
          quotaExhausted: true,
          hint: _extractHint(preview, /monthly.{0,60}limit reached|usage limit.{0,60}/i),
          latencyMs,
          // Period-aware: a CLI "Monthly request limit reached" (e.g. kiro) resolves to +7d — a
          // safe re-check since the billing-cycle date is unknown — instead of the 1h fallback.
          reset_at: resolveExhaustionResetAt({ text: preview, provider: entry.provider, nowMs: Date.now() }),
        });
      }
      if (isAuth)  return resolve({ ok: false, needsAuth: true, hint: _extractHint(preview, /not logged in.{0,60}|please run \/login|authorizationrequired|invalid.{0,40}api key.{0,40}|oauth.{0,20}(revoked|expired)/i), latencyMs });
      // Checked after quota/auth (those are real observations about the agent
      // and outrank everything) but before the exit-code paths, which would
      // otherwise blame the agent for our own shell — see isHarnessFailure.
      if (isHarnessFailure(preview, code)) {
        return resolve({
          ok: false,
          harnessError: true,
          hint: `probe could not execute the command (${(_lastMeaningfulLine(preview) || `exit ${code}`).slice(0, 120)}) — this says nothing about the agent; check the PATH of the process running the probe`,
          latencyMs,
          exit_code: code,
        });
      }
      if (code === 0) {
        if (/\bOK\b/i.test(out)) return resolve({ ok: true, latencyMs });
        return resolve({ ok: false, hint: `exit 0 but response did not include expected marker (got: "${(out || err).slice(0, 120).replace(/\s+/g, " ").trim()}")`, latencyMs, exit_code: code });
      }
      resolve({ ok: false, hint: (_lastMeaningfulLine(preview) || `exit ${code}`).slice(0, 200), latencyMs, exit_code: code });
    });
  });
}
function _extractHint(text, re) {
  const m = text.match(re);
  return m ? m[0].trim().slice(0, 200) : text.split("\n").filter(l => l.trim()).pop()?.slice(0, 200);
}
// A CLI's JSON error body often spans multiple lines (opencode: `Error: {\n
// "name": "UnknownError",\n "data": {"message": "...", "ref": "..."}\n}`), so
// the naive "last non-blank line" grabs a bare closing brace instead of the
// actual message. Pull a message out of the trailing JSON object when there
// is one; otherwise fall back to the last non-blank line as before. A CLI can
// print an unrelated `{` before its real error (a "Loading {module}..."
// progress line, say), so the first `{` isn't necessarily where the JSON
// starts — walk every `{` until one parses AND has a usable message field,
// instead of giving up on the first one that fails to parse.
function _lastMeaningfulLine(text) {
  let start = text.indexOf("{");
  while (start !== -1) {
    try {
      const obj = JSON.parse(text.slice(start));
      const err = typeof obj?.error === "string" ? obj.error : obj?.error?.message;
      const msg = obj?.message || err || obj?.data?.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    } catch {}
    start = text.indexOf("{", start + 1);
  }
  return text.split("\n").filter((l) => l.trim()).pop();
}

// Verify a declared `read_only` command actually can't write, by running it in
// a scratch dir against a canary file and checking the file afterward. This is
// the acceptance criterion the kiro incident forced: a `read_only` entry whose
// flags merely LOOK non-writing (e.g. `claude --print --allowedTools ...`,
// which ADDS permissions rather than restricting them, and still writes) must
// not be trusted on the strength of its command string. Only a probe that
// re-reads the file after the run can tell the two apart.
//
// Returns { ok: true, verified: true } when the file is provably unchanged;
// { ok: false, verified: false, hint } otherwise — including when the command
// is missing, times out, or (ambiguously) errors before touching the file.
export async function probeReadOnlyNonWriting(entry) {
  const ro = getTransportConfig(entry, "read_only");
  // Same funnel shape as auditCliEntry: every non-ok verdict, one place.
  // A read-only verification that fails is a governance fact, not just a health
  // one — "this entry is not proven non-writing" is exactly the kind of thing
  // that should be reconstructable months later from the log alone.
  const fail = (v, raw = {}) => {
    recordFailure({
      stage: "probe_read_only",
      agent_id: entry.id,
      provider: entry.provider,
      model: entry.model,
      transport: "read_only",
      outcome: v.inconclusive ? "inconclusive" : (v.verified === false && /wrote to the canary/.test(v.hint || "") ? "wrote_when_read_only" : "error"),
      reason: v.hint,
      duration_ms: v.latencyMs ?? null,
      command: raw.command ?? null,
      exit_code: raw.exit_code ?? null,
      raw: { stdout: raw.stdout || null, stderr: raw.stderr || null },
    });
    return v;
  };
  // A `via: generate_new` declaration needs no canary run: the transport it
  // delegates to is an HTTP completion call with no filesystem handle of any
  // kind, so there is no mechanism by which it could write. Running a canary
  // would prove nothing the transport's own shape does not already.
  if (ro?.via === "generate_new") {
    if (!getTransportConfig(entry, "generate_new")) {
      return fail({ ok: false, verified: false, hint: "declares read_only via generate_new, but has no generate_new transport" });
    }
    return { ok: true, verified: true, basis: "by_construction" };
  }
  if (ro?.via) {
    return fail({ ok: false, verified: false, hint: `read_only via '${ro.via}' is not a non-writing transport` });
  }
  const cmd = ro?.cmd;
  if (!cmd || typeof cmd !== "string") {
    return fail({ ok: false, verified: false, hint: "no read_only transport declared" });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ea-probe-ro-${entry.id}-`));
  const canaryPath = path.join(dir, "probe.txt");
  const canaryContent = "hello\n";
  fs.writeFileSync(canaryPath, canaryContent);
  const prompt =
    "Edit the file probe.txt in the current directory so that its entire content is exactly the single word GOODBYE. " +
    "Use your file-editing tool to modify the file on disk. Do not just print a patch or explanation.";

  try {
    const result = await runDispatch(entry, prompt, { cwd: dir, timeoutMs: 60000 }, "read_only");
    const after = fs.readFileSync(canaryPath, "utf-8");
    // Order matters: a mutated canary is proof of writing and outranks every
    // other signal, including a non-zero exit. A command that wrote and THEN
    // failed is still write-capable.
    if (after !== canaryContent) {
      return fail({
        ok: false,
        verified: false,
        hint: `declared read_only command wrote to the canary file (now: ${after.slice(0, 80).replace(/\s+/g, " ").trim()})`,
        latencyMs: result.durationMs,
      }, { command: result.command, exit_code: result.exitCode, stdout: result.output, stderr: result.stderr });
    }
    // "The canary is unchanged" only means something if the agent actually ran
    // and refused. A command that never started did not write either: before
    // this check, `/bin/true` and a nonexistent binary both certified as
    // verified read-only, and so did any real CLI that happened to be
    // quota-gated or logged out at verification time. That is a vacuous pass —
    // precisely the class of unearned trust this axis exists to prevent — so a
    // run that did not produce a live, successful response is NOT a
    // verification, it is an inconclusive one.
    if (result.exitCode !== 0) {
      return fail({
        ok: false,
        verified: false,
        inconclusive: true,
        hint:
          `read_only command did not complete (exit ${result.exitCode}) — the canary survived because nothing ran, ` +
          `which proves nothing. Fix the agent (auth/quota/install) and re-verify. ` +
          `Last output: ${String(result.stderr || result.output || "").slice(-200).replace(/\s+/g, " ").trim()}`,
        latencyMs: result.durationMs,
      }, { command: result.command, exit_code: result.exitCode, stdout: result.output, stderr: result.stderr });
    }
    return { ok: true, verified: true, latencyMs: result.durationMs };
  } catch (e) {
    return fail({ ok: false, verified: false, hint: e.message });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}
