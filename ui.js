#!/usr/bin/env node
import http from "node:http";
import url from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry } from "./lib/registry.js";
import { readState, writeState, probeInstalled } from "./lib/state.js";

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

// Resolve agents.yaml relative to this file so 'external-agents ui' works from
// any cwd (previously the "./agents.yaml" relative path only worked from the
// package root).
const __ui_dir = path.dirname(new URL(import.meta.url).pathname);
const REGISTRY = loadRegistry(path.join(__ui_dir, "agents.yaml"));
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

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>external-agents</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; margin: 20px; color: #222; background: #fafafa; }
  h1 { margin: 0 0 6px 0; }
  p.hint { color: #666; margin: 0 0 16px 0; }
  button { font: inherit; padding: 6px 12px; border: 1px solid #ccc; background: #fff; border-radius: 4px; cursor: pointer; }
  button:hover { background: #f0f0f0; }
  button.primary { background: #4a90e2; color: #fff; border-color: #3878c0; }
  button.primary:hover { background: #3878c0; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background: #f4f4f4; font-weight: 600; }
  td.state { font-weight: 600; }
  tr.healthy td.state { background: #dcf5e0; color: #1a6b31; }
  tr.quota_exhausted td.state { background: #fff2cc; color: #7a5300; }
  tr.needs_auth td.state, tr.not_installed td.state { background: #fbdad3; color: #9a2b1c; }
  tr.errored_transient td.state { background: #e6e6e6; color: #555; }
  td.note { color: #666; font-size: 12px; }
  td.time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #666; font-size: 12px; }
  .row-controls { display: flex; gap: 16px; align-items: center; margin-bottom: 12px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; background: #e0e0e0; font-size: 11px; color: #444; margin-right: 4px; }
  .badge.free { background: #d4f7d4; color: #216d2c; font-weight: 600; }
  .badge.free::before { content: "$0 "; opacity: 0.8; }

  .unlock {
    background: linear-gradient(135deg, #fff8dc 0%, #fdf2c4 100%);
    border: 1px solid #d4b942;
    border-radius: 6px;
    padding: 16px 18px;
    margin-bottom: 20px;
    box-shadow: 0 2px 8px rgba(212, 185, 66, 0.15);
  }
  .unlock h2 { margin: 0 0 6px 0; font-size: 16px; color: #6b5a12; }
  .unlock h2::before { content: "💰 "; }
  .unlock p.tag { margin: 0 0 12px 0; color: #7a682a; font-size: 13px; }
  .unlock .row {
    display: grid;
    grid-template-columns: minmax(140px, 180px) 1fr auto minmax(220px, 260px) auto;
    gap: 10px;
    align-items: center;
    padding: 10px 0;
    border-top: 1px solid #e5cd6c;
  }
  .unlock input.keyinput {
    padding: 5px 8px;
    border: 1px solid #d4b942;
    border-radius: 3px;
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    background: #fff;
  }
  .unlock button.save {
    padding: 5px 12px;
    background: #216d2c;
    color: #fff;
    border: 1px solid #1a5623;
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
  }
  .unlock button.save:hover { background: #1a5623; }
  .unlock button.save:disabled { background: #999; cursor: default; }
  .unlock .status {
    grid-column: 1 / -1;
    color: #216d2c;
    font-size: 12px;
    padding-top: 4px;
    min-height: 16px;
  }
  .unlock .status.err { color: #a33; }
  .unlock .row:first-of-type { border-top: none; padding-top: 4px; }
  .unlock .row .prov { font-weight: 600; color: #4a3d0e; }
  .unlock .row .desc { color: #6b5a12; font-size: 13px; }
  .unlock .row .env {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    background: rgba(255,255,255,.6);
    padding: 3px 6px;
    border-radius: 3px;
    color: #4a3d0e;
  }
  .unlock .row a.signup {
    color: #216d2c;
    background: #d4f7d4;
    padding: 5px 11px;
    border-radius: 4px;
    text-decoration: none;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  .unlock .row a.signup:hover { background: #b8ebba; }
  .unlock .footer { margin-top: 10px; color: #7a682a; font-size: 12px; font-style: italic; }
</style>
</head>
<body>
<h1>External agents</h1>
<p class="hint">Loopback dashboard for <code>external-agents-spike</code>. Refresh to update state; click <em>Verify</em> per row to run an install-check.</p>

<div id="unlock" class="unlock" style="display:none"></div>
<div class="row-controls">
  <button class="primary" onclick="refresh()">Refresh</button>
  <span id="stamp" style="color:#666;font-size:12px;"></span>
</div>
<table>
<thead>
<tr>
  <th>ID</th><th>Provider</th><th>Model</th><th>Tier</th><th>Tags</th>
  <th>State</th><th>Note</th><th>Last used</th><th>Usage</th><th>Actions</th>
</tr>
</thead>
<tbody id="rows"></tbody>
</table>

<div style="margin-top: 32px; padding: 16px; background: #fff; border: 1px dashed #ccc; border-radius: 4px;">
  <h3 style="margin: 0 0 4px 0; font-size: 15px;">Missing your model?</h3>
  <p style="margin: 0 0 12px 0; color: #666; font-size: 13px;">Suggest a new model or provider &mdash; opens a pre-filled issue on the public tracker at <a href="https://github.com/mrrlin-dev/external-agents/issues" target="_blank" rel="noopener noreferrer">mrrlin-dev/external-agents</a> (also logged locally).</p>
  <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
    <input id="suggest-name" placeholder="Model or provider name (e.g. anthropic/haiku-4-5)" style="flex: 1; min-width: 260px; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font: inherit;">
    <input id="suggest-url" placeholder="Docs / setup URL (optional)" style="flex: 1; min-width: 260px; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font: inherit;">
    <button class="primary" onclick="submitSuggest()">Suggest</button>
  </div>
  <p id="suggest-result" style="margin: 8px 0 0 0; color: #4a8; font-size: 13px; min-height: 18px;"></p>
</div>
<script>
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString() + " · " + d.toLocaleDateString();
}
function renderRows(agents) {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = "";
  for (const a of agents) {
    const tr = document.createElement("tr");
    tr.className = a.state || "healthy";
    const tags = (a.tags || []).map(t => '<span class="badge '+(t==='free'?'free':'')+'">'+t+'</span>').join("");
    const usage = a.usage_url
      ? '<a href="'+a.usage_url+'" target="_blank" rel="noopener" title="'+a.usage_url+'">↗ usage</a>'
      : '—';
    tr.innerHTML =
      "<td>"+a.id+"</td>" +
      "<td>"+(a.provider||"—")+"</td>" +
      "<td>"+(a.model||"—")+"</td>" +
      "<td>"+(a.tier||"—")+"</td>" +
      "<td>"+tags+"</td>" +
      '<td class="state">'+(a.state||"healthy")+"</td>" +
      '<td class="note">'+(a.note||"—")+"</td>" +
      '<td class="time">'+fmtTime(a.last_used_at)+"</td>" +
      '<td>'+usage+'</td>' +
      '<td><button onclick="verify(\\''+a.id+'\\')">Verify</button></td>';
    tbody.appendChild(tr);
  }
  document.getElementById("stamp").textContent = "Loaded " + new Date().toLocaleTimeString();
}
async function submitSuggest() {
  const name = document.getElementById("suggest-name").value.trim();
  const url  = document.getElementById("suggest-url").value.trim();
  const out  = document.getElementById("suggest-result");
  if (!name) { out.textContent = "please enter a model or provider name"; out.style.color = "#a33"; return; }
  out.textContent = "opening GitHub issue…";
  out.style.color = "#666";

  // 1) Fire-and-forget local JSONL record so 'external-agents ui' still has an
  //    audit trail even if the user cancels the GitHub tab.
  fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, url }),
  }).catch(() => { /* non-blocking; the public issue below is the real submit */ });

  // 2) Public path — open a pre-filled New Issue on the external-agents repo.
  //    The registry maintainer picks it up from the public tracker; anyone else
  //    watching the repo can see it too, so proposals are discoverable, not stuck
  //    in a private JSONL.
  const body = [
    "**Model / provider:** " + name,
    "",
    url ? "**Docs / setup URL:** " + url : "**Docs / setup URL:** _(none provided)_",
    "",
    "---",
    "_Submitted via 'external-agents ui' — the local dashboard's \"Missing your model?\" form._",
  ].join("\n");
  const issueUrl =
    "https://github.com/mrrlin-dev/external-agents/issues/new?" +
    "labels=missing-model" +
    "&title=" + encodeURIComponent("Add " + name) +
    "&body=" + encodeURIComponent(body);
  window.open(issueUrl, "_blank", "noopener,noreferrer");

  out.innerHTML = "opened a pre-filled GitHub issue in a new tab — " +
    "just click <b>Submit new issue</b> there. " +
    '(also logged locally as backup)';
  out.style.color = "#4a8";
  document.getElementById("suggest-name").value = "";
  document.getElementById("suggest-url").value = "";
}
// Per-provider signup metadata for the unlock banner. Only providers whose
// entries carry the "free" tag AND may show up in needs_auth appear here.
const PROVIDER_META = {
  groq: {
    label: "Groq",
    pitch: "Fastest inference on the market — ~500-800 tok/s",
    signup: "https://console.groq.com/keys",
    env: "GROQ_API_KEY",
  },
  openrouter: {
    label: "OpenRouter",
    pitch: "One key, 50+ free models (DeepSeek R1, Qwen-Coder, Llama, …)",
    signup: "https://openrouter.ai/settings/keys",
    env: "OPENROUTER_API_KEY",
  },
  cerebras: {
    label: "Cerebras",
    pitch: "~2000 tok/s — fastest on the planet, 30 rpm free",
    signup: "https://cloud.cerebras.ai/platform/keys",
    env: "CEREBRAS_API_KEY",
  },
  google: {
    label: "Google AI Studio",
    pitch: "7 Gemini variants, each with its own free quota bucket",
    signup: "https://aistudio.google.com/apikey",
    env: "GEMINI_API_KEY",
  },
  zai: {
    label: "Z.ai (GLM)",
    pitch: "Free tier for GLM-4.7-flash — a solid Chinese frontier model",
    signup: "https://z.ai/manage-apikey/apikey-list",
    env: "ZAI_API_KEY",
  },
  "ollama-cloud": {
    label: "Ollama Cloud",
    pitch: "gpt-oss 20B/120B via your Ollama account",
    signup: "https://ollama.com/download",
    env: "(configured via the ollama CLI)",
  },
};
function renderUnlock(agents) {
  const box = document.getElementById("unlock");
  // Find free-tagged entries currently in needs_auth
  const missing = agents.filter(a =>
    (a.tags || []).includes("free") && a.state === "needs_auth"
  );
  // Group by provider (unique)
  const providers = [...new Set(missing.map(a => a.provider))];
  if (providers.length === 0) { box.style.display = "none"; return; }
  const rows = providers.map(p => {
    const m = PROVIDER_META[p] || { label: p, pitch: "", signup: "#", env: "?" };
    const count = missing.filter(a => a.provider === p).length;
    return '<div class="row">' +
      '<div><div class="prov">' + m.label + '</div>' +
      '<div style="font-size:11px;color:#8a7532">+' + count + ' model' + (count>1?"s":"") + ' waiting</div></div>' +
      '<div class="desc">' + m.pitch + '</div>' +
      '<div class="env">' + m.env + '</div>' +
      '<a class="signup" href="' + m.signup + '" target="_blank" rel="noopener">Get free key ↗</a>' +
      '</div>';
  }).join("");
  box.innerHTML =
    '<h2>Unlock ' + missing.length + ' more free-tier voice' + (missing.length>1?"s":"") + '</h2>' +
    '<p class="tag">These providers all offer generous free tiers — sign up (60 s, usually no card), set the env var, restart your MCP client. Your dispatch pool gets bigger, round-robin gets deeper, and your bill stays at $0.</p>' +
    rows +
    '<p class="footer">Providers with a paid-per-token model (DeepSeek direct API) are excluded here — they don’t have a free tier.</p>';
  box.style.display = "block";
}
async function saveKey(envName) {
  const inp = document.getElementById("k-" + envName);
  const stat = document.getElementById("s-" + envName);
  const val = (inp.value || "").trim();
  if (!val) { stat.textContent = "empty value"; stat.className = "status err"; return; }
  stat.textContent = "saving..."; stat.className = "status";
  try {
    const r = await fetch("/api/set_credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env_name: envName, value: val })
    });
    const j = await r.json();
    if (r.ok) {
      stat.textContent = "✓ persisted to " + j.persisted_to + ". Restart your MCP client to pick it up.";
      stat.className = "status";
      inp.value = "";
    } else {
      stat.textContent = "error: " + (j.error || r.statusText);
      stat.className = "status err";
    }
  } catch (e) {
    stat.textContent = "network error: " + e.message;
    stat.className = "status err";
  }
}
async function refresh() {
  const r = await fetch("/api/state").then(r => r.json());
  renderUnlock(r.agents);
  renderRows(r.agents);
}
async function verify(id) {
  await fetch("/api/probe?id="+encodeURIComponent(id), { method: "POST" });
  await refresh();
}
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

  if (req.method === "POST" && p === "/api/set_credential") {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", () => {
      try {
        const { env_name, value } = JSON.parse(body || "{}");
        if (!env_name || typeof env_name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(env_name)) {
          return json(res, 400, { error: "invalid env_name" });
        }
        if (!value || typeof value !== "string") return json(res, 400, { error: "missing value" });
        const persisted = loadKeysFile();
        persisted[env_name] = value;
        saveKeysFile(persisted);
        // The RUNNING UI process's env is updated too, though the MCP server
        // is a separate node process — the operator's next MCP call needs a
        // restart to see it. We tell them so in the response.
        process.env[env_name] = value;
        console.error(`external-agents ui: credential persisted for ${env_name} (${value.length} chars)`);
        return json(res, 200, {
          ok: true,
          env_name,
          persisted_to: KEYS_FILE,
          restart_required: "Restart your MCP client (Claude Code / Codex) to pick up the new key.",
        });
      } catch (e) {
        return json(res, 400, { error: "invalid json: " + e.message });
      }
    });
    return;
  }

  if (req.method === "POST" && p === "/api/suggest") {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", () => {
      try {
        const { name, url: docUrl } = JSON.parse(body || "{}");
        if (!name || typeof name !== "string") {
          return json(res, 400, { error: "missing 'name'" });
        }
        // In the standalone spike, we persist locally + log to stderr so operators
        // can see the request. Mrrlin consumers wire this endpoint into the
        // report-issue mechanism (see ADR 0021 § Consumer-side UX affordances).
        const id = "sug-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        const entry = { id, ts: new Date().toISOString(), name: name.trim(), url: (docUrl || "").trim() };
        try {
          const dir = path.join(os.homedir(), ".local/state/external-agents");
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.appendFileSync(path.join(dir, "suggestions.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
        } catch (e) {
          console.error(`external-agents ui: WARN — could not persist suggestion: ${e.message}`);
        }
        console.error(`external-agents ui: suggestion recorded → id=${id} name="${entry.name}"${entry.url ? " url=" + entry.url : ""}`);
        return json(res, 200, { ok: true, id });
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

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.error(`external-agents ui: http://${HOST}:${PORT}`);
});
