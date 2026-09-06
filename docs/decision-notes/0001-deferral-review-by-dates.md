# 0001. An optional `Review by:` date for a deferral ADR with no fired trigger

- **Date:** 2026-09-06
- **Decider:** Enrico Lionello (maintainer)

The corpus audit (`docs/logs/2026-09-06-adr-corpus-audit.md`) found six deferral-titled ADRs
(0012, 0023, 0039, 0042, 0043, 0047) carry a named revisit trigger but no expiry or review date —
0023 and 0043 specifically have never fired theirs, with nothing scheduling a re-look. Rather than
build a generic "detect every unfired trigger" mechanism (hard to do honestly: a trigger can fire
via a separate ADR's `trigger-fired-by:` relation, as ADR-0039/ADR-0047 did, or via the deferral's
own in-file `## Update`, as ADR-0042 did — the two are indistinguishable from the Relations schema
alone), this adds one optional field, applied only where it's actually useful right now:
`- **Review by:** YYYY-MM-DD`, placed in the status block alongside `Status:`/`Relations:`/`Date:`.
An ADR carrying this field past its date is a candidate for a fresh look, not an automatic
re-open — the maintainer still decides.

Applied to ADR-0023 (`Review by: 2027-01-11`, six months out) and ADR-0043 (`Review by:
2027-02-13`) — the two the audit named as genuinely stale. `bin/lib/adr-index.mjs`'s
`checkAdrIndex()` gains a matching advisory check: a `Review by:` date in the past is a warning,
never a blocking error, mirroring every other judgment-call finding in that gate.

This is deliberately a decision note, not an ADR: reversible (drop the field, nothing else
depends on its presence), low blast-radius (touches two files plus one new warn-only check),
and doesn't gate anything hard to reverse — exactly the reversibility test ADR-0095 added.

> **Extended (2026-09-06).** A follow-up audit applied this note's own stated criterion — a
> deferral ADR with no fired trigger — exhaustively across the corpus rather than the two ADRs the
> original audit happened to name, and found it had been applied to the wrong instance once: the
> field is removed from **ADR-0043**, whose trigger (b) fired on 2026-08-16 per its own in-file
> `## Update` (a resolved deferral is out of this field's scope by definition), and added to three
> ADRs whose triggers are genuinely still unfired and previously carried no date at all —
> **ADR-0015**, **ADR-0018**, **ADR-0081**. A fourth candidate, ADR-0037, was considered and
> excluded: its two "Revisit if…" clauses are narrow hedges on already-decided, already-implemented
> choices (a semver approach, a declined `catalog:` adoption), not a declined-for-now decision
> awaiting a trigger the way ADR-0015's per-PR-scanning question or ADR-0018's event-source seam
> are — the criterion is "a deferral ADR with no fired trigger," not "any ADR containing the word
> 'revisit.'" The date rule this note implies (six months from the date the trigger was last
> confirmed unfired — the ADR's own `Date:`, or its most recent trigger-status `## Update`) is
> unchanged; only the set of ADRs it's applied to grew to match the criterion. `docs/adr/template.md`
> and `docs/adr/README.md` § Conventions now also document the field, so it can spread to a new
> deferral ADR without a reader having to find this note first.

## Links

- Related: ADR-0015, ADR-0018, ADR-0023, ADR-0081 (the ADRs this note currently applies the field
  to); ADR-0037 (considered and excluded by the 2026-09-06 Extension above — not a deferral in this
  field's sense); ADR-0043 (carried the field until the 2026-09-06 Extension above removed it, its
  trigger having fired); ADR-0094 (the status block schema this field extends); ADR-0095 (the
  reversibility test this note's own routing follows).
