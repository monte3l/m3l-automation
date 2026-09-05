# Work log — document-merge-step (2026-09-05)

This log covers solving issue #994 (H1, user-flagged high priority): giving a
human-authored PR a documented, defaulted merge-path decision. It records what
shipped across two PRs, a live push-vs-branch-deletion race that orphaned a
commit mid-flow, and the recovery.

## Summary

- `creating-prs`/SKILL.md gained `### 15 — Decide the merge path`: a defaulted
  decision (wait for the review verdict, then plain `gh pr merge --squash`;
  arm `--auto --squash` only as an opt-in for a PR expecting no review round)
  plus never-`--admin` / never-"Update branch" guardrails, both traced to live
  `gh api` settings rather than assumed.
- `finishing-work`/SKILL.md's `OPEN`-state dead-end now points at Step 15
  instead of stopping bare.
- `docs/contributing/branch-protection.md` corrected a real doc-drift finding:
  "Require branches up to date" was documented as enabled; both protection
  layers actually report `strict: false`.
- `.claude/skills/creating-prs/evals/evals.json` grew from 4 to 6 cases,
  pinning both the default (plain squash, no `--auto`, no `--admin`) and the
  opt-in (`--auto --squash` acceptable for a docs-only PR).
- Shipped as PR #1031 (`feat/document-merge-step`, merged
  2026-09-05T00:03:43Z) plus a small follow-up, PR #1032
  (`docs/fill-pr-1031-placeholder`, merged 2026-09-05T00:20:24Z) — see below
  for why the follow-up was needed.
- `docs/ROADMAP.md`'s H1 row flipped to `Done`; `pnpm sync:hub -- --apply`
  closed issue #994 and archived its now-stale board item.

Skills used: starting-work, creating-prs, resolving-merge-conflicts,
syncing-docs, writing-commits, finishing-work, writing-work-logs.

Spoke incidents: none. The `docs-consistency-reviewer` fan-out (diff was
docs/automation-only) returned a CLEAN verdict, zero Must-fix/Nit findings.

Compaction events: one, after PR #1031 was open and a 2-line follow-up commit
(filling in the real PR number in place of a `#NNN` placeholder) had been
authored locally but not yet confirmed pushed. Resumed cleanly from the
ADR-0078 handoff; the in-flight push's actual outcome is the subject of the
incident below.

## What went as planned

- All four plan-time decisions (skill placement, merge-posture default,
  doc-drift handling, tracker-flip timing) were confirmed by the user via
  `AskUserQuestion`, always the recommended option — no redirection needed.
- A real rebase conflict in `docs/plans/README.md` (a concurrent session's
  already-merged PR added a different Archive-table row at the same
  insertion point) was correctly classified as a benign table-insertion
  collision, not a logic conflict, via `/resolving-merge-conflicts` — resolved
  by keeping both rows rather than auto-picking a side.
- Every local quality gate (lint, typecheck, CLI build, `test:coverage`,
  build, `knip`, `format:check`, `lint:md`, and every targeted
  `check:review-size`/`check:context-budget`/`check:skill-frontmatter`/
  `check:skill-evals`/`check:integration-stance`/`check:cadence-doc`/
  `check:tracker-status`/`check:tracker-coverage`) passed cleanly on both PRs,
  both before and after the rebase.
- The end-to-end proof the plan itself demanded — merging PR #1031 by walking
  the new Step 15 — actually happened, twice: once for #1031 itself (default
  path, wait-for-verdict) and once for #1032 (opt-in path, `--auto --squash`
  for a trivial docs-only fix), exercising both branches of the step it
  shipped.

## What didn't go as planned, and why

### A follow-up push raced GitHub's own post-merge branch deletion, orphaning a commit

After PR #1031's review verdict was clean, a small follow-up commit was
authored on the same branch (`feat/document-merge-step`) to fill in the real
PR number (`#1031`) in place of the `#NNN` placeholder the ROADMAP row and
archived-plan narrative were written with before `gh pr create` returned a
number. Before that follow-up push completed, PR #1031 merged (squash) via
its own Step 15 default path and GitHub's `delete_branch_on_merge` setting
began deleting the remote branch. The push landed in the exact window between
those two events and was rejected by the remote:

```text
! [remote rejected]   feat/document-merge-step -> feat/document-merge-step
  (cannot lock ref 'refs/heads/feat/document-merge-step': unable to resolve
  reference 'refs/heads/feat/document-merge-step')
```

This is the mirror image of the race `finishing-work` Step 3 already
documents ("a second push can complete successfully against an
already-merged-and-deleted remote branch") — here the push was rejected
outright rather than silently succeeding against a phantom ref, which turned
out to be the safer outcome: nothing was corrupted, but the follow-up commit
was now reachable only via the local `feat/document-merge-step` branch ref,
whose sibling commit (`b899c7cd`, later showing as squash commit `6a0098e7`
on `main`) had already landed without it.

**Recovery:** `gh pr view 1031 --json state,mergedAt` confirmed `MERGED`
before attempting any retry — retrying the identical push would have been
futile, since the branch was already gone
(`git ls-remote origin refs/heads/feat/document-merge-step` returned empty).
Created a fresh branch off `origin/main` and cherry-picked the orphaned
commit onto it; the cherry-pick applied with zero conflicts because the diff
target (the `#NNN` placeholder text) was byte-identical between the
pre-squash and post-squash versions of both files. Deleted the now-empty
`feat/document-merge-step` local branch, re-ran the full gate suite plus
`check:review-size` (472 reviewable chars) on the new 2-line diff, and shipped
it as its own small PR (#1032) rather than trying to force it back into #1031.

**Why it happened:** the follow-up commit was authored and queued for push
_after_ PR #1031's checks had already gone green, on a branch already
carrying an armed (default, not `--auto`) path to merge the moment a human
decision landed — the mid-conversation compaction added enough latency for
the merge to complete first. Nothing about the sequencing itself was unusual;
the race window was just non-zero and this session's timing landed inside it.

## Lessons learned

- **A `[remote rejected] ... cannot lock ref ... unable to resolve reference`
  on a feature-branch push is the tell that the push lost a race against the
  branch's own deletion, not a transient error to blindly retry.** Before
  retrying, check `gh pr view <n> --json state,mergedAt` — if it already shows
  `MERGED`, the branch is gone for good and the fix is to cherry-pick the
  orphaned commit onto a fresh branch off the new `main`, not to re-push the
  same ref. _(promoted → .claude/skills/creating-prs/SKILL.md)_
- **A commit whose only sibling already squash-merged is not safely
  abandonable, even though the merge "succeeded."** Before any cleanup that
  deletes a branch (`finishing-work` Step 3, or an ad hoc `git branch -D`),
  check for exactly this shape — `git log <branch> ^origin/main --oneline` —
  since a squash merge means the branch's own commits are never ancestors of
  `main`, so a naive "already merged, safe to delete" read can silently drop
  a commit that never actually made it in.
  _(promoted → .claude/skills/finishing-work/SKILL.md)_
- **This is now empirically the second documented failure mode on the same
  race** (`finishing-work` Step 3's phantom-success case is the first) — a
  push updating a branch that already has (or is about to get) a merge
  landing against it is never safely queued behind that merge, regardless of
  which of the two ways it fails.
