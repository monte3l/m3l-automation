# Ratify ADR-0073's Programme board-field deferral (ADR-0081)

**Status: shipped** (commit `daa4ab7c`)

## Context

Tracker row T12 (`docs/ROADMAP.md`, "Governance follow-ups") recorded that
ADR-0073 § `Programme` specifies a board single-select — written per item by
`sync-hub-projects.mjs` alongside `Status` and `Priority` — that was never
built. The row sat at Status `Deferred` since the 2026-08-22 board
restructure, and `Deferred` is deliberately outside `isResolved()`
(`bin/lib/hub-sync.mjs`), so its derived issue (#613) could never close while
it stood. Filed via `/starting-work` off issue #613.

Every claim behind the row was re-verified live before acting: the board
(project #2) carries no `Programme` field among its 14 fields; no
`Programme` code exists anywhere in `bin/` — not live, not dead, not
commented; and every open board item's `Parent issue` is already a programme
epic (no depth-2 slice row exists yet, so `Parent issue` already carries the
wave axis for free). The result was an asymmetry: three passages asserted the
field exists — all three inside ADR-0073 — and three asserted it was
deferred, all three outside it (`filing-work.md`, `ROADMAP.md` T12, the
restructure plan). ADR-0073 is Accepted, so per the ADR index's immutability
rule the deferral could not be silently edited in — it needed a new ADR.

## Approach / Decisions

- Considered three options: build the field now (rejected — the revival
  condition it exists for has not occurred); leave ADR-0073 unamended and
  keep T12 open indefinitely as the standing record (rejected — a tracker row
  can't express a conditional gate the way an ADR can); or amend ADR-0073 via
  a new ADR carrying an explicit, testable revival condition. Chose the
  third.
- New `docs/adr/0081-deferring-the-programme-board-field.md`: the field is
  deferred, not rejected, and ADR-0073's design for it is adopted unchanged —
  only its timing is amended. Revival condition: the first board item whose
  `Parent issue` is a slice's own item rather than a programme epic (the
  first genuine depth-2 row) — exactly the non-redundancy case ADR-0073
  argues § `Programme` from.
- ADR-0073 itself gets two inline `[**Deferred (2026-08-28):** …]` notes
  (§ Programme, § Consequences) pointing at ADR-0081, following the repo's
  existing inline-note convention for correcting an Accepted ADR (the T9/T10
  `[**Stale (2026-08-20):** …]` precedent). Its two existing `## Update`
  sections and historical option/API rows were left untouched.
- `docs/adr/README.md`: ADR-0073's row gains `, ADR-0081` to its
  amended-by list; a new ADR-0081 row appended after ADR-0080.
- `docs/ROADMAP.md` T12: `Deferred` → `Rejected` (not `Done` — the field
  still isn't built, only the standing record moved, from the open row to
  the ADR), matching the T8 "not going to build it" precedent and the
  T9/T10/T11 governance-table `**PR:** #NNN.`-leading Notes convention.
- Two residual doc inconsistencies that issue #598's earlier correction had
  missed were also fixed in the same change: `filing-work.md`'s "See also"
  line still listed `Programme` as part of the current taxonomy, and the
  restructure plan's PR-6 scope row still listed the field as shipped.
- Explicitly out of scope: building the `Programme` field itself (revival
  condition verified unmet); ADR-0073's historical prose and existing
  Updates; and whether epic #606 (Governance follow-ups) should also close
  now that T12 was its only open child — left for `sync:hub` to decide on
  its own terms rather than forced by this change.

## Outcome

Landed as a docs-only PR (`fix/adr-0073-programme-deferral`, 6 files, 820
reviewable chars): the new ADR-0081; two inline notes in ADR-0073; the
ADR-0073/ADR-0081 index rows in `docs/adr/README.md`; T12 flipped to
`Rejected` in `docs/ROADMAP.md`; and the two residual `Programme` references
corrected in `filing-work.md` and the restructure plan. `pnpm verify` passed
all 48 applicable steps (6 push-only steps skipped, as expected off `main`).

A `pnpm sync:hub` dry run confirmed the mechanical effect ahead of merge:
closing issue #613 (`not planned: Item marked rejected in source trackers`)
and, as a direct consequence of T12 being the section's last open row, also
closing epic #606 (`not planned: Item removed from source trackers`) — the
epic-derivation logic naturally retires a programme epic once none of its
tracker rows remain open, not a separate decision made here.
