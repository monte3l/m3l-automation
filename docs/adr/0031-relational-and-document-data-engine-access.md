# 0031. Relational and document data-engine access for the consumer fleet

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** Enrico Lionello

## Context and problem statement

[ADR-0029](./0029-script-dependency-boundary.md) ratified a hard dependency
boundary — consumer scripts under `scripts/*` depend on exactly
`@m3l-automation/m3l-common` — and, as a direct consequence, dropped the
Postgres (`pg`) and DocumentDB (`mongodb`) engines from the planned `data-query`
script, rescoping it to `athena-query` (Athena only, via the existing `athena`
getter). Its stated trade-off: "capabilities whose natural client is not an AWS
SDK (Kubernetes workloads, Postgres, MongoDB) are out of fleet scope **until a
deliberate library-level decision admits a wrapper for them**."

This ADR is that deliberate decision, requested ahead of any concrete W4
consumer needing it (a deepen-first assessment, not a response to a shipped
script). The question: can Aurora PostgreSQL and/or DocumentDB query access
return to fleet scope, and if so, through what dependency shape?

The two engines are not symmetric, which is the crux of the assessment:

- **Aurora PostgreSQL** has a query path that is itself an **AWS SDK v3
  client**: the RDS Data API (`@aws-sdk/client-rds-data`). It executes SQL over
  HTTPS with IAM or Secrets-Manager authentication and **no persistent
  database connection or VPC reachability requirement** — the same shape as
  every other AWS SDK client this library already depends on (contrast with
  the raw `pg` wire-protocol driver, which needs a live TCP connection into
  the database's VPC). This route was not evaluated in the original
  `data-query` design (archived
  [2026-07-09 consumer-scripts plan](../plans/archive/2026-07-09-consumer-scripts-implementation-plan.md)),
  which assumed the raw `pg` driver throughout; a repo-wide search turned up no
  prior mention of `rds-data`, `RDS Data API`, or `@aws-sdk/client-rds-data`.
  Constraint: only Data-API-enabled Aurora clusters (Aurora Serverless v1/v2,
  or provisioned Aurora with the Data API explicitly enabled) support it —
  not every RDS/Aurora instance.
- **DocumentDB has no equivalent.** `@aws-sdk/client-docdb` is
  control-plane-only (cluster/instance lifecycle) — there is no AWS SDK path
  to run a query against DocumentDB. Its only client is the `mongodb` wire
  driver (DocumentDB is Mongo-wire-compatible), which needs the same
  VPC-reachability and non-AWS-dependency shape ADR-0029 excluded.

[ADR-0017](./0017-dependency-loading-standard.md) already gives this library a
mechanism for admitting exactly this kind of non-AWS, feature-only dependency
without weakening the "required deps are AWS-SDK-only" posture: the optional
`peerDependencies` + `peerDependenciesMeta.optional` + lazy `await import()`
pattern, reference-implemented by the six `core/text` extractors. Whether
that mechanism should be _invoked_ for `mongodb` — reopening a door ADR-0029
closed — is a judgment call this ADR makes explicitly, not a mechanical
consequence of the pattern existing.

## Decision drivers

- ADR-0029's boundary: scripts stay dependency-free; **any** new capability
  must be met by a library wrapper, not a script-local dependency. This ADR
  does not touch that rule — it only decides what the library is willing to
  wrap.
- `CLAUDE.md`'s non-negotiable constraint: minimal runtime dependencies, no
  breaking changes outside a major, shallow import graph.
- ADR-0027's per-consumer-need gate: library capability grows when a
  consumer demands it, not speculatively. This ADR is itself a deliberate,
  named exception to "wait for a consumer" — the P2/D4 gate below restores
  that discipline for the actual wrapper work.
- ADR-0017's required-vs-optional dependency tiering: a dependency is
  "required" only if the library cannot fulfil its _stated_ purpose without
  it. AWS SDK access is a stated purpose (ADR-0017 §"AWS SDK is required");
  a specific non-AWS document-database wire protocol is not.
- Supply-chain and audit surface: every runtime/peer dependency lives in one
  `package.json` (ADR-0029's driver, unaffected either way).

## Considered options

1. **Keep ADR-0029's blanket exclusion** — Postgres and DocumentDB stay out of
   fleet scope indefinitely; no library-level decision is made now.
2. **Admit both engines via their natural non-AWS drivers** — add `pg` and
   `mongodb` as ADR-0017 optional peers, reopening the raw-driver route
   ADR-0029 closed for both engines symmetrically.
3. **Two-tier: admit what fits the AWS-SDK boundary now, gate what doesn't** —
   Aurora PostgreSQL returns to fleet scope via a library wrapper over the RDS
   Data API (`@aws-sdk/client-rds-data`, a hard dependency, same shape as the
   other 20 `@aws-sdk/*` packages); DocumentDB stays out of scope pending its
   _own_ future decision, but with the exact admission terms recorded (an
   ADR-0017 optional `mongodb` peer) so that a future decision is a narrow,
   pre-scoped one rather than a fresh audit.

## Decision

We chose **option 3: two-tier admission.**

### Aurora PostgreSQL — back in fleet scope, via RDS Data API

A future `aws/rds-data` submodule (name per [ADR-0028](./0028-aws-service-naming-convention.md):
`rds-data` is the RDS Data API's own service identifier) wraps
`@aws-sdk/client-rds-data`, following the established typed-wrapper pattern
([ADR-0026](./0026-sqs-operations-wrapper.md)/[ADR-0027](./0027-aws-sdk-boundary-typed-wrappers.md)
class shape: `client.ts` takes an already-provisioned SDK client via
constructor injection — never self-constructing from profile/region —
`error.ts` for a typed `M3LError` subclass, `types.ts` for plain library
types, `index.ts` barrel). `@aws-sdk/client-rds-data` joins the other
`@aws-sdk/*` packages as a **hard, exact-pinned dependency** (ADR-0017's "AWS
SDK is required" tier applies unchanged — this is one more AWS SDK client, not
a new tier). `AWSClientProvider` (`packages/m3l-common/src/aws/clients/provider.ts`)
gains a synchronous `rdsData` getter following the existing 15-getter pattern.

This does not reverse ADR-0029: the RDS Data API is an AWS SDK client, so
routing through it is the _same_ boundary ADR-0029 drew — Aurora PostgreSQL
was never actually a Postgres-wire-protocol requirement, only assumed to be
one by the pre-ADR-0029 design. The raw `pg` driver route is explicitly
**rejected**: it requires VPC reachability from wherever the script runs, a
non-AWS peer dependency, and hand-rolled connection-string credential
handling — exactly the shape ADR-0029 excludes, and unnecessary now that an
in-boundary alternative exists.

### DocumentDB — stays gated, on named terms

DocumentDB has no AWS-SDK query path; admitting it requires the `mongodb`
driver, a genuine non-AWS optional peer. This ADR does **not** admit it now —
consistent with ADR-0027's per-consumer-need gate, there is no script
demanding it — but records the exact terms on which a future decision can
admit it without re-litigating the boundary question:

- `mongodb` declared as an ADR-0017 **optional peer**: `peerDependencies` +
  `peerDependenciesMeta.optional`, caret-ranged, never a hard dependency.
- Loaded via lazy `await import()`; an absent package surfaces as a typed
  `M3LError` (e.g. `ERR_MONGODB_MISSING_DEP`), following the `core/text`
  extractor reference implementation — never a raw `ERR_MODULE_NOT_FOUND`.
- Credentials via the existing AWS credentials seam where possible
  (DocumentDB supports IAM-authenticated connections; Secrets Manager for the
  connection string otherwise) — never a script-local `.env` connection
  string, to keep the `aws.profile` seam as the one credential path.
- TLS is mandatory for DocumentDB; the wrapper documents the CA-bundle
  requirement rather than defaulting to an insecure connection.
- Unblock condition (filed as a P2/D4 row, matching the SES-transport
  precedent): a concrete consumer script needing DocumentDB query access,
  _and_ acceptance of the VPC-reachability and heavy-driver trade-offs this
  ADR declines to accept speculatively.

## Consequences

- **Positive:** Aurora PostgreSQL returns to fleet scope without reopening
  ADR-0029's non-AWS-dependency boundary — the RDS Data API keeps every
  runtime dependency in the AWS SDK family, so ADR-0029's supply-chain and
  mediation-seam guarantees hold unchanged. DocumentDB's future admission
  path is pre-scoped (exact peer-declaration and credential terms), so a
  later decision is a narrow application of ADR-0017, not a fresh boundary
  debate. `athena-query`'s W4 scoping is otherwise untouched.
- **Negative / trade-offs:** the RDS Data API route only covers
  Data-API-enabled Aurora clusters — a consumer needing a non-Data-API RDS
  instance or a self-managed Postgres server still has no in-boundary route
  and would force a fresh decision. DocumentDB support remains speculative
  and unbuilt; teams wanting it today still have no fleet-scope answer. Any
  future `aws/rds-data` build is still gated behind an actual consumer
  script per ADR-0027 — this ADR only pre-clears the dependency-boundary
  question, it does not schedule the work.
- **Semver impact:** none from this ADR alone (documentation; Proposed, not
  yet building anything). The `aws/rds-data` wrapper it eventually permits
  would land as an additive `./aws` barrel export — minor, per ADR-0027's
  established pattern and moving the count-enforced submodule ledger by one.
  A future `mongodb` optional-peer addition would likewise be additive —
  minor, per ADR-0017.

## Update (2026-08-13) — status corrected from Proposed to Accepted

This ADR's `## Decision` section was always definitive — two-tier admission,
with the RDS Data API route and the DocumentDB named-terms gate both fully
specified — but the `Status:` line was never flipped from `Proposed`, and
both `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` had, in the
meantime, come to treat its outcome as settled while independently
**misstating** the Decision itself: both trackers' P2/D4 rows for
`aws/rds-data`/DocumentDB read "ADR-0031 already dropped `pg`"/"already
dropped `mongodb`" and marked the rows **Rejected**. That inverts what this
ADR actually decided. [ADR-0029](./0029-script-dependency-boundary.md) is
what dropped the raw `pg`/`mongodb` drivers from fleet scope; this ADR's
whole purpose was re-opening that question and **re-admitting** Aurora
PostgreSQL (via the RDS Data API, an AWS SDK client) while keeping
DocumentDB gated on named, pre-cleared terms — neither engine was "dropped"
by this ADR. Found and corrected by a 2026-08 tracker-reconciliation audit:
status flipped to `Accepted` (matching the Decision that was already live),
and both trackers' rows corrected to **Deferred** — gated on an actual
consumer script per this ADR's own Consequences ("Any future `aws/rds-data`
build is still gated behind an actual consumer script per ADR-0027"), not
Rejected. Tracked as issues #204/#205 (`docs/ROADMAP.md`,
`docs/plans/IMPLEMENTATION.md` § Gated library modules).

## Update (2026-08-14) — the ADR-0027 consumer gate opened

A Data-API-enabled Aurora PostgreSQL cluster became reachable, opening the
per-consumer-need gate this ADR's Consequences section anticipated. The
`aws/rds-data` wrapper (`M3LRDSDataOperations`) shipped per this ADR's
Decision (**PR:** #424); its named consumer, the `rds-data-sql` script
(ROADMAP W6), is in review as a follow-on PR in the same two-PR chain. Once
both land, issue #204's D4 row flips `Deferred`/`In review` → `Done` in both
trackers. DocumentDB's gate (issue #205) is unaffected — it remains deferred
on its own, separately unmet terms.

## Update (2026-08-15) — the D4 gate is retired

Both PRs in the two-PR chain landed: the `aws/rds-data` wrapper (merged as **PR:** #424) and its named consumer, the `rds-data-sql` script (merged as **PR:** #425), both on 2026-08-14. Issue #204's D4 row is flipped to `Done` in both trackers (`docs/ROADMAP.md`, `docs/plans/IMPLEMENTATION.md` § Gated library modules) and the issue is closed. ROADMAP W6 closes alongside it (issue #426). One known limitation carries forward rather than closing with the gate: no live Data-API-enabled Aurora cluster has yet exercised the wrapper end-to-end — both PRs' responses were verified against installed `@aws-sdk/client-rds-data` dist-types, not real infrastructure (`docs/logs/2026-08-14-aws-rds-data.md`, `docs/logs/2026-08-14-rds-data-sql.md`). DocumentDB's gate (issue #205) remains unaffected — it stays deferred on its own, separately unmet terms.

## Update (2026-08-16) — the D4 DocumentDB gate is rejected

Issue #205's D4 row is flipped `Deferred` → `Rejected` in both trackers
(`docs/ROADMAP.md`, `docs/plans/IMPLEMENTATION.md` § Gated library modules),
and the issue is closed. This is **not** a return to the original 2026-07
Rejected verdict that was reverted in 2026-08 (that one misread this ADR as
having "dropped" `mongodb`, when ADR-0029 did) — this rejection accepts the
Decision above in full and rejects the gate on its own unmet terms: a
2026-08 audit found no evidence anywhere in the repo of a real DocumentDB
workload (every mention is gate bookkeeping, archived pre-ADR-0029 design
material, a stale branch name, or a test fixture), confirmed there is still
no AWS-SDK query path for DocumentDB, and confirmed the fleet's documented
execution environment (public HTTPS, no VPC attachment) cannot reach a
DocumentDB cluster.

**The four named DocumentDB terms in the Decision section above (the
optional `mongodb` peer, the `ERR_MONGODB_MISSING_DEP` error convention, the
AWS-credential-seam requirement, and mandatory TLS) are withdrawn and no
longer stand as pre-approval.** They are left in place as history — this ADR
is immutable once Accepted (`docs/adr/README.md`) and its Aurora tier already
shipped — but the same audit found they never covered three design problems
a real wrapper would have to solve: (1) a provider-seam mismatch (an optional
peer must load via `await import()`, but `AWSClientProvider`'s getters are
documented as synchronous because every existing service client is a hard
dependency — `packages/m3l-common/src/aws/clients/provider.ts`); (2) no
connection-lifecycle precedent (every existing optional peer in `core/text`
is a stateless per-call parser; a `MongoClient` needs connect/close
lifecycle management); (3) no TLS/CA-bundle handling seam exists anywhere in
the library. The terms therefore understated the true cost and cannot be
cited as pre-clearance; any future proposal starts from a fresh boundary
audit, not a narrow ADR-0017 application. ADR-0029's dependency boundary is
left intact and unreopened.

Revisit only if a real DocumentDB workload appears **and** a VPC-reachable
execution environment is documented — matching the two-conjunct standard the
Aurora gate actually met (issue #204: "a Data-API-enabled Aurora cluster
became reachable").

## Links

- Supersedes / superseded by: **refines [ADR-0029](./0029-script-dependency-boundary.md)**
  (narrows its "Postgres, MongoDB… out of fleet scope" trade-off into the
  two-tier rule above; ADR-0029's actual decision — the hard
  library-only dependency boundary for scripts — is unaffected and stands in
  full).
- Related: [ADR-0017](./0017-dependency-loading-standard.md) (required-vs-optional
  dependency tiering; the optional-peer mechanism this ADR reserves for a
  future `mongodb` decision); [ADR-0026](./0026-sqs-operations-wrapper.md) /
  [ADR-0027](./0027-aws-sdk-boundary-typed-wrappers.md) (the typed-wrapper
  submodule pattern `aws/rds-data` would follow, and the per-consumer-need
  gate this ADR is a named exception to); [ADR-0028](./0028-aws-service-naming-convention.md)
  (naming: `rds-data` as the official RDS Data API service identifier);
  `docs/ROADMAP.md` / `docs/plans/IMPLEMENTATION.md` P2/D4 rows (the two
  gated items this ADR files).
