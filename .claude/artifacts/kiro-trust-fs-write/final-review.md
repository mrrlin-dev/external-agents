# Final review: kiro write fix + read_only transport implementation

Branch `claude/kiro-trust-fs-write` off main (3d25f2d), full diff vs origin/main
in `.claude/artifacts/kiro-trust-fs-write/` — this file supersedes `review.md`
(round 1, the fix alone) as the merge gate for the WHOLE branch.

## What this branch does (three layers, in commit order)

1. **The original bug fix.** `kiro` was registered under `edit_exists` (the
   registry's "edits files in place" transport) but its command trusted only
   `fs_read`. Two real dispatches asking it to edit files returned
   `outcome: success, files: []` after ~150s — it read the repo correctly,
   printed the patch as prose, and exited 0. Fix: trust list widened to
   `fs_read,fs_write,execute_bash`. Verified live: a canary file was rewritten
   on disk.

2. **A design-approved `read_only` transport axis** (round-2 consensus:
   anchor APPROVE + 2 pool APPROVE, 0 non-approvals — report at
   `design-report-r2.md`), because layer 1 made every reviewer dispatch of
   kiro (via `/consensus`, which runs reviewers in the LIVE repo under review)
   capable of writing to the repo it judges.

3. **The implementation** of that design, this commit:
   - `lib/dispatch.js`: `runDispatch(entry, prompt, options, transportKind)`
     — a 4th param selecting which `transports.<kind>` config to read.
     `selectTransport`: `--transport read_only` uses a declared `read_only`
     cmd, or an implicit `generate_new` (HTTP has no filesystem access at
     all). An entry with only `edit_exists` and no `read_only` throws rather
     than silently using the write-capable command.
   - `lib/dispatch.js`: new `probeReadOnlyNonWriting(entry)` — spawns the
     declared `read_only` cmd against a canary file in a scratch dir and
     confirms the file is unchanged. This operationalizes the design's
     acceptance criterion (a command is not eligible on the strength of its
     flags looking non-writing).
   - `cli.js`: `external-agents verify-read-only <id>` wraps the probe,
     non-zero exit unless verified.
   - `lib/pick.js`: fixed to recognize the same implicit-generate_new rule as
     `selectTransport` — without this, `pick --transport read_only` would
     have excluded all 20 HTTP entries, leaving only the handful of
     explicitly-declared CLI read_only commands as reviewer candidates.
   - `agents.yaml`: `read_only` declared for `kiro` and the three `claude-*`
     entries, EACH independently verified via `verify-read-only`, not
     inferred by analogy. The three claude entries deliberately omit
     `effort_levels` — testing found that `runDispatch`'s effort-flag
     insertion point (after the full cmd, i.e. after this cmd's required
     trailing `--`) makes the CLI lose the prompt entirely (reproduced twice;
     see commit message). `kiro`'s read_only cmd keeps its existing
     effort_levels — its cmd has no trailing `--`, so the insertion point is
     the same shape already relied on in production for its edit_exists cmd.
   - `~/.codex/scripts/consensus.sh`: every reviewer pick AND dispatch now
     carries `--transport read_only`. Verified end-to-end: this branch was
     temporarily `npm link`ed as the global `external-agents` package, a
     forced `--transport read_only --cwd <dir>` dispatch against both `kiro`
     and `claude-opus-4-8` left a canary file and `git status` untouched
     despite `cwd` being present (the exact condition that previously
     defaulted to the write-capable command), and a full `consensus.sh` smoke
     round completed without mutating the reviewed worktree. The global
     package was restored to the published 0.33.4 afterward.
   - `server.js`: the `dispatch` MCP tool's `transport` enum gains
     `read_only` — an MCP caller could not have requested it otherwise.
   - Tests: 12 new across `dispatch.routing`, `dispatch.progress`, a new
     `pick.test.js`, and `registry.transports`. Full suite: 92 total, 91 pass,
     1 skipped, 0 fail.
   - Version bumped 0.34.0 → 0.35.0 (new capability, not a patch).

## Evidence log (commands actually run, not just described)

- `node --test lib/*.test.js` → 92 tests, 91 pass, 1 skipped, 0 fail.
- `node cli.js verify-read-only <id>` for `kiro`, `claude-opus-4-8`,
  `claude-sonnet-5`, `claude-haiku-4-5` → all `{"ok":true,"verified":true}`.
- Negative control: `probeReadOnlyNonWriting` against a deliberately
  write-capable command → correctly returns
  `{"ok":false,"hint":"declared read_only command wrote to the canary file..."}`.
- `external-agents dispatch kiro --transport read_only --cwd <git-repo-dir>
  "edit probe.txt..."` → file unchanged, `git status` clean, despite `cwd`
  being supplied (previously the exact trigger for edit_exists preference).
  Same result for `claude-opus-4-8`.
- Full `consensus.sh` smoke round via the temporarily-linked branch → 4
  reviewers dispatched, all via `generate_new` (implicit read-only) this
  round by chance of random selection; target worktree's `git status --short`
  showed only the pre-existing edits from this session, nothing new.
- The `--effort` + trailing-`--` prompt-loss bug was reproduced twice
  independently (once before, once after an unrelated CLI session outage
  that also affected these probes) — not a one-off flake.

## Known, explicitly out-of-scope finding

`consensus.sh`'s anchor selection (`pick --tier strong --n 1`) is a generic
strong-tier pick, not a targeted `claude-opus-4-8` selection. In testing it
returned `openrouter-nemotron-super-free` instead. This predates this branch
(reproduced with the ORIGINAL published 0.33.4 package, no `--transport`
filter involved) and is independent of the read_only work — global CLAUDE.md
states `claude-opus-4-8` as the required anchor, so this is a real
discrepancy, but fixing anchor-selection logic is a different, unscoped
change. Flagging for a separate look, not blocking this merge on it.

## Question for reviewers

Is it acceptable to merge the `read_only` axis with only 4 of the 8
`edit_exists` entries carrying a declared `read_only` command (kiro + 3
claude), leaving `codex`, `codex-gpt-5.4-mini`, `cursor-agent`, and `opencode`
undeclared (they simply don't satisfy a `read_only` request yet, and are
skipped rather than guessed at)? The alternative — blocking this merge until
all 8 are verified — was rejected in the design round for the entries that
are quota-blocked through Aug 8; is that still the right call now that the
gate change is live in `consensus.sh`, since it reduces the effective
reviewer pool?
