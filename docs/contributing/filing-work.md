# Filing work: from a rough idea to a tracked issue

This is the piece the rest of `docs/contributing/` didn't cover: where does an
idea start, and how does it become real, tracked work? Read this before
proposing a change of any size larger than a typo fix.

## The core fact: a tracker row is not a suggestion, it's a filed issue

`docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` are not a backlog of
things someone might do — they are the **source of truth GitHub Issues get
synced from**. Adding a row to either tracker and running
`pnpm sync:hub -- --apply` creates a real GitHub issue for it, with a priority
label and a milestone, and from then on `pnpm check:hub-drift` holds CI to
keeping GitHub in sync with that row (ADR-0032). A tracker row is filed,
approved work, not a place to jot something down.

That's deliberate — it's what makes the trackers reliable — but it means
there is no low-friction place to think out loud _before_ something is ready
to become a row. This repo has two, split by audience.

## The two inboxes

```text
PRIVATE board draft  ──approved──▶ convert to issue ──▶ tracker row ──▶ sync:hub --apply
PUBLIC  Ideas thread ──approved──▶ create issue from ──▶ tracker row ──▶ sync:hub --apply
                                    discussion
```

- **Private — a draft item on the GitHub Project board** (`m3l-automation`,
  linked to this repo, kept private — ADR-0050). Use this for a
  half-formed thought that isn't ready for anyone else to see yet: open the
  board, `+ Add item`, type a title, done. It never becomes a GitHub issue on
  its own — `bin/sync-hub-projects.mjs` only ever touches project items that
  already have an issue attached, so a draft is invisible to the sync and
  never archived or overwritten by it (verified in code, not assumed — see
  ADR-0032's 2026-08-19 Update).
- **Public — a [Discussions "Ideas"
  post](https://github.com/monte3l/m3l-automation/discussions/categories/ideas)**
  (ADR-0050). Use this for something worth other people seeing or weighing in
  on — an open-ended design question, a proposal someone external might want
  to comment on. Discussions also has a
  [Q&A category](https://github.com/monte3l/m3l-automation/discussions/categories/q-a)
  for support questions that aren't a bug report or a feature request; see
  [`.github/SUPPORT.md`](../../.github/SUPPORT.md).

Rule of thumb: **private is for an unfinished thought, public is for
something worth discussing.**

## Promoting an idea into filed work

Once an idea is actually ready to be worked on:

1. **From a board draft:** open it and convert it to an issue (the board's
   own "Convert to issue" action). It lands as a real GitHub issue in this
   repo, but is still untracked by the sync until step 2.
2. **From a Discussion:** use the discussion's `⋯` menu → "Create issue from
   discussion". Same result — a real issue, still untracked until step 2.
3. **Add a tracker row.** Pick the right table:
   - `docs/ROADMAP.md` — coarse, prioritized status (Priority 0/1/2, plus a
     Governance section). Registered `##`-level headings:
     `Priority 0`, `Priority 1`, `Priority 2`, `Governance follow-ups`.
   - `docs/plans/IMPLEMENTATION.md` — the detailed per-item backlog. Registered
     `##`-level headings: `Library friction (F-series)`, `ADR-0035 rollout`,
     `Capability-deepening wave`, `Post-comparison hardening wave`,
     `m3l-cli build-out`, `CLI evolution wave (U-series)`,
     `Agent-operator wave (V-series)`, `m3l console wave (X-series)`,
     `Codified-procedure engine wave`, `AWS getter reality`,
     `Gated library modules & deferred decisions (Later)`. The last three
     programme waves were split out of `m3l-cli build-out` by ADR-0073, which
     keeps that section for its own shipped 8b–8g history.
   - **Adding a new `##`-level section to either file?** Run
     `pnpm check:tracker-coverage` right after — an unregistered heading with
     a `Status` column is a silent no-op to the sync, which is exactly the
     failure mode that check exists to catch.
   - Every row's `Status` cell must be one of six values: **Done · To Do · In
     Progress · Deferred · Blocked · Rejected** (`pnpm check:tracker-status`
     enforces this). Priority is `Now`/`Next`/`Later` or a dash placeholder
     where the table doesn't carry a Priority column — see the legend below
     for what each tier means and how to pick one.
   - The row becomes the issue's join key: `sync-hub-issues.mjs` writes an
     `<!-- m3l-hub-sync:<key> -->` marker as the first line of the issue body
     and matches on that marker alone — never on title text. Run
     `pnpm check:hub-keys` after adding a row (or renaming an item's label) to
     catch a key collision before it reaches GitHub.

   **Priority legend** (ADR-0051 — what each tier means and when to pick it;
   `bin/lib/hub-sync.mjs`'s `PRIORITY_LABELS`/`MILESTONE_TITLES` are the
   values the sync actually applies; `PROJECT_PRIORITY_OPTIONS` — ADR-0052 —
   is the same three tiers projected onto the board's own `Priority` field):

   | Cell    | GitHub label       | Milestone                           | Board Priority field | Pick this when…                                                                                         |
   | ------- | ------------------ | ----------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
   | `Now`   | `priority:0-now`   | `Now — unblock first`               | `0-now`              | the item blocks other work landing — do it before more scripts consume the library.                     |
   | `Next`  | `priority:1-next`  | `Next — scheduled`                  | `1-next`             | it's the near-term wave — real, scheduled, not urgent.                                                  |
   | `Later` | `priority:2-later` | `Later — not yet scheduled`         | `2-later`            | it's real work you intend to do, but it isn't scheduled yet. **Nothing external is blocking it.**       |
   | `Gated` | `priority:3-gated` | `Gated — awaiting trigger`          | `3-gated`            | it **cannot start** until an external gate opens — a second consumer, an ADR intake gate, a future ADR. |
   | —       | (none)             | (none, unless another tier applies) | (cleared)            | the row's table has no Priority column at all (untiered by design — e.g. a wave sub-table).             |

   `Later` vs `Gated` is the distinction ADR-0073 added: ask "could I start this
   today if I wanted to?" If yes, it's `Later`; if something outside the repo has
   to happen first, it's `Gated`. The dash placeholder still means `2-later`, not
   `3-gated` — it marks an untiered-but-real row, never a blocked one.

   `Governance` is **not** a priority tier — it's a category for ADR/process
   follow-up work that sits in its own `docs/ROADMAP.md` section and carries
   `type:governance` (not a `priority:*` label) plus its own `Governance`
   milestone. A governance row has no Priority column to fill in; don't force
   one of the four tiers onto it. The board's Priority field gets its own
   dedicated `Governance` option instead (ADR-0052's 2026-08-20 Update) — not
   `2-later` (which would conflate it with real Later-tier work under a
   sort/filter) and no longer cleared/blank; `priority:*` labels are
   unaffected, still exactly the four tiers above.

   **Type legend** (ADR-0073 — assigned as the item's GitHub Issue Type, not
   a label. The axis is **which layer of the monorepo the work lands in**.
   `bin/lib/hub-sync.mjs`'s `TYPE_BY_ROADMAP_SECTION`/
   `TYPE_BY_IMPLEMENTATION_SECTION` supply a **default per tracker section**;
   a row may override it with its own optional `Type` cell, and a dash there
   means "use this section's default". Each Issue Type also carries a matching
   `type:*` GitHub label, applied to every issue unconditionally alongside its
   Priority/Status labels — ADR-0052's 2026-08-20 Update):

   | Issue Type           | GitHub label              | The work lands in                                          |
   | -------------------- | ------------------------- | ---------------------------------------------------------- |
   | `Library capability` | `type:library-capability` | `packages/m3l-common` — `core/`, `aws/`                    |
   | `CLI capability`     | `type:cli-capability`     | `packages/m3l-cli`                                         |
   | `Package capability` | `type:package-capability` | any other workspace package — creating **or** building out |
   | `UI`                 | `type:ui`                 | a browser-facing surface                                   |
   | `Infrastructure`     | `type:infrastructure`     | deployment, packaging, or runtime substrate                |
   | `Fleet retrofit`     | `type:fleet-retrofit`     | changes to existing consumers under `scripts/*`            |
   | `Tooling & gates`    | `type:tooling-gates`      | `bin/`, `.github/`, `.claude/`                             |
   | `Consumer script`    | `type:consumer-script`    | a **new** consumer script under `scripts/*`                |
   | `Friction`           | `type:friction`           | a library friction / defect report (the F-series)          |
   | `Governance`         | `type:governance`         | an ADR / process follow-up                                 |

   `Capability` was retired by ADR-0073: it had grown to 48 of 60 open board
   items, because one tracker section held three separate programmes.
   `Package capability` is deliberately wider than "new package" — several
   console items build _inside_ `m3l-console-server` without creating it.

   Issue Types are an **org**-level GitHub resource, not a repo one, and
   `gh issue create --type <name>` 422s on a name the org does not have. So
   they are declared in `bin/lib/issue-type-defs.mjs` (`ISSUE_TYPE_DEFS`,
   derived from `ISSUE_TYPES` + `TYPE_KINDS` so a new kind cannot be added to
   the vocabulary and forgotten) and provisioned by their own opt-in runner:

   ```bash
   pnpm sync:hub-issues -- --init-issue-types            # dry run
   pnpm sync:hub-issues -- --init-issue-types --apply    # create/retire
   ```

   It stays off `--apply`'s routine path because the blast radius is org-wide:
   a create is visible to every repo `monte3l` owns and a retire removes the
   type from all of them. It creates every declared type the org lacks, and
   retires an **undeclared** one only when the issue census (open _and_ closed)
   shows nothing still carries it — a type that is still in use is reported,
   never deleted. `--init-issue-types` cannot be combined with `--check` or
   `--backfill`.

   Every `--apply` run of the sync itself begins with an Issue-Type
   **preflight**: if any declared type is missing from the org it names them
   and refuses, rather than 422-ing partway through a ~50-issue batch and
   leaving half of it written. The preflight deliberately does **not** run on
   the dry-run or `--check` path — `check:hub-drift` runs in CI with the
   repo-scoped Actions `GITHUB_TOKEN`, which cannot read an org-level resource
   at all.

   Closed issues need their own one-shot pass. `planIssueSync` never recomputes
   a closed-and-resolved issue's payload (ADR-0032's 2026-07-28 Update), and
   `--type` reached the runner long after most of the backlog was closed — so
   131 of the 136 closed marker-bearing issues carry no Issue Type at all:

   ```bash
   pnpm sync:hub-issues -- --retype-closed            # dry run
   pnpm sync:hub-issues -- --retype-closed --apply    # backfill
   ```

   It is a **type-only** edit (`gh issue edit <n> --type`), never a full
   `editIssue` — rewriting 131 finished issues' titles and bodies to fix a type
   would trade one gap for a much larger churn, and would show as fresh activity
   on every one of them. Idempotent, so re-running is safe. A closed issue whose
   marker matches no current tracker row is reported and left alone: nothing can
   supply its type, and guessing one would be worse than the gap. Like
   `--init-issue-types`, it runs on its own and is rejected in combination with
   `--check`, `--backfill`, or the other one-shot.

   A description is written once per kind, in `TYPE_KINDS`
   (`bin/lib/hub-sync.mjs`), and read by both the `type:*` label and the org
   Issue Type — the same single-source arrangement `PRIORITY_TIERS` gives a
   tier's label and its milestone. Colours are not shared: a label takes a hex
   string and an Issue Type takes one of GitHub's eight `IssueTypeColor` enum
   values.

   **Status legend** — every one of the six `Status` cell values now carries
   a matching GitHub label too (ADR-0052's 2026-08-20 Update; originally
   Deferred/Blocked only): `status:todo`, `status:in-progress`,
   `status:deferred`, `status:blocked`, `status:done`, `status:rejected`
   (`bin/lib/hub-sync.mjs`'s `STATUS_LABELS`). A Done/Rejected issue still
   closes as before — the label is additional context on the closed issue,
   not a substitute for its closed state.

   **Is this one row, or a row plus slices?** ADR-0072 puts the soft authoring
   target at 75,000 reviewable chars per PR. If the item plainly can't land in
   one PR, file it as a parent row plus **slice sub-rows** whose IDs extend the
   parent's (`X10` → `X10a`, `X10b`, …). The sync derives the parent link from
   the ID, so each slice becomes a real GitHub sub-issue — marker-bearing,
   labelled, and drift-checked like any other row. Do **not** hand-create a
   sub-issue on GitHub instead: it will carry no marker, so `sync:hub` cannot
   see it, and it ends up wearing hub-managed labels nothing manages
   (issue #576 was exactly this). Each tracker section also gets one derived
   **epic** issue that parents its items; you never author those.

   **Slice when you pick the item up, not when you file it.** ADR-0072 puts
   seam planning immediately before RED, once the contract page has been read.
   Filing a row does not require guessing its slices, and slicing the backlog
   in advance is actively worse than leaving it whole: per-file coverage
   thresholds bind a slice's tests to the files it ships, so a seam chosen
   before anyone has read the contract can be unbuildable — which is what made
   PR #523's after-the-fact split structurally impossible in the first place.

4. **Run `pnpm sync:hub`** (dry-run first to preview, then `-- --apply`,
   maintainer-local — it needs your own `gh` auth; `GITHUB_TOKEN` cannot write
   Projects v2). This reconciles the tracker row against the issue you already
   created in step 1 or 2, applying the right priority label and milestone.
   **A large or first-time sync can take two `--apply` runs to fully
   converge** — a closed issue's body isn't rewritten on the same run that
   closes it, so run `--apply` again until the dry-run plan comes back empty
   (`docs/logs/2026-08-19-hub-sync-key-namespace.md`).
5. `pnpm check:hub-drift` is the CI alarm that fails if the tracker and
   GitHub ever drift apart on `main` — it is not a substitute for running
   `sync:hub` yourself; it only tells you that you (or someone) forgot to.

## The board's view (and the two steps the API can't do)

The board has **one** saved view, **`Backlog`** (Table, filtered `is:open`).
ADR-0073 dropped the `Board` view — a Board layout's one load-bearing setting
is its grouping, which the API cannot write, and its Kanban reading of `Status`
duplicated a column the table already sorts and filters.

`pnpm sync:hub-projects -- --init --apply` (also run as part of `sync:hub
--init`) reconciles that view from `bin/lib/hub-views.mjs`'s `VIEW_DEFS`: name,
layout and filter. The **visible-column set is written only when the view is
CREATED** (ADR-0075). `visibleFieldIds` is a full **replace**, and the built-in
`Type` column cannot be included in the replacement because the API cannot see
it — so writing the resolvable ids to an existing view would silently strip a
`Type` column added by hand. On the create path, a declared name that fails to
resolve skips the whole view rather than writing the short list, which would
delete every other column.

`VIEW_DEFS[0].fields` is therefore the column order `check:hub-views`
**asserts**, maintained by hand on the live board — the same arrangement sort
has always had.

**`VIEW_DEFS` is authoritative, but deleting is opt-in.** An undeclared view is
_reported_ by `--init`, never removed by it; `pnpm sync:hub-projects --
--prune-views` (preview) and `-- --prune-views --apply` are what delete it.
Deleting a view is irreversible through the API — a Board layout's grouping
can't be written back by any mutation — so it gets its own flag rather than
riding along on a routine `--init`. Pruning is skipped entirely if any declared
view failed to reconcile, matches by view **id** off a re-read (so a view
created in the same run is never pruned by it), and aborts rather than leaving
the board with zero views. Still: don't build an ad-hoc view expecting it to
survive a `--prune-views` run.

Three settings remain manual, because GraphQL cannot write them
(`ProjectV2ViewConfigurationInput` accepts only `visibleFieldIds`, and
`createProjectV2Field`'s `dataType` accepts no built-in type). Two of the three
are asserted by `pnpm check:hub-views`, so a drifted board fails a gate rather
than going unnoticed the way the old prose-only instructions did:

- Add the built-in **`Type`** column from the `Backlog` view's own field
  picker. This one is **not** gate-asserted and cannot be: the field is
  invisible to GraphQL by every path — absent from `ProjectV2.fields` and from
  `configuration.visibleFields`, and `projectV2.field(name: "Type")` answers
  `NOT_FOUND` — even while the board UI renders the column (ADR-0075). Check it
  by eye. ADR-0073 assumed the opposite and shipped a gate assertion no board
  could ever satisfy.
- **`Backlog`** columns, in `VIEW_DEFS[0].fields` order. Add and reorder them
  from the field picker; `check:hub-views` asserts the API-visible ones. The
  declared position of `Type` within that list is documentary only — neither
  writable nor assertable.
- **`Backlog`** sort: `Priority` ascending, then `Created` ascending — oldest
  highest-priority work first. Set it under the view's "…" menu → Sort.
  Because sort is readable but not writable, `--init --apply` captures the
  view's sort before an update and re-reads it after; if the update cleared it,
  the runner warns with the exact fields and directions to restore by hand
  rather than reporting a clean success.

Everything else on the board is written by the sync from the trackers: `Status`
and `Priority` per item, and `Parent issue` indirectly (it is a read-only
projection of the issue's own sub-issue link, so the sync sets the link, never
the field).

ADR-0073 also specifies a `Programme` single-select, **deferred and not
implemented**. With slices cut at pickup rather than in advance, the board has
no depth-2 rows, so every item's `Parent issue` already _is_ its programme epic
— the field would duplicate a populated, free column at the cost of ~60 extra
board writes per sync. It earns its keep the day a slice row exists, whose
parent is its item rather than the epic (which is exactly the non-redundancy
case ADR-0073 argues from).

### Board workflows

The board's six built-in workflows are deliberately left as they are: only
**`Auto-add sub-issues to project`** is enabled, which is what makes an
ADR-0072 slice sub-issue appear on the board. Every other one writes `Status`,
and `sync-hub-projects.mjs` already owns `Status` from the tracker — enabling
one would make the board flicker between two writers rather than converge. See
ADR-0073's workflow review before turning any of them on.

## For a bug report or a concrete feature request instead

If you already know exactly what's wrong or what you want, skip both inboxes
and use an [issue template](https://github.com/monte3l/m3l-automation/issues/new/choose)
directly — `bug_report.yml`, `failure_report.yml`, or `feature_request.md`.
These are reporter-facing and don't go through the tracker-row step above
unless the maintainer decides to promote them into one.

## See also

- [ADR-0032](../adr/0032-project-management-visibility-hub.md) — the
  visibility hub this whole sync pipeline implements.
- [ADR-0073](../adr/0073-hub-board-classification-and-hierarchy.md) — the
  current Issue Type / `Programme` / four-tier Priority taxonomy, the
  epic-and-slice issue hierarchy, the single authoritative view, and the
  milestone title set. **Read this one first** — it amends or partially
  supersedes both of the next two.
- [ADR-0051](../adr/0051-semantic-priority-vocabulary.md) — the priority
  label/milestone/tracker-cell vocabulary (amended by ADR-0073, which added
  the fourth tier and renamed two milestones).
- [ADR-0052](../adr/0052-hub-board-identity-and-field-taxonomy.md) — the
  board's identity (`m3l-automation`) and its Status field; its Type and
  Priority vocabularies and its two-view set are partially superseded by
  ADR-0073.
- [ADR-0050](../adr/0050-github-platform-feature-stance.md) — why Discussions
  and the Project board are configured the way they are.
- [`docs/ROADMAP.md`'s Maintenance section](../ROADMAP.md#maintenance) and
  [`docs/plans/IMPLEMENTATION.md`'s Maintenance section](../plans/IMPLEMENTATION.md#maintenance)
  — the full row-editing conventions (row-locality, getter-reality
  requirements for AWS scripts, contract-page deferrals).
