# 0031. Relational and document data-engine access for the consumer fleet

- **Status:** Proposed
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
