# 0095. ADR-worthiness routing and a lightweight decision-note tier

- **Status:** Accepted
- **Date:** 2026-09-06
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + design)

## Context and problem statement

The same audit that motivated ADR-0094 (`docs/logs/2026-09-06-adr-corpus-audit.md`) found the
corpus accumulating entries meeting none of `docs/adr/README.md`'s "When to write an ADR"
criteria: a label rename (ADR-0074), two ADRs each widening one ESLint zone by a single module
(ADR-0040, ADR-0041), two ADRs for one harness affordance (ADR-0087/ADR-0088). None of these is
wrong to have recorded — each is a real decision — but none needed a full MADR-style document with
Decision Drivers, Considered Options, and Consequences to explain a choice this small. Once the
habit of "write an ADR for every decision" is established, it pulls low-blast-radius, cheaply
reversible choices into the same format as decisions that gate a major-version bump, diluting the
signal for the ADRs that actually matter.

The audit also found the corpus's largest single theme — harness and agent-operating-model
decisions (~18 of 94 ADRs: 0012, 0023, 0025, 0030, 0058, 0060–0062, 0078, 0082–0084, 0087–0090,
0092, 0093) — entirely unnamed by `docs/adr/README.md`'s "When to write an ADR" criteria, which
still read as though only library/public-contract decisions qualify.

This is itself a decision about how future decisions get classified and recorded repo-wide — a
harness/agent-operating-model decision under the very criterion it adds, and cross-cutting enough
that a decision note (this ADR's own output) would be the wrong size for it.

## Decision drivers

- **Match record weight to decision weight.** A decision that would just get changed and moved on
  from if it turned out wrong doesn't need an ADR's ceremony, but does need a real record — a
  commit message is not discoverable, and "nowhere" means it gets relitigated.
- **Name the gap, don't just patch symptoms.** The harness/agent-operating-model cluster is real
  and growing; the criteria should say so rather than leaving every future harness ADR to justify
  itself against criteria written for library decisions.
- **A nudge, not a veto.** The maintainer is this repo's sole reviewer (CLAUDE.md: single-maintainer
  project); an automated worthiness check must never block a legitimate ADR the maintainer has
  already decided to write — it can only flag a candidate for a lighter path.
- **No new tier without a defined boundary.** A lightweight record with no stated boundary against
  ADRs and work logs recreates the exact ambiguity problem ADR-0094 fixed for ADR relations.

## Considered options

1. **Do nothing — rely on reviewer judgment alone.** Rejected: this is what already produced
   ADR-0074/0040/0041/0087/0088; judgment alone did not prevent it once, no reason it prevents it
   going forward.
2. **A reversibility test plus a new lightweight decision-note tier, with an advisory routing
   gate.** Chosen.
3. **Delete or retroactively downgrade the existing low-blast-radius ADRs.** Rejected: ADRs are
   immutable once accepted (ADR-0094); rewriting history to fix a process gap is exactly the kind
   of edit the corpus's own conventions forbid, and provides no benefit over fixing the process
   forward.

## Decision

We chose **option 2**: a reversibility test added to "When to write an ADR," the
harness/agent-operating-model cluster named explicitly, a new `docs/decision-notes/` tier for
what fails the test, and an advisory gate flagging a likely-misrouted new ADR.

### The reversibility test and the harness cluster

`docs/adr/README.md`'s "When to write an ADR" gains: a **harness or agent-operating-model
decision** bullet naming the ~18-ADR cluster explicitly, and **the reversibility test** — _would a
different choice here force a different choice somewhere else, or cost real effort to reverse?_ A
decision that fails this test (the honest answer is "we'd just change it and move on") routes to a
decision note instead.

### `docs/decision-notes/` — the lightweight tier

A new directory, `docs/decision-notes/README.md` + `template.md`, for a real decision that is low
blast-radius and cheaply reversible — distinct from a work log (retrospective narrative of what
shipped, never a decision record) and distinct from an ADR (forward-looking, immutable, reserved
for decisions worth the weight). A decision note **may be edited in place** when superseded — an
ADR may not — since nothing depends on a decision note's exact historical wording the way ADR
cross-references depend on the ADR corpus's Relations schema.

### `check:adr-worthiness` — advisory routing

`bin/check-adr-worthiness.mjs` flags a _new_ ADR (one not yet on `origin/main`) that matches one of
a small set of specific low-blast-radius shapes — the ones this ADR's own Context section named as
the audit's actual examples: a label/milestone retitle, widening one lint/type-check zone by a
single module — and whose own Consequences section declares `Semver impact: none`, as a
decision-note candidate. Advisory only — it never blocks, and the maintainer's judgment is final;
the gate exists to prompt the question at review time, not answer it. It deliberately flags
narrowly rather than broadly: an earlier design flagged any semver-impact-none ADR unless it
mentioned a "worthy" keyword, and measured against this repo's own corpus that flagged roughly half
of it — legitimate, foundational ADRs simply don't share a keyword vocabulary. Trading recall for
precision keeps the nudge quiet on everything but the shapes it actually knows are low-value.

## Consequences

- **Positive:** future low-blast-radius decisions have a real, lighter-weight home; the
  harness/agent-operating-model cluster is now explicitly in scope rather than an unnamed
  majority; a routing nudge exists where none did.
- **Negative / trade-offs:** a third tier is one more place to know about; the worthiness gate's
  heuristic (a small set of specific low-value shapes, chosen for precision over recall) will miss
  a genuine decision-note candidate whose shape isn't yet enumerated — it is deliberately advisory
  for exactly this reason, and the shape list can grow as new low-value patterns show up.
- **Semver impact:** none — internal documentation/process governance, no public API surface.

## Links

- Related: ADR-0094 (the status/relations schema this ADR's own new ADRs and decision notes will
  use going forward); `docs/logs/2026-09-06-adr-corpus-audit.md` (the audit both ADRs resolve).
- Cites as examples of the gap this closes: ADR-0074, ADR-0040, ADR-0041, ADR-0087, ADR-0088 —
  none is retroactively changed; ADRs remain immutable once accepted.
