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

## Documentation reconciliation

Three rows in [`README.md`](./README.md)'s Archive table (the CLI-evolution,
agent-operator and m3l-console decision waves) record what each wave produced,
including `impl:cli:u*` / `impl:cli:v*` / `impl:cli:x*` and, for the U-series,
`Capability type`. Those statements are **accurate history and stay true until
PR 3/PR 4 land** — the namespaces and the type vocabulary do not change before
then, so rewriting them in PR 1 would make the table wrong at that moment
instead of right.

Reconcile them in **PR 3**, in the same change that actually moves the rows, and
by _appending_ a forward reference rather than rewriting the historical claim —
e.g. `impl:cli:u*` → ``impl:cli:u*`, re-homed to `impl:cli-evolution:u*` by
ADR-0073``. The Archive table indexes frozen plans; its rows describe what
shipped, so the fix is to point at current state, not to restate history as if
it had always been this way.

The archived plan files under `archive/**` themselves are **not** touched —
they are explicitly frozen, and `archive/**` is excluded from `lint:md`.

## Definition of done

- All seven PRs merged; `pnpm verify` green on `main`.
- The apply session run to convergence — the `sync:hub` dry run comes back
  empty, and `check:hub-drift`, `check:label-drift` and the new
  `check:hub-views` are all green.
- On the live board: one view, `Type` and `Parent issue` populated, no item
  typed `Capability`, and the six declared milestones each carrying a
  description that matches its `priority:*` label's.
- The three Archive-table rows reconciled per the section above (PR 3).
- This file `git mv`d into [`archive/`](./archive/) with a landing date, and a
  row added to this directory's Archive table.

## Update (2026-08-22): PR boundaries corrected against the gates

The seven-PR table above split "tracker vocabulary" (PR 2) from the
`hub-sync.mjs` constant tables (PR 4), and put the three new section headings
in PR 2 ahead of the tables in PR 3. Reading the gates rather than the prose,
neither boundary holds. Four assertions force a different split:

- `bin/check-hub-keys.mjs:199` — `PRIORITY_LABELS.p3` requires a
  `MILESTONE_TITLES.p3`, and `:208` requires an identically-spelled
  `PROJECT_PRIORITY_OPTIONS.p3`.
- `bin/lib/label-defs.mjs:143-162` — any `TYPE_LABELS` entry with no
  `LABEL_DEFS` row **throws at module load**, so the type vocabulary and its
  labels are one atomic unit.
- `bin/check-hub-keys.mjs:246` — `findMissingTypes` validates every item's type
  against `Object.values(ISSUE_TYPES)`, so PR 3 cannot author a `Type` cell
  before the new type names exist.
- `bin/lib/project-hub.mjs`'s `extractImplementation` pushes an error for a
  section whose table is missing, and **both** `bin/gen-project-hub.mjs:138`
  and `bin/check-hub-keys.mjs:271` exit 1 on any extraction error. Registering
  a heading before its table therefore fails `check:hub-keys` in the same
  `pre-push` that would land it, and would break the Pages build on `main`.

Corrected boundaries:

| PR  | Contents                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | **The vocabulary.** Cell classifiers (`Gated` tier, `classifyTypeCell`, `findOffVocabularyTypeCells`), all `hub-sync.mjs` constant tables, `resolveType` per-row override, `LABEL_DEFS`, `check:tracker-status`'s Type half.                  |
| 3   | **The move.** The three section headings _and_ their tables together, plus the anchors/namespaces/section blocks with `legacyKeys`, the row move, `Type` cells, re-tiering and slice sub-rows. Docs **and** ~30 lines of code, not docs-only. |
| 4   | **The behaviour.** Epics, `planParentLinks`, the `planMilestones` widening, and `milestone-defs.mjs` with the shared `PRIORITY_TIERS` descriptions.                                                                                           |

`milestone-defs.mjs` and `PRIORITY_TIERS` stay in PR 4 deliberately: nothing in
PR 3 reads them, and a "shared" description table with one consumer is
premature. `MILESTONE_TITLES.p3` lands in PR 2 as a bare string because
`check:hub-keys` demands it there.

PR 3 loses its docs-only, ~0-reviewable-chars property as a result. That is the
right trade: a heading and the table it matches cannot be separated without
failing a gate, and the alternative — making the three new sections optional in
`extractImplementation` — would weaken a real invariant to accommodate a
transient state.

## Update (2026-08-22b): PR 4 split; the `major` milestone resolves as an orphan

PR 4 as tabled held two independent concerns — milestones and the epic/slice
hierarchy. Split so each is separately reviewable, matching the reasoning that
split PR 3:

| PR  | Contents                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4a  | **Milestones**, end to end: `milestone-defs.mjs`, the shared `PRIORITY_TIERS`, the two renames, `planMilestones`' four outputs, the runner's `patchMilestone` path, the gated section's `p2`→`p3`, and `check:hub-keys`' three-map parity assertion. |
| 4b  | **Hierarchy**: derived per-section epics, `planParentLinks`, and the `planIssueSync`/`planBackfill`/`Item`-typedef changes they need.                                                                                                                |

The runner's milestone read had to move into 4a rather than waiting for PR 5:
`planMilestones`' parameter widened from `string[]` to
`{ number, title, description, state }[]`, and a planner whose contract has
changed under a runner still passing strings is a runtime break that
`check:hub-drift` would hit immediately.

**A live-state hazard the plan did not anticipate.** The plan assumed `major`
would rename `Breaking` → `2.0 / breaking`. Re-deriving against the live repo,
**both titles now exist** — `2.0 / breaking` was created at some point between
the plan being written and PR 4a starting. GitHub rejects a `PATCH` that would
duplicate an existing title, so renaming blindly would 422 mid-apply.

`planMilestones` therefore resolves **title match before legacy match**: a def
whose current title exists live claims that milestone, and any milestone holding
one of its `legacyTitles` becomes an `orphan` instead. `Breaking` is that
orphan, and being report-only it is named for a maintainer to decide rather than
deleted — deleting a milestone strips it from every issue that ever held it, and
this one holds closed history.

That is also why `orphan` is excluded from the drift verdict: an orphan nobody
intends to remove would otherwise make `check:hub-drift` permanently red.

**`3-gated` reached 8 open items, not the ~13 the ADR estimated** — 5 from the
programme waves plus C1, C2 and the TypeScript 6→7 hold, once the gated
section's blanket move to `p3` landed. Open spread is 28 / 23 / 8.

## Update (2026-08-22c): epic model, and two unreachable states

Three decisions in PR 4b departed from the plan, each from measuring rather than
reading:

- **Epics are keyed per declared section, not per issue-key namespace.**
  ROADMAP Priority 1's rows namespace themselves per wave (`roadmap:W3:...`,
  from each row's own Wave cell), so a namespace-keyed model would scatter one
  documented section across seven epics.
- **An epic is emitted only while its section has unresolved work.** The plan
  specified a zero-child guard. Against the real trackers that yields 19 epics,
  12 created and closed in the same run because their sections are fully
  shipped — and invisible on a board filtered `is:open`. The guard yields 7.
  Accepted wart: when a section's last row lands its epic stops being emitted
  and closes via the vanished-item path, so the close reason reads "removed
  from source trackers" rather than "completed".
- **`pending` entries carry the child's own issue number.** Without it, a
  first-time sync would file the epics in run 1 and link nothing, because
  `parentPlan` is computed against pre-apply state and every existing child of
  a not-yet-filed epic lands in `pending` rather than `set`. One `--apply` now
  files 7 epics and links all 59 children.

Two states turned out unreachable, found while writing tests rather than
assumed:

- **`parentPlan.clear` cannot fire from real data** — every non-epic item is
  unconditionally assigned a `parentKey` and epics are skipped. The branch is
  kept as the recovery path for a future section block authored without one,
  and is covered by a synthetic item at the planner level.
- **`pending` alone is not constructible** — it fires only when an epic has no
  issue, which is precisely the condition that puts that epic into
  `issuePlan.create`. This strengthens the decision to exclude `pending` from
  the drift verdict: it does not merely risk double-reporting, it always would.

### Dispatch note

Four spokes on this PR truncated at 40–41 tool calls, the `maxTurns` ceiling.
The common factor was not output volume — the two that finished their writes
truncated only in their final report. What burned turns was **discovery**: a
spoke asked which fixture yields which items spends twenty-odd calls finding
out. Pre-resolving those facts in the brief (for instance: "this fixture pair
emits exactly `roadmap:p0:ck1` plus `epic:roadmap:p0`, and a truly-empty plan
also needs the child's `parent` scripted") reduced the next dispatch to a few
calls.

`.claude/rules/subagent-dispatch.md` bounds a spoke's **output** (≤40 tests, one
file). The sharper constraint is bounding its **input discovery** — resolve the
facts the spoke would otherwise derive, and hand it the answers.

## Update (2026-08-22d): PR 5 split, and the closed backlog is untyped

PR 5 is split the same way PR 4 was, and for the same reason — the two halves
answer different questions and one is a one-shot:

- **PR 5a — Issue-Type provisioning** (`feat/hub-issue-type-provisioning`): the
  apply-path preflight, `--init-issue-types`, `TYPE_KINDS`, and
  `bin/lib/issue-type-defs.mjs`. This is the piece that unblocks
  `sync:hub --apply` at all.
- **PR 5b — `--retype-closed`**: a `planClosedRetype` planner plus its narrow
  `gh issue edit --type` runner path. Genuinely separate: it reconciles nothing
  and runs once.

### The measurement that changed the design

The plan describes `--retype-closed` as retyping the 136 closed issues, framed
as moving them off `Capability`. Measured against the live repo first:

| Live, 2026-08-22            | Count |
| --------------------------- | ----- |
| Closed, marker-bearing      | 136   |
| …with **no** Issue Type     | 131   |
| …carrying `Capability`      | 1     |
| …already correctly typed    | 4     |
| Open, carrying `Capability` | 47    |

Counts are over **marker-bearing** issues only, so the closed rows sum to 136
exactly. The repo has 137 closed issues; the extra is markerless #576.

`--type` reached `createIssue`/`editIssue` long after most of those issues were
closed, and `planIssueSync` never revisits a closed-and-resolved issue — so the
closed backlog was never typed at all. `--retype-closed` therefore **backfills**
a type onto 131 issues; it is not what unblocks retiring `Capability`. The 47
open ones are, and the routine `--apply` already handles them, because
`isDirty` compares `issue.type` against the payload.

### Retirement is a precondition, not an ordering

The plan sequences the delete as "`deleteIssueType` for `Capability` only after
the retype pass" — a rule a human has to remember at the right moment.
`planIssueTypes` expresses the same intent as a condition it can check: an
undeclared live type is retired only when the issue census (open **and** closed)
shows nothing carries it, and is otherwise reported as `blocked` with the count.
The live dry run reports `Capability` blocked at 48, which is the correct
mid-migration answer rather than an error. It also drops the hardcoded
`Capability` name — "undeclared" is derived from `ISSUE_TYPES`, so a future
retirement needs no second edit.

### The preflight cannot be on the `--check` path

`check:hub-drift` runs in CI (`ci.yml`, push-only) with the Actions
`GITHUB_TOKEN`, which is repo-scoped; Issue Types are an **org** resource. A
preflight there would fail the gate for a permission reason unrelated to tracker
drift. So it runs on `--apply` only — verified by the 9 existing `--apply`
runner tests going red the moment it landed, and the dry-run and `--check` tests
staying green.

### Dispatch note (F27 applied)

The three test spokes for this PR were briefed with every fact pre-resolved —
the exact failing test names, the exact unscripted `gh` argv, the rule helper to
add, and the precise reason `isMutatingIssueCall` needed widening. This is the
input-discovery discipline F27 files; the contrast with PR 4b's four truncations
is the point.

One such pre-resolved fact was itself a defect found while briefing:
`isMutatingIssueCall` treats `api … -X …` as the mutation signature, so it
cannot see a `gh api graphql` mutation, which carries no `-X`. Matching on
`graphql` alone would be wrong in the other direction, since the preflight read
is also a `gh api graphql` call — the predicate has to key off the operation
keyword.

## Update (2026-08-22e): PR 5b shipped; F27's issue filed ahead of the session

`--retype-closed` landed as `planClosedRetype` (pure) plus `runClosedRetype`
(I/O). Live dry run: **131 closed issues to retype, 1 unmatched** — matching the
census in Update 5d exactly. Only one of the 131 is a genuine
re-classification (#474, `Capability` → `Library capability`); the other 130 are
`(no type) → <type>` backfills.

Three properties worth naming, since each is a deliberate narrowing:

- **Type-only edit.** `setIssueType` issues `gh issue edit <n> --type <name>`
  and nothing else, rather than reusing `editIssue`. Reusing it would rewrite
  131 finished issues' titles, bodies, labels and milestones to correct one
  field, and would post fresh activity on every one of them.
- **Preflight sits after the dry-run return**, so a dry run needs no org read
  access at all — the same reasoning that keeps it off `runIssueSync`'s
  `--check` path, applied one level down. `gh issue edit --type` 422s on an
  unknown name exactly as `create` does, so the apply path still needs it.
- **`unmatched` is report-only and does not fail the command.** #359's tracker
  row is gone, so nothing can supply its type; counting it as failure would make
  `--retype-closed` permanently non-clean.

### F27's issue was filed by hand, convergently

At the maintainer's direction, `impl:friction:f27` was filed as
[#596](https://github.com/monte3l/m3l-automation/issues/596) before the apply
session rather than by it — the tracker row had merged (#594) but no issue
existed, and the rest of the session is still pending.

It converges rather than diverging, and that was the condition for doing it:

| Field         | Filed as                     | Resolves to                                                            |
| ------------- | ---------------------------- | ---------------------------------------------------------------------- |
| marker        | `impl:friction:f27`          | matches — the sync files no duplicate                                  |
| type / labels | `Friction` + all four labels | already correct                                                        |
| milestone     | `Next — consumer fleet` (#2) | the session's in-place `PATCH` renames #2, carrying this issue with it |
| parent        | unset                        | `planParentLinks` sets it once `epic:impl:friction` exists             |

The payload came from `buildIssuePayload(item)` rather than being hand-written,
with only the milestone title swapped for its `legacyTitles` entry — the
declared title does not exist live yet. Verified: the next dry run plans **7
creates instead of 8** (the epics alone) and lists F27 in no `update` bucket, so
the bytes match what the sync itself would have produced.

The one thing that made this safe is a property PR 4a built deliberately: a
milestone rename is a `PATCH` by number, so associations survive. Filing under
the _declared_ title would have failed outright (it does not exist); filing with
**no** milestone would have been worse than either, because `isDirty` ignores
milestone and the gap would never have been repaired.
