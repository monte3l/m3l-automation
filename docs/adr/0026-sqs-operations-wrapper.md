# 0026. Typed SQS operations wrapper over the raw SDK client

- **Status:** Accepted
- **Date:** 2026-07-12
- **Deciders:** Enrico Lionello

## Context and problem statement

Every AWS client getter on `AWSClientProvider` (`aws/clients/provider.ts`)
returns a **raw AWS SDK v3 client** by deliberate design
(`docs/reference/aws/clients.md`: "expose the underlying SDK clients
directly"). The first SQS-touching consumer script (`sqs-etl`, W2) would
otherwise import command classes (`ReceiveMessageCommand`,
`SendMessageBatchCommand`, ...) from `@aws-sdk/client-sqs` directly and call
`client.send(new XCommand(...))`, adding that package as its own direct
dependency purely to get typed command/response shapes.

ADR-0021's D4 intake gate and the W5 "promotion pass" convention normally
defer a library wrapper until a **second** script duplicates a pattern —
`sqs-etl` is the first SQS consumer, so the default posture would be: consume
the raw client directly (as `json-etl`, W1, does with library primitives). The
consumer explicitly chose to override that default for this case and build the
wrapper now, accepting the larger up-front scope, so the script's `steps/`
never import an AWS SDK package.

Building the wrapper surfaced a second, load-bearing problem: retry
composition. `M3LPollingPolicies.sqsBatchSend()` pairs with `M3LRetryRunner`
to retry `SendMessageBatch` on throttling/network failures.
`awsThrottlingClassifier`/`awsNetworkClassifier`
(`core/polling/classifiers.ts:167-193`) read `.name` / `.code` / `.Code` /
`$metadata` **directly off the thrown value**, never `.cause`. If the wrapper
catches the raw SDK throw and re-wraps it into a library `M3LError` before the
retry runner ever sees it, the classifier can never recognize it — retry would
silently never fire. The retry composition therefore has to happen **inside**
the wrapper, wrapping the raw `.send()` call before any error translation. That
requires `aws/sqs/**` to import `core/polling`, which
`eslint.config.js`'s Zone A (`import-x/no-restricted-paths`, ADR-0009) does
not currently permit — `aws/**` may import only `core/errors` and
`core/prompt`.

## Decision drivers

- Scripts touching SQS should depend only on `@m3l-automation/m3l-common`,
  never a raw `@aws-sdk/client-*` package, once this wrapper exists.
- Retry classification must observe the actual thrown SDK error shape, not a
  library-wrapped one — this is a correctness constraint, not a style
  preference.
- Zone A (ADR-0009) exists to keep `aws/**` a shallow, acyclic island; any
  widening must be justified by a genuinely acyclic edge, not general
  convenience.
- No breaking change to the `exports` map or any existing exported signature.

## Considered options

1. **Wrapper composes retry internally; widen Zone A to permit `aws/** →
core/polling`.** The wrapper's `sendBatch`/`deleteBatch` wrap the raw
   `.send()` call in `new M3LRetryRunner(M3LPollingPolicies.sqsBatchSend())`
   before any error translation, so the classifier sees the untouched SDK
   error. Requires adding `"polling"` to Zone A's `except` list.
2. **Caller (script) composes retry**, wrapping the wrapper's `sendBatch()`
   call in its own `M3LRetryRunner`. Keeps Zone A untouched. Rejected: by the
   time `sendBatch()` returns or throws, the raw SDK error has already been
   caught and re-wrapped into `M3LSQSOperationError` (or the method has
   already returned a `Failed[]`-mapped result) — the classifier would never
   see a recognizable throttling/network shape, so retries would silently
   never trigger. This is not a style trade-off; it is broken.
3. **No wrapper-owned retry; document that `sqs-etl` calls
   `M3LPollingPolicies.sqsBatchSend()` itself around the raw client**,
   abandoning the typed-wrapper goal for `send`/`delete`. Rejected: reopens the
   exact problem this ADR exists to close — the script would still need
   `@aws-sdk/client-sqs` for command classes on the retried path.

## Decision

We chose **option 1**: the wrapper (`packages/m3l-common/src/aws/sqs/`) owns
retry composition internally, and Zone A's exception list widens from
`except: ["errors", "prompt"]` to `except: ["errors", "prompt", "polling"]`
(`eslint.config.js`, the `aws/**` zone block).

This also establishes a new library pattern: `aws/sqs/client.ts`'s
`M3LSQSOperations` class is the first submodule that wraps a raw AWS SDK
client with bespoke typed methods (`receive`, `sendBatch`, `deleteBatch`,
`purgeQueue`) translating SDK request/response shapes into library-owned plain
types (`M3LSQSReceivedMessage`, `M3LSQSSendEntry`, `M3LSQSBatchResult<T>`,
etc. in `aws/sqs/types.ts`) and a new error subclass
(`M3LSQSOperationError`, code `ERR_SQS_OPERATION`, in `aws/sqs/error.ts`).
Retry scope is `sendBatch`/`deleteBatch` only (throttling/network throws);
`receive`/`purgeQueue` are not retried (long-poll absorbs transient emptiness;
`PurgeQueueInProgress` is a 60-second business cooldown, not a transient
fault). The module surfaces through the `aws/index.ts` namespace barrel —
no new `exports`-map entry.

`core/polling` is acyclic with respect to `aws/*` — it imports only
`internal/polling/*` and `core/events`, never anything under `aws/`. The Zone A
widening therefore adds one verified-acyclic edge, not a general loosening; the
zone still blocks `aws/sqs/**` (or any other `aws/**` file) from importing any
other `core/*` module.

## Consequences

- **Positive:** `sqs-etl` (and any future SQS-touching script) never imports
  an AWS SDK package directly; retry-on-throttling for `SendMessageBatch` /
  `DeleteMessageBatch` works correctly because classification happens on the
  untranslated SDK error; establishes a reusable pattern (typed wrapper +
  internal retry + library error) for a future AWS submodule that needs the
  same shape.
- **Negative / trade-offs:** `aws/**` is no longer a pure two-module island
  (`errors`, `prompt`) — it now also depends on `core/polling`, a real (if
  narrow and acyclic) increase in the AWS layer's surface. This is a
  first-consumer library build ahead of the W5 promotion-pass default (only
  `sqs-etl` exists as a caller today); if a second, materially different SQS
  consumer never appears, the wrapper's generality is unproven speculation,
  accepted here as a deliberate, informed trade the consumer chose over the
  default policy. The wrapper adds ~80%-coverage-gated surface to maintain
  (submodules, unlike scripts, are not coverage-exempt).
- **Semver impact:** minor. Purely additive: a new `aws/sqs` submodule
  re-exported through the existing `aws/index.ts` barrel, one new error code
  registered in `M3L_ERROR_CODES`, no `exports`-map change, no existing
  exported signature altered. The Zone A widening is dev-time lint
  configuration only — no effect on the published package or runtime
  behavior.

## Links

- Supersedes / superseded by: none. Amends ADR-0009's Zone A enforcement
  (`eslint.config.js`), not its tool choice.
- Related: [ADR-0009 (dependency-direction guard)](./0009-dependency-direction-guard.md),
  [ADR-0021 (post-1.0 deepen-first strategy — D4/D5 intake gate)](./0021-post-1.0-deepen-first-strategy.md),
  [ADR-0017 (dependency loading standard — AWS SDK as required hard dependency)](./0017-dependency-loading-standard.md),
  `packages/m3l-common/src/aws/clients/provider.ts` (`dynamoDBDocument`
  getter — closest existing wrap-a-raw-client precedent),
  `packages/m3l-common/src/core/polling/M3LPollingPolicies.ts` (`sqsBatchSend`),
  `packages/m3l-common/src/core/polling/classifiers.ts`
  (`awsThrottlingClassifier`/`awsNetworkClassifier` — the classification
  constraint this ADR resolves), `docs/plans/IMPLEMENTATION.md` (W2 `sqs-etl`
  — the named consumer call-site that opens the ADR-0021 gate).
