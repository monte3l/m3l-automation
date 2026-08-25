# Work log — A3b recovery fleet retrofit (2026-08-25)

This log covers implementing issue #485 (A3b): wiring `M3LScript.reportRecovery()`
(and, for `s3-objects`, `Core.M3LOperationPipeline`'s `recovery` callback) into
the four consumer scripts that already absorbed per-item failures but never
reported them, so a degraded-but-not-total run resolves with a `"partial"`
outcome (exit code `6`) instead of throwing or succeeding silently. Ran through
the hub-and-spoke TDD loop (test-author → code-implementer, per script,
sequentially by blast radius), a three-lens review fan-out
(`code-reviewer`/`silent-failure-hunter`/`spec-conformance-reviewer`), doc
reconciliation, and PR submission. It records what shipped, what matched the
plan, two spoke-recovery incidents and how they were resolved, and durable
lessons — one of which is promoted into the subagent-dispatch rules in this
same change set.

## Summary

Shipped PR [#658](https://github.com/monte3l/m3l-automation/pull/658) on
`fix/a3b-recovery-fleet-retrofit`, four commits ordered by blast radius
(`s3-objects` → `dynamodb-crud` → `sqs-etl` → `rds-data-sql`), plus a
tracker-flip commit. `docs/plans/IMPLEMENTATION.md`'s A3b row flipped to
Done in the PR itself, correcting its own filing (only `s3-objects` of the
four adopters actually routes through `Core.M3LOperationPipeline`; the other
three are direct `M3LScript` compositions — the filing's "two pipeline-based
scripts" claim was wrong) and recording that `sqs-etl`'s scope grew to all
three of its commands sharing the absorbed-failure pattern, not just the one
the issue named.

- `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build` all green;
  225 test files / 8414 tests (plain `pnpm test`), 1706 tests in
  `packages/m3l-common`'s coverage run.
- `pnpm sync:docs` (13 steps: provenance, doc counts, doc-exports, reference
  index, markdown lint) — clean, zero diff.
- Review verdicts: `code-reviewer` (split s3-objects+dynamodb-crud /
  sqs-etl+rds-data-sql) — no Must-fix, no Should-fix, a few nits (naming
  consistency of `name: "M3LError"` on synthetic entries, one minor
  duplication opportunity). `silent-failure-hunter` (all four scripts,
  single dispatch) — no Must-fix, no swallow patterns, resume-safety
  verified. `spec-conformance-reviewer` (split, conformance mode) — fully
  conformant both halves, one pre-existing unrelated doc nit flagged
  (`dynamodb-crud.md`'s "retried" field in its summary prose, predates this
  branch). One genuine Should-fix (two stale test-file "Contract:" docblocks
  still describing the removed throw) was fixed by a follow-up `test-author`
  dispatch before push.
- Push succeeded on the first attempt through the multi-minute `pre-push`
  hook (verify-signatures, check-script-docs, check-review-size,
  check-agents, check-file-budget, check-control-chars, typecheck,
  build-exports, format, test, lint).

Skills used: `starting-work`, `writing-commits`, `creating-prs`,
`syncing-docs`, `writing-work-logs`.

Spoke incidents: 2 mid-thought-truncated "final" reports from oversized
review dispatches (redispatched split, divergence #1) / 0 stalls / 0
resumes — plus 3 separate test-author completion-recovery incidents: 1
resolved via journal + `bin/spoke-recovery.mjs` (a truncated-looking report
that was actually complete), 2 whose journals were lost to a session
restart and were recovered by re-deriving state from the persistent git
worktree instead (divergence #2).

## What went as planned

- **RED failed for the right reason in all four scripts** — either a
  TypeScript excess-property error on the not-yet-widened deps type, or the
  still-throwing/still-silent old implementation, never a test-logic bug.
- **GREEN was clean on first pass for all four scripts** — every
  `code-implementer` dispatch delivered lint-clean, typecheck-clean,
  fully-passing code without a re-dispatch (one needed a `handleFailedRecords`
  extraction to stay under `max-lines-per-function`, handled inline by the
  same spoke).
- **`rds-data-sql`'s resume-safety contract held on the first implementation
  attempt** — the trickiest correctness property in this retrofit (a resumed
  `load` run must report only its own newly-rejected rows, never replay the
  checkpoint's carried-over `failedCount`) verified correct by both the
  `code-implementer` and, independently, `silent-failure-hunter` and the
  `spec-conformance-reviewer`, with no fix round needed.
- **No merge conflicts** — the branch stayed in sync with `origin/main`
  throughout (0 commits behind at push time), despite a peer session working
  the related A2b retrofit on overlapping files (`s3-objects`,
  `dynamodb-crud`) in parallel, per the plan's own noted concurrent-risk.
- **`pnpm sync:docs` produced zero diff** — the four doc-page edits made by
  hand during implementation were already Prettier/rumdl-clean and internally
  consistent with the regenerated catalog/index/counts.

## What didn't go as planned, and why

### 1. Two full-repo-scope review dispatches truncated mid-thought

The first `code-reviewer` dispatch (all four scripts' diffs, ~26 files) and
the first `spec-conformance-reviewer` dispatch (same scope) each returned a
"final" report that was actually a mid-thought fragment — e.g. "Lint clean.
Let's run typecheck and tests for these four scripts." — not a real
`ReportFindings`/verdict output. Both were redispatched split into two
2-script reviews each, which converged cleanly with full findings both times.

**Why it happened:** `.claude/rules/subagent-dispatch.md` already documents
this exact failure mode — "split a Phase-4 review dispatch by concern once
the diff exceeds ~3–4 files or a few hundred lines" — but the dispatch was
made at full four-script scope anyway, past that threshold.

**Fix for future:** Apply the file-count/line-count threshold from the rule
_before_ the first dispatch, not after observing a truncation. A four-script,
~60KB retrofit diff should have gone out as two 2-script review dispatches
from the start.

### 2. Two background test-author spokes were lost to a mid-session process interruption, with no journal to recover from

Partway through the fan-out, the session was interrupted (a harness/process
restart) between dispatching the `sqs-etl` and `rds-data-sql` test-author
spokes and their completion. On resume, both showed `status: stopped` with
"no completion record" and were not resumable via `SendMessage` (no live
agent). Their `/tmp` scratchpad directory from the prior session was also
gone (a fresh session gets a fresh temp dir), so `bin/spoke-recovery.mjs`
had no journal to read for either one.

Recovery: rather than treating this as lost work, `git status`/`git diff`
against the persistent worktree showed both scripts' test files already
fully edited, matching the intended design exactly (verified by reading the
diffs in full and cross-checking against the dispatch prompts' specifications).
`pnpm vitest run` on the affected files confirmed they failed RED for the
right reasons. Work proceeded from there with no redispatch needed.

**Why it happened:** A spoke's own scratchpad journal lives under the
session's ephemeral temp directory, not the repo; when the session itself is
interrupted (not just one subagent), that directory is gone on resume even
though the subagent's actual file edits — written straight into the git
worktree — persisted the whole time.

**Fix for future:** When a background agent reports `stopped`/`no completion
record` after any kind of session interruption (not just an individual
spoke's `maxTurns` truncation), check the worktree's `git diff` before
assuming lost work or attempting `bin/spoke-recovery.mjs` with a journal path
— if the journal directory itself is gone, the git worktree is the only
surviving source of truth, and it is usually still complete. This is
distinct from — and needed a different recovery path than — the
already-documented "verify a truncated spoke via its journal" pattern, since
here there was no journal to check at all. Promoted into
`.claude/rules/subagent-dispatch.md` in this same change set.

### 3. `pnpm test:coverage` flaked once on an unrelated pre-existing test under load

A full-suite coverage run failed one test —
`script-aws-provisioning-failure.test.ts`'s AWS-provisioning-seam test — with
a 5000ms timeout. The file is untouched by this branch's diff and passed
instantly (755ms) when run in isolation; a second full `pnpm test:coverage`
run was completely clean (0 failures).

**Why it happened:** Coverage instrumentation adds enough overhead under a
large parallel suite that a test with a tight fixed timeout occasionally
misses it — a pre-existing flake unrelated to this retrofit's changes.

**Fix for future:** Don't treat a single red run on an unrelated file as a
regression signal — isolate the failing file, confirm it's outside the
branch's diff, run it alone to rule out a real break, then re-run the full
suite once before concluding it's a flake. All three steps are cheap and
avoid either a false "ship it" or a wasted debugging detour into unrelated
code.

## Lessons learned

- **Apply the review-dispatch file/line threshold before the first dispatch,
  not after a truncation.** `.claude/rules/subagent-dispatch.md` already
  states the ~3–4 file / few-hundred-line threshold for splitting a Phase-4
  review; this task hit truncations by dispatching at full four-script scope
  first and splitting only in response. Pre-compute the split from
  `git diff --stat` before the first `Agent` call.
- **A spoke's scratchpad journal doesn't survive a session-level restart,
  but its git-worktree edits do.** When recovering from a `stopped`/`no
completion record` notification after any interruption broader than one
  spoke's own turn limit, check `git diff` in the actual worktree before
  reaching for `bin/spoke-recovery.mjs` — the journal path may simply no
  longer exist, and the worktree is still the durable source of truth.
  _(promoted → `.claude/rules/subagent-dispatch.md`)_
- **A coverage-instrumented full-suite run can flake under load on a test
  with a fixed short timeout, unrelated to the current change.** Isolate,
  confirm the file is outside the diff, re-run alone, then re-run the full
  suite once before calling it a flake — cheaper than either a false ship or
  a misdirected debugging session.
- **Re-deriving an issue's own filing against the current tree, even when it
  reads confidently, catches real drift.** Issue #485/A3b's own text claimed
  "two pipeline-based scripts" opt in via `M3LOperationPipelineCoreOptions.recovery`;
  the actual tree showed only `s3-objects` does — the other three are direct
  `M3LScript` compositions. Recording the correction in the tracker row
  itself (not just fixing the code silently) keeps a future reader from
  re-trusting the same wrong claim next time the row is read.
