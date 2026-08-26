# AWS DynamoDB

High-level DynamoDB item operations over the `dynamoDBDocument`/`dynamoDB`
clients from [`aws/clients`](./clients.md): plain-JS-object parameters in and
out, AWS SDK v3 commands constructed internally. This is the abstraction
boundary the library commits to — `aws/clients` provisions raw SDK clients;
`aws/dynamodb` is the only place that builds SDK commands against them, so no
consumer (library or script) ever imports `@aws-sdk/lib-dynamodb` or
`@aws-sdk/client-dynamodb` command classes directly.

## Origin

Surfaced as library friction while implementing the `dynamodb-crud` W2 consumer
script (`scripts/dynamodb-crud`): the script's contract required constructing
`GetCommand`/`PutCommand`/`UpdateCommand`/`DeleteCommand`/`QueryCommand`/
`ScanCommand`/`BatchWriteCommand`/`DescribeTableCommand`, which would have
required the script to depend on `@aws-sdk/lib-dynamodb` /
`@aws-sdk/client-dynamodb` directly. Per the project's minimal-runtime-deps /
single-abstraction-layer rule, that dependency belongs in the library instead —
this submodule is the result.

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS`
namespace):

| Export                      | Kind      | Summary                                                                                                                                                                                |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getItem`                   | function  | Fetch one item by key.                                                                                                                                                                 |
| `putItem`                   | function  | Write (create or replace) one item.                                                                                                                                                    |
| `updateItem`                | function  | Merge-patch one item (patch fields → generated `SET` clauses).                                                                                                                         |
| `deleteItem`                | function  | Delete one item by key.                                                                                                                                                                |
| `queryItems`                | function  | Equality-key-condition query, yielding pages.                                                                                                                                          |
| `scanSegment`               | function  | Single-segment table scan, yielding pages.                                                                                                                                             |
| `batchWriteItems`           | function  | Write up to 25 items in one `BatchWriteItem` request.                                                                                                                                  |
| `batchDeleteItems`          | function  | Delete up to 25 items in one `BatchWriteItem` request.                                                                                                                                 |
| `describeTable`             | function  | Approximate item count + status, for a destructive-op confirm gate.                                                                                                                    |
| `DynamoDBKey`               | type      | `Record<string, unknown>` — a primary key.                                                                                                                                             |
| `DynamoDBItem`              | type      | `Record<string, unknown>` — an item.                                                                                                                                                   |
| `DynamoDBPage`              | interface | `{ items, lastEvaluatedKey }` — one page from `queryItems`/`scanSegment`.                                                                                                              |
| `QueryItemsOptions`         | interface | `queryItems` parameters.                                                                                                                                                               |
| `ScanSegmentOptions`        | interface | `{ tableName, parallel?: { segment, totalSegments }, pageSize? }` — `scanSegment` parameters; `parallel` is a single optional pair (both-or-neither), not two independent flat fields. |
| `BatchWriteResult`          | interface | `{ written, unprocessed }`.                                                                                                                                                            |
| `BatchDeleteResult`         | interface | `{ deleted, unprocessed }`.                                                                                                                                                            |
| `TableDescription`          | interface | `{ itemCount, tableStatus }`.                                                                                                                                                          |
| `M3LDynamoDBOperationError` | class     | Typed error (`code: "ERR_DYNAMODB_OPERATION"`) for any SDK rejection.                                                                                                                  |
| `M3LDynamoDBOperations`     | class     | Thin instance-method wrapper over the 9 functions above (see below).                                                                                                                   |

### Design choices

- **Pages, not items, from `queryItems`/`scanSegment`.** Both yield
  `AsyncGenerator<DynamoDBPage>` — `{ items, lastEvaluatedKey }` — rather than
  individual items, so a caller (e.g. `dynamodb-crud`'s checkpoint/resume
  convention) can persist `lastEvaluatedKey` between pages without buffering
  the whole result set.
- **No retry inside `batchWriteItems`/`batchDeleteItems`.** Both return
  `unprocessed` (items or keys DynamoDB rejected) rather than retrying
  internally — retry policy (backoff, max attempts, concurrency) stays the
  caller's concern via `Core.M3LRetryRunner`, consistent with the library not
  hard-coding a retry policy inside a single low-level call.
- **`updateItem` takes a merge patch, not a raw `UpdateExpression`.** Each
  top-level key in `patch` becomes one generated `SET` clause. This covers the
  common "update a few attributes" case without exposing DynamoDB's expression
  grammar; a raw-expression escape hatch can be added later if a consumer
  needs `REMOVE`/list-append/conditional writes.
- **`describeTable` takes the base `dynamoDB` client, not `dynamoDBDocument`.**
  `DescribeTableCommand` is a control-plane call with no item-shape concern.
- **25-item cap enforced by `batchWriteItems`/`batchDeleteItems`.** Chunking a
  larger record set into 25-item batches is the caller's job (mirrors DynamoDB's
  own `BatchWriteItem` limit); passing more than 25 throws
  `M3LDynamoDBOperationError`.
- **`queryItems`/`scanSegment` reject a repeated `LastEvaluatedKey`.** Each page
  loop is guarded against a `LastEvaluatedKey` identical to the immediately
  preceding one — the second such observation rejects with a plain `M3LError`
  (`code === "ERR_NO_PROGRESS"`, see [`core/errors`](../core/errors.md)) instead
  of looping forever, since a repeating cursor can never make progress. This
  catches exactly a same-cursor-twice-in-a-row repeat, not a longer cycle
  (`a → b → a → …`) or a merely-unhelpful-but-changing cursor; it costs one
  extra page request beyond the repeat before it trips, and it does not seed
  its baseline from a caller-supplied resume key, so a resume that immediately
  re-stalls also costs one extra request. `scanSegment`'s parallel segments
  each track independently. Composite keys are compared by a key-order-
  normalized serialization (so two `LastEvaluatedKey`s with the same
  attributes in different insertion order still count as unchanged) and never
  appear in the thrown error's message or context — this is a distinct,
  non-configurable mechanism from `core/polling`'s opt-in `progress` witness
  (see [`core/polling`](../core/polling.md#no-progress-detection)), not that
  option applied internally.

### `M3LDynamoDBOperationError`

Thrown by every function above when the underlying AWS SDK command rejects
(chained via `cause`), or when a function-level precondition is violated (e.g.
the 25-item batch cap). Callers narrow via `code === "ERR_DYNAMODB_OPERATION"`.
The one exception is `queryItems`/`scanSegment`'s repeated-cursor guard above,
which rejects with `code === "ERR_NO_PROGRESS"` instead — a caller narrowing
only on `ERR_DYNAMODB_OPERATION` will not catch it.

### `M3LDynamoDBOperations` — the `.services.dynamoDBOperations` wrapper class

A thin instance-method wrapper over the 9 functions above, added so
`aws/dynamodb` has a class reachable through `AWSServiceProvider`
(`provider.services.dynamoDBOperations`, see [AWS clients](./clients.md)) the
same way every other wrapped service is. Construction takes **two** clients —
a `DynamoDBDocumentClient` and a raw `DynamoDBClient` — because the functions
themselves split the same way: every method except `describeTable` delegates
through the document client; `describeTable` alone routes through the raw
client, matching `describeTable`'s existing `dynamoDB`-not-`dynamoDBDocument`
requirement above. Every method is a one-line delegation to its matching free
function — no reimplemented SDK logic. The free functions above remain the
primary, unchanged public API; the class is an alternate access path for
callers who prefer `provider.services.dynamoDBOperations.getItem(...)` over
`getItem(provider.clients.dynamoDBDocument, ...)`.

```ts
import { AWSProvider, parseAWSProfile } from "@m3l-automation/m3l-common/aws";

const provider = new AWSProvider({ profile: parseAWSProfile("my-profile") });
const order = await provider.services.dynamoDBOperations.getItem("orders", {
  id: "42",
});
```

## Open questions / deferred follow-ups

- Whether `queryItems`' equality-only key condition needs a follow-up (e.g. a
  sort-key operator like `begins_with`/`between`) — deferred until a real
  consumer needs more than equality (see `dynamodb-crud`'s contract page, which
  also reuses `key` as an equality condition for its first cut).
- Whether `updateItem`'s generated `SET`-only expression needs a `REMOVE` path
  for patch fields explicitly set to `undefined` — decide against a concrete
  test case, not speculatively.

## See also

- [`aws/clients`](./clients.md) — the `dynamoDBDocument`/`dynamoDB` clients
  this module wraps. The primary API is still the function set above
  (mirroring `aws/s3`'s ADR-0033 shape); `M3LDynamoDBOperations` is a thin
  `.services.dynamoDBOperations` wrapper over the same functions, added for
  consistency with every other AWS service tier (ADR-0038).
- [`core/errors`](../core/errors.md) — the `M3LError` hierarchy `M3LDynamoDBOperationError` extends.
- `scripts/dynamodb-crud` — the first consumer of this module (in review on a separate branch).
