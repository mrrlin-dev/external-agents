# @mrrlin-dev/external-agents

**Cut your LLM bill by 10-100x by fanning work across free tiers of a dozen providers.**

`external-agents` is an MCP server + CLI that routes work from your primary coding agent (Claude Code, Codex, Cursor) to a **pool of 20+ free-tier LLMs** — Gemini, Groq, Cerebras, OpenRouter :free, Z.ai, Ollama Cloud, and paid tiers of DeepSeek — via one clean surface: round-robin, cooldown-aware, auto-fallback on 429, with a local dashboard for setting keys and tracking usage.

**The core value is economic.** You have separate free-tier quotas at Google + Groq + Cerebras + OpenRouter + Z.ai. `external-agents` treats them as **one pool of tokens** and dispatches to the next healthy bucket. What used to be one 30-req/min Gemini limit is now ~150 req/min across five providers, all at $0 — enough to run entire agentic loops (implementations, reviews, refactors) that would burn $10-100/day on a single paid model.

**It's also the substrate for LLM-consensus** — the "ask N different models the same question, adjudicate" pattern popularized in [LLM-as-a-Judge](https://arxiv.org/abs/2306.05685) work and echoed frequently by [Andrej Karpathy](https://x.com/karpathy) as an "LLM Council" idea: an ensemble of frontier models routinely beats any single one. `pick_agents` gives you N distinct-provider picks in one call, so a "fleet of subagents deliberating in parallel" is one primitive away. **[Mrrlin](https://mrrlin.com) uses exactly this** — its consensus gate resolves two dynamic terminal reviewers from this pool every round, so every design and every diff gets stress-tested by different model families before it merges.

Beyond savings and consensus, you also get the zoo-manager niceties: per-provider auth, cooldowns keyed to the *provider's* reset time (not a made-up default), quota tracking in a local JSONL, and a config-free `status` view of who is healthy right now.

> **Part of [mrrlin.com](https://mrrlin.com)** — the AI orchestration platform for developers. `external-agents` is the open-source layer we use internally for cost-efficient atomic execution and multi-model consensus. Ships MIT so anyone can adopt it standalone.

---

## Why this exists — the money argument first

If you're paying for a single frontier model to do everything (planning, atomic edits, reviews, unit-test scaffolding, docstrings), you're leaving a **lot** of money on the table:

- **Free-tier quotas stack.** Google gives you generous Gemini quotas. Groq gives you 30 rpm Llama 3.3 70B at 500-800 tok/s. Cerebras gives you 30 rpm at ~2000 tok/s. OpenRouter gives you 20 rpd of `:free`-tagged frontier models with no card. Z.ai gives you GLM-4.7-flash. Ollama Cloud gives you gpt-oss:120b. Each of these has a *separate* bucket — `external-agents` treats them as one pool, so effective throughput is Σ(free-tier limits).
- **Round-robin, not "always pick the smartest".** Weak-tier atomic tasks (rename, refactor, write test, fix lint) don't need frontier reasoning; they need a competent model that's currently under quota. `pick --tier weak` finds one; escalation to strong-tier only fires when a task genuinely fails twice.
- **Fallback is automatic.** A 429 on Groq flips you to Cerebras without a retry loop in your code. The exhausted provider is marked with the reset time the provider itself reports in headers (not a 1-hour fallback), so you don't waste calls probing it.
- **Consensus is cheap.** Fan `pick_agents --n 4 --min-distinct-providers 4` and dispatch in parallel — four independent verdicts across four provider families, all on free-tier buckets, in the wall-time of the slowest one.

The net effect for us has been **10-100x reduction** in per-task cost for the atomic-executor workload that used to run on a single paid model. Your mileage varies with task mix, but the direction is the same for anyone who fans work out.

### What else you get (the zoo-management layer)

- **Unified dispatch.** `dispatch(agent_id, prompt)` runs a specific agent; `pick_agents` picks N healthy candidates by round-robin with cross-provider diversity guaranteed.
- **State that heals itself.** Quota exhaustion detected from live responses + rate-limit headers; cooldown honors the *provider's* reset time; healthy calls auto-clear stale cooldowns.
- **Auth surfaces you actually have.** Subscription CLI (Codex, Claude), env-var API keys via [`aider`](https://aider.chat) → direct-to-provider through LiteLLM (100+ providers, no gateway proxy), direct CLI (cursor-agent, opencode, ollama).
- **Statistics that answer your questions.** How many dispatches went to Gemini this week? What did they cost? Which provider is failing the most? Local JSONL log + dashboard, no cloud required.

### LLM-consensus — the multi-model panel, made trivial

Ask several distinct LLMs the same thing and pick the majority answer — an ensemble of frontier models routinely beats any single one. This pattern shows up as [LLM-as-a-Judge](https://arxiv.org/abs/2306.05685) benchmarks, "LLM Council" experiments, [self-consistency decoding](https://arxiv.org/abs/2203.11171), and Karpathy's [recurring observation](https://x.com/karpathy) that mixed panels are strong. But it works only if you can (a) reach N different providers cheaply and (b) fan out in parallel. `external-agents` gives you both:

```
ids  = pick_agents({ n: 3, min_distinct_providers: 3, exclude_ids: [primary] })
outs = Promise.all(ids.map(id => dispatch({ agent_id: id, prompt })))
// three distinct-provider verdicts, ~$0, in one wall-clock round.
```

**Mrrlin's consensus gate does exactly this.** Every design/spec and every PR diff goes through a 4-reviewer panel — GPT + Gemini (over MCP) + two dynamic terminal reviewers resolved from this pool (`external-agents pick --n 2 --min-distinct-providers 2 --exclude-providers openai,google`). The primary coding agent commits a blind verdict first, then adjudicates the panel. Free-tier terminals mean the gate is essentially free to run on every substantial change.

You don't need Mrrlin's gate to use the pattern — the primitives are unopinionated. Build your own reviewer panel, self-consistency check, jury-of-N verifier, whatever fits.

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

Open the local dashboard with `external-agents ui` (see the [UI section](#local-ui) below).

---

## Wire into your MCP client

Once installed, add one block to your MCP client config.

The package ships a dedicated `external-agents-mcp` binary — the MCP server entry — so client configs are plain command lines with no args. **Both Claude Code and Codex expose a one-liner** for this; you should never have to hand-edit config files unless you want to.

**How the client finds it.** `npm i -g @mrrlin-dev/external-agents` puts two symlinks on your global bin directory (`/opt/homebrew/bin`, `/usr/local/bin`, or wherever your Node global-bin lives) — `external-agents` (the CLI) and `external-agents-mcp` (the MCP server). Because that directory is on your `PATH`, running `external-agents-mcp` from any shell just works. `claude mcp add external-agents external-agents-mcp` stores the literal string `external-agents-mcp` in `~/.claude.json`; when Claude Code starts, it spawns that as a child process the same way your shell would, and shell PATH resolution finds the binary. No hosting, no registry lookup, no daemon. If you skipped the `npm i -g` step, `claude mcp add` succeeds but the server fails at startup with "command not found" — install first.

### Claude Code

```bash
claude mcp add external-agents external-agents-mcp
```

(Uses the native `claude mcp add <name> <command>` — the CLI writes the block into `~/.claude.json` for you and Claude Code picks it up on next start.)

### Codex

```bash
codex mcp add external-agents -- external-agents-mcp
```

(Uses the native `codex mcp add <name> -- <command>` — the CLI writes `[mcp_servers.external-agents]` into `~/.codex/config.toml`.)

### Cursor

Settings → MCP → Add server → command `external-agents-mcp`, no args.

### Manual (any other client)

If your MCP client doesn't have a one-liner, the config block is:

```json
{
  "mcpServers": {
    "external-agents": {
      "command": "external-agents-mcp",
      "args": []
    }
  }
}
```

or TOML equivalent:

```toml
[mcp_servers.external-agents]
command = "external-agents-mcp"
args = []
```

No publishing step — the MCP server is just `external-agents-mcp` on your PATH once you `npm i -g @mrrlin-dev/external-agents`. Nothing to host, nothing to expose over the network; it's a stdio-transport MCP server that runs locally, same as any other npm-installed CLI.

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
The package is deliberately unopinionated about *what* you compose. Mrrlin uses these primitives for its own consensus gate and atomic-executor loop; your workflow probably has its own vocabulary — that's the whole point.

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

## Local UI — setting up API keys the easy way

```bash
external-agents ui
# → external-agents ui: http://127.0.0.1:4711
```

Loopback dashboard (never exposed to the network). Two things you want it for:

### 1) Golden banner — sign up + paste key inline

For every free-tier provider that's currently `needs_auth` (no env var set), a golden row appears at the top with:

- What the provider gives you ("Groq: ~500-800 tok/s — fastest on the market"; "Cerebras: ~2000 tok/s, 30 rpm free"; "OpenRouter: 50+ models tagged `:free`"; …)
- A green **"Get free key ↗"** link that opens the provider's signup page in a new tab. Signup is usually 60 seconds and does not ask for a card.
- **A password input + Save button** — paste the key here and click Save. It persists to `~/.local/state/external-agents/keys.env` (mode 0600, loopback only, never sent anywhere). Enter also submits.

Once saved, restart your MCP client (Codex / Claude Code) so `external-agents-mcp` re-reads `keys.env` at startup. The provider drops from the banner and joins the pool.

### 2) Registry table + Missing-your-model form

- Every registry entry with a live status badge (healthy / needs_auth / quota_exhausted / rate_limited / not_installed)
- Per-row Verify button (re-probes the entry) + Usage link (opens the provider's own billing dashboard for entries that publish one — Gemini, DeepSeek, Z.ai, Ollama Cloud, …)
- "Missing your model?" form at the bottom — submits a pre-filled GitHub issue on [`mrrlin-dev/external-agents/issues`](https://github.com/mrrlin-dev/external-agents/issues) with label `missing-model`, so requests are visible + trackable (and also logged locally as backup)

### CLI equivalent (if you prefer scripting)

Every UI action has a CLI equivalent. To set a key without opening the browser:

```bash
# arg form (bash-history exposed — fine for scripts)
external-agents set-credential CEREBRAS_API_KEY csk-…

# stdin form (nothing in bash-history)
pbpaste | external-agents set-credential CEREBRAS_API_KEY -

# interactive form (typed prompt)
external-agents set-credential CEREBRAS_API_KEY
```

All three paths write to the same `~/.local/state/external-agents/keys.env` — pick whichever is comfortable.

### One-minute walkthrough

```
1. external-agents ui                       # opens http://127.0.0.1:4711
2. Golden banner shows 3 unlockable providers (Groq, OpenRouter, Cerebras)
3. Click "Get free key ↗" on Groq → console.groq.com opens, sign up, copy key
4. Paste key into the row's input, click Save → "✓ persisted to keys.env"
5. Repeat for OpenRouter, Cerebras
6. Restart your MCP client (Codex/Claude Code) — banner shrinks, pool grows

Total time: ~3 minutes. Result: 7 more free-tier agents active in `pick`.
```

_(TODO: an animated GIF walkthrough belongs here — see [issue #<TBD>](https://github.com/mrrlin-dev/external-agents/issues) for the recording task.)_

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


