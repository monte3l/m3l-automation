# Decision notes

A decision note is the lightweight record for a real decision that doesn't
meet [`docs/adr/README.md`](../adr/README.md)'s bar for a full ADR — recorded
because the choice is worth naming and might otherwise be relitigated, but
without an ADR's overhead for something low-blast-radius and reversible.

Introduced by [ADR-0095](../adr/0095-adr-worthiness-and-decision-note-tier.md)
after an audit found the ADR corpus accumulating entries that met none of
`docs/adr/README.md`'s "When to write an ADR" criteria — a label rename
(ADR-0074), two ADRs each widening one ESLint zone by a single module
(ADR-0040, ADR-0041), two ADRs for one harness affordance (ADR-0087,
ADR-0088) — diluting the signal for the ADRs that actually gate something
hard to reverse (`docs/logs/2026-09-06-adr-corpus-audit.md`). A decision that
doesn't need an ADR's ceremony still needs _somewhere_ to live other than a
commit message or nowhere at all.

## Where this sits among the repo's other decision records

Three tiers, by what a decision costs to reverse and how many other decisions
depend on it:

| Tier                               | For                                                                                                                               | Written                             | Immutable?                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| [ADR](../adr/README.md)            | A decision hard to reverse without a major bump, or one other decisions will cite (`docs/adr/README.md`'s "When to write an ADR") | At decision time, forward-looking   | Yes, once `Accepted` (`## Update` sections only execute an already-declared trigger) |
| **Decision note** (this directory) | A real decision, low blast radius, cheaply reversible, nothing else depends on its exact form                                     | At decision time, forward-looking   | No — superseded by editing in place, dated                                           |
| [Work log](../logs/README.md)      | The narrative of what shipped, what diverged, and the lessons from a unit of work                                                 | After the work ships, retrospective | Yes — logs are never edited after landing                                            |

The test that actually separates an ADR from a decision note: **would a
different choice here force a different choice somewhere else, or cost a
major-bump-equivalent effort to reverse?** If yes, it's an ADR. If the honest
answer is "we'd just change it and move on," it's a decision note. A decision
note that turns out to matter more than expected gets superseded by an ADR,
the same as any other record — nothing here is a demotion, it's matching the
weight of the record to the weight of the decision.

A decision note is not a substitute for a work log: a note records the
decision itself (forward-looking, before or at the moment of choosing); a log
records what happened when it shipped (retrospective, after the fact). A unit
of work can produce both — a decision note for the small call made along the
way, a work log for the narrative of the whole task — or neither, or just one.

## Format

Start from [`template.md`](./template.md). A decision note is short — a
paragraph of context, the choice, and why — not a MADR-style multi-section
document. Name it `NNNN-short-title.md`, numbered from the same kind of
zero-padded sequence as `docs/adr/`, in its own sequence (a decision note's
number carries no relationship to any ADR number).

Unlike an ADR, a decision note **may be edited in place** when the decision
it records is superseded by a later note or promoted into a full ADR — add a
dated `> **Superseded (YYYY-MM-DD).**` callout at the top pointing to the
replacement, the same callout style ADR partial-supersessions use, but the
note itself is not required to stay byte-for-byte historical.

## Index

Hand-maintained — low enough volume that a generated index isn't warranted
yet (unlike `docs/adr/README.md`'s generated table, ADR-0094 — deliberately
not citing its row count here, since that number is exactly the kind of
authored claim that rots the moment another ADR lands). Revisit if this list
grows past ~20 entries.

| Note | Title                                                                                                               | Date       |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0001 | [An optional `Review by:` date for a deferral ADR with no fired trigger](./0001-deferral-review-by-dates.md)        | 2026-09-06 |
| 0002 | [Extend the session-telemetry adapter with a per-tool usage scan, recursively](./0002-per-tool-usage-scan-scope.md) | 2026-09-06 |
| 0003 | [Why `SessionEnd`, `Notification`, and `PostCompact` stay unwired](./0003-unwired-hook-events.md)                   | 2026-09-07 |
| 0004 | [A collapse-detector pass-rate floor for the skill-eval suite](./0004-skill-eval-pass-rate-floor.md)                | 2026-09-07 |
