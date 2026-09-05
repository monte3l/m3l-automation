---
name: finishing-work
description: >-
  Runs the post-merge close-out tail creating-prs doesn't: return to main and
  pull, delete the merged branch, prune stale remote refs, prompt for a tracker
  flip + sync:hub, prompt for a work log. Use for /finishing-work, "clean up
  after this PR", "the PR merged, wrap this up", or when a merged
  branch/worktree/refs linger. GitHub stance: gh CLI (ADR-0030), matching
  creating-prs.
---

# finishing-work

`creating-prs` ends at Step 15, "Decide the merge path" — it owns the merge
itself, but nothing checks whether that merge actually happened, let alone
cleans up afterward. Nothing else in the repo owns the tail: returning to
`main`, deleting the merged branch, pruning stale remote-tracking refs,
flipping a tracker row, running `sync:hub`, or checking that a work log
exists. Left undone, that residue accumulates silently — a live audit of this
repo's own checkout after four clean merges found 4 stale remote-tracking
refs, 1 stale local branch, 1 stale worktree, and 1 orphaned spoke journal,
none of it caught by any gate (`docs/research/harness-refresh.md`,
`docs/adr/`). This skill is that missing owner.

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
- `state: "OPEN"` → stop, but not with a bare "it hasn't merged yet": the PR
  isn't merged because the merge decision hasn't been made, and that decision
  now has a home. Point back at `creating-prs` Step 15, "Decide the merge
  path" — nothing else in this skill is safe to run before that step resolves.
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

**Before removing anything, confirm no backgrounded command (a `git push`,
`pnpm verify`, or similar) is still running against the worktree or branch
you're about to delete.** `pnpm worktree:remove` deletes the working
directory outright; a still-running background push's pre-push hook
(`lint`/`typecheck`/`test`) executing inside that same directory fails with
confusing `ENOENT`/`MODULE_NOT_FOUND` errors the instant the directory
disappears out from under it — the commit itself survives (it's already in
the local git object database once committed, and `worktree:remove` only
deletes the worktree, not a branch `git branch -d` refuses as unmerged), but
the push doesn't, and recovery means rebuilding a branch and cherry-picking
(`2026-09-02-statusline-widgets.md`). Treat "the user says the PR merged" as
confirmation the PR merged, not as confirmation every command this session
started against that branch has finished — check for one before Step 3 runs.
This compounds with a separate, common race: once a PR has GitHub auto-merge
armed, a `git push` updating it after opening is racing the merge, not safely
queued behind it — a second push can complete "successfully" against a
already-merged-and-deleted remote branch, or (as above) get caught by
`finishing-work` running concurrently. If a follow-up commit must land in the
_same_ PR, verify the push landed and the PR still shows it as HEAD _before_
proceeding to Step 3, or accept it may need a follow-up PR instead.

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

**If a log is written here, commit it immediately** (its own small `docs:`
commit via `/writing-commits`) before moving on to any other task, rather
than leaving it as an uncommitted file for "the user's next step." A log
written mid-session and then left uncommitted while the session switches
branches or worktrees becomes invisible to any later PR — and a later PR's
own docs referencing it by name (a plan archive, a README row) will cite a
file that doesn't actually exist yet, catchable only by a downstream
reviewer (`docs/logs/2026-09-04-check-no-docker.md`, divergence #2: PR2's
work log sat orphaned in the shared checkout through all of PR3's setup).

### 7 — Orphaned journal sweep

```bash
find tmp -maxdepth 1 -iname '*journal*.md' -newer /dev/null 2>/dev/null
```

List any `tmp/*journal*.md` files whose age predates the merged branch's
last commit (a stray spoke journal from a dispatch on this branch that
never got cleaned up). Ask before deleting — a journal from a _different_,
still-in-progress branch may share the naming pattern.

### 8 — Check for a remaining slice (ADR-0072)

Only applies when `headRefName` (Step 1) landed part of a submodule — the one
case with a durable, machine-checkable slice record today
(`bin/check-scaffold-seam.mjs`'s `LANDING_PLAN_HEADING`). A non-submodule
multi-PR task (X8/X11/X12-style) has no equivalent record and is out of this
step's scope — see `## Notes` below.

If the just-merged work touched `packages/m3l-common/src/{core,aws}/<mod>/`,
read that submodule's `docs/reference/<ns>/<mod>.md` for a `## Landing plan`
heading and parse its slice table. If the heading is absent, or every row's
Status is `Landed`, nothing remains — run `pnpm slice:clear` (blanks the
statusline's slice-progress segment; a no-op if it was never set) and proceed
to Step 9 as today, this is still the terminal case.

**If a row's Status is not `Landed`,** a slice remains. Don't stop here:

1. Derive the next slice's slug from that row (ask the user to confirm if
   the row name doesn't map cleanly to a slug), then run `pnpm worktree:new
<next-slug>` and `EnterWorktree path: ../m3l-automation-<next-slug>` —
   the same in-session mechanism `starting-work` Step 5 uses (ADR-0013/0014's
   2026-09-04 amendments): no restart, no second session.
2. Re-enter `starting-work` in its **abbreviated** form: skip the
   Location/Branch/PR-required/Push-target confirmation entirely — a
   landing plan's own sequence already fixes them (same branch-naming
   pattern as the slice that just merged, PR required, `origin <branch>`
   push target) — but still confirm the session name via `/rename
<kind>-<next-slug>`, since that names this specific session rather than
   settling git state. `starting-work` Step 1's "next-slice signal" is
   exactly this handoff.
3. Report which slice is starting, quoting its `## Landing plan` row,
   instead of Step 9's terminal report.

This makes `finishing-work` a third workflow entry point wired into
ADR-0072's slice discipline, alongside `starting-work` and `creating-prs` —
see that ADR's 2026-09-04 amendment.

### 9 — Report

One-line summary: branch deleted (or kept, with why), refs pruned count,
tracker flip done/skipped, `sync:hub` run/skipped, work log present/written/
skipped, journals swept/left, and (submodule work only) whether Step 8 found
a remaining slice. This is the close-out record for a task with no remaining
slice — nothing after this step is expected to run.

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
- Step 8's remaining-slice check is submodule-scoped by design — it reads
  the one durable slice record `check-scaffold-seam.mjs` already enforces.
  A non-submodule multi-PR task (a process/tooling change spanning several
  PRs, X8/X11/X12-style) has no equivalent record; tell the user Step 8
  found nothing to continue automatically rather than silently treating the
  task as finished, and file a tracker row if a durable record for that
  case is worth building later — this pass deliberately did not invent a
  second mechanism.
