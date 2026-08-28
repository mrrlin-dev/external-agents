# Reasoning Effort

`--effort` sets how much reasoning the model spends before answering.
It is a best-effort quality hint, not a gate.
If the target agent does not declare the requested level, the level is dropped and the dispatch proceeds normally.

## When to use it

Use `high` for planning, design, architecture, and review.
Those are tasks where the reasoning is the deliverable, so extra thinking usually improves the result.

Omit `--effort` for mechanical edits, lookups, formatting, and short factual questions.
On those jobs it mostly adds latency and token usage without improving the answer.

`high` is the safe default for quality-critical work.
It is the one level supported by every agent that supports effort at all.

## Levels

Provider vocabularies differ and there is no canonical mapping.
`external-agents` passes the level through as written.

Levels above `high` exist only on some agents.
Requesting them narrows the usable pool, so use them only when you specifically want those agents.

| Agents | Levels |
|---|---|
| `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `kiro` | low, medium, high, xhigh, max |
| `codex` | low, medium, high, xhigh |
| `codex-gpt-5.6-luna` | none, minimal, low, medium, high, xhigh, max |
| `openrouter-*` (Nemotron, MiniMax M3, GLM 5.2, Dots 3, Laguna S 2.1, North Mini Code) | none, minimal, low, medium, high, xhigh, max |
| `gemini-*` | none, minimal, low, medium, high |
| `groq-gpt-oss-120b`, `groq-gpt-oss-20b` | none, default, low, medium, high |
| `groq-qwen3.6-27b` | none, default |
| `ollama-gpt-oss-20b`, `ollama-gpt-oss-120b` | none, low, medium, high, max |
| `deepseek-chat`, `deepseek-reasoner` | high, max (documented; `high` is DeepSeek's own default) |
| `cursor-agent`, `opencode` | not supported |

## How to check support

Use `pick --effort <level>` to list only agents that declare that level:

```bash
external-agents pick --effort high
external-agents pick --tier strong --effort high
```

The source of truth is `effort_levels` in `agents.yaml`.
If an agent or transport does not declare `effort_levels`, effort is unsupported there.

## Delivery shapes per agent

When you add or maintain a provider, declare the transport shape that matches the real endpoint or CLI.
See [adding-a-provider.md](./adding-a-provider.md) for the registry details.

- Top-level `reasoning_effort` request body field: Gemini, Groq, Ollama, DeepSeek.
- Nested `reasoning: { effort }` request body field: OpenRouter.
- `--effort <level>` CLI flag: Claude CLI, Kiro.
- `-c model_reasoning_effort=<level>` CLI flag: Codex.
- The direct CLI's native flag, recorded in `effort_flag`, for `edit_exists`.

## Examples

Planning or architecture review:

```bash
external-agents dispatch deepseek-reasoner --effort high \
  "Review this migration plan and point out rollout risks."
```

Find strong-tier agents that support effort:

```bash
external-agents pick --tier strong --effort high
```

Mechanical task with no effort hint:

```bash
external-agents dispatch gemini-2.5-flash \
  "Reformat this JSON and keep the values unchanged."
```
