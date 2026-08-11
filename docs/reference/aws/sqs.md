# SQS Operations

`M3LSQSOperations` is a typed wrapper over a raw `SQSClient`, so callers never
import `@aws-sdk/client-sqs` command classes directly. See
[ADR-0026](../../adr/0026-sqs-operations-wrapper.md) for why this module
exists and why it is permitted to import `core/polling`.

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
  `M3LSQSReceiveOptions`, `M3LSQSRedriveDecision`, `M3LSQSRedriveProcessor`,
  `M3LSQSReceiveDeduplicationMode`, `M3LSQSRedriveOptions`,
  `M3LSQSRedriveResult`.

## Public API

### `M3LSQSOperations`

**Constructor** — `new M3LSQSOperations(client)`, where `client` is a raw
`SQSClient` (e.g. `script.aws.clients.sqs`, or the cached
`script.aws.clients.sqsOperations` convenience getter which constructs one
for you, sharing the underlying `sqs` client's lifecycle).

| Method                                                                   | Retried?  | Returns                                         | Throws                 |
| ------------------------------------------------------------------------ | --------- | ----------------------------------------------- | ---------------------- |
| `receive(queueUrl, options?)`                                            | No        | `Promise<readonly M3LSQSReceivedMessage[]>`     | `M3LSQSOperationError` |
| `sendBatch(queueUrl, entries)`                                           | Yes       | `Promise<M3LSQSBatchResult<M3LSQSSendEntry>>`   | `M3LSQSOperationError` |
| `deleteBatch(queueUrl, entries)`                                         | Yes       | `Promise<M3LSQSBatchResult<M3LSQSDeleteEntry>>` | `M3LSQSOperationError` |
| `purgeQueue(queueUrl)`                                                   | No        | `Promise<void>`                                 | `M3LSQSOperationError` |
| `redrive(sourceQueueUrl, destinationQueueUrl, processMessage, options?)` | Composed¹ | `Promise<M3LSQSRedriveResult>`                  | `M3LSQSOperationError` |

¹ `redrive` issues no raw SDK call of its own — it composes `receive` /
`sendBatch` / `deleteBatch`, so retry behavior is exactly the union of theirs
(see below).

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

**One-shot `receive`, no drain loop — with one first-class exception.** The
`receive` method itself remains a single `ReceiveMessage` call, not a
draining generator: an ad-hoc receive→process loop is still a caller/script
decision. `redrive` is the one composed, multi-page operation the library
promotes to a first-class method — it exists because the same
receive→process→move shape had already been hand-duplicated once
(`scripts/sqs-etl/src/steps/redrive-queue.ts`), which is precisely the
second-consumer-duplication signal an internal capability audit treats as
justification for promoting a pattern into the wrapper. It is still built
entirely from `receive`/`sendBatch`/`deleteBatch` — no new raw SDK call, no
new Zone A edge.

### `redrive` — the receive→process→move flow

`redrive(sourceQueueUrl, destinationQueueUrl, processMessage, options?)`
drains `sourceQueueUrl` page by page (via `receive`, capped per page at
`options.receiveOptions?.maxMessages ?? 10`), and for every received message
in a page invokes the caller's `processMessage` callback to decide that
message's `M3LSQSRedriveDecision`:

- **`{ action: "move", entry }`** — `entry` (an `M3LSQSSendEntry`, caller
  assigns `id`) is queued for `sendBatch(destinationQueueUrl, …)`. Only once
  that entry's send succeeds is the original message `deleteBatch`'d from
  `sourceQueueUrl` (matched back to its `receiptHandle` by `entry.id`, which
  must be unique within the page — the same uniqueness `sendBatch` already
  enforces). A send failure leaves the message in `sourceQueueUrl`
  untouched (it becomes visible again after its visibility timeout, so it is
  naturally retried on this or a later `redrive` call) and is reported via
  `M3LSQSRedriveResult.moveFailed`. A delete failure **after** a successful
  send leaves the message published to `destinationQueueUrl` **and** still
  present in `sourceQueueUrl` (a duplicate) — reported via
  `M3LSQSRedriveResult.deleteFailed`; this module does not attempt to
  compensate for a partially-succeeded move.
- **`{ action: "drop" }`** — the message is `deleteBatch`'d from
  `sourceQueueUrl` directly, no send. This delete uses a `redrive`-synthesized
  id (a page-local index), never the caller's `entry.id` space, so a page
  mixing `"move"` and `"drop"` decisions always issues two separate
  `deleteBatch` calls rather than risking an id collision between the two
  groups. A delete failure leaves the message in place and is reported via
  `deleteFailed`.
- **`{ action: "retry" }`** — no operation is performed on the message at
  all; it is left exactly as `receive` returned it (still in flight, subject
  to its own visibility timeout).

**Counters are not a partition of `received`.** `moved` counts only sends
that _also_ deleted successfully; a send that succeeded but whose follow-up
delete failed counts in neither `moved` nor `dropped` — it is reported only
via `deleteFailed` (and the resulting duplicate). Likewise a failed drop-delete
counts nowhere but `deleteFailed`. `received === moved + dropped + retried +
deduplicated` therefore holds only on a run with no `moveFailed`/`deleteFailed`
entries at all — callers that need an exact accounting should inspect the
failure arrays, not assume the counters sum.

`processMessage` may be async; it is awaited once per message, in receive
order, before that message's decision is applied. If `processMessage` throws,
`redrive` does not catch it — the throw propagates out of `redrive`
immediately, ending the run; any pages already fully processed before the
throw keep their committed sends/deletes (partial progress is not rolled
back).

**Deduplication (`options.deduplication`, default `"none"`):** when set to
`"messageId"`, `redrive` tracks every non-empty `messageId` it has already
processed within this single `redrive` call (a `Set`, scoped to the call —
not persisted across calls) and skips `processMessage` entirely for a
message whose `messageId` repeats, counting it in
`M3LSQSRedriveResult.deduplicated` instead. This guards against SQS
occasionally redelivering the same message across pages of one long-running
`redrive` call before its visibility timeout has fully elapsed. A message
whose `messageId` defaults to `""` (the SDK omitted it) is never treated as
a duplicate of another empty-id message, since that would be unprovable.

**`options.messageLimit`** caps the total number of messages `redrive`
receives across every page combined; omit it to drain until a `receive` call
returns an empty page. A `messageLimit` of `0` or less (including `NaN`) is a
caller/config error, not a legitimate "do nothing" request — `redrive` throws
`M3LSQSOperationError` before issuing any call, rather than silently
returning an all-zero-count result.

**No new error class.** Every throw from `redrive` is a plain
`M3LSQSOperationError` — either propagated unchanged from `receive`/
`sendBatch`/`deleteBatch`, or constructed by `redrive` itself for a condition
those methods can't detect (an invalid `messageLimit`, or — unreachable under
the typed `M3LSQSRedriveDecision` contract, but possible if a caller bypasses
types — an unrecognized `processMessage` decision). `redrive` performs no raw
SDK call of its own.

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
  `maxMessages` defaults to `10`, `waitTimeSeconds` defaults to `20`
  (mapped with `??`, not `||`, so an explicit `waitTimeSeconds: 0` — a
  short poll — is honored rather than coerced back to the default).
- **`M3LSQSRedriveDecision`** — a discriminated union on `action`:
  `{ action: "move", entry: M3LSQSSendEntry }` (send `entry` to the
  destination, then delete the source message once the send succeeds),
  `{ action: "drop" }` (delete the source message, no send), or
  `{ action: "retry" }` (leave the source message untouched).
- **`M3LSQSRedriveProcessor`** — `(message: M3LSQSReceivedMessage) =>
M3LSQSRedriveDecision | Promise<M3LSQSRedriveDecision>`, the per-message
  callback passed to `redrive`.
- **`M3LSQSReceiveDeduplicationMode`** — `"none" | "messageId"`, passed as
  `M3LSQSRedriveOptions.deduplication`.
- **`M3LSQSRedriveOptions`** — `{ messageLimit?, receiveOptions?,
deduplication? }`. `messageLimit` caps the total messages processed across
  the whole `redrive` call (omit to drain until an empty page);
  `receiveOptions` tunes each page's underlying `receive` call (its own
  `maxMessages` bounds one page, capped at the SQS per-call limit of 10);
  `deduplication` defaults to `"none"`.
- **`M3LSQSRedriveResult`** — `{ received, moved, dropped, retried,
deduplicated, moveFailed, deleteFailed }`. `received` is the total messages
  pulled across every page; `moved`/`dropped`/`retried`/`deduplicated` are
  disjoint per-message outcome counts; `moveFailed` is
  `readonly M3LSQSBatchFailure<M3LSQSSendEntry>[]` (failed `sendBatch`
  entries — messages left in the source queue) and `deleteFailed` is
  `readonly M3LSQSBatchFailure<M3LSQSDeleteEntry>[]` (failed `deleteBatch`
  entries, from either the post-move or the drop path).

### Field-mapping details (`receive`)

- A `Message` missing `MessageId`, `ReceiptHandle`, or `Body` (the SDK types
  all three as optional; a real SQS response always populates them) maps the
  missing field to `""` rather than throwing or skipping the message —
  `receive` stays total over whatever shape the SDK returns.
- An empty response and a response with no `Messages` field at all both
  resolve to `[]` — `receive` treats "no messages" as success, not an error,
  regardless of whether the SDK omitted the field or returned an empty array.
- `messageAttributes` carries **string values only** (per its type). Sending:
  each `[name, value]` entry is wrapped as `{ DataType: "String", StringValue:
value }` for the SDK. Receiving: only entries whose `StringValue` is present
  are extracted; a binary or list-valued attribute is skipped rather than
  coerced to a string (so it never masquerades as an empty string).

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

// Redrive every message from a DLQ back to its source queue.
const redriveResult = await sqsOperations.redrive(
  dlqUrl,
  queueUrl,
  (message) => ({
    action: "move",
    entry: { id: message.messageId, body: message.body },
  }),
);
// redriveResult.moved / .moveFailed / .deleteFailed report the outcome.
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
  (`aws/**` may otherwise import only `core/errors`/`core/prompt`), added for
  this module's internal retry composition. The `eslint.config.js` exception
  is zone-wide (`aws/**`, not `aws/sqs/**` specifically) — any other AWS
  submodule may also import `core/polling` today, but only this module
  actually does; it is not a general loosening of what `aws/**` may depend on
  beyond that one edge.

## See also

- [AWS Clients](./clients.md) — the raw `sqs` client getter and
  `AWSClientProvider`/`AWSProvider` this module builds on; the
  `sqsOperations` convenience getter is `@deprecated` in favor of
  `AWSServiceProvider.sqsOperations` (`script.aws.services.sqsOperations`).
- [ADR-0026](../../adr/0026-sqs-operations-wrapper.md) — why this pattern
  exists and the Zone A amendment.
- [Polling](../core/polling.md) — `M3LRetryRunner` / `M3LPollingPolicies` /
  the classifiers this module composes internally.
