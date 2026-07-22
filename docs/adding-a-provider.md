# Adding a Provider

This guide walks you through registering a new LLM provider or model in the `agents.yaml` registry for `@mrrlin-dev/external-agents`. Adding a model allows the local UI, MCP server, and CLI tools to discover it, track its health, and route agentic or generation tasks to it.

## Prereq

Before starting, ensure your local environment is set up for the transport you plan to use:

- **For the `aider` transport**: This transport runs iterative, multi-file agentic loops. It requires the `aider` CLI to be globally available. Install it using `uv`:
  ```bash
  uv tool install aider-chat
  ```
- **For the `generate` transport**: No external dependencies are needed. This transport runs direct, lightweight HTTPS requests to any OpenAI-compatible completions endpoint.

## Step 1: Find the provider's endpoint / prefix

To configure the model, you need to identify its identifier and connection strings depending on the target transport:

- **For `aider`**: Aider utilizes LiteLLM under the hood. Locate your provider's prefix format in the [Aider LLM Documentation](https://aider.chat/docs/llms.html). For example, Groq models use the prefix `groq/`, while OpenRouter uses `openrouter/`.
- **For `generate`**: Locate the provider's OpenAI-compatible base URL in their developer docs. For example, DeepSeek uses `https://api.deepseek.com/v1/chat/completions`. Note down the exact model ID (e.g., `deepseek-chat`).

## Step 2: Add a registry entry to agents.yaml

Open your `agents.yaml` configuration file and append your new agent entry.

```yaml
- id: aider-groq-llama-3.3-70b
  provider: groq
  model: llama-3.3-70b-versatile
  quota_scope: shared
  tier: weak
  tags: [quick, fast, free]
  auth: "env:GROQ_API_KEY"
  preference_order: 8
  usage_url: "https://console.groq.com/settings/usage"
  transports:
    cli: "aider --model groq/llama-3.3-70b-versatile"

- id: gen-deepseek-chat
  provider: deepseek
  model: deepseek-chat
  quota_scope: shared
  tier: strong
  tags: [cheap, code]
  auth: "env:DEEPSEEK_API_KEY"
  preference_order: 9
  transports:
    generate:
      url: "https://api.deepseek.com/v1/chat/completions"
      env: DEEPSEEK_API_KEY
      model: deepseek-chat
```

### Registry Fields Definition

- **`id`**: Unique identifier for this specific provider-model-transport configuration.
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
  - `cli`: Command string to launch the agentic loop via aider.
  - `generate`: Mapping configuring direct HTTPS requests to an OpenAI-compatible endpoint.

## Step 3: Set the env var

The agent needs the credentials declared in the `auth` or `transports.generate.env` fields. You can export these directly into your environment or apply them via the local UI's settings panel.

```bash
export GROQ_API_KEY="gsk_y0urS3cr3tKeyH3r3..."
export DEEPSEEK_API_KEY="sk-d33ps33kKey..."
```

## Step 4: Verify

Validate that your new registry entry is parsed correctly and that the external-agents daemon can communicate with the provider's endpoint.

```bash
external-agents probe aider-groq-llama-3.3-70b
```

If successful, the console will print a confirmation showing `state:healthy` alongside latency statistics.

## Step 5: Test dispatch

Run a direct generation test to confirm that the model returns coherent responses over your selected transport.

```bash
external-agents dispatch gen-deepseek-chat "Reply OK if you can read this."
```

The terminal should output the raw response text from the LLM.

## Choosing between transports

| Feature | `aider` | `generate` |
| :--- | :--- | :--- |
| **Iteration** | Excellent (interactive, git-aware loops) | Limited (single shot) |
| **New-file creation** | Good | Excellent (clean write, low latency) |
| **Multi-file edits** | Supported out-of-the-box | Manual processing required |
| **Tool use** | Native via agent command line | No tool calling (pure text) |

Choose `aider` when you want an agent to interactively edit codebases, run tests, and fix bugs. Choose `generate` for fast, zero-dependency generation jobs where you simply need text or a single file generated from scratch without overhead.

## Common gotchas

- **Model ID Prefixing**: When using `aider` (via LiteLLM), you often need prefixes like `groq/llama-3.3-70b-versatile` in the `cli` execution string. However, for the `generate` transport, you must use the raw model name expected by the OpenAI-compatible endpoint (e.g., `llama-3.3-70b-versatile`) in the `model` parameter, otherwise the API will return a 404.
- **Quota Scopes**: Setting `quota_scope: shared` tells the router to avoid hammering other models under the same provider if one model returns a `429 Too Many Requests` error. Make sure to set this correctly for providers like Groq or Anthropic where your tier's limits apply across the entire account.
- **Pricing Fields**: Pricing structures (`input_cost_per_m`, `output_cost_per_m`) are deferred to the v1-deferred schema implementation. Do not manually add price fields to your `agents.yaml` entry; they are fetched dynamically.
- **Aider's SEARCH/REPLACE limits**: The `aider` transport relies heavily on search-and-replace blocks. If you are generating a brand-new file from scratch, aider may occasionally fail if there is no pre-existing code to target. Use the `generate` transport to bootstrap empty files, then hand them off to `aider` for iterative edits.

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