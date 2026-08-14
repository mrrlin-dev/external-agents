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
import { readState, writeState, probeInstalled, resetCooldownsForEnvVar } from "./lib/state.js";
import { nextStateAfterOutcome } from "./lib/outcome.js";
import { resolveExhaustionResetAt } from "./lib/quota-reset.js";
import { runAny, classifyDispatchFailure, resolveEscalation, getStats } from "./lib/dispatch.js";
import { pickAgents } from "./lib/pick.js";

// Resolve agents.yaml relative to THIS module, never the process cwd. As an
// MCP server, external-agents-mcp is spawned by the client (Codex/Claude) with
// an arbitrary cwd — a cwd-relative "./agents.yaml" threw
// `ENOENT: ./agents.yaml` and the server never came up (no tools registered),
// which is exactly why the auto-registered [mcp_servers.external_agents] block
// looked dead. cli.js and ui.js already resolve module-relative; this aligns
// server.js so no per-operator `cwd = ...` config workaround is needed.
const REGISTRY = loadRegistry(path.join(path.dirname(new URL(import.meta.url).pathname), "agents.yaml"));

// Env-var boot injection lives in the shared credentials module (single source
// of truth for CLI + MCP server + UI). Priority: keys.env → Kilo auth store →
// llm keys. Never overrides an already-set env var.
import { KEYS_FILE, loadKeysFile, persistCredential, bootEnv, refreshEnv } from "./lib/credentials.js";
bootEnv();

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
        description:
          "Pick up to N distinct healthy candidates by round-robin (preference_order + last_used_at). " +
          "Optional min_distinct_providers enforces cross-provider diversity, counted per provider " +
          "FAMILY: google3 and google4 are two API keys for one source, not two opinions. A model is " +
          "never seated twice while an unseated one is available, so a panel gets distinct voices " +
          "rather than clones of one model. " +
          "Exclusion uses the same identity: filter.exclude_ids drops every entry serving the same " +
          "model as each named id (excluding gemini-3.6-flash-6 will NOT seat gemini-3.6-flash-5 " +
          "instead), and filter.exclude_providers matches by family, so 'google' covers google3..8. " +
          "\n\nROUTING NOTE: default filter is tier='weak' — that is intentional. Most atomic tasks " +
          "(single-file edits, refactors, glue code, summaries, format conversions, well-scoped fixes) " +
          "get the same quality answer from a weak-tier free-tier model as from Claude Opus or " +
          "Codex Pro, in a fraction of the time and cost. Reach for strong-tier (filter tier='strong') " +
          "ONLY when the task actually needs deep reasoning: multi-step debugging, architecture " +
          "decisions, ambiguous requirements, novel algorithms. Frontier ≠ better output for the " +
          "long tail of routine work; often it is slower with no quality gain. Be smart, not lavish.",
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
                exclude_providers: { type: "array", items: { type: "string" } },
              },
            },
            min_distinct_providers: { type: "integer", minimum: 1 },
          },
        },
      },
      {
        name: "dispatch",
        description:
          "Run a specific agent by id with a prompt. transport ('generate_new' | 'edit_exists' | 'read_only') overrides the " +
          "default. With cwd, edit_exists is preferred when declared; otherwise generate_new is preferred. escalate_to_pro=true uses the " +
          "same-provider strong-tier entry instead. " +
          "\n\nread_only: use when the agent must NOT be able to write — e.g. a reviewer dispatched " +
          "into a live repo it is judging. Selects a declared read_only command, or an implicit " +
          "generate_new (HTTP has no filesystem access at all). An entry with only edit_exists and " +
          "no read_only errors rather than silently falling back to the write-capable command." +
          "\n\nROUTING NOTE: for the same task, weak-tier free-tier models (Gemini flash, Groq " +
          "llama, DeepSeek, OpenRouter :free) are usually correct AND fast enough. Use dispatch " +
          "against Claude Opus, Codex Pro, or any strong-tier subscription model ONLY when the " +
          "task genuinely needs frontier capability. escalate_to_pro is a retry lever, not a " +
          "default. If a weak agent's output is wrong, first ask whether the SPEC was ambiguous " +
          "(fix the spec, re-dispatch weak) before escalating tier — reaching for stronger models " +
          "hides prompt-engineering failures behind expensive compute." +
          "\n\ncwd: absolute path of an existing directory (e.g. a git worktree) for an " +
          "edit_exists agent to run IN and edit files in place. When an agent declares edit_exists, " +
          "supplying cwd selects it by default. generate_new (HTTP) ignores cwd and has no filesystem " +
          "access. When cwd is a git repo, the returned `files` list is the " +
          "git-changed set, not the whole tree." +
          "\n\nfiles: array of {path, lines?, label?} entries. Their contents are read from disk " +
          "and prepended to the prompt as a structured context block. CRITICAL for generate_new " +
          "agents (they have ZERO filesystem access — without files they hallucinate code shapes). " +
          "Optional for edit_exists: direct CLIs can inspect cwd themselves; attach files only when " +
          "you need to constrain or highlight context. Paths resolve relative to cwd. " +
          "IMPORTANT: when using files, ALWAYS pass cwd (the repo root) — it serves as the " +
          "containment basedir for path resolution and security. Without cwd, paths resolve against " +
          "the MCP server process cwd, which is likely wrong.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            prompt: { type: "string" },
            transport: { type: "string", enum: ["generate_new", "edit_exists", "read_only"] },
            escalate_to_pro: { type: "boolean" },
            cwd: { type: "string" },
            files: {
              type: "array",
              description:
                "Attach file contents to the prompt so the agent sees real code, not hallucinated shapes. " +
                "Each entry: { path: 'relative/or/absolute', lines?: '10-50', label?: 'short name' }. " +
                "Paths resolve relative to cwd (or process cwd). The contents are prepended to the prompt " +
                "as a structured context block. Essential for generate_new agents (no filesystem access); " +
                "optional for edit_exists because direct CLIs can read cwd.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "File path (absolute or relative to cwd)" },
                  lines: { type: "string", description: "Line range, e.g. '10-50'. Omit for entire file." },
                  label: { type: "string", description: "Display label in the context block. Defaults to the path." },
                },
                required: ["path"],
              },
            },
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
  // Keys added from a shell after this server booted are picked up per call,
  // so `external-agents set-credential X` no longer strictly requires an MCP
  // client restart to take effect.
  refreshEnv();

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
    const resetIds = resetCooldownsForEnvVar(env_name, REGISTRY.agents);
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, env_name, persisted_to: KEYS_FILE, chars: value.length, cooldowns_reset: resetIds }) },
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
    const { agent_id, prompt, transport, escalate_to_pro, cwd, files } = request.params.arguments;
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
      const escalation = resolveEscalation(REGISTRY, agent_id, readState());
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

    const result = await runAny(entry, prompt, { transport, cwd, files });
    const now = Math.floor(Date.now() / 1000);

    // Shared outcome→state (lib/outcome.js) — escalating cooldown on repeated
    // failures; identical logic to cli.js so the two dispatch surfaces never drift.
    const ok = result.exitCode === 0;
    const failText = result.stderr + "\n" + result.output;
    const failure = ok
      ? { isExhaustion: false }
      : classifyDispatchFailure(failText);
    const isExhaustion = failure.isExhaustion;
    // limited (rate-limit/quota) → resolve the real reset (period/provider-aware); transient → none.
    const exhaustionResetAt = (!ok && isExhaustion)
      ? resolveExhaustionResetAt({ text: failText, provider: entry.provider, nowMs: Date.now() })
      : undefined;
    const prevRec = readState()[entry.id];
    const nextRec = nextStateAfterOutcome(prevRec, {
      ok,
      isExhaustion,
      exhaustionResetAt,
      now,
    });
    writeState({ [entry.id]: nextRec });
    const outcome = ok ? "success" : (isExhaustion ? "quota_exhausted" : "error");

    const response = {
      agent_id: entry.id,
      outcome,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      output: result.output,
      workdir: result.workdir,
      external: result.external,
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
