# Work log — logs-index-drift (2026-09-05)

Two sequenced PRs closing the `docs/logs/README.md` index-drift loop: PR 1
added an advisory gate, a `/writing-work-logs` skill step, and a maintenance
note; PR 2 backfilled every row the gate flagged. This records what shipped,
what diverged, and the durable lessons from both.

Plan of record: [`docs/plans/archive/2026-09-05-logs-index-drift.md`](../plans/archive/2026-09-05-logs-index-drift.md)

## Summary

- **PR 1 (#1046)**: `bin/lib/logs-index.mjs` (pure functions:
  `parseIndexLinks`, `listLogFiles`, `checkCoverage`, `checkDangling`,
  `checkDuplicates`, `checkDateMismatch`, `checkLogsIndex`) and
  `bin/check-logs-index.mjs` (new advisory gate, `pnpm check:logs-index`,
  `process.exit(0)` always), wired into all five registration surfaces
  (`package.json`, `lefthook.yml`, `CLAUDE.md`, `ci.yml` +
  `bin/lib/verify-steps.mjs`, `bin/lib/command-catalog.mjs`).
  `bin/tests/check-logs-index.test.ts` — 24 cases, mutation-tested by
  `test-author`. `.claude/skills/writing-work-logs/SKILL.md` Step 3 gained
  the "add the index row in the same commit" instruction, folded into the
  existing step rather than inserted as a new numbered one (Steps 4/5 are
  cited by number from three other live docs). `docs/logs/README.md` gained
  a "Maintaining this index" section. `docs/research/retrospective.md`'s
  stale "backlog is currently zero" prose was corrected;
  `logs-considered=135` was deliberately left untouched.
- **PR 2 (#1049)**: backfilled 83 rows (the plan's original count was 81;
  a few more logs landed during PR 1's review cycle) across four extended
  tables (Consumer-fleet, X-series, U-series, V-series) and four new wave
  sections (`core/pipeline` migration, Agent-reliability/A-series, Bedrock,
  Harness/statusline). `pnpm check:logs-index` now reports zero findings,
  152/152 logs indexed.
- Both PRs squash-merged clean; all CI lanes (Analyze ×2, Dependency Review,
  Detect changed paths, Secret scan, `review`, `Test`, `verify`, `Run skill
evals`) passed on both.

Skills used: starting-work, writing-commits, syncing-docs, creating-prs,
finishing-work, writing-work-logs.

Spoke incidents: 1 truncation (test-author hit its 40-turn limit mid-task on
its first PR1 dispatch; work was confirmed complete on disk and re-verified
manually rather than assumed failed) / 0 stalls / 0 resumes.

Compaction events: 1 compaction / 1 recovered via handoff — the PreCompact
handoff captured branch/PR state, the plan file, and pending-task context
cleanly; no state was lost across the boundary.

## What went as planned

- The gate's four checks (coverage, dangling, duplicate, date-mismatch) were
  designed and implemented cleanly against the two prior divergence logs as
  evidence — no redesign needed after the mutation-testing pass.
- The `docs-consistency-reviewer` dispatch on PR 2's 83-row backfill came
  back completely clean: zero Must-fix, zero Should-fix, including on the
  four new wave-section placements that were flagged upfront as a judgment
  call.
- The deliberate rename/restore round-trip verification (renaming a log file
  mid-review to confirm both coverage and dangling-link checks fire, then
  restoring it) worked exactly as designed and left the tree clean.
- `pnpm sync:docs` passed all 13 steps on both PRs with zero reconciliation
  changes needed — the backfill touched only `docs/logs/README.md`, nothing
  provenance-tracked.

## What didn't go as planned, and why

### 1. The row-link regex only captured the first link on a multi-log row

`bin/lib/logs-index.mjs`'s original `parseIndexLinks` used a non-global regex
with a single `.exec()` call per line, so a row citing two logs (e.g. a
close-out row) would silently drop the second link from `checkCoverage`'s
denominator. `claude-pr-review`'s delta review on PR 1 flagged it as a
Should-fix — the verdict was otherwise PASS with zero Must-fix, and standing
instructions said to merge on that verdict, but this was a real, cheap,
correctness-relevant gap in code whose entire job is link parsing. Fixed by
switching to a module-level `/g` regex consumed via `text.matchAll`, plus a
regression test asserting both links from a two-log row are captured with
the same date/line. A second delta-review confirmed the fix (verdict: PASS,
zero new findings, explicitly noting the `/g` regex's statelessness under
`matchAll`).

**Why it happened:** The original implementation was written against the
single-link case (every row observed in the README at design time), and the
"link more than one log" case was documented as a possibility in the module's
own header comment but never covered by a test until review caught it.

**Fix for future:** When a module's own doc comment names an edge case as
possible-but-unobserved, write the test for it at implementation time, not
after a reviewer catches the gap — "documented as possible" is a test-case
list, not just prose.

### 2. `git rebase origin/main` hit conflicts across 6 files with a concurrent peer PR

PR 1's rebase before push conflicted on `package.json`, `lefthook.yml`,
`CLAUDE.md`, `ci.yml`, `bin/lib/verify-steps.mjs`, and
`bin/lib/command-catalog.mjs` — a concurrent peer PR (#1044, the
`check:staleness` gate) had touched the exact same five registration
surfaces this task's own gate registration touched, in the same
"add one new list/table entry" shape. Resolved as an additive union merge
(keep both entries in each file) rather than escalating to
`/resolving-merge-conflicts`, judging this fell within that skill's
narrowed-away class (derived-artifact/list-entry conflicts, not real
`src/`/test logic).

**Why it happened:** Two unrelated PRs both added a new `check:*` gate in
the same session window, and every new gate touches the same five
registration surfaces by design (`package.json`, `lefthook.yml`, `CLAUDE.md`,
`ci.yml`+`verify-steps.mjs`, `command-catalog.mjs`) — this collision class is
structural, not incidental, whenever two gate-adding PRs overlap.

**Fix for future:** An additive union merge is the correct default for a
same-shape "two PRs each add one list/table entry" conflict across these five
files specifically — resolve it directly rather than treating every rebase
conflict as an automatic hand-back to `/resolving-merge-conflicts`.

### 3. `ExitWorktree({action: "remove"})` refused ownership twice after mid-session compaction

At both PR 1's and PR 2's close-out, `ExitWorktree({action: "remove"})`
refused with "this session is not the owner of the worktree," because
ownership tracking doesn't survive a mid-session compaction (both worktrees
were entered before the session's one compaction event). The documented
fallback — `ExitWorktree({action: "keep"})`, then `git checkout main && git
pull` and `pnpm worktree:remove <slug>` from the shared checkout — worked
cleanly both times, including correctly detecting and force-deleting a
squash-merged branch `git branch -d` wouldn't remove on its own.

**Why it happened:** This is documented, expected behavior
(`finishing-work`'s Step 3 already names this exact recovery pattern) — not
a new discovery, but it fired twice in one session because both close-outs
happened after the same single compaction event.

**Fix for future:** None needed — the existing fallback pattern worked
exactly as documented both times. Noting it here mainly to confirm the
pattern holds under repeated triggering within one session, not as a new
lesson.

### 4. PR 2's backfill scope grew from 81 to 83 between plan-writing and execution

The plan (written before PR 1 merged) counted 81 missing rows. By the time
PR 2 actually branched — after PR 1 merged and its own review cycle
completed — four more logs had landed, two of which were newly un-indexed
and needed placement the plan hadn't anticipated. Re-running
`node bin/check-logs-index.mjs` at PR 2's start (rather than trusting the
plan's static file list) caught this immediately; the two new logs were
placed into the wave sections their content matched
(`context7-mcp-load-bearing` and `trim-oversized-rule-files` into Workflow/
infra, `statusline-weekly-usage` into the new Harness/statusline section,
`work-log-scope` into Workflow/infra) without needing to re-plan.

**Why it happened:** A plan authored in one session and executed after an
intervening PR merge is inherently working against stale state — any set
derived from "files currently in this directory" is a snapshot, not a fact
that holds until execution.

**Fix for future:** Re-derive a plan's "current missing/uncovered set" at the
start of execution rather than trusting the plan document's own count,
whenever there's a merge (or any other state-changing event) between
planning and execution — this is the same discipline `CLAUDE.md`'s Task
Workflow section already names ("Re-derive any authored claim you're about
to act on").

## Lessons learned

- **Test the edge case a doc comment names as possible.** If a module's own
  header comment says "X could happen, here's how we'd handle it," write
  the test for X at implementation time — don't wait for a reviewer to
  notice the untested branch.

- **Additive union merge is the right default for same-shape registration
  conflicts.** When two PRs each add one entry to the same small set of
  gate-registration files (`package.json`, `lefthook.yml`, `CLAUDE.md`,
  `ci.yml`+`verify-steps.mjs`, `command-catalog.mjs`), resolve directly as
  a union rather than treating it as a hand-back case — this collision
  shape is structural whenever two gate-adding PRs overlap in the same
  window, not signal that something needs deeper judgment.

- **Re-derive a plan's target set at execution time, not just its
  decisions.** A plan's decisions (scope, layout, gate strictness) stay
  valid across a merge boundary; a plan's _census_ (file counts, missing-row
  lists) does not. Re-run the actual detection command at the start of
  execution rather than trusting a number written in an earlier session.

- **A reviewer's Should-fix can be worth fixing even under a "merge fast"
  instruction, when it's cheap and the module's entire job is the thing
  the gap is in.** Stating the reasoning transparently to the user, rather
  than silently deviating from an instruction to merge on PASS, kept the
  judgment call visible and uncontested.
