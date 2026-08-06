# Consensus review round

- CWD: `/Users/Vladyslav.Feninets/dev/external-agents/.claude/worktrees/kiro-trust-fs-write`

- Input: `.claude/artifacts/kiro-trust-fs-write/design.md`

- Requested reviewers: 4


## claude-opus-4-8 — NON_APPROVE

dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
dispatch: waiting for edit_exists response
**Verdict**: REQUEST CHANGES

**Critical issues** (must-fix):
1. **The required anchor's read-only command must be verified as part of landing, not deferred (answers Q4).** The consensus gate requires `APPROVE` from `claude-opus-4-8` on every round, and per your own audit `claude --print` currently *writes*. Under Rule 1 (missing `read_only` = hard error) + Rule 3 (skip agents without read-only), an anchor that has no verified `read_only` command makes the gate unable to satisfy its own quorum — the design would trade the "reviewer can write" block for a "gate can't run" block and not actually unblock the merge. The `claude` read-only invocation (`--allowedTools`/`--disallowedTools` construction) must be established and *proven non-writing* before this lands, even if codex/cursor are deferred to Aug 8.
2. **A declared `read_only` command must be verification-gated before it is trusted — a declared-but-unverified read-only cmd is the same bug class you just fixed.** The plan says commands "should not be guessed," but that norm needs to be an enforced acceptance criterion: each `read_only` entry is proven not to mutate a probe file (as kiro was) before it is eligible for selection. Otherwise `codex exec --sandbox read-only` or `cursor-agent` without `--trust` are label-only guarantees — exactly the trust-list/label mismatch that caused the kiro incident.

**Recommendations** (nice-to-have):
- On Q1: the two-separate-`cmd` shape does risk drift (the `edit_exists` and `read_only` base invocations duplicating flags), but it correctly handles agents where read-only is a wholly different invocation (codex `--sandbox` vs kiro trust flags). Accept the transport-kind axis, but consider a schema-level check/lint that flags entries whose two cmds diverge only in unexpected ways.
- On Q3: make `generate_new`'s read-only property explicit in the registry (a declared flag or documented invariant) rather than purely by-construction. The whole design is a security guarantee; an invariant that lives only in reviewer knowledge is the weakest link, and it costs one line to make it auditable.
- Note in the design that even a verified `read_only` reviewer still runs in the live repo (consensus.sh:104 `cd "$cwd"` is unchanged) with full `fs_read` — acceptable for a reviewer, but state it explicitly so the residual read-exposure is a recorded, accepted decision rather than an oversight.

**One-line bottom line**: Right axis and well-argued, but ship-blocking until the required anchor has a *verified* read-only command and verification is a gating criterion for every read-only entry — otherwise the fix is nominal, not real.
__EXTERNAL_AGENTS_TRAILER__ {"agent_id":"claude-opus-4-8","outcome":"success","exit_code":0,"duration_ms":62123,"workdir":"/var/folders/xn/9__2lhl9155288kwr5w4fpyw0000gn/T/ea-dispatch-claude-opus-4-8-ztXYy8","files":[]}


## groq-llama-3.3-70b — APPROVE

**Verdict**: APPROVE
**Critical issues** (must-fix; empty list = none): 
**Recommendations** (nice-to-have; empty list = none): 
**One-line bottom line**: The proposed design for a read-only transport axis for external-agents addresses the identified security gap and provides a sound solution for ensuring read-only access for reviewers.__EXTERNAL_AGENTS_TRAILER__ {"agent_id":"groq-llama-3.3-70b","outcome":"success","exit_code":0,"duration_ms":759,"workdir":"/var/folders/xn/9__2lhl9155288kwr5w4fpyw0000gn/T/ea-gen-groq-llama-3.3-70b-mO9f0O","files":[{"path":"generated.md","bytes":338}]}


## deepseek-chat — ERRORED



## ollama-gpt-oss-20b — NON_APPROVE

dispatch: waiting for generate_new response
dispatch: waiting for generate_new response
**Verdict**: REQUEST CHANGES  
**Critical issues** (must-fix; empty list = none):  
 - None identified.  

**Recommendations** (nice-to-have; empty list = none):  
1. Provide a clear migration plan for callers that currently rely on the silent‑fallback behaviour of `edit_exists`.  
2. Add documentation (and unit tests) showing that `generate_new` is implicitly read‑only and that the absence of a `read_only` transport is an error only when that transport is explicitly requested.  
3. Populate missing `read_only` commands (to the extent possible until quota is restored) or document how those entries are to be handled once available.  
4. Clarify in the registry schema whether `read_only` is mandatory for new `edit_exists` agents or optional.  

**One-line bottom line**: The design is sound but needs a brief migration plan, documentation, and completion of the `read_only` commands before it can be approved for merge.__EXTERNAL_AGENTS_TRAILER__ {"agent_id":"ollama-gpt-oss-20b","outcome":"success","exit_code":0,"duration_ms":13671,"workdir":"/var/folders/xn/9__2lhl9155288kwr5w4fpyw0000gn/T/ea-gen-ollama-gpt-oss-20b-A4zpNh","files":[{"path":"generated.md","bytes":931}]}


## Runner status

- Required reviewers: 4
- Responded: 3
- Approved: 1
- Anchor approvals: 0
- Random-pool approvals: 1
- Non-approvals: 2
