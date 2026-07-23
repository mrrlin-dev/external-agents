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
    const tmp = STATE_FILE + ".tmp." + process.pid + "." + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    return merged;
  } finally {
    if (gotLock) releaseLock();
  }
}

// Probe an agent's usability. Transport-aware — if EITHER transport is usable,
// the entry is healthy. This is important because most economy-flow entries
// (Groq, Cerebras, OpenRouter, Gemini, DeepSeek, etc.) work via generate_new
// (native fetch, no binary needed) and do NOT require aider. Previously the
// probe short-circuited on aider-missing and marked everything not_installed
// even when the operator only wanted native fetch — that broke the "just
// paste API keys and go" flow on any host without aider installed.
//
// Precedence:
//   1. generate_new usable (URL configured + env var set OR Ollama sentinel)
//      → healthy. Aider is not required.
//   2. edit_exists usable (binary on PATH + auth satisfied) → healthy.
//   3. Neither → the more informative failure wins (needs_auth > not_installed).
// The edit_exists command may be prefixed with `env -u VAR1 -u VAR2 ...` to
// strip inherited environment variables before running the real CLI (used by
// claude-opus-4-*/claude-sonnet-5/claude-haiku-4-5 to avoid an outer
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
  const cli = agentEntry.transports?.edit_exists;
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
        // API-key CLI (e.g. aider): the env var IS the credential. Present →
        // healthy; absent → needs_auth.
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
