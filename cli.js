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
import { loadRegistry } from "./lib/registry.js";
import { readState, writeState, probeInstalled } from "./lib/state.js";
import { runAny, resolveEscalation, parseExhaustionSignal, getStats } from "./lib/dispatch.js";
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
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith("--")) { flags[key] = nxt; i++; }
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
  const filter = {};
  if (flags.tier) filter.tier = flags.tier;
  if (flags.tags) filter.tags = String(flags.tags).split(",").filter(Boolean);
  if (flags.exclude) filter.exclude_ids = String(flags.exclude).split(",").filter(Boolean);
  if (flags["exclude-providers"]) {
    const providers = new Set(String(flags["exclude-providers"]).split(",").filter(Boolean));
    const ids = REGISTRY.agents.filter((a) => providers.has(a.provider)).map((a) => a.id);
    filter.exclude_ids = [...(filter.exclude_ids || []), ...ids];
  }
  if (flags.transport) filter.transport = flags.transport;
  const picked = pickAgents(REGISTRY, readState(), {
    n,
    filter,
    min_distinct_providers: flags["min-distinct-providers"] ? parseInt(flags["min-distinct-providers"], 10) : undefined,
  });
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

  process.stdout.write(result.output);
  const trailer = { agent_id: entry.id, outcome, exit_code: result.exitCode, duration_ms: result.durationMs, workdir: result.workdir, files: result.files };
  if (escalatedFrom) trailer.escalated_from = escalatedFrom;
  console.error("__EXTERNAL_AGENTS_TRAILER__ " + JSON.stringify(trailer));

  process.exit(outcome === "success" ? 0 : (outcome === "quota_exhausted" ? 4 : 1));
}

function cmdStatus(flags) {
  const state = readState();
  const rows = REGISTRY.agents.map((e) => ({ ...e, ...(state[e.id] || { state: "healthy" }) }));
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
  const port = Number(flags.port) || 4711;
  const host = String(flags.host || "127.0.0.1");
  const url  = `http://${host}:${port}/`;
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "cmd" :
    "xdg-open";
  const openerArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  // Spawn UI first, then open browser after it starts listening.
  const uiPath = path.join(path.dirname(new URL(import.meta.url).pathname), "ui.js");
  const env = { ...process.env, EXTERNAL_AGENTS_UI_PORT: String(port), EXTERNAL_AGENTS_UI_HOST: host };
  const child = spawn(process.execPath, [uiPath], { stdio: "inherit", env });
  // Give the UI ~600ms to bind before opening the browser (loopback listen is
  // usually instantaneous but we do not want the browser to open on a not-yet-
  // bound port).
  setTimeout(() => {
    try { spawn(opener, openerArgs, { stdio: "ignore", detached: true }).unref(); }
    catch { /* browser open is best-effort; UI is still up on ${url} */ }
  }, 600);
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT",  () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// `external-agents ui` — spawn the loopback dashboard (ui.js) inline so the CLI
// stays the single entry point. ui.js runs its server at top level and blocks;
// we spawn it as a child so cli.js does not need to import server-lifecycle code
// and so Ctrl-C from the terminal terminates the child cleanly.
function cmdUi(flags) {
  const uiPath = path.join(path.dirname(new URL(import.meta.url).pathname), "ui.js");
  const env = { ...process.env };
  if (flags.port) env.EXTERNAL_AGENTS_UI_PORT = String(flags.port);
  if (flags.host) env.EXTERNAL_AGENTS_UI_HOST = String(flags.host);
  const child = spawn(process.execPath, [uiPath], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
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
  case "help":
  case "--help":
  case undefined:
    console.error(`external-agents CLI — subcommands:
  pick [--tier T] [--n N] [--min-distinct-providers M] [--exclude id,id] [--exclude-providers p,p] [--tags a,b] [--transport generate_new|edit_exists]
  dispatch <agent-id> [--pro] [--transport generate_new|edit_exists] "<prompt>"
  status [--json]
  probe <agent-id>
  stats [--since ISO] [--json]
  ui [--port N] [--host H]        # local dashboard for setting keys + inspecting state (default http://127.0.0.1:4711)
  init [--port N] [--host H]      # launch UI AND open it in the default browser — the "just installed" one-shot
  set-credential <ENV_NAME> [<value> | -]  # persist a key to ~/.local/state/external-agents/keys.env (0600); '-' or omitted = read from stdin`);
    process.exit(subcmd ? 0 : 2);
  default: die(`unknown subcommand: ${subcmd}`, 2);
}
