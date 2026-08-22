# 0074. Retitle the `major` milestone to `Breaking`

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** repo maintainer

## Context and problem statement

The `major` tier's GitHub milestone is titled `2.0 / breaking`.
`packages/m3l-common` is at **4.3.0**, so the title names a version that was
passed two majors ago.

This is not a new observation. ADR-0044 recorded it while resolving the
unfireable "wait for a real 2.0 milestone" gate on issue #338:

> `packages/m3l-common` is already at 2.4.0 — the next major is 3.0, exactly
> as ADR-0038 itself said, not the "2.0 / breaking" milestone label the
> tracker row names (that string is a hard-coded milestone title in
> `bin/lib/hub-sync.mjs`, not a version target; no 2.0/3.0 roadmap or plan
> document exists anywhere in the repo).

The string outlived that finding. ADR-0073 then gave milestones their first
declaration layer and, in doing so, ratified the stale title as canonical —
`major | 2.0 / breaking | Breaking` — making the already-wrong string the
_target_ of a rename rather than its source.

Two further problems make this more than a cosmetic staleness.

**The milestone axis is a horizon vocabulary, not a version one.** Every other
member — `Now — unblock first`, `Next — scheduled`, `Later — not yet
scheduled`, `Gated — awaiting trigger`, `Governance` — answers "when", and
none names a version. A version number on this axis invites exactly the
misreading ADR-0044 had to correct: that some 2.0 release is being planned.

**The declared orientation strands the tier's own history.** Both titles exist
live, and the work is on the one declared legacy:

| #   | Title            | Open | Closed         | Description |
| --- | ---------------- | ---- | -------------- | ----------- |
| 5   | `Breaking`       | 0    | 2 — #338, #196 | _(empty)_   |
| 9   | `2.0 / breaking` | 0    | 0              | present     |

`planMilestones` applies **title match beats legacy match**: a def whose
current title exists live claims that milestone, and a milestone holding one of
its `legacyTitles` becomes an `orphan` rather than a rename, because GitHub
rejects a `PATCH` that would duplicate an existing title. So as declared, the
**empty #9 wins and #5 orphans**, carrying both breaking issues with it. And
`orphan` is deliberately report-only and excluded from `planIsEmpty`'s drift
verdict, so nothing ever escalates it. The end state is stable and wrong:
canonical milestone empty, history on an unclaimed one.

## Decision drivers

- **A declared title should not encode a fact that expires.** A version number
  in a milestone title is wrong again at the next major bump; a horizon label
  never is.
- **The title match must land on the milestone that holds the work.** This is
  the difference between a no-op reconciliation and a permanent split, because
  `orphan` is never deleted.
- **Consistency with the axis.** `Governance` shows the axis already tolerates a
  bare noun for a non-horizon tier.
- **Prefer the declaration that needs no live rename.** A `PATCH` on a title is
  the operation the `legacyTitles` mechanism exists to make safe, but not
  needing it at all is safer still.

## Considered options

1. **`Breaking`**, with `legacyTitles: ["2.0 / breaking"]`.
2. **`Breaking — needs a major bump`**, with both live titles as legacy.
3. **`5.0 / breaking`**, tracking the real next major, with both as legacy.
4. **Leave `2.0 / breaking`** and correct only the prose that describes it.

## Decision

We chose **option 1** because it is the only option that satisfies every
driver at once: it is version-agnostic, and it puts the title match on #5 —
the milestone carrying the closed breaking work — so nothing is renamed,
nothing is created, no issue moves, and the orphan becomes the empty #9.

Options 2 and 3 were rejected on a shared mechanical defect. Neither title
matches a live milestone, so both live titles become legacy candidates for the
same def, and `planMilestones` resolves that with a `.find()` over
`legacyTitles` — making the winner depend on **array order**. Under one order
the rename lands on #5 and #9 orphans; reversed, #5 orphans and the tier's
history is stranded exactly as it is today. A declaration whose correctness
rests on the order of an array is one a future edit silently breaks. Option 3
additionally re-asserts the version axis ADR-0044 explicitly rejected, and
expires at 5.0.

Option 4 was rejected because prose is not what `gh issue edit --milestone`
resolves. The title is the identifier; describing it accurately elsewhere
leaves both the staleness and the orphan split in place.

## Consequences

- **Positive:** the `major` milestone keeps its own history, under a title that
  cannot rot at a version bump. The live `Breaking`/`2.0 / breaking` duplication
  resolves to one claimed milestone plus one empty orphan, safe to delete by
  hand precisely because it holds nothing.
- **Negative / trade-offs:** this **adds** a `describe` action rather than being
  drift-neutral — #9 already carries the def's description verbatim while #5's
  is empty, so `check:hub-drift` reports one describe on #5 until it is applied.
  That is real drift newly _expressed_, not introduced: #5 has always been
  description-less. It must land before the ADR-0073 apply session writes
  milestones, or that session describes #9 and orphans #5, needing a manual UI
  repair afterwards.
- Deleting the orphaned #9 is a manual step. Deleting a milestone strips it from
  every issue that ever held it, so its `0 open / 0 closed` counts must be
  re-read at that moment rather than trusted from this ADR.
- **Semver impact:** none. This is internal tooling (`bin/**`) and GitHub
  project state; no `exports`-map or public-API surface is touched.

## Links

- Amends: ADR-0073 (hub board classification, hierarchy, and a single
  authoritative view) — the `major` row of its milestone table.
- Related: ADR-0044 (which first recorded that `2.0` named no reachable
  version), ADR-0051 (the priority vocabulary these titles express), ADR-0032
  (the visibility hub that manages them).
- Live milestones #5 and #9; issues #338 and #196.
