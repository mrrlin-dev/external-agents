# State: kiro write fix + read_only transport axis

Branch `claude/kiro-trust-fs-write` off main (3d25f2d). Worktree
`/Users/Vladyslav.Feninets/dev/external-agents/.claude/worktrees/kiro-trust-fs-write`.

## Goal

1. (DONE, committed, pushed) Fix kiro silently not writing files.
2. (DESIGN APPROVED, NOT IMPLEMENTED) Add a `read_only` transport kind so the
   consensus gate can dispatch reviewers that provably cannot write.

## Committed so far

- `agents.yaml`: kiro `edit_exists` cmd -> `--trust-tools=fs_read,fs_write,execute_bash`
  plus rewritten comment. CHANGELOG entry. Version bump 0.34.0 -> 0.34.1.
- Pushed to `origin/claude/kiro-trust-fs-write`. NO PR opened yet. NOT merged.

## Why the merge is blocked

Consensus round on the fix: anchor APPROVE, `claude-sonnet-5` REQUEST CHANGES.
Both flagged the same real issue, confirmed in code: `~/.codex/scripts/consensus.sh`
line 104-105 does `cd "$cwd"` then `external-agents dispatch` — reviewers run in
the LIVE repo, restrained only by prompt text at line 93. A now-writable kiro
drawn as a random reviewer could mutate the repo it is judging.
Report: `.claude/artifacts/kiro-trust-fs-write/report.md`.

## Decisions

- Resolution is the `read_only` transport axis, not a point exclusion of kiro.
- Design consensus PASSED on round 2: anchor APPROVE + 2 pool APPROVE, 0 non-approvals.
  Design: `.claude/artifacts/kiro-trust-fs-write/design.md`.
  Reports: `design-report.md` (round 1, blocked), `design-report-r2.md` (round 2, passed).
- Fail-closed: requesting `read_only` on an entry that lacks one is an error,
  never a silent fallback to `edit_exists`.
- A `read_only` cmd must be PROBED (file demonstrably unchanged) before it is
  eligible. Unprobed entries declare nothing and are skipped.
- `generate_new` (HTTP, 20 entries) is read-only by construction, to be declared
  explicitly in the registry.

## Verified facts (probed, do not re-derive)

- kiro `--trust-tools=fs_read` -> does NOT write (the original bug).
- kiro `--trust-tools=fs_read,fs_write,execute_bash` -> DOES write.
- `claude --print --model M` -> DOES write.
- `claude --print --model M --disallowedTools Write,Edit,NotebookEdit,Bash --` -> does NOT write. VERIFIED read-only cmd.
- `claude --print --allowedTools Read,Grep,Glob --` -> STILL WRITES. `--allowedTools` adds, never restricts. Trap.
- Trailing `--` is REQUIRED: the variadic tool flag otherwise eats the prompt
  ("Input must be provided either through stdin or as a prompt argument").
- `MultiEdit` is no longer a known tool; listing it aborts the run (exit 144).
- `opencode -p` -> DOES write.
- `codex exec --skip-git-repo-check`, `cursor-agent -p --output-format text --trust`
  -> UNKNOWN, both quota-exhausted until Aug 8 2026. Not a capability finding.

## Test command

`node --test lib/*.test.js` — currently 77 tests, 76 pass, 1 skipped, 0 fail.
There is no `npm test` script.

## Next three actions

1. Implement `read_only` in the registry schema + `lib/dispatch.js` selection,
   fail-closed on a missing read_only command.
2. Declare `read_only` for kiro and the three claude entries (verified cmds above);
   declare the read-only invariant for `generate_new`; leave codex/cursor/opencode
   without one. Add tests.
3. Update `~/.codex/scripts/consensus.sh` to request read-only posture and skip
   agents lacking it. Then re-run the gate on the FIX (report.md input) to clear
   the original REQUEST CHANGES, open the PR, merge.
