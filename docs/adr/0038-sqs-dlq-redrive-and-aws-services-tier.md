# 0038. Widen the SQS wrapper for DLQ redrive; add an `AWSServiceProvider` services tier

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

An internal capability audit (see [ADR-0037](./0037-deepen-first-re-read-against-consumer-pull.md))
found two AWS-surface gaps, both of which touch ground ADR-0026 already
staked out:

1. **DLQ redrive is out of scope.** ADR-0026 built `M3LSQSOperations` with
   `receive`/`sendBatch`/`deleteBatch`/`purgeQueue` for `sqs-etl`'s needs and
   explicitly did not model a receive→process→move state machine. A DLQ
   redrive/move capability (typed process-action / receive-deduplication
   enums, per-message callbacks) is a genuine gap here — `sqs-etl`'s own
   `redrive-queue.ts` step already hand-composes `receive` → `sendBatch` →
   `deleteBatch` itself, which is precisely the pattern a first-class redrive
   method would fold into the wrapper.
2. **The services tier is half-built and self-contradictory.** ADR-0026
   quotes `docs/reference/aws/clients.md`'s stance that `AWSClientProvider`
   getters "expose the underlying SDK clients directly" — yet
   `AWSClientProvider` already carries four getters that are **not** raw SDK
   clients: `sqsOperations` (`M3LSQSOperations`), `eventBridgeOperations`
   (`M3LEventBridgeOperations`), `requestSigner` (`M3LRequestSigner`), and
   `dynamoDBDocument` (a `DynamoDBDocumentClient`, one layer above the raw
   `DynamoDBClient`). All four are already load-bearing: `sqs-etl`,
   `eventbridge-schedules`, `dynamodb-crud`, and `api-gateway-client` — 4 of
   the 13 consumer scripts — construct their steps' dependencies directly off
   `aws.clients.<name>`. Meanwhile the other eleven wrappers (Athena,
   CloudFormation, CloudWatch Logs Insights, CodePipeline, ECS, EKS, Lambda,
   S3, the credentials manager, SigV4 signing beyond the getter, and the
   incoming Secrets Manager / CloudWatch Alarms / CloudWatch Metrics) must be
   caller-constructed from a raw client — an inconsistent, half-built tier.

Both deltas need deciding before the capability-deepening wave's AWS PRs
(`s3://` URI parser → CloudWatch Alarms/Metrics → Secrets Manager → SQS DLQ
redrive/Athena templating → the services tier itself, per ADR-0037's priority
order) land on top of them.

## Decision drivers

- **Retry classification must observe the untranslated SDK error** — the
  constraint ADR-0026 already established for `sendBatch`/`deleteBatch`
  applies identically to any new method that retries under throttling.
- **Zone A (ADR-0009) widening is justified by a genuinely acyclic edge a
  specific PR needs, never speculative convenience** — same standard ADR-0026
  applied when it widened `aws/**`'s `except` list to admit `core/polling`.
- **Additive-by-default** (ADR-0037): this wave should not force a major bump
  unless a finding genuinely earns one.
- **Scripts touching AWS depend only on `@m3l-automation/m3l-common`**
  (ADR-0029) — a redrive capability must not push `sqs-etl` toward importing
  `@aws-sdk/client-sqs` directly for anything the wrapper doesn't yet cover.

## Considered options

### DLQ redrive scope

1. **Add a `redrive`/`move` method to `M3LSQSOperations`** composing the
   existing `receive`/`sendBatch`/`deleteBatch` primitives internally, plus
   typed process-action and receive-deduplication enums modeling the redrive
   flow directly. Reuses the retry composition ADR-0026 already solved for
   `sendBatch`/`deleteBatch` — no new Zone A edge, since redrive is built
   entirely from primitives that already retry correctly.
2. **Leave redrive as the caller's responsibility**, i.e. accept `sqs-etl`'s
   own hand-composed `redrive-queue.ts` as the permanent shape. Rejected:
   this is the exact "second consumer duplicates a pattern" trigger ADR-0021/
   ADR-0037's intake gate exists to catch — the pattern already exists once
   in this repo waiting to be promoted into a first-class wrapper capability.

### Services tier

1. **Add `AWSServiceProvider`, exposed as `.services` on `AWSProvider`**,
   mirroring `AWSClientProvider`'s lazy-build-and-cache pattern, so every
   wrapper (all fifteen post-wave: the eleven existing plus `s3://`-adjacent
   helpers are not services, plus CloudWatch Alarms, CloudWatch Metrics,
   Secrets Manager) is reachable as `provider.services.<name>` without caller
   construction. The four existing `.clients` getters (`sqsOperations`,
   `eventBridgeOperations`, `requestSigner`, `dynamoDBDocument`) are marked
   `@deprecated` in place, pointing at their `.services` equivalent, but kept
   functional — removing them would source-break `sqs-etl`,
   `eventbridge-schedules`, `dynamodb-crud`, and `api-gateway-client` in the
   same wave that adds their replacement, which is unnecessary churn for a
   consistency fix. `.clients` reverts to being documentation-accurate ("raw
   SDK clients") going forward: no _new_ non-raw getter is added to it: any
   future wrapper is added to `.services` only.
2. **Remove the four getters outright**, forcing `.clients` back to
   raw-clients-only immediately. Rejected: breaking, needs a 3.0 bump per
   ADR-0037's additive-by-default driver, and nothing about this wave's
   findings independently earns a major.
3. **Leave `.clients` as-is and only document the four getters as
   exceptions**, without building `.services`. Rejected by the maintainer
   (see ADR-0037's linked decision record) — it fixes the documentation but
   leaves the eleven-vs-four asymmetry unresolved, and every future wrapper
   (Secrets Manager, CloudWatch Alarms/Metrics, and whatever comes after)
   would keep facing the same caller-construction tax a services facade
   avoids.

## Decision

We chose **DLQ redrive option 1** and **services tier option 1**.

### SQS DLQ redrive

`M3LSQSOperations` gains a redrive/move method composing `receive` →
process-callback → `sendBatch`(destination) → `deleteBatch`(source)
internally, with the retry composition happening exactly where ADR-0026
requires it: around the raw `.send()` calls, before any error translation.
New types model the redrive flow directly — a process-action enum
(`log`/`retry`/`move`-equivalent outcome, exact naming settled at
implementation time) and a receive-deduplication-mode enum — added to
`aws/sqs/types.ts`. No Zone A change: the method is built from primitives
that already import `core/polling` under ADR-0026's existing `except` list.

A named-placeholder SQL template compiler for Athena (bundled into this PR by
the priority order) is unrelated to SQS and needs no Zone A change either —
it is pure string/template logic over `aws/athena/types.ts`'s existing
`executionParameters`, touching only `core/errors`.

### `AWSServiceProvider`

New `aws/clients/service-provider.ts` (or co-located with `aws-provider.ts` —
settled at implementation time) exposing `.services` on `AWSProvider`
alongside the existing `.clients`. Every wrapper submodule is constructed
lazily and cached for the facade's lifetime, mirroring
`AWSClientProvider`'s `destroy()`-on-teardown discipline. The four existing
`.clients` getters are annotated `@deprecated — use \`.services.<name>\`
instead`(TSDoc`@deprecated`tag, not a runtime warning) and their
implementation is unchanged;`docs/reference/aws/clients.md`is updated to
state the`.clients` contract cleanly ("raw SDK clients, plus four
deprecated pre-`.services`convenience wrappers kept for compatibility") and`docs/reference/aws/*`for each service notes its`.services` access path.

**Zone A (ADR-0009) analysis — no widening required.** Every new/changed
piece in this wave was checked against what it needs to import:

| Addition                    | Imports beyond `core/errors`                                                                                                                                                  | Zone A impact                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `s3://` URI parser          | none                                                                                                                                                                          | none                                       |
| CloudWatch Alarms / Metrics | none (wraps existing raw `cloudWatch` client getter)                                                                                                                          | none                                       |
| Secrets Manager             | none — redaction of fetched secret values is a caller/logging concern (`M3LLogger`'s built-in redaction), not something the wrapper itself needs to import `core/logging` for | none                                       |
| SQS DLQ redrive             | `core/polling` (already permitted by ADR-0026)                                                                                                                                | none — reuses the existing edge            |
| Athena SQL templating       | none                                                                                                                                                                          | none                                       |
| `AWSServiceProvider`        | only other `aws/**` modules (constructs wrapper instances)                                                                                                                    | none — intra-`aws/**`, not a `core/*` edge |

`eslint.config.js`'s Zone A `except` list stays exactly
`["errors", "prompt", "polling"]` (the ADR-0026 state) through this whole
wave. This closes ADR-0037's priority-order check: the analysis was done
deliberately, in advance, and the finding is that no widening is needed — not
that one was silently skipped.

## Consequences

- **Positive:** `sqs-etl`'s hand-composed redrive logic gets a first-class,
  correctly-retrying home in the library; every future AWS wrapper has one
  obvious, consistent access path (`.services.<name>`) instead of a choice
  between caller-construction and an ad-hoc `.clients` getter; the
  `.clients`/`.services` split is now documented and enforced rather than
  accidental; no dev-tooling churn since Zone A needs no change.
- **Negative / trade-offs:** `AWSProvider` now carries two overlapping access
  surfaces (`.clients` and `.services`) rather than one clean one — the
  `@deprecated` four are permanent-ish debt until a future major bump can
  remove them; the services tier is a real, ~15-wrapper-wide additive
  surface to build and coverage-gate in PR 9, larger than any other single
  PR in this wave.
- **Semver impact:** minor. New `AWSServiceProvider` export and `.services`
  getter, new SQS methods/enums, and `@deprecated` TSDoc annotations are all
  additive — no existing exported signature changes behavior, no
  `exports`-map entry changes.

## Links

- Supersedes / superseded by: none. Amends ADR-0026's scope and
  `docs/reference/aws/clients.md`'s stance, the same way ADR-0026 itself
  amended ADR-0009's Zone A enforcement without superseding either.
- Related: [ADR-0009 (dependency-direction guard)](./0009-dependency-direction-guard.md),
  [ADR-0026 (typed SQS operations wrapper)](./0026-sqs-operations-wrapper.md),
  [ADR-0029 (script dependency boundary)](./0029-script-dependency-boundary.md),
  [ADR-0033 (typed S3 operations wrapper — the other prior "wrap a raw
  client" precedent)](./0033-aws-s3-operations-wrapper.md),
  [ADR-0037 (deepen-first re-read — sets this wave's priority order and the
  additive-by-default driver this ADR relies on)](./0037-deepen-first-re-read-against-consumer-pull.md),
  `packages/m3l-common/src/aws/clients/provider.ts`, `packages/m3l-common/src/aws/clients/aws-provider.ts`,
  `packages/m3l-common/src/aws/sqs/client.ts`, `scripts/sqs-etl/src/steps/redrive-queue.ts`
  (the pattern being promoted), `scripts/eventbridge-schedules`,
  `scripts/dynamodb-crud`, `scripts/api-gateway-client` (the three other
  consumers of the four soon-`@deprecated` getters).
