# athena-query

Run a single Amazon Athena query and export its results to JSON or CSV. A run
can be resumed after an interruption by reattaching to the same in-flight
query instead of re-issuing it.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/athena-query/README.md`](../../../scripts/athena-query/README.md).

## Purpose and scope

`athena-query` is a thin orchestrator over
[`AWS.M3LAthenaClient`](../aws/athena.md) — it never imports
`@aws-sdk/client-athena` directly (ADR-0029). The library client owns query
execution, throttling retries, poll-to-completion, and `GetQueryResults`
pagination/row normalization; this script owns checkpointed resume and result
export.

**In scope:** a single `queryString` executed once, with its full result set
exported to one output file. **Out of scope:** multi-query batches, per-row
transformation, and any AWS SDK call the script would have to construct
itself — `script.aws.clients.athena` (the raw `AthenaClient`) is only ever
handed to `M3LAthenaClient`, never called directly. The `pg`/`mongodb` engines
are out of scope entirely (ADR-0029 supersedes script-local deps; ADR-0031
declines the Aurora/DocumentDB wrappers).

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam (never `process.env`). Resolution order is CLI > JSON > YAML >
env/.env > preset > default.

| Parameter             | Type           | Default   | Validation         | Description                                                                                                                           |
| --------------------- | -------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`         | `STRING`       | _(req.)_  | `nonEmpty`         | Named AWS profile. The sole trigger for `M3LScript` stage 5 to provision `script.aws`, exposing `script.aws.clients.athena`.          |
| `queryString`         | `STRING`       | _(req.)_  | `nonEmpty`         | The SQL query text, passed verbatim as `StartAthenaQueryInput.queryString`.                                                           |
| `database`            | `STRING`       | _(unset)_ | —                  | `QueryExecutionContext.Database`.                                                                                                     |
| `catalog`             | `STRING`       | _(unset)_ | —                  | `QueryExecutionContext.Catalog`.                                                                                                      |
| `outputLocation`      | `STRING`       | _(unset)_ | —                  | S3 URI for `ResultConfiguration.OutputLocation`. Required by AWS unless the target workgroup has a default output location.           |
| `workGroup`           | `STRING`       | _(unset)_ | —                  | Athena workgroup name.                                                                                                                |
| `executionParameters` | `STRING_ARRAY` | _(unset)_ | —                  | Positional parameters for a parameterized query.                                                                                      |
| `format`              | `STRING`       | `json`    | `oneOf(json, csv)` | Output format; selects the exporter (`Core.M3LJSONListExporter` / `Core.M3LCSVListExporter`).                                         |
| `output`              | `STRING`       | _(req.)_  | `nonEmpty`         | Output file name, resolved under `M3L_OUTPUT_DIR`. The checkpoint file is derived from this name (see below).                         |
| `resume`              | `BOOL`         | `false`   | —                  | When `true`, read the checkpoint and reattach to its in-flight `queryExecutionId` via `awaitResults` instead of starting a new query. |

Required parameters (`aws.profile`, `queryString`, `output`) are declared
`required: true` with `Core.M3LConfigValidators.nonEmpty`, enforced by the
library at **config-load time**. There are no cross-parameter or ISO-8601-style
format checks the way `cloudwatch-logs-insights` needs — `athena-query` issues
a single query with no time-window planning — but a `resolve-settings` step
still narrows the resolved config into a typed `AthenaQuerySettings` (the
`StartAthenaQueryInput` fields plus `format`/`output`/`resume`) for isolated
unit testability, mirroring the sibling script's structure.

## Steps

One module per `src/steps/` responsibility; each takes injected dependencies
(config values, logger, `script.aws`, `M3LPaths`) as a single options object
and is unit-testable with plain mocks — no `M3LScript` lifecycle.

| Step               | Responsibility                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve-settings` | Narrows the resolved config into a typed `AthenaQuerySettings` — the `StartAthenaQueryInput` fields (`queryString`/`database`/`catalog`/`outputLocation`/`workGroup`/`executionParameters`, omitting unset optional fields) plus `format`/`output`/`resume`. Throws `AthenaSettingsError` (`ERR_ATHENA_SETTINGS`) on a malformed config value. |
| `checkpoint`       | Read/write/delete a JSON checkpoint file (`<output>.checkpoint.json`, resolved under `M3L_OUTPUT_DIR` via `Core.M3LPaths.resolveOutput()`) recording `{ queryExecutionId?: string }` — the in-flight Athena query id, if any. `resume: true` reads it; every other run starts from an empty checkpoint. Deleted on full completion.            |
| `export-results`   | Write the query's normalized rows to the output file in the `format`-selected encoding (`Core.M3LJSONListExporter` / `Core.M3LCSVListExporter`), called **once**, after `awaitResults` succeeds.                                                                                                                                               |
| `run-athena-query` | The orchestrator — resolves settings, checkpoints-or-reattaches (`checkpoint` + `AWS.M3LAthenaClient.startQuery()`, recording `queryExecutionId`, or reattaching to a checkpointed one), `awaitResults()`, `export-results` once, then deletes the checkpoint. A terminal query failure aborts the run with the checkpoint left intact.        |

## Resume and failure semantics

- **`startQuery` + `awaitResults`, not `runQuery`:** the orchestrator calls
  the two-step form so it can checkpoint `queryExecutionId` the moment the
  query starts, before waiting on it — `runQuery()` alone never surfaces a
  mid-flight id to checkpoint.
- **Checkpointed, not ad hoc:** `resume` never takes a `queryExecutionId`
  directly — the checkpoint file is the single source of truth for whether a
  prior run's query is still in flight. This lets a caller re-invoke the
  exact same config with `resume: true` and no other change.
- **Abort-and-checkpoint on hard failure:** a terminal
  `AWS.M3LAthenaQueryFailedError` (a genuinely-failed/cancelled query, not
  poll-in-progress) aborts the run — the checkpoint is left intact (still
  carrying `queryExecutionId`) rather than deleted, and no output file is
  written. A subsequent `resume: true` run reattaches via `awaitResults`
  directly, which will surface the same terminal failure rather than
  re-issuing the query — a genuinely-failed query is not automatically
  retried by resuming; re-running with a fresh (non-resumed) invocation
  issues a new query.
- **In-flight re-attach:** if the process is interrupted mid-poll (e.g. the
  process was killed, not a query failure), the checkpoint's
  `queryExecutionId` lets `resume: true` call `awaitResults(queryExecutionId)`
  directly instead of re-issuing `startQuery`.

## Inputs and outputs

- **Reads:** nothing from `M3L_INPUT_DIR` — this script's only external input
  is the Athena query API via `script.aws.clients.athena`.
- **Writes:** the file named by `output` under `M3L_OUTPUT_DIR`, in the
  `format`-selected encoding, plus the `<output>.checkpoint.json` sidecar
  (deleted on a fully-completed run). Stage-9 run archival captures both as
  usual.
- **Reports:** a run summary line — rows exported and the query execution id —
  through the script's logger.

## See also

- [`aws/athena`](../aws/athena.md) — `M3LAthenaClient`, the query wrapper this
  script composes with.
- [`aws/clients`](../aws/clients.md) — the `script.aws.clients.athena` seam.
- [`core/exporters`](../core/exporters.md) — the JSON/CSV list exporters.
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on.
- [`cloudwatch-logs-insights`](./cloudwatch-logs-insights.md) — the sibling
  async start/checkpoint/await script this one mirrors, simplified for a
  single non-windowed query.
- [ADR-0029](../../adr/0029-script-dependency-boundary.md) — why this script
  never imports `@aws-sdk/*` directly, and the W4 prerequisite this submodule
  unblocks.
- [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md) —
  scopes `athena-query` to Athena-only.
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions.
