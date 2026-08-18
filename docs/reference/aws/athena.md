# AWS Athena

`M3LAthenaClient` is a typed wrapper over Amazon Athena query execution (`StartQueryExecution`/`GetQueryExecution`/`GetQueryResults`), so consumer scripts never need to import `@aws-sdk/client-athena` directly ([ADR-0029](../../adr/0029-script-dependency-boundary.md)).

## Overview

The submodule wraps an **injected**, already-provisioned `AthenaClient` — obtain one from `script.aws.clients.athena` (the library's credential/client-construction seam) and inject it here. `M3LAthenaClient` never constructs its own client from a profile/region; that stays behind the `aws.profile` seam.

It composes with `core/polling`: query completion is polled via `M3LPoller` built from `M3LPollingPolicies.athenaQuery()`, and the initial `StartQueryExecution` call (plus every `GetQueryExecution`/`GetQueryResults` call) is retried under AWS throttling via `M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()` — matching the `M3LLogsInsightsClient` precedent.

This submodule is the ADR-0029 W4 prerequisite for the `athena-query` consumer script, which is Athena-only in scope (the `pg`/`mongodb` engines were dropped by [ADR-0029](../../adr/0029-script-dependency-boundary.md), not ADR-0031 — [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md) separately re-admits Aurora PostgreSQL via [`aws/rds-data`](./rds-data.md) and rejects DocumentDB, issue #205).

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace):

- `M3LAthenaClient` — the query wrapper class.
- `AthenaAwaitOptions` — optional-override type for `awaitResults`/`runQuery`, carrying `pollerOptions` and an
  optional `signal` (see Cooperative cancellation).
- `StartAthenaQueryInput` — `startQuery`/`runQuery` input shape.
- `AthenaQueryResult` — the successful result shape.
- `AthenaQueryStatistics`, `AthenaQueryStatus`, `AthenaRow`, `AthenaColumnInfo` — supporting types.
- `M3LAthenaStartQueryError` (`code: "ERR_ATHENA_START_QUERY"`) — thrown when `StartQueryExecution` returns no `QueryExecutionId`.
- `M3LAthenaQueryFailedError` (`code: "ERR_ATHENA_QUERY_FAILED"`) — thrown when a query reaches a terminal non-`SUCCEEDED` status.
- `compileAthenaQueryTemplate` — compiles a SQL string with named `:placeholder`s into a `queryString`/`executionParameters` pair for `StartAthenaQueryInput`.
- `M3LAthenaCompiledQuery` — the `compileAthenaQueryTemplate` result shape.
- `M3LAthenaTemplateError` (`code: "ERR_ATHENA_TEMPLATE_COMPILE"`) — thrown when a template/parameters pair doesn't match 1:1, or the template contains a literal `?`. Exposes `missingParameters`/`unusedParameters` as typed `readonly string[]` fields (in addition to `context`), each empty for the literal-`?` case.

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

## Named-placeholder query templating

Athena/Trino's `ExecutionParameters` are **positional** (`?` markers, values
supplied in order) — awkward for a query with several parameters, since
reordering a `?` in the SQL text silently misaligns the values array.
`compileAthenaQueryTemplate(template, parameters)` compiles a template
written with named `:identifier` placeholders into that positional shape:

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const compiled = AWS.compileAthenaQueryTemplate(
  "SELECT * FROM logs WHERE region = :region AND day = :day AND day = :day",
  { region: "us-east-1", day: "2026-08-11" },
);
// compiled.queryString ===
//   "SELECT * FROM logs WHERE region = ? AND day = ? AND day = ?"
// compiled.executionParameters === ["us-east-1", "2026-08-11", "2026-08-11"]

const result = await athenaClient.runQuery({
  queryString: compiled.queryString,
  executionParameters: compiled.executionParameters,
  database: "my_database",
});
```

**`M3LAthenaCompiledQuery`** — `{ queryString: string, executionParameters:
readonly string[] }`.

**Trust boundary:** `template` is trusted, developer-authored SQL — the same
trust level as any hand-written query string passed to `startQuery`/
`runQuery` directly. Only `parameters`' **values** are the untrusted-input
seam this compiler protects: a value never appears anywhere in `queryString`,
only in the positional `executionParameters` array, so an attacker-controlled
value cannot alter the query's structure regardless of its content (quotes,
placeholders, SQL keywords). Do not construct `template` itself from
untrusted input — the compiler gives that string no protection at all.

**Placeholder syntax and scanning rules:**

- A placeholder is `:` immediately followed by an identifier matching
  `[A-Za-z_][A-Za-z0-9_]*` (e.g. `:region`, `:day_2`).
- A placeholder appearing **inside a single-quoted SQL string literal** is
  left untouched — not replaced, not counted — so a literal value like
  `'12:30:00'` is never mistaken for a parameter. Literal-string scanning
  understands the standard SQL `''` escaped-quote convention.
- `::` (the Presto/Trino cast operator, e.g. `x::date`) is never treated as
  a placeholder start, inside or outside a string literal.
- A placeholder repeated multiple times in the template (as in the example
  above) compiles to one `?`/parameter-value pair **per occurrence**, in
  source order — this is a direct, unavoidable consequence of
  `ExecutionParameters` being positional, not a template-compiler choice.
- **A literal `?` scanned outside single-quote state is rejected.** A `?` the
  scanner sees while it is not inside a single-quoted region throws
  `M3LAthenaTemplateError` immediately, with `missingParameters`/
  `unusedParameters` both empty (the message text names the actual problem in
  this case — a bare `?`, not a name mismatch) — this closes the common case
  of a stray `?` silently misaligning every positional value after it (Athena
  has no way to tell a pre-existing `?` apart from a compiler-generated one).
  This is a scanner-state guard, not a full SQL-structural guarantee: per the
  "out of scope" bullet below, the scanner's only state is "inside vs. outside
  a single-quoted region," so a `?` inside a comment or a double-quoted
  identifier is _also_ rejected (comments/double-quotes get no protection,
  consistent with their own out-of-scope status) — and, conversely, an
  apostrophe inside a comment or double-quoted identifier can flip the scanner
  into single-quote state early, making a genuinely-outside `?` after it look
  "inside a literal" and pass through unrejected. Do not treat this guard as
  a proof that `queryString` is free of stray `?`s in every input; it closes
  the straightforward case, not an adversarially-crafted one.
- **Out of scope:** SQL comments (`--`/`/* */`) are not specially
  recognized — a `:name`-shaped token (or a literal `?`) inside a comment is
  still scanned and treated as real. Double-quoted identifiers are not given
  the same string-literal protection as single-quoted literals — including an
  apostrophe inside one, which is still read as a literal-string delimiter by
  the scanner's single state machine. This is a lightweight template
  compiler, not a SQL tokenizer.

**Validation (fail loud, no partial compile):** every `:name` referenced in
`template` must have a matching key in `parameters`, and every key in
`parameters` must be referenced at least once in `template` — both
directions are checked. A mismatch in either direction throws
`M3LAthenaTemplateError` before returning anything; it never returns a
partially-compiled result.

## Error handling

| Error                       | Code                          | Thrown by                    | Context                                                                                               |
| --------------------------- | ----------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `M3LAthenaStartQueryError`  | `ERR_ATHENA_START_QUERY`      | `startQuery`                 | `{ queryString }`                                                                                     |
| `M3LAthenaQueryFailedError` | `ERR_ATHENA_QUERY_FAILED`     | `awaitResults`               | `{ queryExecutionId, status }` — carries `queryExecutionId` so a caller can log/checkpoint against it |
| `M3LAthenaTemplateError`    | `ERR_ATHENA_TEMPLATE_COMPILE` | `compileAthenaQueryTemplate` | `{ missingParameters, unusedParameters }` — both `readonly string[]`, either may be empty             |

`M3LAthenaStartQueryError` is also thrown when the `StartQueryExecution` SDK call itself fails — after any throttling retries (via `M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()`) are exhausted or the failure is classified fatal — chaining the underlying SDK/network error via `cause`. This is in addition to its existing no-`QueryExecutionId`-in-response case, which carries no `cause` (a successful response with a bad shape has no exception to chain).

`M3LAthenaQueryFailedError` is likewise thrown when a `GetQueryExecution` or `GetQueryResults` SDK call itself fails after retries are exhausted: both are retried under AWS throttling (`M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()`). A genuine send failure is reported with `status: "UNKNOWN"` and the original error chained via `cause`. This is in addition to its existing terminal-AWS-status case (`FAILED`/`CANCELLED`), which still carries no `cause` — a successful response carrying a terminal status has no exception to chain.

Poll-attempt exhaustion (the attempt bound reached while the query is still `QUEUED`/`RUNNING`) is **not** wrapped: the `M3LPoller`-thrown plain `M3LError` with `code === "ERR_POLL_EXHAUSTED"` propagates unchanged. Callers narrow by `code`, never by `instanceof` on a poller-internal class (that class is intentionally not exported from the public barrel).

### Cooperative cancellation

`AthenaAwaitOptions` accepts an optional `signal?: AbortSignal`, threaded into **three** places, so no
layer of the wait can outlive the abort:

1. the `M3LPoller` that drives `awaitResults` (and therefore `runQuery`), so a
   pending backoff is abandoned rather than slept out;
2. the inner `M3LRetryRunner` that wraps each `GetQueryExecution`/`GetQueryResults` call for
   throttling retries (built from `M3LPollingPolicies.athenaQuery()`) — without this, an
   abort landing mid-throttle-backoff would sleep out the remaining delay (up to
   the 5s cap) before being honoured;
3. the **per-command** `abortSignal` on each `GetQueryExecution`/`GetQueryResults` `send()`, so the
   in-flight HTTP request is cancelled rather than merely ignored.

An `AbortError` surfacing from an aborted `send()` is re-classified as
`M3LOperationAbortedError` **before** the query-failed wrapper runs, so a
cancellation is never reported as a failed query.

When both `signal` and `pollerOptions` are supplied, the dedicated `signal` wins.
`pollerOptions` is typed `Omit<M3LPollerOptions, "signal">` so the ambiguous
case cannot be written as an object literal at all; the runtime precedence remains
as a guard for a caller passing a pre-typed variable. When the
signal aborts, the poll rejects with
[`M3LOperationAbortedError`](../core/errors.md#m3loperationabortederror)
(`ERR_OPERATION_ABORTED`, `origin: "caller"`, `retryable: false`) and abandons
any pending backoff delay rather than sleeping it out. Omitting the signal leaves
behavior exactly as before.

Cancelling stops this client waiting; it does not cancel the query
Athena-side. Use the service's own cancellation call if the query itself must
be stopped ([ADR-0049](../../adr/0049-cooperative-cancellation-contract.md)).

## See also

- [`aws/clients`](./clients.md) — the `script.aws.clients.athena` seam this submodule's client is injected from; also reachable as `script.aws.services.athena` (`AWSServiceProvider`).
- [`aws/cloudwatch-logs-insights`](./cloudwatch-logs-insights.md) — the async start/await decomposition and row-normalization precedent this submodule mirrors.
- [`core/polling`](../core/polling.md) — `M3LPoller`, `M3LRetryRunner`, `M3LPollingPolicies.athenaQuery()`/`.awsThrottling()`.
- [ADR-0029](../../adr/0029-script-dependency-boundary.md) — the script-dependency-boundary decision this submodule unblocks (`athena-query`, W4).
- [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md) — scopes `athena-query` to Athena-only.
