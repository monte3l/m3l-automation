# logs-insights

Run CloudWatch Logs Insights queries and export results, splitting by time window for the 10k-row cap

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/logs-insights/README.md`](../../../scripts/logs-insights/README.md).

## Purpose and scope

Runs a CloudWatch Logs Insights query (`StartQuery`/`GetQueryResults` via
`script.aws.cloudWatchLogs`, a `CloudWatchLogsClient`) over one or more log
groups and a caller-specified time range, then exports the matched rows to
`M3L_OUTPUT_DIR`.

In scope:

- Submitting the query per time sub-window with `StartQueryCommand`.
- Polling each query to a terminal state with `Core.M3LPoller` driven by
  `Core.M3LPollingPolicies.cloudWatchLogsQuery()`.
- Splitting the requested `[start, end]` range into fixed-width sub-windows
  (`windowMinutes`) and running one query per window, so no single query risks
  the CloudWatch Logs Insights **10,000-row per-query truncation cap**
  (`GetQueryResults` returns at most 10,000 rows for a query).
- Checkpointing the AWS-side `queryId` (plus the window plan and
  completed-window set) so an interrupted run can `--resume`: skip
  already-exported windows and **re-attach** the in-flight window's
  `GetQueryResults` poll instead of resubmitting a fresh `StartQuery`.
- Exporting rows in the established fleet formats (`json`/`jsonl`/`csv`/`html`).

Out of scope: log ingestion/subscription (reads existing log data only),
cross-account/cross-region log-group discovery, `nextToken` pagination within
a single window (the 10k cap is handled by window-splitting, not intra-window
pagination), and query authoring beyond passing the `query` string straight
through to AWS.

AWS access is exclusively through the `aws.profile` config seam → provisioned
`script.aws` (`script.aws.cloudWatchLogs`); the script never constructs its
own SDK client or credential chain.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. The scaffold placeholder `batchSize` is replaced by `limit` (a
per-query row bound matching the AWS cap and the `json-etl` `limit` naming).
`aws.profile` is kept exactly as declared by the scaffold.

| Parameter       | Type           | Required/Default  | Validation                                       | Description                                                                                                                                                                                         |
| --------------- | -------------- | ----------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`   | `STRING`       | optional          | —                                                | Named AWS profile (`Core.AWS_PROFILE_PARAM_NAME`). Declaring this parameter is the sole trigger for `script.aws` provisioning (stage 5); when unresolved, the SDK default credential chain applies. |
| `logGroups`     | `STRING_ARRAY` | required          | `nonEmpty` + `≤ 50` entries                      | Log group names passed to `StartQuery` as `logGroupNames` (AWS caps a single `StartQuery` at 50 log groups).                                                                                        |
| `query`         | `STRING`       | required          | `nonEmpty`                                       | The Logs Insights query string, passed verbatim as `queryString`.                                                                                                                                   |
| `start`         | `STRING`       | required          | `regex(TIME_SPEC_RE)`                            | Inclusive range start: a relative duration (`\d+[smhd]`, resolved as _now − duration_) or an ISO-8601 timestamp.                                                                                    |
| `end`           | `STRING`       | default `"now"`   | `regex(TIME_SPEC_RE)` (admits the literal `now`) | Inclusive range end: `now`, a relative duration, or an ISO-8601 timestamp.                                                                                                                          |
| `windowMinutes` | `INT`          | default `60`      | `range(1, 1440)`                                 | Width of each sub-window in minutes; the range splits into `ceil(spanMinutes / windowMinutes)` windows, one query each.                                                                             |
| `limit`         | `INT`          | default `10000`   | `range(1, 10000)`                                | Per-query `StartQuery.limit` — max rows AWS returns for one query, hard-capped at 10,000.                                                                                                           |
| `format`        | `STRING`       | default `"jsonl"` | `oneOf(["json", "jsonl", "csv", "html"])`        | Output format; defaults to `jsonl` (append-safe, streaming) — unlike `json-etl`'s `json` default.                                                                                                   |
| `output`        | `STRING`       | required          | `nonEmpty`                                       | Output file name, relative to `M3L_OUTPUT_DIR` (resolved via `M3LPaths.resolveOutput`; `..`/absolute rejected).                                                                                     |
| `resume`        | `BOOL`         | default `false`   | —                                                | When `true`, load the checkpoint and continue (skip completed windows, re-attach the in-flight `queryId`).                                                                                          |

**Cardinality guards enforced beyond a single-parameter validator** (in
`time-range.ts`/`resolve-settings.ts`, not `config.ts`):

- Derived window count `≤ MAX_WINDOWS` (constant, `1000`) — a
  `start`/`end`/`windowMinutes` combination producing more windows throws
  `ERR_LOGS_INSIGHTS_CONFIG` telling the operator to widen `windowMinutes`.
- `resume === true` ⇒ `format === "jsonl"` (only JSONL is safely appendable
  across a resumed run) — throws `ERR_LOGS_INSIGHTS_CONFIG` otherwise.
- `resume === true` ⇒ a checkpoint file must exist and its fingerprint must
  match the current query definition — absent-checkpoint-with-`resume` and
  fingerprint-mismatch both throw `ERR_LOGS_INSIGHTS_CONFIG` (never a silent
  fresh start).

`TIME_SPEC_RE` is a module constant in `config.ts`, e.g.
`/^(now|\d+[smhd]|\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)$/`
— a coarse gate; `time-range.ts` performs the authoritative parse and throws
`ERR_LOGS_INSIGHTS_CONFIG` on a value the regex admits but cannot resolve to a
valid instant.

## Steps

One module per concern, all injection-friendly (deps as a single options
object, no module-level state) so each is unit-testable without the lifecycle.

| Step                | File                             | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve-preset`    | `src/steps/resolve-preset.ts`    | Parse the `--preset` CLI flag into a spreadable `{ preset?: string }` `M3LScriptOptions` fragment, folding bare/blank `--preset` to `{}` (verbatim shape from `json-etl`).                                                                                                                                                                                                                                         |
| `resolve-settings`  | `src/steps/resolve-settings.ts`  | Read every declared parameter into a typed `RunSettings` (coerced-type checks + the `resume ⇒ format==="jsonl"` constraint). Throws `ERR_LOGS_INSIGHTS_CONFIG` on violation.                                                                                                                                                                                                                                       |
| `time-range`        | `src/steps/time-range.ts`        | `parseInstant(spec, now): number` (epoch **seconds**) and `resolveTimeWindows({ startTime, endTime, windowMinutes }): readonly TimeWindow[]`. Validates `startTime < endTime` and the window-count bound.                                                                                                                                                                                                          |
| `checkpoint`        | `src/steps/checkpoint.ts`        | `checkpointFingerprint(settings)`, `loadCheckpoint(path)`, `saveCheckpoint(path, cp)` (atomic write-temp-then-rename), `deleteCheckpoint(path)` (best-effort). Throws `ERR_LOGS_INSIGHTS_CHECKPOINT` on I/O failure.                                                                                                                                                                                               |
| `start-query`       | `src/steps/start-query.ts`       | Issues `StartQueryCommand` via the injected `CloudWatchLogsClient`, wrapped in a `Core.M3LRetryRunner` built from `Core.M3LPollingPolicies.awsThrottling()`. Returns the `queryId`; throws `ERR_LOGS_INSIGHTS_START_QUERY` when the response carries none.                                                                                                                                                         |
| `await-results`     | `src/steps/await-results.ts`     | Builds a `Core.M3LPoller` from `cloudWatchLogsQuery()` and polls `GetQueryResultsCommand` on the given `queryId`. `Complete` → success; `Scheduled`/`Running` → continue; any other terminal status → **throws** `ERR_LOGS_INSIGHTS_QUERY_FAILED` carrying `{ queryId, status, windowIndex }`. Attempt exhaustion propagates as a plain `Core.M3LError` with `code === "ERR_POLL_EXHAUSTED"` (see Error handling). |
| `normalize-rows`    | `src/steps/normalize-rows.ts`    | Shape conversion only (`field`→`value`), preserving every field including `@ptr`/`@timestamp`/`@message`. No column filtering (that stays `json-etl`'s job).                                                                                                                                                                                                                                                       |
| `export-results`    | `src/steps/export-results.ts`    | Dispatches to `M3LJSONListExporter` / `M3LCSVListExporter` / `M3LHTMLListExporter` by `format`, streaming rows via `exportStream()`. Appends (jsonl-only) when resuming, truncates otherwise. Throws `ERR_LOGS_INSIGHTS_EXPORT` on failure.                                                                                                                                                                        |
| `run-logs-insights` | `src/steps/run-logs-insights.ts` | Orchestrator: resolve settings → resolve windows → load/validate-or-init checkpoint → per window `[reattach in-flight queryId \| startQuery] → awaitResults → normalizeRows → append` → checkpoint after each window → delete checkpoint on full success.                                                                                                                                                          |

Supporting wiring (not `steps/` modules): `src/hooks.ts` gains `onBeforeRun`
capturing `ctx.correlationId` plus a `getCorrelationId()` export (verbatim
pattern from `json-etl`); `src/main.ts` threads it into `runLogsInsights`
alongside `config`, `script.paths`, `script.aws`, `script.logger`.

Shared types: `TimeWindow = { readonly index: number; readonly startTime: number; readonly endTime: number }`
(epoch seconds, inclusive); `LogsInsightsCheckpoint = { readonly version: 1; readonly fingerprint: string; readonly totalWindows: number; readonly completed: readonly number[]; readonly inFlight: { readonly index: number; readonly queryId: string } | null }`;
normalized row = `Record<string, string>`.

## Checkpoint and resume

A single JSON checkpoint file per run (`LogsInsightsCheckpoint`) is written to
`M3LPaths.resolveOutput("<output>.checkpoint.json")` — derived deterministically
from `output`, alongside the results file. Written atomically (temp file +
`rename`).

**Write cadence.** Immediately after `StartQuery`/reattach for a window,
`inFlight` is set to `{ index, queryId }` and saved _before_ polling, so a
crash mid-poll leaves a resumable record. After a window's rows are fully
appended, `inFlight` clears and the window index is added to `completed`.

**`resume === true` behavior:**

1. `format` must be `jsonl` (append-safe output); otherwise `ERR_LOGS_INSIGHTS_CONFIG`.
2. A checkpoint must exist and its `fingerprint` must match the current query
   definition (log groups, query, resolved time range, window/limit); absent
   or mismatched ⇒ `ERR_LOGS_INSIGHTS_CONFIG` (never a silent fresh start).
3. Windows in `completed` are skipped (not re-queried, not re-exported).
4. A set `inFlight` window is **re-attached**: `await-results` polls the saved
   `queryId` directly (no new `StartQuery`). A since-failed/expired in-flight
   query surfaces the typed `ERR_LOGS_INSIGHTS_QUERY_FAILED` (or the AWS
   error), never a silent restart.
5. Remaining windows run normally.

**Fresh run (`resume === false`).** Any pre-existing checkpoint for the same
`output` is overwritten as windows complete; the output file opens truncating.

**Success cleanup.** On full completion, the checkpoint file is deleted
(best-effort, logged; a failed unlink does not fail the run).

## Inputs and outputs

**Reads (config):** `aws.profile`, `logGroups`, `query`, `start`, `end`,
`windowMinutes`, `limit`, `format`, `output`, `resume`. `query` and time
bounds may come from a named preset (`--preset`), overridden per run by CLI
flags.

**Reads (AWS, via `script.aws.cloudWatchLogs`):** `StartQueryCommand` per
window; `GetQueryResultsCommand` (poll loop) per window.

**Reads (filesystem, resume only):** the checkpoint file
`<output>.checkpoint.json` under `M3L_OUTPUT_DIR`.

**Writes (to `M3L_OUTPUT_DIR`, via `M3LPaths.resolveOutput`):**

- The results file named by `output`: one normalized row per matched log
  event, in the selected `format`, written incrementally window-by-window
  (memory is O(one window ≤ `limit` rows), never O(all windows)).
- The checkpoint file `<output>.checkpoint.json`, updated per window and
  deleted on success.

**Writes (logs, via `Core.M3LLogger`, correlation-id threaded):** one progress
line per completed window (index, row count, elapsed, AWS statistics); a
truncation warning when a window's matched-record count exceeds `limit`
(results may be incomplete — advise a smaller `windowMinutes`); a final run
summary. Never logs secrets; `logGroups`/`query` are operational, not secret.

## Error handling

Script-level failures throw the **base `Core.M3LError`** with script-scoped
`ERR_LOGS_INSIGHTS_*` codes (not new subclasses), following the `json-etl`
precedent — script codes are intentionally not members of the library's
`M3L_ERROR_CODES` tuple. All failures chain the underlying cause via `cause`;
narrowing at call sites is by `code`, not `instanceof`.

| Code                                  | Thrown by                                                      | When                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_LOGS_INSIGHTS_CONFIG`            | `resolve-settings.ts`, `time-range.ts`, `run-logs-insights.ts` | Wrong coerced param type; unparseable/invalid time spec; `startTime >= endTime`; window count over bound; `resume` with non-jsonl `format`; `resume` with no/mismatched checkpoint; `script.aws` unprovisioned. |
| `ERR_LOGS_INSIGHTS_START_QUERY`       | `start-query.ts`                                               | `StartQuery` response carries no `queryId`. `context: { windowIndex }`.                                                                                                                                         |
| `ERR_LOGS_INSIGHTS_QUERY_FAILED`      | `await-results.ts`                                             | `GetQueryResults` reaches a terminal non-`Complete` status. `context: { queryId, status, windowIndex }` — carries `queryId` so it's never lost.                                                                 |
| `ERR_LOGS_INSIGHTS_CHECKPOINT`        | `checkpoint.ts`                                                | Checkpoint read/parse/write (temp+rename) failure; `cause` chains the fs/JSON error.                                                                                                                            |
| `ERR_LOGS_INSIGHTS_EXPORT`            | `export-results.ts`                                            | Append/finalize failure; an already-typed `M3LError` from the exporter is re-thrown unchanged, otherwise wrapped with `cause`.                                                                                  |
| `ERR_LOGS_INSIGHTS_NO_CORRELATION_ID` | `hooks.ts` (`getCorrelationId`)                                | Called before `onBeforeRun` fired (composition-root wiring bug).                                                                                                                                                |

**Library `M3LError`s that propagate through unchanged** (tests must expect
the real thrown type, not a re-wrap):

- `M3LConfigMissingError` / `M3LConfigValidationError` / `M3LConfigCoercionError`
  — from config load, before any step runs.
- `M3LAWSClientError` — from `script.aws.cloudWatchLogs` client construction /
  credential resolution.
- A plain `Core.M3LError` with `code === "ERR_POLL_EXHAUSTED"` — from
  `await-results.ts` when `cloudWatchLogsQuery()`'s attempt bound (60) is
  reached while the AWS query is still `Running`/`Scheduled`. **The concrete
  class `M3LPollExhaustedError` is a private `internal/polling` type and is
  NOT exported from `Core`** (`packages/m3l-common/src/internal/polling/errors.ts`
  says so explicitly) — tests and implementation code must narrow via
  `error instanceof Core.M3LError && error.code === "ERR_POLL_EXHAUSTED"`,
  never `instanceof Core.M3LPollExhaustedError` (a compile error: the symbol
  doesn't exist on `Core`).
- `M3LPathResolutionError` — from `resolveOutput` when `output` is absolute or
  contains `..`.

`await-results.ts` deliberately throws the typed `ERR_LOGS_INSIGHTS_QUERY_FAILED`
(carrying `queryId`) for a terminal-failure AWS status rather than returning a
poller `{ type: "failure" }` decision — the corresponding private
`M3LPollFailureError` (also not exported from `Core`) is never reached by this
design.

**Contract nuances to hold the line on:**

- `TimeWindow.startTime`/`endTime` are epoch **seconds** (what `StartQuery`
  expects), not milliseconds.
- `logGroups` is sent to AWS as `logGroupNames` (the ≤50-name array form), not
  `logGroupName` (single) or `logGroupIdentifiers` (ARN form).
- `M3LError.cause` is typed `unknown`; tests must not over-constrain it to `Error`.
- The AWS client is reached at `script.aws.cloudWatchLogs` — **not**
  `script.aws.clients.cloudWatchLogs`; `M3LScript.aws` returns the provider
  directly (`AWSProvider | undefined`), with no `.clients` nesting.

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
