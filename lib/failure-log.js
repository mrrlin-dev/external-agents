import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// ---------------------------------------------------------------------------
// Sidecar failure log — opt-in, operator-scoped, never on by default.
//
// The dispatch log (dispatch-log.jsonl) exists for AGGREGATION: one small row
// per call, error text clipped to the last 400 characters so `get_stats` and
// the dashboard stay cheap to read. That clip is exactly wrong for the other
// job — handing a failure to a model and asking it what to fix. A 400-char
// tail routinely cuts off the stack trace, the provider's JSON error body, the
// missing-flag line, the PATH that was wrong. So this is a SIDECAR: a second,
// wider sink that records only failures, and records them whole.
//
// Off unless the operator turns it on, because it is verbose and because raw
// provider output is not something a shared tool should start writing to disk
// on its own.
//
// WHERE THE FLAG LIVES, and why it is a file
//
//   ~/.local/state/external-agents/config.json
//
// not a file inside the package. `npm i -g @mrrlin-dev/external-agents@latest`
// replaces the package directory wholesale; anything configured in there is
// gone on the next release. The state directory is the operator's, not the
// package's, so the switch survives upgrades — which is the whole point of
// having a switch rather than an env var you have to remember to re-export.
// `EXTERNAL_AGENTS_FAILURE_LOG=1|0` still overrides it for a single run.
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), ".local", "state", "external-agents");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const FAILURE_LOG = path.join(STATE_DIR, "failures.jsonl");
const ROTATED_LOG = path.join(STATE_DIR, "failures.1.jsonl");

export const SCHEMA = "external-agents/failure/1";

// Per raw stream (stdout and stderr are capped separately). 256 KiB is far
// above any real CLI's error output while still bounding a runaway process
// that printed a progress bar for nine minutes.
const DEFAULT_MAX_RAW_BYTES = 256 * 1024;
// One rotation, then the old generation is dropped. Two files of 32 MiB is a
// bounded cost the operator does not have to think about; a log that grows
// without limit is one they eventually have to clean up by hand.
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;

const DEFAULTS = {
  enabled: false,
  max_raw_bytes: DEFAULT_MAX_RAW_BYTES,
  max_file_bytes: DEFAULT_MAX_FILE_BYTES,
  // Prompts are the operator's own text and often the most useful thing in a
  // failure report ("the model rejected THIS"), but they are also what can
  // carry source code into a file someone later pastes into a chat window. Off
  // by default: `prompt_text` is dropped and the prompt positional in the argv
  // becomes a byte count.
  //
  // This is NOT a guarantee that no prompt text reaches the file, and must not
  // be described as one. Plenty of CLIs echo the prompt back on stdout, and
  // `raw.stdout` is captured whole — that is the entire point of the sink. What
  // this setting controls is whether THIS TOOL writes the prompt down, not
  // whether the agent did.
  include_prompt: false,
};

export function getConfigPath() {
  return CONFIG_FILE;
}

/**
 * Where records are written. `EXTERNAL_AGENTS_FAILURE_LOG_FILE` moves it —
 * useful for pointing a single run's failures at a scratch file you intend to
 * paste somewhere, and required by this package's own tests, which must not
 * append to (or read around) the operator's real log while they run.
 */
export function getFailureLogPath() {
  const override = process.env.EXTERNAL_AGENTS_FAILURE_LOG_FILE;
  return override && override.trim() ? override.trim() : FAILURE_LOG;
}

export function getRotatedLogPath() {
  const active = getFailureLogPath();
  return active === FAILURE_LOG ? ROTATED_LOG : `${active}.1`;
}

function readConfigFile(file = CONFIG_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function envFlag(name) {
  const v = process.env[name];
  if (v == null || v === "") return undefined;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return undefined;
}

/**
 * Effective config: built-in defaults < config.json < environment.
 *
 * The environment wins so a single run can be traced without editing (and then
 * having to remember to un-edit) the persistent switch.
 */
export function readFailureLogConfig(options = {}) {
  const file = options.configFile || CONFIG_FILE;
  const fromFile = readConfigFile(file).failure_log;
  const merged = { ...DEFAULTS, ...(fromFile && typeof fromFile === "object" ? fromFile : {}) };

  const envEnabled = envFlag("EXTERNAL_AGENTS_FAILURE_LOG");
  if (envEnabled !== undefined) merged.enabled = envEnabled;
  const envPrompt = envFlag("EXTERNAL_AGENTS_FAILURE_LOG_PROMPT");
  if (envPrompt !== undefined) merged.include_prompt = envPrompt;
  const envRaw = Number(process.env.EXTERNAL_AGENTS_FAILURE_LOG_MAX_RAW_BYTES);
  if (Number.isFinite(envRaw) && envRaw > 0) merged.max_raw_bytes = envRaw;

  merged.enabled = merged.enabled === true;
  merged.include_prompt = merged.include_prompt === true;
  if (!Number.isFinite(merged.max_raw_bytes) || merged.max_raw_bytes <= 0) {
    merged.max_raw_bytes = DEFAULT_MAX_RAW_BYTES;
  }
  if (!Number.isFinite(merged.max_file_bytes) || merged.max_file_bytes <= 0) {
    merged.max_file_bytes = DEFAULT_MAX_FILE_BYTES;
  }
  return merged;
}

export function isFailureLogEnabled(options = {}) {
  return readFailureLogConfig(options).enabled;
}

/**
 * Flip the persistent switch. Reads/rewrites the whole config object so an
 * unrelated key someone else put in there is preserved rather than clobbered.
 */
export function setFailureLogEnabled(enabled, options = {}) {
  const file = options.configFile || CONFIG_FILE;
  const current = readConfigFile(file);
  const next = {
    ...current,
    failure_log: { ...(current.failure_log || {}), enabled: enabled === true },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next.failure_log;
}

// ---------------------------------------------------------------------------
// Redaction
//
// This file is written so it can be pasted into a chat window. Everything that
// reaches it goes through here first.
//
// Two layers, and both are needed. The value-based layer is the accurate one:
// it takes the actual secrets this process is holding in its environment and
// blanks those exact strings, so a key echoed back inside a provider's own
// error message is caught even though nothing about its shape says "key". The
// pattern layer is the backstop for secrets this process never held — a token
// quoted in an error body, a key belonging to a different provider.
//
// What neither layer catches: a secret this process does not hold, in a format
// no pattern here recognises. An entropy heuristic was considered for that and
// rejected — hashes, UUIDs, commit SHAs and base64 payloads are all
// high-entropy and all things you actually want to read in a failure report, so
// it would shred the diagnostic value of the file to guard against a case the
// value layer already covers whenever the secret is one of this machine's own.
// ---------------------------------------------------------------------------

// Which environment variables are treated as holding a secret.
//
// This was END-ANCHORED once (`…|_KEY|TOKEN|SECRET)$`) and that was a real hole,
// not a theoretical one: the multi-key convention this pool is built around
// numbers its variables — GEMINI_API_KEY_3, GROQ_API_KEY_2,
// OPENROUTER_API_KEY_2 — and not one of those ends in KEY. Every key in a
// multi-provider setup, i.e. the setup this tool exists for, would have gone
// unredacted.
//
// Matching the bare substring instead would over-fire (AUTHOR contains AUTH,
// KEYBOARD contains KEY, and blanking their values would shred surrounding
// text), so the name is split into segments and each segment is compared whole,
// with any trailing digits stripped so KEY_2 still counts as KEY.
const SECRET_NAME_WORDS = new Set([
  "KEY", "KEYS", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASS",
  "CREDENTIAL", "CREDENTIALS", "AUTH", "BEARER", "SESSION", "COOKIE", "PRIVATE",
  "PASSPHRASE",
]);

// Segment matching still misses the undelimited forms — MYAPIKEY, DEEPSEEKTOKEN
// — which are one word to the splitter above, so a substring pass backs it up.
//
// That pass applies ONLY to names with no delimiter at all. Any name that HAS
// delimiters was already judged correctly, segment by segment, and running a
// substring check over it as well would do nothing but manufacture false
// positives: SECRETARY_EMAIL and TOKENIZERS_PARALLELISM both contain a secret
// word and neither is one. Restricting the pass to the case it was added for
// keeps the fix and drops the collateral.
const SECRET_NAME_SUBSTRINGS = ["APIKEY", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "TOKEN"];

export function isSecretEnvName(name) {
  const upper = String(name).toUpperCase();
  const segments = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  if (segments.some((segment) => SECRET_NAME_WORDS.has(segment.replace(/\d+$/, "")))) return true;
  if (segments.length !== 1) return false;
  return SECRET_NAME_SUBSTRINGS.some((word) => segments[0].includes(word));
}
// Below this length a "secret" is more likely to be a placeholder or a word
// that happens to live in a key-shaped variable, and blanking every occurrence
// of a 6-character string would shred the surrounding text.
const MIN_SECRET_LENGTH = 12;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function secretsFromEnv(env = process.env) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
    if (!isSecretEnvName(name)) continue;
    out.push([name, value]);
  }
  // Longest first: if two variables hold overlapping values, blanking the
  // longer one first stops the shorter one from carving it into fragments.
  out.sort((a, b) => b[1].length - a[1].length);
  return out;
}

/**
 * @param {string} text
 * @param {Record<string,string>} [env]
 */
export function redact(text, env = process.env) {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  for (const [name, value] of secretsFromEnv(env)) {
    out = out.replace(new RegExp(escapeRegExp(value), "g"), `«redacted:${name}»`);
  }
  out = out
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, "«redacted:key-like»")
    .replace(/\bgsk_[A-Za-z0-9_-]{16,}/g, "«redacted:key-like»")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "«redacted:key-like»")
    .replace(/\bghp_[A-Za-z0-9]{20,}/g, "«redacted:key-like»")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 «redacted:auth-header»")
    .replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token|x-api-key)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi,
      (_m, lead) => `${lead}«redacted:key-like»`);
  return out;
}

/**
 * Cap a raw stream, keeping BOTH ends.
 *
 * A plain `.slice(-N)` (what the dispatch log does) loses the invocation and
 * the first error; a plain head loses the exception. For diagnosis the head
 * and the tail are the two halves that matter and the middle is the progress
 * spinner, so an over-long stream is elided in the middle and says so.
 */
export function capRaw(text, maxBytes) {
  if (typeof text !== "string") return text == null ? null : String(text);
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const buf = Buffer.from(text, "utf-8");
  // Cutting a Buffer at an arbitrary offset lands mid-character often enough to
  // matter — a UTF-8 sequence split across the boundary decodes to U+FFFD on
  // both sides. A StringDecoder holds the partial sequence back instead, so the
  // head ends on a character boundary; for the tail the same problem is at the
  // FRONT, so the leading replacement char (if the cut landed inside one) is
  // dropped rather than shown.
  const head = new StringDecoder("utf-8").write(buf.subarray(0, half));
  const tail = buf.subarray(buf.length - half).toString("utf-8").replace(/^\uFFFD+/, "");
  return `${head}\n\n…«${bytes - maxBytes} bytes elided from the middle»…\n\n${tail}`;
}

/**
 * argv with the prompt positional replaced by its size, unless the operator
 * asked for prompts. Everything that survives is still redacted: a few
 * registry entries pass credentials as flags rather than env.
 */
export function sanitizeArgv(argv, prompt, includePrompt, env = process.env) {
  if (!Array.isArray(argv)) return null;
  return argv.map((a) => {
    const s = String(a);
    if (!includePrompt && prompt && s === prompt) {
      return `«prompt elided: ${Buffer.byteLength(prompt, "utf-8")} bytes»`;
    }
    return redact(s, env);
  });
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

function rotateIfNeeded(file, maxBytes) {
  try {
    const { size } = fs.statSync(file);
    if (size < maxBytes) return;
    fs.renameSync(file, file === FAILURE_LOG ? ROTATED_LOG : `${file}.1`);
  } catch { /* no file yet, or a racing rotation already moved it */ }
}

/**
 * Append one failure record. Best-effort by construction: a telemetry sink
 * that can fail a dispatch is worse than no sink at all, so every error here
 * is swallowed after one line on stderr.
 *
 * Returns the record that was written (or null when disabled/failed), which is
 * what the tests assert against.
 */
export function recordFailure(record, options = {}) {
  const cfg = options.config || readFailureLogConfig(options);
  if (!cfg.enabled) return null;
  const file = options.file || getFailureLogPath();
  const env = options.env || process.env;

  try {
    const now = Date.now();
    const raw = record.raw || {};
    const row = {
      schema: SCHEMA,
      ts: Math.floor(now / 1000),
      iso: new Date(now).toISOString(),
      pid: process.pid,
      ...record,
      // Rebuilt rather than spread so a caller cannot accidentally ship an
      // unredacted stream by passing one through.
      raw: {
        stdout: raw.stdout ? capRaw(redact(String(raw.stdout), env), cfg.max_raw_bytes) : null,
        stderr: raw.stderr ? capRaw(redact(String(raw.stderr), env), cfg.max_raw_bytes) : null,
        body: raw.body ? capRaw(redact(String(raw.body), env), cfg.max_raw_bytes) : null,
      },
    };
    if (row.reason) row.reason = redact(String(row.reason), env);
    if (row.command?.argv) {
      row.command = {
        ...row.command,
        argv: sanitizeArgv(row.command.argv, record.prompt_text, cfg.include_prompt, env),
      };
    }
    if (record.prompt_text != null) {
      if (cfg.include_prompt) row.prompt_text = redact(String(record.prompt_text), env);
      else delete row.prompt_text;
    }

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    rotateIfNeeded(file, cfg.max_file_bytes);
    // Backstop. The per-field passes above cover every field this module knows
    // about; this one covers the fields it does not — a provider echoing a
    // token inside a response header, a future caller adding a key to the
    // record shape and forgetting. Redacting the serialised line catches those
    // without anyone having to remember to.
    fs.appendFileSync(file, redact(JSON.stringify(row), env) + "\n", { mode: 0o600 });
    return row;
  } catch (e) {
    console.error(`external-agents: failure-log write failed: ${e.message}`);
    return null;
  }
}

/** Read back the last `limit` records. Used by `external-agents failures tail`. */
export function readFailures(limit = 20, options = {}) {
  const file = options.file || getFailureLogPath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line from a killed append */ }
  }
  return limit > 0 ? rows.slice(-limit) : rows;
}
