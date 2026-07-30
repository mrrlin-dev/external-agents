# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting and [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
