# sqs-etl

SQS message ETL: dump, send, redrive, delete, purge, and transform

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/sqs-etl/README.md`](../../../scripts/sqs-etl/README.md).

## Purpose and scope

A W2 (scale-hardened) consumer script that operates on one Amazon SQS queue at
a time, driven by a `command` config parameter with six modes: `dump` (drain
the queue to streamed JSONL), `send` (batch-publish JSONL records to the
queue), `redrive` (move messages from a DLQ back to its source queue),
`delete` (remove specific messages by receipt handle), `purge` (clear a
queue), and `transform` (map/filter records between two JSONL files without
touching SQS). It is out of scope for this script to manage queue
infrastructure (creation, redrive-policy configuration, DLQ wiring) — that is
`eventbridge-schedules`/CloudFormation territory (W3).

Deferred for future iterations:

- **Checkpoint/resume** for `dump`/`redrive` (the general fleet convention
  documented in `docs/plans/archive/2026-07-09-consumer-scripts-implementation-plan.md`
  Sec 1.2) is deferred — a killed multi-page run restarts rather than
  resuming. Filed as a W5 friction candidate in `IMPLEMENTATION.md` once this
  script ships; not silently dropped.
- **Client-side rate capping** (`maxPagesPerSecond`) is deferred; retry/backoff
  on throttling is still handled by `M3LSQSOperations`' internal
  `M3LRetryRunner`.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-command requiredness (the "Required for" column) is **not**
expressed by `M3LConfigParameter({ required: true })` — a single parameter's
`validate:` callback cannot express a cross-parameter constraint. These are
declared instead as `Core.M3LConfigSchemaValidator`s in `config.ts`
(`configValidators`, F1b) and enforced at **config-load time**, throwing
`Core.M3LConfigValidationError` (`ERR_CONFIG_VALIDATION`) before any step
module runs: `queueUrl` for `dump`/`send`/`redrive`/`delete`/`purge`,
`dlqUrl` for `redrive`, `input` for `send`/`delete`/`transform`, and `output`
for `dump`/`transform`. Every parameter besides `command`/`aws.profile`
remains _declared_ optional; each command's step module (`run-sqs-etl.ts`
dispatches to `steps/dump-queue.ts` etc.) keeps its own
`accessor.requiredString(...)` guard as defense-in-depth and to narrow
`string | undefined` to `string`. Same seam as [`json-etl`](./json-etl.md#configuration-schema)'s
`sort`-requires-`limit` check.

| Parameter                  | Type           | Default | Validation                                                          | Required for                                 | Description                                                                                                                                                            |
| -------------------------- | -------------- | ------- | ------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`              | `STRING`       | —       | `required: true`                                                    | all                                          | AWS SSO/credential profile name; declaring this parameter (via `Core.AWS_PROFILE_PARAM_NAME`) triggers `M3LScript`'s AWS-provisioning stage and populates `script.aws` |
| `command`                  | `STRING`       | —       | `required: true`, `oneOf(dump,send,redrive,delete,purge,transform)` | all                                          | Selects the operation mode                                                                                                                                             |
| `queueUrl`                 | `STRING`       | —       | `nonEmpty`; presence enforced at config-load (`configValidators`)   | `dump`, `send`, `redrive`, `delete`, `purge` | Target queue URL (for `redrive`, the queue messages are redriven **back to**)                                                                                          |
| `dlqUrl`                   | `STRING`       | —       | `nonEmpty`; presence enforced at config-load (`configValidators`)   | `redrive`                                    | Dead-letter queue URL messages are redriven **from**                                                                                                                   |
| `input`                    | `STRING`       | —       | `nonEmpty`; presence enforced at config-load (`configValidators`)   | `send`, `delete`, `transform`                | JSONL source file, resolved via `M3LPaths.resolveInput`                                                                                                                |
| `output`                   | `STRING`       | —       | `nonEmpty`; presence enforced at config-load (`configValidators`)   | `dump`, `transform`                          | JSONL destination file, resolved via `M3LPaths.resolveOutput`                                                                                                          |
| `batchSize`                | `INT`          | `100`   | `range(1, 10_000)`                                                  | `dump`, `send`, `redrive`, `delete`          | Total message budget for the run; internally chunked at SQS's 10-message-per-call cap                                                                                  |
| `visibilityTimeoutSeconds` | `INT`          | —       | `range(0, 43_200)`                                                  | `dump`, `redrive` (optional)                 | Passed through to `receive()`'s `visibilityTimeout`; unset uses the queue's own default                                                                                |
| `deleteAfterDump`          | `BOOL`         | `false` | —                                                                   | `dump` (optional)                            | Turns a non-destructive dump into a drain: deletes each page after it is durably appended to `output`. Destructive — confirm-gated (see Steps) when `true`             |
| `yes`                      | `BOOL`         | `false` | —                                                                   | any destructive command (optional)           | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged                                                                       |
| `fields`                   | `STRING_ARRAY` | `[]`    | —                                                                   | `transform` (optional)                       | `name=path` projection specs applied to each message body (`Core.extractAll`); empty means pass the body through unprojected                                           |
| `filters`                  | `STRING_ARRAY` | `[]`    | —                                                                   | `transform` (optional)                       | `path op value` predicates (`eq\|ne\|contains\|regex\|gt\|lt\|exists`) a record must satisfy to pass through                                                           |

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle. The generator emitted a single starter
step (`run-sqs-etl`) as a placeholder; `implementing-scripts` decomposes it
into the real per-command steps below, dispatched by `run-sqs-etl.ts` on the
resolved `command`.

| Step                | Responsibility                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dump-queue`        | Long-poll `receive()` loop (10 messages/call, `waitTimeSeconds: 20`) streaming JSONL-appends messages to `output` up to `batchSize`; `deleteAfterDump` additionally `deleteBatch()`s each written page (confirm-gated)                                                                                                                        |
| `send-batch`        | Streams `input` JSONL, chunks records into <=10-entry `M3LSQSSendEntry` batches, `sendBatch()`s each chunk; per-entry failures append to `failed.jsonl` and are reported via `M3LScript.reportRecovery()`                                                                                                                                     |
| `redrive-queue`     | Receives from `dlqUrl` up to `batchSize`, `sendBatch()`s each page to `queueUrl`, then `deleteBatch()`s from `dlqUrl` only the entries that sent successfully; unsent entries stay in the DLQ, are logged to `failed.jsonl`, and are reported via `M3LScript.reportRecovery()` — as are any post-send `deleteBatch()` failures. Confirm-gated |
| `delete-messages`   | Streams `input` JSONL (`{ receiptHandle }` rows), chunks into <=10-entry `M3LSQSDeleteEntry` batches, `deleteBatch()`s each; per-entry failures append to `failed.jsonl` and are reported via `M3LScript.reportRecovery()`. Confirm-gated                                                                                                     |
| `purge-queue`       | Calls `purgeQueue()`; confirm-gated, and surfaces SQS's `PurgeQueueInProgress` 60-second cooldown as a typed error rather than retrying through it                                                                                                                                                                                            |
| `transform-records` | Streams `input` JSONL, JSON-parses each message body with per-record tolerance (skip-count surfaced, no SQS calls), applies optional `fields` projection / `filters` predicate, streams to `output`                                                                                                                                           |
| `destructive-gate`  | Shared confirmation step used by `dump-queue` (when `deleteAfterDump`), `redrive-queue`, `delete-messages`, `purge-queue`: prints the target + operation, prompts via `script.prompt.confirm()`, bypassed by `yes` (bypass logged)                                                                                                            |
| `run-sqs-etl`       | Composition: resolves settings for the selected `command`, dispatches to the matching step above, returns the run summary                                                                                                                                                                                                                     |

All SQS access goes through `script.aws.services.sqsOperations`
(`AWS.M3LSQSOperations`, see [`aws/sqs`](../aws/sqs.md)) — this script never
imports `@aws-sdk/client-sqs` or constructs its own `SQSClient`.

## Inputs and outputs

Reads JSONL from `M3L_INPUT_DIR` (`send`, `delete`, `transform` source) and
writes JSONL to `M3L_OUTPUT_DIR` (`dump`/`transform` result, and the fixed
`failed.jsonl` re-drive file for partial `send`/`redrive`/`delete` batch
failures — each row is the original `M3LSQSSendEntry`/`M3LSQSDeleteEntry`,
ready to re-drive with no id bookkeeping). Queue identity (`queueUrl`,
`dlqUrl`) and the `command` selector come from config, never from input-file
content. Every absorbed per-entry failure in `send`/`redrive`/`delete` is
also reported via `M3LScript.reportRecovery()`, so a degraded-but-not-total
run resolves with a `"partial"` outcome (exit code `6`) rather than
succeeding silently.

## Error codes

Script-local error codes are plain `M3LError.code` strings, all prefixed
`ERR_SQS_ETL_`:

- `ERR_SQS_ETL_CONFIG` — a guard-checked config requirement was unmet. The
  missing-parameter cases (`queueUrl`/`dlqUrl`/`input`/`output` for the
  selected command) are now caught earlier by `configValidators`
  (`M3LConfigValidationError`); this code remains reachable for a declared
  parameter present but stored with the wrong type (`batchSize`/
  `visibilityTimeoutSeconds` non-number, `deleteAfterDump`/`yes` non-boolean,
  `fields`/`filters` non-string-array), via `Core.M3LConfigAccessor`'s
  fail-loud reads (see [`core/config`](../core/config.md)). `batchSize` in
  particular used to fall back to its default of `100` for any wrong-typed
  value; it now throws.
- `ERR_SQS_ETL_ABORTED` — the destructive-gate confirmation was declined.

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [`aws/sqs`](../aws/sqs.md) — `M3LSQSOperations`, the only SQS access seam this script uses
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
