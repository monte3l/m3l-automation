# 0033. Typed S3 operations wrapper over the raw SDK client

- **Status:** Accepted
- **Date:** 2026-07-18
- **Deciders:** Enrico Lionello

## Context and problem statement

`docs/ROADMAP.md`'s W3 wave lists `s3-objects` as a "thin op-dispatch...
existing getters ✓" consumer script, implying it can be built directly against
`AWSClientProvider.s3` (`aws/clients/provider.ts:151`), a **raw `S3Client`**,
the same way `dynamodb-crud` (W2) reached for `provider.dynamoDBDocument`.

That premise doesn't hold. Dispatching a single S3 operation
(`ListObjectsV2`, `GetObject`, `PutObject`, `CopyObject`, `DeleteObject(s)`)
against a raw `S3Client` requires constructing the matching command object
(`ListObjectsV2Command`, ...) from `@aws-sdk/client-s3`. ADR-0027 bans
`@aws-sdk/*` imports (including type-only imports) anywhere under
`scripts/*/src`, enforced by `@typescript-eslint/no-restricted-imports` in
`eslint.config.js`. A script cannot import command classes, so it cannot use
the raw client at all — only a library-owned typed wrapper (the ADR-0026/
ADR-0027 pattern: `aws/sqs`'s `M3LSQSOperations`, `aws/dynamodb`'s operations
module) gives a script anything to call. `s3-objects` is therefore
**wrapper-gated**, the same shape as W4's `api-gateway-client` waiting on a
future `aws/signing` wrapper — it was mis-filed under W3 in the roadmap.

Unlike the SQS case (ADR-0026), this decision carries **no new-dependency
question**: `@aws-sdk/client-s3` is already a hard `dependencies` entry
(`packages/m3l-common/package.json`), used today by the `s3` getter itself.

## Decision drivers

- Scripts touching S3 must depend only on `@m3l-automation/m3l-common`
  (ADR-0029), never a raw `@aws-sdk/client-s3` import (ADR-0027).
- No breaking change to the `exports` map or any existing exported signature.
- Follow the established typed-wrapper pattern (ADR-0026) rather than inventing
  a new shape: bespoke methods translating SDK request/response into
  library-owned plain types, plus one operation-error subclass.
- Don't speculatively widen Zone A (`import-x/no-restricted-paths`, ADR-0009)
  for retry composition unless a concrete correctness need surfaces during
  implementation, the way ADR-0026 found one for SQS batch throttling. Most
  wrappers (`aws/dynamodb`) need no `core/polling` import at all — S3 gets the
  same default until proven otherwise.

## Considered options

1. **Add a typed `aws/s3` operations wrapper submodule** — `M3LS3Operations`
   over the raw `S3Client`, covering the ops `s3-objects` needs
   (`listObjects`, `headObject`, `getObject`, `putObject`, `copyObject`,
   `deleteObject`, `deleteObjects`), surfaced through the `aws/index.ts`
   namespace barrel (no new `exports`-map entry). Matches the ADR-0026/
   ADR-0027 pattern exactly.
2. **Leave `s3` as a raw-client-only getter and drop `s3-objects` from the
   fleet.** Rejected: the roadmap already commits to a control-plane CRUD
   script per major service; S3 object operations are a core automation need,
   not a speculative one.
3. **Let `s3-objects` import `@aws-sdk/client-s3` directly, carving an
   exception into the ESLint boundary rule.** Rejected: reopens exactly the
   problem ADR-0027/ADR-0029 close — one script-local exception invites more,
   and the boundary rule has no per-service escape hatch today.

## Decision

We chose **option 1**: add `packages/m3l-common/src/aws/s3/`, a typed
`M3LS3Operations` wrapper (symbol names `M3LS3*` per ADR-0028's full-official-
service-name convention — "S3" is the official short form Amazon uses for
"Amazon Simple Storage Service," matching the existing `s3` getter name),
covering the operation surface `s3-objects` (and any future S3 consumer)
needs. Errors translate into a new `M3LS3OperationError`
(`code: "ERR_S3_OPERATION"`) chained via `cause`, mirroring
`M3LDynamoDBOperationError`/`M3LSQSOperationError`. The module re-exports
through `aws/index.ts` — no new `exports`-map subpath.

No Zone A widening at this stage: none of the target operations have a known
retry-classification correctness constraint like SQS's `SendMessageBatch`
throttling did. If `implementing-submodules` surfaces one (e.g. `PutObject`/
`CopyObject` on `SlowDown` 503s), it follows the ADR-0026 precedent — retry
composed _inside_ the wrapper, before error translation, with a matching Zone A
`except` addition — rather than left to the caller.

This reclassifies `s3-objects` from W3 ("existing getters ✓") to
wrapper-gated, tracked at close-out by correcting the W3 row in
`docs/ROADMAP.md` / `docs/plans/IMPLEMENTATION.md`.

## Consequences

- **Positive:** `s3-objects` (and any future S3-touching script) never imports
  `@aws-sdk/client-s3`; establishes the second instance of the typed-wrapper
  pattern (after SQS), reinforcing it as the default shape for a script's
  first need against a service the raw-client getters don't already cover
  ergonomically.
- **Negative / trade-offs:** built ahead of the W5 promotion-pass default
  (only `s3-objects` exists as a caller); if a second, materially different S3
  consumer never appears, some of the wrapper's generality (e.g. paginated
  `listObjects`) is unproven speculation, accepted as the informed trade the
  ADR-0026 precedent already normalized. The wrapper adds 80%-coverage-gated
  surface to maintain (submodules are not coverage-exempt, unlike scripts).
- **Semver impact:** minor. Purely additive: a new `aws/s3` submodule
  re-exported through the existing `aws/index.ts` barrel, one new error code
  registered in `M3L_ERROR_CODES`, no `exports`-map change, no existing
  exported signature altered, no new runtime dependency (`@aws-sdk/client-s3`
  is already hard-pinned).

## Links

- Supersedes / superseded by: none. Corrects `docs/ROADMAP.md`'s W3
  classification of `s3-objects` (documentation fix, not itself an ADR
  amendment).
- Related: [ADR-0026 (typed SQS operations wrapper)](./0026-sqs-operations-wrapper.md) —
  the pattern this ADR follows; [ADR-0027 (scripts never import `@aws-sdk/*`)](./0027-aws-sdk-boundary-typed-wrappers.md);
  [ADR-0028 (AWS service naming convention)](./0028-aws-service-naming-convention.md);
  [ADR-0029 (script dependency boundary)](./0029-script-dependency-boundary.md);
  [ADR-0009 (dependency-direction guard — Zone A)](./0009-dependency-direction-guard.md);
  `packages/m3l-common/src/aws/clients/provider.ts` (`s3` getter — the raw
  client this wrapper sits over); `docs/plans/IMPLEMENTATION.md` (W3 row —
  the call-site this ADR unblocks, tracked for correction at close-out).
