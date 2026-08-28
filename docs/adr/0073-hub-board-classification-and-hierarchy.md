# 0073. Hub board classification, hierarchy, and a single authoritative view

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deciders:** Enrico Lionello (maintainer); Claude (live-board audit + plan)

## Context and problem statement

The ADR-0032 visibility hub's board (org project **#2**,
`PVT_kwDOC6PG9c4BeLpp`) is the GitHub-side projection of `docs/ROADMAP.md` and
`docs/plans/IMPLEMENTATION.md`. Measured against the live board, the
classification that is supposed to make its backlog navigable has collapsed:

| Measured on the live board (2026-08-21) | Value                                                  |
| --------------------------------------- | ------------------------------------------------------ |
| Open items                              | 60 — 1 `0-now`, 28 `1-next`, 31 `2-later`              |
| Issue Type `Capability`                 | **48 of 60** (Friction 10, Consumer script 1, unset 1) |
| Items carrying a `Parent issue`         | **1 of 60** (#576 → #474)                              |
| Saved views                             | `Backlog` (Table), `Board` (Board)                     |
| Built-in board workflows enabled        | 1 of 6 (`Auto-add sub-issues to project`)              |

**Root cause of the 48.** `TYPE_BY_IMPLEMENTATION_SECTION`
(`bin/lib/hub-sync.mjs:219`) derives an item's Issue Type from its tracker
_section_, and one section — `## m3l-cli build-out — ADR-0042 activation
(issue #333)` — holds three entirely separate programmes: the U-series CLI
evolution wave (ADR-0053…0057), the V-series agent-operator wave
(ADR-0058…0063), and the X-series console wave (ADR-0064…0071). That is 42
tracker rows, 39 of them open, all typed `Capability` by construction. The
`gated` section's own source comment already concedes the same defect one level
down: its entries are "individually mixed (a deferred toolchain chore alongside
genuine capability gaps) but … Capability is the defensible per-row default,
with the nuance carried in the row's own detail text rather than a per-item type
override." A field that is 80% one value across a 60-item backlog carries no
information, and `Priority` is barely better: 59 of 60 items sit in just two of
its three tiers.

**The hierarchy is empty, and the one attempt at it drifted.** Issue #576 (the
B2 landing plan derived by PR #575) carries `hub-sync`, `priority:0-now`,
`type:capability` and `status:todo`, but has **no `m3l-hub-sync` marker, no
tracker row, and no native Issue Type**. It reached the board through the one
enabled built-in workflow and had its Status and Priority set by hand. Because
`toTrackedIssue` (`bin/sync-hub-projects.mjs`) returns `null` for a markerless
body, the sync cannot see it: it is an unmanaged issue wearing labels whose own
description reads "Managed by the ADR-0032 visibility hub sync — do not edit
manually." ADR-0072 requires oversized submodule work to land as several
independently reviewable slices; doing that at the scale of the nine oversized
items in the backlog would multiply this exact drift once per slice.

**Milestones are the one facet of the ADR-0051 vocabulary with no enforcement
at all.** Labels are declared in `bin/lib/label-defs.mjs:40` with a
module-load exhaustiveness assertion and a byte-for-byte `check:label-drift`
gate; the board's single-selects are declared in
`bin/sync-hub-projects.mjs:52` and reconciled by `--init`. Milestones have
none of that: `loadExistingMilestoneTitles` (`bin/sync-hub-issues.mjs:109`)
reads only `.title`, discarding `number`, `description` and `state`;
`createMilestone` (`:194`) POSTs only `title`; and `planMilestones`
(`bin/lib/hub-sync.mjs:864`) returns only `{ create }`. Consequently all five
live milestones have `description: null`, a stale `Breaking` milestone sits
beside the `2.0 / breaking` the sync keeps trying to create — which is why
`pnpm check:hub-drift` is red on `main` today — and two titles have drifted
from the tiers they name with nothing able to notice.

**`VIEW_DEFS` is not authoritative despite claiming to be.** `ensureViews`
(`bin/sync-hub-projects.mjs:433`) is documented as ensuring "the board carries
exactly `VIEW_DEFS`", but it only creates or updates views it finds by name — it
never deletes an undeclared one. The live `Backlog` view has meanwhile
accumulated `Created` and `Parent issue` columns and a `Priority ASC → Created
ASC` sort by hand; none of that is in `bin/lib/hub-views.mjs:30`, so the next
`--init --apply` would silently strip both columns, and
`MANUAL_VIEW_STEPS` (`:63`) still instructs a maintainer to sort by "Priority
ascending, then Status", which is not what the board does.

## Decision drivers

- A classification field that is 80% one value is worse than no field: it
  occupies a column, survives every gate, and answers nothing. Whatever
  replaces it must be derivable from the trackers, not hand-maintained per row.
- **Two axes are being conflated into one.** "Which ADR wave does this serve"
  and "what kind of work is it" are independent questions; forcing both through
  a single section-derived Issue Type is what produced the 48.
- Anything the GraphQL API cannot _write_ but can _read_ must become a gate, not
  a prose instruction. Both existing manual view steps have already drifted from
  the live board — the sort silently, the `Type` column deliberately — which is
  the predictable outcome of documenting an invariant nothing checks.
- ADR-0072's slice discipline needs a hierarchy the sync owns. #576 shows that
  hand-built sub-issues land outside every gate; nine more oversized items are
  queued behind it.
- Consistency by construction over consistency by convention: where a label and
  a milestone describe the same tier, one source should feed both, rather than
  two tables a reviewer must diff by eye.
- Minimal new machinery, per this repo's standing preference — prefer widening
  an existing planner, gate, or defs table over inventing a parallel one.

## Considered options

1. **Do nothing; treat the 48 as acceptable.** Rejected — the board's stated
   purpose (ADR-0032) is visibility, and the field carrying the least
   information is the one meant to answer "what kind of work is this."
2. **Split the overloaded tracker section only**, leaving the four Issue Types
   as they are. Rejected as insufficient — it would move 39 items from one
   `Capability` bucket into three, still all typed `Capability`.
3. **Retire `Capability` for a finer layer-based Issue Type vocabulary, and add
   a separate board `Programme` single-select for the wave axis**, plus a fourth
   priority tier, an epic/slice issue hierarchy, milestone parity with the label
   layer, and a single authoritative view guarded by a new drift gate. Chosen.
4. **Express the wave axis as a fifth/sixth/… Issue Type instead of a board
   field.** Rejected — Issue Types are org-wide and would then encode two
   orthogonal facts in one enum, reproducing the original conflation at a larger
   cardinality.
5. **Hand-maintain a `Type` cell per tracker row with no section default.**
   Rejected — 145 rows of hand-picked metadata with no derivation is exactly
   what `TYPE_BY_*_SECTION`'s "never hand-picked per item" comment exists to
   avoid; a per-row _override_ over a section default keeps the default honest.

## Decision

### What the API can and cannot do

Re-derived against the live GraphQL schema on 2026-08-21 rather than trusted
from `bin/lib/hub-views.mjs`'s existing comments:

| Capability                                                                         | Verdict                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `createProjectV2View` / `updateProjectV2View` / `deleteProjectV2View`              | ✅ all three exist                                                                                                                   |
| View `name`, `layout`, `filter`, `configuration.visibleFieldIds`                   | ✅ writable                                                                                                                          |
| View `sortByFields` / `groupByFields`                                              | ❌ **readable, not writable** — `ProjectV2ViewConfigurationInput` has exactly one field, `visibleFieldIds`                           |
| View `fields` (the visible-column set)                                             | ✅ **readable** — correcting an assumption to the contrary; a gate can assert it                                                     |
| Enabling the built-in `Type` column                                                | ❌ manual UI only — `ProjectV2CustomFieldType` is `TEXT`/`SINGLE_SELECT`/`MULTI_SELECT`/`NUMBER`/`DATE`/`ITERATION`, no `ISSUE_TYPE` |
| Reading whether `Type` is enabled                                                  | ✅ `ProjectV2FieldType` includes `ISSUE_TYPE`, so its **absence is gateable**                                                        |
| A new `Programme` single-select field                                              | ✅ `createProjectV2Field` + `singleSelectOptions`                                                                                    |
| `createIssueType` / `updateIssueType` / `deleteIssueType` / `updateIssueIssueType` | ✅ all exist                                                                                                                         |
| Sub-issue links                                                                    | ✅ `gh issue edit <n> --parent <p>` / `--remove-parent`, `gh issue create --parent`; readable via `gh issue list --json parent`      |
| Milestone rename / describe                                                        | ✅ `gh api -X PATCH repos/<r>/milestones/<n>` — **in place by number, preserving every issue association**                           |
| Built-in board workflows                                                           | ⚠️ readable (`id`, `number`, `name`, `enabled`); `deleteProjectV2Workflow` only — **no create or enable mutation**                   |

Two consequences shape everything below. The `Backlog` sort and the `Type`
column can only be _set by hand_ but _asserted by a gate_ — so they become
declared data plus an assertion, not prose. And `Parent issue` needs **zero**
board writes: it is a read-only projection of the issue's own parent link, so
populating it is an issue-side operation.

### One authoritative view

`VIEW_DEFS` drops the `Board` view and becomes a single `Backlog` entry, and
`ensureViews` gains orphan-view pruning via `deleteProjectV2View` so the table
finally means what its docstring says. Pruning runs only after at least one
declared view reconciled successfully and off a re-listing of the board's views,
because GitHub refuses to delete a project's last view and a view created on
this run must not be pruned by the same run.

The `Board` view is dropped rather than kept because grouping is not writable
(above), so a Board-layout view's one load-bearing setting is permanently
manual — and its Kanban reading of Status duplicates what the `Backlog` table
already shows in a column that is sorted and filterable.

`Backlog`'s declared columns become `Title, Priority, Type, Status, Milestone,
Parent issue, Labels, Created, Linked pull requests`, and its sort is declared
as machine-readable **data** (`Priority ASC`, then `Created ASC` — oldest
highest-priority work first) so the new gate can assert it. `Type` is declared
in the column list and marked optional: until a human enables the built-in
field, `resolveFieldIds` reports its absence as `info` rather than the
indefinite `warn` that ADR-0052's 2026-08-20 Update removed it to avoid. The
loud channel is the gate, not the runner.

### Issue Type — a layer-based vocabulary

`Capability` is retired. The axis becomes **which layer of the monorepo the
work lands in**, which is observable from the tracker row and stable over time:

| Issue Type           | Layer                                                      |
| -------------------- | ---------------------------------------------------------- |
| `Library capability` | `packages/m3l-common` — `core/`, `aws/`                    |
| `CLI capability`     | `packages/m3l-cli`                                         |
| `Package capability` | any other workspace package — creating **or** building out |
| `UI`                 | a browser-facing surface                                   |
| `Infrastructure`     | deployment, packaging, or runtime substrate                |
| `Fleet retrofit`     | changes to existing consumers under `scripts/*`            |
| `Tooling & gates`    | `bin/`, `.github/`, `.claude/`                             |
| `Consumer script`    | a new consumer script (unchanged)                          |
| `Friction`           | library friction / defect report (unchanged)               |
| `Governance`         | ADR / process follow-up (unchanged)                        |

`Package capability` is deliberately wider than "new package": six console
items (X3, X4, X6, X7, X8, X13) build _inside_ `m3l-console-server` without
creating it, and a `New package` type could not express them without an eighth
kind.

Derivation keeps ADR-0052's rule — a per-section default via
`TYPE_BY_IMPLEMENTATION_SECTION` / `TYPE_BY_ROADMAP_SECTION` — but gains an
optional per-row `Type` **override** column, with a dash placeholder meaning
"use this section's default". That is what lets one section hold rows of
genuinely different layers (the `gated` table's admitted mix) without either
hand-typing all 145 rows or splitting the table further. An unrecognized cell
warns and falls back to the section default rather than failing the sync;
`check:tracker-status` is the gate that makes the cell wrong-at-authoring-time
instead of silently defaulted.

### `Programme` — the second axis, board-side

[**Deferred (2026-08-28):** not implemented — see
[ADR-0081](0081-deferring-the-programme-board-field.md), which defers this
field behind an explicit revival gate. The design below is adopted unchanged;
only its timing is amended.]

The wave axis becomes a board single-select with one option per tracker section,
written per item by `sync-hub-projects.mjs` alongside Status and Priority. It is
a board field rather than an Issue Type because it is a _this-repo_ fact, not an
org-wide taxonomy, and because `createProjectV2Field` can create and reconcile
it without touching org resources.

It is not redundant with `Parent issue`: a depth-2 slice row's parent is its
_item_, so its programme is two levels up and invisible in that column.

### Priority — a fourth tier

`2-later` today conflates "real work, not yet scheduled" with "cannot start
until an external gate opens". It splits into **`2-later`** and **`3-gated`**,
driven by a new `Gated` tracker cell alongside `Now`/`Next`/`Later`. The dash
placeholder keeps meaning `p2` — it marks an untiered-but-real row, not a gated
one, so repointing it at `p3` would misfile every wave sub-table row.

`3-gated` is declared **between `2-later` and `Governance`** in
`PROJECT_PRIORITY_OPTIONS` (`bin/lib/hub-sync.mjs:1156`): a board single-select
sorts by declared option order and the `Backlog` view is `Priority ASC`, so that
position _is_ the sort semantics, not a cosmetic detail.
`bin/check-hub-keys.mjs`'s `findPriorityVocabularyMismatches` already asserts
`PRIORITY_LABELS[k] === "priority:" + PROJECT_PRIORITY_OPTIONS[k]` for every
tier, so `priority:3-gated`/`3-gated` is held consistent for free.

### Milestones join the declared-and-gated layer

A new `bin/lib/milestone-defs.mjs` mirrors `label-defs.mjs`' shape:
`{ key, title, description, legacyTitles }` plus a module-load assertion that
every `MILESTONE_TITLES` key has exactly one def and that no title is claimed by
two defs' `legacyTitles` (which would make a rename order-dependent).
`planMilestones` widens from `{ create }` to `{ create, rename, describe,
orphan }`, and `orphan` is **report-only** — a milestone matching no def is
named, never deleted, because it may still carry closed issues.

`legacyTitles` mirrors the `legacyKeys` mechanism already used for issue
markers, so every rename is an in-place `PATCH` by number that preserves all
issue associations:

| Tier         | Title                       | `legacyTitles`           |
| ------------ | --------------------------- | ------------------------ |
| `p0`         | `Now — unblock first`       | —                        |
| `p1`         | `Next — scheduled`          | `Next — consumer fleet`  |
| `p2`         | `Later — not yet scheduled` | `Later — gated/deferred` |
| `p3`         | `Gated — awaiting trigger`  | — (new)                  |
| `governance` | `Governance`                | —                        |
| `major`      | `2.0 / breaking`            | `Breaking`               |

Both renames are consistency repairs rather than preference.
`Later — gated/deferred` becomes wrong the moment `3-gated` exists, and
`Next — consumer fleet` is already wrong: of the 28 open `1-next` items exactly
2 are consumer scripts (W7 and V8), the rest being CLI, agent-operator and
console programme work. Folding `Breaking` in as `2.0 / breaking`'s legacy title also resolves the
live `check:hub-drift` failure in the sync rather than by hand.

Descriptions come from **one** source: a shared `PRIORITY_TIERS` table supplies
the same string to both `LABEL_DEFS` and `MILESTONE_DEFS`, so a tier's label and
its milestone cannot drift apart by construction. The shared string is held to
the label's asserted ≤100-character limit (`bin/lib/label-defs.mjs:130`), the
tighter of the two.

Milestones must be applied **before** any issue write, because
`gh issue create/edit --milestone` resolves by title — a rename that has not yet
landed silently fails to move every issue on the old title. This mirrors the
existing `bootstrapLabels`-before-issue-operations ordering
(`bin/sync-hub-issues.mjs:177`).

### Hierarchy — programme epics and ADR-0072 slices

Two levels, both owned by the sync:

```text
Epic — m3l console wave                    (one epic issue per tracker section)
├── X2  console-server skeleton
├── X10 run-launcher UI MVP
│   ├── X10a script list + parameter form  (ADR-0072 slice sub-rows)
│   ├── X10b launch + live SSE progress
│   └── X10c result surface
└── X12 containerization + compose
```

Epics are **derived**, not authored: one per tracker section, emitted only when
that section has at least one child, with status and priority folded up from
their children by pure functions. A zero-child guard is mandatory — a
temporarily missing heading must not conjure an epic that the next run closes as
"removed from source trackers". An epic's body is deliberately static rather
than an enumeration of its children, since enumerating would rewrite every epic
body on every child edit, and GitHub renders the sub-issue progress bar itself.

Slice sub-rows are ordinary tracker rows whose parent is derived from their row
ID, so they are marker-bearing, gated, and drift-checked like any other item —
which is precisely what #576 is not. #576 is promoted to a real B2 slice row as
part of this work.

A parent difference deliberately does **not** make an issue dirty
(`bin/lib/hub-sync.mjs:1056`): parent links are reconciled by their own planner,
so fixing a link does not trigger a full title/body/label rewrite.

### Migration scope

The overloaded section splits three ways, one per programme ADR and per existing
plan document, each gaining its own anchor, key namespace, and section-default
Issue Type — the paired-tables invariant `IMPLEMENTATION_ANCHORS` /
`IMPLEMENTATION_NAMESPACES` / `TYPE_BY_IMPLEMENTATION_SECTION` already enforce
in prose, and which a widened `check:hub-keys` assertion now enforces
mechanically:

| New section                         | Namespace        | Keys                     | Programme ADRs |
| ----------------------------------- | ---------------- | ------------------------ | -------------- |
| `## CLI evolution wave (U-series)`  | `cli-evolution`  | `impl:cli-evolution:u*`  | ADR-0053…0057  |
| `## Agent-operator wave (V-series)` | `agent-operator` | `impl:agent-operator:v*` | ADR-0058…0063  |
| `## m3l console wave (X-series)`    | `console`        | `impl:console:x*`        | ADR-0064…0071  |

The original `## m3l-cli build-out — ADR-0042 activation (issue #333)` section
**stays**, holding its shipped 8b–8g history on the unchanged `impl:cli:`
namespace. That keeps the migration at exactly the 42 U/V/X rows and leaves the
nine closed 8b–8g issues untouched. Every moved row carries `legacyKeys`
derived from the old namespace, never hand-typed, so a marker written under
`impl:cli:` still resolves to its item through the existing
`indexItemsByKey`/`viaLegacy` path rather than reading as vanished.

All 196 hub-managed issues are retyped, not only the 60 open ones, so the
archive stays queryable by the new vocabulary. Because `planIssueSync` skips
closed issues by design, this is a one-shot opt-in path rather than a change to
the routine sync. Creating and deleting org Issue Types is likewise opt-in and
off the `--apply` path: its blast radius exceeds this repo, and a preflight that
fails loudly before the first mutation is what makes the omission safe — without
it, `gh issue create --type` returns 422 partway through a ~40-issue batch.

### Board workflows: reviewed, unchanged

| #   | Workflow                       | State    | Verdict                                                          |
| --- | ------------------------------ | -------- | ---------------------------------------------------------------- |
| 4   | Auto-add sub-issues to project | ENABLED  | **Keep** — it is what puts the new slice sub-issues on the board |
| 6   | Item added to project          | disabled | Keep disabled                                                    |
| 1   | Item closed                    | disabled | Keep disabled                                                    |
| 2   | Pull request merged            | disabled | Keep disabled                                                    |
| 3   | Auto-close issue               | disabled | Keep disabled                                                    |
| 5   | Pull request linked to issue   | disabled | Keep disabled                                                    |

`applyProjectPlan` → `setItemSingleSelect` (`bin/sync-hub-projects.mjs:844`,
`:769`) already owns Status and Priority for every tracked item, so each
Status-writing workflow above would be a **second writer** against ADR-0032's
one-way markdown→GitHub contract — and `planProjectSync`
(`bin/lib/hub-sync.mjs:1203`) would revert it on the next run, making the board
flicker rather than converge. Nothing is enabled, nothing is deleted. Because
enabling is UI-only while `enabled` is readable, the state is recorded here and
left unasserted rather than gated: a gate that can detect a change it cannot
cause, for a setting nothing in the pipeline writes, would be noise.

## Consequences

- **Positive:** the two fields meant to answer "what kind of work is this" and
  "which wave does it serve" answer them independently
  [**Deferred (2026-08-28):** only Issue Type shipped — `Programme` is
  deferred per [ADR-0081](0081-deferring-the-programme-board-field.md)], with
  the worst bucket
  going from 48/60 to a spread across ten types; the backlog's biggest priority
  bucket splits along a distinction the tracker already made in prose; every
  API-unwritable board setting that previously lived in prose becomes declared
  data with an assertion, closing the loop that let both existing manual steps
  drift; ADR-0072 slices become first-class tracker rows instead of unmanaged
  hand-built issues; milestones reach parity with the label layer, and the live
  `check:hub-drift` failure is resolved by the sync rather than by hand.
- **Negative / trade-offs:** a 42-row key-namespace migration whose entire
  safety rests on `legacyKeys` being derived rather than hand-typed — get it
  wrong and 39 open issues close as "removed from source trackers" and re-file
  as duplicates, so the dry run reporting `Issues to close (0)` is a hard
  precondition; ten Issue Types is more vocabulary for an author to choose
  among, mitigated by the section default meaning the choice is usually
  "leave the dash"; retyping 136 closed issues is a large one-off burst of
  GitHub activity; orphan-view pruning is destructive to any hand-made ad-hoc
  view, which is the accepted cost of `VIEW_DEFS` being authoritative; two
  board settings remain manual and are now merely _detected_, not fixed; and
  the new gate can only assert anything when run with a `project`-scoped token,
  so under CI's default `GITHUB_TOKEN` it is a loud skip rather than a check.
- **Semver impact:** none. Tooling, trackers, and GitHub-side metadata only; no
  `packages/m3l-common` public surface changes.

## Links

- Supersedes / superseded by: **partially supersedes**
  [ADR-0052](0052-hub-board-identity-and-field-taxonomy.md) — its `Type`
  four-value vocabulary is retired for the ten layer-based types above, its
  `Priority` three-tier field gains a fourth option, and its two-view
  `Backlog`/`Board` set becomes one authoritative view; the board _identity_
  (`m3l-automation`, `HUB_PROJECT_TITLE`), the six-value `Status` field, and
  the 2026-08-20 Updates' `status:`/`type:` label coverage and `Governance`
  Priority option all remain in force. **Amends**
  [ADR-0051](0051-semantic-priority-vocabulary.md) — the three-tier priority
  vocabulary gains `3-gated`, and two of the milestone titles it set are
  renamed in place; its governance-is-not-a-tier rule is unaffected.
- Related: [ADR-0032](0032-project-management-visibility-hub.md) (the
  one-way markdown→GitHub sync contract this ADR's workflow review upholds);
  [ADR-0050](0050-github-platform-feature-stance.md) (the platform-feature
  stance; this ADR extends the adopted set to sub-issues and a second custom
  board field, and records the built-in-workflow position it was silent on);
  [ADR-0072](0072-reviewable-slice-discipline.md) (the slice discipline the
  epic/slice hierarchy exists to make trackable);
  `docs/contributing/filing-work.md` (the Priority/Type/Status legends and the
  view-setup steps, rewritten alongside this ADR);
  [`docs/plans/2026-08-21-hub-board-restructure.md`](../plans/2026-08-21-hub-board-restructure.md)
  (the seven-PR landing sequence and its migration hazards).
- Issues: #576 (the hand-built B2 landing plan promoted to a tracker row here);
  #474 (B2, whose closed-vs-`To Do` mismatch is the other half of the live
  `check:hub-drift` failure).

## Update (2026-08-22): the retained-row count was 8, not 9

The Migration-scope section above states that keeping the `m3l-cli build-out`
section "leaves the nine closed 8b–8g issues untouched." Counting the actual
rows while performing the split, it is **eight**: the ADR-0042 activation
record, 8b, 8c, 8d, 8e, the `M3LConfigParameter.secret` library prerequisite,
8f, and 8g. The 42-row figure for the moved U/V/X rows is correct (14 + 12 +
16), as is every consequence drawn from it — only the retained-row count was
wrong, and it was inherited from a synthesis rather than derived from the file.

Recorded rather than silently corrected, since this ADR is Accepted.

## Update (2026-08-22): the closed-issue backlog is untyped, not `Capability`

The Migration-scope section frames the closed half of the work as "retyping"
196 issues, and the `--retype-closed` sketch reads as if the 136 closed ones
carry `Capability`. Measured against the live repo before implementing it, they
do not:

| Live, 2026-08-22                                    | Count |
| --------------------------------------------------- | ----- |
| Closed, marker-bearing                              | 136   |
| …with **no Issue Type**                             | 131   |
| …carrying `Capability`                              | 1     |
| …already correctly typed (Friction 1, Governance 3) | 4     |
| Open, carrying `Capability`                         | 47    |

The rows sum to 136 exactly, and every count is over **marker-bearing** issues
only. The repo has 137 closed issues; the extra one is #576, which this ADR's
Context already names — closed, untyped, and markerless, so no `--retype-closed`
pass can reach it. Counting it would make the table's arithmetic disagree with
its own first row.

`--type` reached `createIssue`/`editIssue` well after most of those issues were
filed and closed, and `planIssueSync` never revisits a closed-and-resolved
issue — so the closed backlog was never typed at all. Two corrections follow:

- **`--retype-closed` backfills a type onto 131 issues; it does not move them
  off `Capability`.** Its value is a complete Type axis over the project's
  history, which is a weaker claim than "unblocks retiring `Capability`" — the
  47 open ones are what carry that, and the routine `--apply` already handles
  them, because `planIssueSync`'s `isDirty` compares `issue.type` against the
  payload.
- **Retiring an Issue Type is gated on a zero-issue census, not on ordering.**
  The Decision above sequences it as `deleteIssueType` on `Capability` "only
  after the retype pass". A precondition the runner can verify is the same
  intent without the human memory: `planIssueTypes` retires an undeclared type
  only when no issue in either state carries it, and reports it as `blocked`
  with the count otherwise. The live dry run reports `Capability` blocked at 48
  today, which is the correct mid-migration answer rather than an error.

One closed issue (#359, a W4 row dropped per ADR-0031) has a marker matching no
current tracker row, so no item can supply its type. It is reported, not
guessed.

Also settled while implementing: a kind's description is written once in
`TYPE_KINDS` (`bin/lib/hub-sync.mjs`) and read by both its `type:*` label and
its org Issue Type, extending the `PRIORITY_TIERS` arrangement this ADR
introduced for a tier's label and milestone. Issue-Type **colour** is not
shared with the label's — GitHub takes an 8-value `IssueTypeColor` enum there
against a label's hex string, so with 10 kinds exactly two pairs must share a
colour; the pairs are chosen semantically (`Infrastructure`/`Tooling & gates`,
`Consumer script`/`Fleet retrofit`).
