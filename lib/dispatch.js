import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExhaustionResetAt } from "./quota-reset.js";

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
 * Returns the assembled context string (empty string if no files or all unreadable).
 */
const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file — keeps prompt within provider token limits

export function resolveFileContext(files, basedir, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return "";
  const strictContainment = options.strictContainment === true;

  const resolvedBase = fs.existsSync(basedir || process.cwd())
    ? fs.realpathSync(path.resolve(basedir || process.cwd()))
    : path.resolve(basedir || process.cwd());
  const blocks = [];
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
      if (strictContainment) throw new Error(`runAny: cannot attach file ${entry.path}: outside basedir`);
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
      content = fs.readFileSync(realPath, "utf-8");
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

const EXHAUSTION_RE = /quota|rate.?limit|429|too many requests|insufficient balance|resource[ _]?exhausted|usage limit|credits exhausted|(?:agent|request) limit (?:has been )?reached|you(?:'|’)?ve (?:reached|hit).{0,60}(?:limit|quota)/i;

export function stripAnsi(text) {
  return String(text ?? "")
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><~])/g, "")
    .replace(/\u001B[\]\^_].*?(?:\u0007|\u001B\\)/gs, "");
}

export function classifyCliFailure(text) {
  const preview = stripAnsi(text);
  return {
    needsAuth: /not logged in|please run \/login|authorizationrequired|authentication failed|unauthenticated|401 unauthorized|please (?:sign |log )?in to use (?:cursor(?: agent)?)|cursor(?: agent)?.{0,80}(?:sign|log) in|please authenticate|no authentication token/i.test(preview),
    quotaExhausted: /monthly.{0,20}(request )?limit reached|usage limit|quota exhausted|hit your usage limit|(?:agent|request) limit (?:has been )?reached|you(?:'|’)?ve (?:reached|hit).{0,60}(?:limit|quota)|rate.?limit|too many requests/i.test(preview),
  };
}

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

export function runDispatch(agentEntry, prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? Number(process.env.EXTERNAL_AGENTS_TIMEOUT_MS || 500000);
  const cliTransport = getTransportConfig(agentEntry, "edit_exists");
  const cliCmd = cliTransport?.cmd;
  if (!cliCmd || typeof cliCmd !== "string") {
    throw new Error(`runDispatch: no cli transport for ${agentEntry.id}`);
  }

  const parts = cliCmd.trim().split(/\s+/);
  const cmd = parts[0];
  if (cmd === "aider") {
    throw new Error(
      `runDispatch: legacy aider transport is no longer supported for ${agentEntry.id}; use a direct CLI edit_exists entry instead`,
    );
  }
  const effortFlag = options.effort && cliTransport?.effort_flag
    ? cliTransport.effort_flag.replace("{level}", options.effort)
    : null;
  const effortParts = effortFlag ? effortFlag.trim().split(/\s+/) : [];

  // Direct CLIs receive the prompt as a final positional argument and can
  // inspect cwd themselves.
  const args = [...parts.slice(1), ...effortParts, prompt];

  // Where the agent runs: a caller-supplied cwd (e.g. a git worktree, edited
  // in place) or a fresh isolated temp dir. Throws on a bad cwd before spawn.
  const { workdir, external } = resolveDispatchWorkdir(agentEntry.id, options);

  // Per-entry env overrides — applied ONLY to the subprocess, never to parent.
  const entryEnv = resolveEntryEnv(agentEntry.env);
  const childEnv = { ...process.env, ...entryEnv };
  const progress = typeof options.progress === "function" ? options.progress : null;
  const heartbeatMs = options.heartbeatMs ?? 5000;

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
    let lastActivityAt = start;

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
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceKillTimer = setTimeout(() => terminate("SIGKILL"), 2000);
    }, timeoutMs);
    const heartbeat = progress
      ? setInterval(() => {
          if (Date.now() - lastActivityAt < heartbeatMs) return;
          progress("dispatch: waiting for edit_exists response", {
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
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        output: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        exitCode: timedOut ? 124 : code,
        durationMs: Date.now() - start,
        workdir,
        external,
        // External cwd (worktree/repo): report only what changed via git, never
        // the whole tree. Temp cwd: enumerate everything the agent produced.
        files: external ? listChangedFiles(workdir) : listFiles(workdir),
      });
    });

    child.on("error", (err) => {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
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
      && !(a.enabled === false && state[a.id]?.enabled !== true)
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
  const envName = g.env;
  const apiKey = envName && envName !== "OLLAMA_UNUSED_KEY" ? resolveAgentEnv(agentEntry, envName) : null;
  if (envName && envName !== "OLLAMA_UNUSED_KEY" && !apiKey) {
    return { ok: false, hint: `env var ${envName} not set` };
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
      return {
        ok: false,
        status: resp.status,
        modelUnavailable: true,
        hint: "model not available on this account (" + resp.status + ")",
        latencyMs,
      };
    }
    // 402 / insufficient balance / payment required — key is valid but the
    // model tier requires a paid plan. Same effect for pick/dispatch as
    // model_unavailable (skip it), but the UX hint is different so the
    // operator knows upgrading billing would unlock it.
    const isPaymentRequired =
      resp.status === 402 ||
      /payment.{0,20}required|insufficient.{0,20}balance|please.{0,20}recharge|billing.{0,20}required/i.test(text);
    if (isPaymentRequired) {
      return {
        ok: false,
        status: resp.status,
        modelUnavailable: true,
        hint: "paid plan required for this model (" + resp.status + ")",
        latencyMs,
      };
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
      return {
        ok: false,
        status: resp.status,
        hint: `HTTP ${resp.status}` + (text ? ": " + text.slice(0, 200) : ""),
        latencyMs,
        reset_at,
      };
    }
    return {
      ok: false,
      status: resp.status,
      hint: resp.status === 401 || resp.status === 403
        ? "invalid API key (server returned " + resp.status + ")"
        : `HTTP ${resp.status}` + (text ? ": " + text.slice(0, 200) : ""),
      latencyMs,
    };
  } catch (e) {
    return { ok: false, hint: e.name === "AbortError" ? "timeout after 10s" : e.message };
  } finally {
    clearTimeout(timer);
  }
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
      };
    }
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
    if (heartbeat) clearInterval(heartbeat);
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
 *   2. Otherwise, a supplied cwd prefers an edit_exists CLI when available.
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
  if (options.cwd != null && options.cwd !== "" && getTransportConfig(agentEntry, "edit_exists")) {
    return "edit_exists";
  }
  if (getTransportConfig(agentEntry, "generate_new")) return "generate_new";
  if (getTransportConfig(agentEntry, "edit_exists")) return "edit_exists";
  throw new Error(`runAny: no known transport for ${agentEntry?.id ?? "<unknown>"}`);
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
  const fileContext = resolveFileContext(options.files, options.cwd || process.cwd(), { strictContainment: true });
  const fullPrompt = fileContext + prompt;
  emitPromptSizeWarning(fullPrompt, options.progress);

  if (transport === "generate_new") {
    result = await runGenerate(agentEntry, fullPrompt, options);
  } else {
    result = await runDispatch(agentEntry, fullPrompt, options);
  }

  // Telemetry — one row per dispatch, best-effort. Failures also capture a
  // short (400 char) preview of stderr / API response body so the UI can show
  // WHY a call failed instead of the blind "error" it used to log. Success
  // rows never include the preview — no telemetry of prompt content. Take the
  // LAST 400 chars, not the first: CLI-transport tools (codex, claude-opus-4-8,
  // etc) print a startup banner + the echoed prompt FIRST, and the actual
  // error/exception only appears near the end right before the process exits.
  const failed = result.exitCode !== 0;
  const errorPreview = failed
    ? String(result.stderr || result.output || "").slice(-400)
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
  const cmd = getTransportConfig(entry, "edit_exists")?.cmd;
  if (!cmd) return { ok: false, hint: "no edit_exists transport" };
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `${cmd} "reply exactly OK"`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); if (out.length > 4000) out = out.slice(-4000); });
    child.stderr.on("data", (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
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
      if (code === 0) {
        if (/\bOK\b/i.test(out)) return resolve({ ok: true, latencyMs });
        return resolve({ ok: false, hint: `exit 0 but response did not include expected marker (got: "${(out || err).slice(0, 120).replace(/\s+/g, " ").trim()}")`, latencyMs });
      }
      resolve({ ok: false, hint: (preview.split("\n").filter(l => l.trim()).pop() || `exit ${code}`).slice(0, 200), latencyMs });
    });
  });
}
function _extractHint(text, re) {
  const m = text.match(re);
  return m ? m[0].trim().slice(0, 200) : text.split("\n").filter(l => l.trim()).pop()?.slice(0, 200);
}
