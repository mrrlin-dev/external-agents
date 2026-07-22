#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry } from "./lib/registry.js";
import { readState, writeState, probeInstalled } from "./lib/state.js";
import { runAny, parseExhaustionSignal, resolveEscalation, getStats } from "./lib/dispatch.js";
import { pickAgents } from "./lib/pick.js";

const REGISTRY = loadRegistry("./agents.yaml");

// Env-var boot injection. Look for credentials in known local stores and populate
// process.env for aider/other CLIs. Never overrides an already-set var.
// UI-set persisted keys — loaded FIRST (highest precedence) so a value the
// operator saved via /api/set_credential wins over whatever legacy stores
// contain. File format: one KEY=value per line, no quotes. Mode 0600.
const KEYS_FILE = path.join(os.homedir(), ".local/state/external-agents/keys.env");

function loadKeysFile() {
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
    console.error(`external-agents-spike: WARN — keys.env unreadable: ${e.message}`);
    return {};
  }
}

function saveKeysFile(kv) {
  const dir = path.dirname(KEYS_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = Object.entries(kv)
    .filter(([k, v]) => k && typeof v === "string")
    .map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const tmp = KEYS_FILE + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, KEYS_FILE);
}

function bootEnv() {
  try {
    // 1. UI-persisted keys (highest priority — operator explicitly set them)
    const persisted = loadKeysFile();
    for (const [k, v] of Object.entries(persisted)) {
      if (!process.env[k]) process.env[k] = v;
    }

    // 2. Kilo auth store (legacy — DeepSeek key only; the Google proxy token
    //    in Kilo does NOT work against direct Google API)
    const kiloAuthPath = path.join(os.homedir(), ".local/share/kilo/auth.json");
    if (fs.existsSync(kiloAuthPath)) {
      const kiloAuth = JSON.parse(fs.readFileSync(kiloAuthPath, "utf-8"));
      if (!process.env.DEEPSEEK_API_KEY && kiloAuth.deepseek?.key) {
        process.env.DEEPSEEK_API_KEY = kiloAuth.deepseek.key;
      }
    }
    // 3. llm-key store (AI Studio Gemini key, `AIza...` format)
    const llmKeysPath = path.join(os.homedir(), "Library/Application Support/io.datasette.llm/keys.json");
    if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_API_KEY.startsWith("AIza")) {
      if (fs.existsSync(llmKeysPath)) {
        const llmKeys = JSON.parse(fs.readFileSync(llmKeysPath, "utf-8"));
        if (llmKeys.gemini) process.env.GEMINI_API_KEY = llmKeys.gemini;
      }
    }
  } catch (e) {
    console.error(`external-agents-spike: WARN — bootEnv failed: ${e.message}`);
  }
}
bootEnv();

// Exposed for the set_credential MCP tool + /api/set_credential UI route.
export function persistCredential(envName, value) {
  if (!envName || !/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new Error("invalid env var name");
  const persisted = loadKeysFile();
  persisted[envName] = value;
  saveKeysFile(persisted);
  // Also inject into the running process env so THIS session sees it immediately.
  process.env[envName] = value;
}

function findAgent(id) {
  return REGISTRY.agents.find((a) => a.id === id);
}

const server = new Server(
  {
    name: "external-agents-spike",
    version: "0.0.1",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ping",
        description: "Ping the server",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_agents",
        description: "List configured agents merged with their current state",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_state",
        description: "Return the current external-agents state file (per-agent healthy/not_installed/needs_auth/quota_exhausted/errored_transient with metadata)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "probe_agent",
        description: "Probe a specific agent by id; runs an install-check and updates the state file. Returns the new state.",
        inputSchema: {
          type: "object",
          properties: { agent_id: { type: "string" } },
          required: ["agent_id"],
        },
      },
      {
        name: "set_credential",
        description: "Persist an API-key env variable so the next dispatch (and future sessions) see it. Writes to ~/.local/state/external-agents/keys.env (mode 0600).",
        inputSchema: {
          type: "object",
          properties: {
            env_name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
            value: { type: "string" },
          },
          required: ["env_name", "value"],
        },
      },
      {
        name: "pick_agents",
        description: "Pick up to N distinct healthy candidates by round-robin (preference_order + last_used_at). Optional min_distinct_providers enforces cross-provider diversity.",
        inputSchema: {
          type: "object",
          properties: {
            n: { type: "integer", minimum: 1 },
            filter: {
              type: "object",
              properties: {
                tier: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                exclude_ids: { type: "array", items: { type: "string" } },
              },
            },
            min_distinct_providers: { type: "integer", minimum: 1 },
          },
        },
      },
      {
        name: "dispatch",
        description: "Run a specific agent by id with a prompt. transport ('generate' | 'cli') overrides the default (generate preferred when entry declares it). escalate_to_pro=true uses the same-provider strong-tier entry instead.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            prompt: { type: "string" },
            transport: { type: "string", enum: ["generate_new", "edit_exists"] },
            escalate_to_pro: { type: "boolean" },
          },
          required: ["agent_id", "prompt"],
        },
      },
      {
        name: "get_stats",
        description: "Aggregate dispatch telemetry from ~/.local/state/external-agents/dispatch-log.jsonl. Returns per-agent counts, tokens, outcomes; per-transport totals.",
        inputSchema: {
          type: "object",
          properties: { since: { type: "string", description: "ISO 8601 datetime; only rows with ts >= since included" } },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "ping") {
    return {
      content: [
        {
          type: "text",
          text: "pong from external-agents-spike v0.0.1",
        },
      ],
    };
  }

  if (name === "list_agents") {
    const state = readState();
    const merged = REGISTRY.agents.map((entry) => ({
      ...entry,
      ...(state[entry.id] || { state: "healthy" }),
    }));
    return {
      content: [
        { type: "text", text: JSON.stringify(merged) },
      ],
    };
  }

  if (name === "get_state") {
    return {
      content: [
        { type: "text", text: JSON.stringify(readState()) },
      ],
    };
  }

  if (name === "set_credential") {
    const { env_name, value } = request.params.arguments || {};
    if (!env_name || !value) throw new Error("set_credential: env_name and value required");
    persistCredential(env_name, value);
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, env_name, persisted_to: KEYS_FILE, chars: value.length }) },
      ],
    };
  }

  if (name === "probe_agent") {
    const id = request.params.arguments?.agent_id;
    if (!id || typeof id !== "string") {
      throw new Error("probe_agent: missing agent_id");
    }
    const entry = findAgent(id);
    if (!entry) {
      throw new Error(`unknown agent: ${id}`);
    }
    const result = probeInstalled(entry);
    const checked = Math.floor(Date.now() / 1000);
    writeState({ [id]: { ...result, checked } });
    return {
      content: [
        { type: "text", text: JSON.stringify({ id, ...result, checked }) },
      ],
    };
  }

  if (name === "pick_agents") {
    const args = request.params.arguments || {};
    const picked = pickAgents(REGISTRY, readState(), {
      n: args.n ?? 1,
      filter: args.filter,
      min_distinct_providers: args.min_distinct_providers,
    });
    return {
      content: [
        { type: "text", text: JSON.stringify({ picked }) },
      ],
    };
  }

  if (name === "get_stats") {
    const { since } = request.params.arguments || {};
    return {
      content: [
        { type: "text", text: JSON.stringify(getStats(since)) },
      ],
    };
  }

  if (name === "dispatch") {
    const { agent_id, prompt, transport, escalate_to_pro } = request.params.arguments;
    if (!agent_id || !prompt) {
      throw new Error("dispatch: missing agent_id or prompt");
    }

    const sourceEntry = findAgent(agent_id);
    if (!sourceEntry) {
      throw new Error(`unknown agent: ${agent_id}`);
    }

    let entry = sourceEntry;
    let escalatedFrom;
    if (escalate_to_pro) {
      const escalation = resolveEscalation(REGISTRY, agent_id);
      if (!escalation) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ outcome: "no_escalation_candidate", requested: agent_id }) },
          ],
        };
      }
      entry = escalation;
      escalatedFrom = agent_id;
    }

    const state = readState();
    writeState({
      [entry.id]: { ...(state[entry.id] || {}), last_used_at: Math.floor(Date.now() / 1000) },
    });

    const result = await runAny(entry, prompt, { transport });
    const now = Math.floor(Date.now() / 1000);

    let outcome;
    let statePatch;

    if (result.exitCode === 0) {
      statePatch = { [entry.id]: { state: "healthy", checked: now, last_used_at: now } };
      outcome = "success";
    } else if (result.exitCode !== 0) {
      const signal = parseExhaustionSignal(result.stderr + "\n" + result.output);
      if (signal.detected) {
        const cooldown_until = signal.reset_at != null ? signal.reset_at : now + 3600;
        statePatch = {
          [entry.id]: {
            state: "quota_exhausted",
            cooldown_until,
            source: signal.reset_at != null ? "error_body" : "fallback_ttl",
            checked: now,
          },
        };
        outcome = "quota_exhausted";
      } else {
        outcome = "error";
      }
    }

    if (statePatch) writeState(statePatch);

    const response = {
      agent_id: entry.id,
      outcome,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      output: result.output,
      workdir: result.workdir,
      files: result.files,
    };
    if (escalatedFrom) response.escalated_from = escalatedFrom;

    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("external-agents-spike MCP server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
