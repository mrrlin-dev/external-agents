import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";

// Where user-scoped overlays live. Each file is optional and merged over the
// bundled registry at load time by id: an entry with the same id in a later
// layer REPLACES the earlier one; new ids are appended.
//
//   OVERRIDE_PATH — populated by `external-agents refresh` (remote pull from GitHub main)
//   LOCAL_PATH    — populated by `external-agents add-model` (operator-authored)
const STATE_DIR = path.join(os.homedir(), ".local/state/external-agents");
export const OVERRIDE_PATH = path.join(STATE_DIR, "agents.yaml.override");
export const LOCAL_PATH = path.join(STATE_DIR, "agents.local.yaml");

function validate(parsed) {
  if (!parsed || typeof parsed !== "object" || !parsed.schema_version) {
    throw new Error("loadRegistry: missing top-level 'schema_version' in YAML");
  }
  if (!Array.isArray(parsed.agents)) {
    throw new Error("loadRegistry: missing or invalid 'agents' array in YAML");
  }
  for (const agent of parsed.agents) {
    if (!agent.id) {
      throw new Error("loadRegistry: agent entry missing 'id'");
    }
    if (!agent.provider) {
      throw new Error(`loadRegistry: agent "${agent.id ?? "<unknown>"}" missing 'provider'`);
    }
    if (!agent.transports || typeof agent.transports !== "object") {
      throw new Error(`loadRegistry: agent "${agent.id}" missing or invalid 'transports'`);
    }
    validateReadOnly(agent);
    validateEnvFrom(agent);
  }
}

// `env_from: { TARGET_VAR: SOURCE_VAR }` on a CLI transport. Both sides must be
// plain env-var names: a typo here silently means "no credential", which the
// CLI then reports as its own auth failure a long way from the cause.
function validateEnvFrom(agent) {
  for (const [name, transport] of Object.entries(agent.transports)) {
    const envFrom = transport && typeof transport === "object" ? transport.env_from : null;
    if (envFrom == null) continue;
    if (typeof envFrom !== "object" || Array.isArray(envFrom)) {
      throw new Error(`loadRegistry: agent "${agent.id}" ${name}.env_from must be a map of TARGET: SOURCE`);
    }
    for (const [target, source] of Object.entries(envFrom)) {
      if (typeof source !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(target) || !/^[A-Z][A-Z0-9_]*$/.test(source)) {
        throw new Error(
          `loadRegistry: agent "${agent.id}" ${name}.env_from["${target}"] — both names must be env-var identifiers, got ${JSON.stringify(source)}`,
        );
      }
    }
  }
}

// A `read_only` block must say HOW it is non-writing, in exactly one of two
// ways: its own `cmd` (a distinct no-write CLI invocation, which
// `verify-read-only` proves against a canary), or `via: generate_new` (an HTTP
// completion call, which has no filesystem access to begin with). Anything
// else — no key, both keys, or `via` pointing at a write-capable transport —
// is a registry authoring error and fails at load rather than silently
// resolving to something that can write at dispatch time.
function validateReadOnly(agent) {
  const ro = agent.transports.read_only;
  if (ro == null) return;
  if (typeof ro === "string") return; // legacy bare-string cmd form
  if (typeof ro !== "object") {
    throw new Error(`loadRegistry: agent "${agent.id}" has an invalid 'read_only' transport`);
  }
  const hasCmd = typeof ro.cmd === "string" && ro.cmd.trim() !== "";
  const hasVia = typeof ro.via === "string" && ro.via.trim() !== "";
  if (hasCmd === hasVia) {
    throw new Error(
      `loadRegistry: agent "${agent.id}" read_only must declare exactly one of 'cmd' or 'via' (got ${hasCmd ? "both" : "neither"})`,
    );
  }
  if (hasVia) {
    if (ro.via !== "generate_new") {
      throw new Error(
        `loadRegistry: agent "${agent.id}" read_only via '${ro.via}' — only 'generate_new' is non-writing by construction`,
      );
    }
    if (!agent.transports.generate_new) {
      throw new Error(
        `loadRegistry: agent "${agent.id}" read_only via 'generate_new' but no generate_new transport is declared`,
      );
    }
  }
}

function readYaml(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(p, "utf-8"));
    validate(parsed);
    return parsed;
  } catch (e) {
    console.error(`loadRegistry: skipping ${p}: ${e.message}`);
    return null;
  }
}

// Merge later layer over earlier: same-id → replaces, new-id → appends.
function mergeLayer(base, overlay) {
  if (!overlay || !Array.isArray(overlay.agents)) return base;
  const byId = new Map(base.agents.map((a) => [a.id, a]));
  for (const a of overlay.agents) byId.set(a.id, a);
  return { ...base, agents: [...byId.values()] };
}

// Public: load bundled registry from `yamlPath` and merge user overlays on top.
// The caller passes the bundled path; overlays are read from fixed home paths.
export function loadRegistry(yamlPath) {
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const bundled = yaml.load(raw);
  validate(bundled);
  let registry = bundled;
  registry = mergeLayer(registry, readYaml(OVERRIDE_PATH));
  registry = mergeLayer(registry, readYaml(LOCAL_PATH));
  return registry;
}

// A provider slug ending in one or more digits is NEVER a canonical base, full
// stop — regardless of whether its un-suffixed prefix currently exists in the
// registry. (An earlier "non-canonical only if some other slug is my prefix"
// rule had a chaining hole: if the prefix were ever removed, the suffixed
// slug would become promotable to a new base.) Returns the Set of env:*-auth
// provider slugs in `registry.agents` eligible as an add-provider-key base.
export function CANONICAL_BASES(registry) {
  const bases = new Set();
  for (const agent of registry.agents) {
    if (
      typeof agent.auth === "string" &&
      agent.auth.startsWith("env:") &&
      !/\d+$/.test(agent.provider)
    ) {
      bases.add(agent.provider);
    }
  }
  return bases;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Given a canonical `baseProvider`, returns 1 + the max existing numeric
// suffix among `registry.agents` whose provider matches
// `^${baseProvider}(\d+)?$` (the base itself counts as 0). Keyed off distinct
// provider slugs, never entry/model count — e.g. `google` with 2 models plus
// `google2` with 2 models still yields 3, not 5.
export function nextProviderSlot(registry, baseProvider) {
  const familyRegex = new RegExp(`^${escapeRegex(baseProvider)}(\\d+)?$`);
  let maxSuffix = 0;
  for (const agent of registry.agents) {
    const m = agent.provider.match(familyRegex);
    if (m) {
      const suffix = m[1] ? parseInt(m[1], 10) : 0;
      if (suffix > maxSuffix) maxSuffix = suffix;
    }
  }
  return maxSuffix + 1;
}

// Serializes read-modify-write access to LOCAL_PATH across BOTH in-process
// callers (the UI server's /api/add_model and /api/add_provider_key routes)
// and separate OS processes (the `external-agents add-model` CLI) via an
// advisory lockfile sibling to LOCAL_PATH. Rejects with an error whose
// message starts with "registry busy" if the lock isn't free within 5s.
// `mutatorFn(overlay)` receives a FRESH read of the overlay (never a stale
// in-process copy) and returns the overlay to write; the write itself is
// temp-file-then-atomic-rename, never an in-place truncate.
export async function withLocalOverlayLock(mutatorFn) {
  const LOCK_PATH = `${LOCAL_PATH}.lock`;
  const TIMEOUT_MS = 5000;
  const RETRY_MS = 50;
  const start = Date.now();
  let fd;

  while (true) {
    try {
      fd = fs.openSync(LOCK_PATH, "wx");
      break;
    } catch (e) {
      if (e.code === "EEXIST") {
        if (Date.now() - start > TIMEOUT_MS) throw new Error("registry busy: lock timeout");
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        continue;
      }
      throw e;
    }
  }

  try {
    let overlay = { schema_version: 1, agents: [] };
    if (fs.existsSync(LOCAL_PATH)) {
      try {
        const parsed = yaml.load(fs.readFileSync(LOCAL_PATH, "utf-8"));
        if (parsed && Array.isArray(parsed.agents)) overlay = parsed;
      } catch (_) {
        // Treat unreadable as empty for this generic lock helper. Callers
        // with a stricter contract (e.g. the CLI's cmdAddModel, which must
        // die() loudly on a corrupt overlay rather than silently discard it)
        // perform their own readability check BEFORE calling this helper.
      }
    }

    const newOverlay = await mutatorFn(overlay);

    fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true, mode: 0o700 });
    const tmpPath = `${LOCAL_PATH}.tmp.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmpPath, yaml.dump(newOverlay), { mode: 0o644 });
    fs.renameSync(tmpPath, LOCAL_PATH);
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  }
}
