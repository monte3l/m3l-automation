# Reject the D4 DocumentDB gate (issue #205)

**Status: shipped** — commit pending on `docs/reject-d4-documentdb-gate`.

## Context

Issue #205 is the surviving half of ADR-0031's two-tier decision. Its sibling
gate, #204 (`aws/rds-data` + `rds-data-sql`), shipped and was retired on
2026-08-15 (see `2026-08-15-retire-d4-rds-data-gate.md`). #205 had remained
`Deferred` in both trackers since a 2026-08-13 reconciliation audit corrected
an earlier, factually wrong `Rejected` verdict — that verdict had misread
ADR-0031 as having "dropped" `mongodb`, when ADR-0029 did; ADR-0031 separately
kept DocumentDB gated on named, pre-cleared terms rather than settling the
question.

The user asked `/auditing` to investigate whether issue #205 (and its
referenced documentation) should be rejected, or whether a DocumentDB
consumer script would add significant value to the project. A three-facet
parallel audit — gate bookkeeping/rejection precedent, library capability
surface, and consumer-fleet value case — established:

1. **No evidence of a real DocumentDB workload anywhere in the repo.** An
   exhaustive repo-wide search for `documentdb|docdb|mongo|document database`
   returned only the gate's own ADR/tracker bookkeeping, archived
   pre-ADR-0029 design material that was explicitly dropped, a stale branch
   name (`feat/aws-clients-logs-docdb-athena`), and a synthetic test fixture
   string (`bin/tests/project-hub.test.ts:239`). The Aurora gate opened on a
   concrete infrastructure fact ("a Data-API-enabled Aurora cluster became
   reachable," issue #204); no analogous statement exists or is plausible for
   DocumentDB.
2. **No in-boundary query route exists.** ADR-0031 itself records that
   `@aws-sdk/client-docdb` is control-plane-only — there is no AWS SDK path
   to run a query against DocumentDB. A wrapper would inherit exactly the
   raw-driver shape ADR-0031 calls "explicitly rejected" for `pg` (VPC
   reachability, a non-AWS peer dependency, hand-rolled connection-string
   credentials), with no available mitigation.
3. **The fleet's documented execution environment cannot reach a DocumentDB
   cluster.** All 14 shipped scripts reach AWS over public HTTPS; no doc
   places any script inside a VPC. ADR-0031 chose the RDS Data API for Aurora
   specifically to avoid this shape.
4. **ADR-0031's pre-cleared `mongodb`-peer terms are incomplete.** They
   specify the optional-peer declaration, the missing-dependency error code,
   the credential seam, and mandatory TLS — but do not cover three real
   design problems: a provider-seam mismatch (`AWSClientProvider`'s getters
   are documented synchronous because every service client is a hard
   dependency; an optional peer must load via `await import()`), no
   connection-lifecycle precedent (every existing optional peer in
   `core/text` is a stateless per-call parser; a `MongoClient` is not), and no
   TLS/CA-bundle handling seam anywhere in the library. The pre-clearance
   therefore does not do what it was written to do — make a future decision
   narrow — so leaving it standing would be a false shortcut.
5. **The library already covers the rest of the pipeline.** Paging (the
   `aws/dynamodb` async-generator precedent), streaming resume (`core/exporters`,
   ADR-0045), and NDJSON/CSV export/field-shaping (`core/exporters`,
   `core/importers`, `core/json`) all exist without `mongodb`.

## Decision

**Reject issue #205.** Grounds are DocumentDB-specific, deliberately not the
"W1–W5 closed, no further script planned" template used by every other
rejected D4/D5 row (#199/#200/#202/#203/#206) — that exact wording was already
reworded off #205 once, as false, during the #204 reconciliation (W6 reopened
the fleet). Reusing it here would reintroduce a claim already corrected.

**The referenced documentation — ADR-0031's four named DocumentDB terms — is
withdrawn, not deleted.** ADR-0031 is Accepted and immutable per
`docs/adr/README.md`; its Aurora tier already shipped. The withdrawal is
recorded as a fourth `## Update` section (following the ADR-0031's own three
prior Updates and the ADR-0030 retire precedent, commit `0cbe179`), leaving
lines 116-139 in place as history while stating plainly that they no longer
stand as pre-approval.

**This is not a reversion to the 2026-07 rejected verdict.** That verdict was
wrong on the facts (misreading ADR-0031 itself); this one accepts ADR-0031's
reading in full and rejects the gate on its own separately-unmet terms.
Both the tracker rows and the ADR Update say so explicitly, so a future
reader does not conflate the two.

The rejected row carries a two-conjunct revisit clause — a real DocumentDB
workload **and** a documented VPC-reachable execution environment — mirroring
the standard the Aurora gate actually met, rather than a single-fact trigger
that would understate the harder (infrastructure) half of the blocker.

## Outcome

One `docs:` commit:

- `docs/plans/IMPLEMENTATION.md` — D4 DocumentDB row `Deferred` → `Rejected`,
  DocumentDB-specific rationale, closes issue #205.
- `docs/ROADMAP.md` — matching P2 duplicate row updated for consistency (this
  table is never synced by `sync:hub`, but left contradicting `main` would be
  the same drift #428 already had to correct once).
- `docs/adr/0031-relational-and-document-data-engine-access.md` — new
  `## Update (2026-08-16)` section withdrawing the four named terms, citing
  the three unresolved design problems, and distinguishing this from the
  reverted 2026-07 verdict. Status line unchanged (`Accepted`).
- `docs/reference/scripts/athena-query.md` and `docs/reference/aws/athena.md`
  — collateral prose updated from "keeps DocumentDB out of scope on named,
  pre-cleared terms" to "rejects DocumentDB (issue #205)", so neither page
  contradicts the new verdict.
- This archive record + one new index row in `docs/plans/README.md`.

No `src/`, test, or `exports`-map change; zero semver impact; no submodule
added or removed, so `check:impl-counts`/`check:doc-provenance` are no-ops by
construction. `pnpm sync:hub -- --apply` is left for the maintainer to run
from `main` after merge, matching the #428 precedent — running it earlier
would plan against a `main` that lacks these tracker edits.
