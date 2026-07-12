# AWS Logs Insights

`M3LLogsInsightsClient` is a typed wrapper over CloudWatch Logs Insights query execution (`StartQuery`/`GetQueryResults`), so consumer scripts never need to import `@aws-sdk/client-cloudwatch-logs` directly ([ADR-0026](../../adr/0026-aws-sdk-boundary-typed-wrappers.md)).

## Overview

The submodule wraps an **injected**, already-provisioned `CloudWatchLogsClient` — obtain one from `script.aws.cloudWatchLogs` (the library's credential/client-construction seam) and inject it here. `M3LLogsInsightsClient` never constructs its own client from a profile/region; that stays behind the `aws.profile` seam.

It composes with `core/polling`: query completion is polled via `M3LPoller` built from `M3LPollingPolicies.cloudWatchLogsQuery()`, and the initial `StartQuery` call is retried under AWS throttling via `M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()`.

## Public API

Exported from `@m3l-automation/m3l-common/aws` (and re-exported under the `AWS` namespace):

- `M3LLogsInsightsClient` — the query wrapper class.
- `LogsInsightsAwaitOptions` — optional-override type for `awaitResults`/`runQuery`.
- `StartLogsInsightsQueryInput` — `startQuery`/`runQuery` input shape.
- `LogsInsightsQueryResult` — the successful result shape.
- `LogsInsightsQueryStatistics`, `LogsInsightsQueryStatus`, `LogsInsightsRow` — supporting types.
- `M3LLogsInsightsStartQueryError` (`code: "ERR_LOGS_INSIGHTS_START_QUERY"`) — thrown when `StartQuery` returns no `queryId`.
- `M3LLogsInsightsQueryFailedError` (`code: "ERR_LOGS_INSIGHTS_QUERY_FAILED"`) — thrown when a query reaches a terminal non-`Complete` status.

### `M3LLogsInsightsClient`

**Constructor** — `new M3LLogsInsightsClient(client: CloudWatchLogsClient)`.

**Methods:**

| Method         | Signature                                                                                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startQuery`   | `(input: StartLogsInsightsQueryInput) => Promise<string>`                                   | Wraps `StartQueryCommand`, retried under AWS throttling via `awsThrottling()`. Returns the bare `queryId`. Throws `M3LLogsInsightsStartQueryError` when the response carries no `queryId`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `awaitResults` | `(queryId: string, options?: LogsInsightsAwaitOptions) => Promise<LogsInsightsQueryResult>` | Standalone-usable (the resume/re-attach primitive — no fresh `StartQuery` is issued). Polls `GetQueryResultsCommand` via `M3LPoller` built from `cloudWatchLogsQuery()` by default (override via `options.pollerOptions`). `Complete` → resolves with normalized rows + statistics; `Scheduled`/`Running` → continues polling; any other terminal status → throws `M3LLogsInsightsQueryFailedError`. Poll-attempt exhaustion propagates the plain `M3LError` with `code === "ERR_POLL_EXHAUSTED"` unchanged (that error class itself is not part of the public barrel — narrow by `code`, not `instanceof`). |
| `runQuery`     | `(input, options?) => Promise<LogsInsightsQueryResult>`                                     | Convenience `startQuery` + `awaitResults` for the common non-resumable case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**`StartLogsInsightsQueryInput`** — field names mirror the AWS `StartQuery` request shape 1:1:

| Field           | Type                | Required | Notes                                                               |
| --------------- | ------------------- | -------- | ------------------------------------------------------------------- |
| `logGroupNames` | `readonly string[]` | yes      | The ≤50-name array form (not `logGroupName`/`logGroupIdentifiers`). |
| `queryString`   | `string`            | yes      | Passed verbatim as `queryString`.                                   |
| `startTime`     | `number`            | yes      | Epoch **seconds** (what `StartQuery` expects), not milliseconds.    |
| `endTime`       | `number`            | yes      | Epoch **seconds**.                                                  |
| `limit`         | `number`            | no       | Max rows AWS returns for this query (hard-capped at 10,000 by AWS). |

**`LogsInsightsQueryResult`:**

| Field        | Type                                       | Notes                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queryId`    | `string`                                   | The AWS-side query identifier this result was polled from.                                                                                                                                                                                       |
| `status`     | `"Complete"`                               | Only a `Complete` status reaches the success path.                                                                                                                                                                                               |
| `rows`       | `readonly LogsInsightsRow[]`               | Normalized rows — AWS `ResultField[]` collapsed to `Record<string,string>` per row, preserving every field including `@ptr`/`@timestamp`/`@message`. Row normalization is this submodule's responsibility; callers carry no AWS-shape knowledge. |
| `statistics` | `LogsInsightsQueryStatistics \| undefined` | `recordsMatched`/`recordsScanned`/`bytesScanned`, when AWS returns them.                                                                                                                                                                         |

## Error handling

| Error                             | Code                             | Thrown by      | Context                                                                             |
| --------------------------------- | -------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `M3LLogsInsightsStartQueryError`  | `ERR_LOGS_INSIGHTS_START_QUERY`  | `startQuery`   | `{ logGroupNames }`                                                                 |
| `M3LLogsInsightsQueryFailedError` | `ERR_LOGS_INSIGHTS_QUERY_FAILED` | `awaitResults` | `{ queryId, status }` — carries `queryId` so a caller can log/checkpoint against it |

`M3LLogsInsightsStartQueryError` is also thrown when the `StartQuery` SDK call itself fails — after any throttling retries (via `M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()`) are exhausted or the failure is classified fatal — chaining the underlying SDK/network error via `cause`. This is in addition to its existing no-`queryId`-in-response case, which carries no `cause` (a successful response with a bad shape has no exception to chain).

`M3LLogsInsightsQueryFailedError` is likewise thrown when the `GetQueryResults` SDK call itself fails after retries are exhausted: `GetQueryResults` is now retried under AWS throttling (`M3LRetryRunner` + `M3LPollingPolicies.awsThrottling()`), matching `StartQuery`'s treatment. A genuine send failure is reported with `status: "Unknown"` and the original error chained via `cause`. This is in addition to its existing terminal-AWS-status case (`Failed`/`Cancelled`/`Timeout`/`Unknown`/no-status), which still carries no `cause` — a successful response carrying a bad status has no exception to chain.

Poll-attempt exhaustion (the attempt bound reached while the query is still `Running`/`Scheduled`) is **not** wrapped: the `M3LPoller`-thrown plain `M3LError` with `code === "ERR_POLL_EXHAUSTED"` propagates unchanged. Callers narrow by `code`, never by `instanceof` on a poller-internal class (that class is intentionally not exported from the public barrel).

## See also

- [`aws/clients`](./clients.md) — the `script.aws.cloudWatchLogs` seam this submodule's client is injected from.
- [`core/polling`](../core/polling.md) — `M3LPoller`, `M3LRetryRunner`, `M3LPollingPolicies.cloudWatchLogsQuery()`/`.awsThrottling()`.
- [ADR-0026](../../adr/0026-aws-sdk-boundary-typed-wrappers.md) — the AWS SDK boundary decision this submodule implements.
- [`scripts/logs-insights`](../scripts/logs-insights.md) — the consuming script.
