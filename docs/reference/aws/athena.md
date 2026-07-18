# AWS Athena

`M3LAthenaClient` is a typed wrapper over Amazon Athena query execution (`StartQueryExecution`/`GetQueryExecution`/`GetQueryResults`), so consumer scripts never need to import `@aws-sdk/client-athena` directly ([ADR-0029](../../adr/0029-script-dependency-boundary.md)).

**Status: scaffolded, not yet implemented.** Every `M3LAthenaClient` method
currently throws unconditionally (see `src/aws/athena/client.ts`). This page
is the contract `implementing-submodules` implements against.

## Overview

The submodule wraps an **injected**, already-provisioned `AthenaClient` — obtain one from `script.aws.athena` (the library's credential/client-construction seam) and inject it here. `M3LAthenaClient` never constructs its own client from a profile/region; that stays behind the `aws.profile` seam.

It composes with `core/polling`: query completion is polled via `M3LPoller` built from `M3LPollingPolicies.athenaQuery()`, and the initial `StartQueryExecution` call (plus every `GetQueryExecution`/`GetQueryResults` call) is retried under AWS throttling via `M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()` — matching the `M3LLogsInsightsClient` precedent.

This submodule is the ADR-0029 W4 prerequisite for the `athena-query` consumer script, which is Athena-only in scope (the `pg`/`mongodb` engines were dropped; see [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md)).

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace):

- `M3LAthenaClient` — the query wrapper class.
- `AthenaAwaitOptions` — optional-override type for `awaitResults`/`runQuery`.
- `StartAthenaQueryInput` — `startQuery`/`runQuery` input shape.
- `AthenaQueryResult` — the successful result shape.
- `AthenaQueryStatistics`, `AthenaQueryStatus`, `AthenaRow`, `AthenaColumnInfo` — supporting types.
- `M3LAthenaStartQueryError` (`code: "ERR_ATHENA_START_QUERY"`) — thrown when `StartQueryExecution` returns no `QueryExecutionId`.
- `M3LAthenaQueryFailedError` (`code: "ERR_ATHENA_QUERY_FAILED"`) — thrown when a query reaches a terminal non-`SUCCEEDED` status.

### `M3LAthenaClient`

**Constructor** — `new M3LAthenaClient(client: AthenaClient)`.

**Methods:**

| Method         | Signature                                                                                | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startQuery`   | `(input: StartAthenaQueryInput) => Promise<string>`                                      | Wraps `StartQueryExecutionCommand`, retried under AWS throttling via `awsThrottling()`. Returns the bare `QueryExecutionId`. Throws `M3LAthenaStartQueryError` when the response carries no `QueryExecutionId`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `awaitResults` | `(queryExecutionId: string, options?: AthenaAwaitOptions) => Promise<AthenaQueryResult>` | Standalone-usable (the resume/re-attach primitive — no fresh `StartQueryExecution` is issued). Polls `GetQueryExecutionCommand` via `M3LPoller` built from `athenaQuery()` by default (override via `options.pollerOptions`). `SUCCEEDED` → fetches every `GetQueryResults` page and resolves with normalized rows + column schema + statistics; `QUEUED`/`RUNNING` → continues polling; `FAILED`/`CANCELLED` → throws `M3LAthenaQueryFailedError`. Poll-attempt exhaustion propagates the plain `M3LError` with `code === "ERR_POLL_EXHAUSTED"` unchanged (that error class itself is not part of the public barrel — narrow by `code`, not `instanceof`). |
| `runQuery`     | `(input, options?) => Promise<AthenaQueryResult>`                                        | Convenience `startQuery` + `awaitResults` for the common non-resumable case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**`StartAthenaQueryInput`** — field names mirror the AWS `StartQueryExecution` request shape closely:

| Field                 | Type                | Required | Notes                                                                                        |
| --------------------- | ------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `queryString`         | `string`            | yes      | Passed verbatim as `QueryString`.                                                            |
| `database`            | `string`            | no       | `QueryExecutionContext.Database`.                                                            |
| `catalog`             | `string`            | no       | `QueryExecutionContext.Catalog`.                                                             |
| `outputLocation`      | `string`            | no       | `ResultConfiguration.OutputLocation` (S3 URI). Required by AWS unless the workgroup has one. |
| `workGroup`           | `string`            | no       | `WorkGroup`.                                                                                 |
| `executionParameters` | `readonly string[]` | no       | `ExecutionParameters`, for a parameterized query.                                            |

**`AthenaQueryResult`:**

| Field              | Type                                 | Notes                                                                                                                                                   |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queryExecutionId` | `string`                             | The AWS-side query execution identifier this result was polled from.                                                                                    |
| `status`           | `"SUCCEEDED"`                        | Only a `SUCCEEDED` status reaches the success path.                                                                                                     |
| `columns`          | `readonly AthenaColumnInfo[]`        | Column schema (name + Athena/Presto type), in column order, from `ResultSetMetadata.ColumnInfo`.                                                        |
| `rows`             | `readonly AthenaRow[]`               | Normalized rows across every `GetQueryResults` page — see the header-row contract below.                                                                |
| `statistics`       | `AthenaQueryStatistics \| undefined` | `dataScannedInBytes`/`totalExecutionTimeInMillis`/`engineExecutionTimeInMillis`, when AWS returns them (`GetQueryExecution.QueryExecution.Statistics`). |

### Row normalization contract (Athena-specific pagination hazard)

AWS's `GetQueryResults` API includes the **column header as the first row of
the first page only**, for `SELECT`/DML queries (not for `DDL`/`UTILITY`
statement types, which return no rows). The implementation **must**:

1. Fetch `ResultSetMetadata.ColumnInfo` once (present on every page, but only
   needs reading from the first response) and use `ColumnInfo[].Name` as the
   canonical column-name source for keying every row — **not** the header
   row's cell text. This avoids a fragile "is this the header row" heuristic
   drifting out of sync across pages.
2. Skip exactly the first `Row` of the **first** `GetQueryResults` page
   (`NextToken` absent on the request) — subsequent pages (`NextToken`
   present) start directly with data rows and must not have their first row
   dropped.
3. Collapse each subsequent `Row.Data[]` (`Datum[]`, each with an optional
   `VarCharValue`) into a plain `AthenaRow` keyed by the matching
   `ColumnInfo[].Name`, positionally — a missing `VarCharValue` (Athena's
   representation of SQL `NULL`) normalizes to `""`, mirroring
   `M3LLogsInsightsClient`'s `normalizeRow` treatment of an absent `value`.
4. Loop `GetQueryResultsCommand` while the response carries a `NextToken`,
   accumulating rows across every page into the single `AthenaQueryResult`
   returned by `awaitResults`.

## Error handling

| Error                       | Code                      | Thrown by      | Context                                                                                               |
| --------------------------- | ------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `M3LAthenaStartQueryError`  | `ERR_ATHENA_START_QUERY`  | `startQuery`   | `{ queryString }`                                                                                     |
| `M3LAthenaQueryFailedError` | `ERR_ATHENA_QUERY_FAILED` | `awaitResults` | `{ queryExecutionId, status }` — carries `queryExecutionId` so a caller can log/checkpoint against it |

`M3LAthenaStartQueryError` is also thrown when the `StartQueryExecution` SDK call itself fails — after any throttling retries (via `M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()`) are exhausted or the failure is classified fatal — chaining the underlying SDK/network error via `cause`. This is in addition to its existing no-`QueryExecutionId`-in-response case, which carries no `cause` (a successful response with a bad shape has no exception to chain).

`M3LAthenaQueryFailedError` is likewise thrown when a `GetQueryExecution` or `GetQueryResults` SDK call itself fails after retries are exhausted: both are retried under AWS throttling (`M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()`). A genuine send failure is reported with `status: "UNKNOWN"` and the original error chained via `cause`. This is in addition to its existing terminal-AWS-status case (`FAILED`/`CANCELLED`), which still carries no `cause` — a successful response carrying a terminal status has no exception to chain.

Poll-attempt exhaustion (the attempt bound reached while the query is still `QUEUED`/`RUNNING`) is **not** wrapped: the `M3LPoller`-thrown plain `M3LError` with `code === "ERR_POLL_EXHAUSTED"` propagates unchanged. Callers narrow by `code`, never by `instanceof` on a poller-internal class (that class is intentionally not exported from the public barrel).

## See also

- [`aws/clients`](./clients.md) — the `script.aws.athena` seam this submodule's client is injected from.
- [`aws/cloudwatch-logs-insights`](./cloudwatch-logs-insights.md) — the async start/await decomposition and row-normalization precedent this submodule mirrors.
- [`core/polling`](../core/polling.md) — `M3LPoller`, `M3LRetryRunner`, `M3LPollingPolicies.athenaQuery()`/`.awsThrottling()`.
- [ADR-0029](../../adr/0029-script-dependency-boundary.md) — the script-dependency-boundary decision this submodule unblocks (`athena-query`, W4).
- [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md) — scopes `athena-query` to Athena-only.
