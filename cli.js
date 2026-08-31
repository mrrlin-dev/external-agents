#!/usr/bin/env node
// external-agents CLI — thin argv wrapper over the same primitives the MCP
// server exposes. Used by shell wrappers (kilo-executor.sh, consensus-reviewer.sh)
// that need to reach the registry from bash without speaking MCP JSON-RPC.
//
// Subcommands:
//   pick [--tier T] [--n N] [--min-distinct-providers M] [--exclude ID,ID] [--exclude-providers P,P]
//        [--prompt-bytes N | --prompt-tokens N]
//        (--exclude and --exclude-providers both cascade to every API-key clone:
//         excluding one id drops every entry serving the same model, and a
//         provider is matched by family, so `google` covers google3..google8)
//     → prints one agent id per line (up to N), or exits 3 if no candidates
//   dispatch <agent-id> [--pro] "<prompt>"
//     → runs the agent, prints stdout of the child, exits with:
//        0 success  |  2 usage  |  3 unknown agent  |  4 quota exhausted
//        1 real error
//     → prints a JSON-RPC-style summary trailer to stderr for callers that want it:
//        {"outcome":..., "exit_code":..., "duration_ms":..., "workdir":...}
//   status [--json]  → table of every registry entry with state (or JSON)
//   probe <agent-id> → probes one agent, prints new state JSON
import { loadRegistry, LOCAL_PATH, withLocalOverlayLock } from "./lib/registry.js";
import yaml from "js-yaml";
import { readState, writeState, probeInstalled, resetCooldownsForEnvVar, enableAgentsAwaitingCredential, mergeAuditState, auditCooldown, deriveDisplayState } from "./lib/state.js";
import { runAny, resolveEscalation, classifyDispatchFailure, getStats, verifyCredential, auditCliEntry, getTransportConfig, selectTransport, probeReadOnlyNonWriting, classifyVerifyResult, shouldPersistOutcome, repoProvenance, sweepDispatchTemp } from "./lib/dispatch.js";
import { pickAgents, providerFamily, isAgentEnabled } from "./lib/pick.js";
import { nextStateAfterOutcome, sharedQuotaBucketIds, withObservations, floorExhaustionReset } from "./lib/outcome.js";
import { resolveExhaustionResetAt } from "./lib/quota-reset.js";
import { persistCredential, bootEnv, KEYS_FILE } from "./lib/credentials.js";
import { writeText } from "./lib/stream-write.js";
import { readDispatchRows, runChecks, formatReport } from "./lib/doctor.js";
import {
  recordFailure,
  readFailureLogConfig,
  setFailureLogEnabled,
  readFailures,
  getFailureLogPath,
  getRotatedLogPath,
  getConfigPath as getFailureLogConfigPath,
} from "./lib/failure-log.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

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
const BOOLEAN_FLAGS = new Set(["json", "pro", "no-open", "force", "stream", "enabled", "disabled", "include-disabled"]);
const ARRAY_FLAGS = new Set(["file"]);
const VALID_EFFORT_LEVELS = new Set(["none", "minimal", "default", "low", "medium", "high", "xhigh", "max"]);
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (ARRAY_FLAGS.has(key) && nxt !== undefined && !nxt.startsWith("--")) {
        if (!Array.isArray(flags[key])) flags[key] = [];
        flags[key].push(nxt); i++;
      } else if (!BOOLEAN_FLAGS.has(key) && nxt !== undefined && !nxt.startsWith("--")) { flags[key] = nxt; i++; }
      else if (!ARRAY_FLAGS.has(key)) flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}
function die(msg, code = 2) { console.error(msg); process.exit(code); }

// A refusal is a failed attempt too, and it is the class the operator is least
// likely to reconstruct later: nothing was spawned, so there is no stderr, no
// exit code, and nothing at all in the dispatch log. "Why did half my fan-out
// silently do nothing" almost always answers to one of these four lines.
function refuse(msg, code, record) {
  recordFailure({ stage: "precheck", outcome: "refused", reason: msg, ...record });
  die(msg, code);
}
function findAgent(id) { return REGISTRY.agents.find((a) => a.id === id); }
function resolveEffort(entry, transport, effort) {
  if (!effort) return undefined;
  if (!VALID_EFFORT_LEVELS.has(effort)) {
    die(`dispatch: invalid --effort '${effort}' (valid: none, minimal, default, low, medium, high, xhigh, max)`, 2);
  }
  const config = getTransportConfig(entry, transport);
  const supported = Array.isArray(config?.effort_levels) ? config.effort_levels : [];
  if (supported.includes(effort)) return effort;
  return undefined;
}

// --- subcommands --------------------------------------------------
function cmdPick(flags) {
  const n = parseInt(flags.n || "1", 10);
  const baseFilter = {};
  if (flags.tags) baseFilter.tags = String(flags.tags).split(",").filter(Boolean);
  if (flags.exclude) baseFilter.exclude_ids = String(flags.exclude).split(",").filter(Boolean);
  if (flags["exclude-providers"]) {
    // Passed through rather than expanded to ids here: pickAgents matches by
    // provider FAMILY, so `--exclude-providers google` covers google3..google8.
    // Expanding by exact slug in the CLI is what let a numbered clone through,
    // and it also left the MCP path (which never saw this flag) unprotected.
    baseFilter.exclude_providers = String(flags["exclude-providers"]).split(",").filter(Boolean);
  }
  if (flags.transport) baseFilter.transport = flags.transport;
  // --prompt-bytes / --prompt-tokens: seat only agents whose declared limits can
  // actually hold the prompt you are about to send. Optional; without it, sizing
  // is not considered at all and pick behaves exactly as before.
  for (const [flag, key] of [["prompt-bytes", "prompt_bytes"], ["prompt-tokens", "prompt_tokens"]]) {
    if (flags[flag] === undefined) continue;
    const v = Number(flags[flag]);
    if (!Number.isFinite(v) || v <= 0) die(`pick: --${flag} must be a positive number`, 2);
    baseFilter[key] = v;
  }
  if (flags.effort) {
    if (!VALID_EFFORT_LEVELS.has(String(flags.effort))) {
      die(`pick: invalid --effort '${flags.effort}' (valid: none, minimal, default, low, medium, high, xhigh, max)`, 2);
    }
    baseFilter.effort = String(flags.effort);
  }
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
      // providers so the panel stays provider-diverse. Both go through
      // pickAgents' family matching: excluding the raw slug `google3` used to
      // leave `google4` free to backfill the same model into the next slot.
      const usedFamilies = new Set(
        primary.map((id) => findAgent(id)?.provider).filter(Boolean).map(providerFamily),
      );
      const remainingDistinct = minDistinct != null ? Math.max(0, minDistinct - usedFamilies.size) : undefined;
      const backfill = pickAgents(REGISTRY, state, {
        n: n - out.length,
        filter: {
          ...baseFilter,
          tier: other,
          exclude_ids: [...(baseFilter.exclude_ids || []), ...primary],
          exclude_providers: [...(baseFilter.exclude_providers || []), ...usedFamilies],
        },
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
  if (!agentId) die("usage: cli.js dispatch <agent-id> [--pro] [--json] [--stream] [--transport generate_new|edit_exists|read_only] [--effort <level>] [--cwd <dir>] [--file path[:lines]] \"<prompt>\"", 2);
  if (!prompt) die("dispatch: missing prompt", 2);

  // --file path[:lines] — repeatable. "src/foo.ts:10-50" → {path, lines}.
  const rawFiles = Array.isArray(flags.file) ? flags.file : [];
  const fileEntries = rawFiles.map((f) => {
    const colonIdx = f.lastIndexOf(":");
    if (colonIdx > 0 && /^\d+-\d+$/.test(f.slice(colonIdx + 1))) {
      return { path: f.slice(0, colonIdx), lines: f.slice(colonIdx + 1) };
    }
    return { path: f };
  });

  const src = findAgent(agentId);
  if (!src) refuse(`unknown agent: ${agentId}`, 3, { agent_id: agentId });
  // A naked agent-id dispatch bypasses pickAgents entirely, so its own kill-switch
  // filter never runs — naming an id explicitly used to be enough to reach a
  // provider the operator had deliberately disabled (e.g. a corporate network
  // policy blocking it outright). Refuse the same way pick does.
  if (!isAgentEnabled(src, readState())) {
    refuse(
      `agent disabled: ${agentId} (re-enable with: external-agents toggle ${agentId} --enabled)`,
      5,
      { agent_id: agentId, provider: src.provider, model: src.model },
    );
  }

  // --require-base: refuse to dispatch when the checkout is not the base the
  // caller expected. The failure this prevents is not hypothetical — a worker
  // pointed at a cwd sitting a couple hundred commits behind reviews code that
  // no longer exists upstream, reports it accurately, and gets dismissed as
  // making things up. runAny always TELLS the worker where it is; this is for
  // when the caller wants that to be a precondition rather than a note.
  //
  // Checked here, before escalation resolution and before last_used_at is
  // stamped, so a refusal leaves no trace in the agent's STATE: nothing was
  // dispatched, so nothing should look as though it was. (The sidecar failure
  // log, when the operator has switched it on, does record the refusal — that
  // file is a record of what happened, not a claim about the agent's health.)
  //
  // Off by default and never inferred. A stale checkout is sometimes exactly
  // what you meant to inspect, and a tool that decides that for you is worse
  // than one that stays quiet.
  if (flags["require-base"]) {
    if (!flags.cwd) refuse("--require-base needs --cwd: there is no checkout to check without one", 2, { agent_id: agentId });
    assertRequiredBase(String(flags.cwd), String(flags["require-base"]), agentId);
  }

  let entry = src;
  let escalatedFrom;
  if (flags.pro) {
    const esc = resolveEscalation(REGISTRY, agentId, readState());
    if (!esc) {
      recordFailure({
        stage: "precheck",
        outcome: "refused",
        reason: `no escalation candidate available for ${agentId} (--pro)`,
        agent_id: agentId,
        provider: src.provider,
        model: src.model,
      });
      console.error(JSON.stringify({ outcome: "no_escalation_candidate", requested: agentId }));
      process.exit(4);
    }
    entry = esc;
    escalatedFrom = agentId;
  }

  const cur = readState();
  writeState({ [entry.id]: { ...(cur[entry.id] || {}), last_used_at: Math.floor(Date.now() / 1000) } });

  const transport = flags.transport;  // "generate_new" | "edit_exists" | undefined
  // A transport refusal is a refusal, not a crash. It used to escape as an
  // uncaught exception: a Node stack trace on stderr and exit 1, which a caller
  // could only report as "rc=1". runAny records the failure row; this turns it
  // into the same shape as every other pre-dispatch refusal here.
  let resolvedTransport;
  try {
    resolvedTransport = selectTransport(entry, { transport, cwd: flags.cwd });
  } catch (e) {
    // Recorded here, the same way every other pre-dispatch refusal in this
    // function is: the CLI resolves the transport before runAny, so runAny's own
    // capture point never sees this one.
    recordFailure({
      stage: "precheck",
      outcome: "refused",
      surface: "cli",
      reason: e.message,
      agent_id: entry.id,
      provider: entry.provider,
      model: entry.model,
      requested_transport: transport ?? null,
      declared_transports: Object.keys(entry.transports || {}),
    });
    console.error(JSON.stringify({
      outcome: "transport_refused",
      requested: entry.id,
      requested_transport: transport ?? null,
      declared_transports: Object.keys(entry.transports || {}),
      reason: e.message,
    }));
    process.exit(4);
  }
  const effort = resolveEffort(entry, resolvedTransport, flags.effort ? String(flags.effort) : undefined);
  const files = fileEntries.length > 0 ? fileEntries : undefined;
  const progress = !flags.json
    ? (message, meta = {}) => {
        if (meta.type === "stream") {
          if (flags.stream) process.stderr.write(message);
          return;
        }
        process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
      }
    : undefined;
  const result = await runAny(entry, prompt, { transport, cwd: flags.cwd, files, effort, progress });
  const now = Math.floor(Date.now() / 1000);

  // Centralized outcome→state via nextStateAfterOutcome (lib/outcome.js): tracks
  // consecutive_failures and applies an escalating cooldown (60s→5m→30m→2h→12h),
  // so an agent that keeps failing — even with plain errors, which USED to write
  // no state at all and got re-picked every round — drops out of `pick` for
  // progressively longer. Success resets the streak. Same helper in server.js
  // so the two dispatch surfaces never drift.
  const ok = result.exitCode === 0;
  const failText = result.stderr + "\n" + result.output;
  const failure = ok
    ? { cliFailure: { needsAuth: false, quotaExhausted: false }, exhaustionSignal: { detected: false }, isExhaustion: false }
    : classifyDispatchFailure(failText);
  // Resolve the REAL reset (period-aware, provider-aware) from the failing output — e.g. a CLI
  // "Monthly request limit reached" resolves to +7d, not the ladder's first rung. No headers on
  // the CLI path, so this uses body text + provider policy only.
  // Only a `limited` (rate-limit/quota) outcome carries a reset; a plain transient fault climbs the
  // ladder and ignores resetAt.
  const isExhaustion = failure.isExhaustion;
  // Headers are passed now that every dispatch return carries them (see the
  // hoist in lib/dispatch.js). The comment here used to say there were none,
  // which was true of the CLI transports and quietly wrong for every HTTP one —
  // so the most precise reset available was being ignored on exactly the
  // providers that publish it.
  let exhaustionResetAt = (!ok && isExhaustion)
    ? resolveExhaustionResetAt({
        text: failText,
        headers: result.responseHeaders,
        provider: entry.provider,
        nowMs: Date.now(),
      })
    : undefined;
  if (!ok && isExhaustion) {
    exhaustionResetAt = floorExhaustionReset(exhaustionResetAt, result.responseHeaders, now);
  }
  const prev = readState()[entry.id];
  const nextRec = failure.cliFailure.needsAuth
    ? {
        ...prev,
        state: "needs_auth",
        note: "CLI reports not authenticated — run login flow for this CLI",
        checked: now,
      }
    : nextStateAfterOutcome(prev, {
        ok,
        isExhaustion,
        exhaustionResetAt,
        now,
      });
  const stateWrite = { [entry.id]: withObservations({ base: nextRec, prev, result, ok, now }) };
  // One allowance, many entries: an account-wide free tier is exhausted for
  // every sibling the moment one of them hits it, so they go down together
  // rather than being picked in turn to rediscover the same cap.
  if (!ok && isExhaustion) {
    for (const siblingId of sharedQuotaBucketIds(entry, REGISTRY.agents)) {
      const sibling = REGISTRY.agents.find((a) => a.id === siblingId);
      const currentState = readState();
      // A switched-off sibling is not dispatchable, so recording an allowance it
      // cannot spend just adds a row nobody reads.
      if (!sibling || !isAgentEnabled(sibling, currentState)) continue;
      const prevSibling = currentState[siblingId];
      if (prevSibling?.state === "quota_exhausted" && (prevSibling.cooldown_until ?? 0) >= (nextRec.cooldown_until ?? 0)) continue;
      stateWrite[siblingId] = nextStateAfterOutcome(prevSibling, { ok: false, isExhaustion: true, exhaustionResetAt, now });
    }
  }
  writeState(stateWrite);
  const outcome = ok ? "success" : (isExhaustion ? "quota_exhausted" : "error");

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
      // Which checkout produced this. A programmatic caller comparing two
      // workers' answers needs to know they read the same tree before it
      // treats a disagreement as a disagreement about the code.
      repo: result.provenance ?? null,
    };
    if (escalatedFrom) payload.escalated_from = escalatedFrom;
    await writeText(process.stdout, JSON.stringify(payload) + "\n");
  } else {
    await writeText(process.stdout, result.output);
    const trailer = { agent_id: entry.id, outcome, exit_code: result.exitCode, duration_ms: result.durationMs, workdir: result.workdir, files: result.files };
    if (result.provenance?.head) {
      trailer.repo = {
        branch: result.provenance.branch,
        head: result.provenance.short,
        behind: result.provenance.behind,
        dirty: result.provenance.dirty,
      };
    }
    if (escalatedFrom) trailer.escalated_from = escalatedFrom;
    await writeText(process.stderr, "__EXTERNAL_AGENTS_TRAILER__ " + JSON.stringify(trailer) + "\n");
  }

  process.exitCode = outcome === "success" ? 0 : (outcome === "quota_exhausted" ? 4 : 1);
}

// The --require-base check. Two distinct ways this fails, and they need
// different words or the operator just sees "no" and starts guessing:
//   - the ref does not resolve in this repo at all — usually origin/main that
//     was never fetched into a fresh clone or worktree;
//   - it resolves, but HEAD does not contain it: the checkout is behind, or has
//     diverged onto another lineage. That is the stale-worktree case, and the
//     error reports how far, because "195 behind" is the number that explains
//     why the report you are about to get would have described other code.
//
// Passing means HEAD contains the base. Being AHEAD of it is fine — the base is
// a floor, not an equality check; a task branch with work on top of origin/main
// is the normal case, not a violation.
//
// Reads only. It never fetches: a dispatch that silently mutated the caller's
// repo to satisfy its own precondition would be a far nastier surprise than
// the stale checkout it was guarding against. The counts are therefore
// relative to refs already on disk, and the error says so.
function assertRequiredBase(cwd, baseRef, agentId) {
  const refuseBase = (msg, code) => refuse(msg, code, { agent_id: agentId, cwd, base_ref: baseRef });
  const prov = repoProvenance(cwd);
  if (!prov) refuseBase(`--require-base ${baseRef}: ${cwd} is not inside a git repository`, 2);
  if (!prov.head) refuseBase(`--require-base ${baseRef}: ${prov.root} has no commits`, 2);

  const git = (args) => spawnSync("git", ["-C", prov.root, ...args], { encoding: "utf-8", timeout: 5000 });
  const resolved = git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (resolved.status !== 0 || !(resolved.stdout || "").trim()) {
    refuseBase(`--require-base ${baseRef}: that ref does not resolve in ${prov.root} (fetch it first: git -C ${prov.root} fetch origin)`, 6);
  }
  const baseSha = resolved.stdout.trim();

  if (git(["merge-base", "--is-ancestor", baseSha, prov.head]).status !== 0) {
    const counts = git(["rev-list", "--left-right", "--count", `${baseSha}...${prov.head}`]);
    const drift = counts.status === 0 ? ` (${counts.stdout.trim().replace(/\s+/, " behind, ")} ahead, as of the last fetch)` : "";
    refuseBase(
      `--require-base ${baseRef}: refusing to dispatch — ${prov.root} is on ` +
      `${prov.detached ? `detached ${prov.short}` : `${prov.branch} @ ${prov.short}`}, which does not contain ${baseRef}${drift}. ` +
      `Anything the agent reports would be about a different version of this project than you asked about.`,
      6,
    );
  }
}

// Housekeeping attached to `audit` rather than to every command: audit is the
// periodic maintenance pass, it already writes state.json, and a sweep on every
// `pick` would be a surprising side effect on the hot path.
//
// Dispatch temp directories hold `generated.md` — the model's full response in
// plain text — and the OS reclaims them only after roughly a month. Reported on
// stderr so it never lands in --json stdout, and returned so the JSON branch can
// include it as data.
function reportTempSweep() {
  const swept = sweepDispatchTemp();
  if (swept.removed > 0) {
    const mb = (swept.bytes / (1024 * 1024)).toFixed(1);
    console.error(
      `swept ${swept.removed} dispatch temp director${swept.removed === 1 ? "y" : "ies"} older than ${swept.retention_days}d (${mb} MB)` +
      (swept.failed ? `; ${swept.failed} could not be removed` : "") +
      // Deliberately does NOT advertise 0: with a zero window the cutoff is
      // "now", which would collect the workdir of a dispatch running this
      // second — the one thing the retention window exists to protect.
      ` — set EXTERNAL_AGENTS_TEMP_RETENTION_DAYS to change the window; a negative value disables the sweep.`,
    );
  }
  return swept;
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
  // `state` and `enabled` answer two different questions and the table used to
  // show only the first, so a switched-off entry rendered as a bare "healthy"
  // — true (its key works) and useless (nothing will ever dispatch to it).
  // Both registry-level `enabled: false` (paid entries, DeepSeek) and the
  // operator toggle land in the same column.
  //
  // deriveDisplayState is applied here for the same reason the dashboard
  // applies it: a record whose cooldown has already elapsed is no longer
  // binding, and printing the expired verdict makes the pool look worse than
  // it is.
  const rows = REGISTRY.agents.map((e) => {
    const merged = state[e.id] ? { ...e, ...state[e.id] } : { ...e, ...probeInstalled(e) };
    return { ...deriveDisplayState(merged), enabled: isAgentEnabled(e, state) };
  });
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const w = 42;
  console.log(`${"agent".padEnd(w)} ${"state".padEnd(18)} ${"use".padEnd(4)} ${"tier".padEnd(7)} tags`);
  console.log("-".repeat(101));
  for (const r of rows) {
    const tagsStr = (r.tags || []).join(",");
    console.log(`${r.id.padEnd(w)} ${(r.state || "?").padEnd(18)} ${(r.enabled ? "on" : "OFF").padEnd(4)} ${(r.tier || "-").padEnd(7)} ${tagsStr}`);
  }
  const off = rows.filter((r) => !r.enabled);
  if (off.length) {
    // Capped the same way outOfScopeReason caps its file list: one API key per
    // provider clone means a single switched-off model can contribute eight ids,
    // and a summary that wraps three terminal lines stops being a summary.
    const shown = off.slice(0, 8).map((r) => r.id).join(", ");
    const more = off.length > 8 ? ` (+${off.length - 8} more)` : "";
    console.log();
    console.error(`${off.length} entr${off.length === 1 ? "y is" : "ies are"} switched off and will never be picked or dispatched, whatever their state column says: ${shown}${more}`);
    console.error(`turn one on with: external-agents toggle <agent-id> --enabled`);
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
  // Same kill-switch guard as `dispatch <id>` (see the disabled-guard test) —
  // naming a disabled entry's id directly must not spend a probe on it either.
  if (!isAgentEnabled(entry, readState())) {
    die(`agent disabled: ${agentId} (re-enable with: external-agents toggle ${agentId} --enabled)`, 5);
  }
  const result = probeInstalled(entry);
  const checked = Math.floor(Date.now() / 1000);
  writeState({ [agentId]: { ...result, checked } });
  console.log(JSON.stringify({ id: agentId, ...result, checked }));
}

// `external-agents verify-read-only <id>` runs the entry's declared `read_only`
// command against a canary file and confirms it truly can't write — the
// acceptance check the read_only axis exists to enforce (see dispatch.js's
// probeReadOnlyNonWriting for why a command that LOOKS non-writing, e.g.
// `--allowedTools` which only ADDS permissions, cannot be trusted on sight).
// Exits non-zero on any non-verified result so it composes in a pre-merge check.
async function cmdVerifyReadOnly(args) {
  const [agentId] = args;
  if (!agentId) die("usage: cli.js verify-read-only <agent-id>", 2);
  const entry = findAgent(agentId);
  if (!entry) die(`unknown agent: ${agentId}`, 3);
  const result = await probeReadOnlyNonWriting(entry);
  console.log(JSON.stringify({ id: agentId, ...result }));
  if (!result.verified) process.exitCode = 1;
}

// `external-agents toggle <id> --enabled|--disabled` — flip the same operator
// kill switch as the local UI's POST /api/toggle, so a caller never needs the
// UI's HTTP server just to enable/disable an agent. writeState does a SHALLOW
// merge, so we deep-merge here to keep probe results (state, note, checked,
// last_used_at) intact across the flip — mirrors ui.js's /api/toggle exactly.
function cmdToggle(args, flags) {
  const [agentId] = args;
  if (!agentId || !(flags.enabled || flags.disabled) || (flags.enabled && flags.disabled)) {
    die("usage: external-agents toggle <agent-id> --enabled|--disabled", 2);
  }
  if (!findAgent(agentId)) die(`unknown agent: ${agentId}`, 3);
  const enabled = Boolean(flags.enabled);
  const current = readState()[agentId] || {};
  writeState({ [agentId]: { ...current, enabled } });
  console.log(JSON.stringify({ id: agentId, enabled }));
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
    // Read from stdin. Interactively a terminal never sends EOF after Enter —
    // waiting for 'end' would hang until Ctrl-D — so on a TTY we take the first
    // line. Piped/redirected input still reads to EOF (multi-line keys, no
    // trailing newline, etc.).
    if (process.stdin.isTTY) {
      process.stderr.write(`Enter value for ${envName} (echoed): `);
      const rl = readline.createInterface({ input: process.stdin });
      value = await new Promise((resolve) => rl.once("line", resolve));
      rl.close();
    } else {
      value = await new Promise((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => { buf += chunk; });
        process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
      });
    }
  }
  try {
    const persistedTo = persistCredential(envName, value);
    const resetIds = resetCooldownsForEnvVar(envName, REGISTRY.agents);
    const enabledIds = enableAgentsAwaitingCredential(envName, REGISTRY.agents);
    // Print to stderr so stdout stays clean for scripting; do NOT echo the value.
    console.error(`external-agents: ${envName} persisted to ${persistedTo}`);
    if (enabledIds.length > 0) {
      console.error(`  Enabled ${enabledIds.length} agent(s) that were off pending this key: ${enabledIds.join(", ")}`);
    }
    if (resetIds.length > 0) {
      console.error(`  Cooldowns reset for ${resetIds.length} agent(s): ${resetIds.join(", ")}`);
    }
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
  const skipOpen = flags["no-open"] === true;
  // Spawn UI first, then open browser once it confirms it's actually listening.
  const uiPath = path.join(path.dirname(new URL(import.meta.url).pathname), "ui.js");
  const env = { ...process.env, EXTERNAL_AGENTS_UI_PORT: String(port), EXTERNAL_AGENTS_UI_HOST: host };
  // stderr is piped (not inherited) so this function can watch for ui.js's
  // bound-port confirmation line — ui.js now falls back to PORT+1, PORT+2...
  // when `port` is taken, so the real port can differ from what we requested,
  // and blindly opening a browser at the requested `port` after a fixed delay
  // (the old approach) would point at the wrong URL. Every chunk is still
  // relayed to our own stderr unconditionally, so terminal output looks the
  // same as before (stdin/stdout stay inherited either way).
  const child = spawn(process.execPath, [uiPath], { stdio: ["inherit", "inherit", "pipe"], env });
  let opened = skipOpen; // skip the open-once logic entirely when --no-open
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    if (opened) return;
    const match = chunk.toString().match(/external-agents ui: (https?:\/\/\S+)/);
    if (!match) return;
    opened = true;
    const realUrl = match[1];
    const opener =
      process.platform === "darwin" ? "open" :
      process.platform === "win32"  ? "cmd" :
      "xdg-open";
    const openerArgs = process.platform === "win32" ? ["/c", "start", "", realUrl] : [realUrl];
    // Browser-open is best-effort — swallow BOTH sync spawn errors AND async
    // 'error' events (ENOENT is emitted async, not thrown; without a listener
    // it crashes the process — this is what breaks curl|bash on a headless
    // Linux box that has no xdg-open installed). The UI keeps running either way.
    try {
      const opener_proc = spawn(opener, openerArgs, { stdio: "ignore", detached: true });
      opener_proc.on("error", (err) => {
        console.error(`external-agents init: could not launch browser (${err.code || err.message}) — open ${realUrl} manually.`);
      });
      opener_proc.unref();
    } catch (err) {
      console.error(`external-agents init: could not launch browser (${err.message}) — open ${realUrl} manually.`);
    }
  });
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
  const includeDisabled = flags["include-disabled"] === true;
  // Before entry selection, not after. Housekeeping must not depend on the
  // audit finding work: `audit --provider X` where every X is switched off
  // exits early with "no enabled entries match", and that is a perfectly
  // ordinary way to run this command — it should still tidy up.
  const tempSweep = reportTempSweep();
  const auditState = readState();
  // A disabled entry cannot be dispatched — pick hides it and a by-id dispatch
  // refuses it — so auditing one buys nothing and is not free: `audit` is the
  // path that spends a REAL round-trip, and for a prepaid provider (DeepSeek)
  // that is money spent proving an agent nobody can call is reachable. Worse,
  // it then writes `healthy` next to an entry that is switched off, which is
  // exactly the reading that makes a pool look larger than it is.
  //
  // --include-disabled is the escape hatch for the one case that matters: you
  // are deciding whether to turn something back on and want to know if it
  // still works first.
  const skippedDisabled = [];
  const entries = REGISTRY.agents.filter((a) => {
    if (providerFilter && a.provider !== providerFilter) return false;
    if (!(a.transports?.generate_new?.url || a.transports?.edit_exists)) return false;
    if (!includeDisabled && !isAgentEnabled(a, auditState)) {
      skippedDisabled.push(a.id);
      return false;
    }
    return true;
  });
  if (entries.length === 0) {
    die(
      `audit: no enabled entries match${providerFilter ? ` provider=${providerFilter}` : ""}` +
      (skippedDisabled.length ? ` (${skippedDisabled.length} disabled entr${skippedDisabled.length === 1 ? "y" : "ies"} skipped; --include-disabled to audit them anyway)` : ""),
      3,
    );
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
        const outcome = classifyVerifyResult(v);
        const note =
          v.ok            ? `verified (${v.latencyMs}ms)${hasApi ? "" : " (cli)"}`
          : v.hint        ? v.hint + (v.status ? ` (HTTP ${v.status})` : "")
          : `HTTP ${v.status || "?"}`;
        // Which outcomes carry an expiry, and how long, now lives in
        // auditCooldown (lib/state.js) — the dashboard's /api/audit ran a
        // second copy of this expression and the two had to be kept in step
        // by hand.
        const { cooldown_until, source: cooldownSource } = auditCooldown(outcome, v);
        // "probe_error" means our own shell failed, not the agent. Persisting
        // it would blame the agent for our PATH and — since any non-healthy
        // record blocks pick until it expires — pull a working entry out of
        // rotation. Leave whatever state.json already says alone.
        if (shouldPersistOutcome(outcome)) {
          const existing = readState()[entry.id] || {};
          writeState({
            [entry.id]: mergeAuditState(existing, {
              outcome,
              note,
              checked: Math.floor(Date.now() / 1000),
              cooldown_until,
              source: cooldownSource,
              verifyResult: v,
            }),
          });
        }
        out.push({ id: entry.id, provider: entry.provider, model: entry.model, outcome, status: v.status || null, note });
      }
      return out;
    })
  );
  for (const b of providerBatches) results.push(...b);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (asJson) {
    console.log(JSON.stringify({ elapsed_s: parseFloat(elapsed), results, skipped_disabled: skippedDisabled, temp_sweep: tempSweep }, null, 2));
    return;
  }
  // Human-readable table.
  const pad = (s, n) => String(s).padEnd(n);
  const w = { id: 34, provider: 12, outcome: 20, note: 60 };
  console.log(pad("agent", w.id) + pad("provider", w.provider) + pad("verdict", w.outcome) + "note");
  console.log("-".repeat(w.id + w.provider + w.outcome + w.note));
  const sym = { healthy: "✓", needs_auth: "⚠", model_unavailable: "✗", rate_limited: "⏳", quota_exhausted: "⏳", errored_transient: "?", probe_error: "!" };
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
  if (counts.probe_error) {
    console.error(`${counts.probe_error} entr${counts.probe_error === 1 ? "y" : "ies"} could not be probed at all (the command failed to execute) — their stored state was left untouched. Usually a PATH problem in the process running the audit.`);
  }
  if (skippedDisabled.length) {
    console.error(`skipped ${skippedDisabled.length} disabled entr${skippedDisabled.length === 1 ? "y" : "ies"}: ${skippedDisabled.join(", ")} — pass --include-disabled to audit them.`);
  }
}

// Append a locally-authored agent to the local overlay yaml. Minimum viable:
// caller passes id / provider / url / model / env; we build the entry and
// merge it into ~/.local/state/external-agents/agents.local.yaml.
async function cmdAddModel(flags) {
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
      // An OpenAI-compatible completion call holds no filesystem handle, so the
      // read-only role is served by this transport itself — the `by_construction`
      // basis the registry documents, and the shape every bundled HTTP entry
      // already uses. Written here because leaving it out is not a neutral
      // omission: `pick --transport read_only` seats an undeclared entry while
      // `selectTransport` refuses it, so a locally added model was picked into
      // consensus panels and then died on dispatch. Measured on the only entry in
      // the registry that lacked it — a locally added one — across 11 of 16 runs.
      read_only: {
        via: "generate_new",
        verified: "by_construction",
      },
      generate_new: {
        url: String(flags.url),
        env: String(flags.env),
        model: String(flags.model),
      },
    },
  };
  // Preserve the original unreadable-file check outside the lock so the exact
  // die() message/exit code still fires for a corrupt existing overlay —
  // withLocalOverlayLock's generic mutator silently treats unreadable as
  // empty, which is right for the UI's add_provider_key path but would look
  // like silent data loss from a direct CLI invocation.
  if (fs.existsSync(LOCAL_PATH)) {
    try {
      yaml.load(fs.readFileSync(LOCAL_PATH, "utf-8"));
    } catch (e) {
      die(`add-model: existing ${LOCAL_PATH} unreadable — ${e.message}`, 1);
    }
  }
  let replaced = false;
  try {
    await withLocalOverlayLock(async (overlay) => {
      const idx = overlay.agents.findIndex((a) => a.id === entry.id);
      if (idx >= 0) {
        overlay.agents[idx] = entry;
        replaced = true;
      } else {
        overlay.agents.push(entry);
        replaced = false;
      }
      return overlay;
    });
  } catch (e) {
    die(`add-model: failed to write overlay — ${e.message}`, 1);
  }
  console.log(`${replaced ? "replaced" : "added"}: ${entry.id}`);
  console.log(`wrote:    ${LOCAL_PATH}`);
  console.log(`re-run 'external-agents probe ${entry.id}' to verify.`);

  // A new entry with no ceiling anywhere is the shape that costs the most.
  // `azure-kimi-k2-5-safe` was added this way, declared nothing, and turned out
  // to have a 5000-token-per-minute cap — so every review prompt sent to it was
  // arithmetically impossible and it failed 47% of the time for weeks.
  //
  // A warning, not a refusal: `audit` now reads the ceiling straight out of the
  // provider's response headers, so the honest instruction is "go measure it",
  // and refusing would only push the operator into hand-writing a guess.
  const voiceOf = (e) => `${providerFamily(e.provider)}::${e.model || e.id}`;
  const siblingHasLimits = REGISTRY.agents.some(
    (a) => a.id !== entry.id && a.token_limits && voiceOf(a) === voiceOf(entry),
  );
  if (!entry.token_limits && !siblingHasLimits) {
    console.log("");
    console.log(`note:     ${entry.id} declares no token_limits, and no sibling key declares any.`);
    console.log(`          Until something measures its ceiling, pick cannot keep an oversized`);
    console.log(`          prompt away from it. Run 'external-agents audit --provider ${entry.provider}'`);
    console.log(`          — the probe reads the real limits out of the response headers.`);
  }
}

// --- failures -----------------------------------------------------
//
// The sidecar failure log's whole reason to exist is that its output gets
// handed to a model. So `tail` is not a pretty-printer: it emits the raw JSONL
// verbatim, which is the form a model reads best and the form that survives a
// copy-paste. `status`, by contrast, is for the human deciding whether to look.
function cmdFailures(args, flags) {
  const [action = "status", ...restArgs] = args;
  const file = getFailureLogPath();

  switch (action) {
    case "on":
    case "off": {
      const enabled = action === "on";
      const cfg = setFailureLogEnabled(enabled);
      const effective = readFailureLogConfig();
      console.log(`failure log: ${enabled ? "ON" : "OFF"}`);
      console.log(`flag:        ${getFailureLogConfigPath()} (failure_log.enabled = ${cfg.enabled})`);
      console.log(`log:         ${file}`);
      if (effective.enabled !== enabled) {
        // The env var outranks the file on purpose, but silently ignoring a
        // switch the operator just flipped is how you lose an afternoon.
        console.error(
          `warning: EXTERNAL_AGENTS_FAILURE_LOG=${process.env.EXTERNAL_AGENTS_FAILURE_LOG} is set in this shell ` +
          `and overrides the file, so the effective setting is still ${effective.enabled ? "ON" : "OFF"}. Unset it.`,
        );
      }
      if (enabled) {
        console.log("");
        console.log("Every failed attempt — dispatch, audit, credential verify, read-only probe,");
        console.log("and pre-dispatch refusal — is now appended with its full raw output.");
        console.log("Prompts are elided by default; 'failures on --with-prompts' includes them.");
      }
      if (enabled && flags["with-prompts"]) {
        const current = JSON.parse(fs.readFileSync(getFailureLogConfigPath(), "utf-8"));
        current.failure_log.include_prompt = true;
        fs.writeFileSync(getFailureLogConfigPath(), JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
        console.log("prompt capture: ON (prompts will be written to the log)");
      }
      return;
    }
    case "path":
      console.log(file);
      return;
    case "clear": {
      for (const f of [file, getRotatedLogPath()]) {
        try { fs.rmSync(f); console.log(`removed ${f}`); } catch { /* nothing there */ }
      }
      return;
    }
    case "tail": {
      const limit = Number(restArgs[0] || flags.n || 20);
      const rows = readFailures(Number.isFinite(limit) && limit > 0 ? limit : 20);
      if (!rows.length) {
        console.error(`no failures recorded in ${file}`);
        process.exitCode = 1;
        return;
      }
      for (const row of rows) console.log(JSON.stringify(row));
      return;
    }
    case "status": {
      const cfg = readFailureLogConfig();
      const rows = cfg.enabled || fs.existsSync(file) ? readFailures(0) : [];
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* not created yet */ }
      console.log(`failure log: ${cfg.enabled ? "ON" : "OFF"}`);
      console.log(`flag file:   ${getFailureLogConfigPath()}`);
      console.log(`log file:    ${file}${size ? ` (${(size / 1024).toFixed(1)} KiB, ${rows.length} record(s))` : " (empty)"}`);
      console.log(`prompts:     ${cfg.include_prompt ? "captured" : "elided"}`);
      if (!cfg.enabled) {
        console.log("");
        console.log("Turn it on with:  external-agents failures on");
        console.log("It survives upgrades — the flag lives in your state dir, not in the package.");
        return;
      }
      if (rows.length) {
        const byAgent = {};
        for (const r of rows) byAgent[r.agent_id || "<none>"] = (byAgent[r.agent_id || "<none>"] || 0) + 1;
        const top = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 8);
        console.log("");
        console.log("most failures:");
        for (const [id, n] of top) console.log(`  ${String(n).padStart(4)}  ${id}`);
        const last = rows[rows.length - 1];
        console.log("");
        console.log(`latest:  ${last.iso}  ${last.agent_id || "-"}  [${last.stage}/${last.outcome}]`);
        console.log(`         ${String(last.reason || "").slice(0, 140)}`);
        console.log("");
        console.log(`hand the raw log to a model:  external-agents failures tail 50`);
      }
      return;
    }
    default:
      die(`failures: unknown action '${action}' — use status | on | off | tail [N] | path | clear`, 2);
  }
}

function cmdUi(flags) {
  // Same behavior as `init` — start UI, then open the browser after a short
  // delay to let the port bind. Pass --no-open to skip the browser (useful in
  // SSH / tmux where a launched browser would just open on the wrong screen).
  cmdInit(flags);
}

// `doctor` — check the five goals in README against the telemetry, daily.
//
// Deliberately a subcommand and not a personal script: every defect this guards
// was found by reading these same logs by hand, weeks after the fact. A check
// that ships with the tool runs for everybody who installs it, gets tested in
// CI, and cannot rot in somebody's home directory.
function cmdDoctor(flags) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - parseWindowSeconds(flags.since ?? "24h");
  const result = runChecks({
    rows: readDispatchRows(),
    registry: REGISTRY,
    state: readState(),
    since,
    now,
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    // Same convention as the human report: only a `high` finding fails the run.
    process.exit(result.findings.some((f) => f.severity === "high") ? 1 : 0);
  }
  const { text, exitCode } = formatReport(result);
  console.log(text);
  process.exit(exitCode);
}

/** `--since 24h | 7d | 90m | 3600` → seconds. */
function parseWindowSeconds(raw) {
  const s = String(raw).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(s);
  if (!m) die(`doctor: --since must look like 24h, 7d, 90m or a number of seconds (got '${raw}')`, 2);
  const n = parseFloat(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, "": 1 }[m[2].toLowerCase()];
  const secs = Math.round(n * mult);
  if (!(secs > 0)) die("doctor: --since must be positive", 2);
  return secs;
}

// --- entrypoint ---------------------------------------------------
const [, , subcmd, ...rest] = process.argv;
const { args, flags } = parseArgs(rest);

// `<subcommand> --help` printed nothing and RAN the subcommand: `pick --help`
// performed a real pick and returned an agent id. Anything shell-side that
// probed for a flag that way — the consensus runner's feature detection did
// exactly this — read the agent id, concluded the flag was absent, and silently
// dropped it, while spending a pick call per probe.
const helpRequested = flags.help === true || flags.h === true;

// `--version` is what a scheduled job prints into its own report so that "the
// daily check was running a stale build" is visible instead of invisible. It
// used to fall through to `default` and die with "unknown subcommand".
if (subcmd === "--version" || subcmd === "-v" || subcmd === "version") {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "package.json"), "utf-8"),
  );
  console.log(pkg.version);
  process.exit(0);
}

switch (helpRequested ? "--help" : subcmd) {
  case "pick":     cmdPick(flags); break;
  case "dispatch": cmdDispatch(args, flags); break;
  case "status":   cmdStatus(flags); break;
  case "probe":    cmdProbe(args); break;
  case "verify-read-only": await cmdVerifyReadOnly(args); break;
  case "toggle":   cmdToggle(args, flags); break;
  case "stats":    cmdStats(flags); break;
  case "ui":       cmdUi(flags); break;
  case "init":     cmdInit(flags); break;
  case "set-credential": await cmdSetCredential(args); break;
  case "audit":    await cmdAudit(flags); break;
  case "add-model": cmdAddModel(flags); break;
  case "failures": cmdFailures(args, flags); break;
  case "doctor":   cmdDoctor(flags); break;
  case "help":
  case "--help":
  case undefined:
    console.error(`external-agents CLI — subcommands:
  pick [--tier T | --tier-prefer T] [--n N] [--min-distinct-providers M] [--exclude id,id] [--exclude-providers p,p] [--tags a,b] [--transport generate_new|edit_exists|read_only] [--effort <level>]
       [--prompt-bytes N | --prompt-tokens N]
       (--prompt-bytes/--prompt-tokens = seat only agents whose declared token_limits can hold a
        prompt that size; entries declaring no limits are never refused. Bytes are counted at 4:1.)
       (--exclude/--exclude-providers cascade to API-key clones: excluding one id drops every
        entry serving the same model; providers match by family, so \`google\` covers google3..8)
       (--tier = strict single tier; --tier-prefer = prefer that tier, backfill the other to fill N slots, provider-diverse)
  dispatch <agent-id> [--pro] [--json] [--transport generate_new|edit_exists|read_only] [--effort <level>] [--cwd <dir>] [--require-base <ref>] [--file path[:lines]] "<prompt>"
       (exit 4 = refused before anything was spawned: unknown/disabled agent, no escalation candidate,
        --require-base mismatch, or a transport the entry does not declare)
       (--json = one structured {text,outcome,tokens,…} object on stdout; default = text on stdout + trailer on stderr)
       (--effort = reasoning depth. Use \`high\` for planning, design and review;
        omit it for mechanical edits and lookups — the provider's own default applies.)
       (--cwd = existing dir; with an available edit_exists transport it is preferred and edits in place; generate_new ignores it)
       (--file = essential context for generate_new; optional for edit_exists because direct CLIs can read --cwd; repeatable; path:10-50 for line range; paths relative to --cwd)
       (ALWAYS pass --cwd with --file: it is the containment root. Without it paths resolve against
        the current process cwd, so a file outside that tree fails the dispatch instead of attaching.)
       (--require-base = refuse to dispatch unless the --cwd checkout contains <ref>, e.g. origin/main.
        Guards against sending a worker at a stale worktree, whose accurate report about old code
        then reads as a hallucination. Never fetches; compares against refs already on disk.
        Exits 6 when the checkout is wrong, 2 on usage errors. Being AHEAD of <ref> is fine.)
  status [--json]
  probe <agent-id>
  verify-read-only <agent-id>  # runs the entry's declared read_only cmd against a canary file; exits 1 unless it's provably non-writing
  toggle <agent-id> --enabled|--disabled  # flip the same kill switch as the UI's POST /api/toggle
  stats [--since ISO] [--json]
  ui [--port N] [--host H] [--no-open]   # local dashboard (auto-opens in browser; use --no-open for SSH/tmux)
  init                                    # alias for 'ui' — kept for backward compat
  set-credential <ENV_NAME> [<value> | -]  # persist a key to ~/.local/state/external-agents/keys.env (0600); '-' or omitted = read from stdin
  doctor [--since 24h|7d] [--json]
       (checks the five goals in README against the dispatch log: oversized dispatches, seats
        with no measured ceiling, agents that never answer, success rate, tier balance, and
        provider allowance left unspent. Exit 1 on a high-severity finding, 0 otherwise —
        so it is safe to run from cron and only shouts when it matters.)
  audit [--provider P] [--include-disabled] [--json]
                                   # force API round-trip for every ENABLED registry entry (or just PROVIDER); writes state.json outcomes (healthy / needs_auth / model_unavailable / rate_limited)
                                   # disabled entries are skipped — they cannot be dispatched, and for prepaid providers auditing them spends real money; --include-disabled overrides
  add-model --id ID --provider P --url URL --model M --env ENV_VAR [--tier weak|strong] [--tags a,b]
                                   # add a locally-authored agent to ~/.local/state/external-agents/agents.local.yaml (merged over the bundled registry)
  failures [status|on|off|tail [N]|path|clear] [--with-prompts]
                                   # sidecar failure log: OFF unless you turn it on. Records EVERY failed attempt
                                   # (dispatch, audit, credential verify, read-only probe, pre-dispatch refusal)
                                   # with the full raw stdout/stderr/HTTP body, the argv, and the classification —
                                   # not the 400-char preview 'stats' keeps. Secrets redacted; prompts elided
                                   # unless --with-prompts. The flag lives in ~/.local/state/external-agents/config.json,
                                   # so upgrading the package does not switch it back off.
                                   # 'tail N' prints raw JSONL — paste it straight into a model and ask what to fix.`);
    process.exit(subcmd ? 0 : 2);
  default: die(`unknown subcommand: ${subcmd}`, 2);
}
