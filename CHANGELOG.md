# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.34.1] - 2026-08-06

### Fixed

- `kiro`'s `edit_exists` transport trusted only `fs_read`, so the agent could read the working directory but never write to it. It did not fail — it printed the patch as text and exited 0 with no files touched, which the dispatcher reported as `success` with `files: []`. The trust list now covers `fs_read,fs_write,execute_bash`, matching what the `edit_exists` transport promises.

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
