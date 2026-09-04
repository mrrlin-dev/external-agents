import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

// `audit` is the one path that spends a REAL provider round-trip per entry, and
// it used to include switched-off entries. Two costs, one of them literal: for
// a prepaid provider (DeepSeek ships off precisely because its API is prepaid)
// it spends money proving an agent nobody can dispatch is reachable, and it
// then writes `healthy` next to an entry that is switched off — which is the
// reading that makes a pool look larger than it is.
//
// Both DeepSeek entries are bundled `enabled: false`, so narrowing the audit to
// that provider proves the skip without any network access at all: it must exit
// before probing anything.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "cli.js");

function runAudit(args, homeDir) {
  return spawnSync(process.execPath, [cliPath, "audit", ...args], {
    encoding: "utf-8",
    cwd: repoRoot,
    env: { ...process.env, HOME: homeDir },
    timeout: 30000,
  });
}

test("audit skips disabled entries and says so instead of probing them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-disabled-"));
  try {
    const res = runAudit(["--provider", "deepseek"], dir);
    // Exit 3 = "nothing matched", reached without a single round-trip.
    assert.equal(res.status, 3);
    assert.match(res.stderr, /no enabled entries match provider=deepseek/);
    assert.match(res.stderr, /2 disabled entries skipped/);
    // The escape hatch has to be discoverable at the moment you need it.
    assert.match(res.stderr, /--include-disabled/);
    assert.doesNotMatch(res.stderr, /probing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--include-disabled opts back in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-include-disabled-"));
  try {
    // No key in this HOME, so the probes fail fast; all that is asserted here
    // is that the entries were selected for probing at all, which is the flag's
    // entire job.
    const res = runAudit(["--provider", "deepseek", "--include-disabled", "--json"], dir);
    assert.notEqual(res.status, 3);
    assert.match(res.stderr, /probing 2 agent\(s\) from deepseek/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("status marks switched-off entries so a green state cannot be misread as available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-status-disabled-"));
  try {
    const res = spawnSync(process.execPath, [cliPath, "status", "--json"], {
      encoding: "utf-8",
      cwd: repoRoot,
      env: { ...process.env, HOME: dir },
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    const rows = JSON.parse(res.stdout);
    const off = rows.find((r) => r.id === "gemini-3.1-pro-preview");
    assert.ok(off, "gemini-3.1-pro-preview missing from status");
    assert.equal(off.enabled, false);
    // Every row carries the flag — a consumer must never have to infer it.
    for (const r of rows) assert.equal(typeof r.enabled, "boolean", `${r.id} lacks enabled`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `doctor` builds its audit remedy out of a provider FAMILY — see doctor.js,
// `audit --provider ${providerFamilyOf(...)}` — while the numbered API-key
// clones carry a numbered provider id (`groq2`, `google3..8`). Matching the raw
// string made the tool's own prescribed remedy quietly miss them: a real run of
// `audit --provider groq` probed 3 of 6 enabled groq seats, printed
// "healthy:3", and left a clone holding a measured ceiling seven times too low
// for the rest of its 30-day TTL. Family matching is what `--exclude-providers`
// already documents ("`google` covers google3..8"); audit was the odd one out.
//
// The bundled registry ships no numbered clones — they arrive as extra API keys
// in the local overlay — so the overlay is what these tests seed.
function seedClone(homeDir, { id, provider }) {
  const dir = path.join(homeDir, ".local", "state", "external-agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agents.local.yaml"),
    [
      "schema_version: 1",
      "agents:",
      `  - id: ${id}`,
      `    provider: ${provider}`,
      "    model: openai/gpt-oss-120b",
      "    tier: strong",
      '    auth: "env:GROQ_API_KEY_2"',
      "    transports:",
      "      generate_new:",
      '        url: "https://api.groq.com/openai/v1/chat/completions"',
      "        env: GROQ_API_KEY_2",
      "        model: openai/gpt-oss-120b",
      "",
    ].join("\n"),
  );
}

const probedCount = (stderr) => Number((/probing (\d+) agent\(s\)/.exec(stderr) || [])[1]);

test("audit --provider matches the provider FAMILY, so it reaches numbered key clones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-family-"));
  try {
    // No key in this HOME, so every probe fails fast; all that is asserted is
    // which entries were SELECTED, which is the whole of this flag's job.
    const before = probedCount(runAudit(["--provider", "groq", "--json"], dir).stderr);
    seedClone(dir, { id: "groq-gpt-oss-120b-2", provider: "groq2" });
    const after = probedCount(runAudit(["--provider", "groq", "--json"], dir).stderr);
    assert.equal(after, before + 1, "the groq2 clone must be probed by `--provider groq`");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Consensus round 1 pushed back on making this symmetric, and was right: audit
// spends a real API round-trip per entry, so widening `--provider groq2` to the
// whole family charges the operator for seats they did not name. The remedy
// problem is one-directional — a family name must reach its clones — so only
// that direction expands. A numbered id is a precise request; honour it.
test("audit --provider on a numbered id stays exact, and does not widen to the family", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-family-numbered-"));
  try {
    seedClone(dir, { id: "groq-gpt-oss-120b-2", provider: "groq2" });
    const family = probedCount(runAudit(["--provider", "groq", "--json"], dir).stderr);
    const numbered = probedCount(runAudit(["--provider", "groq2", "--json"], dir).stderr);
    assert.equal(numbered, 1, "only the groq2 clone was named");
    assert.ok(family > numbered, "the family name covers strictly more");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// providerFamily strips a trailing digit run, so a numeric-only argument reduces
// to the empty string. Guarding on the truthiness of that result silently
// dropped the filter and sent audit at the ENTIRE registry — a real round-trip
// per enabled agent, on prepaid keys included. A filter that was asked for must
// never widen the run; if it matches nothing, that is exit 3, not everything.
test("audit --provider never widens to the whole registry on a degenerate argument", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-audit-degenerate-"));
  try {
    for (const arg of ["123", "nosuchprovider"]) {
      const res = runAudit(["--provider", arg, "--json"], dir);
      assert.equal(res.status, 3, `--provider ${arg} must match nothing, not everything`);
      assert.doesNotMatch(res.stderr, /probing/, `--provider ${arg} must not probe`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
