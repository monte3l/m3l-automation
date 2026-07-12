# SQS Operations

`M3LSQSOperations` is a typed wrapper over a raw `SQSClient`, so callers never
import `@aws-sdk/client-sqs` command classes directly. See
[ADR-0026](../../adr/0026-sqs-operations-wrapper.md) for why this module
exists and why it is permitted to import `core/polling`.

> **Scaffold status:** this page describes the intended contract.
> Implementation is tracked in `docs/implementation-status.md` (status 🧪);
> method bodies currently throw `M3LSQSOperationError("... not yet
implemented")`.

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LSQSOperations` is the first
submodule to instead expose bespoke, typed methods over one of those raw
clients (`sqs`), translating SDK request/response shapes into plain,
library-owned types so a caller never touches an `@aws-sdk/client-sqs` type.

- `M3LSQSOperations` — the wrapper class, constructed from a raw `SQSClient`.
- `M3LSQSOperationError` — thrown on a request-level SQS failure.
- Plain types: `M3LSQSReceivedMessage`, `M3LSQSSendEntry`,
  `M3LSQSDeleteEntry`, `M3LSQSBatchFailure<T>`, `M3LSQSBatchResult<T>`,
  `M3LSQSReceiveOptions`.

## Public API

### `M3LSQSOperations`

**Constructor** — `new M3LSQSOperations(client)`, where `client` is a raw
`SQSClient` (e.g. `script.aws.clients.sqs`, or the cached
`script.aws.clients.sqsOperations` convenience getter which constructs one
for you, sharing the underlying `sqs` client's lifecycle).

| Method                           | Retried? | Returns                                         | Throws                 |
| -------------------------------- | -------- | ----------------------------------------------- | ---------------------- |
| `receive(queueUrl, options?)`    | No       | `Promise<readonly M3LSQSReceivedMessage[]>`     | `M3LSQSOperationError` |
| `sendBatch(queueUrl, entries)`   | Yes      | `Promise<M3LSQSBatchResult<M3LSQSSendEntry>>`   | `M3LSQSOperationError` |
| `deleteBatch(queueUrl, entries)` | Yes      | `Promise<M3LSQSBatchResult<M3LSQSDeleteEntry>>` | `M3LSQSOperationError` |
| `purgeQueue(queueUrl)`           | No       | `Promise<void>`                                 | `M3LSQSOperationError` |

**Retry:** `sendBatch`/`deleteBatch` wrap the raw SDK `.send()` call in
`M3LRetryRunner` configured by `M3LPollingPolicies.sqsBatchSend()`
(throttling/network classifiers, exponential backoff 100ms→3s). A per-entry
failure inside a _successful_ response (SQS's `Failed[]`) is never retried —
it is returned via `M3LSQSBatchResult.failed`, joined back to the caller's
original input entry. `receive`/`purgeQueue` are not retried: a long-poll
receive absorbs transient emptiness on its own, and SQS's `PurgeQueue`
60-second cooldown (`PurgeQueueInProgress`) is a business condition, not a
transient fault.

**Batch limits:** `sendBatch`/`deleteBatch` accept at most 10 entries per
call (the SQS API cap) with unique `id`s; a violation throws
`M3LSQSOperationError` before any AWS call is made.

**One-shot `receive`, no drain loop:** the class exposes a single
`ReceiveMessage` call, not a draining generator. Loop policy (delete-after-
read, a message-count budget, when to stop) is a caller/script decision, kept
out of the library so it stays a reusable primitive rather than encoding one
consumer's termination policy.

### `M3LSQSOperationError`

Subclass of `M3LError` with `code: "ERR_SQS_OPERATION"`. Thrown when a
request-level SQS operation fails: a whole batch request rejects after
retries, `receive`/`purgeQueue` rejects, or a pre-flight guard (batch size,
duplicate ids) fails before any AWS call. The originating SDK error is
chained via `cause`. Per-entry batch failures are **not** represented by this
error — see `M3LSQSBatchResult.failed`.

### Plain types

- **`M3LSQSReceivedMessage`** — `{ messageId, receiptHandle, body,
md5OfBody?, attributes?, messageAttributes? }`.
- **`M3LSQSSendEntry`** — `{ id, body, delaySeconds?, messageGroupId?,
messageDeduplicationId?, messageAttributes? }`. `id` must be unique within
  a batch.
- **`M3LSQSDeleteEntry`** — `{ id, receiptHandle }`. `id` must be unique
  within a batch.
- **`M3LSQSBatchFailure<T>`** — `{ entry: T, code, senderFault, message? }`;
  `entry` is the caller's original input entry, so a failure can be logged or
  re-driven with no id bookkeeping of its own.
- **`M3LSQSBatchResult<T>`** — `{ successful: readonly T[], failed:
readonly M3LSQSBatchFailure<T>[] }`. Every input entry lands in exactly one
  of the two.
- **`M3LSQSReceiveOptions`** — `{ maxMessages?, waitTimeSeconds?,
visibilityTimeout?, messageAttributeNames?, systemAttributeNames? }`.

## Usage

### From within a script

```typescript
// script.aws.clients.sqsOperations is the cached convenience getter
const sqsOperations = script.aws.clients.sqsOperations;

const messages = await sqsOperations.receive(queueUrl, { maxMessages: 10 });

const result = await sqsOperations.sendBatch(queueUrl, [
  { id: "0", body: JSON.stringify({ hello: "world" }) },
]);
// result.failed[].entry is the original M3LSQSSendEntry, ready to write
// straight to a failed.jsonl file with no extra bookkeeping.
```

### Standalone construction

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSClientProvider({
  profile: AWS.parseAWSProfile("my-profile"),
});
const sqsOperations = new AWS.M3LSQSOperations(provider.sqs);
```

## Notes and behavior

- No `@aws-sdk/client-sqs` type ever appears in this module's public surface
  — every request/response shape is translated to a plain type in
  `aws/sqs/types.ts` at the boundary.
- `M3LSQSOperations` holds no destroyable resource of its own; when accessed
  via `AWSClientProvider.sqsOperations`, it shares the underlying `sqs`
  client's connection lifecycle and is cleared (not independently destroyed)
  by `provider.close()`.
- `core/polling` is an intentional, ADR-0026-recorded exception to Zone A
  (`aws/**` may otherwise import only `core/errors`/`core/prompt`) — scoped
  to this module's internal retry composition, not a general loosening.

## See also

- [AWS Clients](./clients.md) — the raw `sqs` client getter and
  `AWSClientProvider`/`AWSProvider` this module builds on.
- [ADR-0026](../../adr/0026-sqs-operations-wrapper.md) — why this pattern
  exists and the Zone A amendment.
- [Polling](../core/polling.md) — `M3LRetryRunner` / `M3LPollingPolicies` /
  the classifiers this module composes internally.
