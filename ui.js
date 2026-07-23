#!/usr/bin/env node
import http from "node:http";
import url from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, LOCAL_PATH } from "./lib/registry.js";
import { readState, writeState, probeInstalled } from "./lib/state.js";
import { verifyCredential, getStats } from "./lib/dispatch.js";
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
const HOST = process.env.EXTERNAL_AGENTS_UI_HOST || "127.0.0.1";
const PORT = Number(process.env.EXTERNAL_AGENTS_UI_PORT) || 4711;

function stateRows() {
  const state = readState();
  return REGISTRY.agents.map((entry) => ({
    ...entry,
    ...(state[entry.id] || { state: "healthy" }),
  }));
}
function findAgent(id) {
  return REGISTRY.agents.find((a) => a.id === id);
}

// Compute the tile-strip stats. `saved` is a deliberately-conservative estimate:
// we anchor "what would this have cost on a strong closed model" at Claude
// Sonnet 4.5 input+output blended ~$3/M tokens. Every dispatch that hit a free
// provider is counted as tokens_total × $3/M saved. Not marketing spin —
// honestly labeled as "vs Claude Sonnet input" in the UI.
const SAVED_ANCHOR_PER_M = 3.0;
function computeStats() {
  const rows = stateRows();
  const healthy = rows.filter((r) => r.state === "healthy").length;
  const locked  = rows.filter((r) => r.state === "needs_auth").length;
  const s24 = getStats(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const dispatches24 = s24.total || 0;
  const tokensAll = Object.values(s24.by_agent || {})
    .reduce((sum, a) => sum + (a.tokens_in || 0) + (a.tokens_out || 0), 0);
  // We only count "saved" for dispatches that would otherwise cost real money —
  // ie. those that ran on free-tagged agents. Anything else was going to cost
  // something already.
  const freeIds = new Set(rows.filter((r) => (r.tags || []).includes("free")).map((r) => r.id));
  const tokensFree = Object.entries(s24.by_agent || {})
    .filter(([id]) => freeIds.has(id))
    .reduce((sum, [, a]) => sum + (a.tokens_in || 0) + (a.tokens_out || 0), 0);
  const savedUsd = (tokensFree / 1_000_000) * SAVED_ANCHOR_PER_M;
  return {
    healthy_count:  healthy,
    locked_count:   locked,
    total_count:    rows.length,
    dispatches_24h: dispatches24,
    tokens_24h:     tokensAll,
    tokens_free_24h: tokensFree,
    saved_usd_24h:  savedUsd,
    saved_anchor:   SAVED_ANCHOR_PER_M,
    // Per-agent aggregates so the UI can surface last_error inline per row.
    by_agent: s24.by_agent || {},
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
    --panel:    #ffffff;
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
    --bg:#f6f8fa;--panel:#ffffff;--panel-2:#f6f8fa;--border:#d0d7de;--border-2:#e6ebf1;
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
  td.note { color: var(--text-2); font-size: 11.5px; max-width: 320px; }

  /* State — pill + row-rail */
  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 12px;
    font-size: 11px; font-weight: 500;
    font-family: var(--mono);
  }
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

  tr.healthy         td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
  tr.needs_auth      td:first-child,
  tr.not_installed   td:first-child { box-shadow: inset 2px 0 0 var(--err); }
  tr.quota_exhausted td:first-child,
  tr.rate_limited    td:first-child { box-shadow: inset 2px 0 0 var(--warn); }
  tr.errored_transient td:first-child { box-shadow: inset 2px 0 0 var(--info); }
  tr.model_unavailable td:first-child { box-shadow: inset 2px 0 0 var(--text-3); }
  tr.model_unavailable td:not(:first-child) { opacity: 0.55; }

  /* Tags */
  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 10px;
    background: var(--panel-2); border: 1px solid var(--border-2);
    color: var(--text-2); font-size: 10.5px; font-weight: 500;
    margin-right: 3px; font-family: var(--mono);
  }
  .badge.free {
    background: var(--accent-2); border-color: transparent; color: var(--accent);
    font-weight: 600;
  }
  .badge.free::before { content: "$0 "; opacity: 0.7; }

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
      <span class="listening">${HOST}:${PORT}</span>
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
      <p class="label">Dispatches · 24h</p>
      <p class="value" id="s-disp">—</p>
      <p class="foot" id="s-disp-foot">— tokens routed</p>
    </div>
    <div class="stat hero">
      <p class="label">Est. saved · 24h</p>
      <p class="value" id="s-saved">—</p>
      <p class="foot" id="s-saved-foot">vs Claude Sonnet ($3/M)</p>
    </div>
  </section>

  <div id="unlock" class="unlock" style="display:none"></div>

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
        <th data-sort="calls" class="num">Calls 24h</th>
        <th data-sort="tokens" class="num">Tokens 24h</th>
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
  state: ["healthy", "quota_exhausted", "rate_limited", "needs_auth", "not_installed", "errored_transient", "model_unavailable"],
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
    const tags = (a.tags || []).map(t =>
      '<span class="badge ' + (t === 'free' ? 'free' : '') + '">' + t + '</span>'
    ).join("");
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
        '<span class="sub">' + esc(a.model || "—") + '</span>' +
      '</td>' +
      '<td>' + (a.provider || "—") + '</td>' +
      '<td class="tier">' + (a.tier || "—") + '</td>' +
      '<td>' + tags + '</td>' +
      '<td><span class="pill ' + (a.state || "healthy") + '">' + (a.state || "healthy") + '</span>' + errCell + '</td>' +
      '<td class="num ' + (calls === 0 ? 'zero' : '') + '">' + (calls || "—") + '</td>' +
      '<td class="num ' + (tokens === 0 ? 'zero' : '') + '">' + (tokens > 0 ? fmtNum(tokens) : "—") + '</td>' +
      '<td class="num">' + successHtml + '</td>' +
      '<td class="time">' + fmtTime(a.last_used_at) + '</td>' +
      '<td>' + (a.usage_url
        ? '<a href="' + a.usage_url + '" target="_blank" rel="noopener">usage ↗</a>'
        : '<button class="btn" style="height:26px;padding:0 10px;font-size:11px;" onclick="verify(\\'' + a.id + '\\')">verify</button>') +
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

function renderStats(s) {
  document.getElementById("s-healthy").textContent = s.healthy_count;
  document.getElementById("s-healthy-foot").textContent = "of " + s.total_count + " total";
  document.getElementById("s-locked").textContent = s.locked_count;
  document.getElementById("s-locked-foot").textContent =
    s.locked_count > 0 ? "paste a key below to unlock" : "all providers configured";
  document.getElementById("s-disp").textContent = fmtNum(s.dispatches_24h);
  document.getElementById("s-disp-foot").textContent =
    fmtNum(s.tokens_24h) + " tokens routed";
  document.getElementById("s-saved").textContent = fmtUsd(s.saved_usd_24h);
  document.getElementById("s-saved-foot").textContent =
    "vs Claude Sonnet ($" + s.saved_anchor.toFixed(0) + "/M) · " + fmtNum(s.tokens_free_24h) + " free-tier tokens";
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
    pitch: "7 Gemini variants, each with its own free-quota bucket.",
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
};

function renderUnlock(agents) {
  const box = document.getElementById("unlock");
  // Only surface entries that pasting a key will actually unlock. Skip:
  //   - already disabled by the operator (toggle off)
  //   - model_unavailable — key is fine, model just doesn't exist on this account
  const missing = agents.filter(a =>
    (a.tags || []).includes("free") &&
    a.state === "needs_auth" &&
    a.enabled !== false
  );
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
  box.innerHTML =
    '<h2>Unlock ' + missing.length + ' free-tier model' + (missing.length > 1 ? "s" : "") + '</h2>' +
    '<p class="tag">These providers offer generous free tiers — sign up (60s, usually no card), paste the key, restart your MCP client. Your dispatch pool grows and your bill stays flat.</p>' +
    rows;
  box.style.display = "block";
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

async function refresh() {
  const [state, stats] = await Promise.all([
    fetch("/api/state").then(r => r.json()),
    fetch("/api/stats").then(r => r.json()),
  ]);
  renderStats(stats);
  renderUnlock(state.agents);
  renderRows(state.agents, stats.by_agent);
}
async function verify(id) {
  await fetch("/api/probe?id=" + encodeURIComponent(id), { method: "POST" });
  await refresh();
}
document.querySelectorAll("#thead-row th[data-sort]").forEach(th => {
  th.addEventListener("click", () => setSort(th.dataset.sort));
});
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
    return json(res, 200, {
      schema_version: REGISTRY.schema_version,
      agents: stateRows(),
    });
  }

  if (req.method === "GET" && p === "/api/stats") {
    return json(res, 200, computeStats());
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
            // If verify failed specifically because THIS model doesn't exist
            // on the account, mark ONLY the verified agent as model_unavailable
            // (the key itself is fine — sibling entries with different models
            // stay eligible). Any other failure fans out to every entry
            // sharing this provider (bad key = bad key everywhere).
            if (vr.modelUnavailable) {
              patch[vr.agent_id] = {
                state: "model_unavailable",
                note: `provider says model does not exist (HTTP ${vr.status || "?"})`,
                checked: Math.floor(Date.now() / 1000),
              };
              continue;
            }
            for (const a of affected.filter((x) => x.provider === vr.provider)) {
              patch[a.id] = {
                state: "needs_auth",
                note: `verify failed: ${vr.hint || "unknown"}`,
                checked: Math.floor(Date.now() / 1000),
              };
            }
          }
        }
        if (Object.keys(patch).length > 0) writeState(patch);
        const okCount = verifyResults.filter((v) => v.ok).length;
        const failCount = verifyResults.length - okCount;
        console.error(`external-agents ui: set_credential(${env_name}) — re-probed ${affected.length}, verified ${verifyResults.length} providers (${okCount} ok, ${failCount} failed): ${verifyResults.map((v) => v.provider + "=" + (v.ok ? "ok" : "FAIL:" + v.hint)).join(", ")}`);
        return json(res, 200, {
          ok: true,
          env_name,
          persisted_to: KEYS_FILE,
          reprobed: affected.map((a) => a.id),
          verified: verifyResults,
          restart_required: "Restart your MCP client (Claude Code / Codex) so IT reads keys.env too.",
        });
      } catch (e) {
        return json(res, 400, { error: "invalid json: " + e.message });
      }
    });
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && p === "/api/probe") {
    const id = parsed.query.id;
    if (!id || typeof id !== "string") return json(res, 400, { error: "missing id" });
    const entry = findAgent(id);
    if (!entry) return json(res, 404, { error: `unknown agent: ${id}` });
    const result = probeInstalled(entry);
    const checked = Math.floor(Date.now() / 1000);
    writeState({ [id]: { ...result, checked } });
    return json(res, 200, { id, ...result, checked });
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

server.listen(PORT, HOST, () => {
  console.error(`external-agents ui: http://${HOST}:${PORT}`);
});
