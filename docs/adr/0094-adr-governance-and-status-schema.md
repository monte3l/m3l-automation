# 0094. ADR governance: a structured status schema and a generated index

- **Status:** Accepted
- **Date:** 2026-09-06
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + design)

## Context and problem statement

An audit of the 93-ADR corpus (`docs/logs/2026-09-06-adr-corpus-audit.md`) found the status
field has no enforced schema and three disagreeing consumers: the ADR file's own `- **Status:**`
bullet, `docs/adr/README.md`'s hand-maintained index row, and `bin/lib/project-hub.mjs`'s
`parseAdr()`/`classifyAdrStatusKind()`, which renders the corpus onto the published GitHub Pages
hub. The declared six-value vocabulary (`Proposed`, `Accepted`, `Rejected`, `Deprecated`,
`Superseded by ADR-NNNN`, `Re-affirmed by ADR-NNNN`) and documented practice have diverged in
both directions:

- `Partially superseded by`, `Amends`, and `Amended by` are the three most-used relations in the
  corpus (18+ occurrences: ADR-0020, 0027, 0032, 0038, 0050, 0051, 0052, 0073, 0074, 0075, 0080,
  0081, 0087, 0088, 0093) and none is declared.
- `Rejected` and `Deprecated` are declared and never used.
- `classifyAdrStatusKind()` recognizes only `Accepted`/`Proposed`/`Superseded`; running it over
  the live corpus classifies **ADR-0020 and ADR-0052 as `"Unknown"`**, so the published hub
  currently renders them as _"(Unknown)"_.
- 9 ADRs' README index rows disagree with the file's own status bullet (0012, 0027, 0030, 0032,
  0071, 0073, 0080, 0081, 0093), and neither side is authoritative.
- Two of the five partial-supersession cases (ADR-0020 → 0057, ADR-0052 → 0073) carry a bare
  `Partially superseded by ADR-NNNN` with **no in-file statement of which clauses survive** — the
  clause list exists only on the superseding ADR's side, so a reader of the old ADR must still
  cross-reference the new one. The other three (0032, 0038, 0050) already state the surviving
  scope in a dated blockquote callout; that pattern is what this ADR formalizes as mandatory.
- 6 relations are one-directional: the superseding ADR names the superseded one, but the
  superseded one's own `Links`/status never names it back (0020↔0057, 0012↔0023, 0071↔0091,
  0034/0015↔0091, 0013↔0080, 0073↔0074/0075/0081).
- `## Update` sections appended to `Accepted` ADRs (66 across 29 files) are legitimate in
  practice — they execute a decision's own declared revisit trigger (e.g. ADR-0042's
  "Update 2026-08-13 — revisit trigger fired") rather than changing the decision — but the
  README's immutability rule never says so, reading as though every one is a violation.
- The corpus has zero gate coverage: no `check:*` script validates status vocabulary, index/file
  agreement, or relation reciprocity, in a repo that runs ~55 other `check:*` gates.

## Decision drivers

- The status field must be **mechanically parseable** into a closed set, so `parseAdr()` never
  again renders `"(Unknown)"` for a value the corpus actually uses.
- The ADR file, not the README index, must be the **single source of truth** — the index becomes
  a derived artifact, mirroring `docs/reference`'s generate+check pattern (ADR-0024).
- A partial supersession must be **bidirectionally self-describing**: the clause list belongs on
  _both_ sides, not only the superseding one — a reader of either file gets the full picture
  without cross-referencing.
- `## Update` sections must be **explicitly legitimized**, not eliminated — they are how the
  corpus already records a fired revisit trigger, and `docs/contributing/filing-work.md` cites
  specific Update dates externally (e.g. "ADR-0032's 2026-08-19 Update"); the convention must not
  invalidate that citation.
- Minimal new machinery — reuse `bin/lib/report.mjs` and `parseAdr()` rather than building a
  parallel index system.

## Considered options

1. **Extend the six-value vocabulary to a closed set matching practice**, plus a separate
   `Relations:` line for cross-ADR pointers. Chosen.
2. **Normalize practice down to the original six values**, moving all nuance (amends, partial
   supersession) into free-form body prose only. Rejected: discards distinctions the corpus uses
   meaningfully (an `amends` reader needs to know no supersession occurred), and a body-prose-only
   convention is exactly what produced the current unparseable drift.
3. **A fully structured status object** (e.g. YAML frontmatter) replacing the Markdown bullet
   entirely. Rejected: the largest possible format change across all 93 files, with no reader
   benefit over a structured `Relations:` line at the same location; MADR-style ADRs are prose
   documents by convention and a frontmatter block fights that.

## Decision

We chose **option 1**: a closed-set `Status:` field plus a structured `Relations:` field,
because it legitimizes exactly the relations the corpus already depends on while staying
parseable, and requires the smallest change to the existing per-file format.

### The schema

```markdown
- **Status:** Accepted
- **Relations:** partially-superseded-by: 0057 (clauses: the publish pipeline; §Decision 2)
- **Date:** YYYY-MM-DD
```

**`Status:`** is exactly one of: `Proposed`, `Accepted`, `Rejected`, `Deprecated`, `Superseded`,
`Partially-superseded`. (The `by ADR-NNNN` suffix moves into `Relations:` — the machine field
states only the ADR's own current standing.)

**`Relations:`** is optional, comma-separated `<verb>: <NNNN>` entries, one per related ADR. Verb
is one of a closed set: `supersedes`, `superseded-by`, `partially-supersedes`,
`partially-superseded-by`, `amends`, `amended-by`, `re-affirmed-by`, `fires-trigger-of`,
`trigger-fired-by`. A `partially-supersedes` / `partially-superseded-by` entry **must** carry a
`(clauses: …)` qualifier naming what is replaced (on the superseding side) or what survives (on
the superseded side) — bare partial supersession is what made ADR-0020 and ADR-0052 the worst
cases in the audit, and is no longer permitted.

**Reciprocity is mandatory**: every `Relations:` entry on ADR A naming ADR B must be matched by a
corresponding entry on ADR B naming A (`supersedes` ↔ `superseded-by`, `amends` ↔ `amended-by`,
etc.). `bin/check-adr-index.mjs` (tooling PR, following this one) enforces this as a blocking
check once the corpus is normalized.

**`## Update` sections remain permitted** on an `Accepted` ADR and do not change its `Status:`,
under one condition: the Update must execute a revisit trigger or condition **already stated in
the ADR's own accepted Decision** (e.g., "the revisit trigger is a named multi-script flow… it has
fired"). An Update that reverses the decision itself requires a new ADR with
`superseded-by`/`partially-superseded-by`, per the existing immutability rule — this ADR narrows
that rule's scope to _decision changes_, it does not weaken it. Update section headings and dates
already cited externally (`docs/contributing/filing-work.md`) are never renumbered or redated.

### The index becomes generated

`docs/adr/README.md`'s `## Index` table (the `ADR | Title | Status` columns) is regenerated from
the ADR files by `bin/gen-adr-index.mjs`, inside a `<!-- BEGIN GENERATED ADR INDEX -->` …
`<!-- END GENERATED ADR INDEX -->` marker block, and verified by `bin/check-adr-index.mjs`
(mirroring `bin/gen-reference-index.mjs` / `bin/check-reference-index.mjs`, ADR-0024's
merge-driver treatment applying to the generated block). The file's own `Status:`/`Relations:`
bullet is authoritative; the index can no longer disagree with it because it is derived from it.

## Consequences

- **Positive:** the status field becomes mechanically parseable — `classifyAdrStatusKind()` can
  cover the full closed set, eliminating the live `"(Unknown)"` hub-rendering defect. Index/file
  disagreement becomes structurally impossible once the index is generated. Partial supersession
  becomes self-describing on both sides. `## Update` sections are explicitly sanctioned, removing
  the ambiguity against the immutability rule.
- **Negative / trade-offs:** every one of the 93 existing ADRs needs its status bullet rewritten
  to the new schema (tracked as the follow-up normalization sweep — mechanical only, no new
  decisions). The README's authored index prose (beyond ADR/Title/Status) is no longer freely
  editable inside the generated block.
- **Semver impact:** none — internal documentation tooling, no public API surface.

## Links

- Related: `docs/logs/2026-09-06-adr-corpus-audit.md` (the audit this ADR resolves); ADR-0024
  (generated-artifact merge-driver treatment, applied to the new generated index block);
  ADR-0030 (structured `--json` report shape, followed by `bin/check-adr-index.mjs`).
- Followed by (tooling and sweep, tracked as the next PRs in this sequence): the
  `bin/gen-adr-index.mjs` / `bin/check-adr-index.mjs` pair, and the mechanical normalization of
  all 93 existing ADRs onto this schema.
