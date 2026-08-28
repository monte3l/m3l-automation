# 0081. Defer ADR-0073's `Programme` board field behind an explicit revival gate

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** Enrico Lionello (maintainer); Claude (live-board verification)

## Context and problem statement

ADR-0073 § `Programme` specifies a board single-select — "one option per
tracker section, written per item by `sync-hub-projects.mjs` alongside Status
and Priority" — as the board-side answer to "which wave does this item serve".
It was never built, and tracker row T12
(`docs/ROADMAP.md`, "Governance follow-ups") has carried that gap at Status
`Deferred` since the 2026-08-22 board restructure.

A live audit re-verified every claim behind that row before this ADR was
written:

| Claim                                                        | Verdict | Evidence                                                                                                                                                             |
| ------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The board has no `Programme` field                           | True    | `gh project field-list 2 --owner monte3l` lists 14 fields; the only single-selects are `Status` and `Priority`.                                                      |
| `sync-hub-projects.mjs` does not write it                    | True    | `applyProjectPlan` resolves `Status` + `Priority` only; no `Programme` code exists anywhere in `bin/` — not live, not dead, not commented.                           |
| No depth-2 rows exist, so `Parent issue` already is the wave | True    | Every open board item's `Parent issue` is a programme epic (#606/#608/#609/#610/#612); the one non-epic parent (#576 → #474) is closed and predates the restructure. |
| `docs/contributing/filing-work.md` was corrected to say so   | True    | `filing-work.md` states the deferral (corrected in #598).                                                                                                            |

The result is an asymmetry: three passages assert the field exists — all three
inside ADR-0073 (§ `Programme`, its Considered-options row, its API-capability
table row) — and three assert it is deferred, all three outside ADR-0073
(`filing-work.md`, `docs/ROADMAP.md` T12,
`docs/plans/2026-08-21-hub-board-restructure.md`). ADR-0073's own Consequences
section still asserts the two-field outcome as shipped, with no caveat.
ADR-0073 is Accepted, so per this index's immutability rule it cannot be
silently edited to match reality — the deferral has to be ratified by a new
ADR, and T12 needs somewhere durable to hand off to before it can retire.

## Decision drivers

- ADR-0072's slices are cut at pickup rather than in advance — the reason no
  depth-2 board row exists yet, and therefore the reason `Programme` is
  currently redundant with the free `Parent issue` column.
- Writing `Programme` today costs roughly 60 extra board writes per
  `sync:hub` run for a field every item's `Parent issue` already implies.
- The ADR index's immutability rule: "ADRs are immutable once Accepted. To
  change a decision, add a new ADR that supersedes the old one and update the
  old one's status."
- An Accepted ADR that describes a board field which does not exist is a
  standing inaccuracy, not a neutral omission — every reader of § `Programme`
  is told a field is live that isn't.

## Considered options

1. Build the `Programme` field as ADR-0073 specifies, closing the gap by
   implementing rather than deferring.
2. Leave ADR-0073 unamended and keep tracker row T12 open indefinitely as the
   standing record of the gap.
3. **Amend ADR-0073 to defer the `Programme` field behind an explicit,
   testable revival condition, and retire T12 once the record has a durable
   home. Chosen.**

## Decision

We chose **option 3** because the revival condition ADR-0073 itself argues
from — a depth-2 slice row whose parent is its own item rather than a
programme epic — has not occurred, so building the field now (option 1) would
add sync cost for a column that duplicates `Parent issue`. Leaving T12 open
indefinitely (option 2) keeps the record in a place — a tracker row — that
cannot express a conditional gate the way an ADR can, and leaves ADR-0073
misdescribing the board it accompanies for as long as nobody revisits it.

The `Programme` field is **deferred, not rejected**. ADR-0073's design for it
is adopted unchanged — only its timing is amended.

**Revival condition:** the first board item whose `Parent issue` is a slice's
own item rather than a programme epic — i.e. the first genuine depth-2 row.
That is exactly the non-redundancy case ADR-0073 argues § `Programme` from:
once it exists, `Parent issue` stops carrying the wave axis for free, and this
ADR is the trigger to implement § `Programme` as originally specified. The
implementation shape is already available and untouched by this deferral:
`setItemSingleSelect` (`bin/sync-hub-projects.mjs:1054-1089`) for the per-item
write, and the `updateProjectV2Field` reconciliation
(`bin/sync-hub-projects.mjs:222`) for the field definition.

## Consequences

- **Positive:** ADR-0073 stops asserting a board field that does not exist;
  the deferral becomes a ratified decision with a testable gate instead of an
  annotation nobody owns; tracker row T12 can retire, since the standing
  record now lives here rather than in an open issue.
- **Negative / trade-offs:** the wave axis stays implicit in `Parent issue`
  and is unavailable as an independent board group-by or filter until the
  gate opens; the revival condition is not itself gated by any check, so the
  first depth-2 row must be noticed by a human rather than flagged
  automatically.
- **Semver impact:** none — no public API surface is touched.

## Links

- Supersedes / superseded by: **amends**
  [ADR-0073](0073-hub-board-classification-and-hierarchy.md) — its
  § `Programme` decision is deferred behind the revival gate above; every
  other ADR-0073 decision (the Issue Type vocabulary, the `3-gated` priority
  tier, milestone parity, the epic/slice hierarchy, the single authoritative
  view) is unaffected.
- Related: [ADR-0072](0072-reviewable-slice-discipline.md) (the slices-cut-at-
  pickup discipline this deferral's premise rests on);
  [ADR-0075](0075-issue-type-invisible-columns-assert-only.md) (the other
  ADR-0073 correction, handled the same way — a follow-up ADR rather than a
  silent edit); `docs/contributing/filing-work.md` (restates the deferral in
  plain terms for contributors filing new rows);
  [`docs/plans/2026-08-21-hub-board-restructure.md`](../plans/2026-08-21-hub-board-restructure.md)
  (the landing plan whose PR-6 row originally scoped this field).
- Issues: #613 (tracker row T12, the standing record this ADR retires).
