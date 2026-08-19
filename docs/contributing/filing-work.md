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

- **Private — a draft item on the GitHub Project board** (`m3l-automation
hub`, linked to this repo, kept private — ADR-0050). Use this for a
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
     `AWS getter reality`, `Gated library modules & deferred decisions (P2)`.
   - **Adding a new `##`-level section to either file?** Run
     `pnpm check:tracker-coverage` right after — an unregistered heading with
     a `Status` column is a silent no-op to the sync, which is exactly the
     failure mode that check exists to catch.
   - Every row's `Status` cell must be one of six values: **Done · To Do · In
     Progress · Deferred · Blocked · Rejected** (`pnpm check:tracker-status`
     enforces this). Priority is `P0`/`P1`/`P2` or a dash placeholder where
     the table doesn't carry a Priority column.
   - The row becomes the issue's join key: `sync-hub-issues.mjs` writes an
     `<!-- m3l-hub-sync:<key> -->` marker as the first line of the issue body
     and matches on that marker alone — never on title text. Run
     `pnpm check:hub-keys` after adding a row (or renaming an item's label) to
     catch a key collision before it reaches GitHub.
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

## For a bug report or a concrete feature request instead

If you already know exactly what's wrong or what you want, skip both inboxes
and use an [issue template](https://github.com/monte3l/m3l-automation/issues/new/choose)
directly — `bug_report.yml`, `failure_report.yml`, or `feature_request.md`.
These are reporter-facing and don't go through the tracker-row step above
unless the maintainer decides to promote them into one.

## See also

- [ADR-0032](../adr/0032-project-management-visibility-hub.md) — the
  visibility hub this whole sync pipeline implements.
- [ADR-0050](../adr/0050-github-platform-feature-stance.md) — why Discussions
  and the Project board are configured the way they are.
- [`docs/ROADMAP.md`'s Maintenance section](../ROADMAP.md#maintenance) and
  [`docs/plans/IMPLEMENTATION.md`'s Maintenance section](../plans/IMPLEMENTATION.md#maintenance)
  — the full row-editing conventions (row-locality, getter-reality
  requirements for AWS scripts, contract-page deferrals).
