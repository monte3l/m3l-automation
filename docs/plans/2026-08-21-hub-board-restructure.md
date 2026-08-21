# Hub board restructure — implementation plan (2026-08-21)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0073](../adr/0073-hub-board-classification-and-hierarchy.md),
  which partially supersedes
  [ADR-0052](../adr/0052-hub-board-identity-and-field-taxonomy.md) and amends
  [ADR-0051](../adr/0051-semantic-priority-vocabulary.md), plus 2026-08-21
  Update blocks on ADR-0042, ADR-0053, ADR-0058 and ADR-0064.
- **Trackers:** [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) carries the live
  status of the rows this plan restructures; this file carries the sequencing
  and the migration hazards behind them.

## Why this plan exists

The board's classification collapsed to a single value — 48 of 60 open items
typed `Capability` — because `TYPE_BY_IMPLEMENTATION_SECTION`
(`bin/lib/hub-sync.mjs:219`) derives Issue Type from the tracker section, and
one section had accumulated three separate programmes. ADR-0073 records the
taxonomy that replaces it. This plan exists because _landing_ that taxonomy is
a seven-PR migration with a 42-row key-namespace change at its centre, and the
ordering constraints between those PRs are not obvious from the ADR: several of
them make a push-only gate go red on `main` until the next one lands, and one
of them can close and re-file 39 open issues if a single derived field is wrong.

## Scope and sequencing

Seven PRs, per ADR-0072's docs-vs-code split axis. PRs 1 and 3 are docs-only
and measure ~0 reviewable chars against `claude-pr-review.yml`'s `is_ignored`
predicate, so they are free to review.

| PR  | Branch                                 | Contents                                                    |
| --- | -------------------------------------- | ----------------------------------------------------------- |
| 1   | `docs/hub-board-restructure-decisions` | ADR-0073, the ADR status/Update notes, `filing-work.md`     |
| 2   | `feat/tracker-type-vocabulary`         | `project-hub.mjs` cell classifiers + the 3 section headings |
| 3   | `docs/tracker-programme-split`         | the 42-row move, `Type` column, re-tiering, slice sub-rows  |
| 4   | `feat/hub-sync-planners`               | `hub-sync.mjs` tables, epics, `planParentLinks`, defs files |
| 5   | `feat/hub-sync-runner`                 | `sync-hub-issues.mjs` — milestones, parents, preflight      |
| 6   | `feat/hub-board-views`                 | `hub-views.mjs` rewrite, view pruning, `Programme` field    |
| 7   | `feat/check-hub-views-gate`            | the new `check:hub-views` gate and its 4-place registration |

A maintainer-local apply session follows PR 7; `sync:hub` needs the `project`
OAuth scope and never runs in CI.

## Ordering constraints

These are the non-obvious ones — the reason this plan is a committed record
rather than a mental note:

- **PR 2 strictly before PR 3.** PR 3 introduces the first `Gated` Priority
  cell and the first `Type` cell. `check:tracker-status` rejects both until PR
  2's `classifyPriorityCell` branch and `classifyTypeCell` exist, so the
  reverse order puts `main` in a red state that only the next PR can clear.
- **`legacyKeys` is the whole migration.** Every one of the 42 moved rows must
  carry its old `impl:cli:<slug>` key as a legacy alias, derived from
  `IMPLEMENTATION_NAMESPACES` rather than hand-typed. Without it,
  `planIssueSync` reads all 39 open issues as removed from the source trackers,
  closes them, and files 39 duplicates. **Acceptance test: the dry run must
  report `Issues to close (0)` before any `--apply`.** Treat a non-zero count
  as an abort, not a warning.
- **Milestones before issues.** `gh issue create/edit --milestone` resolves by
  title, so a rename that has not yet landed silently fails to move every issue
  on the old title. This mirrors the existing
  `bootstrapLabels`-before-issue-operations ordering
  (`bin/sync-hub-issues.mjs:177`).
- **Org Issue Types before any `--type` write.** `gh issue create --type` 422s
  partway through a ~40-issue batch otherwise, leaving GitHub half-migrated.
  A preflight that reads `organization.issueTypes` and refuses to proceed is
  what makes this safe.
- **`Backlog` reconciles before any view is pruned.** GitHub refuses to delete
  a project's last view, and a view created on the current run must not be
  pruned by that same run — hence the re-list rather than reusing the stale
  name map.
- **`--init --apply` then immediately `--apply`.**
  `updateProjectV2Field.singleSelectOptions` is a full replace; inserting
  `3-gated` risks option-id churn, and the second run re-setting every item's
  Priority from the trackers is the only recovery path.
- **Land and apply in one maintainer session.** Between merging PR 5 and
  running the sync, the push-only `check:hub-drift` and `check:label-drift`
  gates are red on `main` — label descriptions changed, 42 keys changed, and
  the derived epics are not yet filed.

## Pre-existing state this must not build on top of

Both were found while auditing the live board, and both are resolved by this
work rather than worked around:

- **`check:hub-drift` is already red on `main`.** The `2.0 / breaking`
  milestone does not exist while a stale `Breaking` does, and #474 is closed
  while its tracker row still reads `To Do`. The milestone half is fixed by
  folding `Breaking` in as `2.0 / breaking`'s legacy title, so the sync renames
  it in place instead of orphaning it.
- **Issue #576 is an unmanaged issue wearing managed labels.** It carries
  `hub-sync`, `priority:0-now`, `type:capability` and `status:todo` with no
  marker, no tracker row and no native Issue Type. It is the template this
  plan replaces: PR 3 promotes it to a real B2 slice row.

## Definition of done

- All seven PRs merged; `pnpm verify` green on `main`.
- The apply session run to convergence — the `sync:hub` dry run comes back
  empty, and `check:hub-drift`, `check:label-drift` and the new
  `check:hub-views` are all green.
- On the live board: one view, `Type` and `Parent issue` populated, no item
  typed `Capability`, and the six declared milestones each carrying a
  description that matches its `priority:*` label's.
- This file `git mv`d into [`archive/`](./archive/) with a landing date, and a
  row added to this directory's Archive table.
