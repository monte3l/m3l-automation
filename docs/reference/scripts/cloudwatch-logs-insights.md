# cloudwatch-logs-insights

Run a CloudWatch Logs Insights query across one or more log groups over a time
range, splitting the range into fixed-size windows to stay under the
10,000-row `GetQueryResults` cap per query, and export the combined results to
JSON or CSV. A run can be resumed after an interruption or a hard failure.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/cloudwatch-logs-insights/README.md`](../../../scripts/cloudwatch-logs-insights/README.md).

## Purpose and scope

`cloudwatch-logs-insights` is a thin orchestrator over
[`AWS.M3LLogsInsightsClient`](../aws/cloudwatch-logs-insights.md) — it never imports
`@aws-sdk/*` directly (ADR-0027, ESLint-enforced). The library client owns
query execution, throttling retries, poll-to-completion, and AWS `ResultField[]`
row normalization; this script owns time-window planning, checkpointed
resume, and result export.

**In scope:** a single `query` applied identically across a sequence of
windows spanning `[start, end)`, aggregated into one output file.
**Out of scope:** per-window query variation, live/tailing queries, and any
AWS SDK call the script would have to construct itself — `script.aws.clients.cloudWatchLogs`
(the raw `CloudWatchLogsClient`) is only ever handed to `M3LLogsInsightsClient`,
never called directly.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam (never `process.env`). Resolution order is CLI > JSON > YAML >
env/.env > preset > default.

| Parameter       | Type           | Default   | Validation           | Description                                                                                                                                                                                                                                                                                                |
| --------------- | -------------- | --------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`   | `STRING`       | _(req.)_  | `nonEmpty`           | Named AWS profile. The sole trigger for `M3LScript` stage 5 to provision `script.aws`, exposing `script.aws.clients.cloudWatchLogs`.                                                                                                                                                                       |
| `logGroups`     | `STRING_ARRAY` | _(req.)_  | `nonEmpty`           | Log group names, forwarded verbatim as `logGroupNames` to every window's `StartQuery`.                                                                                                                                                                                                                     |
| `query`         | `STRING`       | _(req.)_  | `nonEmpty`           | The Logs Insights query string, applied identically to every window.                                                                                                                                                                                                                                       |
| `start`         | `STRING`       | _(req.)_  | `nonEmpty`; ISO-8601 | Inclusive start of the overall time range, e.g. `2026-07-01T00:00:00Z`. Converted to epoch seconds by `time-range.ts`.                                                                                                                                                                                     |
| `end`           | `STRING`       | _(req.)_  | `nonEmpty`; ISO-8601 | Exclusive end of the overall time range. Must be strictly after `start`.                                                                                                                                                                                                                                   |
| `windowMinutes` | `INT`          | `60`      | `range(1, 1440)`     | Size of each query window in minutes; `[start, end)` is split into fixed windows of this size (a shorter final window).                                                                                                                                                                                    |
| `limit`         | `INT`          | _(unset)_ | `range(1, 10_000)`   | Optional per-window row cap, forwarded verbatim as `StartLogsInsightsQueryInput.limit`.                                                                                                                                                                                                                    |
| `format`        | `STRING`       | `json`    | `oneOf(json, csv)`   | Output format; selects the exporter (`Core.M3LJSONListExporter` / `Core.M3LCSVListExporter`).                                                                                                                                                                                                              |
| `output`        | `STRING`       | _(req.)_  | `nonEmpty`           | Output file name, resolved under `M3L_OUTPUT_DIR`. The checkpoint file is derived from this name (see below).                                                                                                                                                                                              |
| `resume`        | `BOOL`         | `false`   | —                    | When `true`, read the checkpoint and continue from the first incomplete window instead of starting over; if no checkpoint file exists, the run fails with `Core.M3LCheckpointError` (`ERR_CHECKPOINT_MISSING`) rather than silently starting over. When `false`, the checkpoint file is never read at all. |

Required parameters (`aws.profile`, `logGroups`, `query`, `start`, `end`,
`output`) are declared `required: true` with `Core.M3LConfigValidators.nonEmpty`,
enforced by the library at **config-load time**. `start < end` is a
**cross-parameter** check a single parameter's own `validate` cannot express;
it is declared as a `Core.M3LConfigSchemaValidator` in `config.ts`
(`configValidators`, F1b) and enforced at **config-load time**, before any
window is planned or any query is issued, throwing
`Core.M3LConfigValidationError` (`ERR_CONFIG_VALIDATION`). The ISO-8601 parse
itself is a **format** check that stays a run-start guard in
`resolve-settings.ts` (`ERR_LOGS_INSIGHTS_SETTINGS`) — a schema-level
validator that also parsed the dates would duplicate that guard, so an
unparseable `start`/`end` is deliberately left for `resolve-settings.ts` to
catch, and the `start < end` schema-level check is a no-op (passes) when
either value doesn't parse.

## Steps

One module per `src/steps/` responsibility; each takes injected dependencies
(config values, logger, `script.aws`, `M3LPaths`) as a single options object
and is unit-testable with plain mocks — no `M3LScript` lifecycle.

| Step                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve-settings`             | Parse the resolved config into a typed run-settings object: ISO-8601 `start`/`end` → epoch seconds (throwing on an unparseable string), plus the pass-through fields (`logGroups`, `query`, `windowMinutes`, `limit`, `format`, `output`, `resume`). The `start < end` cross-parameter check runs earlier, at config-load time (`config.ts`'s `configValidators`) — this step assumes it already holds.                                                                                                                                                                                                                                                                                                                                                       |
| `time-range`                   | Pure function splitting `[startEpochSeconds, endEpochSeconds)` into an ordered array of fixed-size `{ startTime, endTime }` windows of `windowMinutes * 60` seconds (the final window is shorter if the range doesn't divide evenly). No I/O.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `export-results`               | Write the **full accumulated row set** (checkpoint's carried-over rows plus this run's newly-fetched rows) to the output file in one shot via the exporter's whole-array `export(items)` (`format`-dispatched `Core.M3LJSONListExporter` / `Core.M3LCSVListExporter`) — called **once**, after the last window, never incrementally per window.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `run-cloudwatch-logs-insights` | The orchestrator — composes `resolve-settings` → `time-range` → per-window `AWS.M3LLogsInsightsClient.startQuery()` + a [`Core.M3LCheckpointStore`](../core/checkpoint.md) keyed on `output` (recording `{ completedWindows: number, rows: readonly LogsInsightsRow[], inFlightQueryId?: string }` — the **rows already fetched**, not just a count, since the exporters can only write a whole array, not append; `resume: true` reads it, an absent file throws `ERR_CHECKPOINT_MISSING`, every other run starts from `{ completedWindows: 0, rows: [] }`) + `awaitResults()` → accumulate rows → checkpoint update → `export-results` once at the end. A terminal query failure aborts the run with the checkpoint (and its accumulated rows) left intact. |

## Resume and failure semantics

- **Why the checkpoint carries rows, not just a count:** the library's list
  exporters (`M3LJSONListExporter`/`M3LCSVListExporter`) only support a
  whole-array write, not append — re-opening the output file mid-run would
  truncate it. So instead of writing incrementally, the script accumulates
  rows across windows (in memory during a run, and in the checkpoint file
  across resumed runs) and writes the output file exactly once, at the end,
  from the full accumulated set. Row volume is bounded — at most
  `windowCount * 10,000` rows, the same cap `GetQueryResults` already imposes
  per window.
- **Checkpointed, not ad hoc:** `resume` never takes a `queryId` directly —
  the checkpoint file is the single source of truth for how far a run got
  and what it already has. This lets a caller re-invoke the exact same
  config with `resume: true` and no other change.
- **`resume: true` with no checkpoint is an error, not a fresh start:** the
  `Core.M3LCheckpointStore` is constructed with a `{ kind: "error" }`
  missing-checkpoint policy whenever `resume` is set, so an absent checkpoint
  file surfaces as `Core.M3LCheckpointError` / `ERR_CHECKPOINT_MISSING`
  rather than silently starting over (see [`core/checkpoint`](../core/checkpoint.md)).
  A present-but-corrupt checkpoint throws `ERR_CHECKPOINT_PARSE`; any other
  read/write/delete failure throws `ERR_CHECKPOINT_IO`. A non-resume run
  never reads the checkpoint file at all.
- **Checkpoint shape validation is strict, not just structural:** the `validate`
  predicate (`isLogsInsightsCheckpoint`) requires `completedWindows` to be a
  non-negative integer (rejects negative, non-integer, `NaN`, and `Infinity`
  values) and every `rows` element to be a plain object whose every value is a
  `string` (matching the declared `LogsInsightsRow` shape) — not merely an
  array of arbitrary JSON. A truncated or hand-edited checkpoint that would
  otherwise resume into a wrong window offset instead fails loud with
  `ERR_CHECKPOINT_PARSE`.
- **`startQuery` + `awaitResults`, not `runQuery`:** the orchestrator calls
  the two-step form so it can checkpoint `inFlightQueryId` the moment a
  query starts, before waiting on it — `runQuery()` alone never surfaces a
  mid-flight `queryId` to checkpoint.
- **Abort-and-checkpoint on hard failure:** a terminal
  `M3LLogsInsightsQueryFailedError` (a genuinely-failed query, not
  poll-in-progress) aborts the whole run rather than skipping the window —
  no silently-incomplete output file is ever written (the output file is
  only written on full completion). Because the checkpoint is updated after
  each **completed** window (not the failing one), a subsequent
  `resume: true` run picks up exactly at the failed window without
  re-querying anything already fetched.
- **In-flight re-attach:** if the process is interrupted mid-poll (not a
  query failure — e.g. the process was killed), the checkpoint's
  `inFlightQueryId` lets `resume: true` call `awaitResults(queryId)` directly
  instead of re-issuing `StartQuery` for that window.

## Inputs and outputs

- **Reads:** nothing from `M3L_INPUT_DIR` — this script's only external input
  is the CloudWatch Logs Insights API via `script.aws.clients.cloudWatchLogs`.
- **Writes:** the file named by `output` under `M3L_OUTPUT_DIR`, in the
  `format`-selected encoding, plus the `<output>.checkpoint.json` sidecar
  (deleted on a fully-completed run, from the `onAfterRun` hook — `M3LScript`
  has no `onShutdown` hook).
  Stage-9 run archival captures both as usual.
- **Reports:** a run summary line — windows completed, rows exported, and
  (on abort) the window index that failed — through the script's logger.

## See also

- [`aws/cloudwatch-logs-insights`](../aws/cloudwatch-logs-insights.md) — `M3LLogsInsightsClient`,
  the query wrapper this script composes with.
- [`aws/clients`](../aws/clients.md) — the `script.aws.clients.cloudWatchLogs` seam.
- [`core/exporters`](../core/exporters.md) — the JSON/CSV list exporters.
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on.
- [ADR-0027](../../adr/0027-aws-sdk-boundary-typed-wrappers.md) — why this
  script never imports `@aws-sdk/*` directly.
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions.
