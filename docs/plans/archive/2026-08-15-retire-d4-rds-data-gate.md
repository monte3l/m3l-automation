# Retire the D4 `aws/rds-data` gate (issues #204, #426)

**Status: shipped** — commit `7b6e60a` (docs) on
`chore/retire-d4-rds-data-gate`.

## Context

The user asked whether GitHub issue #204 (`D4 aws/rds-data Aurora PostgreSQL
query wrapper`) should be closed definitively along with its associated
milestone and project-board items. `/auditing` (3-facet parallel fan-out plus
direct verification) established that both PRs in the D4 gate's 2-PR chain —
`aws/rds-data` (#424) and its named consumer `rds-data-sql` (#425) — had
merged on `main`, with `aws/rds-data` genuinely complete (real
`M3LRDSDataOperations` implementation, barrel wiring, a hard
`@aws-sdk/client-rds-data` dependency, 52 library tests, 100 script tests, and
passing reference/provenance/count checks). Issue #204 is a **derived**
ADR-0032 hub-sync issue, generated from a single Status cell in
`docs/plans/IMPLEMENTATION.md`; hand-closing it on GitHub would have been
silently reopened by the next `pnpm sync:hub -- --apply`, since open/closed
state is driven exclusively by the tracker row, not the issue itself.

The audit also found the root cause of why the row stayed "shipped-looking"
yet open: the tracker Status cell used the token `In review`, which is a
board-side Project option name, not one of ADR-0032's six documented tracker
values. `classifyStatus` (`bin/lib/project-hub.mjs`) has no branch for it and
silently falls through to `"todo"`, with no warning channel in the gated-table
block (unlike the friction/wave tables' `resolvePriority`).

## Approach / Decisions

Per the user's choices during planning:

1. **Close both #204 and #426**, not #204 alone. #426 (ROADMAP W6
   `rds-data-sql`) is the sibling derived issue, driven by
   `docs/ROADMAP.md`'s Priority 1 wave table; its own body already asserted
   "Closes issue #204," and both PRs it depends on merged.
2. **Fold the live-verification caveat into the Done row**, rather than filing
   a separate tracker row or dropping it. Both work logs
   (`docs/logs/2026-08-14-aws-rds-data.md`,
   `docs/logs/2026-08-14-rds-data-sql.md`) record that no live
   Data-API-enabled Aurora cluster has exercised the wrapper end-to-end —
   verification was against installed `@aws-sdk/client-rds-data` dist-types.
   That caveat now lives in the D4 row's Done note and in ADR-0031's closing
   Update, so it survives the issue's close.
3. **File, don't fix, the `classifyStatus` vocabulary gap.** Added a new
   `Deferred` row to `docs/plans/IMPLEMENTATION.md`'s gated table describing
   the silent `In review` → `"todo"` fallthrough and the missing
   unrecognized-cell warning, rather than patching `bin/lib/project-hub.mjs`
   in the same change. This becomes its own derived issue on the next sync.
4. **Amend ADR-0031 with a closing Update**, following the ADR-0030 retire
   precedent (commit `33cb838`): record that both PRs landed, the gate is
   retired, and #204/#426 are closed — rather than leaving the ADR's prior
   Update phrasing the flip as future work.

Both `docs/plans/IMPLEMENTATION.md` (drives #204) and `docs/ROADMAP.md`'s
Priority 1 wave table (drives #426) were edited; `docs/ROADMAP.md`'s own
(never-synced) Priority 2 D4 row and its W6 narrative paragraph were also
corrected for consistency, since they otherwise contradicted `main`.

Explicitly out of scope (per the user, and the plan itself): fixing
`classifyStatus` in this change, and running `pnpm sync:hub -- --apply` from
this branch — GitHub mutation must happen from `main` after merge, or the
next sync would plan a reopen against a `main` that doesn't yet have these
tracker edits.

## Outcome

One `docs:` commit flipping the D4 `aws/rds-data` row and ROADMAP W6 row to
`Done`, filing the `classifyStatus` gap as a new gated row, correcting
`docs/ROADMAP.md`'s Priority 2 duplicate and narrative prose, and adding a
closing Update to ADR-0031. `pnpm sync:docs` (13/13 steps),
`check:tracker-coverage`, `check:doc-counts`, `check:impl-counts`, and
`lint:md` all pass; a `pnpm sync:hub` dry run confirms the intended plan
exactly — close #204 and #426, create 1 new gated issue, update #205's
cross-reference wording, **no reopens**. `pnpm sync:hub -- --apply` is left
for the maintainer to run from `main` after merge. No `src/`, test, or
`exports`-map changes; zero semver impact.
