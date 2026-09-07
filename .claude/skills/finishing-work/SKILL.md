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
none of it caught by any gate at the time. This skill is that missing owner.
`pnpm check:staleness` (issue #995 / ROADMAP H2) now _detects_ this residue
class post-merge/post-rewrite and pre-push, but it only reports — cleaning up
what it finds, and the tracker/work-log/sync:hub steps below, are still this
skill's job.

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

Also capture any slice-progress entry now, before Step 3 removes the worktree
it lives in: read `tmp/slice-progress.json` in the current worktree/checkout.
If it exists and is stamped for `headRefName`, record it for Step 8 — but what
you need depends on its mode:

- **Literal mode** (a `wave` field with no `page` field — ADR-0072's escape
  hatch for a non-submodule multi-PR wave with no committed landing-plan
  document): record the whole `{wave, current, total, label}`.
- **Derived mode with a submodule reference page** (a `page` field pointing at
  `docs/reference/<ns>/<mod>.md`): no capture needed. Step 8 re-derives the
  page path independently from `headRefName` itself (which submodule's
  `packages/m3l-common/src/{core,aws}/<mod>/` the merge touched), so it's
  unaffected by worktree removal.
- **Derived mode with a non-submodule wave's plan doc** (a `page` field
  pointing at `docs/plans/YYYY-MM-DD-<slug>.md`, ADR-0072's 2026-09-07
  amendment): record the `page` path. Unlike a submodule, there is no
  deterministic way to derive _which_ plan doc a wave's merged diff belongs
  to from the diff alone — the pointer, not the table content, is the one
  thing that dies with the worktree.

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

Squash-merged branch commits are never ancestors of `main`, so "the PR
merged" does not mean every commit on the branch landed. Run `git log
<branch> ^origin/main --oneline` before any branch-deleting cleanup — a
non-empty result is a commit about to be abandoned, not noise
(`docs/logs/2026-09-05-document-merge-step.md`).

Two cases, mutually exclusive — decide with a command, not recollection:

```bash
git rev-parse --show-toplevel        # this checkout's root
git rev-parse --git-common-dir       # differs from --git-dir in a linked worktree
git rev-parse --git-dir
```

If `--git-common-dir` and `--git-dir` resolve differently you're in a linked
worktree; `basename $(git rev-parse --show-toplevel)` gives
`m3l-automation-<slug>`. If they resolve identically you're in the shared
checkout. **Run this, don't recall it** — a mid-session compaction, a
concurrent session's close-out, or an `ExitWorktree` since the last check can
all have moved you, same as `starting-work` Step 1's re-inspection rule.
`pnpm branch:cleanup` now enforces the same discriminator itself and refuses
with the right remedy if this step is skipped or gets it wrong (issue #1004).

- **Linked worktree** (per ADR-0013/0014): `pnpm worktree:remove <slug>` — it
  already removes the worktree, prunes admin entries, and deletes the branch
  if `git branch -d` accepts it (kept-and-noted otherwise). Nothing further
  needed here. **`ExitWorktree({action: "remove"})` first, if this session
  entered the worktree via `EnterWorktree` earlier — but expect it to refuse
  with "this session is not the owner" if a mid-session compaction happened
  since entry** (ownership tracking doesn't survive one). That's not an error
  to debug: call `ExitWorktree({action: "keep"})` instead (falls back to the
  current directory), then run `git checkout main && git pull` and `pnpm
worktree:remove <slug>` from there as below
  (`docs/logs/2026-09-05-statusline-weekly-usage.md`).
- **Shared checkout**: `pnpm branch:cleanup <headRefName>` — the
  shared-checkout equivalent, added alongside this skill. It refuses to
  delete `main` or the currently-checked-out branch, and safely keeps (never
  force-deletes) a branch `git branch -d` won't accept, printing a manual
  fallback. It also refuses (exit 1) when deleting `headRefName` would strand
  a linked worktree — either it's checked out in a _different_ worktree, or
  this checkout itself is the worktree named for that branch's slug (issue
  #1004) — naming `pnpm worktree:remove <slug>` as the remedy either way.

If either reports the branch was **kept** (not merged into its base, or
checked out elsewhere), stop and tell the user why — don't force-delete
without asking; an un-mergeable-by-ancestry branch after a squash merge is
expected and not itself a problem (`worktree-prune.mjs`'s `[gone]`-upstream
check is the one that actually detects a squash merge; `branch -d`/`-D`
force-deletion is a separate, deliberate user decision).

### 4 — Prune stale remote-tracking refs and check for other residue

```bash
git fetch --prune
pnpm check:staleness
```

`git fetch --prune` is cheap and safe regardless of which path Step 3 took —
clears the `[deleted]` markers for this and any other already-merged
branch's remote ref. `pnpm check:staleness` (issue #995 / ROADMAP H2) then
reports any residue left behind: a stale worktree or local branch
`worktree:prune`/`branch:cleanup` haven't been run against yet, a
remote-tracking ref still pending prune, or an orphaned `tmp/` file (see
Step 7). It's advisory — act on what it reports, don't treat a clean run as
proof nothing needs cleanup if Step 3 already handled the branch/worktree
for this PR. Also runs automatically post-merge/post-rewrite and pre-push,
so this step mainly surfaces older residue this session didn't cause.

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

Scope lives in [`docs/logs/README.md`](../../../docs/logs/README.md): a
substance test, not a commit-type filter. Skip this step silently for a
mechanical merge with no narrative — a dependency bump, a formatting/lint
sweep, a tracker-status flip, a bare `sync:hub` run, or the `docs:` commit
that lands a log itself. Otherwise, continue:

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

`pnpm check:staleness` (Step 4) already lists any `tmp/` file older than 7
days that isn't on its live-state allowlist (`tmp/slice-progress.json`,
`tmp/compact-handoff.json`, `tmp/session-incidents.jsonl` — the weekly-usage
cache moved account-scoped, outside any repo's `tmp/`, per ADR-0092's
amendment) — this replaces an earlier `find
tmp -iname '*journal*.md'` glob here, which missed non-`*journal*`-named
orphans (a spoke's dispatch journal has no fixed naming convention;
`.claude/rules/subagent-dispatch.md` only requires a `tmp/`-scoped path).
Review its `tmp/` findings and ask before deleting — a file from a
_different_, still-in-progress branch may look identical to a genuine
orphan.

### 8 — Check for a remaining slice (ADR-0072)

One lookup, with a fallback — both a submodule and a non-submodule wave now
carry the identical durable record (ADR-0072's 2026-09-07 amendment, issue
#998): a `## Landing plan` heading and a `| Slice | [Branch |] Scope | Status |`
table, read by the same shared parser either way.

**1 — Resolve the document.** If `headRefName` (Step 1) touched
`packages/m3l-common/src/{core,aws}/<mod>/`, it's that submodule's
`docs/reference/<ns>/<mod>.md`. Otherwise, use the `page` path Step 1 captured
from a derived-mode `tmp/slice-progress.json` entry pointing at
`docs/plans/YYYY-MM-DD-<slug>.md` — there is no way to derive _which_ plan doc
a non-submodule wave's diff belongs to from the diff alone, which is exactly
why Step 1 captures that pointer before the worktree (and its `tmp/`) is gone.
If neither applies, there is no document to resolve — skip to Step 3's
literal-mode fallback.

**2 — Parse it.** Read the resolved document for a `## Landing plan` heading
and parse its slice table. If the heading is absent, or every row's Status is
terminal (`Landed`/`Shipped`/`✅`, matched by leading word — a trailing PR
citation like `Landed (PR #580)` still counts), nothing remains: run `pnpm
slice:clear` (blanks the statusline segment; a no-op if it was never set) and
proceed to Step 9, this is still the terminal case.

**If a row's Status is not terminal,** a slice remains. Don't stop here:

1. Determine the next slice's branch: if the table has a `Branch` column,
   use that row's cell verbatim — it's already settled, don't re-derive a
   slug or ask the user to confirm it. Only when the cell is empty/absent (no
   `Branch` column at all, a submodule's page never has one) does this fall
   back to deriving a slug from the row name, asking the user to confirm if
   it doesn't map cleanly. Then run `pnpm worktree:new <next-slug>` and
   `EnterWorktree path: ../m3l-automation-<next-slug>` — the same in-session
   mechanism `starting-work` Step 5 uses (ADR-0013/0014's 2026-09-04
   amendments): no restart, no second session.
2. Re-enter `starting-work` in its **abbreviated** form: skip the
   Location/Branch/PR-required/Push-target confirmation entirely — the
   landing plan's own sequence already fixes them (same branch-naming
   pattern as the slice that just merged, PR required, `origin <branch>`
   push target) — but still confirm the session name via `/rename
<kind>-<next-slug>`, since that names this specific session rather than
   settling git state. `starting-work` Step 1's "next-slice signal" is
   exactly this handoff.
3. In the new worktree, re-run `pnpm slice:set -- --page <the resolved
document>` so the statusline segment continues immediately — derived
   mode re-reads the same committed table, so this never drifts.
4. Report which slice is starting, quoting its `## Landing plan` row,
   instead of Step 9's terminal report.

**3 — Literal-mode fallback.** Only when Step 1 found no document to resolve
at all: if it captured a literal-mode entry (`{wave, current, total, label}`
— a non-submodule wave with no plan doc yet, ADR-0072's original 2026-09-04
escape hatch), the just-merged PR was slice `current` of `total`.

- **`current < total`:** a slice remains. Ask the user for the next slice's
  slug (there is no table row to derive it from) and, separately, whether
  this wave's plan doc should finally be authored — closing the gap that put
  it here. Follow the same sub-steps as above — `worktree:new` +
  `EnterWorktree`, abbreviated `starting-work` re-entry, session name — and
  in the new worktree run `pnpm slice:set -- --wave <wave> --current
<current + 1> --total <total> [--label <label>]` so the segment continues
  immediately at the next position. Report which slice is starting instead
  of Step 9's terminal report.
- **`current >= total`** (the just-merged PR was the wave's last slice), or
  Step 1 captured nothing: there is nothing to continue — proceed to Step 9
  as the terminal case. There is no `slice:clear` to run here; the entry
  lived only in the now-removed worktree's `tmp/` and is already gone.

This makes `finishing-work` a third workflow entry point wired into
ADR-0072's slice discipline, alongside `starting-work` and `creating-prs` —
see that ADR's 2026-09-04 and 2026-09-07 amendments.

### 9 — Report

One-line summary: branch deleted (or kept, with why), refs pruned count,
tracker flip done/skipped, `sync:hub` run/skipped, work log
present/written/skipped/n/a (out of scope), journals swept/left, and whether
Step 8 found a remaining slice (submodule or non-submodule wave). This is
the close-out record for a task with no remaining slice — nothing after
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
- **The asymmetry between Step 8's two cases is closed, as of ADR-0072's
  2026-09-07 amendment (issue #998).** Both a submodule and a non-submodule
  wave now read a durable, machine-checkable record — `bin/check-scaffold-seam.mjs`
  gates the former, `bin/check-landing-plans.mjs` the latter, both through the
  same `parseLandingPlanProgress`. The residual gap is narrower than before:
  Step 1 still has to capture a derived-mode entry's `page` pointer before
  Step 3 deletes the worktree, since (unlike a submodule) there's no way to
  derive which plan doc a wave's diff belongs to from the diff alone. A
  session that skips that capture (or resumes `finishing-work` mid-flow after
  the worktree is already gone) falls through to the literal-mode fallback,
  which reports nothing to continue if no `--wave` entry was ever set either
  — indistinguishable from a wave's last slice. `pnpm slice:set -- --wave`
  itself remains deliberately ephemeral and gitignored (ADR-0072's 2026-09-04
  amendment) for the one case that genuinely still has no durable record: a
  wave whose plan doc hasn't been authored yet.
