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

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam.

| Parameter     | Type     | Default | Validation         | Description                                                                                                                                                            |
| ------------- | -------- | ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batchSize`   | `INT`    | `100`   | `range(1, 10_000)` | Items processed per batch (starter default; may be superseded by the SQS 10-message receive/send-batch cap during implementation)                                      |
| `aws.profile` | `STRING` | —       | `required: true`   | AWS SSO/credential profile name; declaring this parameter (via `Core.AWS_PROFILE_PARAM_NAME`) triggers `M3LScript`'s AWS-provisioning stage and populates `script.aws` |

Command-specific parameters (`command`, `queueUrl`, `dlqUrl`, visibility-timeout
budget, etc.) are added during implementation per the W2 command set below and
must be reflected in this table when they land.

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle. The generator emitted a single starter
step (`run-sqs-etl`) as a placeholder; `implementing-scripts` decomposes it
into the real per-command steps below.

| Step (planned) | Responsibility                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `dump`         | Long-poll receive loop (10 messages/batch) draining a queue to streamed JSONL output                       |
| `send`         | Batch-publish JSONL records to a queue via the `sqsBatchSend()` policy, writing failures to `failed.jsonl` |
| `redrive`      | Move messages from a DLQ back to its source queue, budgeted against the visibility timeout                 |
| `delete`       | Remove specific messages from a queue by receipt handle                                                    |
| `purge`        | Clear a queue's contents, respecting SQS's purge cooldown                                                  |
| `transform`    | Map/filter records between two JSONL files, no SQS calls                                                   |

## Inputs and outputs

Reads JSONL from `M3L_INPUT_DIR` (`send`, `transform` source) and writes JSONL
to `M3L_OUTPUT_DIR` (`dump` output, `transform` result, and the `failed.jsonl`
re-drive file for partial `send`/`redrive`/`delete` batch failures). Queue
identity (`queueUrl`, `dlqUrl`) and the `command` selector come from config,
never from input-file content.

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
