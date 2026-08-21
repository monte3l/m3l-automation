# 0052. Hub board identity and field taxonomy

- **Status:** Partially superseded by ADR-0073
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + implementation)

## Context and problem statement

The org-owned GitHub Project (`monte3l`, project #2, ADR-0032's visibility
hub board) was titled `m3l-automation hub`. That name was meaningful when the
board was one of several planned visibility surfaces; the repo now has one
board, so the qualifier is redundant with the repository it projects.

A repo audit (see the `/auditing` fan-out that produced this ADR) also found
the board itself carried almost no information: all 18 open items sat at
`Status = Pending`; the board's own `Priority` single-select field existed
with **zero options**, hand-created and unmanaged by any script; the org's
Issue Types were still GitHub's untouched defaults (`Task`/`Bug`/`Feature`),
unset on every item; and the board had exactly one saved view (`User`, a
Table), despite ADR-0032 having sold the board/roadmap views as part of the
reason Projects was chosen at all (ADR-0032 §Considered options). The
`Status` field's 3-value vocabulary (`Pending`/`In review`/`Done`,
ADR-0032's 2026-07-28 Update) also collapsed `Deferred` and `Blocked` into an
indistinguishable `Pending`, which the board could never surface.

## Decision drivers

- The board's own field surface should carry the same information the
  tracker rows already do (type, status, priority), not require reading the
  linked issue to find out.
- ADR-0050 established that every enabled GitHub platform feature needs a
  recorded reason ("an unrecorded 'on because nobody turned it off' stance
  is the same ambient-default problem ADR-0030 was written to eliminate…
  This ADR does the equivalent for GitHub platform features"); adopting
  project custom fields, saved views, and org Issue Types is exactly that
  kind of platform-surface adoption.
- `HUB_PROJECT_TITLE` (`bin/lib/hub-sync.mjs`) is the board's _only_
  machine-readable identity — `sync-hub-projects.mjs` resolves it by title
  string at runtime, never by its stored node ID (ADR-0032's 2026-07-22
  Update). A rename must not silently orphan that lookup.
- ADR-0051 is explicit that `governance` is a category, not a priority tier;
  any new priority-bearing surface must uphold that, not re-introduce a
  fourth tier.
- Minimize new drift surface: reuse the same option spellings the labels and
  milestones already use rather than inventing a fifth register for the same
  three tiers.

## Considered options

1. **Rename only, leave the field/view surface as-is.** Solves the naming
   redundancy but leaves the board carrying almost no information — the
   audit's larger finding goes unaddressed.
2. **Fields on the board, mirrored by new labels.** Maximum visibility, but
   creates a fifth register for the same taxonomy (labels, milestones,
   tracker cells, board fields, issue types) with drift risk on every
   registration, and requires undoing ADR-0051's deliberate `type:`/
   `priority:` mutual-exclusivity and sparse-`status:`-labelling rules.
3. **Fields only — org Issue Types for Type, project single-selects for
   Status/Priority. No new labels.** Adds exactly one new register (the
   board fields / org issue types), reuses the existing label spellings
   everywhere a value needs to match, and leaves ADR-0051's label rules
   untouched.

## Decision

We chose **option 3**.

### Board identity

The board is renamed `m3l-automation hub` → **`m3l-automation`**
(`HUB_PROJECT_TITLE` in `bin/lib/hub-sync.mjs`, changed in the same commit as
the live `gh project edit --title` rename, so the lookup and the live board
never disagree). Project #2, node `PVT_kwDOC6PG9c4BeLpp` — unchanged; only
the title moves.

`sync-hub-projects.mjs` gained a rename-detection guard: when the title
lookup misses and the owner has exactly one existing project, the run fails
loudly ("the board may have been renamed — fix `HUB_PROJECT_TITLE` rather
than running `--init`") instead of offering to create a second, empty board.
This was the one drift class nothing previously detected, since the board is
resolved by title, not a stored ID.

The Pages dashboard heading (`bin/lib/project-hub.mjs`, `"m3l-automation
project hub"`) is a **separate, deliberately unchanged** string — a
different ADR-0032 artifact, not the board title.

### `Type` — org Issue Types

Four values, replacing GitHub's three untouched defaults:

| Issue Type        | Meaning                              | Tracker series |
| ----------------- | ------------------------------------ | -------------- |
| `Capability`      | Library capability work              | A/B/C-series   |
| `Consumer script` | A new or retrofitted consumer script | W-series       |
| `Friction`        | Library friction / defect report     | F-series       |
| `Governance`      | ADR/process follow-up work           | T-series       |

Derived per tracker **section**, not hand-picked per item —
`TYPE_BY_ROADMAP_SECTION`/`TYPE_BY_IMPLEMENTATION_SECTION` in
`bin/lib/hub-sync.mjs`, keyed identically to the existing
`ROADMAP_ANCHORS`/`IMPLEMENTATION_ANCHORS` tables so a new section cannot
gain an anchor without also gaining a type. `sync-hub-issues.mjs` applies it
via `gh issue edit/create --type`; a type mismatch now also makes an issue
dirty (alongside title/body/label drift), so `check:hub-drift` catches a
hand-cleared type.

### `Status` — widened to the tracker's 6 values

`Pending`/`In review`/`Done` → **`To Do`/`In Progress`/`Blocked`/
`Deferred`/`Done`/`Rejected`** — the tracker's own vocabulary, one-for-one
(`PROJECT_STATUS_OPTIONS` in `bin/lib/hub-sync.mjs`,
`DESIRED_STATUS_OPTIONS` in `bin/sync-hub-projects.mjs`). This retires
ADR-0032's 2026-07-28 Update, which explicitly left the board at 3 values
("possible later… not needed today") — "later" arrived. The three renamed
options (`Pending`→`To Do`, `In review`→`In Progress`, `Done`→`Done`) keep
their GraphQL option ids through the migration
(`STATUS_OPTION_RENAME_SOURCE`), so every item's existing value survives
uninterrupted; `Blocked`/`Deferred`/`Rejected` are new appended options.

### `Priority` — populated to mirror the labels

The pre-existing, empty `Priority` field gets three options —
**`0-now`/`1-next`/`2-later`** — spelled identically to the
`priority:0-now`/`priority:1-next`/`priority:2-later` label suffixes
(`PROJECT_PRIORITY_OPTIONS` in `bin/lib/hub-sync.mjs`). A **governance**
item's Priority field is **cleared** (`clearProjectV2ItemFieldValue`), never
given a `Governance` option — ADR-0051's "governance is a category, not a
tier" rule extends to this new surface exactly as it already governs the
labels. `bin/check-hub-keys.mjs`'s `findPriorityVocabularyMismatches` was
widened to assert `PRIORITY_LABELS[key] === "priority:" +
PROJECT_PRIORITY_OPTIONS[key]` for every tier, so the label and the board
field can never drift into two different spellings of the same three tiers;
`findMissingTypes` similarly asserts every tracker item resolves to a real
Issue Type.

### Views

Three saved views, reconciled by `sync-hub-projects.mjs --init`
(`bin/lib/hub-views.mjs`'s `VIEW_DEFS`): **`Backlog`** (Table, filtered
`is:open`, renamed in place from the pre-existing `User` view rather than
left orphaned beside a new one), **`Board`** (Board layout), **`Timeline`**
(Roadmap layout).

**API constraint, verified against the live schema:**
`ProjectV2ViewConfigurationInput` accepts only `visibleFieldIds`;
`groupByFields`, `sortByFields`, and `verticalGroupByFields` are readable on
`ProjectV2View` but not writable through either
`createProjectV2View`/`updateProjectV2View`. So name, layout, filter, and
the visible-column set are automated; group-by, sort, and the Roadmap view's
paired date fields are **not** — those, plus enabling the built-in `Type`
field (also API-unwritable; a project must have it turned on once via its
own Settings UI before any view can show it), are a documented one-time
manual step (`bin/lib/hub-views.mjs`'s `MANUAL_VIEW_STEPS`, echoed in
`docs/contributing/filing-work.md`). The Roadmap view is paired to the
built-in `Created`/`Updated` date fields rather than a new custom date field
or milestone due-dates — no milestone in this repo carries a `due_on`, and
adding one was out of scope for this change.

## Consequences

- **Positive:** the board now carries the same Type/Status/Priority
  information the tracker rows do, in GitHub's own vocabulary; the board can
  distinguish Blocked/Deferred from a plain not-yet-started item for the
  first time; a hand-renamed board is now detected instead of silently
  duplicated; three purpose-built views exist where there was one generic
  table.
- **Negative / trade-offs:** the board's field surface now has more moving
  parts to keep in sync (`ensureSingleSelectOptions`/`ensureViews` on every
  `--init`), and three view-configuration knobs (group-by, sort, Roadmap
  date-pairing) remain permanently manual — the API does not expose them,
  not a scoping choice this ADR made. `check:github-features` deliberately
  does not (and will not) cover any of this: it is explicitly scoped away
  from Projects board views/fields, since the `project` OAuth scope the
  Actions token never carries makes that surface impossible to gate in CI —
  a hand-drifted board field or view stays undetected between maintainer-run
  `sync:hub --init --apply` invocations, the same limit `check:label-drift`
  already accepts for labels.
- **Semver impact:** none — this is internal tooling (`bin/**`) and hosted
  GitHub configuration; it does not touch `packages/m3l-common`'s `exports`
  map.

## Links

- Supersedes / superseded by: partially supersedes
  [ADR-0050](0050-github-platform-feature-stance.md) (the board identity it
  recorded at `docs/adr/0050-github-platform-feature-stance.md` §104-105 is
  superseded by this ADR's rename; its Wiki/Discussions/Projects-linking/
  Insights/Pages stance is unaffected and remains in force — this ADR only
  extends the adopted-platform-feature set to project custom fields, saved
  views, and org Issue Types, which ADR-0050 was silent on); partially
  supersedes
  [ADR-0032](0032-project-management-visibility-hub.md)'s 2026-07-28 Update
  (the board's Status field is no longer 3-value, and its "the board's own
  field set [is] untouched" framing no longer holds — `sync-hub-projects.mjs`
  now actively manages Status/Priority options and views)
- Related: [ADR-0051](0051-semantic-priority-vocabulary.md) (the label/
  milestone/tracker-cell vocabulary this ADR's `Priority` field mirrors, and
  whose governance-is-not-a-tier rule this ADR extends to a new surface);
  `docs/contributing/filing-work.md` (the priority legend, now carrying a
  Type column and the manual view-setup steps)

## Update (2026-08-20): the Roadmap view is dropped; `Type` is never a managed column

Running `pnpm sync:hub -- --apply --init` against the live board surfaced two
problems the schema check that produced the Views section above didn't catch,
because it only verified the _input type_ accepted `visibleFieldIds` in the
abstract, not that every layout accepts it in practice:

- `createProjectV2View`/`updateProjectV2View` both reject
  `configuration.visibleFieldIds` outright for `ROADMAP_LAYOUT`, with the
  exact error `"Roadmap views do not support visible fields."` (confirmed
  directly against the live API). `name`/`filter` still work without
  `configuration`, but a Roadmap view's group-by and date-field pairing were
  already unautomatable (the original Views section), leaving nothing this
  module could usefully manage. The **`Timeline`** view is dropped from
  `VIEW_DEFS` entirely rather than worked around — a view with only a name
  and a filter, and every other setting requiring a manual visit, added
  little over just creating it by hand.
- The built-in **`Type`** field being requested in `Backlog`/`Board`'s
  `fields` list warned on every `--init` run ("View field 'Type' is not on
  the board yet"), indefinitely — there is no mutation to enable a built-in
  field (`createProjectV2Field`'s `dataType` accepts only the custom-field
  types: `TEXT`/`SINGLE_SELECT`/`MULTI_SELECT`/`NUMBER`/`DATE`/`ITERATION`,
  never a built-in like `ISSUE_TYPE`), so the warning could never resolve
  itself. `Type` is removed from both views' `fields` lists; showing it as a
  board column is now purely an optional manual step
  (`docs/contributing/filing-work.md`), not something `sync:hub` manages.

The board's own Type/Status/Priority _fields_ (the org Issue Type assignment,
the Status/Priority single-selects) are unaffected — this only trims which
**views** exist and which columns they request.

## Update (2026-08-20): complete `status:`/`type:` label coverage, and a board Priority value for Governance

The original label vocabulary was partial: `status:*` covered only 2 of the
6 Status values (`deferred`/`blocked` — Deferred/Blocked/To Do were
otherwise visually identical on GitHub), and `type:*` covered only 1 of the
4 Type values (`governance`, added by ADR-0051 specifically to keep it out
of the `priority:` prefix). Governance items also had no board Priority
value at all — the field was cleared for them, per the original Decision.
Requested directly: complete both label families to full coverage, and give
Governance a board Priority value.

**`status:*` — all 6 values now labeled**
(`bin/lib/hub-sync.mjs`'s `STATUS_LABELS`): `status:todo`, `status:in-progress`,
`status:deferred`, `status:blocked`, `status:done`, `status:rejected`.
`buildIssuePayload`'s status-label lookup is now an exhaustiveness throw
(matching the existing `projectStatusOption`/`projectPriorityOption`
pattern) rather than a silent-omit ternary — every status is now expected
to always resolve a label, so a table gap must fail loud.

This creates a close-flow gap: `planIssueSync`'s `close` path (Done/
Rejected items) never called `editIssue` — only `closeIssue`, which cannot
set labels (`gh issue close` has no `--add-label`/`--remove-label`,
confirmed via `gh issue close --help`). Without a fix, a closed issue would
retain whatever stale `status:*` label it had while open (e.g.
`status:in-progress` on an issue that's now Done). Fixed: `planIssueSync`'s
resolved-item `close` entries now carry `payload` and `labelsStale`
(`managedLabelsDiffer(issue.labels, payload)`); `sync-hub-issues.mjs` gained
`syncManagedLabels()` (a label-only `gh issue edit` — no title/body/
milestone/type) called before `closeIssue` only when `labelsStale` is true,
avoiding an unconditional extra API call on every close.
`planBackfill`'s create+close path is unaffected — it already calls
`buildIssuePayload` before creating, so a backfilled Done/Rejected issue
gets the right label from creation.

**`type:*` — all 4 values now labeled**
(`type:capability`, `type:consumer-script`, `type:friction`,
`type:governance`, unchanged). `TYPE_LABELS` is re-keyed by the
`ISSUE_TYPES` display-name values (matching how `Item.type` is actually
stored) so `TYPE_LABELS[item.type]` resolves directly. `facetLabel()`
simplifies to just the priority label (or nothing for governance) — the
type label that used to stand in for governance's missing priority label
(`TYPE_LABELS.governance`) is now applied unconditionally to every item via
a separate, always-present lookup, also an exhaustiveness throw.

**Governance's board Priority: a dedicated `"Governance"` option, not
`2-later` and not a `null`-cleared field.** Asked directly whether to reuse
`2-later` or add a lower value: reusing `2-later` would make governance rows
indistinguishable from real Later-tier roadmap work under any Priority
sort/filter — exactly the conflation ADR-0051 eliminated at the label layer,
reintroduced at the board layer. `DESIRED_PRIORITY_OPTIONS`
(`bin/sync-hub-projects.mjs`) gains a 4th option, `Governance` (color
`PURPLE`); `PROJECT_PRIORITY_OPTIONS.governance` (`bin/lib/hub-sync.mjs`)
changes from `null` to `"Governance"`. This is board-only, with no
`priority:*` label counterpart — ADR-0051's "governance is a category, not
a tier" rule is unaffected; the board just no longer leaves governance rows
blank. `setItemSingleSelect`'s `null`-clearing branch
(`clearProjectV2ItemFieldValue`) stays in the code as generic, correct,
currently-unreached-by-callers capability — not worth stripping for a
now-dead path.

**Live migration:** `bin/lib/label-defs.mjs` gained 7 new `LABEL_DEFS`
entries (4 status + 3 type) plus a module-load coverage assertion — every
`PRIORITY_LABELS`/`TYPE_LABELS`/`STATUS_LABELS` value must have a matching
`LABEL_DEFS` entry, or the module throws at import time. This closes a real
failure mode: `gh issue edit --add-label <name>` fails if the label doesn't
already exist on the repo, so a table entry with no `LABEL_DEFS` counterpart
would have passed every local check silently and then hard-failed the very
first live `--apply` that needed it.

**Bug found and fixed during the live apply:** `updateSingleSelectOptions`
(`bin/sync-hub-projects.mjs`) only ever preserved an existing option's id
when the desired name appeared as a `renameSource` key (a genuine rename,
like Status's `Pending`→`To Do`). Adding the `Governance` option to a
Priority field that already had three existing, _unrenamed_ options
(`0-now`/`1-next`/`2-later`, no `renameSource` entry — nothing about them
was changing) submitted all four options with no `id`; `updateProjectV2Field`'s
`singleSelectOptions` is a full replace, not a merge, so GitHub minted four
brand-new ids and silently orphaned the three old ones — wiping every
tracked item's board Priority value. Recovered only because the very next
`planProjectSync --apply` happened to re-set every value from the tracker's
own source of truth (verified live: all 21 items' Priority values correct
afterward) — there is no such safety net in general. Fixed: the id lookup
now checks whether an option already exists under its own desired name
**first**, falling back to `renameSource` only for an actual rename — this
one change covers "add a new option alongside unchanged ones" (today's bug)
and "rename an option" (the pre-existing, still-correct Status behavior) in
a single code path.
