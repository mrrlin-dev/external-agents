# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.38.0] - 2026-08-10

### Changed

- **Every `read_only` capability is now declared explicitly.** An entry with a `generate_new` transport used to satisfy a `read_only` request without declaring anything — true (an HTTP completion call holds no filesystem handle) but unauditable: an entry nobody had considered looked exactly like one deliberately cleared for read-only use. The 17 HTTP-only entries now carry `read_only: { via: generate_new, verified: by_construction }`, and the implicit fallback is gone — requesting `read_only` on an entry that does not declare it is an error. **This is a breaking change for a caller that relied on the implicit fallback for a hand-authored `agents.local.yaml` entry**; add the block above to it.
- A `read_only` block must declare exactly one of `cmd` (a distinct no-write CLI invocation, proven per-entry by `verify-read-only` against a canary) or `via: generate_new`. Neither, both, or `via` pointing at any other transport is rejected at registry load rather than at dispatch time — `via: edit_exists` in particular is the write-capable fallback this axis exists to prevent.
- `verify-read-only` returns `{verified: true, basis: "by_construction"}` for a `via: generate_new` entry without running a canary probe. There is no filesystem handle to exercise, so a probe would prove nothing the transport's shape does not already.

### Added

- Verified `read_only` transports for the 14 entries that previously declared only a write-capable `edit_exists`: `cursor-agent` and all 11 `agy-*` entries via their own `--mode plan`, `codex` and `codex-gpt-5.4-mini` via `--sandbox read-only`. Each was checked individually with `external-agents verify-read-only`. `opencode` is still uncovered — the binary on the test machine does not match the CLI its registry entry documents, so no `read_only` command could be written honestly.
- `edit_exists` is back on the 15 HTTP-only entries where it can be routed through `aider` (Google, DeepSeek, Groq, OpenRouter, Ollama Cloud). Live-verified end to end on one entry per provider bucket. The two `google2` entries are deliberately excluded: aider reads `GEMINI_API_KEY`, and the registry has no way to bind that name to the second key's `GEMINI_API_KEY_2`.

### Fixed

- The aider lane works again, and 0.33.4's blanket migration error is gone. It never failed because of aider: the old command passed `--no-git` and attached no files, so aider opened with an empty chat and the model could only ask for the file contents back — every such dispatch exited 0 having changed nothing. The prompt was also appended as a positional, which aider reads as a *filename*. Prompts now go through `--message`, `--file` paths are attached as the files aider may edit, and `--no-git` is gone.
- A dispatched aider no longer dirties the caller's worktree. It used to append `.aider*` to the repo's `.gitignore` and leave `.aider.chat.history.md`, `.aider.input.history` and `.aider.tags.cache.v4/` behind — a worktree the caller is required to hand back clean. History files are redirected to a temp dir and `--no-gitignore` / `--map-tokens 0` suppress the rest.
- A dispatched aider no longer opens browser tabs on the operator's desktop. `offer_url` asks "Open documentation url for more info?" on a quota error, a model warning or a version bump, and `--yes-always` answered *yes*. `--no-show-release-notes` and `--no-detect-urls` remove the prompts; `BROWSER=true` in the child env neutralises any remaining `webbrowser.open`.
- A CLI dispatch that exits 0 having printed nothing and changed nothing is now a failure, on every CLI transport. `kiro` does exactly this when it is quota-gated — it was reporting `outcome: success` with empty output and no files, the same silent-success class the `read_only` axis was introduced to stop. It now reports `quota_exhausted`. Whitespace-only output counts as empty; any real answer, however short, is left alone.
- aider exits 0 even when the provider call failed outright — a Gemini 429 printed `litellm.RateLimitError` and still reported `outcome: success`. A run that changed no file *and* printed a provider error is now re-coded as a failure, so the existing classifier can see it (that dispatch now reports `quota_exhausted`). A zero-diff run with no error is still a success: answering a question without editing is legitimate.

## [0.36.0] - 2026-08-09

### Added

- `POST /api/add_provider_key` and a matching "+ Add another key" panel in `external-agents ui`: lets an operator register a second (third, ...) API key for a provider they already use. Every `env:*`-auth base provider (Google AI Studio, Groq, DeepSeek, OpenRouter, Cerebras, Z.ai, ...) is eligible. The new key's models are cloned under a numbered provider slug (`google` → `google2` → `google3`, ...) with a derived env-var name (`GEMINI_API_KEY_2`), so the second key is an independently-quota'd sibling `pick`'s `min_distinct_providers` already treats as diverse — not a silent overwrite of the first. The raw secret is written only to `keys.env`, under the new derived name; `agents.local.yaml` only ever stores the env-var name.
- `POST /api/remove_provider_key`, with a removable "×" chip per numbered key in the same panel — the inverse of the above. Refuses to touch a canonical (non-numbered) base outright; a bundled/hand-authored provider was never created by this endpoint and isn't something it can safely undo.
- `lib/registry.js`: `CANONICAL_BASES(registry)`, `nextProviderSlot(registry, baseProvider)`, and `withLocalOverlayLock(mutatorFn)` — the shared primitives behind both endpoints (and `cmdAddModel`, which now goes through the same lock for cross-process safety with the UI).
- Two Google AI Studio entries (`gemini-3.6-flash`, `gemini-3.1-pro-preview`, the latter disabled by default) trimmed down from five variants — redundancy against Google's quota gate now comes from adding another key via the panel above, not from registering more models under the same key.
- A second, independent Google AI Studio key/project (`google2`, `GEMINI_API_KEY_2`) and 11 Antigravity CLI (`agy`) entries (Gemini, Claude, and gpt-oss variants reachable through the `agy` CLI, `provider: antigravity`) — both confirmed live to be genuinely independent quota pools from the primary `google`/`claude` entries.
- The dismissable "API keys" / "CLI setup" / "Unlock" banner panels in `external-agents ui` are now individually collapsible, with the collapsed/expanded state persisted per-panel in the browser's `localStorage`.

### Fixed

- `classifyCliFailure`'s quota-exhaustion detection didn't recognize Antigravity CLI's own wording ("Individual quota reached..."), so every `agy-*` 429 misclassified as a generic `errored_transient` — no `reset_at`/cooldown got recorded, so `pick()`'s cooldown-skip never applied, and the dashboard showed what looked like an unexplained error instead of a normal (if multi-day) quota cooldown. Confirmed via a full live `external-agents audit` across the entire registry before and after the fix.
- `renderUnlock`'s free-tier "Unlock" banner filter only excluded a provider's own numbered siblings, not the reverse: a numbered sibling with a working key didn't stop its *base* provider from still appearing in the banner. The filter is now bidirectional — a family (base + numbered siblings) is hidden from "Unlock" once ANY member is verified, and picked up by the new "API keys" panel instead.

## [0.35.0] - 2026-08-06

### Added

- New `read_only` transport kind, alongside `edit_exists`/`generate_new`. A `read_only` command is a distinct, separately-declared CLI invocation — never the `edit_exists` command with a hopeful instruction appended, and never trusted on the strength of its flags looking non-writing (`claude --print --allowedTools ...` looks read-only and still writes: `--allowedTools` only adds permissions, it never restricts them). `dispatch --transport read_only` / `pick --transport read_only` select a declared `read_only` command, or an implicit `generate_new` (an HTTP completion call has no filesystem access at all). Requesting `read_only` on an entry that declares neither is a hard error — it never silently falls back to a write-capable command.
- `external-agents verify-read-only <agent-id>` — runs an entry's declared `read_only` command against a canary file in a scratch directory and confirms the file comes back unchanged. Exits non-zero unless verified. This is the acceptance check every `read_only` entry in this registry was required to pass before being declared.
- Declared and verified `read_only` commands for `kiro` (`--trust-tools=fs_read`, the CLI's original — and, per the fix below, no longer default — invocation) and for `claude-opus-4-8`, `claude-sonnet-5`, and `claude-haiku-4-5` (`--disallowedTools Write,Edit,NotebookEdit,Bash`). The three Claude entries' `read_only` commands do not declare `effort_levels`: their command ends in a trailing `--`, and `runDispatch` inserts the effort flag AFTER the full command — including that `--` — which was confirmed to swallow the prompt entirely rather than erroring loudly. Do not add effort support there until that interaction is fixed and independently verified.
- `~/.codex/scripts/consensus.sh` now picks and dispatches every reviewer with `--transport read_only`. Reviewers run in the live repo under review (`cd "$cwd"` there is unchanged); before this, only a prompt instruction ("Do not edit files") stood between a reviewer and the repo it was judging — the same class of unenforced constraint the kiro incident showed does not bind tool access.

### Fixed

- `kiro`'s `edit_exists` transport trusted only `fs_read`, so the agent could read the working directory but never write to it. It did not fail — it printed the patch as text and exited 0 with no files touched, which the dispatcher reported as `success` with `files: []`. The trust list now covers `fs_read,fs_write,execute_bash`, matching what the `edit_exists` transport promises.
- `pick`'s `--transport` filter checked for a literal transport key, which meant `--transport read_only` would have excluded every `generate_new`-only entry even though HTTP transports are read-only by construction. It now recognizes that implicit case, matching `dispatch`'s `selectTransport`.

## [0.34.0] - 2026-08-04

### Added

- `external-agents toggle <agent-id> --enabled|--disabled` — flips the same kill switch as the local dashboard's `POST /api/toggle`, so a caller never needs the dashboard's HTTP server just to enable or disable an agent. Deep-merges the persisted entry, keeping `state`, `note`, `checked` and `last_used_at` intact across the flip.
- `agents.yaml` entries may now declare optional `signup_url`, `docs_url`, and `free_tier { description, limits, card_required }`, surfaced in `status --json` for consumers that want to explain a provider's free tier rather than just tag it `free`. Populated for all 28 bundled entries.

## [0.33.5] - 2026-08-04

### Fixed

- Attached files outside the requested `cwd` now fail the dispatch clearly instead of being silently omitted from model context.
- A successful HTTP response with empty completion content is now reported as an error rather than a misleading successful dispatch.
- HTTP dispatch timeouts remain active until the full response body is read, preventing providers that send headers but stall the body from hanging indefinitely.
- Timed-out direct CLI dispatches terminate their whole process group, preventing descendant processes from surviving the timeout.

## [0.33.4] - 2026-08-04

### Changed

- When `cwd` is supplied, dispatch now prefers an available direct-CLI `edit_exists` transport. Without `cwd`, `generate_new` remains the default when available; explicit transport selection still overrides both.
- Clarified that `cwd` does not give `generate_new` filesystem access: use `files` to attach repository context.
- Removed aider-backed `edit_exists` declarations from bundled HTTP-only entries; callers that explicitly selected that transport must choose a bundled direct-CLI agent instead. Custom `aider` commands now fail with a migration error; replace them with the direct CLI for the chosen agent.

### Fixed

- Direct CLI output is normalized before it is returned or classified, so terminal ANSI sequences do not interfere with auth and quota diagnostics.

## [0.33.3] - 2026-08-03

### Fixed

- Expired `quota_exhausted`, `rate_limited`, and cooldown-backed transient rows now show as `need_check` in the dashboard instead of looking permanently stuck on a past `until ...` timestamp.
- The dashboard now nudges operators to rerun a probe once cooldown has elapsed, while leaving router eligibility unchanged so recovered agents can still be picked immediately.

## [0.33.1] - 2026-07-30

### Fixed

- Fixed `TypeError: cmd.trim is not a function` and `[object Object]: command not found` when using any agent whose `edit_exists` transport is declared in the map form introduced in 0.33.0. Two call sites still read the raw field instead of the normalizer, so `status`, `probe`, and the CLI audit path crashed for the Claude, Kiro and aider-fronted agents.
- Agent health for map-form CLI transports is reported correctly again; previously the healthy branch was skipped entirely because it tested for a string.
- Added a regression test covering both transport shapes so the bare-string and map forms stay interchangeable.

### Changed

- `openrouter-gemma-4-31b-free` now declares effort support like the other OpenRouter entries. OpenRouter validates `reasoning.effort` at the router for every model it fronts, so the level is accepted — though Gemma is not a reasoning model and will likely ignore it.

## [0.33.0] - 2026-07-30

### Added

- Added `--effort <level>` to both `dispatch` and `pick`, so operators can request more or less model reasoning for a job instead of treating every run the same.
- Added transport-level effort declarations in `agents.yaml`, which lets each agent advertise exactly which effort levels it supports on each transport.

### Changed

- `pick --effort <level>` now returns only agents that explicitly declare that level, making it easier to build a compatible pool before dispatch.
- Effort delivery now matches the target agent path: direct `reasoning_effort` body fields, OpenRouter's nested `reasoning.effort`, CLI flags such as `--effort`, Codex's `-c model_reasoning_effort=...`, and aider's `--reasoning-effort` flow for HTTP-backed `edit_exists`.
- Unsupported effort levels are treated as a best-effort hint and dropped for that agent instead of blocking the run, while malformed level strings still exit with code 2.
- Dispatch timeout increased from 300 seconds to 500 seconds, with `EXTERNAL_AGENTS_TIMEOUT_MS` available to override it for slower agentic runs.

## [0.32.0] - 2026-07-29

### Added

- Added repeatable `--file path[:lines]` on `dispatch`, so operators can attach real repository files directly to a prompt instead of hoping an HTTP-only agent guesses the project structure.
- Added the same file-attachment support to the MCP tool schema, keeping CLI and MCP callers aligned.

### Fixed

- Added containment checks around attached paths, including `realpathSync`, a time-of-check/time-of-use fix, and a broken-symlink guard, so file inclusion stays inside the intended workspace.
- Added support for line ranges, labels, and a 256 KB per-file cap, which makes prompt context more precise and prevents oversized attachments from bloating requests.

## [0.31.0] - 2026-07-28

### Changed

- `set-credential` now clears cooldowns for every agent that uses the updated environment variable, so a newly pasted key works immediately instead of waiting for an old `quota_exhausted` timer to expire.
- `pick` now respects registry-level `enabled: false`, while still allowing `state.enabled: true` to re-enable a specific entry when you want a local override.
- `gemini-3-pro-preview` and `gemini-3.1-pro-preview` are now disabled and tagged `paid` because Google removed them from the free tier; paid operators can still turn them back on in the UI.

## [0.30.0] - 2026-07-27

### Added

- Added optional `--cwd` on `dispatch` for `edit_exists`, so an agent can work directly inside an existing repository or worktree instead of always running in a temporary directory.

### Changed

- When you pass an external `cwd`, `external-agents` now reports the git-changed file set from `git status --porcelain` instead of walking the whole tree, which makes returned file lists match the actual edits.
- The supplied directory is treated as caller-owned: it is never created or deleted by `external-agents`.

### Fixed

- Missing or non-directory `cwd` values now fail before the child process is spawned, so a bad path is rejected early instead of producing a confusing downstream run.

## [0.29.1] - 2026-07-27

### Fixed

- Fixed `external-agents-mcp` failing to start with `ENOENT: ./agents.yaml` when an MCP client launched it from an arbitrary working directory.
- Registry resolution now uses the module directory, matching the CLI and UI, so operators no longer need a `cwd = \"...\"` workaround in MCP configuration just to start the server.
