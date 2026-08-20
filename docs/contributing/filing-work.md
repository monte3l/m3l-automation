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
     `m3l-cli build-out`, `Codified-procedure engine wave`,
     `AWS getter reality`, `Gated library modules & deferred decisions (Later)`.
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

   | Cell    | GitHub label       | Milestone                           | Board Priority field | Pick this when…                                                                                |
   | ------- | ------------------ | ----------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
   | `Now`   | `priority:0-now`   | `Now — unblock first`               | `0-now`              | the item blocks other work landing — do it before more scripts consume the library.            |
   | `Next`  | `priority:1-next`  | `Next — consumer fleet`             | `1-next`             | it's the near-term consumer-fleet wave — real, scheduled, not urgent.                          |
   | `Later` | `priority:2-later` | `Later — gated/deferred`            | `2-later`            | it's gated on a future trigger (a second consumer, an ADR intake gate) or explicitly deferred. |
   | —       | (none)             | (none, unless another tier applies) | (cleared)            | the row's table has no Priority column at all (untiered by design — e.g. a wave sub-table).    |

   `Governance` is **not** a priority tier — it's a category for ADR/process
   follow-up work that sits in its own `docs/ROADMAP.md` section and carries
   `type:governance` (not a `priority:*` label) plus its own `Governance`
   milestone. A governance row has no Priority column to fill in; don't force
   one of the three tiers onto it. The board's Priority field is **cleared**
   for a governance item, never given a `Governance` option — the same rule,
   projected onto the new field (ADR-0052).

   **Type legend** (ADR-0052 — assigned as the item's GitHub Issue Type, not
   a label; `bin/lib/hub-sync.mjs`'s `TYPE_BY_ROADMAP_SECTION`/
   `TYPE_BY_IMPLEMENTATION_SECTION` derive it per tracker section, never
   hand-picked per row):

   | Issue Type        | Tracker series | Source section(s)                                                           |
   | ----------------- | -------------- | --------------------------------------------------------------------------- |
   | `Capability`      | A/B/C-series   | ROADMAP Priority 0; every IMPLEMENTATION.md section except Library friction |
   | `Consumer script` | W-series       | ROADMAP Priority 1 (the Wave/Scripts table)                                 |
   | `Friction`        | F-series       | IMPLEMENTATION.md's Library friction table                                  |
   | `Governance`      | T-series       | ROADMAP Governance follow-ups                                               |

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

## The board's views (one-time manual setup)

`pnpm sync:hub-projects -- --init --apply` (also run as part of `sync:hub
--init`) reconciles the board's three saved views — **`Backlog`** (Table),
**`Board`** (Board), **`Timeline`** (Roadmap) — via `bin/lib/hub-views.mjs`'s
`VIEW_DEFS`: name, layout, filter, and visible columns. GitHub's GraphQL API
does not expose everything a view needs, though (verified against the live
schema — ADR-0052); these steps are manual and one-time, done once via the
board's own UI:

- Enable the built-in **`Type`** field (board "…" menu → Settings → Fields →
  `Type`) if it is not already on — it does not exist as a selectable field
  until a human turns it on, so no view can show it until this runs once.
- **`Board`** view: verify it groups by `Status` (Board layout defaults to
  grouping by the first single-select field, which should already be
  `Status`).
- **`Backlog`** view: sort by `Priority` ascending, then `Status`.
- **`Timeline`** view: pair the roadmap to the built-in `Created` (start) and
  `Updated` (target) date fields, and set the zoom level.

## For a bug report or a concrete feature request instead

If you already know exactly what's wrong or what you want, skip both inboxes
and use an [issue template](https://github.com/monte3l/m3l-automation/issues/new/choose)
directly — `bug_report.yml`, `failure_report.yml`, or `feature_request.md`.
These are reporter-facing and don't go through the tracker-row step above
unless the maintainer decides to promote them into one.

## See also

- [ADR-0032](../adr/0032-project-management-visibility-hub.md) — the
  visibility hub this whole sync pipeline implements.
- [ADR-0051](../adr/0051-semantic-priority-vocabulary.md) — the priority
  label/milestone/tracker-cell vocabulary.
- [ADR-0052](../adr/0052-hub-board-identity-and-field-taxonomy.md) — the
  board's identity (`m3l-automation`) and its Type/Status/Priority field
  taxonomy and saved views.
- [ADR-0050](../adr/0050-github-platform-feature-stance.md) — why Discussions
  and the Project board are configured the way they are.
- [`docs/ROADMAP.md`'s Maintenance section](../ROADMAP.md#maintenance) and
  [`docs/plans/IMPLEMENTATION.md`'s Maintenance section](../plans/IMPLEMENTATION.md#maintenance)
  — the full row-editing conventions (row-locality, getter-reality
  requirements for AWS scripts, contract-page deferrals).
