# 0044. Remove three deprecated `AWSClientProvider` wrapper getters

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** Enrico Lionello (maintainer); Claude (implementation)

## Context and problem statement

ADR-0038 added `AWSServiceProvider` (`.services`) as the single, consistent
access path for library-owned wrapper objects over raw AWS SDK clients. It
found `AWSClientProvider` already carried four getters that were not raw SDK
clients — `sqsOperations`, `eventBridgeOperations`, `requestSigner`, and
`dynamoDBDocument` — contradicting `docs/reference/aws/clients.md`'s stance
that `.clients` exposes "the underlying SDK clients directly." Rather than
remove them in the same wave that added their replacement, ADR-0038 marked all
four `@deprecated` in place and kept them functional, reasoning that removal
would source-break the four consumer scripts already built against them for
"unnecessary churn for a consistency fix." Its Consequences section called
this "permanent-ish debt until a future major bump can remove them," and its
rejected option 2 ("remove the four getters outright") noted removal "needs a
3.0 bump."

Issue #338 tracked this removal, filed by `docs/plans/IMPLEMENTATION.md`'s
"Gated library modules & deferred decisions (P2)" table with the unblock
condition: _"re-file against a real 2.0 milestone rather than carry as
unscheduled 1.x work; not a live path today."_

That gate cannot fire. `packages/m3l-common` is already at 2.4.0 — the next
major is 3.0, exactly as ADR-0038 itself said, not the "2.0 / breaking"
milestone label the tracker row names (that string is a hard-coded milestone
title in `bin/lib/hub-sync.mjs`, not a version target; no 2.0/3.0 roadmap or
plan document exists anywhere in the repo). And per ADR-0020, the package is
internal and has never been published — a "major bump" is a manual one-line
edit to `package.json` with zero external consumers to break. There is no
release train, no registry, and no external signal that would ever cause this
gate to open on its own.

## Decision drivers

- **Additive-by-default has a floor.** ADR-0037's "no major bump unless a
  finding genuinely earns one" driver assumes the gate blocking a bump is
  itself real. A gate with no observable trigger is not a deferral, it is
  permanent debt wearing a deferral's TSDoc tag.
- **`dynamoDBDocument` is not the same shape as the other three.** It returns
  a genuine AWS SDK client (`DynamoDBDocumentClient` from `@aws-sdk/lib-dynamodb`),
  not a library-owned wrapper object — `docs/reference/aws/clients.md` already
  documents it twice, once in the raw-client table and again in the
  convenience-getter table, conceding in the latter that it is "a raw
  (document-layer) SDK client, not a library-owned wrapper, but is grouped
  here per ADR-0038's four-getter accounting."
- **Minimize blast radius for a deferred-debt cleanup.** A removal driven by
  "this gate can never open" should not also import new risk (an untested
  error-handling branch moved between classes) that a live feature request
  would justify taking on.

## Considered options

1. **Remove all four getters**, moving `dynamoDBDocument`'s
   `DynamoDBDocumentClient.from` construction, memoization, and
   `M3LAWSClientError` wrapping from `AWSClientProvider` into
   `AWSServiceProvider` (today a pure passthrough), retrofitting all four
   consumer scripts. Literal execution of issue #338 as filed.
2. **Remove only the three genuine wrapper getters** (`sqsOperations`,
   `eventBridgeOperations`, `requestSigner`) and keep `dynamoDBDocument` on
   `.clients`, un-deprecated. `AWSServiceProvider.dynamoDBDocument` stays an
   unchanged passthrough; only three of the four consumer scripts need
   retrofitting.
3. **Leave all four as-is**, closing issue #338 as Rejected in the same style
   as the tracker's F3 row (a breaking change re-filed against a real
   milestone, not carried as unscheduled work).

## Decision

We chose **option 2**. `sqsOperations`, `eventBridgeOperations`, and
`requestSigner` are removed from `AWSClientProvider`; callers move to their
`.services` equivalents. `dynamoDBDocument` is kept on `.clients` and its
`@deprecated` tag is removed — it was miscategorized as a wrapper getter by
ADR-0038's four-getter accounting when it is, and always was, a raw SDK
client consistent with `.clients`'s documented contract. `AWSServiceProvider`
needs no logic change: its `dynamoDBDocument` getter remains the passthrough
it already was, and `dynamoDBOperations` continues reading
`clientProvider.dynamoDBDocument` unchanged.

Option 3 was rejected because the gate ADR-0038 wrote for this decision is not
a real gate — see Context above — so declining to act does not actually
preserve optionality, it just leaves permanent debt mislabeled as deferred.
Option 1 was rejected because it would have added an uncovered `catch` branch
to `AWSServiceProvider` and required porting five additional test behaviors,
none of which addresses the actual duplication ADR-0038 flagged (the
library-owned wrapper objects being reachable two ways) — `dynamoDBDocument`
was never duplicated in that sense; it has exactly one construction path
today and after this change.

## Consequences

- **Positive:** `.clients` is restored to its documented "raw SDK clients"
  contract with no exceptions; the genuinely duplicated wrapper surface
  (`sqsOperations`/`eventBridgeOperations`/`requestSigner`) collapses onto the
  single `.services` access path ADR-0038 intended; issue #338 closes without
  carrying forward a gate that could never open; three consumer scripts
  (`sqs-etl`, `eventbridge-schedules`, `api-gateway-client`) move to
  `.services.<name>` with no step-signature changes, since every `.services`
  getter returns the identical type its `.clients` predecessor did.
- **Negative / trade-offs:** breaking change to a still-narrow surface —
  three public getters disappear from `AWSClientProvider`. `dynamoDBDocument`
  remains reachable via both `.clients.dynamoDBDocument` and
  `.services.dynamoDBDocument` (the latter a passthrough to the former) —
  this narrower removal does not fully collapse `AWSClientProvider` onto
  "true raw multiplicity clients only" the way removing all four would have;
  that duplication was judged acceptable because `dynamoDBDocument` is a raw
  client on both paths, not two competing implementations.
- **Semver impact:** major. `AWSClientProvider.sqsOperations`,
  `.eventBridgeOperations`, and `.requestSigner` are removed from the public
  API with no runtime deprecation warning ever having existed (TSDoc-only).
  `packages/m3l-common` moves 2.4.0 → 3.0.0.

## Links

- Supersedes: [ADR-0038](./0038-sqs-dlq-redrive-and-aws-services-tier.md)'s
  decision to keep all four getters deprecated-in-place rather than remove
  any of them; ADR-0038's DLQ redrive decision and Zone A analysis are
  unaffected and remain in force.
- Related: [ADR-0020 (drop release automation — why "wait for a major bump"
  is not an external gate for this package)](./0020-drop-release-automation.md),
  [ADR-0037 (additive-by-default driver this decision tests against)](./0037-deepen-first-re-read-against-consumer-pull.md),
  `docs/plans/IMPLEMENTATION.md` (issue #338 row),
  `packages/m3l-common/src/aws/clients/provider.ts`,
  `packages/m3l-common/src/aws/clients/service-provider.ts`,
  `scripts/sqs-etl`, `scripts/eventbridge-schedules`,
  `scripts/api-gateway-client` (the three retrofitted consumers).
