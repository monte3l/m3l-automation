# RDS Data API

`M3LRDSDataOperations` is a typed wrapper over a raw `RDSDataClient`, so
callers never import `@aws-sdk/client-rds-data` command classes directly.
Covers running statements (single and batched) and transactions against a
**Data-API-enabled Aurora cluster** — the route [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md)
re-admits Aurora PostgreSQL into fleet scope, since the RDS Data API is
itself an AWS SDK v3 client with no persistent database connection or VPC
reachability requirement (unlike the raw `pg` wire-protocol driver, which
ADR-0031 explicitly rejects).

> **Scaffold status:** this page anchors the contract for the
> `implementing-submodules` TDD loop. `spec-conformance-reviewer` should
> treat every shape below as a draft to verify against the real
> `@aws-sdk/client-rds-data` types before `test-author`/`code-implementer`
> proceed — not as settled truth.

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LRDSDataOperations` wraps the
`rdsData` client, translating SDK request/response shapes into plain,
library-owned types so a caller never touches an `@aws-sdk/client-rds-data`
type.

- `M3LRDSDataOperations` — the wrapper class, constructed from a raw
  `RDSDataClient`.
- `M3LRDSDataOperationError` — thrown on a request-level operation failure.
- `M3LRDSDataResultTooLargeError` — thrown when an unpaged
  `executeStatement` result set exceeds the RDS Data API's 1 MiB response
  cap (the API has no `NextToken` on `ExecuteStatement` at all — a caller
  hitting this must page the statement itself, e.g. via `LIMIT`/`OFFSET`).
- Plain types: `M3LRDSDataValue`, `M3LRDSDataRow`, `M3LRDSDataColumn`,
  `M3LRDSDataParameter`, `M3LRDSDataTypeHint`, `M3LRDSDataStatementInput`,
  `M3LRDSDataStatementResult`, `M3LRDSDataBatchInput`,
  `M3LRDSDataBatchResult`, `M3LRDSDataUpdateResult`,
  `M3LRDSDataTransaction`, `M3LRDSDataBeginTransactionInput`.

## Scope

**In scope:** the operations a SQL-oriented consumer script needs —
`ExecuteStatement`, `BatchExecuteStatement`, `BeginTransaction`,
`CommitTransaction`, `RollbackTransaction`, plus a `withTransaction`
convenience wrapper composing the three transaction calls.

**Out of scope for this iteration:**

- **The deprecated `ExecuteSql` operation** (multi-statement, no typed
  parameters) — AWS itself recommends `BatchExecuteStatement`/
  `ExecuteStatement` instead; this module never wraps it.
- **Non-Data-API-enabled RDS/Aurora instances** — the RDS Data API only
  works against Data-API-enabled Aurora Serverless v1/v2 or provisioned
  Aurora clusters with the Data API explicitly enabled; a plain RDS instance
  has no route through this module. ADR-0031 explicitly rejects the raw
  `pg` driver as the fallback for that case.
- **Result-set pagination beyond the 1 MiB single-response cap** — the API
  provides none; `M3LRDSDataResultTooLargeError` surfaces the condition, a
  caller pages via `LIMIT`/`OFFSET` in the SQL itself.
- **`formatRecordsAs: "JSON"`** — pre-serializing the result set as a JSON
  string bypasses the typed `M3LRDSDataValue` mapping this module exists to
  provide, and is not supported for every statement form. Add it when a
  concrete consumer need is named (ADR-0027's per-consumer-need pattern).
- **Array-valued fields** (`arrayValue`) — the typed `M3LRDSDataValue` union
  covers `string`/`long`/`double`/`boolean`/`blob`/`null`; a row containing
  a nested array value is not yet mapped.

## Public API (draft — subject to spec-conformance verification)

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
than seeing only one.

### Types

| Type                        | Shape                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M3LRDSDataValue`           | Discriminated union on `kind`: `"null"`, `"string"` (+`value: string`), `"long"`/`"double"` (+`value: number`), `"boolean"` (+`value: boolean`), `"blob"` (+`value: Uint8Array`). Mirrors the SDK's `Field` union without coercing to a single type, unlike `aws/athena`'s `AthenaRow = Record<string, string>`. |
| `M3LRDSDataColumn`          | `{ name, typeName, label, nullable? }` — mapped from `ColumnMetadata`.                                                                                                                                                                                                                                           |
| `M3LRDSDataRow`             | `readonly M3LRDSDataValue[]`, positional against the paired `M3LRDSDataColumn[]`.                                                                                                                                                                                                                                |
| `M3LRDSDataParameter`       | `{ name, value: M3LRDSDataValue, typeHint? }`.                                                                                                                                                                                                                                                                   |
| `M3LRDSDataTypeHint`        | `"DATE" \| "DECIMAL" \| "JSON" \| "TIME" \| "TIMESTAMP" \| "UUID"`.                                                                                                                                                                                                                                              |
| `M3LRDSDataStatementInput`  | `{ resourceArn, secretArn, sql, database?, schema?, parameters?, transactionId? }`.                                                                                                                                                                                                                              |
| `M3LRDSDataStatementResult` | `{ rows, columns, numberOfRecordsUpdated, generatedFields }`.                                                                                                                                                                                                                                                    |
| `M3LRDSDataBatchInput`      | `{ resourceArn, secretArn, sql, database?, schema?, parameterSets, transactionId? }`.                                                                                                                                                                                                                            |
| `M3LRDSDataBatchResult`     | `{ updateResults: readonly M3LRDSDataUpdateResult[] }`.                                                                                                                                                                                                                                                          |
| `M3LRDSDataTransaction`     | `{ transactionId }`.                                                                                                                                                                                                                                                                                             |

## Usage

```ts
import { M3LRDSDataOperations } from "@m3l-automation/m3l-common/aws";

const rdsData = new M3LRDSDataOperations(script.aws.services.rdsDataOperations);

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

- Every SDK send is retried under AWS throttling via `M3LRetryRunner` +
  `M3LPollingPolicies.awsThrottling()`. There is no poller: unlike
  `aws/athena`, `ExecuteStatement` is synchronous — there is no
  Athena-style async-query-then-await-results shape.
- The RDS Data API resolves `secretArn` server-side; this module never
  itself calls `GetSecretValue`. A consumer script wanting a fail-fast error
  on a typo'd/wrong-account ARN should preflight with
  `aws/secrets-manager`'s `describeSecret` before issuing statements.
- Error messages must never contain a parameter or row value — only
  identifiers (cluster/secret ARN, transaction id).

## See also

- [`aws/clients`](./clients.md) — the `script.aws.clients.rdsData` /
  `script.aws.services.rdsDataOperations` seams this submodule's client is
  injected from.
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
