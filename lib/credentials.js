// Persistent credential store for external-agents.
//
// Backing file: ~/.local/state/external-agents/keys.env (mode 0600, one
// KEY=value per line, no quotes). This is the ONLY store bootEnv reads. It
// used to also fall back to two legacy per-provider stores (Kilo's
// auth.json for DeepSeek, Simon Willison's llm CLI keys for Gemini) — removed
// because the Gemini fallback's guard, "only borrow the llm-store key if
// GEMINI_API_KEY doesn't look like an AI-Studio key (start with AIza)", fired
// on every boot: the key persisted through this store's own `set-credential`
// used a different Google credential format (`AQ.A…`), so it never matched
// the prefix and was silently overwritten by whatever key `llm` had cached
// from a completely separate setup. An operator who rotated their key here had
// no way to know it was not the one actually being used.
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

// Populate process.env from keys.env alone. Never overrides an already-set
// env var — a value the operator exported in their own shell always wins.
// Same logic in server.js and cli.js used to drift; this is the single source
// of truth now.
export function bootEnv() {
  try {
    const persisted = loadKeysFile();
    for (const [k, v] of Object.entries(persisted)) {
      if (!process.env[k]) process.env[k] = v;
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
