---
name: finishing-work
description: >-
  Runs the post-merge close-out tail that no other skill owns — return to
  main and pull, delete the merged branch (shared checkout or linked
  worktree), prune stale remote-tracking refs, prompt for a tracker-row
  flip and `sync:hub`, and prompt for a work log if none was written. Use
  this skill whenever the user says /finishing-work, "clean up after this
  PR", "the PR merged, wrap this up", "finish up this branch", "close this
  out", or after `creating-prs` reports a PR as merged and the user wants
  the workspace tidied. Also invoke proactively when a merged PR's branch,
  worktree, or stale remote-tracking refs are still lying around — verified
  live in this repo's own checkout after four consecutive merges (4 stale
  remote-tracking refs, 1 stale local branch, 1 stale worktree, 1 orphaned
  spoke journal, none of it cleaned up automatically). Distinct from
  `creating-prs`, which owns everything up to and including "confirm
  mergeability" — this is the step after that one, which nothing else in
  the repo runs.

  GitHub-integration stance: ADR-0030 (amended 2026-07-27) — uses the gh CLI,
  matching `creating-prs` (this skill's direct predecessor in the same
  session): Step 1's merge-state check needs nothing beyond `gh pr view`,
  which has no GitHub MCP toolset gap to work around, so there is no reason
  to switch tools mid-workflow.
---

# finishing-work

`creating-prs` ends at Step 14, "Confirm mergeability" — it never checks
whether the PR actually merged, let alone cleans up afterward. Nothing else
in the repo owns the tail: returning to `main`, deleting the merged branch,
pruning stale remote-tracking refs, flipping a tracker row, running
`sync:hub`, or checking that a work log exists. Left undone, that residue
accumulates silently — a live audit of this repo's own checkout after four
clean merges found 4 stale remote-tracking refs, 1 stale local branch, 1
stale worktree, and 1 orphaned spoke journal, none of it caught by any gate
(`docs/research/harness-refresh.md`, `docs/adr/`). This skill is that
missing owner.

`bin/worktree-remove.mjs` and `bin/worktree-prune.mjs` both exist already but
are worktree-scoped — neither helps when work happened in the shared
checkout, `starting-work`'s documented default. This skill calls whichever
of `bin/branch-cleanup.mjs` (shared checkout) or `pnpm worktree:remove`
(linked worktree) actually applies, rather than duplicating either.

## Steps

### 1 — Confirm the PR actually merged

Don't assume "the user said it merged" is enough — verify:

```bash
gh pr view --json state,mergedAt,headRefName,baseRefName
```

- `state: "MERGED"` with a non-null `mergedAt` → proceed.
- `state: "OPEN"` → stop and tell the user it hasn't merged yet; nothing else
  in this skill is safe to run.
- `state: "CLOSED"` with a null `mergedAt` → stop; the PR was closed without
  merging. Ask whether the branch should still be cleaned up (abandoned work)
  or left alone.

Record `headRefName` — every later step operates on this branch, not
whatever the user typed.

### 2 — Return to `main` and pull

```bash
git checkout main
git pull
```

Skip this if already on `main` with nothing to pull. If the current checkout
is a linked worktree whose sole purpose was `headRefName`, skip straight to
Step 3's worktree branch instead — there is no reason to switch a
single-purpose worktree to `main` before removing it.

### 3 — Delete the merged branch

Two cases, mutually exclusive:

- **Linked worktree** (this session is running inside
  `../m3l-automation-<slug>`, per ADR-0013/0014): `pnpm worktree:remove <slug>`
  — it already removes the worktree, prunes admin entries, and deletes the
  branch if `git branch -d` accepts it (kept-and-noted otherwise). Nothing
  further needed here.
- **Shared checkout**: `pnpm branch:cleanup <headRefName>` — the
  shared-checkout equivalent, added alongside this skill. It refuses to
  delete `main` or the currently-checked-out branch, and safely keeps (never
  force-deletes) a branch `git branch -d` won't accept, printing a manual
  fallback.

If either reports the branch was **kept** (not merged into its base, or
checked out elsewhere), stop and tell the user why — don't force-delete
without asking; an un-mergeable-by-ancestry branch after a squash merge is
expected and not itself a problem (`worktree-prune.mjs`'s `[gone]`-upstream
check is the one that actually detects a squash merge; `branch -d`/`-D`
force-deletion is a separate, deliberate user decision).

### 4 — Prune stale remote-tracking refs

```bash
git fetch --prune
```

Cheap and safe regardless of which path Step 3 took — clears the
`[deleted]` markers for this and any other already-merged branch's remote
ref. Report how many refs were pruned, if any.

### 5 — Tracker row and `sync:hub`

Ask (don't assume): "Does this merge close out a tracker row in
`docs/ROADMAP.md` or `docs/implementation-status.md`?" If yes, flip the
status cell, then run:

```bash
pnpm sync:hub          # dry-run first
pnpm sync:hub -- --apply
```

matching `writing-work-logs`' documented cadence — skipping this is the
exact gap a 2026-08 audit found (two full waves of tracker updates landing
with zero GitHub representation). `check:hub-drift` alarms on `main` if this
is skipped, but running the sync is the actual fix, not the alarm.

### 6 — Work log check

```bash
ls docs/logs/ | grep <today's date>
```

If no log matching this merge's task exists yet, ask whether one should be
written now via `/writing-work-logs` before moving on — real-time context
(spoke incidents, test counts, divergences) degrades fast once the session
that did the work is gone. If a log already exists, skip silently.

### 7 — Orphaned journal sweep

```bash
find tmp -maxdepth 1 -iname '*journal*.md' -newer /dev/null 2>/dev/null
```

List any `tmp/*journal*.md` files whose age predates the merged branch's
last commit (a stray spoke journal from a dispatch on this branch that
never got cleaned up). Ask before deleting — a journal from a _different_,
still-in-progress branch may share the naming pattern.

### 8 — Report

One-line summary: branch deleted (or kept, with why), refs pruned count,
tracker flip done/skipped, `sync:hub` run/skipped, work log present/written/
skipped, journals swept/left. This is the close-out record — nothing after
this step is expected to run.

## Notes

- This skill is read-and-confirm heavy by design — every destructive step
  (branch delete, journal delete) asks first rather than assuming. The
  audit that motivated this skill found the failure mode is _silence_, not
  _wrong automatic action_ — nothing runs the tail at all today, so a
  cautious, always-asks tail is a strict improvement over the status quo of
  none.
- `bin/check-github-features.mjs` separately warns if the live repository's
  `delete_branch_on_merge` setting is off — that's the GitHub-side
  precondition for the remote branch disappearing on its own; this skill's
  Step 3/4 handle only the _local_ residue regardless of that setting.
