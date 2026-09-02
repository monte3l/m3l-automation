# Work log — `finishing-work` skill (2026-09-02)

This log covers PR #857, Slice 1 of a 3-slice remediation plan produced by an
`/auditing` pass over the repo's session-continuity and work-close-out
automations. The audit found that no skill or gate owned the tail after a PR
merges — `creating-prs` stops at "confirm mergeability" — and this checkout's
own residue (4 stale remote-tracking refs, 1 stale local branch, 1 stale
worktree, 1 orphaned spoke journal) proved the gap was live, not theoretical.
This log records what shipped, what matched the plan, what diverged, and the
close-out of PR #857 performed by the very skill it delivered.

Plan of record: `~/.claude/plans/how-the-current-automations-quiet-hoare.md`
(session plan-mode file, not yet archived under `docs/plans/`).

## Summary

Delivered a new `.claude/skills/finishing-work/SKILL.md` (+ `evals/evals.json`,
4 cases) that owns post-merge close-out end-to-end: confirm the merge via
`gh pr view`, return to `main` and pull, delete the merged branch (linked
worktree via `pnpm worktree:remove`, shared checkout via a new
`bin/branch-cleanup.mjs`), prune stale remote-tracking refs, prompt for a
tracker-row flip + `pnpm sync:hub`, and prompt for a missing work log.

New files: `bin/branch-cleanup.mjs` (CLI wrapper), `bin/lib/branch-cleanup.mjs`
(`deleteBranch`/`validateDeletable`, keep-and-notify fallback on failure),
`bin/tests/branch-cleanup.test.ts` (14 tests after the bot-review extension).
Modified: `bin/lib/github-features.mjs` (new `EXPECTED_DELETE_BRANCH_ON_MERGE`

- `cleanupWarnings`), `bin/check-github-features.mjs` (routes the warning
  through `reporter.warn`, non-fatal), `bin/tests/check-github-features.test.ts`
  (22 tests total), `package.json` (`branch:cleanup` script), and
  `bin/lib/command-catalog.mjs` (new entry + a stale-description fix on the
  pre-existing `check:github-features` entry).

`pnpm verify` passed in full (57/57 non-skipped steps) before the first push.
`docs-consistency-reviewer` ran at pre-push (docs/automation-only diff, no
`src/**` changes) and caught one Must-fix, fixed pre-push. The `claude-pr-review.yml`
bot caught one Must-fix post-push, resolved via `/resolving-pr-comments` and
pushed as `4d679cfb`. PR #857 merged into `main` at `2026-09-01T22:32:58Z`.

Skills used: auditing, researching-anthropic-guidance,
claude-code-setup:claude-automation-recommender, starting-work, writing-commits,
syncing-docs, creating-prs, resolving-pr-comments, finishing-work,
writing-work-logs.

Spoke incidents: none.

## What went as planned

- **The plan's slice boundaries held.** Slice 1 (Gap 3 — post-merge
  finalization) landed as a single, independently reviewable PR exactly as
  scoped, with Slices 2 and 3 untouched and clearly deferred.
- **`pnpm verify` was clean on first full run** — no re-dispatch to a writer
  spoke was needed to satisfy typecheck/lint/coverage/build before the first
  push.
- **The `finishing-work` skill worked end-to-end against its own PR.** Running
  it against PR #857 itself (worktree removal, ref pruning, fast-forward)
  exercised the exact linked-worktree path the skill documents, and it
  behaved as specified.
- **The hub-and-spoke boundary was respected without friction.** Every
  `bin/tests/**` edit (initial test authoring, plus the bot-review-driven
  test extension) was correctly redirected to the `test-author` spoke rather
  than attempted directly, on the first try each time.

## What didn't go as planned, and why

### 1. `deleteBranch()`'s catch block swallowed the real git error

The initial implementation of `bin/lib/branch-cleanup.mjs` had a bare
`catch {}` that returned one fixed message — "not merged into its base, or
checked out in another worktree" — for every possible `git branch -d`
failure: an unmerged branch, a nonexistent branch, a corrupt ref, or git
itself missing from `PATH`. The `claude-pr-review.yml` bot flagged this as a
Must-fix: the message actively misleads for three of those four cases, and
the function still exits 0, so a caller has no way to distinguish a real
problem from an expected safety refusal.

**Why it happened:** The original design copied `worktree-remove.mjs`'s
keep-and-notify shape without also copying forward the actual causing error —
it optimized for "never crash the caller" and lost error fidelity in the
process.

**Fix for future:** A keep-and-notify fallback must still surface the
underlying failure. Fixed by adding a `cause` field to the result (extracted
from `stderr` when present, falling back to the `Error` message, then
`String(cause)`), verified with 3 new/rewritten tests proving two distinct
failures now produce two distinguishable results — not just two non-throws.

### 2. A stale command-catalog description surfaced only at pre-push review

`bin/lib/command-catalog.mjs`'s pre-existing `check:github-features` entry
predated this PR's `delete_branch_on_merge` warning (added in an earlier
commit within the same branch) and still described the old, narrower
behavior. `docs-consistency-reviewer` caught it during the Step 7 pre-push
fan-out, not earlier.

**Why it happened:** The catalog entry lives in a different file from the
gate script it describes, so nothing forces them to change together — only a
reviewer reading both catches the drift.

**Fix for future:** Landed as a small fourth commit rather than folded into
the earlier commit that introduced the warning, since interactive rebase
(`git rebase -i`) is disallowed in this environment. When a catalog
description needs correcting after the commit that should have included it,
prefer a small standalone commit over reaching for an interactive-rebase
fold.

## Lessons learned

- **A keep-and-notify fallback must carry the real cause, not a guessed
  one.** Any function that swallows an error to return a soft "kept, not
  deleted" result needs a `cause`/`reason` field sourced from the actual
  failure (`stderr` first, then `Error.message`, then `String(cause)`) — a
  single fixed message across all failure modes is itself the defect a
  reviewer will find.
- **`docs-consistency-reviewer` earns its slot in the pre-push fan-out even
  on docs/automation-only diffs.** It caught a real catalog/gate-script
  description drift that `pnpm verify` has no gate for, on a diff with zero
  `src/**` changes — the skip-to-`docs-consistency-reviewer`-only branch in
  `creating-prs` Step 7 is doing real work, not just a formality.
- **A new skill's post-merge close-out is best proven by running it on its
  own PR.** `finishing-work`'s linked-worktree deletion path, ref-pruning
  count, and fast-forward behavior were all verified for real by running the
  skill against PR #857 itself immediately after merge, rather than only
  against a disposable fixture branch.
- **Interactive rebase is unavailable in this environment; use a small
  standalone commit instead.** When a pre-push reviewer finding logically
  belongs in an earlier commit, land it as its own small commit rather than
  reaching for `git rebase -i` to fold it in — this repo's tooling
  explicitly does not support interactive git commands here.
