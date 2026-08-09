# Review: trust fs_write for kiro's edit_exists transport

Repo: external-agents (agent registry + dispatcher). Branch `claude/kiro-trust-fs-write` off `origin/main` (3d25f2d).

## Problem

`agents.yaml` registers `kiro` under the `edit_exists` transport — the registry's
only transport kind, meaning "spawns a direct agent CLI in the caller's cwd and
edits files in place". Its command trusted only `fs_read`:

    kiro-cli chat --no-interactive --trust-tools=fs_read

Consequence observed in production use: two separate dispatches asking kiro to
edit files returned `outcome: success, exit_code: 0, files: []` after ~150s, and
`git diff --stat` in the target worktree was empty. kiro read the working
directory correctly (it cited real routes, real line numbers, real code
structure) but, lacking a write tool, degraded to printing the patch as prose
("Change 1 — Find: ... Replace with: ..."). It did not error. The dispatcher
therefore reported success for work that never happened.

Adding "YOU MUST EDIT FILES ON DISK" to the prompt did not change the outcome,
because the constraint is in the trust list, not the model.

## Change

One line in `agents.yaml`:

    - cmd: "kiro-cli chat --no-interactive --trust-tools=fs_read"
    + cmd: "kiro-cli chat --no-interactive --trust-tools=fs_read,fs_write,execute_bash"

Plus a rewritten comment above the entry (the old one asserted read-only was
intentional), a CHANGELOG entry, and a 0.34.0 -> 0.34.1 patch bump.

`kiro-cli chat --help` documents exactly this form:
`--trust-tools <TOOL_NAMES>  Trust only this set of tools. Example: '--trust-tools=fs_read,fs_write'`

## Evidence

- `node --test lib/*.test.js` — 77 tests, 76 pass, 1 skipped, 0 fail.
- Live smoke test in a scratch dir with the new trust list: a file containing
  `hello` was rewritten to `GOODBYE` on disk by kiro's `write` tool in 0.4s.
  Confirms writes actually land.
- `grep -rn "trust-tools|fs_read"` over README.md, docs/, lib/, cli.js, ui.js —
  no other references. The change is confined to the registry entry.

## Rejected alternative (explicitly out of scope)

Also adding a separate `read_only` / `review` transport kind so `/consensus`
could keep dispatching kiro without write rights. Rejected by the maintainer:
a single agent entry cannot hold two mutually exclusive modes without a new
axis in the transport schema, and introducing that axis would require
re-auditing all 8 registry entries that currently use `edit_exists`. Deferred
as separate work.

## Known consequence to weigh

`execute_bash` is now trusted and unsandboxed. It is included deliberately —
dispatch prompts routinely ask kiro to run acceptance commands (typecheck,
`git diff --stat`) and report real output, which is impossible without it. The
effect is that kiro is now exactly as privileged as every other writer in the
pool, and must be given its own worktree. Reviewers: say so if you think
`execute_bash` should be dropped and acceptance commands run by the orchestrator
instead.

## Questions for reviewers

1. Is `fs_read,fs_write,execute_bash` the correct minimal trust list, or is
   `execute_bash` an unnecessary privilege escalation here?
2. Is a patch bump (0.34.1) right, or does changing an agent's effective
   capabilities warrant a minor bump?
3. Any failure mode where a now-writable kiro breaks an existing consumer that
   relied on it being read-only (e.g. the /consensus reviewer path)?

The full diff is at `.claude/artifacts/kiro-trust-fs-write/diff.patch` (61 lines).
