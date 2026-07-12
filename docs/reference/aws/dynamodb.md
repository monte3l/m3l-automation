# AWS DynamoDB

High-level DynamoDB item operations over the `dynamoDBDocument`/`dynamoDB`
clients from [`aws/clients`](./clients.md): plain-JS-object parameters in and
out, AWS SDK v3 commands constructed internally. This is the abstraction
boundary the library commits to — `aws/clients` provisions raw SDK clients;
`aws/dynamodb` is the only place that builds SDK commands against them, so no
consumer (library or script) ever imports `@aws-sdk/lib-dynamodb` or
`@aws-sdk/client-dynamodb` command classes directly.

## Origin

Surfaced as library friction while implementing the `dynamo-crud` W2 consumer
script (`scripts/dynamo-crud`): the script's contract required constructing
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

### Design choices

- **Pages, not items, from `queryItems`/`scanSegment`.** Both yield
  `AsyncGenerator<DynamoDBPage>` — `{ items, lastEvaluatedKey }` — rather than
  individual items, so a caller (e.g. `dynamo-crud`'s checkpoint/resume
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

### `M3LDynamoDBOperationError`

Thrown by every function above when the underlying AWS SDK command rejects
(chained via `cause`), or when a function-level precondition is violated (e.g.
the 25-item batch cap). Callers narrow via `code === "ERR_DYNAMODB_OPERATION"`.

## Open questions / deferred follow-ups

- Whether `queryItems`' equality-only key condition needs a follow-up (e.g. a
  sort-key operator like `begins_with`/`between`) — deferred until a real
  consumer needs more than equality (see `dynamo-crud`'s contract page, which
  also reuses `key` as an equality condition for its first cut).
- Whether `updateItem`'s generated `SET`-only expression needs a `REMOVE` path
  for patch fields explicitly set to `undefined` — decide against a concrete
  test case, not speculatively.

## See also

- [`aws/clients`](./clients.md) — the `dynamoDBDocument`/`dynamoDB` clients this module wraps.
- [`core/errors`](../core/errors.md) — the `M3LError` hierarchy `M3LDynamoDBOperationError` extends.
- `scripts/dynamo-crud` — the first consumer of this module (in review on a separate branch).
