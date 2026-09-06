# Work log — adr-corpus-audit (2026-09-06)

This log covers the `/auditing` session that reviewed the 93-ADR corpus (`docs/adr/`) against
a user-supplied report naming five governance risks (partial-supersession ambiguity, stale
reads, index/context cost, decision sprawl, ADR-writing rubber-stamping, single-reviewer bus
factor), verified those risks against live repo state, and produced an approved 5-PR
reconciliation-and-governance plan. It records what the audit confirmed, what it refuted in the
source report, and the durable lessons from running the fan-out + adversarial-verify loop on a
governance-document corpus rather than source code.

Plan of record: `this-has-become-a-sorted-scroll.md`, the hub's plan-mode file
(`~/.claude/plans/`, outside the repo tree — not a `docs/plans/` file, so no repo-relative link
applies) — its Context section and PR sequence carried forward into ADR-0094's own Links.

## Summary

Ran `/auditing` over `docs/adr/` (93 numbered ADRs, README, template — 1,004,653 bytes) via the
`audit-fanout` workflow across 5 facets: supersession/status integrity, drift against live repo
state, index size/context cost, gate/tooling coverage, and contradiction-risk/ADR-worthiness/
process weight. The workflow ran 20 agents (5 finders + up to 15 adversarial `audit-refuter`
verifications) with 0 errors, 681,000 subagent tokens, 292 tool calls. Verify-phase tally: **13
confirmed, 2 refuted, 36 past the round-robin verify budget** (of which the hub personally
verified the highest-stakes ones directly — the exports-map drift, the live `parseAdr()`
`"Unknown"` rendering, the partial-supersession census, and the context-budget headroom — per
the skill's Step 3 requirement to check every `unverified` item before treating it as real).

Key confirmed findings: the ADR status field has no enforced schema and three disagreeing
consumers (the file's own `Status:` bullet, the README index row, and
`bin/lib/project-hub.mjs`'s `classifyAdrStatusKind()`), which today renders **ADR-0020 and
ADR-0052 as `"(Unknown)"` on the live published GitHub Pages hub** — verified by running
`parseAdr()` over the corpus directly. 9 ADRs have index/file status disagreements; 6 relations
are one-directional (declared on one side, absent on the other); ADR-0004's header/Decision/
Consequences still claim a "three-entry" exports map against a live four-entry map
(`./core/errors` shipped); zero `check:*` gate covers `docs/adr/` at all, in a repo running ~55
other gates; and no lightweight decision-record tier exists, which the audit tied to concrete
over-weight ADRs (0074 retitles a milestone label; 0040/0041 each widen one ESLint zone by one
module; 0087/0088 are two ADRs for one harness affordance).

The session produced `docs/adr/0094-adr-governance-and-status-schema.md` (this session, branch
`feat/adr-governance`) and a 5-PR sequence: convention (ADR-0094 + template + README) → gen/check
tooling (advisory) → 93-file mechanical normalization sweep (flips the gate to blocking) →
drift-detection (provenance sidecars + a claims-descriptor table generalizing
`bin/lib/integration-stance.mjs`'s pattern) → a lightweight decision-note tier + routing gate.

**Skills used:** auditing, starting-work, writing-work-logs.
**Spoke incidents:** none (`tmp/session-incidents.jsonl` absent this session).
**Compaction events:** none.

## What went as planned

- **The `audit-fanout` workflow ran clean** — 20/20 agents completed, 0 errors, 0 empty results,
  no `missingFacets`, so no facet needed re-dispatch per the skill's Step 3 requirement.
- **The adversarial refute pass earned its cost immediately.** It caught two of the hub's own
  candidate findings as wrong before they reached the plan — see divergence #1 below. This is
  exactly the failure mode the skill's refute step exists to prevent, and it fired on the first
  run.
- **Existing repo machinery was reusable, not just precedent.** `parseAdr()`
  (`bin/lib/project-hub.mjs`) is already tested and became the basis for the planned
  `bin/lib/adr-index.mjs`; `bin/lib/integration-stance.mjs`'s `INTEGRATION_DESCRIPTORS` pattern
  (already generalized once, ADR-0030 → ADR-0093) is the direct template for the planned
  claims-descriptor drift gate; `bin/check-logs-index.mjs` is a near-exact template for the
  planned `bin/check-adr-index.mjs`. No new architectural pattern had to be invented.
- **The registration surface for a new gate was fully mapped in one pass** — `package.json`,
  `lefthook.yml`, the CLAUDE.md cadence table, `.github/workflows/ci.yml`, and
  `bin/lib/verify-steps.mjs` — by reading the tooling-coverage facet's own investigation plus a
  direct read of `check-cadence-doc.mjs` and `check-verify-parity.mjs`.

## What didn't go as planned, and why

### 1. The source report's own named examples were the wrong ones

The user's report cited ADR-0032, 0038, and 0050 as the corpus's partial-supersession problem.
Direct verification (`grep -l "partially superseded"` plus reading each file) found the
opposite: those three are the **well-implemented** cases — each carries a dated blockquote
callout naming the exact surviving/replaced clauses. The two structurally broken ones — ADR-0020
and ADR-0052, bare `Partially superseded by ADR-NNNN` with zero in-file clause list — were not
in the report's list at all, and were found only by exhaustively grepping every ADR rather than
trusting the report's enumeration.

**Why it happened:** A user-supplied report's own examples read as pre-verified ground truth,
especially when the report is otherwise well-reasoned and directionally correct about the
existence of the problem. But the report was written from a skim, not a systematic sweep, and
its examples happened to be the corpus's best cases rather than its worst.

**Fix for future:** When a report names specific examples as evidence for a claimed pattern,
verify the examples themselves before verifying the pattern — an audit that confirms "yes,
partial supersession is a real problem" without checking whether the _named instances_ are
themselves correct can end up designing a fix around cases that don't need it, while missing the
cases that do.

### 2. Two of the hub's own draft findings were refuted by the adversarial pass

Before the verify phase, the hub had independently derived two findings: (a) the 66 `## Update`
sections across 29 `Accepted` ADRs violate the README's "ADRs are immutable once Accepted" rule;
(b) ADR-0027 was "never amended" despite citing a renamed script directory. The `audit-refuter`
spoke disproved both: (a) the README's rule is conditional — "to change _a decision_, add a new
ADR" — and an Update that executes a decision's own already-declared revisit trigger (e.g.
ADR-0042's fired-trigger update) changes no decision; (b) ADR-0027's status literally reads
`Accepted — amended 2026-07-15`, and ADR-0028's noncompliance ledger reconciles the rename the
hub had flagged as unreconciled.

**Why it happened:** Both misses came from reading a status line or a section heading in
isolation rather than reading the full surrounding context (the README's exact rule wording, the
cross-referenced ledger in a sibling ADR) before concluding a violation existed.

**Fix for future:** Treat "this pattern looks like a rule violation" as a hypothesis to verify
against the full text of the rule and any cross-referenced reconciliation, not as a finding —
especially for a governance corpus where the same fact is often recorded in two places (a status
bullet and a sibling ADR's ledger) and only one of them is wrong.

## Lessons learned

- **Verify a report's own cited examples, not just its thesis.** A source report can be
  directionally correct about a systemic problem while citing the wrong specific instances as
  evidence — the corpus's worst cases here were absent from the report entirely. Grep
  exhaustively for the pattern rather than trusting a named list.
  _(promoted → .claude/skills/auditing/SKILL.md)_
- **The adversarial refute pass catches the hub's own errors, not just finders' errors.**
  Two of the confirmed-vs-refuted findings in this audit originated from the hub's direct
  investigation, not a fanned-out finder — the refute step is a general correctness backstop for
  the whole audit, not only insurance against subagent hallucination.
- **A "drift claim" needs the live code run, not just read.** The `"(Unknown)"` hub-rendering
  defect was only provable by actually invoking `parseAdr()`/`classifyAdrStatusKind()` against
  the corpus (`node -e 'import(...)...'`) — reading the function's source suggested the defect
  but running it produced the exact two ADR numbers affected, which is what made it a concrete,
  actionable finding rather than a plausible-sounding one.
- **Reusable governance-drift machinery already exists in this repo and generalizes.**
  `bin/lib/integration-stance.mjs`'s descriptor-table pattern was built once for GitHub-stance
  drift and once more for docs-lookup-stance drift (ADR-0030 → ADR-0093); this audit is the third
  case (ADR-claims drift) that fits the same shape. Worth naming explicitly in the next ADR
  rather than rebuilding a parallel mechanism.
- **When a plan sequence spans several PRs, decide the whole sequence before the first branch.**
  `starting-work`'s PR-sequence step, applied here, produced concrete branch names for all 5 PRs
  up front (`feat/adr-governance` → `feat/adr-index-tooling` → `feat/adr-corpus-sweep` →
  `feat/adr-drift-detection` → `feat/adr-lightweight-tier`) rather than re-deriving naming at each
  PR boundary.
