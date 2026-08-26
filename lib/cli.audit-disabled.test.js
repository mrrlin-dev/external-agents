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
