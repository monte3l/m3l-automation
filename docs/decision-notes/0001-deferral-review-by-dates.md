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

## Links

- Related: ADR-0023, ADR-0043 (the two ADRs this note applies the field to); ADR-0094 (the status
  block schema this field extends); ADR-0095 (the reversibility test this note's own routing
  follows).
