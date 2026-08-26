#!/usr/bin/env node
import http from "node:http";
import url from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, LOCAL_PATH, CANONICAL_BASES, nextProviderSlot, withLocalOverlayLock } from "./lib/registry.js";
import { readState, writeState, probeInstalled, deriveDisplayState, enableAgentsAwaitingCredential, mergeAuditState, auditCooldown } from "./lib/state.js";
import { verifyCredential, getStats, auditCliEntry, classifyVerifyResult, shouldPersistOutcome } from "./lib/dispatch.js";
import { bootEnv, refreshEnv } from "./lib/credentials.js";
// Load keys.env + legacy provider stores (Kilo auth, llm-keys) into process.env
// before any probe/dispatch runs. Without this, /api/audit sees a blank env
// and reports all API-key entries as needs_auth.
bootEnv();
import yaml from "js-yaml";

// UI-set persisted keys — MUST use the same file that server.js reads at
// startup, otherwise the operator's saved key is invisible on next boot.
const KEYS_FILE = path.join(os.homedir(), ".local/state/external-agents/keys.env");
function loadKeysFile() {
  try {
    if (!fs.existsSync(KEYS_FILE)) return {};
    const out = {};
    for (const line of fs.readFileSync(KEYS_FILE, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1);
    }
    return out;
  } catch { return {}; }
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

const __ui_dir = path.dirname(new URL(import.meta.url).pathname);
const BUNDLED_YAML = path.join(__ui_dir, "agents.yaml");
// REGISTRY is a hot-reloading ref — refresh() reads bundled + overlays fresh so
// UI-side add-model appears without a UI restart. Called by every request that
// touches the registry surface.
let REGISTRY = loadRegistry(BUNDLED_YAML);
function reloadRegistry() { REGISTRY = loadRegistry(BUNDLED_YAML); return REGISTRY; }
// Guards /api/add_provider_key against a double-click firing two concurrent
// clones for the same base provider (withLocalOverlayLock alone would just
// serialize them into two DIFFERENT slots, e.g. google2 AND google3 for one
// paste). Keyed by base_provider, not by env var.
const addProviderInFlight = new Set();
const HOST = process.env.EXTERNAL_AGENTS_UI_HOST || "127.0.0.1";
const PORT = Number(process.env.EXTERNAL_AGENTS_UI_PORT) || 4711;

function stateRows() {
  const state = readState();
  return REGISTRY.agents.map((entry) => {
    if (state[entry.id]) return deriveDisplayState({ ...entry, ...state[entry.id] });
    // No persisted state — this entry has never been probed OR dispatched.
    // Falling back to a static "healthy" (the old behavior) was a false
    // positive: a fresh install with zero credentials rendered everything
    // green. Falling back to a static "unverified" fixed that lie but
    // introduced a worse regression — the unlock banner only surfaces
    // entries in `needs_auth`, so an apikey entry that's missing its env
    // var became invisible to the ONE UI element that lets you paste a key.
    // The right default is the cheap, synchronous, network-free
    // probeInstalled() check (same one /api/probe and `external-agents
    // probe` already use) — it correctly reports needs_auth when the env
    // var is absent (banner picks it up, key input appears), healthy when
    // present (optimistic-but-reasonable, matches pick_agents' own
    // eligibility rule), and not_installed when a CLI binary is missing.
    return deriveDisplayState({ ...entry, ...probeInstalled(entry) });
  });
}
function findAgent(id) {
  return REGISTRY.agents.find((a) => a.id === id);
}

// Compute the tile-strip stats. `saved` is a deliberately-conservative estimate:
// we anchor "what would this have cost on a strong closed model" at Claude
// Sonnet 4.5 input+output blended ~$3/M tokens. Every dispatch that hit a free
// provider is counted as tokens_total × $3/M saved. Not marketing spin —
// honestly labeled as "at Claude Sonnet pricing" in the UI.
const SAVED_ANCHOR_PER_M = 3.0;
const AUDIT_STALE_DAYS = 7;
// Range picker for the Dispatches / Est. saved tiles — "all" means no lower
// bound (getStats treats a falsy sinceIso as "since the epoch").
const RANGE_MS = {
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "1mo": 30 * 24 * 3600 * 1000,
  "all": null,
};
function computeStats(range = "24h") {
  const rangeKey = Object.prototype.hasOwnProperty.call(RANGE_MS, range) ? range : "24h";
  const ms = RANGE_MS[rangeKey];
  const sinceIso = ms === null ? undefined : new Date(Date.now() - ms).toISOString();

  const rows = stateRows();
  // The healthy tile is read as "how much of the pool can actually take work",
  // so a switched-off entry must not count toward it however green its probe
  // came back. Several registry entries ship off by default (paid models,
  // DeepSeek's prepaid key) and their env var is often present anyway, so they
  // probe healthy and inflated this number by exactly the entries that can
  // never be dispatched. `enabled` here is already the effective value —
  // stateRows() spreads the state record over the registry entry, so an
  // operator toggle overrides the registry default, same rule as
  // isAgentEnabled.
  const dispatchable = rows.filter((r) => r.enabled !== false);
  const healthy = dispatchable.filter((r) => r.state === "healthy").length;
  const disabled = rows.length - dispatchable.length;
  // Counted over dispatchable rows for the same reason as `healthy`, and for a
  // sharper one: this tile's footnote is "paste a key below to unlock", and the
  // banner it points at (renderCliSetup) already filters out disabled entries.
  // Counting them here made the tile promise an unlock action the page below it
  // would not offer.
  const locked  = dispatchable.filter((r) => r.state === "needs_auth").length;
  // Audit freshness — oldest `checked` timestamp = when we last confirmed
  // each entry is real. 0 (never audited) or > 7 days = nag the operator.
  const stamps = rows.map((r) => r.checked || 0).filter((t) => t > 0);
  const oldestChecked = stamps.length ? Math.min(...stamps) : 0;
  const auditAgeDays  = oldestChecked
    ? Math.floor((Date.now() / 1000 - oldestChecked) / 86400)
    : null;
  const auditStale = auditAgeDays === null || auditAgeDays >= AUDIT_STALE_DAYS;
  const s = getStats(sinceIso);
  const dispatches = s.total || 0;
  const tokensAll = Object.values(s.by_agent || {})
    .reduce((sum, a) => sum + (a.tokens_in || 0) + (a.tokens_out || 0), 0);
  // We only count "saved" for dispatches that would otherwise cost real money —
  // ie. those that ran on free-tagged agents. Anything else was going to cost
  // something already.
  const freeIds = new Set(rows.filter((r) => (r.tags || []).includes("free")).map((r) => r.id));
  const tokensFree = Object.entries(s.by_agent || {})
    .filter(([id]) => freeIds.has(id))
    .reduce((sum, [, a]) => sum + (a.tokens_in || 0) + (a.tokens_out || 0), 0);
  const savedUsd = (tokensFree / 1_000_000) * SAVED_ANCHOR_PER_M;
  return {
    healthy_count:  healthy,
    locked_count:   locked,
    disabled_count: disabled,
    total_count:    rows.length,
    dispatches:     dispatches,
    tokens:         tokensAll,
    tokens_free:    tokensFree,
    saved_usd:      savedUsd,
    saved_anchor:   SAVED_ANCHOR_PER_M,
    range:          rangeKey,
    // Per-agent aggregates so the UI can surface last_error inline per row.
    by_agent: s.by_agent || {},
    // Audit freshness — UI shows a small nag when this is true.
    audit: {
      stale: auditStale,
      age_days: auditAgeDays,
      threshold_days: AUDIT_STALE_DAYS,
    },
  };
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>external-agents</title>
<style>
  /* ---------- Tokens ---------- */
  :root {
    --bg:       #f6f8fa;
    --panel:    #fafbfc;
    --panel-2:  #f6f8fa;
    --border:   #d0d7de;
    --border-2: #e6ebf1;
    --text:     #1f2328;
    --text-2:   #59636e;
    --text-3:   #818b98;
    --accent:   #1a7f37;
    --accent-2: #dafbe1;
    --warn:     #9a6700;
    --warn-2:   #fff8c5;
    --err:      #cf222e;
    --err-2:    #ffebe9;
    --info-2:   #ddf4ff;
    --info:     #0969da;
    --mono:     ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans:     -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:       #0d1117;
      --panel:    #161b22;
      --panel-2:  #1c232b;
      --border:   #2c3441;
      --border-2: #21262d;
      --text:     #e6edf3;
      --text-2:   #8b949e;
      --text-3:   #586069;
      --accent:   #39d353;
      --accent-2: #1f6427;
      --warn:     #f0b429;
      --warn-2:   #4a3812;
      --err:      #f85149;
      --err-2:    #4a1418;
      --info-2:   #264066;
      --info:     #58a6ff;
    }
  }
  :root[data-theme="light"] {
    --bg:#f6f8fa;--panel:#fafbfc;--panel-2:#f6f8fa;--border:#d0d7de;--border-2:#e6ebf1;
    --text:#1f2328;--text-2:#59636e;--text-3:#818b98;
    --accent:#1a7f37;--accent-2:#dafbe1;--warn:#9a6700;--warn-2:#fff8c5;
    --err:#cf222e;--err-2:#ffebe9;--info-2:#ddf4ff;--info:#0969da;
  }
  :root[data-theme="dark"] {
    --bg:#0d1117;--panel:#161b22;--panel-2:#1c232b;--border:#2c3441;--border-2:#21262d;
    --text:#e6edf3;--text-2:#8b949e;--text-3:#586069;
    --accent:#39d353;--accent-2:#1f6427;--warn:#f0b429;--warn-2:#4a3812;
    --err:#f85149;--err-2:#4a1418;--info-2:#264066;--info:#58a6ff;
  }

  /* ---------- Base ---------- */
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums;
  }
  a { color: var(--info); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, .mono { font-family: var(--mono); font-size: 12.5px; }

  /* ---------- Container ---------- */
  .container {
    max-width: 1140px;
    margin: 0 auto;
    padding: 40px 32px 80px;
  }

  /* ---------- Header ---------- */
  .header {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 4px; flex-wrap: wrap; gap: 8px;
  }
  .header h1 {
    font-family: var(--sans);
    font-size: 24px; font-weight: 700; letter-spacing: -0.4px;
    margin: 0; text-wrap: balance;
  }
  .header h1 .dot { color: var(--accent); }
  .header-right { display: flex; align-items: center; gap: 10px; }
  .header .listening {
    font-family: var(--mono); font-size: 11.5px;
    color: var(--text-2); background: var(--panel);
    padding: 3px 8px; border: 1px solid var(--border-2); border-radius: 4px;
  }
  .header .listening::before { content: "● "; color: var(--accent); }
  .theme-btn {
    height: 26px; padding: 0 10px;
    font-family: var(--sans); font-size: 11.5px; font-weight: 500;
    color: var(--text-2); background: var(--panel);
    border: 1px solid var(--border-2); border-radius: 4px;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .theme-btn:hover { background: var(--panel-2); color: var(--text); }
  .theme-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .subtitle {
    color: var(--text-2); font-size: 13.5px;
    margin: 0 0 24px 0; max-width: 620px;
  }

  /* ---------- Stats strip ---------- */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 24px;
  }
  @media (max-width: 780px) { .stats { grid-template-columns: repeat(2, 1fr); } }
  .stat {
    background: var(--panel);
    border: 1px solid var(--border-2);
    border-radius: 8px;
    padding: 16px 18px;
    position: relative;
    overflow: hidden;
  }
  .stat .label {
    text-transform: uppercase; letter-spacing: 0.6px;
    font-size: 10.5px; font-weight: 600;
    color: var(--text-3);
    margin: 0 0 8px 0;
  }
  .stat .value {
    font-family: var(--sans);
    font-size: 26px; font-weight: 600; line-height: 1;
    color: var(--text);
    letter-spacing: -0.5px;
    margin: 0 0 6px 0;
    font-variant-numeric: tabular-nums;
  }
  .stat .foot {
    font-size: 11.5px; color: var(--text-2);
  }
  .stat.hero {
    background: linear-gradient(135deg, var(--panel) 0%, var(--panel-2) 100%);
    border-color: var(--accent-2);
  }
  .stat.hero .value { color: var(--accent); }
  .stat.hero::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .stat.warn .value { color: var(--warn); }
  .stat.warn::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    box-shadow: inset 3px 0 0 var(--warn);
  }

  /* ---------- Audit-freshness nag ---------- */
  .audit-nag {
    background: var(--panel);
    border: 1px solid var(--info-2);
    border-left: 3px solid var(--info);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
    font-size: 13px; color: var(--text);
  }
  .audit-nag .msg { color: var(--text-2); }
  .audit-nag code { color: var(--text); background: var(--panel-2); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

  /* ---------- Unlock banner ---------- */
  .unlock {
    background: var(--panel);
    border: 1px solid var(--warn-2);
    border-left: 3px solid var(--warn);
    border-radius: 8px;
    padding: 20px 22px;
    margin-bottom: 24px;
  }
  .unlock h2 {
    margin: 0 0 4px 0; font-size: 15px; font-weight: 600;
    color: var(--text); letter-spacing: -0.1px;
  }
  .unlock .tag {
    margin: 0 0 16px 0; color: var(--text-2); font-size: 13px;
    max-width: 720px;
  }
  .unlock-row {
    display: grid;
    grid-template-columns: minmax(150px, 190px) 1fr minmax(280px, 340px) auto;
    gap: 12px 20px;
    align-items: start;
    padding: 14px 0;
    border-top: 1px solid var(--border-2);
  }
  .unlock-row:first-of-type { border-top: none; padding-top: 6px; }
  .unlock-row .prov { font-weight: 600; color: var(--text); font-size: 13.5px; }
  .unlock-row .waiting {
    font-size: 11px; color: var(--text-3); margin-top: 2px;
    font-family: var(--mono);
  }
  .unlock-row .pitch { color: var(--text-2); font-size: 13px; }
  .unlock-row .keyrow { display: flex; gap: 8px; align-items: center; }

  /* CLI setup banner — accent-blue left border to distinguish from the
     green api-key unlock banner. Same grid as unlock-row. */
  .cli-setup { border-left: 3px solid var(--info); }
  .cli-setup-row {
    display: grid;
    grid-template-columns: minmax(150px, 190px) 1fr auto;
    gap: 12px 20px;
    align-items: start;
    padding: 14px 0;
    border-top: 1px solid var(--border-2);
  }
  .cli-setup-row:first-of-type { border-top: none; padding-top: 6px; }
  .cli-setup-row .prov { font-weight: 600; color: var(--text); font-size: 13.5px; }
  .cli-setup-row .waiting { font-size: 11px; color: var(--text-3); margin-top: 2px; font-family: var(--mono); }
  .cli-setup-row .pitch { color: var(--text-2); font-size: 13px; margin-bottom: 8px; }
  .cli-cmds { display: flex; flex-direction: column; gap: 6px; }
  .cli-cmd-row { display: flex; align-items: center; gap: 8px; }
  .cli-cmd-label { font-size: 11px; color: var(--text-3); min-width: 64px; }
  .cli-cmd {
    font-family: var(--mono); font-size: 12px;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 5px;
    padding: 4px 8px; cursor: pointer; user-select: none;
    white-space: nowrap; overflow-x: auto; max-width: 100%;
  }
  .cli-cmd:hover { border-color: var(--info); }
  .cli-cmd.copied { color: var(--accent); border-color: var(--accent); }
  .unlock-row .keyinput {
    flex: 1; height: 32px; box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 5px;
    font-family: var(--mono); font-size: 12px;
    background: var(--bg); color: var(--text);
    outline: none;
  }
  .unlock-row .keyinput:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-2); }
  .unlock-row .status {
    display: block; font-size: 11.5px; color: var(--text-2);
    margin-top: 6px; min-height: 14px; font-family: var(--mono);
  }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 32px; box-sizing: border-box;
    padding: 0 14px;
    font-family: var(--sans);
    font-size: 12.5px; font-weight: 500;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    transition: background 80ms;
  }
  .btn:hover { background: var(--panel); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .btn.primary {
    background: var(--accent); color: #052e0c; border-color: var(--accent);
    font-weight: 600;
  }
  .btn.primary:hover { filter: brightness(1.05); background: var(--accent); }
  :root[data-theme="light"] .btn.primary { color: #ffffff; }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) .btn.primary { color: #ffffff; } }
  .btn.signup { background: transparent; color: var(--accent); border-color: var(--accent); }
  .btn.signup:hover { background: var(--accent-2); }

  /* ---------- Table controls ---------- */
  .controls {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-bottom: 12px;
  }
  .controls .left { display: flex; gap: 12px; align-items: center; }
  .stamp { color: var(--text-3); font-size: 11.5px; font-family: var(--mono); }

  /* ---------- Stats range toggle ---------- */
  /* Inline range select — sits where the static "24h" text used to be inside
     each tile's label, styled to read as part of the label (uppercase,
     letter-spaced, small-caps sizing) rather than a form control. Both tiles
     get their own select (#stats-range-select on Dispatches, -2 on Est.
     saved) so either one is a visible, interactive control — they drive one
     shared range and stay in sync via renderStats(). */
  #stats-range-select, #stats-range-select-2 {
    appearance: none; -webkit-appearance: none;
    background: var(--panel-2); color: var(--text-2);
    border: 1px solid var(--border); border-radius: 4px;
    font: inherit; text-transform: uppercase; letter-spacing: 0.6px;
    font-size: 10.5px; font-weight: 600;
    padding: 2px 20px 2px 7px; margin-left: 2px; cursor: pointer;
    background-image: linear-gradient(45deg, transparent 50%, var(--text-3) 50%),
                       linear-gradient(135deg, var(--text-3) 50%, transparent 50%);
    background-position: right 9px center, right 5px center;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
    transition: background-color 120ms, color 120ms, border-color 120ms;
  }
  #stats-range-select:hover, #stats-range-select-2:hover { background-color: var(--panel); color: var(--text); border-color: var(--text-3); }
  #stats-range-select:focus-visible, #stats-range-select-2:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* ---------- Table ---------- */
  .table-wrap {
    background: var(--panel);
    border: 1px solid var(--border-2);
    border-radius: 8px;
    overflow-x: auto;
  }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    padding: 10px 14px; text-align: left;
    border-bottom: 1px solid var(--border-2);
    font-size: 12.5px; vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: none; }
  th {
    background: var(--panel-2);
    font-size: 10.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--text-3);
    position: sticky; top: 0; z-index: 1;
    white-space: nowrap;
  }
  th[data-sort] { cursor: pointer; user-select: none; }
  th[data-sort]:hover { color: var(--text); }
  th[data-sort]::after { content: ""; display: inline-block; width: 0.7em; }
  th.sort-asc::after  { content: " ▲"; }
  th.sort-desc::after { content: " ▼"; }
  th.num, td.num { text-align: right; }
  tbody tr { position: relative; }
  tbody tr:hover td { background: var(--panel-2); }
  td.id { font-family: var(--mono); color: var(--text); }
  td.id .sub { display: block; color: var(--text-3); font-size: 11px; margin-top: 1px; }
  td.model { font-family: var(--mono); color: var(--text-2); font-size: 12px; }
  td.num { font-family: var(--mono); font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  td.num.zero { color: var(--text-3); }
  td.tier { font-size: 11.5px; color: var(--text-2); }
  td.time { color: var(--text-3); font-family: var(--mono); font-size: 11.5px; }
  /* Note column: truncate to a single line with ellipsis so the pill + row
     stay compact. Full text lives in the title attribute — hover to see. */
  td.note {
    color: var(--text-2); font-size: 11.5px;
    max-width: 220px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: help;
  }
  /* State column should hug its pill — no fixed width, no wrapping. */
  td.state { white-space: nowrap; }

  /* State — pill + row-rail */
  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 12px;
    font-size: 11px; font-weight: 500;
    font-family: var(--mono);
  }
  .pill[title] { cursor: help; }
  .pill::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    display: inline-block;
  }
  .pill.healthy         { background: var(--accent-2); color: var(--accent); }
  .pill.healthy::before { background: var(--accent); }
  .pill.needs_auth,
  .pill.not_installed   { background: var(--err-2); color: var(--err); }
  .pill.needs_auth::before,
  .pill.not_installed::before { background: var(--err); }
  .pill.quota_exhausted,
  .pill.rate_limited    { background: var(--warn-2); color: var(--warn); }
  .pill.quota_exhausted::before,
  .pill.rate_limited::before { background: var(--warn); }
  .pill.errored_transient { background: var(--info-2); color: var(--info); }
  .pill.errored_transient::before { background: var(--info); }
  .pill.model_unavailable { background: var(--panel-2); color: var(--text-3); border: 1px solid var(--border); }
  .pill.model_unavailable::before { background: var(--text-3); }
  /* unverified — never probed. Deliberately NOT green: it must not read as
     a confirmed-working state. Dashed dot + neutral color signal "unknown",
     distinct from every other (confirmed) state. */
  .pill.unverified { background: var(--panel-2); color: var(--text-2); border: 1px dashed var(--border); }
  .pill.unverified::before { background: var(--text-3); border-radius: 1px; }
  .pill.need_check { background: var(--warn-2); color: var(--warn); border: 1px dashed color-mix(in srgb, var(--warn) 55%, transparent); }
  .pill.need_check::before { background: var(--warn); border-radius: 1px; }

  tr.healthy         td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
  tr.needs_auth      td:first-child,
  tr.not_installed   td:first-child { box-shadow: inset 2px 0 0 var(--err); }
  tr.quota_exhausted td:first-child,
  tr.rate_limited    td:first-child { box-shadow: inset 2px 0 0 var(--warn); }
  tr.need_check      td:first-child { box-shadow: inset 2px 0 0 var(--warn); }
  tr.errored_transient td:first-child { box-shadow: inset 2px 0 0 var(--info); }
  tr.model_unavailable td:first-child { box-shadow: inset 2px 0 0 var(--text-3); }
  tr.model_unavailable td:not(:first-child) { opacity: 0.55; }
  tr.unverified td:first-child { box-shadow: inset 2px 0 0 var(--border); }

  /* Tags — proper flex container so pills breathe instead of stacking */
  .tags {
    display: inline-flex; flex-wrap: wrap; gap: 4px 5px;
    align-items: center;
  }
  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 10px;
    background: var(--panel-2); border: 1px solid var(--border-2);
    color: var(--text-2); font-size: 10.5px; font-weight: 500;
    font-family: var(--mono); line-height: 1.4;
  }
  /* Muted free tag — subtle green background, no dollar-sign prefix, weight
     unchanged. Signals free-tier without shouting over the row. */
  .badge.free {
    background: var(--accent-2); border-color: transparent;
    color: var(--accent); opacity: 0.85;
  }
  /* One access-mode tag per row, derived from auth type. Mutually exclusive
     (cli for subscription CLIs, apikey for env-var API keys). Both colored — cli
     blue, apikey purple — so the auth surface is scannable at a glance. */
  .badge.cli    { background: rgba(88,166,255,.14); color: var(--info); border-color: transparent; }
  .badge.apikey { background: rgba(163,113,247,.16); color: #a371f7; border-color: transparent; }

  /* Collapsible banner headers (cli-setup / unlock / api-keys) — click the
     whole heading row to toggle; state persists in localStorage. */
  .collapsible-header {
    cursor: pointer; display: flex; align-items: center;
    justify-content: space-between; user-select: none;
  }
  .collapsible-header .chevron { font-size: 11px; color: var(--text-3); margin-left: 10px; }

  /* Removable numbered-key chips (e.g. "google2 ×") under a provider label in
     the API Keys panel — the base slug itself is never shown as a chip. */
  .extra-keys { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 1px 4px 1px 7px; border-radius: 10px;
    background: var(--panel-2); border: 1px solid var(--border-2);
    color: var(--text-2); font-size: 10.5px; font-family: var(--mono);
  }
  .chip-x {
    border: none; background: transparent; color: var(--text-3);
    cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px;
  }
  .chip-x:hover { color: var(--err); }

  /* Verify (row-level "run") button — clicks a live audit against ONE agent,
     shows loading + outcome inline before the row redraws. */
  .verify-btn { height: 26px; padding: 0 10px; font-size: 11px; min-width: 68px; margin-top: 4px; }
  .verify-btn:disabled { opacity: 0.7; cursor: wait; }

  /* ---------- Suggest form ---------- */
  .suggest {
    margin-top: 40px;
    background: var(--panel); border: 1px dashed var(--border);
    border-radius: 8px; padding: 20px 22px;
  }
  .suggest h3 { margin: 0 0 4px 0; font-size: 14px; font-weight: 600; }
  .suggest p { margin: 0 0 14px 0; color: var(--text-2); font-size: 13px; }
  .suggest .fields { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .suggest input {
    flex: 1; min-width: 240px; height: 34px; padding: 0 12px;
    border: 1px solid var(--border); border-radius: 5px;
    font: inherit; background: var(--bg); color: var(--text); outline: none;
  }
  .suggest input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-2); }
  #suggest-result, #am-result { margin-top: 10px; font-size: 12px; color: var(--text-2); min-height: 16px; }
  .suggest .grid-form {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    align-items: center;
  }
  .suggest .grid-form select {
    height: 34px; padding: 0 12px; border-radius: 5px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
    font: inherit; outline: none;
  }
  .suggest .grid-form select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-2); }
  @media (max-width: 640px) { .suggest .grid-form { grid-template-columns: 1fr; } }

  /* Toggle switch — operator kill switch per row */
  .switch {
    position: relative; display: inline-block; width: 34px; height: 18px;
    vertical-align: middle;
  }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .slider {
    position: absolute; cursor: pointer; inset: 0;
    background: var(--border); border-radius: 18px;
    transition: background 120ms;
  }
  .switch .slider::before {
    content: ""; position: absolute; height: 14px; width: 14px;
    left: 2px; top: 2px; border-radius: 50%;
    background: var(--panel); transition: transform 120ms;
    box-shadow: 0 1px 2px rgba(0,0,0,.2);
  }
  .switch input:checked + .slider { background: var(--accent); }
  .switch input:checked + .slider::before { transform: translateX(16px); }
  .switch input:focus-visible + .slider { box-shadow: 0 0 0 3px var(--accent-2); }
  tr.disabled td:not(:first-child) { opacity: 0.5; }

  /* Last-error tooltip — inline note shown under state pill for failed dispatches */
  .last-err {
    display: block; font-size: 10.5px; color: var(--err);
    margin-top: 4px; font-family: var(--mono);
    max-width: 240px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    cursor: help;
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
</style>
</head>
<body>
<div class="container">
  <header class="header">
    <h1>external-agents<span class="dot">.</span></h1>
    <div class="header-right">
      <button id="theme-toggle" class="theme-btn" onclick="cycleTheme()" title="Cycle theme (system / light / dark)"></button>
    </div>
  </header>
  <p class="subtitle">Local dashboard — inspect the pool, set API keys, watch dispatches settle. Zero data leaves this machine.</p>

  <section class="stats" id="stats">
    <div class="stat">
      <p class="label">Healthy models</p>
      <p class="value" id="s-healthy">—</p>
      <p class="foot" id="s-healthy-foot">of — total</p>
    </div>
    <div class="stat warn">
      <p class="label">Locked (needs auth)</p>
      <p class="value" id="s-locked">—</p>
      <p class="foot" id="s-locked-foot">paste a key to unlock</p>
    </div>
    <div class="stat">
      <p class="label">Dispatches · <select id="stats-range-select" title="applies to Dispatches + Est. saved">
        <option value="24h">24h</option>
        <option value="7d">7d</option>
        <option value="1mo">1mo</option>
        <option value="all">all</option>
      </select></p>
      <p class="value" id="s-disp">—</p>
      <p class="foot" id="s-disp-foot">— tokens routed</p>
    </div>
    <div class="stat hero">
      <p class="label">Est. saved · <select id="stats-range-select-2" title="applies to Dispatches + Est. saved">
        <option value="24h">24h</option>
        <option value="7d">7d</option>
        <option value="1mo">1mo</option>
        <option value="all">all</option>
      </select></p>
      <p class="value" id="s-saved">—</p>
      <p class="foot" id="s-saved-foot">at Claude Sonnet pricing ($3/1M tokens)</p>
    </div>
  </section>

  <div id="audit-nag" class="audit-nag" style="display:none"></div>
  <div id="unlock" class="unlock" style="display:none"></div>
  <div id="api-keys" class="unlock" style="display:none"></div>
  <div id="cli-setup" class="unlock cli-setup" style="display:none"></div>

  <div class="controls">
    <div class="left">
      <button class="btn primary" onclick="refresh()">Refresh</button>
      <span id="stamp" class="stamp"></span>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr id="thead-row">
        <th>On</th>
        <th data-sort="id">Model</th>
        <th data-sort="provider">Provider</th>
        <th data-sort="tier">Tier</th>
        <th data-sort="tags">Tags</th>
        <th data-sort="state">State</th>
        <th data-sort="calls" class="num" id="th-calls">Calls 24h</th>
        <th data-sort="tokens" class="num" id="th-tokens">Tokens 24h</th>
        <th data-sort="success" class="num">Success</th>
        <th data-sort="last_used_at">Last used</th>
        <th></th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <section class="suggest">
    <h3>Add your own model</h3>
    <p>Wire any OpenAI-compat endpoint into the pool — internal proxy, beta model, custom fine-tune. Stored locally in <code>~/.local/state/external-agents/agents.local.yaml</code>, layered on top of the bundled registry. No package release needed.</p>
    <div class="grid-form">
      <input id="am-id" placeholder="id (e.g. kimi-k2-instruct)">
      <input id="am-provider" placeholder="provider (e.g. groq)">
      <input id="am-model" placeholder="model (e.g. moonshotai/kimi-k2-instruct)">
      <input id="am-url" placeholder="url (e.g. https://api.groq.com/openai/v1/chat/completions)">
      <input id="am-env" placeholder="env var (e.g. GROQ_API_KEY)">
      <input id="am-tags" placeholder="tags, comma-separated (e.g. free,fast)">
      <select id="am-tier"><option value="weak">weak</option><option value="strong">strong</option></select>
      <button class="btn primary" onclick="submitAddModel()">Add model</button>
    </div>
    <p id="am-result"></p>
  </section>

  <section class="suggest" style="margin-top:16px;">
    <h3>Missing a provider we should bundle?</h3>
    <p>Opens a pre-filled issue on <a href="https://github.com/mrrlin-dev/external-agents/issues" target="_blank" rel="noopener">mrrlin-dev/external-agents</a> — for models you want everyone to get out of the box.</p>
    <div class="fields">
      <input id="suggest-name" placeholder="Model or provider (e.g. anthropic/haiku-4-5)">
      <input id="suggest-url"  placeholder="Docs / setup URL (optional)">
      <button class="btn" onclick="submitSuggest()">Suggest</button>
    </div>
    <p id="suggest-result"></p>
  </section>
</div>

<script>
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diff = (now - ts * 1000) / 1000;
  if (diff < 60)     return Math.floor(diff) + "s ago";
  if (diff < 3600)   return Math.floor(diff / 60) + "m ago";
  if (diff < 86400)  return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function fmtUsd(v) {
  if (!v || v < 0.001) return "$0.00";
  if (v < 1)   return "$" + v.toFixed(3);
  if (v < 100) return "$" + v.toFixed(2);
  return "$" + Math.round(v);
}

// Persist sort choice in localStorage so a refresh doesn't reset it.
let sortKey = localStorage.getItem("sort_key") || "state";
let sortDir = localStorage.getItem("sort_dir") || "asc";
const SORT_ORDER = {
  state: ["healthy", "unverified", "need_check", "quota_exhausted", "rate_limited", "needs_auth", "not_installed", "errored_transient", "model_unavailable"],
  tier:  ["strong", "weak"],
};
function sortAgents(agents, statsByAgent) {
  const dir = sortDir === "desc" ? -1 : 1;
  const key = sortKey;
  return [...agents].sort((a, b) => {
    let av, bv;
    if (key === "calls")   { av = (statsByAgent[a.id]?.count) || 0;      bv = (statsByAgent[b.id]?.count) || 0; }
    else if (key === "tokens") { av = ((statsByAgent[a.id]?.tokens_in) || 0) + ((statsByAgent[a.id]?.tokens_out) || 0);
                                 bv = ((statsByAgent[b.id]?.tokens_in) || 0) + ((statsByAgent[b.id]?.tokens_out) || 0); }
    else if (key === "success") {
      const sa = statsByAgent[a.id]; const sb = statsByAgent[b.id];
      // Success ratio 0..1; agents with 0 calls sort as -1 (below the busy ones)
      av = sa && sa.count > 0 ? (sa.outcomes?.success || 0) / sa.count : -1;
      bv = sb && sb.count > 0 ? (sb.outcomes?.success || 0) / sb.count : -1;
      // Tied ratio (very common — many agents sit at 100%) has no natural
      // direction, so break it the same way regardless of asc/desc: more
      // calls behind the ratio is a stronger signal, then id for determinism.
      if (av === bv) {
        const countDiff = (sb?.count || 0) - (sa?.count || 0);
        return countDiff !== 0 ? countDiff : a.id.localeCompare(b.id);
      }
    }
    else if (key === "last_used_at") { av = a.last_used_at || 0; bv = b.last_used_at || 0; }
    else if (key === "tags") { av = (a.tags || []).join(","); bv = (b.tags || []).join(","); }
    else if (SORT_ORDER[key]) {
      const av_ = SORT_ORDER[key].indexOf(a[key] || SORT_ORDER[key][0]);
      const bv_ = SORT_ORDER[key].indexOf(b[key] || SORT_ORDER[key][0]);
      av = av_ < 0 ? 999 : av_;
      bv = bv_ < 0 ? 999 : bv_;
    }
    else { av = a[key] || ""; bv = b[key] || ""; }
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}
function setSort(key) {
  if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
  else { sortKey = key; sortDir = (key === "calls" || key === "tokens" || key === "success" || key === "last_used_at") ? "desc" : "asc"; }
  localStorage.setItem("sort_key", sortKey);
  localStorage.setItem("sort_dir", sortDir);
  refresh();
}
function updateSortIndicators() {
  document.querySelectorAll("#thead-row th[data-sort]").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortKey) th.classList.add("sort-" + sortDir);
  });
}

function renderRows(agents, statsByAgent) {
  updateSortIndicators();
  const tbody = document.getElementById("rows");
  tbody.innerHTML = "";
  const sorted = sortAgents(agents, statsByAgent || {});
  for (const a of sorted) {
    const tr = document.createElement("tr");
    const enabled = a.enabled !== false;
    tr.className = (a.state || "healthy") + (enabled ? "" : " disabled");
    // One access-mode tag per row, derived from the auth field. Mutually
    // exclusive by construction — an entry either uses a subscription CLI
    // (auth "cli:...") or an API-key env var (auth "env:..."), never both.
    const derived = [];
    if (typeof a.auth === "string") {
      if (a.auth.startsWith("cli:")) derived.push("cli");
      else if (a.auth.startsWith("env:")) derived.push("apikey");
    }
    const allTags = [...derived, ...(a.tags || [])];
    const tags = '<span class="tags">' + allTags.map(t =>
      '<span class="badge ' + (["free","cli","apikey"].includes(t) ? t : "") + '">' + t + '</span>'
    ).join("") + '</span>';
    const s = (statsByAgent || {})[a.id] || {};
    const lastErr = s.last_error;
    const errCell = lastErr && lastErr.error_preview
      ? '<span class="last-err" title="' + esc(lastErr.error_preview) + '">' +
          (lastErr.http_status ? 'HTTP ' + lastErr.http_status + ' · ' : '') +
          esc(lastErr.error_preview) +
        '</span>'
      : '';
    const calls = s.count || 0;
    const tokens = (s.tokens_in || 0) + (s.tokens_out || 0);
    const okN = s.outcomes?.success || 0;
    const failN = calls - okN;
    // Color-code: all-ok → accent, mixed → warn, all-fail → err. Zero calls
    // stays dim. String format is "N ok · M fail" to keep both numbers visible.
    let successHtml = '<span class="zero">—</span>';
    if (calls > 0) {
      const ratio = okN / calls;
      const color = ratio === 1 ? "var(--accent)" : ratio === 0 ? "var(--err)" : "var(--warn)";
      successHtml =
        '<span style="color:' + color + ';font-weight:600;">' + okN + '</span>' +
        (failN > 0 ? '<span style="color:var(--text-3);"> / ' + failN + ' fail</span>' : '');
    }
    const toggleId = 'tg-' + a.id.replace(/[^a-z0-9]/gi, '_');
    tr.innerHTML =
      '<td><label class="switch">' +
        '<input type="checkbox" id="' + toggleId + '" ' + (enabled ? "checked" : "") +
        ' onchange="toggleAgent(\\'' + a.id + '\\', this.checked)"><span class="slider"></span>' +
      '</label></td>' +
      '<td class="id">' + esc(a.id) +
        // Show model sub-line whenever it adds information. Skip only when
        // id === model (pure duplication). model === "default" (Codex "let
        // the CLI pick whatever the account exposes") still gets a sub-line —
        // just a static explainer instead of a name, since the actual
        // resolved model varies by account/plan and can't be hardcoded here.
        (a.model === "default"
          // Use &#39; (HTML entity) instead of a literal apostrophe here — a
          // literal ' inside this single-quoted JS string would need \' to
          // survive, but backslash escapes get consumed by the OUTER PAGE
          // template literal before this text ever reaches the browser
          // (learned the hard way — see git history). Entities sidestep the
          // whole escaping trap.
          ? '<span class="sub" title="Resolves to whatever your Codex plan exposes — run &#39;codex exec &quot;what model are you?&quot;&#39; to check">auto (account-picked)</span>'
          : a.model && a.model !== a.id
          ? '<span class="sub">' + esc(a.model) + '</span>'
          : '') +
      '</td>' +
      '<td>' + (a.provider || "—") + '</td>' +
      '<td class="tier">' + (a.tier || "—") + '</td>' +
      '<td>' + tags + '</td>' +
      // State cell: pill hugs its text (state class already handles
      // white-space:nowrap on the td). The full note from probe/audit goes
      // into the pill's title attribute — hover to read without taking row space.
      // The last-err span (from stats.last_error) still renders inline below
      // the pill for failed dispatches, truncated + tooltipped in its own CSS.
      '<td class="state">' +
        '<span class="pill ' + (a.state || "healthy") + '"' +
          (a.note ? ' title="' + esc(a.note) + '"' : '') +
        '>' + (a.state || "healthy") + '</span>' +
        (a.state === "need_check"
          ? '<span class="last-err">cooldown elapsed; run probe</span>'
          : '') +
        ((a.state === "quota_exhausted" || a.state === "rate_limited") && a.cooldown_until
          // source "error_body" = an actual reset time was parsed from the
          // provider's response (Retry-After header, "Resets in Xh" text).
          // Anything else (missing, or "fallback_ttl") is a flat 1-hour
          // guess we made up because the provider didn't tell us — label it
          // as an estimate instead of presenting it as a known fact.
          ? '<span class="last-err">' +
              (a.source === "error_body" ? "until " : "~until ") +
              esc(new Date(a.cooldown_until * 1000).toLocaleString()) +
              (a.source === "error_body" ? "" : " (est.)") +
            '</span>'
          : '') +
        errCell +
      '</td>' +
      '<td class="num ' + (calls === 0 ? 'zero' : '') + '">' + (calls || "—") + '</td>' +
      '<td class="num ' + (tokens === 0 ? 'zero' : '') + '">' + (tokens > 0 ? fmtNum(tokens) : "—") + '</td>' +
      '<td class="num">' + successHtml + '</td>' +
      '<td class="time">' + fmtTime(a.last_used_at) + '</td>' +
      '<td>' +
        (a.usage_url
          ? '<a href="' + a.usage_url + '" target="_blank" rel="noopener">usage ↗</a> '
          : '') +
        '<button class="btn verify-btn" id="vb-' + a.id.replace(/[^a-z0-9]/gi, '_') + '" onclick="verify(\\'' + a.id + '\\')" title="Live probe — dispatch a tiny prompt and update state">run probe</button>' +
      '</td>';
    tbody.appendChild(tr);
  }
  document.getElementById("stamp").textContent =
    "loaded " + new Date().toLocaleTimeString([], { hour12: false });
}

// Theme cycle: system → light → dark → system. Applied via data-theme on the
// root element; CSS tokens redefine per data-theme value. When mode is
// "system", the attribute is cleared so prefers-color-scheme wins. Persisted
// in localStorage under key "theme".
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  const label = mode === "system" ? "◐ auto" : mode === "light" ? "☀ light" : "☾ dark";
  document.getElementById("theme-toggle").textContent = label;
}
function cycleTheme() {
  const cur = localStorage.getItem("theme") || "system";
  const next = cur === "system" ? "light" : cur === "light" ? "dark" : "system";
  localStorage.setItem("theme", next);
  applyTheme(next);
}
applyTheme(localStorage.getItem("theme") || "system");
function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}
// Click-to-copy for the CLI login commands. Copies the element's text (minus
// any trailing "# comment"), flashes a "copied" state on the <code> element.
function copyCmd(el) {
  const raw = el.textContent.replace(/\s*#.*$/, "").trim();
  navigator.clipboard.writeText(raw).then(() => {
    const prev = el.textContent;
    el.classList.add("copied");
    el.textContent = "✓ copied";
    setTimeout(() => { el.textContent = prev; el.classList.remove("copied"); }, 1000);
  }).catch(() => {});
}
async function toggleAgent(id, enabled) {
  await fetch("/api/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, enabled }),
  });
  await refresh();
}
async function submitAddModel() {
  const out = document.getElementById("am-result");
  const payload = {
    id:       document.getElementById("am-id").value.trim(),
    provider: document.getElementById("am-provider").value.trim(),
    model:    document.getElementById("am-model").value.trim(),
    url:      document.getElementById("am-url").value.trim(),
    env:      document.getElementById("am-env").value.trim(),
    tier:     document.getElementById("am-tier").value,
    tags:     document.getElementById("am-tags").value.trim(),
  };
  const miss = ["id", "provider", "model", "url", "env"].filter(k => !payload[k]);
  if (miss.length) {
    out.textContent = "missing: " + miss.join(", ");
    out.style.color = "var(--err)";
    return;
  }
  out.textContent = "saving…"; out.style.color = "var(--text-2)";
  const r = await fetch("/api/add_model", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (r.ok) {
    out.innerHTML = '<span style="color:var(--accent);">✓ ' + j.action + '</span> — probe the new model or paste its API key above.';
    out.style.color = "var(--accent)";
    ["am-id","am-provider","am-model","am-url","am-env","am-tags"].forEach(id => document.getElementById(id).value = "");
    await refresh();
  } else {
    out.textContent = "error: " + (j.error || r.statusText);
    out.style.color = "var(--err)";
  }
}

function renderAuditNag(audit) {
  const box = document.getElementById("audit-nag");
  if (!audit || !audit.stale) { box.style.display = "none"; return; }
  const msg = audit.age_days === null
    ? "No audit has ever run — you don't know whether these models still exist."
    : ("Oldest audit is " + audit.age_days + " day" + (audit.age_days === 1 ? "" : "s") + " old — providers deprecate models silently.");
  box.innerHTML =
    '<span class="msg">' + msg + '</span>' +
    '<code>external-agents audit</code>';
  box.style.display = "flex";
}
function renderStats(s) {
  renderAuditNag(s.audit);
  document.getElementById("s-healthy").textContent = s.healthy_count;
  // Name the switched-off entries in the footnote rather than silently
  // shrinking the numerator: "12 of 48" with 9 of those 48 disabled otherwise
  // reads as 36 broken agents.
  document.getElementById("s-healthy-foot").textContent =
    "of " + s.total_count + " total" + (s.disabled_count ? " · " + s.disabled_count + " off" : "");
  document.getElementById("s-locked").textContent = s.locked_count;
  document.getElementById("s-locked-foot").textContent =
    s.locked_count > 0 ? "paste a key below to unlock" : "all providers configured";
  document.getElementById("s-disp").textContent = fmtNum(s.dispatches);
  document.getElementById("s-disp-foot").textContent =
    fmtNum(s.tokens) + " tokens routed";
  document.getElementById("s-saved").textContent = fmtUsd(s.saved_usd);
  document.getElementById("s-saved-foot").textContent =
    "at Claude Sonnet pricing ($" + s.saved_anchor.toFixed(0) + "/1M tokens) · " + fmtNum(s.tokens_free) + " free-tier tokens";
  // Per-row Calls/Tokens columns are populated from stats.by_agent, which is
  // computed over the same selected range — keep their header text truthful.
  document.getElementById("th-calls").textContent = "Calls " + s.range;
  document.getElementById("th-tokens").textContent = "Tokens " + s.range;
  document.getElementById("stats-range-select").value = s.range;
  document.getElementById("stats-range-select-2").value = s.range;
}

async function submitSuggest() {
  const name = document.getElementById("suggest-name").value.trim();
  const u    = document.getElementById("suggest-url").value.trim();
  const out  = document.getElementById("suggest-result");
  if (!name) { out.textContent = "enter a model or provider name."; out.style.color = "var(--err)"; return; }
  const body = [
    "**Model / provider:** " + name,
    "",
    u ? "**Docs / setup URL:** " + u : "**Docs / setup URL:** _(none provided)_",
    "",
    "---",
    "_Submitted via 'external-agents ui' — the local dashboard._",
  ].join('\\n');
  const issueUrl =
    "https://github.com/mrrlin-dev/external-agents/issues/new?" +
    "labels=missing-model" +
    "&title=" + encodeURIComponent("Add " + name) +
    "&body=" + encodeURIComponent(body);
  window.open(issueUrl, "_blank", "noopener,noreferrer");
  out.innerHTML = 'opened a pre-filled GitHub issue in a new tab — click <b>Submit new issue</b> there.';
  out.style.color = "var(--accent)";
  document.getElementById("suggest-name").value = "";
  document.getElementById("suggest-url").value = "";
}

const PROVIDER_META = {
  groq: {
    label: "Groq",
    pitch: "Fastest hosted inference — ~500-800 tok/s. Free 30 rpm.",
    signup: "https://console.groq.com/keys",
    env: "GROQ_API_KEY",
  },
  openrouter: {
    label: "OpenRouter",
    pitch: "One key, 50+ free models — DeepSeek R1, Qwen-Coder, Llama, more.",
    signup: "https://openrouter.ai/settings/keys",
    env: "OPENROUTER_API_KEY",
  },
  cerebras: {
    label: "Cerebras",
    pitch: "~2000 tok/s — fastest silicon on the planet. Free 30 rpm.",
    signup: "https://cloud.cerebras.ai/platform/keys",
    env: "CEREBRAS_API_KEY",
  },
  google: {
    label: "Google AI Studio",
    pitch: "Gemini flash + pro, free API key — no card required.",
    signup: "https://aistudio.google.com/apikey",
    env: "GEMINI_API_KEY",
  },
  zai: {
    label: "Z.ai (GLM)",
    pitch: "Free tier for GLM-4.7-flash — solid Chinese frontier model.",
    signup: "https://z.ai/manage-apikey/apikey-list",
    env: "ZAI_API_KEY",
  },
  "ollama-cloud": {
    label: "Ollama Cloud",
    pitch: "gpt-oss 20B/120B via your Ollama account.",
    signup: "https://ollama.com/download",
    env: "(configured via the ollama CLI)",
  },
  deepseek: {
    label: "DeepSeek",
    pitch: "Prepaid balance, per account.",
    signup: "https://platform.deepseek.com/",
    env: "DEEPSEEK_API_KEY",
  },
};

// Per-CLI setup metadata — install link + auth step. Keyed by provider.
// Parallel to PROVIDER_META (which handles api-key providers): this drives the
// CLI-setup banner for agents whose auth is cli-based and are currently
// not_installed (need to install the binary) or needs_auth (installed but not
// logged in). These are subscription CLIs, so there is no API key to paste —
// the operator installs a binary and authenticates it once.
// NB: no backticks in this comment — it lives inside the PAGE template literal.
const CLI_META = {
  openai: {
    label: "Codex (OpenAI)",
    pitch: "ChatGPT-plan coding agent. Runs headless via codex exec.",
    installUrl: "https://github.com/openai/codex#installation",
    auth: "codex login",
  },
  anthropic: {
    label: "Claude Code",
    pitch: "Claude subscription CLI. Runs headless via claude --print.",
    installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    auth: "claude login",
  },
  cursor: {
    label: "Cursor Agent",
    pitch: "Cursor's agentic CLI (Pro plan for real usage).",
    installUrl: "https://docs.cursor.com/en/cli/overview",
    auth: "cursor-agent login",
  },
  sst: {
    label: "opencode",
    pitch: "SST's open-source agentic CLI.",
    installUrl: "https://opencode.ai/docs/",
    auth: "opencode auth login",
  },
  kiro: {
    label: "Kiro (AWS)",
    pitch: "AWS Kiro agentic CLI. Free monthly tier.",
    installUrl: "https://kiro.dev/downloads/",
    auth: "kiro-cli login",
  },
  "ollama-cloud": {
    label: "Ollama Cloud",
    pitch: "gpt-oss 20B/120B via the local Ollama daemon → cloud proxy.",
    installUrl: "https://ollama.com/download",
    auth: "ollama signin   # then: ollama pull gpt-oss:120b-cloud",
  },
};

// CLI setup banner — mirrors the api-key unlock banner but for subscription
// CLIs. Surfaces cli-auth agents that are not_installed (need install) or
// needs_auth (installed, need login). Install is a LINK (the "Install ↗"
// button, parallel to the api-key banner's "Get free key ↗"), because install
// steps differ per OS/arch and are better handled on the tool's own page. The
// login step is a copy-pasteable command since that IS the actionable local
// action once the binary is present.
// Collapse state for the three dismissable banner panels (cli-setup, unlock,
// api-keys) persists in localStorage so a closed panel stays closed across
// both refresh() (which fully rebuilds these boxes' innerHTML) and page
// reloads.
function isBoxCollapsed(key) {
  return localStorage.getItem("collapsed_" + key) === "1";
}
function toggleBoxCollapse(key) {
  localStorage.setItem("collapsed_" + key, isBoxCollapsed(key) ? "0" : "1");
  refresh();
}

function renderCliSetup(agents) {
  const box = document.getElementById("cli-setup");
  const needsSetup = agents.filter(a =>
    typeof a.auth === "string" && a.auth.startsWith("cli:") &&
    (a.state === "not_installed" || a.state === "needs_auth") &&
    a.enabled !== false
  );
  const providers = [...new Set(needsSetup.map(a => a.provider))];
  if (providers.length === 0) { box.style.display = "none"; return; }
  const rows = providers.map(p => {
    const m = CLI_META[p] || { label: p, pitch: "", installUrl: "#", auth: "" };
    const list = needsSetup.filter(a => a.provider === p);
    const count = list.length;
    const anyMissing = list.some(a => a.state === "not_installed");
    // not_installed → the install link is step 1, login step 2. Already
    // installed (needs_auth) → login is the only step.
    const authRow = m.auth
      ? '<div class="cli-cmd-row">' +
          '<span class="cli-cmd-label">' + (anyMissing ? "then log in" : "log in") + '</span>' +
          '<code class="cli-cmd" title="click to copy" onclick="copyCmd(this)">' + esc(m.auth) + '</code>' +
        '</div>'
      : '';
    // Installing/logging in never flips state.json itself — a subscription
    // CLI's login can't be cheaply probed at rest (see deriveDisplayState),
    // so needs_auth persists until a real audit runs. Give the row its own
    // probe button (mirrors the per-agent "run probe" in the table) so the
    // operator can clear the banner right after logging in instead of
    // waiting to discover the stale state elsewhere.
    const btnId = "vb-cli-" + p.replace(/[^a-z0-9]/gi, "_");
    const ids = list.map(a => a.id);
    const verifyBtn = '<button class="btn verify-btn" id="' + btnId + '" ' +
      'data-ids="' + esc(JSON.stringify(ids)) + '" onclick="verifyCliProvider(this)" ' +
      'title="Live probe — dispatch a tiny prompt per model and update state">run probe</button>';
    return '<div class="cli-setup-row">' +
      '<div>' +
        '<div class="prov">' + m.label + '</div>' +
        '<div class="waiting">' + count + ' model' + (count > 1 ? "s" : "") + ' · ' +
          (anyMissing ? "not installed" : "needs login") + '</div>' +
      '</div>' +
      '<div>' +
        '<div class="pitch">' + m.pitch + '</div>' +
        '<div class="cli-cmds">' + authRow + '</div>' +
      '</div>' +
      (anyMissing
        ? '<a class="btn signup" href="' + m.installUrl + '" target="_blank" rel="noopener">Install ↗</a>'
        : verifyBtn) +
    '</div>';
  }).join("");
  const collapsed = isBoxCollapsed("cli-setup");
  box.innerHTML =
    '<h2 class="collapsible-header" onclick="toggleBoxCollapse(\\'cli-setup\\')">Set up ' + providers.length + ' CLI agent' + (providers.length > 1 ? "s" : "") +
      '<span class="chevron">' + (collapsed ? "▸" : "▾") + '</span></h2>' +
    (collapsed ? "" :
      '<p class="tag">These are subscription/agentic CLIs — no API key to paste. Install the binary (link), log in once (copy the command), then restart your MCP client.</p>' +
      rows);
  box.style.display = "block";
}

function renderUnlock(agents) {
  const box = document.getElementById("unlock");
  // Only surface entries that pasting a key will actually unlock. Skip:
  //   - already disabled by the operator (toggle off)
  //   - model_unavailable — key is fine, model just doesn't exist on this account
  //   - any provider whose FAMILY (base + numbered siblings, e.g. google/google2)
  //     already has a working key elsewhere — that family belongs in the
  //     "API Keys" panel's "+ add another key" flow instead, not this banner.
  const missing = (() => {
    const digitSuffix = /\\d+$/;
    const basesWithNonNeedsAuth = new Set(
      agents.filter(a => a.state !== "needs_auth" && a.enabled !== false)
            .map(a => a.provider.replace(digitSuffix, ""))
    );
    return agents.filter(a => {
      if (digitSuffix.test(a.provider)) return false;
      if (basesWithNonNeedsAuth.has(a.provider.replace(digitSuffix, ""))) return false;
      return (a.tags || []).includes("free") && a.state === "needs_auth" && a.enabled !== false;
    });
  })();
  const providers = [...new Set(missing.map(a => a.provider))];
  if (providers.length === 0) { box.style.display = "none"; return; }
  const rows = providers.map(p => {
    const m = PROVIDER_META[p] || { label: p, pitch: "", signup: "#", env: "?" };
    const count = missing.filter(a => a.provider === p).length;
    const hasEnvInput = !!m.env && !m.env.startsWith("(");
    const keyRow = hasEnvInput
      ? '<div class="keyrow">' +
          '<input id="k-' + m.env + '" class="keyinput" type="password" placeholder="paste ' + m.env + '" ' +
            'onkeydown="if(event.key===\\'Enter\\')saveKey(\\'' + m.env + '\\')">' +
          '<button class="btn primary" onclick="saveKey(\\'' + m.env + '\\')">Save</button>' +
        '</div>' +
        '<span id="s-' + m.env + '" class="status"></span>'
      : '<span class="status">' + m.env + '</span>';
    return '<div class="unlock-row">' +
      '<div>' +
        '<div class="prov">' + m.label + '</div>' +
        '<div class="waiting">+' + count + ' model' + (count > 1 ? "s" : "") + ' waiting</div>' +
      '</div>' +
      '<div class="pitch">' + m.pitch + '</div>' +
      '<div>' + keyRow + '</div>' +
      '<a class="btn signup" href="' + m.signup + '" target="_blank" rel="noopener">Get free key ↗</a>' +
    '</div>';
  }).join("");
  const collapsed = isBoxCollapsed("unlock");
  box.innerHTML =
    '<h2 class="collapsible-header" onclick="toggleBoxCollapse(\\'unlock\\')">Unlock ' + missing.length + ' free-tier model' + (missing.length > 1 ? "s" : "") +
      '<span class="chevron">' + (collapsed ? "▸" : "▾") + '</span></h2>' +
    (collapsed ? "" :
      '<p class="tag">These providers offer generous free tiers — sign up (60s, usually no card), paste the key, restart your MCP client. Your dispatch pool grows and your bill stays flat.</p>' +
      rows);
  box.style.display = "block";
}

// "+ Add another key" panel — the complement of renderUnlock's family check
// above: shows a provider here iff its family already has >=1 working entry
// (renderUnlock hides it once that's true). A second key for an
// already-working provider gets its own numbered provider slug (google2,
// google3, ...) via POST /api/add_provider_key, so it counts as an
// independent quota bucket for pick's min_distinct_providers, not a retry of
// the same one.
function renderApiKeysPanel(agents) {
  const box = document.getElementById("api-keys");
  const digitSuffix = /\\d+$/;
  const families = new Map();
  for (const a of agents) {
    if (a.enabled === false) continue;
    const base = a.provider.replace(digitSuffix, "");
    if (!families.has(base)) families.set(base, []);
    families.get(base).push(a);
  }
  const rows = [];
  for (const [base, members] of families) {
    if (!members.some(a => a.state !== "needs_auth")) continue;
    const meta = PROVIDER_META[base];
    // No env-var story for this base (e.g. a subscription CLI like
    // ollama-cloud) — nothing to paste, so there is no "+ add key" flow.
    if (!meta || !meta.env || meta.env.startsWith("(")) continue;
    const slugs = [...new Set(members.map(a => a.provider))];
    const slugCount = slugs.length;
    // The base slug (e.g. "google") is bundled/hand-authored — never removable
    // here. Numbered siblings (google2, google3, ...) were created by THIS
    // endpoint, so they can be undone by it too.
    const extraSlugs = slugs.filter(s => s !== base).sort();
    const explainer =
      base === "google"
        ? "Google AI Studio can gate an entire project at once — separate from each model's own per-minute/per-day limit — even within the same Google account. We confirmed this directly: a request that failed under one project succeeded immediately from a second project's key, same account."
        : base === "deepseek"
        ? "Your DeepSeek prepaid balance is tied to the whole account, not to one model — a second account means a second balance."
        : "This provider's free tier is tied to the whole account, not to one model — a second account means a second free tier.";
    const extraKeysRow = extraSlugs.length
      ? '<div class="extra-keys">' + extraSlugs.map(s =>
          '<span class="chip">' + s +
            '<button class="chip-x" title="remove ' + s + '" onclick="removeProviderKey(\\'' + base + '\\',\\'' + s + '\\')">×</button>' +
          '</span>'
        ).join("") + '</div>'
      : "";
    rows.push(
      '<div class="unlock-row">' +
        '<div><div class="prov">' + meta.label + ' <span class="badge">' + slugCount + ' key' + (slugCount > 1 ? "s" : "") + '</span></div>' + extraKeysRow + '</div>' +
        '<div class="pitch">' + explainer + '</div>' +
        '<div>' +
          '<div class="keyrow">' +
            '<input id="pk-' + base + '" class="keyinput" type="password" placeholder="paste another ' + meta.env + '" ' +
              'onkeydown="if(event.key===\\'Enter\\')addProviderKey(\\'' + base + '\\')">' +
            '<button class="btn primary" onclick="addProviderKey(\\'' + base + '\\')">Add key</button>' +
          '</div>' +
          '<span id="pks-' + base + '" class="status"></span>' +
        '</div>' +
        '<div></div>' +
      '</div>'
    );
  }
  if (rows.length === 0) { box.style.display = "none"; return; }
  const collapsed = isBoxCollapsed("api-keys");
  box.innerHTML =
    '<h2 class="collapsible-header" onclick="toggleBoxCollapse(\\'api-keys\\')">API keys' +
      '<span class="chevron">' + (collapsed ? "▸" : "▾") + '</span></h2>' +
    (collapsed ? "" :
      '<p class="tag">Already using one of these? Add another account\\'s key — it gets its own quota bucket, so a limit on the first key no longer stalls dispatch.</p>' +
      rows.join(""));
  box.style.display = "block";
}

async function addProviderKey(base) {
  const inp = document.getElementById("pk-" + base);
  const stat = document.getElementById("pks-" + base);
  const val = (inp.value || "").trim();
  if (!val) { stat.textContent = "empty value"; stat.style.color = "var(--err)"; return; }
  stat.textContent = "adding…"; stat.style.color = "var(--text-2)";
  try {
    const r = await fetch("/api/add_provider_key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_provider: base, value: val })
    });
    const j = await r.json();
    if (r.ok && j.ok) {
      stat.innerHTML = '<span style="color:var(--accent);">✓ +' + j.cloned_ids.length + ' models added as ' + j.provider_slug + '</span>' + (j.warning ? ' — ' + j.warning : "");
      inp.value = "";
      await refresh();
    } else {
      stat.textContent = "error: " + (j.error || r.statusText);
      stat.style.color = "var(--err)";
    }
  } catch (e) {
    stat.textContent = "network error: " + e.message;
    stat.style.color = "var(--err)";
  }
}

async function removeProviderKey(base, slug) {
  if (!confirm("Remove " + slug + " and its models? This deletes the associated key too.")) return;
  const stat = document.getElementById("pks-" + base);
  try {
    const r = await fetch("/api/remove_provider_key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_slug: slug })
    });
    const j = await r.json();
    if (r.ok && j.ok) {
      await refresh();
    } else if (stat) {
      stat.textContent = "error: " + (j.error || r.statusText);
      stat.style.color = "var(--err)";
    }
  } catch (e) {
    if (stat) { stat.textContent = "network error: " + e.message; stat.style.color = "var(--err)"; }
  }
}

async function saveKey(envName) {
  const inp = document.getElementById("k-" + envName);
  const stat = document.getElementById("s-" + envName);
  const val = (inp.value || "").trim();
  if (!val) { stat.textContent = "empty value"; stat.style.color = "var(--err)"; return; }
  stat.textContent = "saving…"; stat.style.color = "var(--text-2)";
  try {
    const r = await fetch("/api/set_credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env_name: envName, value: val })
    });
    const j = await r.json();
    if (r.ok) {
      const v = (j.verified || [])[0] || {};
      const nProbed = (j.reprobed || []).length;
      if (v.ok) {
        const ms = v.latencyMs ? " (" + v.latencyMs + "ms)" : "";
        stat.innerHTML = '<span style="color:var(--accent);">✓ verified' + ms + '</span> — ' + nProbed + ' model' + (nProbed === 1 ? "" : "s") + ' unlocked';
      } else if (v.hint) {
        stat.innerHTML = '<span style="color:var(--err);">✗ ' + v.hint + '</span> — key saved but provider rejected it';
      } else {
        stat.innerHTML = '<span style="color:var(--accent);">✓ persisted</span> — ' + nProbed + ' model' + (nProbed === 1 ? "" : "s") + ' unlocked';
      }
      inp.value = "";
      await refresh();
    } else {
      stat.textContent = "error: " + (j.error || r.statusText);
      stat.style.color = "var(--err)";
    }
  } catch (e) {
    stat.textContent = "network error: " + e.message;
    stat.style.color = "var(--err)";
  }
}

// Persisted alongside sort_key/sort_dir so a refresh doesn't reset it.
let statsRange = localStorage.getItem("stats_range") || "24h";
function setStatsRange(range) {
  statsRange = range;
  localStorage.setItem("stats_range", range);
  refresh();
}

async function refresh() {
  const [state, stats] = await Promise.all([
    fetch("/api/state").then(r => r.json()),
    fetch("/api/stats?range=" + encodeURIComponent(statsRange)).then(r => r.json()),
  ]);
  renderStats(stats);
  renderUnlock(state.agents);
  renderApiKeysPanel(state.agents);
  renderCliSetup(state.agents);
  renderRows(state.agents, stats.by_agent);
}
async function verify(id) {
  const btnId = "vb-" + id.replace(/[^a-z0-9]/gi, "_");
  const btn = document.getElementById(btnId);
  const originalText = btn ? btn.textContent : "run";
  if (btn) { btn.textContent = "..."; btn.disabled = true; }
  try {
    const r = await fetch("/api/audit?id=" + encodeURIComponent(id), { method: "POST" });
    const j = await r.json();
    // Flash the outcome on the button for 1.5s before refresh redraws the row.
    if (btn) {
      const glyph = j.outcome === "healthy" ? "✓" :
                    j.outcome === "needs_auth" ? "⚠" :
                    j.outcome === "model_unavailable" ? "✗" :
                    j.outcome === "quota_exhausted" || j.outcome === "rate_limited" ? "⏳" :
                    j.outcome === "probe_error" ? "!" : "?";
      // probe_error means the command never ran, so the row's stored state was
      // deliberately left untouched. Showing a latency next to it would imply
      // the agent answered something; it didn't, and the operator needs to look
      // at this machine rather than at the provider.
      btn.textContent = j.outcome === "probe_error"
        ? "! probe failed"
        : glyph + " " + (j.latency_ms ? j.latency_ms + "ms" : j.outcome);
      if (j.outcome === "probe_error") btn.title = j.note || "the probe command could not be executed";
      btn.disabled = false;
    }
    setTimeout(() => refresh(), 1200);
  } catch (e) {
    if (btn) { btn.textContent = "✗ err"; btn.disabled = false; }
    setTimeout(() => refresh(), 1200);
  }
}
// Same probe as verify() but for the CLI-setup banner, where one provider
// (e.g. codex) can back several registry ids — probing just one wouldn't
// clear the banner, since renderCliSetup keeps showing the provider as long
// as ANY of its ids is still needs_auth/not_installed.
async function verifyCliProvider(btn) {
  const ids = JSON.parse(btn.dataset.ids || "[]");
  if (!ids.length) return;
  btn.textContent = "...";
  btn.disabled = true;
  try {
    const results = await Promise.all(ids.map(id =>
      fetch("/api/audit?id=" + encodeURIComponent(id), { method: "POST" }).then(r => r.json())
    ));
    const allHealthy = results.every(j => j.outcome === "healthy");
    const glyph = allHealthy ? "✓" : results.some(j => j.outcome === "healthy") ? "△" : "⚠";
    // Prefer a real verdict over "probe_error" when reporting a mixed batch:
    // an id whose command would not execute says nothing about the provider,
    // and leading with it hides the ids that did answer.
    const reported = results.find(j => j.outcome !== "probe_error") || results[0];
    btn.textContent = glyph + " " + (allHealthy ? "verified" : reported.outcome);
    btn.disabled = false;
  } catch (e) {
    btn.textContent = "✗ err";
    btn.disabled = false;
  }
  setTimeout(() => refresh(), 1200);
}
document.querySelectorAll("#thead-row th[data-sort]").forEach(th => {
  th.addEventListener("click", () => setSort(th.dataset.sort));
});
document.getElementById("stats-range-select").addEventListener("change", (e) => setStatsRange(e.target.value));
document.getElementById("stats-range-select-2").addEventListener("change", (e) => setStatsRange(e.target.value));
refresh();
</script>
</body>
</html>`;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  if (req.method === "GET" && p === "/api/state") {
    // Pick up keys added from another shell since this process booted, so a
    // `set-credential` in a terminal is reflected on the next poll instead of
    // needing a UI restart.
    refreshEnv();
    return json(res, 200, {
      schema_version: REGISTRY.schema_version,
      agents: stateRows(),
    });
  }

  if (req.method === "GET" && p === "/api/stats") {
    return json(res, 200, computeStats(parsed.query.range));
  }

  if (req.method === "POST" && p === "/api/set_credential") {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", async () => {
      try {
        const { env_name, value } = JSON.parse(body || "{}");
        if (!env_name || typeof env_name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(env_name)) {
          return json(res, 400, { error: "invalid env_name" });
        }
        if (!value || typeof value !== "string") return json(res, 400, { error: "missing value" });
        const persisted = loadKeysFile();
        persisted[env_name] = value;
        saveKeysFile(persisted);
        process.env[env_name] = value;
        console.error(`external-agents ui: credential persisted for ${env_name} (${value.length} chars)`);
        const affected = REGISTRY.agents.filter((a) => {
          const authVar = typeof a.auth === "string" && a.auth.startsWith("env:")
            ? a.auth.slice("env:".length).split(/\s+/)[0]
            : null;
          const genVar = a.transports?.generate_new?.env || null;
          return authVar === env_name || genVar === env_name;
        });
        const patch = {};
        for (const a of affected) {
          const r = probeInstalled(a);
          patch[a.id] = { ...r, checked: Math.floor(Date.now() / 1000) };
        }
        // Verify + patch is wrapped separately from the outer JSON-parse
        // try/catch: the credential is ALREADY persisted above by this
        // point, so a thrown verifyCredential (vs. its normal {ok:false,...}
        // return) must not surface as the outer catch's "invalid json: ..."
        // — that blames parsing for an unrelated failure and, worse, tells
        // the operator the save itself failed when it didn't. Mirrors
        // /api/add_provider_key's identical try/catch below.
        try {
          const seenProviders = new Set();
          const toVerify = affected.filter((a) => {
            if (seenProviders.has(a.provider)) return false;
            seenProviders.add(a.provider);
            return a.transports?.generate_new?.url;
          });
          const verifyResults = await Promise.all(toVerify.map(async (a) => {
            const v = await verifyCredential(a);
            return { agent_id: a.id, provider: a.provider, ...v };
          }));
          for (const vr of verifyResults) {
            if (!vr.ok) {
              // Only a confirmed model_unavailable or needs_auth outcome says
              // anything about the credential itself. quota_exhausted/
              // rate_limited/errored_transient (429, 5xx, timeout, network
              // blip) are noise from THIS verify ping, not proof the key is
              // bad — leave the probeInstalled() result already computed above
              // alone instead of clobbering a correct "healthy" with a false
              // "needs_auth" (see classifyVerifyResult in lib/dispatch.js).
              const outcome = classifyVerifyResult(vr);
              if (outcome === "model_unavailable") {
                // THIS model doesn't exist on the account — the key itself is
                // fine, so mark only the verified agent (sibling entries with
                // different models stay eligible).
                patch[vr.agent_id] = {
                  state: "model_unavailable",
                  note: `provider says model does not exist (HTTP ${vr.status || "?"})`,
                  checked: Math.floor(Date.now() / 1000),
                };
              } else if (outcome === "needs_auth") {
                // A genuinely bad key fans out to every entry sharing this provider.
                for (const a of affected.filter((x) => x.provider === vr.provider)) {
                  patch[a.id] = {
                    state: "needs_auth",
                    note: `verify failed: ${vr.hint || "unknown"}`,
                    checked: Math.floor(Date.now() / 1000),
                  };
                }
              }
            }
          }
          if (Object.keys(patch).length > 0) writeState(patch);
          // After the patch, not before: those writes replace each entry
          // wholesale and would drop the `enabled` flag set here.
          const enabledIds = enableAgentsAwaitingCredential(env_name, REGISTRY.agents);
          if (enabledIds.length > 0) {
            console.error(`external-agents ui: set_credential(${env_name}) enabled ${enabledIds.length} agent(s) that were off pending this key: ${enabledIds.join(", ")}`);
          }
          const okCount = verifyResults.filter((v) => v.ok).length;
          const failCount = verifyResults.length - okCount;
          console.error(`external-agents ui: set_credential(${env_name}) — re-probed ${affected.length}, verified ${verifyResults.length} providers (${okCount} ok, ${failCount} failed): ${verifyResults.map((v) => v.provider + "=" + (v.ok ? "ok" : "FAIL:" + v.hint)).join(", ")}`);
          return json(res, 200, {
            ok: true,
            env_name,
            persisted_to: KEYS_FILE,
            reprobed: affected.map((a) => a.id),
            enabled_ids: enabledIds,
            verified: verifyResults,
            restart_required: "Restart your MCP client (Claude Code / Codex) so IT reads keys.env too.",
          });
        } catch (verifyErr) {
          return json(res, 200, {
            ok: true,
            env_name,
            persisted_to: KEYS_FILE,
            reprobed: affected.map((a) => a.id),
            verified: [],
            warning: `credential saved but post-save verification failed: ${verifyErr.message}`,
          });
        }
      } catch (e) {
        return json(res, 400, { error: "invalid json: " + e.message });
      }
    });
    return;
  }

  // POST /api/add_provider_key { base_provider, value } — clone every entry
  // for an already-configured provider under a NEW numbered provider slug
  // (google -> google2, google3, ...) so a second account's key becomes an
  // independently-quota'd sibling instead of overwriting the first. See
  // lib/registry.js's CANONICAL_BASES / nextProviderSlot / withLocalOverlayLock
  // for the invariants this depends on (canonical-base eligibility, slot
  // numbering keyed off distinct provider slugs, cross-process-safe overlay
  // write).
  if (req.method === "POST" && p === "/api/add_provider_key") {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", async () => {
      let base_provider, value;
      try {
        ({ base_provider, value } = JSON.parse(body || "{}"));
      } catch (e) {
        return json(res, 400, { error: "invalid json: " + e.message });
      }
      if (!base_provider || typeof base_provider !== "string") {
        return json(res, 400, { error: "missing base_provider" });
      }
      if (!value || typeof value !== "string") {
        return json(res, 400, { error: "missing value" });
      }
      if (!CANONICAL_BASES(REGISTRY).has(base_provider)) {
        return json(res, 400, { error: `unknown or non-canonical base provider: ${base_provider}` });
      }
      if (addProviderInFlight.has(base_provider)) {
        return json(res, 409, { error: `an add-key request for ${base_provider} is already in progress` });
      }
      addProviderInFlight.add(base_provider);
      try {
        const baseAgent = REGISTRY.agents.find(
          (a) => a.provider === base_provider && typeof a.auth === "string" && a.auth.startsWith("env:")
        );
        if (!baseAgent) {
          return json(res, 400, { error: `no env:-auth entry found for base provider: ${base_provider}` });
        }
        const baseEnvName = baseAgent.auth.slice("env:".length).split(/\s+/)[0];

        let provider_slug, newEnvName, clonedIds;
        try {
          await withLocalOverlayLock(async (overlay) => {
            // Fresh merge of bundled + the overlay withLocalOverlayLock just
            // handed us — never the in-process REGISTRY, which could be
            // stale relative to a write another process just made.
            const bundled = yaml.load(fs.readFileSync(BUNDLED_YAML, "utf-8"));
            const merged = { agents: [...bundled.agents, ...overlay.agents] };
            const N = nextProviderSlot(merged, base_provider);
            provider_slug = `${base_provider}${N}`;
            newEnvName = `${baseEnvName}_${N}`;

            clonedIds = [];
            for (const a of merged.agents.filter((x) => x.provider === base_provider)) {
              const newId = `${a.id}-${N}`;
              if (overlay.agents.some((x) => x.id === newId)) continue;
              const transports = structuredClone(a.transports || {});
              for (const t of Object.values(transports)) {
                if (t && t.env === baseEnvName) t.env = newEnvName;
              }
              overlay.agents.push({ ...a, id: newId, provider: provider_slug, auth: `env:${newEnvName}`, transports });
              clonedIds.push(newId);
            }
            return overlay;
          });
        } catch (lockErr) {
          const status = /^registry busy/.test(lockErr.message) ? 503 : 500;
          return json(res, status, { error: lockErr.message });
        }

        reloadRegistry();
        const persisted = loadKeysFile();
        persisted[newEnvName] = value;
        saveKeysFile(persisted);
        process.env[newEnvName] = value;
        console.error(`external-agents ui: add_provider_key ${base_provider} -> ${provider_slug} (${clonedIds.length} clones, env=${newEnvName})`);

        try {
          const cloneAgents = clonedIds.map((id) => REGISTRY.agents.find((a) => a.id === id)).filter(Boolean);
          const patch = {};
          for (const a of cloneAgents) {
            const r = probeInstalled(a);
            patch[a.id] = { ...r, checked: Math.floor(Date.now() / 1000) };
          }
          const toVerify = cloneAgents.filter((a) => a.transports?.generate_new?.url);
          const verifyResults = await Promise.all(toVerify.map(async (a) => {
            const v = await verifyCredential(a);
            return { agent_id: a.id, provider: a.provider, ...v };
          }));
          for (const vr of verifyResults) {
            if (vr.ok) continue;
            // Same reasoning as /api/set_credential: only model_unavailable
            // or needs_auth says anything about the credential. A transient
            // verify failure (rate limit, 5xx, timeout) must not overwrite
            // the healthy probeInstalled() result already in patch — that
            // is exactly what locked the numbered clones the operator just
            // added when the very next verify ping caught Gemini's 429.
            const outcome = classifyVerifyResult(vr);
            if (outcome === "model_unavailable") {
              patch[vr.agent_id] = {
                state: "model_unavailable",
                note: `provider says model does not exist (HTTP ${vr.status || "?"})`,
                checked: Math.floor(Date.now() / 1000),
              };
            } else if (outcome === "needs_auth") {
              for (const a of cloneAgents) {
                patch[a.id] = {
                  state: "needs_auth",
                  note: `verify failed: ${vr.hint || "unknown"}`,
                  checked: Math.floor(Date.now() / 1000),
                };
              }
            }
          }
          if (Object.keys(patch).length > 0) writeState(patch);
          return json(res, 200, { ok: true, provider_slug, cloned_ids: clonedIds, verified: verifyResults });
        } catch (verifyErr) {
          return json(res, 200, {
            ok: true,
            provider_slug,
            cloned_ids: clonedIds,
            verified: [],
            warning: `key saved but post-add verification failed: ${verifyErr.message}`,
          });
        }
      } finally {
        addProviderInFlight.delete(base_provider);
      }
    });
    return;
  }

  // POST /api/remove_provider_key { provider_slug } — the inverse of
  // /api/add_provider_key: drops every agents.local.yaml entry for a NUMBERED
  // provider slug (google2, groq3, ...) plus its dedicated env var. Rejects
  // canonical (non-numbered) bases outright — those are bundled/hand-authored,
  // never something this UI created, so there is nothing here to safely undo.
  if (req.method === "POST" && p === "/api/remove_provider_key") {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", async () => {
      let provider_slug;
      try {
        ({ provider_slug } = JSON.parse(body || "{}"));
      } catch (e) {
        return json(res, 400, { error: "invalid json: " + e.message });
      }
      if (!provider_slug || typeof provider_slug !== "string" || !/\d+$/.test(provider_slug)) {
        return json(res, 400, { error: "provider_slug must be a numbered slug (e.g. google2) — canonical bases cannot be removed here" });
      }
      let removedIds, removedEnvNames;
      try {
        await withLocalOverlayLock(async (overlay) => {
          removedIds = [];
          removedEnvNames = new Set();
          overlay.agents = overlay.agents.filter((a) => {
            if (a.provider !== provider_slug) return true;
            removedIds.push(a.id);
            if (typeof a.auth === "string" && a.auth.startsWith("env:")) {
              removedEnvNames.add(a.auth.slice("env:".length).split(/\s+/)[0]);
            }
            return false;
          });
          return overlay;
        });
      } catch (lockErr) {
        const status = /^registry busy/.test(lockErr.message) ? 503 : 500;
        return json(res, status, { error: lockErr.message });
      }
      // A numbered slug can also ship in the BUNDLED registry — `google2` is
      // hand-authored there, so the overlay filter above removes nothing. Every
      // key past the first is optional, though, so "remove" has to work for
      // those too. We can't delete a line out of the bundled yaml, so use the
      // kill switch state.json already provides: disable each bundled entry
      // under this slug. The env var is dropped either way, so the entries go
      // needs_auth as well as disabled — re-adding the key through "+ Add
      // another key" flips them back on.
      let disabledIds = [];
      if (removedIds.length === 0) {
        const bundled = REGISTRY.agents.filter((a) => a.provider === provider_slug);
        if (bundled.length === 0) {
          return json(res, 404, { error: `unknown provider: ${provider_slug}` });
        }
        const current = readState();
        const patch = {};
        for (const a of bundled) {
          disabledIds.push(a.id);
          patch[a.id] = { ...(current[a.id] || {}), enabled: false };
          if (typeof a.auth === "string" && a.auth.startsWith("env:")) {
            removedEnvNames.add(a.auth.slice("env:".length).split(/\s+/)[0]);
          }
        }
        writeState(patch);
      }
      reloadRegistry();
      // Only drop the env var from keys.env once nothing in the registry
      // still references it — defensive; in practice a numbered slug's env
      // var is never shared with any other entry.
      // A disabled-not-deleted entry still "references" its env var in the
      // registry, so exclude the ones we just disabled — otherwise the key
      // would survive the removal it was the whole point of.
      const disabledSet = new Set(disabledIds);
      const stillReferenced = new Set(
        REGISTRY.agents
          .filter((a) => typeof a.auth === "string" && a.auth.startsWith("env:"))
          .filter((a) => !disabledSet.has(a.id))
          .map((a) => a.auth.slice("env:".length).split(/\s+/)[0])
      );
      const persisted = loadKeysFile();
      let keysChanged = false;
      for (const envName of removedEnvNames) {
        if (!stillReferenced.has(envName) && envName in persisted) {
          delete persisted[envName];
          delete process.env[envName];
          keysChanged = true;
        }
      }
      if (keysChanged) saveKeysFile(persisted);
      console.error(`external-agents ui: remove_provider_key ${provider_slug} (${removedIds.length} removed, ${disabledIds.length} disabled, env(s) ${[...removedEnvNames].join(",")})`);
      return json(res, 200, { ok: true, provider_slug, removed_ids: removedIds, disabled_ids: disabledIds });
    });
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && p === "/api/probe") {
    const id = parsed.query.id;
    if (!id || typeof id !== "string") return json(res, 400, { error: "missing id" });
    const entry = findAgent(id);
    if (!entry) return json(res, 404, { error: `unknown agent: ${id}` });
    refreshEnv();
    const result = probeInstalled(entry);
    const checked = Math.floor(Date.now() / 1000);
    writeState({ [id]: { ...result, checked } });
    return json(res, 200, { id, ...result, checked });
  }

  // POST /api/audit?id=X — single-agent live audit. For entries with a
  // generate_new transport uses verifyCredential (HTTP round-trip ~500ms);
  // for edit_exists-only entries invokes auditCliEntry (spawns the CLI with
  // a tiny prompt, 5-20s). Writes the resulting state to state.json (same
  // deep-merge semantics as the CLI `audit` command) and returns the outcome
  // so the UI can flash a per-button result before the full refresh().
  if (req.method === "POST" && p === "/api/audit") {
    const id = parsed.query.id;
    if (!id || typeof id !== "string") return json(res, 400, { error: "missing id" });
    const entry = findAgent(id);
    if (!entry) return json(res, 404, { error: `unknown agent: ${id}` });
    const hasApi = !!entry.transports?.generate_new?.url;
    const v = hasApi ? await verifyCredential(entry) : await auditCliEntry(entry);
    const outcome = classifyVerifyResult(v);
    const note =
      v.ok            ? `verified (${v.latencyMs}ms)${hasApi ? "" : " (cli)"}`
      : v.hint        ? v.hint + (v.status ? ` (HTTP ${v.status})` : "")
      : `HTTP ${v.status || "?"}`;
    // Which outcomes carry an expiry, and how long, lives in auditCooldown
    // (lib/state.js). This handler and the `external-agents audit` CLI loop
    // used to compute it separately, which is how one of them could grow a
    // rule (errored_transient needs a TTL) that the other never learned.
    const { cooldown_until, source: cooldownSource } = auditCooldown(outcome, v);
    // "probe_error" = the command never executed (usually this process's PATH),
    // so we learned nothing about the agent. Recording it would blame the agent
    // for our shell AND, because any non-healthy record blocks pick until it
    // expires, drop a working entry out of rotation. Leave state.json as it was.
    if (shouldPersistOutcome(outcome)) {
      writeState({
        [entry.id]: mergeAuditState(readState()[entry.id] || {}, {
          outcome,
          note,
          checked: Math.floor(Date.now() / 1000),
          cooldown_until,
          source: cooldownSource,
        }),
      });
    }
    return json(res, 200, {
      id, outcome, note,
      latency_ms: v.latencyMs || null,
      status: v.status || null,
      // Tells the caller whether state.json actually moved. false means the
      // probe failed to run and the stored verdict was deliberately left alone.
      persisted: shouldPersistOutcome(outcome),
    });
  }

  // POST /api/toggle { id, enabled } — flip the operator kill switch. Stored in
  // state.json as `enabled: false`; pickAgents hides disabled entries from
  // both pick and dispatch. Missing / true = enabled (default).
  if (req.method === "POST" && p === "/api/toggle") {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", () => {
      try {
        const { id, enabled } = JSON.parse(body || "{}");
        if (!id || !findAgent(id)) return json(res, 404, { error: `unknown agent: ${id}` });
        if (typeof enabled !== "boolean") return json(res, 400, { error: "enabled must be boolean" });
        // writeState does a SHALLOW merge — the value for state[id] is replaced
        // wholesale — so we deep-merge here to keep probe results (state, note,
        // checked, last_used_at) intact when the operator flips the toggle.
        const current = readState()[id] || {};
        writeState({ [id]: { ...current, enabled } });
        console.error(`external-agents ui: toggle ${id} → enabled=${enabled}`);
        return json(res, 200, { ok: true, id, enabled });
      } catch (e) {
        return json(res, 400, { error: "invalid json: " + e.message });
      }
    });
    return;
  }

  // POST /api/add_model — append a user-authored entry to the LOCAL_PATH overlay.
  // Same schema as `external-agents add-model`; the UI just gives it a form.
  // Registry is hot-reloaded so the new row appears without a UI restart.
  if (req.method === "POST" && p === "/api/add_model") {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", () => {
      try {
        const { id, provider, model, url: modelUrl, env: envVar, tier, tags } = JSON.parse(body || "{}");
        if (!id || !provider || !model || !modelUrl || !envVar) {
          return json(res, 400, { error: "missing required field (id / provider / model / url / env)" });
        }
        if (!/^[A-Za-z0-9_.:@\-]+$/.test(id)) return json(res, 400, { error: "id contains invalid chars" });
        if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar)) return json(res, 400, { error: "env must be SHOUTY_SNAKE_CASE" });
        const entry = {
          id, provider, model,
          tier: tier === "strong" ? "strong" : "weak",
          tags: Array.isArray(tags) ? tags : (typeof tags === "string" ? tags.split(",").map(t => t.trim()).filter(Boolean) : []),
          auth: `env:${envVar}`,
          transports: { generate_new: { url: modelUrl, env: envVar, model } },
        };
        let overlay = { schema_version: 1, agents: [] };
        if (fs.existsSync(LOCAL_PATH)) {
          try {
            const parsed = yaml.load(fs.readFileSync(LOCAL_PATH, "utf-8"));
            if (parsed && Array.isArray(parsed.agents)) overlay = parsed;
          } catch (e) {
            return json(res, 500, { error: `existing ${LOCAL_PATH} unreadable: ${e.message}` });
          }
        }
        const idx = overlay.agents.findIndex((a) => a.id === entry.id);
        if (idx >= 0) overlay.agents[idx] = entry;
        else overlay.agents.push(entry);
        fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true, mode: 0o700 });
        fs.writeFileSync(LOCAL_PATH, yaml.dump(overlay), { mode: 0o644 });
        reloadRegistry();
        console.error(`external-agents ui: add-model ${entry.id} (${idx >= 0 ? "replaced" : "added"})`);
        return json(res, 200, { ok: true, action: idx >= 0 ? "replaced" : "added", id: entry.id });
      } catch (e) {
        return json(res, 400, { error: "invalid json: " + e.message });
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// If PORT is already taken (another `external-agents ui` still running, or
// something else bound to it), fall back to PORT+1, PORT+2, ... instead of
// crashing — a leftover process from a previous session is common here.
// `cmdInit` in cli.js greps this exact "external-agents ui: http://" line to
// learn the REAL bound port before opening the browser, so the string prefix
// must stay unchanged.
const MAX_PORT_ATTEMPTS = 10;
function listenWithRetry(port) {
  // Both listeners must be torn down when the other one wins. `server.listen`'s
  // callback form registers a PERSISTENT 'listening' listener that survives the
  // failed attempt, so a retry chain accumulates one per attempt and they all
  // fire on the bind that finally succeeds — printing a URL line for every port
  // tried, including the ones that were in use. `cmdInit` in cli.js opens the
  // FIRST such line it sees, which would be the stale port.
  const onListening = () => {
    server.off("error", onError);
    console.error(`external-agents ui: http://${HOST}:${port}`);
  };
  const onError = (err) => {
    server.off("listening", onListening);
    if (err.code === "EADDRINUSE") {
      const attemptsSoFar = port - PORT;
      if (attemptsSoFar < MAX_PORT_ATTEMPTS) {
        const next = port + 1;
        console.error(`external-agents ui: port ${port} is in use, trying ${next}...`);
        listenWithRetry(next);
        return;
      }
      console.error(`external-agents ui: could not bind — ports ${PORT}-${port} are all in use.`);
    } else {
      console.error(`external-agents ui: failed to listen on port ${port}: ${err.message}`);
    }
    process.exit(1);
  };
  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port, HOST);
}
listenWithRetry(PORT);
