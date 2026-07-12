# dynamo-crud

CRUD, batch, and streaming operations against a DynamoDB table with checkpoint resume and destructive-op confirmation

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/dynamo-crud/README.md`](../../../scripts/dynamo-crud/README.md).

## Purpose and scope

`dynamo-crud` performs CRUD, batch, and streaming operations against a single
DynamoDB table via the library's [`aws/dynamodb`](../aws/dynamodb.md)
high-level item operations (`AWS.getItem`/`putItem`/`updateItem`/`deleteItem`/
`queryItems`/`scanSegment`/`batchWriteItems`/`batchDeleteItems`/
`describeTable`) — `get | put | update | delete | query | scan | batch-write |
batch-delete | export | import`. The script never constructs an AWS SDK
command or imports `@aws-sdk/lib-dynamodb`/`@aws-sdk/client-dynamodb` itself;
`aws/dynamodb` is the sole abstraction boundary over those SDK commands (see
its contract page for why). It is the first W2 scale-hardened script: reads at scale
(`scan`/`export`) run parallel segmented scan workers that page-loop and stream
straight to a JSONL sink (never materializing the table in memory), and writes
at scale (`batch-write`/`batch-delete`/`import`) chunk into 25-item `BatchWrite`
requests with `UnprocessedItems` retried through `M3LRetryRunner`. Long reads
and writes checkpoint their cursor so a killed run resumes with `--resume`
instead of restarting.

**In scope:** single-table, item-level operations, including full-table scan
and bulk batch write/delete/import/export at ≥ 10⁶-record scale. **Out of
scope:** table/index creation or schema changes (a future `cfn-stacks`
concern), cross-table joins, and record-shape transformation — `export`'s
output is Task-1 JSONL; filtering, field extraction, and reformatting are
`json-etl`'s job, not duplicated here.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam (never `process.env`). Resolution order is CLI > JSON > YAML >
env/.env > preset > default.

| Parameter              | Type     | Default   | Validation                                                                                | Description                                                                                                                                                                   |
| ---------------------- | -------- | --------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`          | `STRING` | _(req.)_  | non-empty                                                                                 | AWS named profile; declaring this parameter triggers the `script.aws` provisioning seam (`AWS_PROFILE_PARAM_NAME`).                                                           |
| `operation`            | `STRING` | _(req.)_  | `oneOf(get, put, update, delete, query, scan, batch-write, batch-delete, export, import)` | Which of the ten operations this run performs.                                                                                                                                |
| `tableName`            | `STRING` | _(req.)_  | non-empty                                                                                 | Target DynamoDB table.                                                                                                                                                        |
| `batchSize`            | `INT`    | `100`     | `range(1, 10_000)`                                                                        | Page size for `scan`/`query` reads.                                                                                                                                           |
| `totalSegments`        | `INT`    | `1`       | `range(1, 1_000)`                                                                         | Parallel `scan`/`export` worker count; each segment is an independent async-generator page-loop with its own checkpoint.                                                      |
| `maxPagesPerSecond`    | `FLOAT`  | _(unset)_ | `range(0, …)`                                                                             | Optional inter-page delay to cap read throughput against provisioned RCUs.                                                                                                    |
| `maxInFlightBatches`   | `INT`    | `4`       | `range(1, 100)`                                                                           | Concurrent 25-item `BatchWrite`/`BatchDelete` requests in flight for `batch-write`/`batch-delete`/`import`.                                                                   |
| `checkpointEveryPages` | `INT`    | `25`      | `range(1, …)`                                                                             | How often (in pages) the checkpoint file is written for resumable reads.                                                                                                      |
| `resume`               | `BOOL`   | `false`   | —                                                                                         | Load `<output-dir>/<run-name>.checkpoint.json` and continue; an absent checkpoint with `resume: true` is a typed config error, not a silent fresh start.                      |
| `key`                  | `STRING` | _(unset)_ | non-empty when set                                                                        | JSON-encoded key for `get`/`update`/`delete` (the item's primary key), **and reused as `query`'s equality key condition** (`AWS.queryItems`'s `keyCondition`).                |
| `item`                 | `STRING` | _(unset)_ | non-empty when set                                                                        | JSON-encoded item for `put` (the full item), **and reused as `update`'s merge patch** (`AWS.updateItem`'s `patch` — each top-level field becomes one generated `SET` clause). |
| `indexName`            | `STRING` | _(unset)_ | non-empty when set                                                                        | Optional GSI/LSI name for `query`.                                                                                                                                            |
| `input`                | `STRING` | _(unset)_ | non-empty when set                                                                        | Source file for `batch-write`/`batch-delete`/`import`, resolved under `M3L_INPUT_DIR` (JSONL/JSON via `import-records`).                                                      |
| `output`               | `STRING` | _(unset)_ | non-empty when set                                                                        | Destination file for `export`/`get`/`query`/`scan` results, resolved under `M3L_OUTPUT_DIR`.                                                                                  |
| `progressEveryRecords` | `INT`    | `10_000`  | `range(1, …)`                                                                             | Log a progress line (count, elapsed, source cursor) every N records; never per-record at scale.                                                                               |

`operation`, `tableName`, and `aws.profile` are declared `required: true` with
`Core.M3LConfigValidators.nonEmpty`/`oneOf`, so presence is enforced by the
library at **config-load time**. The remaining per-operation requirements
(e.g. `key` for `get`, `input` for `batch-write`) are **cross-parameter**
constraints the per-parameter validators cannot express, so they stay guards
at **run start** (top of `run-dynamo-crud`), the same pattern as `json-etl`'s
`sort`⇒`limit` guard (F1b backlog item).

## Steps

One row per `src/steps/` **module**; each takes injected dependencies (config
values, the `AWS.dynamodb` item operations, logger, paths) as a single options
object and is unit-testable without the `M3LScript` lifecycle. Read-side and
write-side steps are both `AsyncIterable`-based (O(1) memory) per the fleet's
streaming step contract.

| Step                | Responsibility                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single-item-ops`   | `get` / `put` / `update` / `delete` against one key/item via `AWS.getItem`/`putItem`/`updateItem`/`deleteItem`. `delete`/`update` route through the destructive-operation gate.                                                                                                                                                                                                                     |
| `scan-table`        | `scan`/`query`/`export`: `totalSegments` parallel workers each driving `AWS.scanSegment`/`queryItems` (async generators yielding `{ items, lastEvaluatedKey }` pages), checkpointing `lastEvaluatedKey` every `checkpointEveryPages` pages, streaming records straight to the JSONL sink. `query` adds `indexName` + `key` as the equality key condition.                                           |
| `batch-write-table` | `batch-write`/`batch-delete`/`import`: reads records via `import-records` (shared `M3LJSONListImporter.importStream()` wrapper), chunks into 25-item groups, calls `AWS.batchWriteItems`/`batchDeleteItems`, retries each call's `unprocessed` result through `M3LRetryRunner`'s throttling classifier bounded by `maxInFlightBatches`, and appends still-failing items to `<output>/failed.jsonl`. |
| `destructive-gate`  | Shared confirm-gate for `delete`/`update`/`batch-delete`/`import` into a non-empty table: prints the target table + an item-count estimate (`AWS.describeTable`) and requires confirmation before proceeding (fleet convention, promoted in W5).                                                                                                                                                    |
| `run-dynamo-crud`   | Composes the pipeline — the only module that knows operation dispatch order: resolve operation → (destructive gate if applicable) → read or write step → emit the run summary (written/retried/failed/skipped counts) through the `ctx`-correlated logger, exiting non-zero on failures.                                                                                                            |

## Inputs and outputs

- **Reads:** for batch write-side operations, the file named by `input`,
  resolved under `M3L_INPUT_DIR` (JSONL/JSON via `import-records`).
- **Writes:** for read-side operations, the file named by `output`, resolved
  under `M3L_OUTPUT_DIR`, as streamed JSONL. Write-side operations write
  `<output>/failed.jsonl` for any item that fails after retry, and a
  `<output-dir>/<run-name>.checkpoint.json` (deleted on successful completion)
  for resumable long reads.
- **Reports:** a run summary — items read/written/retried/failed/skipped — so
  a partial batch failure is never silent; the run exits non-zero when any
  items land in `failed.jsonl`.

## See also

- [`aws/dynamodb`](../aws/dynamodb.md) — the high-level item operations (`getItem`/`putItem`/`updateItem`/`deleteItem`/`queryItems`/`scanSegment`/`batchWriteItems`/`batchDeleteItems`/`describeTable`) used throughout; the sole abstraction boundary over the AWS SDK commands.
- [`core/polling`](../core/polling.md) — `M3LRetryRunner` and its throttling policies, used for `unprocessed`-result retry.
- [`core/importers`](../core/importers.md) — `M3LJSONListImporter.importStream()`, wrapped by `import-records`.
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on.
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions.
