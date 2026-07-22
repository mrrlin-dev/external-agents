# @mrrlin-dev/external-agents

**One MCP server for every LLM you talk to.**

`external-agents` is a small, opinionated MCP server + CLI that lets your primary coding agent (Claude Code, Codex, Cursor) route work to a pool of secondary LLMs — Gemini, DeepSeek, Grok, OpenRouter, local Ollama, and any CLI-agentic reviewer (cursor-agent, opencode) — through one clean surface, with per-provider auth, cooldowns, round-robin, escalation, and a local statistics dashboard.

> **Part of [mrrlin.com](https://mrrlin.com)** — the AI orchestration platform for developers. `external-agents` is the open-source layer we use internally to power multi-model consensus and cost-efficient atomic execution. Ships MIT so anyone can adopt it standalone.

---

## Why this exists

If you use more than one LLM in your workflow (and by now most people do), you've probably done at least one of these:

- Hand-rolled a shell script that alternates DeepSeek and Gemini for cheap tasks.
- Copy-pasted the same "review this diff" prompt into three CLIs to compare answers.
- Written a wrapper to detect a 429 and retry on a different provider.
- Kept a mental note of which providers are quota-exhausted today.

`external-agents` collapses all of that into **one tool with one config**:

- **Unified dispatch.** `dispatch(agent_id, prompt)` with default transport `generate_new` picks the next healthy provider by round-robin; N parallel `pick_agents` + `dispatch` calls (consumer-composed) fans out to N providers in parallel with cross-model diversity guaranteed.
- **State that heals itself.** Quota exhaustion is detected from live responses and rate-limit headers, cooldown lasts until the *provider's* reset time (not a made-up default), and healthy calls automatically clear stale cooldowns.
- **Auth surfaces you actually have.** Subscription CLI (Codex, Claude), env-var API keys via [`aider`](https://aider.chat) → direct-to-provider through LiteLLM (Gemini, DeepSeek, Grok, OpenRouter, and 100+ more), direct CLI (cursor-agent, opencode, ollama) — pick your credential path per entry, no forced OAuth, no gateway proxy.
- **Statistics that answer your questions.** How many dispatches went to Gemini this week? What did they cost? Which provider is failing the most? All in a local dashboard, no cloud required.

---

## Install

```bash
npm install -g @mrrlin-dev/external-agents
external-agents --version
```

Requires Node ≥ 20. Works on macOS and Linux. Windows via WSL.

---

## Two-minute quickstart

```bash
# 1. See what's available (starts with zero-config defaults)
external-agents status

# 2. Wire an API-key provider (e.g. DeepSeek — sets DEEPSEEK_API_KEY for aider)
external-agents auth deepseek

# 3. Dispatch something (auto-pick + run)
id=$(external-agents pick -n 1)
external-agents dispatch "$id" "Summarize this in one line: <paste any text>"

# 4. See what just happened
external-agents stats
```

Open the local dashboard with `external-agents ui` and you'll get a page like:

![external-agents dashboard](docs/screenshot.png)

---

## Wire into your MCP client

Once installed, add one block to your MCP client config.

**Claude Code** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "external-agents": {
      "command": "external-agents",
      "args": ["mcp", "serve"]
    }
  }
}
```

**Codex Code** (`~/.codex/config.toml`):
```toml
[mcp_servers.external-agents]
command = "external-agents"
args = ["mcp", "serve"]
```

**Cursor** — Settings → MCP → Add server → same command.

Your primary agent now has these low-level tools (build your own exec/review flows on top):

| Tool | What it does |
| --- | --- |
| `pick_agents` | Pick N distinct healthy candidates (round-robin, cooldown-aware). Optional `min_distinct_providers` for diverse fan-out. |
| `dispatch` | Run a specific agent with a prompt. `escalate_to_pro: true` retries on the same provider's strong tier. |
| `probe_agent` | Health-check one provider (cheap prompt). |
| `list_agents` | Registry with live state. |
| `get_state` | Full state file — for building your own dashboard. |
| `get_stats` | Aggregated dispatch metrics from local JSONL. |
| `set_credential` | Store a provider credential via the entry's auth surface. |

**Composition example** — build "review by a panel of 3 diverse providers" client-side:
```
ids  = pick_agents({ n: 3, min_distinct_providers: 3, exclude_ids: [primary] })
outs = Promise.all(ids.map(id => dispatch({ agent_id: id, prompt })))
```
The package is deliberately unopinionated about *what* you compose. Mrrlin uses these primitives for its own `/consensus` gate and atomic-executor loop; your workflow probably has its own vocabulary — that's the whole point.

---

## Supported providers (v0.1.0)

### Free tier — no card required to get started

Most of the pool runs on generous free tiers. **20 agents across 8 providers, 17 of which cost $0** when the request is on the provider's free plan (all get their own quota bucket, so round-robin dramatically extends what you can do without paying).

| Provider | Models | Free tier |
| --- | --- | --- |
| **Google Gemini** (via AI Studio) | 3.5-flash-lite, 3.1-flash-lite, 3.6-flash, 3.5-flash, 3-flash-preview, 3/3.1-pro-preview | ✅ generous per-model quotas |
| **Groq** ⚡ | llama-3.3-70b-versatile, deepseek-r1-distill-llama-70b | ✅ 30 rpm — fastest inference on the market (~500-800 tok/s) |
| **OpenRouter** 🌐 | 50+ models tagged `:free` (deepseek-r1, qwen-coder-32b, llama-3.3-70b, ...) | ✅ 20 rpd free without card |
| **Cerebras** ⚡⚡ | llama3.3-70b, qwen-3-coder-480b | ✅ 30 rpm — ~2000 tok/s (fastest on the planet) |
| **Z.ai** (GLM) | glm-4.7-flash | ✅ free API tier |
| **Ollama Cloud** | gpt-oss:20b-cloud, gpt-oss:120b-cloud | ✅ free with Ollama account |

### Paid tier / per-token

| Provider | Models | Notes |
| --- | --- | --- |
| **DeepSeek** (direct API) | deepseek-chat (Flash), deepseek-reasoner | Very cheap per-token; not on free tier but often <$1/day for atomic-task workloads |
| **Codex** (subscription) | gpt-5.2-codex (primary orchestrator) | Uses your Codex Code subscription; not an API key |

### Direct-CLI agentic (repo-aware reviewers)

- cursor-agent, opencode, Ollama (local, no quota)

Missing a provider? Adding one is a ~15-line YAML addition — see [docs/adding-a-provider.md](docs/adding-a-provider.md). aider (our downstream) supports 100+ providers via LiteLLM.

---

## Config reference

Registry file at `~/.config/external-agents/agents.yaml`:

```yaml
runtime:
  primary_agent: codex              # ignored when there's no orchestrator concept
  review_diversity:
    min_distinct_providers: 3
  max_rounds_default: 3

telemetry_sink:                     # optional: pipe events to your own endpoint
  url: https://your-backend.example/telemetry
  headers:
    Authorization: "Bearer {ENV_TOKEN}"
  batch_size: 50

agents:
  aider-gemini-flash:
    provider: google
    model: gemini-3-flash-preview
    tier: weak
    auth: "env:GEMINI_API_KEY"
    transports:
      generate_new:
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      env: GEMINI_API_KEY
      model: gemini-3-flash-preview
    edit_exists: "aider --model gemini/gemini-3-flash-preview"
  # ... more entries
```

Full schema documented in [docs/registry-schema.md](docs/registry-schema.md).

---

## Local UI

Run `external-agents ui` and a page opens on `http://127.0.0.1:port`. Loopback only — never exposed to the network. Shows:

**💰 "Unlock more free voices" banner at the top** — as long as you have any free-tier provider that hasn't been wired up yet (no env var set), the UI shows a golden banner urging you to sign up. One row per provider with: what it gives you ("Groq: ~500-800 tok/s — fastest on the market"), the exact env var name to set, and a green "Get free key ↗" link to the signup page. **Signup is usually 60 seconds and doesn't ask for a card.** Once you add the key and restart your MCP client, that provider drops from the banner and joins the pool.


- Every registry entry with a live status badge
- **Per-row Usage link** — for each provider that publishes one (Gemini / DeepSeek / OpenAI / Z.ai / Ollama Cloud / ...), a small `↗ usage` link opens the provider's own dashboard so you never have to guess where your billing lives
- Install / auth / verify buttons per state
- **"Missing your model?" panel** — a two-input form (model name + optional docs URL) at the bottom of the table. Submit records your suggestion locally (JSONL). If you're running inside mrrlin, the same submit is intercepted and filed as an actionable task in your inbox
- Statistics tab: dispatches, costs, success rate, per-agent timing
- Config editor with schema validation

Everything the UI does is also available in the CLI — the UI is a convenience, not a requirement.

---

## FAQ

**Do you send my API keys anywhere?**
No. API-key credentials live in env vars only (read by aider at spawn time). Subscription tokens live where the subscription CLI keeps them (`codex login`, `claude login`, ...). `external-agents` never persists or transmits your credentials.

**Do you phone home?**
Not by default. Telemetry writes to a local JSONL file. If you configure `telemetry_sink` in your registry, events go to *your* endpoint — no default sink.

**Is Mrrlin required?**
No. `external-agents` is standalone. Mrrlin uses it internally, but the package works for anyone building a multi-model workflow.

**Can I use this with just a subscription (no API keys)?**
Yes — Codex subscription with `--model` overrides gives you access to cheaper models on the same plan. Same story with Claude when v0.2 lands. Zero API-key setup for those cases.

**How do you avoid rate-limit surprises?**
Every real call updates state from response headers and error signals. Cooldown honors the provider's own reset time (parsed from `x-ratelimit-reset-*`, `Retry-After`, and error bodies). If Google says "resets in 42h", we wait 42h — not a 1h default.

**Why `aider` for API-key providers?**
[aider](https://aider.chat) is a mature (4-year) agentic CLI that talks to 100+ providers directly through [LiteLLM](https://litellm.ai) — no gateway proxy. Every provider is just an env var (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, ...) and a `--model {provider}/{id}` flag. We layer state / round-robin / cooldown on top instead of writing our own provider client for every LLM ourselves.

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

We use MIT + DCO (sign-off in commits), no CLA. Bug reports and provider additions are especially appreciated.

---

## License

MIT. See [LICENSE](LICENSE).

---

## About Mrrlin

`external-agents` is one piece of [**Mrrlin**](https://mrrlin.com) — an AI orchestration platform for solo developers and small teams. Mrrlin uses this package internally to power its multi-model consensus gate and cost-efficient atomic executor, and layers on top of it a Director agent that decides what work to route where.

If you like `external-agents`, you'll probably like the rest of Mrrlin.

---


