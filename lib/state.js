import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

export function writeState(patch) {
  ensureDir();
  const gotLock = acquireLock();
  try {
    const current = readState();
    const merged = { ...current, ...patch };
    // `enabled` is the operator's kill switch, not an observation, so it must
    // survive every write that merely reports what a probe/dispatch just saw.
    // The merge above is per-id REPLACE, and almost every caller builds its
    // patch from a fresh probe result — so a single `probe` silently reverted
    // a toggle, and for a registry-disabled entry that means turning it back
    // OFF. Carry the flag forward unless the patch names it explicitly (that's
    // how /api/toggle and enableAgentsAwaitingCredential actually change it).
    for (const [id, rec] of Object.entries(patch)) {
      if (!rec || typeof rec !== "object") continue;
      if ("enabled" in rec) continue;
      if (current[id] && "enabled" in current[id]) merged[id] = { ...rec, enabled: current[id].enabled };
    }
    const tmp = STATE_FILE + ".tmp." + process.pid + "." + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    return merged;
  } finally {
    if (gotLock) releaseLock();
  }
}

const EXPIRED_COOLDOWN_STATES = new Set(["quota_exhausted", "rate_limited", "errored_transient"]);

// UI-facing state normalization. Persisted records stay unchanged; when a
// cooldown has already elapsed we surface a derived "need_check" state so the
// dashboard does not look stuck on an old outage/quota timestamp.
export function deriveDisplayState(record, now = Math.floor(Date.now() / 1000)) {
  if (!record || typeof record !== "object") return record;
  if (!EXPIRED_COOLDOWN_STATES.has(record.state)) return record;
  if (record.cooldown_until == null || now < record.cooldown_until) return record;
  return {
    ...record,
    state: "need_check",
    stale_state: record.state,
    note: record.note
      ? `${record.note} Cooldown expired; run probe to confirm recovery.`
      : "Cooldown expired; run probe to confirm recovery.",
  };
}

export function mergeAuditState(existing, { outcome, note, checked, cooldown_until, source }) {
  const limited = outcome === "quota_exhausted" || outcome === "rate_limited";
  const { cooldown_until: _cooldownUntil, source: _source, ...rest } = existing || {};
  return {
    ...(limited ? (existing || {}) : rest),
    ...(outcome === "healthy" ? { consecutive_failures: 0 } : {}),
    state: outcome,
    note,
    checked,
    ...(limited ? { cooldown_until, source } : {}),
  };
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
