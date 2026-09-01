# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **`doctor` no longer prescribes a remedy that cannot work.** `unmeasured_seat` used to fire for every enabled HTTP seat with no token ceiling and tell the operator to run `external-agents audit`. For a provider that answers without any rate-limit headers that instruction can never succeed, so the finding came back unchanged every run with a fix that is impossible to apply — the exact "noise in a daily job" this file's own header warns against. Measured: one provider in the pool returns 23 response headers, all vendor plumbing, and not one `x-ratelimit-*`, while the same probe reads a ceiling off two others in under a second.

  It is two findings now. `unmeasured_seat` (medium) keeps the audit remedy and means *nobody has probed this yet*. `unmeasurable_seat` (low) means *this has been probed and the provider reports nothing*, and its remedy is a hand-written `token_limits` — or the honest option of leaving a seat unsized when it has never actually been rejected. Lower severity on purpose: it has already had the only automatic fix applied to it.

- **`observedFromResponse` records that a provider answered without reporting limits** (`limits_unreported`), rather than discarding it as `null` — which read identically to "we have never asked". Kept out of `observed_limits` deliberately: that block merges field by field, so writing an absence into it would overwrite the provenance of a real measurement while leaving its `tpm` in place. A ceiling arriving later retires the marker.

## [0.56.0] - 2026-09-01

### Added

- **`dispatch-log.jsonl` now keeps 30 days and drops what is older.** Until now it had no retention at all, while the opt-in sidecar carrying far *more* sensitive content was already capped — the asymmetry was backwards (measured on a live install: 2.4 MB / 8442 rows over 41 days, ~22 MB/year, 281 ms to read on every `get_stats` call).

  Retention is by **age, not size**, and that choice is the substance of the change. Every question anyone asks this file has a time window in it — `get_stats --since`, `doctor --since 24h`, `doctor`'s measured-allowance window — and a byte cap satisfies those only by coincidence of traffic rate: a quiet month hoards a year of dead rows, a busy week silently drops the far end of a window somebody is still asking about. (The 30-day `OBSERVED_LIMIT_TTL_S` in `budget.js` is *not* affected either way: it is checked against `state.json`, which this file never backs.) Neither direction errors, which is what makes bytes the wrong axis. `EXTERNAL_AGENTS_DISPATCH_LOG_RETENTION_DAYS` changes the window; `EXTERNAL_AGENTS_DISPATCH_LOG_MAX_BYTES` remains as a 32 MiB backstop for a burst that outruns the age rule, and it reports on stderr when it trims rather than truncating quietly.

  Trimming is triggered when the oldest row is a fifth of a window overdue rather than the moment it crosses the boundary. Without that hysteresis the steady state is pathological — the oldest row sits exactly on the line, so every append rewrites the whole file.

  Pruning takes a single-holder lock so two servers cannot rewrite the file at once. The lock records its holder's pid and is broken on **liveness alone**, never on age — an age rule is a promise that no prune will ever be slower than the number chosen, and a prune that is slower watches another process declare its lock stale and start pruning the same file. Raising the number makes that rarer and harder to find, not fixed. A lock held far longer than any prune could take (a pid the OS recycled onto an unrelated process) is therefore **reported to the operator with the command to clear it**, and never stolen.

  **On upgrade, the first trim drops whatever you already have beyond 30 days.** Copy the file first if you want the older history.

- **`EXTERNAL_AGENTS_DISPATCH_LOG_FILE`**, the override `failures.jsonl` has had since 0.50.1. Without one this package's own suite had nowhere else to write: fixtures that dispatch and fail on purpose appended to the operator's real log — 357 rows across 119 suite runs on the machine this was found on — and `doctor` carried a `/^test-/` filter to subtract them back out. The suite now redirects itself, and a full run adds zero rows.

- **The registry's `usage_from` and its transport's `--output-format` are now checked against each other**, in both directions and against recorded CLI output. They are two hand-maintained halves of one mechanism and drift between them is silent either way: drop the flag and the seat goes back to reporting no tokens at all (the exact blindness 0.54.0 existed to end), keep it without a spec and the caller's answer becomes a raw JSON envelope instead of the text inside it.

### Changed

- **The 400-character error preview in a dispatch-log row is redacted** with the same machinery the failure sidecar uses, and the file's `0600` mode is re-checked on every write rather than only at creation (`appendFileSync`'s `mode` applies to creation alone, so a file left wider by an earlier version stayed wider). Measured over the 1675 previews already on disk, redaction changes none of them — this is insurance on a channel that *can* carry a key, not a fix for an observed leak.

- **`external-agents: telemetry write failed` is now `dispatch-log write failed`.** Nothing is sent anywhere; the only two `fetch()` calls in the dispatch path are the dispatches themselves, and the old wording made a local disk error read like a failed upload.

## [0.55.0] - 2026-09-01

### Added

- **A generic `deprecated` field in the `agents.yaml` schema**, not a one-off flag — any entry can now carry an advisory pointing at its replacement. `ollama-gpt-oss-20b` and `ollama-gpt-oss-120b` (the `cli:ollama`/local-daemon path) are marked deprecated in favor of their `-key` siblings below, which need no local daemon or `ollama signin`. No removal date is set — the cli entries stay registered and fully functional until API-key auth is established as the norm.

- **`runAny()` warns once per dispatch** when a deprecated entry is used: `dispatch: WARNING — <id> is deprecated: <text>`, printed to stderr in the same style as the existing files-without-`cwd` warning. It never blocks or changes the transport, and `--json` mode's stdout stays clean — verified live that the warning fires on stderr while stdout still parses as valid JSON.

- **`ollama-gpt-oss-20b-key` / `ollama-gpt-oss-120b-key`** — an API-key auth path for Ollama Cloud models. They hit `ollama.com` directly with a Bearer `OLLAMA_API_KEY`, bypassing the local daemon entirely, kept alongside the existing `cli:ollama` entries rather than replacing them since the key path is the only one that works where the daemon isn't installed. `reasoning_effort` validated empirically against the hosted endpoint (200 for `high`, 400 with an explicit enum error otherwise) rather than assumed from the cli sibling.

## [0.54.0] - 2026-08-31

### Added

- **`external-agents doctor` now measures what a subscription seat actually served.** A CLI transport has no rate-limit headers, so its ceiling cannot be observed the way an HTTP seat's can — but whatever it served *between running out twice* IS the allowance for that period, in the provider's own accounting, with no guessing. Live on the current pool: `groq-gpt-oss-120b-2` served 71 dispatches / 396,827 tokens over ~94h; `azure-kimi-k2-5-safe` 7 dispatches / 49,393 tokens over ~1h, which is its 5000-token minute showing up as a period measurement.

  Reported and **never gated on**, deliberately: a ceiling set too high costs nothing (exhaustion still stops us) while one set too low silently discards the rest of the allowance with nothing failing to point at — the same pathology as a provider sitting at 0.5% utilization. Two exhaustions closer together than an hour are treated as one event hit repeatedly rather than two periods.

- **`doctor --json` reports per-agent spend**, separating measured tokens from an honest `tokens_unknown` count. Before the CLI usage adapter below, every CLI seat's entire history was in that unknown column.

- **`usage_from` in the registry, and `lib/cli-usage.js` to interpret it.** Token accounting for CLI transports, which the 0.53.0 header ledger structurally could not reach.

### Removed

- **`scripts/doctor-daily.sh` and `scripts/install-doctor-schedule.sh`.** Shipped in 0.53.0 and superseded a day later. `doctor` is the tested half of a daily check — thresholds, evidence, a remedy per finding, an exit code — and a launchd/cron wrapper was the wrong other half: the interesting part of a daily check is deciding what in the output is worth waking somebody for, which is a judgement, not a cron line. A scheduled Claude task does that better and needs no shipped shell. The `doctor` command itself stays; it is what such a task runs.

  Removing them also drops the two defects they carried: a `set -o pipefail` + `grep -q` pipeline that made `--status` report a loaded job as not loaded (`grep -q` exits on first match, upstream gets SIGPIPE, `pipefail` fails the whole pipeline), and a feature probe that would have matched `--since` in the general help text of a build with no `doctor` at all.

### Fixed


- **A CLI's reset time was being guessed at when it was stated, or knowable.** Three distinct cases, all in `lib/quota-reset.js` — a bare `try again at 3:03 PM` (unparseable, fell to a 48-hour default on six recorded rows, throwing a working seat away for two days to wait out minutes), `Resets in 4h30m14s` (the hand-rolled pattern dropped the seconds and rejected a seconds-only form outright), and cursor-agent stating no period at all (48-hour default, re-seated ~15 times a month against a monthly allowance).

MINOR: additive. New module (`lib/cli-usage.js`), new registry field (`usage_from`), new `doctor` check; the only removal is the two cron-wrapper scripts, superseded a day after shipping. No breaking change to any existing flag. Full suite: 386 tests, 385 pass, 0 fail, 1 pre-existing skip, repeated clean runs. Verified live against the real CLI, not only in tests.

Reviewed over two consensus rounds. Round 1 surfaced one real defect (a bare number read as seconds); round 2 surfaced two more (a truncated event stream passing an intermediate count as totals, and a dunder path segment satisfying a lookup that promised to refuse it). Six other raised items were answered with measurements rather than accepted — three of those were wrong on the facts, and the checks are recorded in the commits.


## [0.53.0] - 2026-08-31

Measured over 8079 dispatches across 40 days: **19.7% of all dispatches were thrown away**, 26.9% over the trailing week, and rising. Three quarters of that loss was predictable from data the providers were already handing us and the pool was discarding.

### Added

- **`external-agents doctor [--since 24h|7d] [--json]`** — checks the five goals now written down in the README against the dispatch log, instead of assuming them. One check per goal, each carrying the evidence to verify or dismiss it and the command that fixes it. Exit 1 on a high-severity finding only, so it is safe to run unattended and only shouts when something actually broke.

- **A daily schedule for it.** `scripts/install-doctor-schedule.sh` (launchd on macOS, `crontab` elsewhere) runs `scripts/doctor-daily.sh`, which does **audit first, then doctor**. That order is the design: `audit` is one `max_tokens: 1` ping per entry and the response carries the provider's real ceiling, so the measuring pass repairs the most common finding rather than reporting it. Reports land in `~/.local/state/external-agents/doctor/`, pruned after 30 days.

- **`external-agents --version`.** It used to die with `unknown subcommand`. A scheduled job needs it to record which build it actually ran, or "the nightly check was testing a stale build" stays invisible.

### Fixed

- **Rate-limit headers were captured only on failure, so the system could learn a limit only by breaking on it.** Every provider in the pool publishes `x-ratelimit-limit-tokens` / `-remaining-tokens` / `-reset-*` on a **200** as well as a 429; the success path built no header object at all. By the time a 429 arrived the information was an autopsy, and the identical headers on the preceding success had been a warning nobody read.

  Headers are now attached to every return path — including the `max_tokens: 1` audit probe, which turns `audit` into a limits-*discovery* pass — and normalized into two records per agent with deliberately different lifetimes: `observed_limits` (the ceiling, good for weeks) and `observed_budget` (what is left of it, expiring in 120s). `pick` reads the observation **before** the registry's declaration.

  This was the keystone, and the numbers say why. Only **4 of 52** entries declared a `tpm` at all. Both directions of error were live: `azure-kimi-k2-5-safe` declared nothing and really has a **5000-token-per-minute** ceiling, so every review prompt sent to it was arithmetically impossible — 47% failure rate, and the single largest source of lost consensus reviewers; while `groq-llama-3.3-70b` succeeded **59 times above** the 8000 its family was assumed to share, so a hand-written family constant would have been wrong the other way. One rule gets both right and nothing has to be maintained by hand.

- **All 251 recorded HTTP 413s were groq, and every one was predictable.** The error body states `Limit 8000, Requested 10098` in as many words; it is now parsed and recorded as the observed ceiling, which makes the most expensive class of failure the measurement that prevents the next one. Measured before/after on the live pool: a 40 KB prompt used to be offered every groq and azure seat and is now offered **none**, while a 4 KB prompt still gets 6 groq seats and 1 azure — routed by size, not blacklisted.

  A tighter bytes→tokens divisor was measured and **rejected**: empirically 4.44 mean / 4.00 median / 3.43 at p5, and moving 4.0 → 3.2 catches 8.4pp more 413s while wrongly blocking 10.7pp more real successes. Break-even at best. The lever is a measured ceiling, not a better guess.

- **`retry-after: 1` on a token-exhausted 429 produced a one-second cooldown.** Azure sends it beside `x-ratelimit-type: Tokens`, `remaining-tokens: 0`, `renewalperiod-tokens: 60` — true about the request bucket, irrelevant while the token minute is empty. Obeying it literally meant an instant re-pick into the same wall: **21 measured re-dispatches inside 60 seconds of an agent's own rate-limit response.** When the provider names tokens as the exhausted axis the cooldown is now floored at that axis's own window. The floor only ever lengthens a cooldown.

- **An agent that had never once answered was ordered exactly like one that always does.** `consecutive_failures` is a streak and deliberately blind to rate limits ("a busy agent is not a bad agent" — that rule stays), so the pool had no long memory at all: **247 dispatches went to agents with a lifetime success rate under 15%**, four of them at exactly zero. `openrouter-gemma-4-31b-free` was seated 73 times and failed 73 times, every day for 40 days, because a lapsing cooldown was the only thing anything remembered about it.

  Two mechanisms, kept separate because conflating them is how a pool empties itself. **Quarantine** is a filter whose bar is absolute — never succeeded, in 8 tries — so it cannot mistake an exhausted free tier for a dead model, and `audit` clears it. The **success rate** is a sort key and never a filter: a seat that works 5% of the time belongs after every seat that works 95% of the time and ahead of an empty slot.

- **Least-recently-used was balancing attempts while ignoring outcomes.** `last_used_at` is stamped at dispatch *start*, so LRU was honest — but failures return in 14.7s mean against 47.6s for a success, so a broken seat re-entered the front of the queue about three times quicker than a working one. LRU did not merely tolerate dead agents, it over-sampled them. Ordering is now health band first, LRU inside the band; the band is coarse (four buckets) on purpose, because a finer score would override the tiebreak that spreads load and collapse "balanced across the live models of a tier" into "whichever model is marginally luckiest gets everything".

### Not changed, and why

- **`quota_scope: shared` is still not used to collapse sibling cooldowns**, despite being declared on 27 entries and read by zero lines of code. Generalizing the openrouter rule to every `shared` sibling on a key looked obvious and was measured wrong before shipping: auditing groq's three models behind **one** key within the same second returned *independent* budgets — `groq-gpt-oss-20b` at `remaining-tokens: 7927` (spent 73), `groq-qwen3.6-27b` at `7988` (spent 12), each decremented only by its own ping. Groq meters per (key, model), so cooling two healthy seats down because a third hit its own limit removes capacity that exists — a direct hit on goals 1 and 5.

  The deeper problem is that the field does not say which *axis* is shared. `shared` is plausibly true of groq's daily `tpd: 200000` and false of its per-minute window, and a per-sibling cooldown is only correct for the axis that actually bit. OpenRouter keeps its collapse because it is not a guess: its own 429 says `free-models-per-day`, the cap is documented per account, and it was recorded costing four consecutive gate rounds.

- **A verdict-only write erased measurements.** `writeState` merges per id by REPLACE, which is right for a verdict and wrong for anything the record *knew*. Reproduced while smoke-testing this release: a dispatch recorded `observed_limits {tpm: 5000}` and 38 seconds later a concurrent write from an older build replaced the record wholesale and the measurement was gone. `observed_limits` and `health` now survive alongside `enabled`, which learned the same lesson first — carried in `writeState` rather than at each call site, so writers that predate the fields, and any added later, cannot drop them. `observed_budget` is deliberately not carried: it describes one 60-second window and expires on its own.

- **`add-model` created entries with no ceiling and said nothing.** That is how `azure-kimi-k2-5-safe` entered the pool. It now points at the audit that would measure it — a warning, not a refusal, because the honest instruction is "go measure it", and refusing would only push the operator into hand-writing a guess.

### Changed

- **README now states what the project is optimizing for**, as five numbered goals with the rule that follows from them: observation beats declaration, and a limit discovered by being rejected is a limit recorded too late. Every check in `doctor` names the goal it defends.

- **A patch was assumed to be newer than what was already on disk.** `writeState` restores a measured field when the patch stays silent about it, and let the patch win outright when it did not — without comparing timestamps. Every writer builds its observation from the call that just finished, so an observation is fresh when it is *built*; but the state lock waits up to ten seconds. A dispatch that returned at T=100 can therefore be blocked until T=106 and write its `seen_at: 100` observation on top of one made at T=105 by a concurrent dispatch to the same agent.

  For a ceiling the damage is usually nil, since it rarely moves between two calls. For `observed_budget` it is not: that field is replaced wholesale, its values genuinely differ call to call, and a stale `remaining_tokens: 0` landing on a fresh `remaining_tokens: 4000` takes a healthy seat out of `pick` for the full 120-second TTL. Both fields now keep whichever observation has the greater `seen_at`; an undated one on disk is treated as no evidence about now, the same rule `effectiveCooldownUntil` applies to a verdict that cannot say when it applied. Raised by a consensus reviewer.

- **Two pre-existing test flakes, root-caused rather than re-run until green.** Both asserted on machine-global state while `node --test` runs test files in parallel processes. The signal-handler cleanup test ran with `timeoutMs: 1000`, so it was also asserting that a cold `node` spawn beats one second under parallel load — it failed ~1 run in 6 with `exitCode 124` at ~1450 ms, never reaching the assertions it existed for. The temp-directory test counted *every* `ea-gen-*` directory in the OS temp dir, so any other file's dispatch creating or sweeping one between a `before` and its assertion changed the number — ~1 run in 10, while passing 5/5 in isolation. The counter is now scoped to its own fixture's agent id, and a mutation test confirms it still fails when a failed dispatch really does create a workdir.

- **An empty `pick` exited 3 with nothing to say.** "Everything is cooled down", "everything is quarantined" and "your prompt is bigger than every seat you have" are three different problems with three different remedies, and they were indistinguishable from a bare exit code. `pick` now prints one line naming the funnel:

  ```
  pick: no candidates out of 53 entries — 17 cooling down (quota_exhausted);
  14 prompt too large (needs 22500000 tokens); 10 switched off; 10 excluded by
  transport, tags, effort or an explicit --exclude; 2 cooling down (errored_transient)
  ```

  A reviewer raised this as "the quarantine filter can empty the pool". It can — and so could the cooldown filter long before any of this, so the claimed invariant was overstated and is now written down accurately. The proposed remedy (ignore quarantine when it would empty the set) was declined: a pool where every agent has been tried eight times and never once answered has no working credentials, and re-offering those seats spends another round discovering it. Describing the state is the fix; papering over it is not.

MINOR: additive. New subcommand, new state fields, no breaking change to the registry or to any existing flag. Full suite: 358 tests, 357 pass, 0 fail, 1 skipped (pre-existing), repeated clean runs after both flake fixes. Verified end to end against the live pool, not only in tests — the ledger learned `tpm: 5000` for azure and `tpm: 8000` for six groq keys that had declared nothing, and `pick` changed its answer accordingly.

## [0.52.1] - 2026-08-31

### Fixed

- **A provider error delivered inside a 200 envelope was scored as a generic fault instead of the quota event it was.** OpenAI-compatible endpoints are supposed to signal failure with a status code and several do not: a 200 arrives carrying `{"error": {"code": 429, …}}` and no `choices`. That was already treated as a failure — but for the wrong reason. With `choices` absent the completion is empty, so the run was reported as `empty generated output`, and since the classifier reads only `stderr + output`, the envelope's own words never reached it. A real 429 therefore got the transient-failure ladder instead of a quota cooldown, and the account-wide free-tier bucket was never marked. Same shape as a 0-byte file passing for work, one layer up.

  The envelope is now inspected before the completion, and its numeric code stands in for the HTTP status, so the failure reads `HTTP 429` exactly as it would have on a correctly-coded response. A slug code (`rate_limit_exceeded`) is not a status but is folded into the message, where the classifier can still see it.

  **The sibling case is deliberately NOT covered, and a test pins that.** A 200 whose *content* discusses a rate limit is the model's answer, not a failure; inferring otherwise is the prose-guessing that four rounds of consensus rejected for the CLI-side guard in 0.52.0. Structured evidence is acted on, prose is not.

PATCH: no API change, no new setting. Full suite: 291 pass, 0 fail, 1 skipped (pre-existing), four consecutive clean runs — one earlier run failed once and did not reproduce, so the likeliest cause was removed rather than left to chance: the new tests' HTTP server close is now awaited instead of fire-and-forget.

## [0.52.0] - 2026-08-31

### Fixed

- **A run that returned nothing but provider errors was reported as `outcome: success`.** Recorded live: a planner dispatch came back with a trailer saying success while its content was rate-limit errors and no plan, and the sidecar failure log had no row for it, because only failures are recorded and this was not counted as one.

  Two guards existed for exactly this class and a single **0-byte file** defeated both — each opened with `if (files.length > 0) return code;`. That is not a corner case but the ordinary shape of a failed planner run: `buildAiderArgs` refuses to run without a `--file`, aider touches a declared path that does not exist into existence, and a planner is told to write its plan to exactly such a path. Measured: a 0-byte file plus an all-429 stdout returned exit 0.

  The worst consequence was not the label. Success resets `consecutive_failures` and writes `state: healthy`, so a rate-limited agent looked healthy and was picked again at once — defeating the escalating cooldown AND the account-wide free-tier bucket collapse, since a 429 arriving as exit 0 never marks the bucket.

  A file is now evidence of work only if it has content. A deletion or rename still counts despite carrying no bytes — without that clause a successful deletion would be re-coded as a failure, which is worse than the bug. Bytes are used when the listing has them and resolved from disk when it does not, so neither `listFiles` nor `parseGitPorcelain` changes shape and a successful run does no extra filesystem work at all. The resolution realpaths the **candidate** path, not just the root, because a symlink inside the workdir pointing outside it passes a string-prefix test, and it fails closed on anything it cannot confirm — safe only because the guard is unreachable until a provider-error pattern has already matched.

  Scope deliberately unchanged elsewhere: `emptyRunExitCode` is untouched, so "create an empty file" is still a success unless the run also printed a provider error.

### Added

- **`failure_markers`, an optional per-transport list of strings that mean "this run failed" despite an exit code of 0.** Ships with `kiro`'s observed `Monthly request limit reached` and nothing invented. An entry that declares none keeps its previous behaviour exactly.

  Declared as data rather than pattern-matched in code because a vocabulary spanning unrelated CLIs cannot be defined: a four-round consensus rejected both a generalised regex and a "the banner appeared twice" repetition heuristic, on the grounds that neither "provider-error marker" nor "substantive line" has a definition across `opencode`, `kiro`, `codex` and the `agy` family — which makes such a rule unimplementable and untestable, and risks re-coding legitimate answers that merely discuss rate limits. Wording drift is real, and is now fixed by editing data (the registry, or `agents.local.yaml` per machine) instead of shipping a release. Detecting drift automatically is an explicit non-goal.

MINOR: one new optional registry field, no change to any existing default beyond the corrected exit code above. Full suite: 287 pass, 0 fail, 1 skipped (pre-existing). Design passed the consensus gate at round 4 on a full four-voice panel with zero critical issues; rounds 1-3 dissented and each objection is reflected above.

## [0.51.1] - 2026-08-30

### Fixed

- **`<subcommand> --help` ran the subcommand instead of printing help.** `external-agents pick --help` performed a real pick and printed an agent id. That is worse than unhelpful for the callers most likely to ask: shell-side feature detection reads help text, so a probe for a flag got an agent id back, concluded the flag did not exist, and silently dropped it — while spending a pick call on every probe. Measured consequence: 0.51.0's whole point was to stop oversized prompts being seated, and the consensus runner detected `--prompt-bytes` exactly that way, so the very next gate run seated an 8000-TPM agent for a 40 KB review and took another `HTTP 413`. Any subcommand with `--help` (or `-h`) now prints the usage banner.

- **`pick`'s sizing flags were documented only in a source comment.** `--prompt-bytes` / `--prompt-tokens` were absent from the printed help, so even a correct probe of the right command would not have found them. They are in the banner now, with the rule that entries declaring no limits are never refused.

PATCH: no API change. Full suite: 274 pass, 0 fail, 1 skipped (pre-existing).

## [0.51.0] - 2026-08-30

Six findings, all of them read off the logs this package now keeps rather than guessed at: the
sidecar failure log and the consensus gate's own run stats, over 46 recorded failures and 16 gate
rounds.

### Fixed

- **`pick` and `dispatch` disagreed about `--transport read_only`, and the gate paid for it every round.** `pick` treated a bare `generate_new` as satisfying a read-only request — an HTTP call cannot write, so the observation was true — while `selectTransport` requires the declaration to be *explicit*, because an entry nobody has considered is otherwise indistinguishable from one deliberately cleared for read-only use. `pick`'s comment claimed the two rules matched. They did not, and `pick` was the side that was wrong: it handed out a seat, `dispatch` refused it, and the process died with an uncaught stack trace. Measured across 16 consecutive consensus rounds: **11 of them lost a reviewer this way**, and only one round in sixteen ever reached its four-voice target. `pick` now applies `selectTransport`'s rule exactly, including refusing a `read_only` that delegates to a transport the entry does not have, and a test asserts the two agree entry by entry rather than by comment.

- **`add-model` created entries that could never be dispatched read-only.** It wrote `generate_new` alone, so every locally added model landed in exactly the state above. It was the only entry of 52 in the resolved registry missing the declaration — and it was a locally added one, which is what that tells you about where such entries come from. New entries now carry `read_only: {via: generate_new, verified: by_construction}`, the same shape every bundled HTTP entry uses and the basis `verify-read-only` already reports for them.

- **A transport refusal escaped as an uncaught exception and left no trace.** A Node stack trace on stderr and exit 1, so a caller could report only "rc=1" — and because the throw happened before anything was spawned, the sidecar failure log recorded nothing, on precisely the pre-dispatch-refusal class it was built to capture. It is now a recorded `precheck` refusal and a structured `transport_refused` on stderr with exit 4, on both the CLI and the MCP surface.

- **Declared token limits were never read, so oversized prompts were seated and failed live.** `token_limits` has been in the registry for exactly this purpose, and one entry's own note warns about the cap that then rejected seven dispatches: `Request too large … TPM: Limit 8000, Requested 8118 / 8195 / 10098`. `pick` accepts `--prompt-bytes N` / `--prompt-tokens N` and drops entries whose declared `tpm` or `context_window` cannot hold the request. Limits are inherited from a sibling key serving the same model — of the eight model families that declare limits, every one has numbered siblings that declare none, so a per-entry read would have skipped the oversized seat and handed the prompt straight to its clone. A missing limit is never a refusal: silence is not "too small", and treating it as such would empty the pool.

- **An account-wide free tier went out one entry at a time.** OpenRouter's free tier is a per-account daily cap across every `:free` model, but the registry models them as separate entries, so exhausting one left the rest looking healthy to be picked in turn and rediscover the same cap — four consecutive gate runs, one ending in a re-pick that found no non-openrouter candidate and proceeded on the two-voice floor. Exhausting one now marks the bucket. Deliberately narrow: a paid model on the same key is untouched, and providers that meter per key (groq's numbered keys are separate allowances) are never collapsed.

- **A benign warning became the failure reason.** Three recorded failures carried `Warning: Input is not a terminal (fd=0).` as their one-line reason. The filter for that noise already existed and was applied to the error preview — just not to the reason, which is the line a reader actually sees first.

- **The overlay lock did not create its own directory.** Found while testing the fix above: on a machine where nothing had yet written state, `add-model` died with `ENOENT` on the lock file, before the overlay it was about to create.

MINOR: one new optional flag pair on `pick`, no change to any existing default. `pick --transport read_only` is stricter — by design, since the seats it no longer offers are exactly the ones `dispatch` refuses. Full suite: 272 pass, 0 fail, 1 skipped (pre-existing).

## [0.50.1] - 2026-08-29

### Fixed

- **A fine-grained GitHub token held in `GH_PAT` was written to the failure log in the clear.** The name test judges an environment variable by its segments, and `PAT` was not among the words it recognises, so `GH_PAT` and `GITHUB_PAT` returned false and the value pass never saw the token. The pattern pass did not catch it either — `ghp_` is the *classic* token prefix, and a fine-grained token starts `github_pat_`. With both passes blind to it, the serialised backstop had nothing to match, so a live credential could pass all three. `PAT` and `PSK` are now recognised as whole segments and `github_pat_` as a shape. `PAT` is deliberately kept out of the undelimited-substring list, where it would swallow `PATH`.

  This is the same class as the end-anchored name test fixed during 0.50.0's own review, found the same way: a consensus round that read the code, and a check that ran it. The list is names, and a list of names is only ever as complete as the conventions someone thought of.

- **A password embedded in a connection string survived every pass.** `DATABASE_URL`, `REDIS_URL` and `AMQP_URL` are named after the service, not after the credential inside them, so name-based matching cannot reach them by construction. Caught by shape instead: `scheme://user:password@host` keeps its scheme, user and host — the half you diagnose with — and blanks what sits between the colon and the `@`. A URL with no credentials in it, and an SSH remote, are left exactly as they were.

- **A secret containing a quote, a backslash or a newline could ride out in a field the module does not model.** The per-field passes run before serialisation, but the backstop runs *over the serialised line*, where JSON has escaped those characters and the literal value no longer appears. The value pass now blanks the escaped form as well.

- **An existing log file with wider permissions kept them.** `mode` on `appendFileSync` applies at creation only, so a file left behind by an earlier version — or by a redirected `EXTERNAL_AGENTS_FAILURE_LOG_FILE` — went on receiving raw provider output at whatever mode it already had. It is now stat-ed and tightened to `0600` before the append.

- **Running the test suite appended to the operator's own failure log.** With the flag switched on, two test files drove real failure paths without redirecting the sink, so a full run mixed eight fixture rows into the file the operator diagnoses with. Measured, then fixed at the source; a full run now adds none.

PATCH: no API change, no new setting, no change to any default. Full suite: 261 pass, 0 fail, 1 skipped (pre-existing).

## [0.50.0] - 2026-08-29

### Added

- **An opt-in sidecar failure log,** written so it can be handed to a model and turned back into a fix. `external-agents failures on` starts appending every *failed* attempt to `~/.local/state/external-agents/failures.jsonl`, one JSON object per line, and `external-agents failures tail N` prints it raw for exactly that purpose.

  The existing dispatch log is an aggregation record and is right to be small: one row per call, error text clipped to the last 400 characters so `get_stats` and the dashboard stay cheap. That clip is wrong for diagnosis, and wrong in a specific way — it is a *tail*, so a CLI that prints a startup banner, echoes the prompt, and then throws has its exception preserved and its invocation dropped, while a provider that answers with a JSON error body long enough to overflow loses the half naming the replacement model. The sidecar keeps both ends of an over-long stream and says how much it elided from the middle.

  What each row carries beyond the preview: full stdout and stderr, the exact argv and cwd the child was spawned with (the most common cause of a puzzling CLI failure is a flag the registry spells differently than the installed version of the tool expects), the HTTP request descriptor and the provider's untruncated response body and headers, unwrapped `fetch` causes (`ECONNREFUSED` instead of "fetch failed"), and the classification drawn from that output — so a reader can tell "your key is wrong" from "this model no longer exists" from "your `PATH` is broken" without re-deriving it.

  It covers every failure path, not just dispatch: `audit` and credential verification (whose hints clip the provider's body to 200 characters), the read-only canary probe, and — the class with no trace anywhere before this — pre-dispatch refusals. An unknown agent, a disabled agent, a `--require-base` mismatch, or a missing escalation candidate never reaches `runAny`, so nothing was spawned, there is no exit code, and the dispatch log has no row. On both the CLI and the MCP surface, those now leave a record.

  **The switch is a file, not an environment variable:** `~/.local/state/external-agents/config.json`, in the operator's state directory rather than the package, so `npm i -g …@latest` replaces the package and leaves the setting alone. `EXTERNAL_AGENTS_FAILURE_LOG=1|0` still overrides it for a single run, and `external-agents failures on` warns when that override is set in the current shell rather than letting a flipped switch appear to do nothing. `EXTERNAL_AGENTS_FAILURE_LOG_FILE` redirects the sink.

  Off by default, and everything stays local: the file is `0600`, nothing is transmitted. Secrets are stripped on the way in by three passes — exact-match blanking of every key-shaped environment value this process holds (which catches a key echoed back inside a provider's own error message, where nothing about its shape says "key"), a pattern pass for tokens this process never held, and a final pass over the serialised line so a field this module does not know about cannot leak one. The tool does not write the prompt down: `prompt_text` is dropped and the prompt positional in the argv becomes a byte count, with `failures on --with-prompts` to opt back in. That is deliberately not stated as a guarantee that no prompt text reaches the file — many CLIs echo the prompt back on stdout, and `raw.stdout` is captured whole, which is the point of the sink. The log rotates once at 32 MiB rather than growing without limit.

### Fixed

- **A CLI that printed a banner to stdout and its exception to stderr got the banner reported as the failure reason.** The one-line summary was drawn from stderr and stdout concatenated, so the last line of the joined text won — and that is stdout's. The two streams are now consulted separately, error stream first. Only affects the new failure log's `reason` field.

MINOR: new subcommand, new environment variables, new opt-in behaviour, no change to any existing default. Full suite on the branch: 253 pass, 0 fail, 1 skipped (pre-existing), three consecutive clean runs.

## [0.49.0] - 2026-08-28

### Added

- **Four current OpenRouter free-tier models:** MiniMax M3, GLM 5.2, Dots 3 Note Preview, and Laguna S 2.1. They use the shared OpenRouter `:free` quota and expose the same OpenAI-compatible generation transport as the existing OpenRouter entries.

### Removed

- **The stale OpenAI GPT-OSS 20B free entry** was removed after it disappeared from OpenRouter's live model catalog.

## [0.48.0] - 2026-08-27

### Fixed

- **Two thirds of the dispatch temp directories were empty.** `runGenerate` created its workdir before sending the request, so every dispatch that produced no file left an empty directory behind — a missing key, a 429, a timeout, a non-JSON body, an empty completion. Measured on one developer machine: 909 of 1427 `ea-gen-*` directories held nothing but the fact that a dispatch had failed. The directory is now created when there is something to write into it, and `workdir` is `null` on the paths that write nothing (it previously pointed at an empty directory, which was never useful). The success path is unchanged.
- **CI's MCP smoke step asserted the opposite of the desired behaviour and had failed on every run since it was added.** A stdio MCP server exits as soon as its transport closes — EOF on stdin means no client, so there is nothing to serve — and a workflow step's stdin is `/dev/null`, i.e. EOF immediately. Measured: with stdin at `/dev/null` the server exits after ~290 ms; with the pipe held open it runs until killed. The step now holds the pipe open the way a real MCP host does. It also waits for the server's stdio banner instead of sampling once at a fixed two-second offset (which asserted a boot *speed* and failed a merely slow runner), and then confirms the process is still up — catching a server that announces itself and immediately dies, which the old check could not detect at all.
- **The two process-group tests were timing races and could report either answer wrongly.** Both spawned a descendant that wrote a marker file after a fixed delay (120ms / 250ms), killed the group, slept a little longer, and asserted the marker was absent. Too slow and the kill lands after the marker is already written, so a WORKING group kill fails — that is what made `runDispatch forwards parent SIGTERM to the subprocess group` go red in a loaded full-suite run while passing 3/3 in isolation. Too slow the other way and the descendant has not booted when the assertion runs, so a BROKEN group kill passes; `runDispatch timeout terminates the subprocess group` also used a 30ms dispatch timeout that could fire before the fixture had spawned anything to kill, exercising nothing at all. Both now record the descendant's PID and wait for it to stop existing, which is what "terminates the process group" actually claims and has neither failure mode. Verified by disabling the group kill in `terminate()`: both tests fail, as they must. Three consecutive full-suite runs on a machine at load average 25-70: clean.

### Added

- **`external-agents audit` now sweeps this package's stale temp directories** and reports what it removed. Not really about disk — the whole accumulation measured 9 MB — but about what is in it: `ea-gen-*` directories hold `generated.md`, the model's complete response in plain text, which on a machine used for code review means the reviewed source and the review itself sitting unencrypted in the OS temp directory until the system reclaims it, roughly a month later on macOS. The retention window defaults to 3 days; set `EXTERNAL_AGENTS_TEMP_RETENTION_DAYS` to change it, or a negative value to disable it. Nothing modified within the last 15 minutes is removed whatever the window says: the window is read as `Number(env || default)`, and while an empty string falls through to the default, `" "` is truthy and `Number(" ")` is 0 — a stray space in a shell export would otherwise have swept the workdir of a dispatch that started moments earlier. The sweep only ever touches direct children of the temp directory carrying one of this package's own prefixes, only real directories (a symlink is skipped, never followed), and only entries older than the window, so a dispatch running right now cannot lose its workdir.

Both halves of #70 concern the same directories: dispatch workdirs that held a model's full response in plain text and outlived any use for it. The CI and process-group fixes from #69 landed after 0.47.0 was cut and ride along here. MINOR because `audit` gains behaviour and a new environment variable (`EXTERNAL_AGENTS_TEMP_RETENTION_DAYS`), which in 0.x belongs in the minor position. Full suite on the release branch: 233 tests, 232 pass, 0 fail, 1 skipped (the skip is pre-existing). CI green on main at 6735c02.

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
