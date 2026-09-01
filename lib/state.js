import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { observedFromResponse, mergeObserved } from "./budget.js";

const STATE_DIR = path.join(os.homedir(), ".local", "state", "external-agents");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOCK_DIR = path.join(STATE_DIR, ".lock");

export function getStatePath() {
  return STATE_FILE;
}

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function acquireLock() {
  for (let i = 0; i < 500; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const wait = spawnSync("/bin/sh", ["-c", "sleep 0.02"]);
      if (wait.error) throw wait.error;
    }
  }
  return false;
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch {}
}

export function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Fields that a write must never erase by accident.
//
// `writeState` merges per id by REPLACE, which is right for a verdict — a fresh
// probe result should not inherit half of a stale one. It is wrong for anything
// the record KNEW rather than concluded:
//
//   enabled          — the operator's kill switch, not an observation.
//   observed_limits  — a measurement of this key's real ceiling, good for weeks
//                      (lib/budget.js). A verdict-only writer that does not know
//                      the field exists drops it, and `pick` goes straight back
//                      to guessing.
//   health           — the long-horizon success counters behind the quarantine.
//                      Dropping them silently resets an agent's "never answered
//                      in N tries" progress to zero.
//
// Reproduced live while smoke-testing the ledger: a dispatch wrote
// `observed_limits {tpm: 5000}` for one agent and 38 seconds later a concurrent
// write from an older build replaced the record wholesale and the measurement was
// gone. Carrying it HERE rather than at each call site is what makes that
// unreachable — including for writers that predate the field and any added later.
//
// `observed_budget` is deliberately NOT in this list: it describes one 60-second
// window and expires on its own (BUDGET_TTL_S), so restoring it onto an unrelated
// write would only keep a dead number alive a little longer.
export const CARRY_FORWARD_FIELDS = ["enabled", "observed_limits", "limits_unreported", "health"];

// Measured fields where the NEWER observation wins, compared by `seen_at`.
//
// A patch is not automatically newer than what is on disk, and assuming it was
// is a real bug this had. Every writer builds its observation from the response
// of the call that just finished — so the observation is fresh at the moment it
// is BUILT — but `acquireLock` will wait up to ten seconds. A dispatch that
// returned at T=100 can therefore be blocked until T=106 and write its
// `seen_at: 100` observation on top of one made at T=105 by a dispatch to the
// same agent that got the lock first.
//
// For `observed_limits` the damage is usually nil, because a ceiling rarely moves
// between two calls. For `observed_budget` it is not: that field is REPLACED
// wholesale, the values genuinely differ call to call, and a stale
// `remaining_tokens: 0` landing on top of a fresh `remaining_tokens: 4000` takes
// a healthy seat out of `pick` for the whole 120s TTL. Same root cause, so both
// are compared.
//
// Only `seen_at` is trusted, and only when the on-disk side has one: an
// observation that cannot say WHEN it was made is not evidence about now — the
// same rule effectiveCooldownUntil applies to a verdict with no timestamp.
export const NEWEST_WINS_FIELDS = new Set(["observed_limits", "observed_budget"]);

/**
 * Reconciles the fields above against `current`.
 *
 * MUTATES `merged` in place (and returns it for convenience); reads `current` and
 * `patch` without touching them. Only ids that appear in `patch` are reconciled —
 * everything else in `merged` keeps whatever it inherited from `current`, which is
 * the intent: a write says nothing about the agents it does not mention.
 *
 * Runs inside writeState's lock, which is the only reason it can see the newest
 * value at all.
 */
export function applyCarryForward(merged, current, patch) {
  for (const [id, rec] of Object.entries(patch || {})) {
    if (!rec || typeof rec !== "object") continue;
    const cur = current?.[id];
    const overlay = {};

    for (const field of CARRY_FORWARD_FIELDS) {
      if (field in rec) continue;                          // the patch is explicit; respect it
      if (cur && field in cur) overlay[field] = cur[field];
    }

    for (const field of NEWEST_WINS_FIELDS) {
      if (!(field in rec)) continue;                       // silence handled above
      if (!cur || !(field in cur)) continue;               // nothing to compare against
      const incoming = Number(rec[field]?.seen_at);
      const onDisk = Number(cur[field]?.seen_at);
      if (!Number.isFinite(onDisk)) continue;              // undated: the patch stands
      if (!Number.isFinite(incoming) || onDisk > incoming) overlay[field] = cur[field];
    }

    if (Object.keys(overlay).length > 0) merged[id] = { ...rec, ...overlay };
  }
  return merged;
}

export function writeState(patch) {
  ensureDir();
  const gotLock = acquireLock();
  try {
    const current = readState();
    const merged = { ...current, ...patch };
    // The merge above is per-id REPLACE, which is right for a verdict and wrong
    // for a measurement. See CARRY_FORWARD_FIELDS for which fields survive it
    // and why — the original case was `enabled`, where a single `probe` silently
    // reverted an operator toggle.
    applyCarryForward(merged, current, patch);
    const tmp = STATE_FILE + ".tmp." + process.pid + "." + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    return merged;
  } finally {
    if (gotLock) releaseLock();
  }
}

const EXPIRED_COOLDOWN_STATES = new Set(["quota_exhausted", "rate_limited", "errored_transient"]);

// How long an `errored_transient` verdict is allowed to keep an entry out of
// pick before it must be re-proven.
//
// It used to be forever. quota_exhausted/rate_limited were the only outcomes
// that ever recorded `cooldown_until`, and pick.js only lets a non-healthy
// entry back in once a cooldown has ELAPSED — so an entry that failed once for
// a transient reason (a 5xx, a timeout, a probe spawned with a broken PATH) was
// filtered out permanently, until somebody noticed and re-probed it by hand.
// Nobody notices: the entry simply stops being offered, and the pool silently
// degrades to whatever else is left. That is the opposite of what "transient"
// means, and it is how a panel ends up seated entirely on weak models without
// anybody choosing that.
//
// 15 minutes: long enough that a provider having a bad minute isn't retried
// into the ground, short enough that a stale verdict cannot quietly shape a
// whole session's routing.
export const ERRORED_TRANSIENT_TTL_S = 900;

// The moment a non-healthy record stops being binding, or null if it never
// does. Normally that is the recorded `cooldown_until`; for errored_transient
// it falls back to `checked + ERRORED_TRANSIENT_TTL_S`, which is what makes
// the rule apply to records ALREADY written without a cooldown — no migration,
// no rewrite of state.json, the expiry is simply derived on read.
//
// Single source of truth on purpose: pick.js (eligibility) and
// deriveDisplayState (what the dashboard shows) must not be able to disagree
// about whether a record is still binding.
export function effectiveCooldownUntil(record) {
  if (!record || typeof record !== "object") return null;
  if (record.cooldown_until != null) return record.cooldown_until;
  if (record.state !== "errored_transient") return null;
  if (record.checked) return record.checked + ERRORED_TRANSIENT_TTL_S;
  // No cooldown AND no timestamp. Every writer in this codebase sets at least
  // one (outcome.js writes both; mergeAuditState guarantees a cooldown even
  // when the caller omits `checked`), so this is a hand-edited or
  // foreign-written record. Treat it as already expired rather than as binding:
  // a verdict that cannot say WHEN it applied is not evidence about now, and
  // the alternative is the exact permanent exclusion this function exists to
  // abolish. The next probe will write a real record either way.
  return 0;
}

// UI-facing state normalization. Persisted records stay unchanged; when a
// cooldown has already elapsed we surface a derived "need_check" state so the
// dashboard does not look stuck on an old outage/quota timestamp.
export function deriveDisplayState(record, now = Math.floor(Date.now() / 1000)) {
  if (!record || typeof record !== "object") return record;
  if (!EXPIRED_COOLDOWN_STATES.has(record.state)) return record;
  const expiresAt = effectiveCooldownUntil(record);
  if (expiresAt == null || now < expiresAt) return record;
  return {
    ...record,
    state: "need_check",
    stale_state: record.state,
    note: record.note
      ? `${record.note} Cooldown expired; run probe to confirm recovery.`
      : "Cooldown expired; run probe to confirm recovery.",
  };
}

// Outcomes that come with an expiry rather than standing until a human
// intervenes. errored_transient joined this set for the reason spelled out at
// ERRORED_TRANSIENT_TTL_S: it is by definition a verdict about a moment, and a
// verdict about a moment must not outlive the moment.
const COOLDOWN_OUTCOMES = new Set(["quota_exhausted", "rate_limited", "errored_transient"]);

// The cooldown an audit/verify outcome should be recorded with. Lives here so
// the CLI `audit` loop and the dashboard's /api/audit cannot drift apart —
// they carried two copies of this expression, and only one of them would have
// been updated when errored_transient started needing a TTL.
//
// `source` tags whether the reset time was actually parsed out of the
// provider's error body or is a flat-TTL guess, so the UI can present an
// estimate as an estimate.
export function auditCooldown(outcome, verifyResult = {}, now = Math.floor(Date.now() / 1000)) {
  if (!COOLDOWN_OUTCOMES.has(outcome)) return { cooldown_until: undefined, source: undefined };
  if (outcome === "errored_transient") {
    // No provider ever reports "come back in N seconds" for a generic failure,
    // so this is always our own TTL, never parsed.
    return { cooldown_until: now + ERRORED_TRANSIENT_TTL_S, source: "fallback_ttl" };
  }
  return verifyResult.reset_at != null
    ? { cooldown_until: verifyResult.reset_at, source: "error_body" }
    : { cooldown_until: now + 3600, source: "fallback_ttl" };
}

export function mergeAuditState(existing, { outcome, note, checked, cooldown_until, source, verifyResult }) {
  const limited = COOLDOWN_OUTCOMES.has(outcome);
  const { cooldown_until: _cooldownUntil, source: _source, ...rest } = existing || {};
  // An errored_transient record must never leave here without an expiry. Making
  // that true HERE rather than trusting every call site is the point: the
  // open-ended verdict this guards against was created by exactly one call site
  // omitting a field the others set, and it stayed invisible for as long as it
  // did because nothing forced the invariant at the place the record is built.
  const cooldownFields = (limited && outcome === "errored_transient" && cooldown_until == null)
    ? {
        cooldown_until: (checked ?? Math.floor(Date.now() / 1000)) + ERRORED_TRANSIENT_TTL_S,
        source: "fallback_ttl",
      }
    : { cooldown_until, source };
  const now = checked ?? Math.floor(Date.now() / 1000);
  // An audit is a REAL call, so it teaches the same two things a dispatch does.
  //
  // Limits: verifyCredential pings with `max_tokens: 1` and the response carries
  // the provider's whole rate-limit header set, which makes `audit` a
  // limits-discovery pass. A fresh install learns every ceiling it has for the
  // price of a probe it was already running, instead of discovering them one
  // HTTP 413 at a time — measured 251 of those, every one predictable.
  //
  // Quarantine: a healthy verdict is proof the model answered, which is exactly
  // the evidence `quarantineReason` asks for. So `audit` is the documented way
  // to bring a quarantined seat back, and it works without a special case.
  const observed = observedFromResponse({
    headers: verifyResult?.responseHeaders,
    bodyText: verifyResult?.body ?? verifyResult?.hint,
    now,
  });
  const base = {
    ...(limited ? (existing || {}) : rest),
    ...(outcome === "healthy" ? { consecutive_failures: 0 } : {}),
    state: outcome,
    note,
    checked,
    ...(limited ? cooldownFields : {}),
  };
  const healed = outcome === "healthy"
    ? { health: { ...(existing?.health || {}), attempts_since_ok: 0, ever_ok: true, last_ok_at: now } }
    : {};
  return { ...mergeObserved(base, observed), ...healed };
}

// Reset cooldowns for every agent that uses `envName` as its credential.
// Called after `set-credential` so a new key immediately makes the affected
// agents eligible for dispatch instead of waiting out a stale cooldown.
export function resetCooldownsForEnvVar(envName, agents) {
  const ids = [];
  for (const a of agents) {
    const authEnv = typeof a.auth === "string" && a.auth.startsWith("env:") ? a.auth.slice(4).split(/\s+/)[0] : null;
    const genEnv = a.transports?.generate_new?.env || null;
    if (authEnv === envName || genEnv === envName) ids.push(a.id);
  }
  if (ids.length === 0) return [];
  const now = Math.floor(Date.now() / 1000);
  const patch = {};
  const current = readState();
  for (const id of ids) {
    const prev = current[id];
    if (!prev || prev.state === "healthy") continue;
    const { cooldown_until: _, ...rest } = prev;
    patch[id] = { ...rest, state: "healthy", consecutive_failures: 0, checked: now };
  }
  if (Object.keys(patch).length > 0) writeState(patch);
  return Object.keys(patch);
}

// Flip on the entries that were shipped off-by-default *pending their key*.
// `enabled: false` in the registry means two different things — "paid, opt in
// deliberately" (gemini-3.1-pro-preview-2) and "useless until a credential
// exists" (DeepSeek, whose API is prepaid: bundling it enabled would put an
// entry in every fresh install's list that can never answer). Only the second
// kind carries `enable_on_credential: true`, and only that kind is turned on
// here, by writing the state.json layer that pick.js already lets override a
// registry default. Removing the key does not flip it back — that's the
// operator's explicit toggle to make.
//
// This is a ONE-TIME bootstrap flip, not a standing sync: it must never
// re-flip an entry the operator has already made a decision about, in either
// direction. The guard is therefore "does state.json have an `enabled` key at
// all for this id", not "is it already true" — the latter let a REPEATED call
// for the same envName (key rotation, `set-credential` run again, a second
// setup pass) silently re-enable an entry the operator had explicitly turned
// off via `/api/toggle`, since an explicit `false` and "never touched" both
// read as falsy. Reproduced live: disable via toggle, re-run `set-credential`
// for the same key, `enabled` flips back to `true` with no operator action.
export function enableAgentsAwaitingCredential(envName, agents) {
  const patch = {};
  const current = readState();
  for (const a of agents) {
    if (a.enabled !== false || a.enable_on_credential !== true) continue;
    const authEnv = typeof a.auth === "string" && a.auth.startsWith("env:") ? a.auth.slice(4).split(/\s+/)[0] : null;
    const genEnv = a.transports?.generate_new?.env || null;
    if (authEnv !== envName && genEnv !== envName) continue;
    if (current[a.id] && Object.prototype.hasOwnProperty.call(current[a.id], "enabled")) continue;
    patch[a.id] = { ...(current[a.id] || {}), enabled: true };
  }
  if (Object.keys(patch).length > 0) writeState(patch);
  return Object.keys(patch);
}

// Probe an agent's usability. Transport-aware — if EITHER transport is usable,
// the entry is healthy. This is important because most economy-flow entries
// (Groq, Cerebras, OpenRouter, Gemini, DeepSeek, etc.) work via generate_new
// (native fetch, no binary needed) and do not require a CLI transport.
// A native-fetch-capable entry remains usable when its optional direct CLI is
// unavailable, preserving the "just paste API keys and go" flow.
//
// Precedence:
//   1. generate_new usable (URL configured + env var set OR Ollama sentinel)
//      → healthy. A CLI is not required.
//   2. edit_exists usable (binary on PATH + auth satisfied) → healthy.
//   3. Neither → the more informative failure wins (needs_auth > not_installed).
// The edit_exists command may be prefixed with `env -u VAR1 -u VAR2 ...` to
// strip inherited environment variables before running the real CLI (used by
// claude-opus-5/claude-sonnet-5/claude-haiku-4-5 to avoid an outer
// ANTHROPIC_BASE_URL hijacking auth — see 0.14.0). Naively taking the first
// whitespace-split token would check `command -v env` (always present),
// reporting "healthy" regardless of whether the actual CLI is installed.
// This walks past a leading `env` token and its `-u NAME` pairs to find the
// real binary name.
function realBinaryOf(cmd) {
  const tokens = cmd.trim().split(/\s+/);
  let i = 0;
  if (tokens[i] === "env") {
    i++;
    while (tokens[i] === "-u" || tokens[i] === "-i") {
      i += tokens[i] === "-u" ? 2 : 1;
    }
    // Skip any bare NAME=value assignments env also accepts before the command.
    while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  }
  return tokens[i] || tokens[0];
}

export function probeInstalled(agentEntry) {
  const auth = agentEntry.auth || "";
  const gen = agentEntry.transports?.generate_new;
  // edit_exists is either the legacy bare command string or a map
  // ({ cmd, effort_levels, effort_flag, ... }) since 0.33.0. Normalize to the
  // command string here so every check below keeps working on both forms.
  const cliTransport = agentEntry.transports?.edit_exists;
  const cli = typeof cliTransport === "string" ? cliTransport : (cliTransport?.cmd ?? null);
  if (!gen && !cli) return { state: "errored_transient", note: "no transport declared" };

  // Resolve per-entry env overrides once (used by both transport checks).
  const envOverrideReady = (() => {
    if (!agentEntry.env || typeof agentEntry.env !== "object") return { ok: true, note: null };
    for (const [k, v] of Object.entries(agentEntry.env)) {
      if (typeof v === "string" && v.startsWith("@file:")) {
        let p = v.slice("@file:".length);
        if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
        try {
          const s = fs.statSync(p);
          if (!s.isFile()) throw new Error("not a regular file");
        } catch (e) {
          return { ok: false, note: `env override ${k}: cannot read ${p}` };
        }
      }
    }
    return { ok: true, note: null };
  })();

  // ---- Attempt (1): generate_new transport is usable ---------------------
  if (gen && gen.url) {
    const genEnv = gen.env;
    const isOllama = genEnv === "OLLAMA_UNUSED_KEY";
    // A localhost/127.0.0.1 URL is a LOCAL DAEMON (e.g. Ollama), not a hosted
    // API. "No API key required" does NOT mean "ready" — the daemon has to be
    // running, which at minimum requires its CLI installed. Previously the
    // OLLAMA_UNUSED_KEY sentinel short-circuited straight to healthy even in a
    // container where ollama was never installed — a false positive of the
    // same class as the env-prefix binary bug. For a local-daemon entry whose
    // auth is cli-based, require the CLI binary present before Attempt (1) can
    // report healthy; otherwise fall through to the cli/not_installed paths.
    const isLocalDaemon = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(gen.url);
    if (isLocalDaemon && typeof auth === "string" && auth.startsWith("cli:")) {
      const daemonBin = auth.slice("cli:".length).split(/\s+/)[0];
      const present = spawnSync("command", ["-v", daemonBin], { shell: "/bin/bash" }).status === 0;
      if (!present) {
        return { state: "not_installed", note: `local daemon not installed: ${daemonBin} (needs the ${daemonBin} CLI + a running daemon)` };
      }
      return { state: "healthy", note: `${daemonBin} daemon CLI present (local generate_new)` };
    }
    const envSatisfied = isOllama
      || !genEnv                                             // no env → no auth wall
      || (agentEntry.env && agentEntry.env[genEnv])          // per-entry override
      || !!process.env[genEnv];                              // process env
    if (envOverrideReady.ok && envSatisfied) {
      return {
        state: "healthy",
        note: isOllama || !genEnv
          ? `generate_new ready (no api key required)`
          : `generate_new ready (${genEnv} set)`,
      };
    }
  }

  // ---- Attempt (2): edit_exists transport is usable ----------------------
  if (cli && typeof cli === "string") {
    const bin = realBinaryOf(cli);
    const r = spawnSync("command", ["-v", bin], { shell: "/bin/bash" });
    if (r.status === 0) {
      if (!envOverrideReady.ok) return { state: "needs_auth", note: envOverrideReady.note };
      // Auth wall from the top-level `auth:` field.
      if (auth.startsWith("env:")) {
        // API-key CLI: the env var IS the credential. Present → healthy;
        // absent → needs_auth.
        const varName = auth.slice("env:".length).split(/\s+/)[0];
        if (!process.env[varName]) {
          return { state: "needs_auth", note: `env var ${varName} not set (paste via UI or run: external-agents set-credential ${varName})` };
        }
        return { state: "healthy", note: `binary present: ${bin}` };
      }
      if (auth.startsWith("cli:")) {
        // Subscription CLI (codex/claude/cursor/opencode/kiro): the binary
        // being installed does NOT prove the operator is logged in — codex
        // installed-but-unauthed returns 401 at dispatch, claude likewise.
        // A cheap sync probe can't reliably verify login state (each tool
        // stores auth differently — keychain, oauth file, etc), so it must
        // NOT optimistically report healthy. Report needs_auth with the login
        // step; a real Verify/audit (which actually runs the CLI) is what
        // promotes to healthy once the operator has logged in.
        const tool = auth.slice("cli:".length).split(/\s+/)[0];
        return { state: "needs_auth", note: `installed but not verified — run \`${tool} login\`, then click Verify` };
      }
      // No auth field declared → binary presence is all we can check.
      return { state: "healthy", note: `binary present: ${bin}` };
    }
  }

  // ---- Both attempts failed — pick the most informative failure ---------
  if (gen && gen.url && gen.env && gen.env !== "OLLAMA_UNUSED_KEY") {
    return {
      state: "needs_auth",
      note: `env var ${gen.env} not set (paste via UI or run: external-agents set-credential ${gen.env})`,
    };
  }
  if (cli) {
    const bin = realBinaryOf(cli);
    return { state: "not_installed", note: `binary missing: ${bin}` };
  }
  return { state: "errored_transient", note: "no usable transport" };
}
