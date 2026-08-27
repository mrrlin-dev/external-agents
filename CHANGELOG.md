# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Two thirds of the dispatch temp directories were empty.** `runGenerate` created its workdir before sending the request, so every dispatch that produced no file left an empty directory behind — a missing key, a 429, a timeout, a non-JSON body, an empty completion. Measured on one developer machine: 909 of 1427 `ea-gen-*` directories held nothing but the fact that a dispatch had failed. The directory is now created when there is something to write into it, and `workdir` is `null` on the paths that write nothing (it previously pointed at an empty directory, which was never useful). The success path is unchanged.

### Added

- **`external-agents audit` now sweeps this package's stale temp directories** and reports what it removed. Not really about disk — the whole accumulation measured 9 MB — but about what is in it: `ea-gen-*` directories hold `generated.md`, the model's complete response in plain text, which on a machine used for code review means the reviewed source and the review itself sitting unencrypted in the OS temp directory until the system reclaims it, roughly a month later on macOS. The retention window defaults to 3 days; set `EXTERNAL_AGENTS_TEMP_RETENTION_DAYS` to change it, or a negative value to disable it. Nothing modified within the last 15 minutes is removed whatever the window says: the window is read as `Number(env || default)`, and while an empty string falls through to the default, `" "` is truthy and `Number(" ")` is 0 — a stray space in a shell export would otherwise have swept the workdir of a dispatch that started moments earlier. The sweep only ever touches direct children of the temp directory carrying one of this package's own prefixes, only real directories (a symlink is skipped, never followed), and only entries older than the window, so a dispatch running right now cannot lose its workdir.

### Fixed

- **CI's MCP smoke step asserted the opposite of the desired behaviour and had failed on every run since it was added.** A stdio MCP server exits as soon as its transport closes — EOF on stdin means no client, so there is nothing to serve — and a workflow step's stdin is `/dev/null`, i.e. EOF immediately. Measured: with stdin at `/dev/null` the server exits after ~290 ms; with the pipe held open it runs until killed. The step now holds the pipe open the way a real MCP host does. It also waits for the server's stdio banner instead of sampling once at a fixed two-second offset (which asserted a boot *speed* and failed a merely slow runner), and then confirms the process is still up — catching a server that announces itself and immediately dies, which the old check could not detect at all.
- **The two process-group tests were timing races and could report either answer wrongly.** Both spawned a descendant that wrote a marker file after a fixed delay (120ms / 250ms), killed the group, slept a little longer, and asserted the marker was absent. Too slow and the kill lands after the marker is already written, so a WORKING group kill fails — that is what made `runDispatch forwards parent SIGTERM to the subprocess group` go red in a loaded full-suite run while passing 3/3 in isolation. Too slow the other way and the descendant has not booted when the assertion runs, so a BROKEN group kill passes; `runDispatch timeout terminates the subprocess group` also used a 30ms dispatch timeout that could fire before the fixture had spawned anything to kill, exercising nothing at all. Both now record the descendant's PID and wait for it to stop existing, which is what "terminates the process group" actually claims and has neither failure mode. Verified by disabling the group kill in `terminate()`: both tests fail, as they must. Three consecutive full-suite runs on a machine at load average 25-70: clean.

## [0.47.0] - 2026-08-26

### Fixed

- **A failed health probe could remove an agent from the pool permanently, and nothing said so.** `errored_transient` was the one non-healthy verdict that never recorded a `cooldown_until`, and `pickAgents` only readmits a non-healthy entry once a cooldown has *elapsed* — so a single transient failure (a 5xx, a timeout, a probe spawned with a broken PATH) filtered that entry out of every subsequent pick until somebody re-probed it by hand. Observed live: `claude-opus-5` sat in `state.json` as `errored_transient — "bash: line 1: env: command not found"`, and `external-agents pick --tier strong` returned no closed strong model at all, only free/local ones. `errored_transient` now carries a 15-minute expiry (`ERRORED_TRANSIENT_TTL_S`), and `effectiveCooldownUntil` *derives* that expiry from `checked` for records already written without one — so existing `state.json` files heal on read, with no migration.
- **A probe whose own command failed to execute was recorded as an agent failure.** `auditCliEntry` runs the entry's command through `bash -c` with the parent's environment; when that parent is a GUI-spawned MCP server or dashboard, `PATH` can be missing `/usr/bin`, and a registry command beginning with `env -u ANTHROPIC_BASE_URL … claude --print` dies as `bash: line 1: env: command not found` before the agent is ever invoked. That was classified as `errored_transient` and written to `state.json` — blaming the agent for our shell. Such failures now classify as `probe_error` (`isHarnessFailure`, keyed on exit 127 and the shell's own "cannot execute" text) and are **never persisted**: the stored verdict is left untouched. `audit` reports them separately and the dashboard's Verify button shows "! probe failed" instead of a latency.
- **`audit` probed switched-off entries, spending real round-trips to write `healthy` next to agents that cannot be dispatched.** For a prepaid provider (both DeepSeek entries ship `enabled: false` for exactly this reason) that is money spent proving an unreachable agent is reachable. Disabled entries are now skipped and reported; `--include-disabled` opts back in for the "should I turn this on?" case.

### Added

- **Repository provenance on every `--cwd` dispatch.** A worker was handed a directory and told nothing about which version of the project it held. The failure mode this closes is specific and was hit in practice: a checkout sitting a couple of hundred commits behind, a review that accurately described code no longer present upstream, and a reader who concluded the model had fabricated it. `runAny` now prepends a short factual header (repo root, branch or detached HEAD, commit + subject, drift versus the branch's upstream — falling back to the remote's default branch when a local task branch declares none — and whether the worktree is dirty), and returns the same facts to the caller as `repo` in `dispatch --json`, in the stderr trailer, in the MCP `dispatch` response, and as `repo_head` / `repo_branch` / `repo_behind` / `repo_dirty` in the telemetry row. Read-only and best-effort throughout: it never fetches, never mutates the caller's repo, and degrades to an absent field rather than a failed dispatch. Opt out with `provenance: false`.
- **`external-agents dispatch --require-base <ref>`** — refuse to dispatch unless the `--cwd` checkout contains `<ref>` (e.g. `origin/main`), turning the above from a note in the prompt into a precondition. Off by default and never inferred; a stale checkout is sometimes exactly what you meant to inspect. Checked before any state is written, so a refusal leaves no trace, and it never fetches — comparisons are against refs already on disk, which the error message says. Exits 6 when the checkout is wrong, 2 on usage errors.
- **The provenance header distinguishes "clean" from "could not tell".** `git status --porcelain` returns empty output for a clean tree, which is indistinguishable from the command having failed or timed out on a very large tree unless the two are read apart. `dirty` is now `null` for the undeterminable case and the header says so, rather than reporting a worktree as clean on the strength of a check that did not complete.
- **`enabled` and `dispatchable` are now stated outright by the MCP `list_agents` tool and `external-agents status`.** `enabled` previously reached callers only as a side effect of spread order, so reading it correctly required knowing the two-layer kill-switch rule; and a switched-off entry whose key is present still probes `healthy`, so a client reading only `state` concluded an agent was available that dispatch would then refuse. `status` gains a `use` column (`on` / `OFF`) and names the switched-off entries, and the dashboard's "healthy" tile no longer counts them (its footnote reports them as "N off").

## [0.46.1] - 2026-08-21

### Fixed

- **`external-agents audit` (and the UI's per-row "Verify" button) reported agy entries as `errored_transient` with a `bubbletea: could not open TTY` crash, which read as a broken environment or a quota problem.** Root cause: `auditCliEntry` builds its probe command from an entry's bare `edit_exists.cmd`, but never applied `prompt_flag` — the transport field `runDispatch` already uses to insert `--print` immediately before the prompt, because agy's `--print` consumes the very next token as its own value (see 0.45.0's aider write-scope fix for the sibling case of a CLI eating a flag as its prompt). Without `--print`, agy silently booted its full interactive TUI instead of answering headless, and that TUI requires a real controlling terminal — the actual source of the TTY crash. `auditCliEntry` now inserts `prompt_flag` the same way `runDispatch` does. Live-verified: `external-agents audit --provider antigravity` went from 5/5 TTY crashes to 4/5 `healthy` plus one real, distinct upstream error.
- **The same audit path garbled a CLI's JSON error body into a bare `"}"` hint** (observed on opencode, whose Zen backend returns a multi-line `{"name":"UnknownError","data":{"message":"...","ref":"..."}}` on failure) — the fallback hint extraction took "the last non-blank line," which for multi-line JSON is just the closing brace. It now pulls `.message` / `.error.message` (object or plain string) / `.data.message` out of a trailing JSON object first, scanning past any unrelated `{` that appears earlier in the output (e.g. a CLI's own "Loading {module}..." progress line), and falls back to the old last-line behavior only when there's no parseable JSON with a usable message.

Both fixes are confined to the health-probe path (`audit` / UI "Verify") — no change to how a real dispatch runs. Consensus gate: run and converged (round 3/5, 4/4 pool reviewers responded, all APPROVE, 0 critical issues outstanding — 2 critical issues were raised and adjudicated across rounds 1-2, one accepted and fixed, one dismissed with cited evidence and the dismissal accepted by the raising reviewer in round 3).

## [0.46.0] - 2026-08-21

> **BREAKING:** `claude-opus-4-8` and `codex-gpt-5.4-mini` no longer exist as
> agent ids — dispatch by either id will fail with "unknown agent". See
> **Changed** below for the replacements.

### Changed

- **`claude-opus-4-8` renamed to `claude-opus-5`** — Anthropic's newest Opus
  tier. Live-confirmed with `claude --print --model claude-opus-5` and
  `external-agents verify-read-only claude-opus-5`. `claude-sonnet-5` and
  `claude-haiku-4-5` are unaffected (already on their current names; there is
  no v5 Haiku yet). Antigravity's re-hosted Claude entries
  (`agy-claude-sonnet-4-6`, `agy-claude-opus-4-6-thinking`) are also
  unaffected — `agy models` confirms that provider does not expose a v5
  Claude model yet.
- **`codex-gpt-5.4-mini` renamed to `codex-gpt-5.6-luna`** — `codex debug
  models` (no quota consumed) shows `gpt-5.4-mini` deprecated in-catalog with
  `gpt-5.6-luna` named as its direct successor; the old `-codex`-suffixed
  tiers this registry previously noted as unsupported are gone from the
  catalog entirely. Re-verified live once a temporary account-wide usage cap
  reset: `verify-read-only` passes, and an out-of-enum
  `-c model_reasoning_effort=bogus` 400s naming the full supported set
  (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) — wider than
  previously declared, so `effort_levels` was widened to match.
- Neither rename changes dispatch behavior for anyone already using the new
  ids; this is a hard rename, not an alias — matching this file's own
  precedent of removing retired model ids outright (see the `claude-opus-4-7`
  removal note in `agents.yaml`) rather than keeping a deprecated pointer
  around.

## [0.45.0] - 2026-08-19

> **BREAKING (aider only):** an aider `edit_exists` dispatch now requires at least one `--file`.
> Every other `edit_exists` CLI is unaffected. See **Changed** below.

### Fixed

- **An aider `edit_exists` dispatch attached repo files nobody declared, blowing the context window and leaking file contents to the provider.** aider's `preproc_user_input()` scans our own `--message` prompt for filenames before the first request, matching every whitespace-separated word against the entire git-tracked file list — by full path *or* by bare basename — and `--yes-always` auto-accepts each one, so any prompt mentioning `foo.js` shipped that whole file. Seen in production as a dispatch going from a 131k model limit to 594k tokens and failing every retry (surfaced misleadingly as `quota_exhausted`); reproduced deterministically, including a secret from an undeclared file reaching a third-party provider. Neither existing guard could stop it — `--map-tokens 0` governs the repo *map*, a different code path, and `MAX_TOTAL_FILE_BYTES` only ever counted the files we pass. A generated `.aiderignore` now narrows aider's view to exactly the declared `--file` paths, with the repo's own `.aiderignore` rules folded in last so they can still veto a declared path.
- **An aider dispatch could write outside the files it was given.** aider's `allowed_to_edit()` auto-approves both "Create new file?" and "Allow edits to file that has not been added to the chat?" under `--yes-always`, and consults only gitignore — never `.aiderignore` — so the read-side allowlist above does not bound writes. No aider-side lever exists for this (no flag disables the prompts, and without `--yes-always` non-tty stdin makes them default to yes anyway), so containment is verified after the run instead: the worktree's dirty state is snapshotted before spawn — path, status, and a content hash, so a second edit to an already-dirty file cannot hide behind an unchanged status — compared afterwards against the declared paths, and a dispatch that exceeded its scope fails with the offending paths named. The caller's own uncommitted work is never blamed on the dispatch, and nothing is ever reverted.

### Changed

- **BREAKING (aider only): an aider `edit_exists` dispatch now requires at least one `--file`.** `--file` stays optional for every other `edit_exists` CLI, which can search its `--cwd`; aider cannot, having no search tool. It previously compensated by scraping filenames out of the prompt — the behaviour removed above — so a no-files aider run could now only start on an empty chat and exit 0 having changed nothing. It refuses up front instead. Callers dispatching aider without `--file` must declare the files it may edit; a declared path that does not exist yet is created.

## [0.44.4] - 2026-08-18

### Fixed

- **A numbered provider clone kept its stale `enabled` after the base it was cloned from was later disabled.** `/api/add_provider_key` clones a base entry by spreading its fields at CLONE time; if the base subsequently gets `enabled: false` in the registry (e.g. a provider drops free-tier access to a model), every clone created before that change keeps whatever `enabled` it was cloned with — undefined, i.e. "on" — forever. Reproduced live: `gemini-3.1-pro-preview-3` through `-8` predated the base's `enabled: false` (added in 0.31.0 when Gemini Pro left the free tier) and had no `enabled` key at all, so `pickAgents` kept seating them — one clone errored against Gemini's billing-required paid tier three times in a single day via a consensus review panel. `loadRegistry` now re-derives a numbered clone's `enabled` from its base by (provider family, model) identity on every load, filling the gap only when the clone has no explicit `enabled` of its own; a `state.json` per-key override still takes precedence, unchanged.

## [0.44.3] - 2026-08-17

### Fixed

- **The MCP `pick_agents` tool's documented "defaults to tier='weak'" routing note was advisory only, not enforced.** An omitted `filter.tier` fell through to the full, tier-unrestricted pool, sorted by `preference_order` — a field only ever set on cheap/free weak-tier entries by registry convention, never by code. A caller that forgot `filter.tier` could land a strong-tier, costlier/slower candidate whenever a weak sibling in the same provider family happened to be unhealthy. The handler now defaults `filter.tier` to `"weak"` in code when omitted; explicit `filter.tier='strong'` is unaffected.

## [0.44.2] - 2026-08-17

### Fixed

- **`runDispatch` orphaned its detached CLI child when the parent runner was killed.** A parent SIGINT/SIGTERM to the Node dispatch wrapper no longer leaves the child process group running (observed live as a PPID=1 orphaned provider CLI after the wrapper exited) — the signal is now forwarded to the child's process group, cleanup is idempotent, and temporary parent-signal listeners are removed instead of leaking across dispatches.

## [0.44.1] - 2026-08-17

### Fixed

- **A flaky test, not a product defect: the 1s spawn budget in `lib/dispatch.progress.test.js` failed under CPU contention.** Seven fixtures spawn a fresh `node` and expect it to run to completion within `timeoutMs: 1000`; a cold node start is ~100-300ms on an idle machine but comfortably over 1s when the box is busy, so the assertion measured the load average and reported `runDispatch`'s own timeout code (`124 !== 0`). Hoisted into `SPAWN_TIMEOUT_MS = 10_000`; the two deliberate timeout tests (30ms, 50ms) keep their tight inline budgets. Verified A/B under 4-way parallel load, 24 suite runs each: 14 failures before, 0 after.

## [0.44.0] - 2026-08-17

### Removed

- **Groq's two Llama entries (`groq-llama-3.3-70b`, `groq-llama-3.1-8b-instant`)** — both now return `model_not_found` from `api.groq.com`; Groq has retired the chat-capable Llama family from its hosted catalog (`/openai/v1/models` lists only the `llama-prompt-guard-2` classifiers). Their `token_limits` notes had already flagged them as missing from Groq's live rate-limits page in 0.43.0; this confirms the deprecation.

### Added

- **`groq-qwen3.6-27b`** — replaces the removed Llama entries in Groq's weak tier (131072-token context, `reasoning_effort` enum `none`/`default`, validated against the live API). `groq-gpt-oss-20b` also remains weak-tier on the same key.

### Fixed

- **The operator kill-switch (`enabled: false`) is now honoured on every dispatch path** — a direct `dispatch <agent_id>` from the CLI or the MCP tool named an id explicitly and bypassed `pickAgents`' filter, so a deliberately disabled entry was still reachable. The check is now a shared `isAgentEnabled()` in `lib/pick.js`, applied in `cli.js`'s `cmdDispatch`, the MCP dispatch tool, and `resolveEscalation`.
- **A repeated `set-credential` no longer silently re-enables a disabled agent** — `enableAgentsAwaitingCredential` skipped an entry only when `state.json` already had `enabled: true`, so key rotation or a second setup pass flipped an explicit disable back on. It now skips whenever the operator has recorded a decision in either direction; the flip stays a one-time bootstrap, not a standing sync.

## [0.43.0] - 2026-08-17

### Added

- **`agents.yaml` entries can now carry a `token_limits` block** — `context_window`, `tpm`/`itpm`/`otpm` (combined vs. direction-split tokens-per-minute), `tpd`, `rpm`, `rpd`, `concurrent` (concurrent-connection cap, e.g. DeepSeek), and a freeform `note` — so a picker (human or LLM orchestrator) can check a prompt's size against a model's real cap before dispatching instead of finding out via a live failure. Triggered by dispatching a 42KB prompt to `groq-gpt-oss-120b` and hitting Groq's free-tier 8000 TPM cap outright. Every field is populated only when that specific provider actually publishes that cap shape — never invented for a shape it doesn't use. Numbers are a 2026-08 best-effort snapshot, not a live poll; two Groq entries (`groq-llama-3.3-70b`, `groq-llama-3.1-8b-instant`) are flagged in their `note` as absent from Groq's live rate-limits page as of this research, possibly deprecated there.

## [0.42.2] - 2026-08-14

### Fixed

- **The dashboard's `error_preview` for `ollama-gpt-oss-120b` (and any other `ollama_chat`-backed entry) showed a harmless startup warning instead of the real failure reason.** aider's litellm `ollama_chat` backend shells out to `ollama show <model>` for context-window auto-detection, inheriting the parent spawn's `stdin:"ignore"` — so it always prints `Warning: Input is not a terminal (fd=0).` to stderr, success or failure. That line landed at the tail of stderr, exactly where the preview's last-400-chars slice looks, burying the actual error. Added `stripBenignStderrNoise()`, applied only when building the preview; the raw stored stderr and the exit-code/outcome classification path are unchanged.

## [0.42.1] - 2026-08-13

### Fixed

- **Pasting a valid key could still leave it shown as "Locked (needs auth)."** `/api/set_credential` and `/api/add_provider_key` persist the new key, then fire a live verify ping — and treated ANY failure of that ping other than `modelUnavailable` as proof the key was bad, overwriting the correct `healthy` state a `probeInstalled()` check had just computed moments earlier in the same request. Reproduced live: six `gemini-3.1-pro-preview` clones (`-3` through `-8`), added back to back, each caught Gemini's rate limit on their post-add verify and got permanently stuck `needs_auth` — with valid, working keys. `/api/audit`'s single-agent Verify button already classified this correctly (429 → `rate_limited`, 401/403 → `needs_auth`, everything else failing → `errored_transient`); that classification is now the one shared `classifyVerifyResult()` all three call sites use, so a rate limit or a 5xx during verify no longer locks a key that was just successfully saved.
- **`cli.js`'s `audit` command carried its own fourth copy of that same classification logic**, left behind when the dashboard's three copies were unified above. Deduped to the shared function; behavior unchanged.
- **`/api/set_credential` could report "invalid json" for an unrelated failure and imply the save itself had failed when it had not.** Its verify+patch phase had no dedicated try/catch, unlike the identical phase in `/api/add_provider_key`. A thrown `verifyCredential` fell through to the outer JSON-parsing catch, which blamed parsing and returned HTTP 400 — even though the credential had already been persisted successfully a few lines earlier. Now mirrors `add_provider_key`: reports `ok:true` with a warning, since the key genuinely was saved.
- **CI never actually ran the `node:test` suite** — only `node -c` syntax checks, a registry-load check, and a boot smoke test. Every regression test in `lib/*.test.js`, including new ones added for the fixes above, protected nothing in CI until now. Added a step.
- **`agy` (Antigravity CLI) could silently never receive the prompt it was dispatched with, while still reporting success.** Every other CLI transport appends the prompt as a trailing positional after its flags — the shape `agy --print --dangerously-skip-permissions --model M --add-dir D "<prompt>"` uses too, and it works for every other CLI here. But confirmed live that agy's `--print` (aliased `--prompt`) is not a bare boolean like claude's: it consumes the very next token as its own value, so it swallowed `--dangerously-skip-permissions` as "the prompt" and the model answered a question about that flag instead — while the process still exited 0. Registry entries can now declare `prompt_flag` (alongside the existing `cwd_flag`/`effort_flag`), which `runDispatch` places directly before the prompt instead of leaving it a bare trailing positional; set on all five `agy-*` entries. Confirmed fixed live: the model correctly echoes back an exact marker string given in the prompt.
- **Many individually-small attached files could together push a dispatch well past the target model's real context window, and the request would be silently truncated rather than rejected — with the dispatch still reporting success.** The existing 256KB-per-file cap did nothing against ~25 files that were each well under it but summed past a ~131k-token budget to ~594k. Confirmed live against a real provider: planted a unique marker in the middle of an oversized file and asked for it back — the answer was "not found," while the dispatch still reported `outcome: success`. No error text exists for any regex-based safety net to catch in that case, so `aider`'s existing provider-error detection could never have caught this failure mode either way — prevention is the only fix that works. Added a `MAX_TOTAL_FILE_BYTES` aggregate cap (512KB, sized to the smallest real context window in the bundled registry): the HTTP path truncates gracefully file-by-file once the running total would cross it; `aider`'s own file-attachment path (previously completely unguarded, since `aider` reads its files itself) refuses the dispatch outright before `aider` is even spawned, rather than let it silently work from a partial view of the request.

## [0.42.0] - 2026-08-11

### Fixed

- **Exclusion did not cascade to a model's other API keys, so keeping a model out of a panel was whack-a-mole.** `--exclude gemini-3.6-flash-6` seated `gemini-3.6-flash-5` instead, and `--exclude-providers google` seated one too, because the clones live under `google3`..`google8` and the flag matched the provider slug exactly. 0.41.0 fixed this identity confusion for *diversity* — a numbered slug is one KEY, not one SOURCE — but left exclusion counting keys. Both axes now use the same identity: an excluded id drops every entry serving the same model, and an excluded provider matches by FAMILY, so `google` covers every numbered key. Excluding a single key is deliberately not supported — a key that is rate-limited or out of quota is already skipped via state, which is the mechanism that belongs to keys.
- The cascade does not over-reach: exclusion is keyed on family+model, so `--exclude groq-gpt-oss-20b` leaves `groq-gpt-oss-120b` eligible. Same provider, different model, still a distinct voice.
- The `--tier-prefer` backfill excluded already-picked *providers* by raw slug, so a strong-tier `google3` pick could be followed by a weak-tier `google4` backfill of the same model — a panel that looked provider-diverse and was not. It now excludes by family.
- `filter.exclude_ids` cascades inside `pickAgents`, so the MCP `pick_agents` tool gets the same behavior as the CLI; previously `--exclude-providers` was expanded to ids in `cli.js` and the MCP path had no equivalent at all. `pick_agents` also now accepts `filter.exclude_providers`, and its description states both cascade rules, since that description is what a model reads at runtime to decide how to fan out.

## [0.41.0] - 2026-08-11

### Fixed

- **`min_distinct_providers` could be satisfied by four clones of one model.** A smoke test asking for 4 agents with `min_distinct_providers: 2` got `gemini-3.6-flash-3/4/7/8` — four API keys, one model, one opinion. That is a four-seat jury with a single voice, the exact failure a panel exists to prevent. The count was per raw provider slug, and a numbered slug is one KEY (a real, independent quota bucket, which is why dispatch spreads across them) rather than one SOURCE. Diversity is now counted per provider FAMILY (`google3`/`google4` → `google`), and no model is seated twice while an unseated one is still available. Quota spreading is untouched — that happens at dispatch, across the keys of whichever entry gets picked.
- The same bug made raising the threshold useless as a workaround: the diversity guard only applied *while* fewer than `min_distinct_providers` had been seen, so every slot after the threshold was unconstrained. `min_distinct_providers: 3` returned a pick byte-identical to `2`. Both the family rule and the no-duplicate-model rule now apply to every slot.
- `n` is honored again as a request for n agents. If the pool genuinely runs out of distinct models, the remaining slots are backfilled with duplicates in the same preference/least-recently-used order, rather than silently returning a shorter list.
- `pick_agents`' MCP tool description said only "enforces cross-provider diversity", which is what a caller would reasonably read as "distinct models". It now states the family rule and the one-seat-per-model rule explicitly, since the description is what a model reads at runtime to decide how to fan out.

## [0.40.0] - 2026-08-11

### Removed

- **`google2` is no longer bundled.** It was hand-authored into `agents.yaml` back before `+ Add another key` existed, and it had two problems. It shipped one operator's second GCP project ("My Project 82450") into everyone's install, where the derived `GEMINI_API_KEY_2` means nothing. And it was the only numbered slug the UI could not undo: removal edits `agents.local.yaml`, there was nothing there to edit, so the × the dashboard itself drew on the chip could only ever 404 — the symptom 0.39.0 papered over by disabling those entries instead. Extra Google projects now come only from `+ Add another key` (or `add-model`), which writes them to the local overlay where removal genuinely deletes them. Bundled registry is 28 entries, 25 enabled by default. An operator who was relying on the bundled `google2` keeps working: `agents.local.yaml` overrides by id, and re-adding the key through the UI recreates the pair under the next free slug.

### Fixed

- `nextProviderSlot` would have named a fresh install's second Google key `google1`. With `google2` unbundled the only family match is the bare base slug (suffix 0), and a naive max+1 gave 1 — contradicting both the base slug and the `GEMINI_API_KEY_2` env var derived next to it. Floored at 2.
- `gemini-3.1-pro-preview`'s `free_tier` block claimed a free tier with no card required, copied wholesale from the Flash entry, while the comment directly above it said Google had set Pro's free allowance to 0. The entry now says what is true: 0 free requests, billing required. It stays bundled and disabled so it can be opted into.
- README claimed 42 bundled entries / 32 enabled. That count was taken from a machine with six locally-added Google keys in its overlay — a fresh install never had them. Now 28 / 25, with the Gemini row corrected from "×8 slots" to what actually ships.

## [0.39.2] - 2026-08-11

### Fixed

- **A probe silently reverted the operator kill switch, which 0.39.0 turned into a way to lose DeepSeek right after enabling it.** `writeState` merges per id by REPLACEMENT, and almost every caller builds its patch from a fresh observation — so `probe`, `audit`, a dashboard refresh, or any dispatch dropped whatever `enabled` the record was carrying. For an ordinary entry that was invisible, since absent means enabled. For an entry disabled in the registry it meant the opposite: `set-credential DEEPSEEK_API_KEY` turned both DeepSeek entries on, and the very next probe turned them back off. Reproduced on a clean HOME — `pick --tier strong` matched `deepseek-reasoner` before the probe and not after. `enabled` is the operator's decision, not an observation, so it now survives any write that does not name it explicitly; `/api/toggle` and the enable-on-credential path both still name it, and still win. One change covers every writeState call site, including the ones in `dispatch.js` that run on every call. Regression test added.

## [0.39.1] - 2026-08-11

### Changed

- README rewritten for someone arriving at the package cold, and corrected — it had drifted through ten releases since it was last touched. It claimed 28 bundled agents (there are 42, 32 enabled by default), five Gemini variants plus two paid upgrades (eight and eight), and six OpenRouter `:free` models (five); it never mentioned Antigravity's five entries at all; it dated the Cerebras/Z.ai removals as "this release" when they were 0.13.0 and 0.22.0; and it linked a `CONTRIBUTING.md` that does not exist in the repo or the tarball, so the link 404'd. It also led with the registry rather than the question a new reader actually has — *what do I have to set up before any of this works?* — which is now its own section: nothing at all if you are logged into an agentic CLI, and one optional free-tier key per provider after that. Docs-only; no code changes.

## [0.39.0] - 2026-08-11

### Added

- Registry entries can carry `enable_on_credential: true` alongside `enabled: false`. It distinguishes the two things a bundled `enabled: false` used to conflate: "paid, opt in deliberately" (`gemini-3.1-pro-preview-2`, unchanged) and "useless until a credential exists". Only the second kind is flipped on automatically when its key arrives, via the state.json layer `pick` already lets override a registry default.

### Changed

- **DeepSeek now ships disabled and turns itself on when a key is added.** Its API is prepaid, so a fresh install with no `DEEPSEEK_API_KEY` listed two entries that could never answer anything. `deepseek-chat` and `deepseek-reasoner` are now `enabled: false` + `enable_on_credential: true`; `set-credential DEEPSEEK_API_KEY` through either the CLI or the UI enables both and says so. Removing the key does not flip them back — that stays an explicit operator toggle.
- Removing a numbered provider key no longer refuses when the slug is bundled. `google2` is hand-authored in `agents.yaml`, so the overlay-only removal path found nothing to delete and 404'd with "no removable entries" on a chip the UI itself had drawn an × on — but every key past the first is optional, so removal has to work there too. A bundled slug's entries are now disabled through the existing state.json kill switch and their env var dropped; re-adding the key through "+ Add another key" flips them back on. The response reports `disabled_ids` next to `removed_ids`.

### Fixed

- The UI and the MCP server picked up `keys.env` only at boot, so a key added afterwards from another shell left the dashboard insisting `env var DEEPSEEK_API_KEY not set` for an agent whose key was already on disk — with no hint that the fix was a restart. Both now re-read the store per request (`refreshEnv`), so a `set-credential` in a terminal shows up on the next poll. A value exported in the operator's own shell still wins, exactly as at boot.
- `external-agents ui` printed a URL line for every port it tried, not just the one it bound: `server.listen(port, host, cb)` registers a PERSISTENT `listening` listener, so a retry chain accumulated one per attempt and they all fired on the bind that finally succeeded. With 4711 taken you got both `:4711` and `:4712` — and `cmdInit` opens the FIRST such line it sees, i.e. the port it had just failed to bind. Both listeners are now torn down per attempt.

## [0.38.3] - 2026-08-11

### Fixed

- `external-agents set-credential <ENV_NAME>` hung forever after the value was typed. The interactive path read stdin until the `end` event — i.e. EOF — but a terminal never sends EOF on Enter, only `data`. The prompt appeared, the key was accepted, and then nothing happened until the user thought to press Ctrl-D, which reads as a broken command rather than a subtle stdin contract. On a TTY the first line is now taken via `readline` instead. The piped/redirected path still reads to EOF, so multi-line values and input without a trailing newline behave exactly as before.

## [0.38.2] - 2026-08-11

### Fixed

- `auditCliEntry`'s health-check timeout was a hardcoded 20s SIGKILL, and that turned out to be the real cause of most of the `opencode` flakiness the previous fix (0.38.1's model pin) didn't fully explain. Measured cold-start latency for `opencode run --auto` on this machine ranged **7s–62s across five back-to-back calls with nothing else changed** — no model swap, no network hiccup, just CLI startup variance. At 20s that's a coin-flip SIGKILL mid-reply: stdout comes back empty and the dashboard reports `errored_transient` for an agent that would have answered fine given a few more seconds. Raised to 90s — comfortably past the observed worst case, still well under `runDispatch`'s real-dispatch timeout (500s default) so a probe fails faster than an actual task. A killed-by-timeout run is now also reported distinctly (`"timed out after Ns waiting for a reply"`) instead of looking identical to an empty response for an unrelated reason.
- Retracted an overclaimed comparison from 0.38.1: the "5/5 clean vs. 2/8 empty" reliability difference cited between `deepseek-v4-flash-free` and `big-pickle` was confounded by inconsistent `timeout N` values used across separate manual test runs, not a real measured quality gap — exactly the kind of variance the fix above explains. The registry comment on `opencode` now says so plainly rather than repeating the retracted number. The model pin itself stands: `nemotron-3-ultra-free` is still excluded on its own separate, real defect (it leaked chain-of-thought text into replies meant to be plain answers), and there's no evidence `deepseek-v4-flash-free` is worse than `big-pickle`.
- Re-verified with the fix in place: `audit --provider sst` now reports `healthy` on 3 of 3 runs (was flapping before), each between 38s and 87s — consistent with the newly-understood latency range, not with a broken agent.

## [0.38.1] - 2026-08-11

### Fixed

- `opencode` was unpinned entirely ("this entry's whole reason to exist is that `cli:opencode` is a separate auth surface, so don't borrow anyone else's"), which turned out worse than borrowing a bucket: bare `opencode run --auto` round-robins across EVERY authenticated surface it can see — OpenCode Zen and this package's own GROQ/OPENROUTER/CEREBRAS/GEMINI env vars alike — with zero regard for task fit. Observed live: `opencode/big-pickle` (a real Zen model, works), then on the very next call Groq's `whisper-large-v3-turbo` — an audio-transcription model — picked for a plain text-edit prompt and failing outright. That produced exactly the 6-success/2-fail flakiness an operator reported from the dashboard.
- Now pinned to `opencode/deepseek-v4-flash-free`, an OpenCode Zen model confirmed live to need neither this package's keys nor `opencode auth login` — a genuinely independent quota bucket, not borrowed from anything else in the registry. Chosen over Zen's other no-auth free models by measurement: 5/5 clean replies to a trivial probe vs. 2/8 empty responses for `big-pickle` and worse for `nemotron-3-ultra-free` (which also leaked chain-of-thought text into replies meant to be plain answers). Per Zen's own docs this specific free model is promotional ("available for a limited time" while the team collects feedback), not a permanent tier — noted in the entry's `free_tier.limits` so it doesn't read as a stable guarantee.

## [0.38.0] - 2026-08-10

### Security

- **`verify-read-only` was certifying commands that never ran.** Its only test was "is the canary unchanged?" — and a command that fails to start does not write either. `/bin/true` and a nonexistent binary both came back `verified: true`, and so did any real CLI that happened to be quota-gated, logged out, or uninstalled at verification time. That is a vacuous pass, exactly the unearned trust this axis was created to prevent. A probe now also requires the run to have completed successfully; when it did not, the result is `{verified: false, inconclusive: true}` with the agent's last output — a prompt to fix auth/quota and re-verify, not a claim that the command writes. Canary mutation is still checked first and outranks everything: a command that wrote and then failed is write-capable, not inconclusive.
- Re-running every `cmd`-based `read_only` entry under the stricter probe: **3 verified (`claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`), 16 inconclusive.** The 11 `agy-*` entries, `cursor-agent`, `codex`, `codex-gpt-5.4-mini`, `kiro` and `opencode` are all quota-gated or unauthenticated right now, so none has been verified against a live run — including entries this release previously recorded as individually verified. Their commands are unchanged and still plausible; what was wrong is the claim that they were *proven*. Re-verification has to wait for quota resets (`kiro`: 1 Sept); `opencode` no longer needs a credential at all as of 0.38.1, below.

### Changed

- **Every `read_only` capability is now declared explicitly.** An entry with a `generate_new` transport used to satisfy a `read_only` request without declaring anything — true (an HTTP completion call holds no filesystem handle) but unauditable: an entry nobody had considered looked exactly like one deliberately cleared for read-only use. The 17 HTTP-only entries now carry `read_only: { via: generate_new, verified: by_construction }`, and the implicit fallback is gone — requesting `read_only` on an entry that does not declare it is an error. **This is a breaking change for a caller that relied on the implicit fallback for a hand-authored `agents.local.yaml` entry**; add the block above to it.
- A `read_only` block must declare exactly one of `cmd` (a distinct no-write CLI invocation, proven per-entry by `verify-read-only` against a canary) or `via: generate_new`. Neither, both, or `via` pointing at any other transport is rejected at registry load rather than at dispatch time — `via: edit_exists` in particular is the write-capable fallback this axis exists to prevent.
- `verify-read-only` returns `{verified: true, basis: "by_construction"}` for a `via: generate_new` entry without running a canary probe. There is no filesystem handle to exercise, so a probe would prove nothing the transport's shape does not already.

- `opencode`'s entry now targets the opencode 1.x CLI it always claimed to (`provider: sst`, `docs_url: opencode.ai`). Its command was `opencode -p`, from the abandoned pre-1.0 Go CLI that shadowed the name on PATH — the project Charm forked into `crush`. On 1.x, `-p` is `--password`, so that command printed the help banner and exited 0: work silently never done, and not even catchable by the empty-run rule above, because a help banner is output. Now `opencode run --auto` with `--dir {cwd}`.
- `read_only` for `opencode`, closing the last undeclared entry: `--agent plan`, opencode's own read-only agent. It passed `verify-read-only` three times while a borrowed provider was configured; with that removed it is inconclusive pending `opencode auth login`. The entry is deliberately pinned to no provider key: its harness costs 17-32k tokens per request, so pointing it at a shared free bucket would drain that bucket's daily cap on behalf of an entry contributing no quota of its own. Note the registry comment on it — substituting `permission: {edit: deny, …}` in config **hangs indefinitely** in non-interactive mode with `--auto` (reproduced on 1.18.16 against two separate providers at 100s, 150s and 300s, no output on either stream). `--agent plan` is the only usable read-only lever there.

### Added

- `env_from: { TARGET: SOURCE }` on a CLI transport — copies the credential in `SOURCE` into the child's `TARGET`. **This is what makes a provider's 2nd, 3rd, Nth key usable for editing.** `add_provider_key` clones a provider into numbered siblings whose credential lands in a derived name (`GEMINI_API_KEY` → `GEMINI_API_KEY_2` → `_3` …); an HTTP transport reads that name straight from the entry, but aider takes its key name from LiteLLM's fixed table and only ever looks at `GEMINI_API_KEY`. Both `google2` entries now carry the mapping and have `edit_exists` for the first time. Proven live, not just wired: `gemini-3.6-flash-2` edited a file in 7.3s **while the primary `gemini-3.6-flash` was quota-exhausted**, which is only possible if the second key was the one used. Env-var identifiers are validated at registry load, and an unset source is skipped rather than exported empty (absent makes a CLI say "no credential"; empty makes it send `Bearer ` and get an opaque 401). Values resolve through the same path as `env:`, so `@file:~/...` refs work.

- Declared `read_only` transports for the 14 entries that previously declared only a write-capable `edit_exists`: `cursor-agent` and all 11 `agy-*` entries via their own `--mode plan`, `codex` and `codex-gpt-5.4-mini` via `--sandbox read-only`. See the Security note above for their verification status — all 14 are currently quota-gated and therefore **inconclusive**, not verified.
- `edit_exists` is back on the 15 HTTP-only entries where it can be routed through `aider` (Google, DeepSeek, Groq, OpenRouter, Ollama Cloud). Live-verified end to end on one entry per provider bucket. The two `google2` entries were initially excluded for want of a way to bind aider's fixed `GEMINI_API_KEY` to their `GEMINI_API_KEY_2`; `env_from` (above) solves that, so all 17 HTTP entries now have `edit_exists`.

### Fixed

- The aider lane works again, and 0.33.4's blanket migration error is gone. It never failed because of aider: the old command passed `--no-git` and attached no files, so aider opened with an empty chat and the model could only ask for the file contents back — every such dispatch exited 0 having changed nothing. The prompt was also appended as a positional, which aider reads as a *filename*. Prompts now go through `--message`, `--file` paths are attached as the files aider may edit, and `--no-git` is gone.
- A dispatched aider no longer dirties the caller's worktree. It used to append `.aider*` to the repo's `.gitignore` and leave `.aider.chat.history.md`, `.aider.input.history` and `.aider.tags.cache.v4/` behind — a worktree the caller is required to hand back clean. History files are redirected to a temp dir and `--no-gitignore` / `--map-tokens 0` suppress the rest.
- A dispatched aider no longer opens browser tabs on the operator's desktop. `offer_url` asks "Open documentation url for more info?" on a quota error, a model warning or a version bump, and `--yes-always` answered *yes*. `--no-show-release-notes` and `--no-detect-urls` remove the prompts; `BROWSER=true` in the child env neutralises any remaining `webbrowser.open`.
- A CLI dispatch that exits 0 having printed nothing and changed nothing is now a failure, on every CLI transport. `kiro` does exactly this when it is quota-gated — it was reporting `outcome: success` with empty output and no files, the same silent-success class the `read_only` axis was introduced to stop. It now reports `quota_exhausted`. Whitespace-only output counts as empty; any real answer, however short, is left alone. Both streams are considered, but for different questions: **stdout alone** decides whether the agent answered, because `result.output` — the value every caller reads as the reply — is stdout, and kiro's own "Monthly request limit reached" notice goes to stderr while stdout stays empty. **stderr** decides why, and a `dispatch:` reason line is appended to it so a diagnosed empty run (a quota notice the classifier can name) is distinguishable from a silent one instead of both surfacing as a bare exit 1.
- aider's provider-error detection reads stderr as well as stdout. LiteLLM prints its exceptions to stdout in the runs observed here, but nothing guarantees that, and a failure the classifier can already read off stderr must not be invisible to the exit code.
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
