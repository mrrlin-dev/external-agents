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

export function probeInstalled(agentEntry) {
  const cliCmd = agentEntry?.transports?.edit_exists;
  if (!cliCmd || typeof cliCmd !== "string") {
    return { state: "errored_transient", note: "no cli transport" };
  }
  const bin = cliCmd.trim().split(/\s+/)[0];
  const r = spawnSync("command", ["-v", bin], { shell: "/bin/bash" });
  if (r.status !== 0) {
    return { state: "not_installed", note: `binary missing: ${bin}` };
  }

  // Binary present. Check auth prerequisites:
  //   - per-entry `env` override (with optional @file: refs) OR
  //   - `auth: "env:XXX"` — the var must be in process.env
  // If a per-entry env override is present, it takes precedence: we verify
  // every @file: reference resolves. Otherwise fall back to auth-field.
  const auth = agentEntry.auth || "";

  if (agentEntry.env && typeof agentEntry.env === "object") {
    for (const [k, v] of Object.entries(agentEntry.env)) {
      if (typeof v === "string" && v.startsWith("@file:")) {
        let p = v.slice("@file:".length);
        if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
        try {
          const s = fs.statSync(p);
          if (!s.isFile()) throw new Error("not a regular file");
        } catch (e) {
          return { state: "needs_auth", note: `env override ${k}: cannot read ${p}` };
        }
      }
    }
    return { state: "healthy", note: `binary present: ${bin}; per-entry env resolved` };
  }

  if (auth.startsWith("env:")) {
    const varName = auth.slice("env:".length).split(/\s+/)[0];
    if (!process.env[varName]) {
      return { state: "needs_auth", note: `env var ${varName} not set (add to shell or ADR-0016 store)` };
    }
  }

  // For entries with only generate transport (no cli), the "binary" is aider-agnostic
  // (native fetch). Also handle the Ollama sentinel — no real env var needed.
  const genEnv = agentEntry.transports?.generate_new?.env;
  if (genEnv && genEnv !== "OLLAMA_UNUSED_KEY" && !process.env[genEnv] && !(agentEntry.env && agentEntry.env[genEnv])) {
    // If we already passed the cli auth check above, this is a "generate needs its own env" case.
    // Skip when auth check already flagged the same var.
    if (!auth.startsWith("env:") || !auth.includes(genEnv)) {
      return { state: "needs_auth", note: `generate env var ${genEnv} not set` };
    }
  }

  return { state: "healthy", note: `binary present: ${bin}` };
}
