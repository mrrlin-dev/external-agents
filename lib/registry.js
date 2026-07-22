import fs from "node:fs";
import yaml from "js-yaml";

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

export function loadRegistry(yamlPath) {
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const parsed = yaml.load(raw);
  validate(parsed);
  return parsed;
}
