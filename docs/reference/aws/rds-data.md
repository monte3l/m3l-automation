# RDS Data API

`M3LRDSDataOperations` is a typed wrapper over a raw `RDSDataClient`, so
callers never import `@aws-sdk/client-rds-data` command classes directly.
Covers running statements (single and batched) and transactions against a
**Data-API-enabled Aurora cluster** — the route [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md)
re-admits Aurora PostgreSQL into fleet scope, since the RDS Data API is
itself an AWS SDK v3 client with no persistent database connection or VPC
reachability requirement (unlike the raw `pg` wire-protocol driver, which
ADR-0031 explicitly rejects).

> **Status:** this page's `## Public API` section is the verified contract
> `test-author`/`code-implementer` build against — checked against the
> installed `@aws-sdk/client-rds-data@3.1105.0` `dist-types` by
> `spec-conformance-reviewer` (2026-08-14 contract pass). It supersedes the
> earlier draft.

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LRDSDataOperations` wraps the
`rdsData` client, translating SDK request/response shapes into plain,
library-owned types so a caller never touches an `@aws-sdk/client-rds-data`
type.

- `M3LRDSDataOperations` — the wrapper class, constructed from a raw
  `RDSDataClient`.
- `M3LRDSDataOperationError` — thrown on a request-level operation failure.
- `M3LRDSDataResultTooLargeError` — thrown by `executeStatement` only, when
  the SDK rejects with `UnsupportedResultException`. AWS overloads this
  exception for three conditions — an oversized result (the API has no
  `NextToken` on `ExecuteStatement` at all, so a caller must page via
  `LIMIT`/`OFFSET` in the SQL itself), an unsupported data type, or a
  multidimensional array — and gives no way to distinguish them; the error
  message must name all three possibilities, not claim "too large"
  exclusively.
- Plain types: `M3LRDSDataValue`, `M3LRDSDataRow`, `M3LRDSDataColumn`,
  `M3LRDSDataParameter`, `M3LRDSDataTypeHint`, `M3LRDSDataStatementInput`,
  `M3LRDSDataStatementResult`, `M3LRDSDataBatchInput`,
  `M3LRDSDataBatchResult`, `M3LRDSDataUpdateResult`,
  `M3LRDSDataTransaction`, `M3LRDSDataBeginTransactionInput` (lives in
  `types.ts` alongside its siblings, not `client.ts`).

## Scope

**In scope:** the operations a SQL-oriented consumer script needs —
`ExecuteStatement`, `BatchExecuteStatement`, `BeginTransaction`,
`CommitTransaction`, `RollbackTransaction`, plus a `withTransaction`
convenience wrapper composing the three transaction calls. Also in scope:
the `AWSClientProvider.rdsData` raw-client getter and the
`AWSServiceProvider.services.rdsDataOperations` memoized wrapper getter
(`aws/clients/provider.ts` / `aws/clients/service-provider.ts`) — this
module is unreachable from a script without them.

**Out of scope for this iteration:**

- **The deprecated `ExecuteSql` operation** (multi-statement, its own
  `Value`/`_Record`/`ResultFrame`/`StructValue`/`SqlStatementResult` types) —
  AWS itself recommends `BatchExecuteStatement`/`ExecuteStatement` instead;
  this module never wraps it, and never uses `_Record[]` in place of
  `Field[][]`.
- **Non-Data-API-enabled RDS/Aurora instances** — the RDS Data API only
  works against Data-API-enabled Aurora Serverless v1/v2 or provisioned
  Aurora clusters with the Data API explicitly enabled; a plain RDS instance
  has no route through this module. ADR-0031 explicitly rejects the raw
  `pg` driver as the fallback for that case.
- **Result-set pagination beyond the 1 MiB single-response cap** — the API
  provides none (verified: no `NextToken`/pagination field anywhere in the
  SDK's `dist-types`); `M3LRDSDataResultTooLargeError` surfaces the
  condition, a caller pages via `LIMIT`/`OFFSET` in the SQL itself.
- **`formatRecordsAs: "JSON"`** and **`resultSetOptions`**
  (`decimalReturnType`/`longReturnType`) — pre-serializing the result set as
  a JSON string bypasses the typed `M3LRDSDataValue` mapping this module
  exists to provide; `resultSetOptions` changes the returned value's kind
  entirely (`longReturnType: "STRING"` is the only way to avoid the
  `number`-typed `kind: "long"` arm's `Number.MAX_SAFE_INTEGER` precision
  loss for a PostgreSQL `bigint`). Neither is modeled — add when a concrete
  consumer need is named (ADR-0027's per-consumer-need pattern).
- **`continueAfterTimeout`** — AWS recommends `true` for DDL so a
  long-running statement isn't left in an ambiguous state by a client-side
  timeout, but this module does not set or expose it.
- **`schema`** is accepted as a pass-through field on every input type, but
  AWS currently does not support it ("the `schema` parameter isn't
  supported", per the SDK's own request docs) — the wrapper forwards it
  unconditionally; do not add validation that assumes it takes effect.
- **`DATABASE.SCHEMA`-qualified `resultSetOptions`, `transactionStatus`
  strings** (`CommitTransactionResponse`/`RollbackTransactionResponse`'s
  `transactionStatus?: string`) — discarded on purpose; `commitTransaction`/
  `rollbackTransaction` resolve `void`, not the status string.

## Public API

### `class M3LRDSDataOperations`

```ts
class M3LRDSDataOperations {
  constructor(client: RDSDataClient);

  executeStatement(
    input: M3LRDSDataStatementInput,
  ): Promise<M3LRDSDataStatementResult>;

  batchExecuteStatement(
    input: M3LRDSDataBatchInput,
  ): Promise<M3LRDSDataBatchResult>;

  beginTransaction(
    input: M3LRDSDataBeginTransactionInput,
  ): Promise<M3LRDSDataTransaction>;

  commitTransaction(
    resourceArn: string,
    secretArn: string,
    transaction: M3LRDSDataTransaction,
  ): Promise<void>;

  rollbackTransaction(
    resourceArn: string,
    secretArn: string,
    transaction: M3LRDSDataTransaction,
  ): Promise<void>;

  withTransaction<T>(
    input: M3LRDSDataBeginTransactionInput,
    fn: (transactionId: string) => Promise<T>,
  ): Promise<T>;
}
```

`withTransaction` begins a transaction, runs `fn` with the started
transaction's id, commits on success, and rolls back on any throw from
`fn`. **A rollback failure must never be swallowed** — it is chained as the
`cause` of the error `fn`'s own throw surfaces as, so a caller always learns
both that the operation failed _and_ that the rollback also failed, rather
than seeing only one. When the rollback succeeds, `fn`'s original error
propagates unchanged.

### SDK request/response mapping (authoritative)

All SDK field names are **lowerCamelCase** (unlike Athena/S3's PascalCase
casing) — do not PascalCase them when constructing a command's input.

| Method                  | Request fields sent                                                                                                                                                                                                                                                                               | Response fields read                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executeStatement`      | `resourceArn`, `secretArn`, `sql` (required); conditional-spread `database`, `schema`, `parameters` (→ `SqlParameter[]`), `transactionId`; **always** `includeResultMetadata: true` (without it, `columnMetadata` is never returned by AWS and `columns` would silently stay `[]` on every call). | `records?: Field[][]` → `rows` (absent → `[]`); `columnMetadata?: ColumnMetadata[]` → `columns` (absent → `[]`); `numberOfRecordsUpdated?: number` (absent → `0`); `generatedFields?: Field[]` (absent → `[]`). `formattedRecords` is ignored (out of scope — see above). |
| `batchExecuteStatement` | `resourceArn`, `secretArn`, `sql`; conditional `database`, `schema`, `transactionId`; `parameterSets: SqlParameter[][]`.                                                                                                                                                                          | `updateResults?: UpdateResult[]` (absent → `[]`); each entry's `generatedFields?: Field[]` (absent → `[]`).                                                                                                                                                               |
| `beginTransaction`      | `resourceArn`, `secretArn`; conditional `database`, `schema`.                                                                                                                                                                                                                                     | `transactionId?: string` — **absent throws `M3LRDSDataOperationError`** naming `resourceArn` (never a parameter/row value), mirroring `aws/athena/client.ts`'s "response carried no QueryExecutionId" guard.                                                              |
| `commitTransaction`     | `resourceArn`, `secretArn`, `transactionId` (all required).                                                                                                                                                                                                                                       | `transactionStatus?: string` discarded; resolves `void`.                                                                                                                                                                                                                  |
| `rollbackTransaction`   | `resourceArn`, `secretArn`, `transactionId` (all required).                                                                                                                                                                                                                                       | `transactionStatus?: string` discarded; resolves `void`.                                                                                                                                                                                                                  |

### `Field` → `M3LRDSDataValue` mapping

The SDK's `Field` union has **eight** members:
`isNull` / `booleanValue` / `longValue` / `doubleValue` / `stringValue` /
`blobValue` / `arrayValue` / `$unknown` (a forward-compatibility catch-all).
`{ isNull: true }` maps to `{ kind: "null" }`; `{ isNull: false }` is a
representable wire value and must be handled the same as a missing `isNull`
key (i.e. fall through to the other members). `arrayValue` and `$unknown`
are **both** unmapped — mapping either to `{ kind: "null" }` would silently
corrupt data for a script writing results out, so both cases **throw**
`M3LRDSDataOperationError` naming the row/column index and the encountered
member's kind (never the value itself).

### `ColumnMetadata` → `M3LRDSDataColumn` mapping

`ColumnMetadata.nullable` is the SDK's JDBC-style `number | undefined`
(`0` = not nullable, `1` = nullable, `2` = nullable-unknown), not a
`boolean`. Map `1 → true`, `0 → false`; for `2`, any other value, or an
absent field, **omit the `nullable` key entirely** (never `undefined`,
per `exactOptionalPropertyTypes`) rather than guessing.

### Types

| Type                              | Shape                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3LRDSDataValue`                 | Discriminated union on `kind`: `"null"`, `"string"` (+`value: string`), `"long"`/`"double"` (+`value: number`, `long` is lossy above `Number.MAX_SAFE_INTEGER` — see Scope), `"boolean"` (+`value: boolean`), `"blob"` (+`value: Uint8Array`). Mirrors the SDK's `Field` union without coercing to a single type, unlike `aws/athena`'s `AthenaRow = Record<string, string>`. |
| `M3LRDSDataColumn`                | `{ name, typeName, label, nullable? }` — `name`/`typeName`/`label` default to `""` when the SDK omits them; `nullable` per the mapping above.                                                                                                                                                                                                                                 |
| `M3LRDSDataRow`                   | `readonly M3LRDSDataValue[]`, positional against the paired `M3LRDSDataColumn[]`.                                                                                                                                                                                                                                                                                             |
| `M3LRDSDataParameter`             | `{ name, value: M3LRDSDataValue, typeHint? }`.                                                                                                                                                                                                                                                                                                                                |
| `M3LRDSDataTypeHint`              | `"DATE" \| "DECIMAL" \| "JSON" \| "TIME" \| "TIMESTAMP" \| "UUID"`.                                                                                                                                                                                                                                                                                                           |
| `M3LRDSDataStatementInput`        | `{ resourceArn, secretArn, sql, database?, schema?, parameters?, transactionId? }`.                                                                                                                                                                                                                                                                                           |
| `M3LRDSDataStatementResult`       | `{ rows, columns, numberOfRecordsUpdated, generatedFields }`.                                                                                                                                                                                                                                                                                                                 |
| `M3LRDSDataBatchInput`            | `{ resourceArn, secretArn, sql, database?, schema?, parameterSets, transactionId? }`.                                                                                                                                                                                                                                                                                         |
| `M3LRDSDataUpdateResult`          | `{ generatedFields: readonly M3LRDSDataValue[] }`.                                                                                                                                                                                                                                                                                                                            |
| `M3LRDSDataBatchResult`           | `{ updateResults: readonly M3LRDSDataUpdateResult[] }`.                                                                                                                                                                                                                                                                                                                       |
| `M3LRDSDataTransaction`           | `{ transactionId }`.                                                                                                                                                                                                                                                                                                                                                          |
| `M3LRDSDataBeginTransactionInput` | `{ resourceArn, secretArn, database?, schema? }`.                                                                                                                                                                                                                                                                                                                             |

### Errors

| Error                           | Code                            | Thrown by               | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3LRDSDataOperationError`      | `ERR_RDS_DATA_OPERATION`        | every method            | any SDK rejection other than the `UnsupportedResultException` case below; a `beginTransaction` response with no `transactionId`; an unmapped `Field` member (`arrayValue`/`$unknown`). Chains the raw SDK rejection as `cause`; for `withTransaction`'s rollback-failure path, the surfaced error is `fn`'s own thrown error with the rollback's own failure chained onto _its_ `cause` — both are recoverable by walking the cause chain, never just one. |
| `M3LRDSDataResultTooLargeError` | `ERR_RDS_DATA_RESULT_TOO_LARGE` | `executeStatement` only | the SDK rejects with an `Error`-shaped value whose `name === "UnsupportedResultException"`. A non-`Error` rejection carrying that same `name` (e.g. a plain object thrown by a non-conforming caller/mock) is not recognized and falls through to `M3LRDSDataOperationError` instead.                                                                                                                                                                      |

## Usage

```ts
import { M3LRDSDataOperations } from "@m3l-automation/m3l-common/aws";

const rdsData = new M3LRDSDataOperations(script.aws.clients.rdsData);
// or, equivalently, skip constructing it yourself: script.aws.services.rdsDataOperations
// already returns a memoized M3LRDSDataOperations.

const result = await rdsData.executeStatement({
  resourceArn: clusterArn,
  secretArn,
  sql: "SELECT id, name FROM users WHERE active = :active",
  parameters: [{ name: "active", value: { kind: "boolean", value: true } }],
});

await rdsData.withTransaction(
  { resourceArn: clusterArn, secretArn },
  async (transactionId) => {
    await rdsData.executeStatement({
      resourceArn: clusterArn,
      secretArn,
      sql: "INSERT INTO users (name) VALUES (:name)",
      parameters: [{ name: "name", value: { kind: "string", value: "Ada" } }],
      transactionId,
    });
  },
);
```

## Notes and behavior

- Every SDK send is retried under a classifier combining AWS throttling and
  transient 5xx (`M3LPollingPolicies.awsThrottling()`) with
  `DatabaseResumingException` (`combineClassifiers`, scoped locally to this
  module — never edited into the shared `awsThrottlingClassifier` other
  wrappers use). `DatabaseResumingException` is the Aurora-Serverless-v1
  paused-cluster case; AWS's own guidance is "the Data API request
  automatically resumes the DB instance, wait a few seconds and try again",
  making it the one RDS-Data-specific retryable condition beyond generic
  throttling/5xx. There is no poller: unlike `aws/athena`, `ExecuteStatement`
  is synchronous — there is no Athena-style async-query-then-await-results
  shape.
- The `try`/`catch` around each SDK send is narrow — response mapping and
  result construction happen after the `catch` resolves, so a local mapping
  bug is never mislabeled as an upstream failure (`aws/lambda/client.ts` is
  the reference shape).
- The RDS Data API resolves `secretArn` server-side; this module never
  itself calls `GetSecretValue`. A consumer script wanting a fail-fast error
  on a typo'd/wrong-account ARN should preflight with
  `aws/secrets-manager`'s `describeSecret` before issuing statements.
- **This module's own `.message` text must never contain a parameter or row
  value** — only identifiers (cluster/secret ARN, transaction id, or a
  row/column index). This guarantee is scoped to the message channel only:
  every method chains the raw SDK rejection as `cause`, and a real
  Data-API/PostgreSQL error can itself echo a parameter's value verbatim
  server-side (e.g. a unique-constraint-violation message naming the
  duplicate key's value). Callers must not log or persist an
  `M3LRDSDataOperationError`'s full `cause` chain assuming it is
  value-free — only the error's own `message` carries that guarantee.

## See also

- [`aws/clients`](./clients.md) — the `script.aws.clients.rdsData` raw
  getter and `script.aws.services.rdsDataOperations` memoized wrapper getter
  this submodule's client is injected from.
- [`aws/athena`](./athena.md) — the nearest structural precedent (async
  query wrapper over an AWS SDK client); `aws/rds-data` diverges by staying
  synchronous and preserving a typed value union rather than coercing to
  strings.
- [`aws/secrets-manager`](./secrets-manager.md) — the optional preflight
  check for `secretArn` validity.
- [ADR-0026](../../adr/0026-sqs-operations-wrapper.md) / [ADR-0027](../../adr/0027-aws-sdk-boundary-typed-wrappers.md) —
  the typed-wrapper submodule pattern this module follows, and the
  per-consumer-need gate that opened it.
- [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md) —
  the decision admitting Aurora PostgreSQL into fleet scope via the RDS
  Data API.
