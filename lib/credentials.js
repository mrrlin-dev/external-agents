// Persistent credential store for external-agents.
//
// Backing file: ~/.local/state/external-agents/keys.env (mode 0600, one
// KEY=value per line, no quotes). This is the operator-facing store — it wins
// over legacy per-provider stores (Kilo's auth.json, Simon Willison's llm keys,
// per-entry @file: refs) at bootEnv time.
//
// Exposed as a plain module (no side effects at import time) so both the MCP
// server (server.js) and the CLI (cli.js) can import from here without spinning
// up an MCP transport.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KEYS_FILE = path.join(os.homedir(), ".local/state/external-agents/keys.env");

export function loadKeysFile() {
  try {
    if (!fs.existsSync(KEYS_FILE)) return {};
    const raw = fs.readFileSync(KEYS_FILE, "utf-8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1);
      if (k) out[k] = v;
    }
    return out;
  } catch (e) {
    console.error(`external-agents: WARN — keys.env unreadable: ${e.message}`);
    return {};
  }
}

export function saveKeysFile(kv) {
  const dir = path.dirname(KEYS_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = Object.entries(kv)
    .filter(([k, v]) => k && typeof v === "string")
    .map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const tmp = KEYS_FILE + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, KEYS_FILE);
}

// Populate process.env from all credential sources this package knows about,
// in priority order:
//   1. keys.env (UI-persisted / `set-credential` — operator's explicit choice)
//   2. Kilo auth store (~/.local/share/kilo/auth.json) — DeepSeek only
//   3. Simon Willison's llm CLI keys (~/Library/Application Support/io.datasette.llm/keys.json) — AI Studio Gemini
// Never overrides an already-set env var. Same logic in server.js and cli.js
// used to drift — this is the single source of truth now.
export function bootEnv() {
  try {
    // 1. UI-persisted / set-credential keys — highest priority
    const persisted = loadKeysFile();
    for (const [k, v] of Object.entries(persisted)) {
      if (!process.env[k]) process.env[k] = v;
    }
    // 2. Kilo auth store — DeepSeek key
    const kiloAuthPath = path.join(os.homedir(), ".local/share/kilo/auth.json");
    if (fs.existsSync(kiloAuthPath)) {
      const kiloAuth = JSON.parse(fs.readFileSync(kiloAuthPath, "utf-8"));
      if (!process.env.DEEPSEEK_API_KEY && kiloAuth.deepseek?.key) {
        process.env.DEEPSEEK_API_KEY = kiloAuth.deepseek.key;
      }
    }
    // 3. llm-key store — AI Studio Gemini `AIza...` key
    const llmKeysPath = path.join(os.homedir(), "Library/Application Support/io.datasette.llm/keys.json");
    if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_API_KEY.startsWith("AIza")) {
      if (fs.existsSync(llmKeysPath)) {
        const llmKeys = JSON.parse(fs.readFileSync(llmKeysPath, "utf-8"));
        if (llmKeys.gemini) process.env.GEMINI_API_KEY = llmKeys.gemini;
      }
    }
  } catch (e) {
    console.error(`external-agents: WARN — bootEnv failed: ${e.message}`);
  }
}

// Persist a credential to the keys.env store AND inject into the current
// process's env so subsequent calls in the same process see it. Returns the
// path the credential was persisted to so callers can report it back to the
// operator. Env-var-name is validated: SHOUTY_SNAKE_CASE only.
export function persistCredential(envName, value) {
  if (!envName || !/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    throw new Error(`invalid env var name: ${JSON.stringify(envName)} (expected SHOUTY_SNAKE_CASE)`);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("credential value must be a non-empty string");
  }
  const persisted = loadKeysFile();
  persisted[envName] = value;
  saveKeysFile(persisted);
  process.env[envName] = value;
  return KEYS_FILE;
}
