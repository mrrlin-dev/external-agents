#!/usr/bin/env node
// external-agents CLI — thin argv wrapper over the same primitives the MCP
// server exposes. Used by shell wrappers (kilo-executor.sh, consensus-reviewer.sh)
// that need to reach the registry from bash without speaking MCP JSON-RPC.
//
// Subcommands:
//   pick [--tier T] [--n N] [--min-distinct-providers M] [--exclude ID,ID] [--exclude-providers P,P]
//     → prints one agent id per line (up to N), or exits 3 if no candidates
//   dispatch <agent-id> [--pro] "<prompt>"
//     → runs the agent, prints stdout of the child, exits with:
//        0 success  |  2 usage  |  3 unknown agent  |  4 quota exhausted
//        1 real error
//     → prints a JSON-RPC-style summary trailer to stderr for callers that want it:
//        {"outcome":..., "exit_code":..., "duration_ms":..., "workdir":...}
//   status [--json]  → table of every registry entry with state (or JSON)
//   probe <agent-id> → probes one agent, prints new state JSON
import { loadRegistry, LOCAL_PATH } from "./lib/registry.js";
import yaml from "js-yaml";
import { readState, writeState, probeInstalled } from "./lib/state.js";
import { runAny, resolveEscalation, parseExhaustionSignal, getStats, verifyCredential, auditCliEntry } from "./lib/dispatch.js";
import { pickAgents } from "./lib/pick.js";
import { persistCredential, bootEnv, KEYS_FILE } from "./lib/credentials.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// CLI + MCP server share the same env-loading logic — see lib/credentials.js.
// This ensures `external-agents set-credential FOO_KEY ...` followed by
// `external-agents probe some-agent` reads the just-written keys.env, and the
// two invocation surfaces (CLI here, MCP server in server.js) never drift.
bootEnv();

const REGISTRY_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "agents.yaml");
const REGISTRY = loadRegistry(REGISTRY_PATH);

// --- argv parsing helpers -----------------------------------------
// Boolean flags never consume the following token. Without this list a value-
// taking parser turns `dispatch <id> --json "prompt"` into {json:"prompt"} and
// eats the positional — the prompt vanishes ("missing prompt"). Same latent
// trap for --pro. Everything else stays a value flag (--n 3, --tier strong, …).
const BOOLEAN_FLAGS = new Set(["json", "pro", "no-open", "force"]);
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && nxt !== undefined && !nxt.startsWith("--")) { flags[key] = nxt; i++; }
      else flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}
function die(msg, code = 2) { console.error(msg); process.exit(code); }
function findAgent(id) { return REGISTRY.agents.find((a) => a.id === id); }

// --- subcommands --------------------------------------------------
function cmdPick(flags) {
  const n = parseInt(flags.n || "1", 10);
  const baseFilter = {};
  if (flags.tags) baseFilter.tags = String(flags.tags).split(",").filter(Boolean);
  if (flags.exclude) baseFilter.exclude_ids = String(flags.exclude).split(",").filter(Boolean);
  if (flags["exclude-providers"]) {
    const providers = new Set(String(flags["exclude-providers"]).split(",").filter(Boolean));
    const ids = REGISTRY.agents.filter((a) => providers.has(a.provider)).map((a) => a.id);
    baseFilter.exclude_ids = [...(baseFilter.exclude_ids || []), ...ids];
  }
  if (flags.transport) baseFilter.transport = flags.transport;
  const minDistinct = flags["min-distinct-providers"] ? parseInt(flags["min-distinct-providers"], 10) : undefined;
  const state = readState();

  // --tier-prefer <t>: return exactly N, preferring tier <t>, then backfilling
  // the OTHER tier for any unfilled slots — keeping cross-provider diversity
  // across the whole panel. This is mrrlin's consensus degrade ladder (ADR 0022
  // D2: strong preferred, weak rather than a smaller panel) in a single call.
  // --tier <t> stays the strict single-tier filter.
  if (flags["tier-prefer"]) {
    const prefer = String(flags["tier-prefer"]);
    const other = prefer === "strong" ? "weak" : "strong";
    const primary = pickAgents(REGISTRY, state, {
      n, filter: { ...baseFilter, tier: prefer }, min_distinct_providers: minDistinct,
    });
    let out = [...primary];
    if (out.length < n) {
      // Backfill from the other tier, excluding already-picked ids AND their
      // providers so the panel stays provider-diverse.
      const usedProviders = new Set(primary.map((id) => findAgent(id)?.provider).filter(Boolean));
      const backfillExclude = [
        ...(baseFilter.exclude_ids || []),
        ...primary,
        ...REGISTRY.agents.filter((a) => usedProviders.has(a.provider)).map((a) => a.id),
      ];
      const remainingDistinct = minDistinct != null ? Math.max(0, minDistinct - usedProviders.size) : undefined;
      const backfill = pickAgents(REGISTRY, state, {
        n: n - out.length,
        filter: { ...baseFilter, tier: other, exclude_ids: backfillExclude },
        min_distinct_providers: remainingDistinct,
      });
      out = [...out, ...backfill];
    }
    if (out.length === 0) process.exit(3);
    for (const id of out) console.log(id);
    return;
  }

  const filter = { ...baseFilter };
  if (flags.tier) filter.tier = flags.tier;
  const picked = pickAgents(REGISTRY, state, { n, filter, min_distinct_providers: minDistinct });
  if (picked.length === 0) process.exit(3);
  for (const id of picked) console.log(id);
}

async function cmdDispatch(args, flags) {
  const [agentId, ...promptParts] = args;
  const prompt = promptParts.join(" ");
  if (!agentId) die("usage: cli.js dispatch <agent-id> [--pro] \"<prompt>\"", 2);
  if (!prompt) die("dispatch: missing prompt", 2);

  const src = findAgent(agentId);
  if (!src) die(`unknown agent: ${agentId}`, 3);

  let entry = src;
  let escalatedFrom;
  if (flags.pro) {
    const esc = resolveEscalation(REGISTRY, agentId);
    if (!esc) {
      console.error(JSON.stringify({ outcome: "no_escalation_candidate", requested: agentId }));
      process.exit(4);
    }
    entry = esc;
    escalatedFrom = agentId;
  }

  const cur = readState();
  writeState({ [entry.id]: { ...(cur[entry.id] || {}), last_used_at: Math.floor(Date.now() / 1000) } });

  const transport = flags.transport;  // "generate_new" | "edit_exists" | undefined
  const result = await runAny(entry, prompt, { transport });
  const now = Math.floor(Date.now() / 1000);

  let outcome;
  let statePatch;
  if (result.exitCode === 0) {
    statePatch = { [entry.id]: { state: "healthy", checked: now, last_used_at: now } };
    outcome = "success";
  } else {
    const sig = parseExhaustionSignal(result.stderr + "\n" + result.output);
    if (sig.detected) {
      const cooldown_until = sig.reset_at != null ? sig.reset_at : now + 3600;
      statePatch = { [entry.id]: { state: "quota_exhausted", cooldown_until, source: sig.reset_at != null ? "error_body" : "fallback_ttl", checked: now } };
      outcome = "quota_exhausted";
    } else outcome = "error";
  }
  if (statePatch) writeState(statePatch);

  // --json: emit ONE structured object to stdout and nothing else — for
  // programmatic callers (mrrlin's runMultiHead, ADR 0022) that need
  // {text, outcome, tokens, …} without scraping free text from stdout and the
  // trailer from stderr separately. Default (human/shell) keeps the text-on-
  // stdout + trailer-on-stderr shape wrappers already rely on.
  if (flags.json) {
    const payload = {
      agent_id: entry.id,
      outcome,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      tokens_in: result.tokens_in ?? null,
      tokens_out: result.tokens_out ?? null,
      text: result.output,
      workdir: result.workdir,
      files: result.files,
    };
    if (escalatedFrom) payload.escalated_from = escalatedFrom;
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    process.stdout.write(result.output);
    const trailer = { agent_id: entry.id, outcome, exit_code: result.exitCode, duration_ms: result.durationMs, workdir: result.workdir, files: result.files };
    if (escalatedFrom) trailer.escalated_from = escalatedFrom;
    console.error("__EXTERNAL_AGENTS_TRAILER__ " + JSON.stringify(trailer));
  }

  process.exit(outcome === "success" ? 0 : (outcome === "quota_exhausted" ? 4 : 1));
}

// Show a hint line at the bottom of status/UI when the audit hasn't run
// recently — the oldest `checked` timestamp across all entries is our proxy
// for "when did we last verify these are still real". > 7 days → nag.
// Written as a stderr line so LLM operators reading the tool output pick it
// up and can act on it without clobbering json output.
const AUDIT_STALE_DAYS = 7;
function auditFreshnessHint(rows) {
  const stamps = rows.map((r) => r.checked || 0).filter((t) => t > 0);
  if (stamps.length === 0) {
    return "hint: no audit has ever run. Run 'external-agents audit' to verify model availability.";
  }
  const oldest = Math.min(...stamps);
  const ageDays = Math.floor((Date.now() / 1000 - oldest) / 86400);
  if (ageDays >= AUDIT_STALE_DAYS) {
    return `hint: oldest audit is ${ageDays} days old — run 'external-agents audit' to refresh model availability (providers deprecate models silently).`;
  }
  return null;
}

function cmdStatus(flags) {
  const state = readState();
  // No persisted state → run the cheap, synchronous, network-free
  // probeInstalled() check instead of a static fallback string. Reports
  // needs_auth when an env var is absent, healthy when present, and
  // not_installed for a missing CLI binary — matches what `external-agents
  // probe <id>` would actually find, without a live API round-trip.
  const rows = REGISTRY.agents.map((e) => state[e.id] ? { ...e, ...state[e.id] } : { ...e, ...probeInstalled(e) });
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const w = 42;
  console.log(`${"agent".padEnd(w)} ${"state".padEnd(18)} ${"tier".padEnd(7)} tags`);
  console.log("-".repeat(96));
  for (const r of rows) {
    const tagsStr = (r.tags || []).join(",");
    console.log(`${r.id.padEnd(w)} ${(r.state || "?").padEnd(18)} ${(r.tier || "-").padEnd(7)} ${tagsStr}`);
  }
  const hint = auditFreshnessHint(rows);
  if (hint) {
    console.log();
    console.error(hint);
  }
}

function cmdStats(flags) {
  const s = getStats(flags.since);
  if (flags.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  console.log(`total dispatches: ${s.total}${s.span.first_ts ? `  (from ${new Date(s.span.first_ts*1000).toISOString()} to ${new Date(s.span.last_ts*1000).toISOString()})` : ""}`);
  console.log();
  console.log("by transport:");
  for (const [t, v] of Object.entries(s.by_transport)) {
    console.log(`  ${t.padEnd(10)} count=${v.count} tokens_in=${v.tokens_in} tokens_out=${v.tokens_out}`);
  }
  console.log();
  console.log("by agent:");
  const rows = Object.entries(s.by_agent).sort((a,b) => b[1].count - a[1].count);
  for (const [id, v] of rows) {
    const okCount = v.outcomes.success || 0;
    const successRate = v.count ? Math.round(100 * okCount / v.count) : 0;
    console.log(`  ${id.padEnd(40)} count=${v.count} success=${successRate}% avg_dur=${Math.round(v.duration_ms/(v.count||1))}ms tokens=${v.tokens_in}/${v.tokens_out}`);
  }
}

function cmdProbe(args) {
  const [agentId] = args;
  if (!agentId) die("usage: cli.js probe <agent-id>", 2);
  const entry = findAgent(agentId);
  if (!entry) die(`unknown agent: ${agentId}`, 3);
  const result = probeInstalled(entry);
  const checked = Math.floor(Date.now() / 1000);
  writeState({ [agentId]: { ...result, checked } });
  console.log(JSON.stringify({ id: agentId, ...result, checked }));
}

// `external-agents set-credential ENV_NAME [value]` — persist a credential to
// ~/.local/state/external-agents/keys.env (0600). Two input paths:
//   - value supplied as an argument (fine for scripts)
//   - value read from stdin when the argument is `-` or omitted (safer for
//     interactive use — no shell-history leak, no ps-listing exposure).
// After persisting, the current process env is updated so a follow-up probe /
// dispatch inside the same shell script sees the new value.
async function cmdSetCredential(args) {
  const [envName, valueArg] = args;
  if (!envName) {
    die("usage: external-agents set-credential <ENV_NAME> [<value> | -]\n  <value> may be `-` (or omitted) to read from stdin", 2);
  }
  let value = valueArg;
  if (!value || value === "-") {
    // Read from stdin. If a TTY, prompt on stderr.
    if (process.stdin.isTTY) {
      process.stderr.write(`Enter value for ${envName} (echoed): `);
    }
    value = await new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => { buf += chunk; });
      process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    });
  }
  try {
    const persistedTo = persistCredential(envName, value);
    // Print to stderr so stdout stays clean for scripting; do NOT echo the value.
    console.error(`external-agents: ${envName} persisted to ${persistedTo}`);
    console.error(`  Restart your MCP client (Codex / Claude Code) so its external-agents-mcp instance re-reads keys.env at startup.`);
  } catch (e) {
    die(`set-credential failed: ${e.message}`, 2);
  }
}

// `external-agents init` — one-shot setup: launch the UI AND open the default
// browser to it. Meant for the "just installed the package, what now" moment.
// The UI process stays foregrounded (Ctrl-C to quit) so the operator can watch
// key-save events land in stderr.
function cmdInit(flags) {
  // --port/--host flags win; then EXTERNAL_AGENTS_UI_PORT/_HOST env (so a
  // Docker/systemd deployment can configure via env without a CLI flag);
  // then the loopback-only default. Previously this silently ignored the
  // env vars and always defaulted to 127.0.0.1 unless --host was passed —
  // breaking any container that set EXTERNAL_AGENTS_UI_HOST=0.0.0.0 and
  // expected the UI to actually be reachable from outside the container.
  const port = Number(flags.port) || Number(process.env.EXTERNAL_AGENTS_UI_PORT) || 4711;
  const host = String(flags.host || process.env.EXTERNAL_AGENTS_UI_HOST || "127.0.0.1");
  const url  = `http://${host}:${port}/`;
  const skipOpen = flags["no-open"] === true;
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "cmd" :
    "xdg-open";
  const openerArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  // Spawn UI first, then open browser after it starts listening.
  const uiPath = path.join(path.dirname(new URL(import.meta.url).pathname), "ui.js");
  const env = { ...process.env, EXTERNAL_AGENTS_UI_PORT: String(port), EXTERNAL_AGENTS_UI_HOST: host };
  const child = spawn(process.execPath, [uiPath], { stdio: "inherit", env });
  if (skipOpen) {
    child.on("exit", (code) => process.exit(code ?? 0));
    process.on("SIGINT",  () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    return;
  }
  // Give the UI ~600ms to bind before opening the browser (loopback listen is
  // usually instantaneous but we do not want the browser to open on a not-yet-
  // bound port). Browser-open is best-effort — swallow BOTH sync spawn errors
  // AND async 'error' events (ENOENT is emitted async, not thrown; without a
  // listener it crashes the process — this is what breaks curl|bash on a
  // headless Linux box that has no xdg-open installed). The UI keeps running.
  setTimeout(() => {
    try {
      const opener_proc = spawn(opener, openerArgs, { stdio: "ignore", detached: true });
      opener_proc.on("error", (err) => {
        console.error(`external-agents init: could not launch browser (${err.code || err.message}) — open ${url} manually.`);
      });
      opener_proc.unref();
    } catch (err) {
      console.error(`external-agents init: could not launch browser (${err.message}) — open ${url} manually.`);
    }
  }, 600);
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT",  () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// `external-agents ui` — spawn the loopback dashboard (ui.js) inline so the CLI
// stays the single entry point. ui.js runs its server at top level and blocks;
// we spawn it as a child so cli.js does not need to import server-lifecycle code
// and so Ctrl-C from the terminal terminates the child cleanly.
// Force-audit every registry entry with a live API round-trip: prove the key
// works AND the model actually exists on this account/tier. Writes the outcome
// to state.json (healthy / needs_auth / model_unavailable / rate_limited) so
// the UI and pick decisions reflect ground truth. Optional --provider narrows
// the audit; --json machine-parseable output.
//
// This replaces the old `refresh` (which just fetched agents.yaml from
// GitHub) — we decided the source-of-truth is the bundled registry via
// `npm i -g @latest`, and what actually matters day-to-day is knowing
// whether YOUR account still has access to each model.
async function cmdAudit(flags) {
  const providerFilter = flags.provider ? String(flags.provider) : null;
  const asJson = flags.json === true;
  const entries = REGISTRY.agents.filter((a) =>
    (!providerFilter || a.provider === providerFilter) &&
    (a.transports?.generate_new?.url || a.transports?.edit_exists)
  );
  if (entries.length === 0) {
    die(`audit: no entries match${providerFilter ? ` provider=${providerFilter}` : ""}`, 3);
  }

  const results = [];
  const started = Date.now();
  process.stderr.write(`external-agents audit: probing ${entries.length} agent(s)${providerFilter ? ` from ${providerFilter}` : ""}…\n`);

  // Serialize per-provider to respect rate limits (parallelize across providers).
  const byProvider = {};
  for (const e of entries) (byProvider[e.provider] ??= []).push(e);
  const providerBatches = await Promise.all(
    Object.values(byProvider).map(async (batch) => {
      const out = [];
      for (const entry of batch) {
        const hasApi = !!entry.transports?.generate_new?.url;
        // Prefer HTTP verifyCredential — faster, cheaper. Fall back to CLI
        // headless invocation for cli-only entries (codex, claude, cursor-agent,
        // opencode, kiro) so quota/auth surface in audit like everything else.
        const v = hasApi
          ? await verifyCredential(entry)
          : await auditCliEntry(entry);
        const outcome =
          v.ok                       ? "healthy"
          : v.modelUnavailable       ? "model_unavailable"
          : v.quotaExhausted         ? "quota_exhausted"
          : v.needsAuth              ? "needs_auth"
          : v.status === 401 || v.status === 403 ? "needs_auth"
          : v.status === 429         ? "rate_limited"
          : "errored_transient";
        const note =
          v.ok            ? `verified (${v.latencyMs}ms)${hasApi ? "" : " (cli)"}`
          : v.hint        ? v.hint + (v.status ? ` (HTTP ${v.status})` : "")
          : `HTTP ${v.status || "?"}`;
        // Deep-merge so probe metadata (last_used_at, enabled flag) survives.
        const existing = readState()[entry.id] || {};
        writeState({
          [entry.id]: {
            ...existing,
            state: outcome,
            note,
            checked: Math.floor(Date.now() / 1000),
          },
        });
        out.push({ id: entry.id, provider: entry.provider, model: entry.model, outcome, status: v.status || null, note });
      }
      return out;
    })
  );
  for (const b of providerBatches) results.push(...b);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (asJson) {
    console.log(JSON.stringify({ elapsed_s: parseFloat(elapsed), results }, null, 2));
    return;
  }
  // Human-readable table.
  const pad = (s, n) => String(s).padEnd(n);
  const w = { id: 34, provider: 12, outcome: 20, note: 60 };
  console.log(pad("agent", w.id) + pad("provider", w.provider) + pad("verdict", w.outcome) + "note");
  console.log("-".repeat(w.id + w.provider + w.outcome + w.note));
  const sym = { healthy: "✓", needs_auth: "⚠", model_unavailable: "✗", rate_limited: "⏳", quota_exhausted: "⏳", errored_transient: "?" };
  for (const r of results) {
    console.log(
      pad(r.id, w.id) +
      pad(r.provider, w.provider) +
      pad(`${sym[r.outcome] || "·"} ${r.outcome}`, w.outcome) +
      String(r.note).slice(0, w.note)
    );
  }
  const counts = results.reduce((acc, r) => (acc[r.outcome] = (acc[r.outcome] || 0) + 1, acc), {});
  console.log();
  console.log(`audited ${results.length} in ${elapsed}s — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(", ")}`);
}

// Append a locally-authored agent to the local overlay yaml. Minimum viable:
// caller passes id / provider / url / model / env; we build the entry and
// merge it into ~/.local/state/external-agents/agents.local.yaml.
function cmdAddModel(flags) {
  const need = ["id", "provider", "url", "model", "env"];
  const missing = need.filter((k) => !flags[k]);
  if (missing.length) {
    die(`add-model: missing --${missing.join(" --")} (usage: --id ID --provider P --url URL --model M --env ENV_VAR [--tier weak|strong] [--tags a,b] [--auth env:X])`, 2);
  }
  const entry = {
    id: String(flags.id),
    provider: String(flags.provider),
    model: String(flags.model),
    tier: flags.tier ? String(flags.tier) : "weak",
    tags: flags.tags ? String(flags.tags).split(",").filter(Boolean) : [],
    auth: flags.auth ? String(flags.auth) : `env:${flags.env}`,
    transports: {
      generate_new: {
        url: String(flags.url),
        env: String(flags.env),
        model: String(flags.model),
      },
    },
  };
  // Load existing overlay (or start fresh) — append/replace by id.
  let overlay = { schema_version: 1, agents: [] };
  if (fs.existsSync(LOCAL_PATH)) {
    try {
      const parsed = yaml.load(fs.readFileSync(LOCAL_PATH, "utf-8"));
      if (parsed && Array.isArray(parsed.agents)) overlay = parsed;
    } catch (e) {
      die(`add-model: existing ${LOCAL_PATH} unreadable — ${e.message}`, 1);
    }
  }
  const idx = overlay.agents.findIndex((a) => a.id === entry.id);
  if (idx >= 0) overlay.agents[idx] = entry;
  else overlay.agents.push(entry);
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(LOCAL_PATH, yaml.dump(overlay), { mode: 0o644 });
  console.log(`${idx >= 0 ? "replaced" : "added"}: ${entry.id}`);
  console.log(`wrote:    ${LOCAL_PATH}`);
  console.log(`re-run 'external-agents probe ${entry.id}' to verify.`);
}

function cmdUi(flags) {
  // Same behavior as `init` — start UI, then open the browser after a short
  // delay to let the port bind. Pass --no-open to skip the browser (useful in
  // SSH / tmux where a launched browser would just open on the wrong screen).
  cmdInit(flags);
}

// --- entrypoint ---------------------------------------------------
const [, , subcmd, ...rest] = process.argv;
const { args, flags } = parseArgs(rest);

switch (subcmd) {
  case "pick":     cmdPick(flags); break;
  case "dispatch": cmdDispatch(args, flags); break;
  case "status":   cmdStatus(flags); break;
  case "probe":    cmdProbe(args); break;
  case "stats":    cmdStats(flags); break;
  case "ui":       cmdUi(flags); break;
  case "init":     cmdInit(flags); break;
  case "set-credential": await cmdSetCredential(args); break;
  case "audit":    await cmdAudit(flags); break;
  case "add-model": cmdAddModel(flags); break;
  case "help":
  case "--help":
  case undefined:
    console.error(`external-agents CLI — subcommands:
  pick [--tier T | --tier-prefer T] [--n N] [--min-distinct-providers M] [--exclude id,id] [--exclude-providers p,p] [--tags a,b] [--transport generate_new|edit_exists]
       (--tier = strict single tier; --tier-prefer = prefer that tier, backfill the other to fill N slots, provider-diverse)
  dispatch <agent-id> [--pro] [--json] [--transport generate_new|edit_exists] "<prompt>"
       (--json = one structured {text,outcome,tokens,…} object on stdout; default = text on stdout + trailer on stderr)
  status [--json]
  probe <agent-id>
  stats [--since ISO] [--json]
  ui [--port N] [--host H] [--no-open]   # local dashboard (auto-opens in browser; use --no-open for SSH/tmux)
  init                                    # alias for 'ui' — kept for backward compat
  set-credential <ENV_NAME> [<value> | -]  # persist a key to ~/.local/state/external-agents/keys.env (0600); '-' or omitted = read from stdin
  audit [--provider P] [--json]    # force API round-trip for every registry entry (or just PROVIDER); writes state.json outcomes (healthy / needs_auth / model_unavailable / rate_limited)
  add-model --id ID --provider P --url URL --model M --env ENV_VAR [--tier weak|strong] [--tags a,b]
                                   # add a locally-authored agent to ~/.local/state/external-agents/agents.local.yaml (merged over the bundled registry)`);
    process.exit(subcmd ? 0 : 2);
  default: die(`unknown subcommand: ${subcmd}`, 2);
}
