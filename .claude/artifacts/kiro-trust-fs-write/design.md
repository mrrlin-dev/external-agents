# Design review: a read-only transport axis for external-agents

Repo: external-agents (agent registry + dispatcher), branch `claude/kiro-trust-fs-write` off main (3d25f2d).
This is a DESIGN review — no implementation exists yet for the part under review.

## Background: the bug that exposed the gap

`agents.yaml` has exactly two transport kinds today:

- `generate_new` — HTTP API call. No filesystem access at all (20 entries: gemini, groq, deepseek, openrouter, ollama).
- `edit_exists` — spawns a direct agent CLI in the caller's cwd, documented as "edits files in place" (8 entries).

`kiro` was registered under `edit_exists` but its command trusted only `fs_read`:
`kiro-cli chat --no-interactive --trust-tools=fs_read`. It was placed there deliberately, because
the `/consensus` gate needed a read-only terminal reviewer and the schema had nowhere else to put it.

The failure mode was silent. Asked to edit files, kiro read the working directory
correctly, printed the patch as prose, and exited 0 — dispatch reported
`outcome: success, exit_code: 0, files: []`. Two real dispatches burned ~150s each producing nothing.
Prompt-level insistence ("YOU MUST EDIT FILES ON DISK") had no effect, because the
constraint lived in the trust list, not the model.

The already-committed fix on this branch widens kiro's trust list to
`fs_read,fs_write,execute_bash`, verified by a live smoke test (a file was
actually rewritten on disk). That fix is not what this review is about.

## The blocking problem this design must solve

The consensus gate (`~/.codex/scripts/consensus.sh`) dispatches four reviewers.
At line 104-105 it does `cd "$cwd"` then `external-agents dispatch "$agent" ...`
— the reviewer runs in the LIVE repository being reviewed, with no worktree
isolation. The only thing stopping a reviewer from editing is line 93 of the
prompt: "Do not edit files or dispatch agents."

That is a prompt-level constraint — exactly the kind the kiro bug just proved
does not bind tool access. With kiro now writable, a kiro drawn as one of the
three random reviewers can mutate or run bash in the repo it is judging.
An earlier consensus round flagged this and REQUESTED CHANGES; it is unresolved
and currently blocks the merge.

## Empirical audit of all 8 `edit_exists` entries

Each was probed in a scratch dir: a file containing `hello`, with an instruction
to rewrite it to `GOODBYE` using file-editing tools. Result = does the file change.

| entry | command shape | writes? | basis |
|---|---|---|---|
| kiro | `kiro-cli chat --no-interactive --trust-tools=...` | was NO, now YES | probe, both before and after |
| claude-opus-4-8 | `claude --print --model ...` | YES | probe |
| claude-sonnet-5 | same shape | YES | inferred from opus probe, same binary+flags |
| claude-haiku-4-5 | same shape | YES | inferred from opus probe, same binary+flags |
| opencode | `opencode -p` | YES | probe |
| codex | `codex exec --skip-git-repo-check` | UNKNOWN | probe blocked: usage limit until Aug 8 |
| codex-gpt-5.4-mini | same shape | UNKNOWN | probe blocked: usage limit |
| cursor-agent | `cursor-agent -p --output-format text --trust` | UNKNOWN | probe blocked: usage limit |

Finding: kiro was the ONLY confirmed capability/label mismatch. The other verified
entries do what `edit_exists` promises. Three remain unverified for quota reasons,
not capability reasons — stated as unknown rather than assumed.

## Round 2 revisions (responding to round 1 anchor REQUEST CHANGES)

Round 1: anchor `claude-opus-4-8` REQUEST CHANGES, `groq-llama-3.3-70b` APPROVE,
`ollama-gpt-oss-20b` REQUEST CHANGES (with an empty must-fix list),
`deepseek-chat` ERRORED. Both must-fixes are now resolved with evidence.

**Must-fix 1 — the anchor's own read-only command (was: gate would deadlock).**
Correct and now closed. A verified read-only invocation for `claude` exists:

    claude --print --model <m> --disallowedTools Write,Edit,NotebookEdit,Bash --

Probed: the file stayed `hello`, exit 0, and the agent stated it had no tool able
to modify the file. The trailing `--` is REQUIRED — without it the variadic tool
flag swallows the prompt and the CLI dies with "Input must be provided". Note
`MultiEdit` must NOT be listed; it is no longer a known tool and its presence
aborts the run.

**Must-fix 2 — verification must gate a declared read_only entry.** Accepted and
strengthened into an acceptance criterion below, because round 2 found a live
example of exactly the label-only guarantee the anchor warned about:

    claude --print --allowedTools Read,Grep,Glob --      -> STILL WRITES the file

`--allowedTools` ADDS permissions; it does not restrict them. The invocation any
reasonable reader would call "the read-only one" is not read-only. This is the
kiro bug in mirror image, and it is why no `read_only` command may be trusted on
the strength of its flags looking right.

**Acceptance criterion (new, binding).** A `read_only` command is not eligible
for selection until it has been probed: a scratch directory containing a file,
an instruction to rewrite it with file-editing tools, and the file demonstrably
unchanged afterwards. A quota-blocked or otherwise unprobed entry declares no
`read_only` command at all — it is skipped, not assumed safe.

**Recommendations accepted.** `generate_new`'s read-only property will be
declared explicitly in the registry rather than left as reviewer knowledge.
Residual exposure is recorded as an accepted decision: a verified `read_only`
reviewer still runs in the live repo (`consensus.sh:104` `cd "$cwd"` is unchanged)
with full read access — acceptable for a reviewer, whose job is to read the repo,
and out of scope for this change.

**Q2 answered (fail-closed).** Fail-closed stays. There are no external consumers
of a `read_only` transport today because the kind does not exist yet, so there is
nothing to migrate; the only caller is `consensus.sh`, changed in the same work.

**Q4 answered.** codex, codex-gpt-5.4-mini and cursor-agent remain quota-blocked
until Aug 8. Under the acceptance criterion above they simply declare no
`read_only` command and are skipped as reviewers until probed. This is no worse
than today and does not block the axis.

## Proposed design

Add a third transport kind, `read_only`: same direct-CLI spawn mechanism as
`edit_exists`, but the command is the CLI's no-write invocation. An entry may
declare `edit_exists`, `read_only`, or both — they are separate commands, so
there is no "one agent in two modes" contradiction. Sketch:

    - id: kiro
      transports:
        edit_exists:
          cmd: "kiro-cli chat --no-interactive --trust-tools=fs_read,fs_write,execute_bash"
        read_only:
          cmd: "kiro-cli chat --no-interactive --trust-tools=fs_read"

Consumer rules:

1. `dispatch --transport read_only` selects that command; asking for `read_only`
   on an entry that has none is an explicit error, never a silent fallback to
   `edit_exists`. (Silent fallback would recreate the class of bug we just fixed.)
2. `generate_new` (HTTP) entries are read-only BY CONSTRUCTION — no filesystem
   exists in that path. They satisfy a read-only request without declaring anything.
3. `consensus.sh` requests read-only posture for every reviewer, and skips any
   agent that cannot provide one. Today's reviewer pool is mostly HTTP entries,
   which already qualify, so the practical blast radius is small.

Per-entry read-only invocations, with current verification status:

| entry | read_only cmd | status |
|---|---|---|
| kiro | `--trust-tools=fs_read` | VERIFIED not-writing (this was the original bug) |
| claude-opus-4-8 / -sonnet-5 / -haiku-4-5 | `--print --disallowedTools Write,Edit,NotebookEdit,Bash --` | VERIFIED not-writing (probed on opus) |
| codex, codex-gpt-5.4-mini | `codex exec --sandbox read-only` (candidate) | UNVERIFIED — quota-blocked, declares nothing |
| cursor-agent | drop `--trust` (candidate) | UNVERIFIED — quota-blocked, declares nothing |
| opencode | unknown | UNVERIFIED — declares nothing |
| all 20 `generate_new` entries | n/a | read-only by construction, to be declared explicitly |

## Alternatives rejected

- **Prompt-only ("Do not edit files")** — the status quo. The kiro incident is
  direct evidence that prompt text does not constrain tool access.
- **Give every reviewer a throwaway worktree.** Mitigates damage rather than
  removing capability; costs a worktree per reviewer per round; a trusted
  `execute_bash` still reaches outside the worktree.
- **Drop kiro from the reviewer pool by hardcoding an exclusion.** A point fix
  for one agent that leaves the general hole open for the next writable CLI added.
- **Drop `execute_bash` from kiro's trust list.** Narrows the radius but does not
  close the finding (writes remain), and removes kiro's ability to run the
  acceptance commands dispatch prompts ask it to report.

## Questions for reviewers

1. Is a third transport kind the right axis, or should read-only be a modifier on
   `edit_exists` (e.g. `read_only_cmd`) to avoid entries drifting out of sync?
2. Rule 1 makes a missing `read_only` a hard error. Is fail-closed right here, or
   will it break existing callers badly enough to need a migration period?
3. Is treating `generate_new` as implicitly read-only sound, or should HTTP
   entries declare it explicitly so the guarantee is visible in the registry?
4. Should the three quota-blocked entries block this design landing, or is it
   acceptable to ship the axis and fill in their read-only commands once quota
   returns on Aug 8?
