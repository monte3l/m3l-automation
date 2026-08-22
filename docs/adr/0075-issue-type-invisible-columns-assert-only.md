# 0075. The board's Type column is invisible to GraphQL; view columns become assert-only

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** repo maintainer

## Context and problem statement

`check:hub-views` reported two failures against a board that was correct in
both respects. One was a wrong-connection read, fixed under PR #616. The other
is a premise error in ADR-0073 that cannot be fixed by a manual step, and
whose printed remediation actively destroys board state.

ADR-0073 recorded two capability claims that turn out to be false:

| ADR-0073 claim                                                                                                                       | Actual                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| line 127 — "View `fields` (the visible-column set) ✅ **readable** — correcting an assumption to the contrary; a gate can assert it" | Readable, but in board field-DEFINITION order. The ordered truth is `configuration.visibleFields` ("the fields visible in the view, in configured order"). |
| line 129 — "Reading whether `Type` is enabled ✅ `ProjectV2FieldType` includes `ISSUE_TYPE`, so its **absence is gateable**"         | The enum value exists but is never materialized as a field node. Its absence is therefore NOT gateable — the assertion can never pass.                     |

Verified against the live schema and the live board on 2026-08-23:

| Probe                                            | Result                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectV2FieldConfiguration` union members      | exactly `ProjectV2Field`, `ProjectV2IterationField`, `ProjectV2MultiSelectField`, `ProjectV2SingleSelectField` — no issue-type member |
| Any `ProjectV2IssueTypeField` in the schema      | does not exist                                                                                                                        |
| `ProjectV2.fields(first: 50)`                    | `totalCount: 14`, 14 nodes, no `ISSUE_TYPE`, nothing dropped by the `ProjectV2FieldCommon` fragment                                   |
| `gh project field-list`                          | the same 14                                                                                                                           |
| `projectV2.field(name: "Type")` / `"Issue type"` | `NOT_FOUND`                                                                                                                           |
| `configuration.visibleFields`                    | `hasNextPage: false`, `endCursor: "OA"` (= 8), 8 nodes                                                                                |
| The board UI                                     | shows **9** columns, `Type` fourth                                                                                                    |

So the UI renders a column that GraphQL cannot see by any path.

### The destructive consequence

Both findings told the reader to run `pnpm sync:hub-projects -- --init --apply`.
That command deletes the Type column:

1. `resolveFieldIds` cannot resolve `Type`, and because it is in
   `OPTIONAL_VIEW_FIELDS` it is silently omitted from the id list — with an
   `info` message promising it "will sync automatically once the field is
   enabled", which can never happen.
2. `updateView` then writes the remaining 8 ids to
   `configuration.visibleFieldIds`, which is a **full replace**.
3. The manually-added Type column is stripped.

This is the same failure shape as the 2026-08-20 Priority wipe that
`bin/sync-hub-projects.mjs`'s own comments warn about. Critically it is
**undetectable from inside sync**: the API reports 8 visible fields whether or
not Type is present, so no guard can see the column it is about to delete.
The Type column and automated `visibleFieldIds` writes are mutually exclusive.

## Decision drivers

- A gate that cannot pass is worse than no gate: it trains the reader to
  ignore the channel.
- A remediation string must not destroy the state it claims to repair.
- Board facets that are readable-but-not-writable already have a settled
  pattern here — sort: declared as data, asserted by the gate, set by hand.

## Considered options

1. **Keep the Type column; make column reconciliation assert-only.** Stop
   writing `visibleFieldIds` on update; keep it on create.
2. **Drop the Type column.** Remove it from `VIEW_DEFS` and keep full column
   reconciliation.
3. **Keep both, behind a `--force-columns` opt-in.** Writes stay reachable but
   never run by default.

## Decision

We chose **option 1**. The Type column carries the ADR-0073 layer vocabulary on
the board's one authoritative view, which is worth more than an automated
column write that has nothing left to reconcile once the order is correct. It
also matches how sort is already handled, so the board's manual facets are
described by one rule instead of two.

Concretely:

- **`updateProjectV2View` no longer sends `configuration`.** Name, layout and
  filter stay writable.
- **`createProjectV2View` keeps `visibleFieldIds`.** A view being created has no
  Type column to lose, and a new view needs its columns from somewhere. This
  create-writes / update-asserts asymmetry is the safety property, not an
  oversight.
- **The ISSUE_TYPE presence assertion is removed** from `deriveViewDrift`. The
  `Type` column stays declared in `VIEW_DEFS` and becomes unconditionally exempt
  from the ordered-column assertion, with the union-membership evidence as its
  stated reason.
- `VIEW_DEFS.fields` is reinterpreted: the **asserted** column order, written
  only on view creation.

## Consequences

- **Positive:** `check:hub-views` can pass. No sync path can strip a column it
  cannot see. The API blind spot is recorded rather than re-derived — this
  investigation cost a full session precisely because ADR-0073 asserted the
  opposite.
- **Negative / trade-offs:** The 8-column order joins sort as a manual,
  gate-asserted facet — a board rebuilt from scratch needs one UI pass to add
  Type and order the columns. The declared POSITION of `Type` within
  `VIEW_DEFS.fields` is documentary only: unwritable and unassertable, so a
  board whose Type column sits elsewhere cannot be detected.
- **Semver impact:** none — repo tooling only; no `packages/` source or
  `exports`-map change.

## Links

- Amends: ADR-0073 (its capability table, lines 127 and 129, and its
  column-reconciliation decision)
- Related: ADR-0052 (hub board identity and field taxonomy), ADR-0032
  (the visibility hub)
