import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const AIDER_HEADLESS_FLAGS = [
  "--yes",
  "--no-git",
  "--no-auto-commits",
  "--no-check-update",
  "--no-show-model-warnings",
  "--no-analytics",
];

function isAiderCommand(tokens) {
  return tokens[0] === "aider";
}

function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
      if (name.startsWith(".aider")) continue;
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

const EXHAUSTION_RE = /quota|rate.?limit|429|too many requests|insufficient balance|resource[ _]?exhausted|usage limit|credits exhausted/i;

export function parseExhaustionSignal(text) {
  const detected = EXHAUSTION_RE.test(text);

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

export function runDispatch(agentEntry, prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300000;
  const cliCmd = agentEntry.transports?.edit_exists;
  if (!cliCmd || typeof cliCmd !== "string") {
    throw new Error(`runDispatch: no cli transport for ${agentEntry.id}`);
  }

  const parts = cliCmd.trim().split(/\s+/);
  const cmd = parts[0];

  // aider: prompt via --message flag + append headless flags. Otherwise: prompt as final positional.
  let args;
  if (isAiderCommand(parts)) {
    args = [...parts.slice(1), "--message", prompt, ...AIDER_HEADLESS_FLAGS];
  } else {
    args = [...parts.slice(1), prompt];
  }

  // Fresh temp cwd per call so file effects are isolated + collectable.
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `ea-dispatch-${agentEntry.id}-`));

  // Per-entry env overrides — applied ONLY to the subprocess, never to parent.
  const entryEnv = resolveEntryEnv(agentEntry.env);
  const childEnv = { ...process.env, ...entryEnv };

  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, { cwd: workdir, env: childEnv });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        output: stdout,
        stderr,
        exitCode: timedOut ? 124 : code,
        durationMs: Date.now() - start,
        workdir,
        files: listFiles(workdir),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        output: stdout,
        stderr: stderr + "\n" + err.message,
        exitCode: 1,
        durationMs: Date.now() - start,
        workdir,
        files: [],
      });
    });
  });
}

export function resolveEscalation(registry, sourceAgentId) {
  const source = registry.agents.find((a) => a.id === sourceAgentId);
  if (!source) return null;
  return registry.agents.find(
    (a) => a.id !== sourceAgentId && a.provider === source.provider && a.tier === "strong"
  ) || null;
}

/**
 * Pure-generation transport: hits an OpenAI-compatible /chat/completions
 * endpoint via native fetch, dumps the response content into a file in a
 * fresh temp workdir. NO agentic loop, NO tool use — the model outputs text,
 * we write text. Great for "generate the content of this file from spec"
 * tasks where aider's edit-oriented pipeline gets in the way.
 *
 * Registry shape expected:
 *   transports:
 *     generate:
 *       url:   "https://…/chat/completions"    # OpenAI-compat endpoint
 *       env:   "GEMINI_API_KEY"                # env var holding the Bearer key
 *       model: "gemini-3.5-flash"              # OPTIONAL — falls back to agentEntry.model
 *       output_filename: "generated.md"        # OPTIONAL — default "generated.md"
 */
export async function runGenerate(agentEntry, prompt, options = {}) {
  const g = agentEntry.transports?.generate_new;
  if (!g || typeof g !== "object") {
    throw new Error(`runGenerate: no generate transport for ${agentEntry.id}`);
  }
  if (!g.url) throw new Error(`runGenerate: transports.generate_new.url missing for ${agentEntry.id}`);
  const envName = g.env;
  let apiKey; // optional — Ollama and some local endpoints need no auth
  if (envName && envName !== "OLLAMA_UNUSED_KEY") {
    apiKey = process.env[envName];
    if (!apiKey) {
      return {
        output: "",
        stderr: `env var ${envName} not set`,
        exitCode: 1,
        durationMs: 0,
        workdir: fs.mkdtempSync(path.join(os.tmpdir(), `ea-gen-${agentEntry.id}-`)),
        files: [],
      };
    }
  }

  const model = g.model || agentEntry.model;
  if (!model) throw new Error(`runGenerate: no model set for ${agentEntry.id}`);

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `ea-gen-${agentEntry.id}-`));
  const filename = g.output_filename || "generated.md";
  const outPath = path.join(workdir, filename);

  const timeoutMs = options.timeoutMs ?? 300000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(g.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - start;

    const bodyText = await resp.text();
    if (!resp.ok) {
      return {
        output: bodyText,
        stderr: `HTTP ${resp.status} ${resp.statusText}`,
        exitCode: 1,
        durationMs,
        workdir,
        files: [],
        status: resp.status,
      };
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { output: bodyText, stderr: "non-JSON response", exitCode: 1, durationMs, workdir, files: [] };
    }
    const content = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage || {};
    fs.writeFileSync(outPath, content);

    return {
      output: content,
      stderr: "",
      exitCode: 0,
      durationMs,
      workdir,
      files: [{ path: filename, bytes: Buffer.byteLength(content, "utf-8") }],
      tokens_in: usage.prompt_tokens,
      tokens_out: usage.completion_tokens,
    };
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const timedOut = err?.name === "AbortError";
    return {
      output: "",
      stderr: err?.message || String(err),
      exitCode: timedOut ? 124 : 1,
      durationMs,
      workdir,
      files: [],
    };
  }
}

/**
 * Route to the right runner based on which transport the agent declares.
 *
 * Selection order:
 *   1. If options.transport is explicitly "generate_new" or "edit_exists", use that (error
 *      if the entry doesn't declare it). This is how callers override.
 *   2. Otherwise, prefer generate (simpler caller contract — a real file
 *      always lands in workdir), fall back to cli/aider (agentic).
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

export async function runAny(agentEntry, prompt, options = {}) {
  const forced = options.transport;
  let transport;
  let result;

  if (forced === "generate_new") {
    if (!agentEntry?.transports?.generate_new) {
      throw new Error(`runAny: transport 'generate' requested but not declared for ${agentEntry?.id}`);
    }
    transport = "generate_new";
    result = await runGenerate(agentEntry, prompt, options);
  } else if (forced === "edit_exists") {
    if (!agentEntry?.transports?.edit_exists) {
      throw new Error(`runAny: transport 'cli' requested but not declared for ${agentEntry?.id}`);
    }
    transport = "edit_exists";
    result = await runDispatch(agentEntry, prompt, options);
  } else if (agentEntry?.transports?.generate_new) {
    transport = "generate_new";
    result = await runGenerate(agentEntry, prompt, options);
  } else if (agentEntry?.transports?.edit_exists) {
    transport = "edit_exists";
    result = await runDispatch(agentEntry, prompt, options);
  } else {
    throw new Error(`runAny: no known transport for ${agentEntry?.id ?? "<unknown>"}`);
  }

  // Telemetry — one row per dispatch, best-effort.
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
    prompt_bytes: Buffer.byteLength(prompt || "", "utf-8"),
  });

  return { ...result, transport };
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
    const a = (by_agent[r.agent_id] ??= { count: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0, outcomes: {}, transports: {} });
    a.count++;
    a.tokens_in += r.tokens_in || 0;
    a.tokens_out += r.tokens_out || 0;
    a.duration_ms += r.duration_ms || 0;
    a.outcomes[r.outcome] = (a.outcomes[r.outcome] || 0) + 1;
    a.transports[r.transport] = (a.transports[r.transport] || 0) + 1;
    const t = (by_transport[r.transport] ??= { count: 0, tokens_in: 0, tokens_out: 0 });
    t.count++; t.tokens_in += r.tokens_in || 0; t.tokens_out += r.tokens_out || 0;
    if (r.ts < first) first = r.ts;
    if (r.ts > last) last = r.ts;
  }
  return {
    total: filtered.length,
    by_agent,
    by_transport,
    span: filtered.length ? { first_ts: first, last_ts: last } : {},
  };
}
