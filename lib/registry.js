import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
