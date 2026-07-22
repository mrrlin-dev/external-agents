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
    const bin = cli.trim().split(/\s+/)[0];
    const r = spawnSync("command", ["-v", bin], { shell: "/bin/bash" });
    if (r.status === 0) {
      if (!envOverrideReady.ok) return { state: "needs_auth", note: envOverrideReady.note };
      // Auth wall from the top-level `auth:` field (subscription CLI vs env var).
      if (auth.startsWith("env:")) {
        const varName = auth.slice("env:".length).split(/\s+/)[0];
        if (!process.env[varName]) {
          return { state: "needs_auth", note: `env var ${varName} not set (paste via UI or run: external-agents set-credential ${varName})` };
        }
      }
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
    const bin = cli.trim().split(/\s+/)[0];
    return { state: "not_installed", note: `binary missing: ${bin}` };
  }
  return { state: "errored_transient", note: "no usable transport" };
}
