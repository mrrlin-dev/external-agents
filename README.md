# @mrrlin-dev/external-agents

[![Install to Claude Code](https://img.shields.io/badge/Install_to-Claude_Code-4a90e2?style=for-the-badge&logo=anthropic&logoColor=white)](#-2-minute-setup)
[![Install to Codex](https://img.shields.io/badge/Install_to-Codex-24292f?style=for-the-badge&logo=openai&logoColor=white)](#-2-minute-setup)
[![One-command install](https://img.shields.io/badge/curl_%7C_bash-one_command-4a8?style=for-the-badge)](#-2-minute-setup)
[![npm](https://img.shields.io/npm/v/@mrrlin-dev/external-agents?style=for-the-badge)](https://www.npmjs.com/package/@mrrlin-dev/external-agents)

**Route work from your coding agent across 20+ free-tier LLMs. Cut your bill 10-100×.**

![architecture: primary agent → external-agents → six free-tier providers, one pool of tokens](docs/hero.png)

Your Google + Groq + Cerebras + OpenRouter + Z.ai + Ollama Cloud free tiers all have **separate quota buckets**. `external-agents` treats them as one pool: round-robin dispatch, cooldown-aware, auto-fallback on 429. Same agentic workload that used to cost $10-100/day on one paid model runs at effectively $0. Also the perfect substrate for [LLM-Council](https://github.com/karpathy/llm-council)-style multi-model panels — `pick_agents` gives you N distinct-provider picks in one call.

---

## 🚀 2-minute setup

```bash
curl -fsSL https://raw.githubusercontent.com/mrrlin-dev/external-agents/main/install.sh | bash
```

That's it. The script installs the package, registers the MCP server with Claude Code + Codex (whichever you have), and opens the local dashboard so you can paste free-tier API keys inline:

![paste-and-save walkthrough — banner → password input → Save → confirmation](docs/ui-walkthrough.gif)

Sign up (60 sec, usually no card), paste, Save, restart your MCP client. Done. **Every new key adds a provider to the round-robin pool.**

<details>
<summary>Or wire it up manually (three commands)</summary>

```bash
npm install -g @mrrlin-dev/external-agents

# Register with whichever host(s) you use
claude mcp add external-agents external-agents-mcp
codex  mcp add external-agents -- external-agents-mcp

# Set up keys
external-agents init      # opens http://127.0.0.1:4711
```

Requires Node ≥ 20. Works on macOS and Linux; Windows via WSL.

</details>

---

## What you get

- **`dispatch(agent_id, prompt)`** — an MCP tool your primary agent calls. Auto-picks a healthy provider, retries on a different one if the first is rate-limited, honors the provider's own reset time (not a made-up 1h default).
- **`pick_agents(n, min_distinct_providers)`** — the primitive for multi-model panels. Fan out 2-4 distinct-provider votes in parallel for jury-style review, self-consistency checks, or your own consensus loop.
- **Local dashboard** — `external-agents init` opens a loopback page where you paste keys inline, see live provider state, and check usage. Loopback only, never over the network, keys stored at `~/.local/state/external-agents/keys.env` (mode 0600).

Your primary agent (Claude Code, Codex, Cursor) gets these as MCP tools automatically after the setup script above.

---

## Providers in the pool (out of the box, 25 agents)

| | | |
|---|---|---|
| **Gemini** (Google AI Studio) | Groq | Cerebras |
| 7 model variants, per-model quota | 30 rpm, ~500-800 tok/s | 30 rpm, ~2000 tok/s |
| **OpenRouter** :free | Z.ai (GLM) | Ollama Cloud |
| 50+ models, 20 rpd, no card | GLM-4.7-flash free | gpt-oss 20B/120B |
| **DeepSeek** | Anthropic Claude | Codex |
| Cheap direct API | Subscription (Opus + Sonnet) | Subscription (GPT-5) |
| **cursor-agent** | **opencode** | **kiro-cli** |
| CLI agentic reviewer | CLI agentic reviewer | AWS Kiro headless |

Missing a provider? [Suggest it](https://github.com/mrrlin-dev/external-agents/issues/new?labels=missing-model) — the built-in UI has a form that opens a pre-filled issue.

---

## Mrrlin uses this

[Mrrlin](https://mrrlin.com) is the platform this was extracted from. Its consensus gate — every design and every PR diff — runs a 4-reviewer panel: GPT + Gemini over MCP + **two dynamic terminal reviewers pulled from this exact pool** every round. Free-tier terminals mean the gate is essentially free to run on every substantial change, and cross-model diversity beats any single-model reviewer.

You don't need Mrrlin's gate to use the pattern. Build your own reviewer panel, self-consistency check, jury-of-N verifier — the primitives are unopinionated.

---

## FAQ

<details>
<summary><b>Do you send my API keys anywhere?</b></summary>

No. Keys live in `~/.local/state/external-agents/keys.env` (mode 0600, loopback-set) and are read into the MCP server's env at startup. Subscription tokens live where the subscription CLI puts them (`codex login`, `claude login`). Nothing is ever transmitted by `external-agents` itself.

</details>

<details>
<summary><b>How does <code>claude mcp add</code> find <code>external-agents-mcp</code>?</b></summary>

`npm i -g` puts a symlink to `external-agents-mcp` on your global bin dir (usually `/opt/homebrew/bin` on macOS, `/usr/local/bin` on Linux). That dir is on your `PATH`. `claude mcp add` writes the literal string `external-agents-mcp` into `~/.claude.json`; when Claude Code starts, it spawns that as a child process — shell PATH resolution finds the binary. No hosting, no daemon, no registry lookup.

</details>

<details>
<summary><b>How does it handle 429s?</b></summary>

Every real call updates state from response headers and error signals. Cooldown honors the provider's own reset time (parsed from `x-ratelimit-reset-*`, `Retry-After`, and error bodies). If Google says "resets in 42h", we wait 42h — not a 1h fallback.

</details>

<details>
<summary><b>Can I use this with just a subscription (no API keys)?</b></summary>

Yes — Codex subscription and Claude subscription are registered as `cli:*` entries. Zero API-key setup for those cases. Free-tier providers stack on top.

</details>

<details>
<summary><b>Is Mrrlin required?</b></summary>

No. `external-agents` is standalone. Mrrlin uses it internally, but the package works for anyone building a multi-model workflow.

</details>

<details>
<summary><b>What about adding a new provider?</b></summary>

~15-line YAML addition — see [docs/adding-a-provider.md](docs/adding-a-provider.md). aider (used for `edit_exists` transport) supports 100+ providers via LiteLLM.

</details>

---

## About Mrrlin

`external-agents` is one piece of [**Mrrlin**](https://mrrlin.com) — an AI orchestration platform for solo developers and small teams. If you like this package, you'll probably like the rest of Mrrlin.

## License

MIT. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
