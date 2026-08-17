# Adding a Provider

This guide walks you through registering a new LLM provider or model in the `agents.yaml` registry for `@mrrlin-dev/external-agents`. Adding a model allows the local UI, MCP server, and CLI tools to discover it, track its health, and route agentic or generation tasks to it.

## Prereq

Before starting, ensure your local environment is set up for the transport you plan to use:

- **For `edit_exists`**: Install and authenticate the direct agent CLI you want to use (for example, Codex or Claude). The CLI runs in the supplied `cwd`, so it can inspect, edit, and test the project itself. A provider that has no CLI of its own can route through `aider` instead — see [Routing an API-key provider through `aider`](#routing-an-api-key-provider-through-aider).
- **For `generate_new`**: No external CLI is needed. This transport runs a direct, lightweight HTTPS request to an OpenAI-compatible completions endpoint.

## Step 1: Find the provider's endpoint / prefix

To configure the model, you need to identify its identifier and connection strings depending on the target transport:

- **For `edit_exists`**: Verify the CLI's non-interactive command and authentication flow. The command must accept the task prompt as its final positional argument (`aider` is the one exception — it takes `--message`, and the dispatcher supplies it).
- **For `generate_new`**: Locate the provider's OpenAI-compatible base URL in their developer docs. For example, DeepSeek uses `https://api.deepseek.com/v1/chat/completions`. Note down the exact model ID (e.g., `deepseek-chat`).

## Step 2: Add a registry entry to agents.yaml

Open your `agents.yaml` configuration file and append your new agent entry.

```yaml
- id: example-direct-cli
  provider: example
  model: default
  tier: strong
  tags: [agentic]
  auth: "cli:example-agent"
  transports:
    edit_exists: "example-agent --print"

- id: gen-deepseek-chat
  provider: deepseek
  model: deepseek-chat
  quota_scope: shared
  tier: strong
  tags: [cheap, code]
  auth: "env:DEEPSEEK_API_KEY"
  preference_order: 9
  transports:
    generate_new:
      url: "https://api.deepseek.com/v1/chat/completions"
      env: DEEPSEEK_API_KEY
      model: deepseek-chat
```

### Registry Fields Definition

- **`id`**: Unique identifier for this specific provider-model configuration.
- **`provider`**: The lowercase name of the hosting provider.
- **`model`**: The target model ID expected by the provider.
- **`quota_scope`**: Set to `shared` if the rate limits are shared across all models on that provider account, or `individual` if the model has its own dedicated limit bucket.
- **`tier`**: Either `strong` (complex reasoning, coding) or `weak` (fast, lightweight tasks).
- **`tags`**: Metadata array for filtering within the UI and MCP routers.
- **`auth`**: Specifies the environment variable containing the API key (e.g., `env:GROQ_API_KEY`). For custom or complex setups, you can override variables inline:
  ```yaml
  env:
    OPENAI_API_KEY: "@file:~/.claude/state/zai.key"
  ```
- **`preference_order`**: Integer representing the fallback priority. Higher numbers are tried first.
- **`transports`**:
  - `edit_exists`: Command string (or `{ cmd: ... }` map) for a direct agent CLI.
  - `generate_new`: Mapping configuring direct HTTPS requests to an OpenAI-compatible endpoint.

## Step 3: Set the env var

The agent needs the credentials declared in the `auth` or `transports.generate.env` fields. You can export these directly into your environment or apply them via the local UI's settings panel.

```bash
export GROQ_API_KEY="gsk_y0urS3cr3tKeyH3r3..."
export DEEPSEEK_API_KEY="sk-d33ps33kKey..."
```

## Step 4: Verify

Validate that your new registry entry is parsed correctly and that the external-agents daemon can communicate with the provider's endpoint.

```bash
external-agents probe example-direct-cli
```

If successful, the console will print a confirmation showing `state:healthy` alongside latency statistics.

## Step 5: Test dispatch

Run a direct generation test to confirm that the model returns coherent responses over your selected transport.

```bash
external-agents dispatch gen-deepseek-chat "Reply OK if you can read this."
```

The terminal should output the raw response text from the LLM.

## Optional: declare reasoning effort

Reasoning effort is a transport-level capability. Declare it only when you have verified the accepted enum for that exact provider/model path.

`generate_new` example:

```yaml
transports:
  generate_new:
    url: "https://example.com/v1/chat/completions"
    env: EXAMPLE_API_KEY
    model: example-model
    effort_levels: [low, medium, high]
```

`edit_exists` example:

```yaml
transports:
  edit_exists:
    cmd: "codex exec --skip-git-repo-check"
    effort_levels: [low, medium, high, xhigh]
    effort_flag: "-c model_reasoning_effort={level}"
```

Rules:

- Omit `effort_levels` when support is unknown or unavailable.
- Legacy `edit_exists: "some-cli ..."` entries still load unchanged.
- `dispatch --effort` fails loud when the selected transport does not declare the requested level.

## Choosing between transports

| Feature | `edit_exists` (direct CLI) | `generate_new` |
| :--- | :--- | :--- |
| **Iteration** | Excellent (agent can inspect and test `cwd`) | Limited (single shot) |
| **New-file creation** | Good | Excellent (clean write, low latency) |
| **Multi-file edits** | Native | Manual processing required |
| **Tool use** | Native to the CLI | No tool calling (pure text) |

Use `edit_exists` with a direct CLI for codebase edits, tests, and iterative work. Use `generate_new` for fast, single-shot text generation. Attach `files` for `generate_new`, which has no filesystem access; they are optional for `edit_exists` when a `cwd` is supplied.

### Routing an API-key provider through `aider`

A provider that only offers an HTTP endpoint has no CLI of its own, so its
`edit_exists` runs through [`aider`](https://aider.chat), which reaches ~100
providers directly via LiteLLM:

```yaml
    edit_exists:
      cmd: "aider --model groq/openai/gpt-oss-20b"
```

The model id is aider's LiteLLM id (`gemini/…`, `groq/…`, `openrouter/…`,
`deepseek/…`, `ollama_chat/…`), which is *not* always the same string as the
`generate_new` `model:` field. aider reads the provider's conventional env var
(`GROQ_API_KEY`, `OPENROUTER_API_KEY`, …); if your entry authenticates with a
differently-named variable, aider cannot see it and the entry should stay
generation-only.

Two things this transport does differently, both handled by the dispatcher —
do not re-add them to `cmd`:

- **Prompts go through `--message`.** aider reads a positional argument as a
  *filename*, so the usual "prompt as final positional" rule is inverted here.
- **`--file` paths are attached to the aider chat.** aider has no search tool:
  a file that is not in the chat is invisible to it, and it will write a new
  file rather than edit the existing one. Always pass `--file` for an aider
  dispatch, and prefer naming the exact files over hoping it finds them.

aider has no read-only mode; requesting `read_only` on an aider entry is an
error rather than a silent downgrade.

## Declaring `read_only` (for dispatches that must not write)

A `read_only` transport is a THIRD command on an `edit_exists` entry, not a
flag on the existing one — it exists because CLI flags that merely look
non-writing are not proof they are. `claude --print --allowedTools Read,Grep,Glob`
looks read-only and still writes, because `--allowedTools` ADDS permissions on
top of the defaults rather than restricting to them. The command that actually
doesn't write needs its OWN, separately verified, entry:

```yaml
transports:
  edit_exists:
    cmd: "example-agent --print"
  read_only:
    cmd: "example-agent --print --disallowed-tools write,edit,bash"
```

Before trusting a `read_only` cmd, prove it with `external-agents
verify-read-only <agent-id>` — it runs the command against a canary file in a
scratch directory and confirms the file comes back unchanged. A declared but
unverified `read_only` command is the same failure class this axis exists to
catch (see `kiro`'s incident: `edit_exists` trusting only a read-capable tool
silently degraded to printing patches as prose instead of erroring).

### An HTTP-only entry declares `via: generate_new`

An entry with no CLI of its own still has a non-writing path — its own HTTP
transport. Declare it, rather than leaving it implied:

```yaml
transports:
  generate_new:
    url: "https://api.example.com/v1/chat/completions"
    env: EXAMPLE_API_KEY
    model: example-1
  read_only:
    via: generate_new
    verified: by_construction
```

An OpenAI-compatible completion call holds no filesystem handle of any kind, so
there is nothing for a canary probe to exercise — `verify-read-only` returns
`{verified: true, basis: "by_construction"}` for this form without dispatching.

Every `read_only` block must give **exactly one** of `cmd` or `via`, and `via`
accepts only `generate_new`. Neither, both, or `via: edit_exists` fails at
registry load: `via: edit_exists` is precisely the write-capable fallback this
axis exists to prevent.

**There is no implicit fallback.** A `generate_new` entry without a `read_only`
block does NOT satisfy `transport: "read_only"` — it used to, which was
correct but unauditable, because an entry nobody had considered was
indistinguishable from one deliberately cleared for read-only use.
`pick`/`dispatch --transport read_only` error on any entry that does not
declare the capability, and never fall back to a write-capable command.

## Common gotchas

- **CLI invocation**: `edit_exists` passes the task prompt as the command's final positional argument. Verify this contract for a custom CLI before registering it.
- **Model ID Prefixing**: For `generate_new`, use the raw model name expected by the OpenAI-compatible endpoint (e.g., `qwen/qwen3.6-27b`), otherwise the API may return a 404.
- **Quota Scopes**: Setting `quota_scope: shared` tells the router to avoid hammering other models under the same provider if one model returns a `429 Too Many Requests` error. Make sure to set this correctly for providers like Groq or Anthropic where your tier's limits apply across the entire account.
- **Pricing Fields**: Pricing structures (`input_cost_per_m`, `output_cost_per_m`) are deferred to the v1-deferred schema implementation. Do not manually add price fields to your `agents.yaml` entry; they are fetched dynamically.
- **Attached files**: The containment and size limits on `files` protect `generate_new` from reading outside its supplied `cwd`. Do not rely on them to grant a direct CLI filesystem access; pass `cwd` for that.

## When it's more than one entry

Certain providers require multiple entries within `agents.yaml` for what seems like a single model family.

For instance, Google Gemini models have distinct quota buckets for Flash vs. Pro tiers, as well as distinct endpoint characteristics. In these scenarios, declare them as individual agent blocks so the router can gracefully fall back from a rate-limited Pro endpoint to a highly-available Flash endpoint:

```yaml
- id: gen-gemini-2.5-pro
  provider: google
  model: gemini-2.5-pro
  quota_scope: individual
  tier: strong
  # ...

- id: gen-gemini-2.5-flash
  provider: google
  model: gemini-2.5-flash
  quota_scope: individual
  tier: weak
  # ...
```
