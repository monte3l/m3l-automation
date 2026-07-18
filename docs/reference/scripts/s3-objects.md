# s3-objects

Thin op-dispatch over the `aws/s3` typed operations wrapper: list, describe,
get, put, copy, and delete S3 objects

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/s3-objects/README.md`](../../../scripts/s3-objects/README.md).

## Purpose and scope

`s3-objects` performs single-bucket object operations via the library's
[`aws/s3`](../aws/s3.md) typed operations wrapper — free functions
(`AWS.listObjects`/`headObject`/`getObject`/`putObject`/`copyObject`/
`deleteObject`/`deleteObjects`), not a class facade like `aws.clients.
sqsOperations` — `list | describe | get | put | copy | delete |
delete-batch`. Every step calls `AWS.<fn>(client, ...)` against the raw
`S3Client` obtained via `script.aws.clients.s3`. The script never constructs
an AWS SDK command or imports
`@aws-sdk/client-s3` itself; `aws/s3` is the sole abstraction boundary over
those SDK commands (ADR-0027/ADR-0029). It is the first W3 script — mechanical
op-dispatch over an existing library wrapper, one AWS call per invocation
(`delete-batch` chunks internally, but issues no retries of its own).

**In scope:** single-bucket, single-object (or single-batch) operations:
listing under an optional prefix, reading one object's metadata or body,
writing or copying one object, and deleting one or many objects. **Out of
scope:** bucket creation/policy/lifecycle management (a future
`s3-buckets`-shaped concern, not this script), cross-bucket sync/replication,
and multipart upload for objects too large for a single `PutObjectCommand`
(the library wrapper doesn't expose multipart; a future `aws/s3` addition if a
consumer needs it).

## Origin

Filed as W3 in `docs/ROADMAP.md`, this script was blocked until the
`aws/s3` library wrapper existed — the roadmap's original "existing getters ✓"
premise for `s3-objects` was wrong (the `s3` getter is a raw `S3Client`; see
[ADR-0033](../../adr/0033-aws-s3-operations-wrapper.md)). This page assumes
that wrapper is already merged.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam (never `process.env`). Resolution order is CLI > JSON > YAML >
env/.env > preset > default.

| Parameter      | Type     | Default   | Validation                                                    | Description                                                                                                                                  |
| -------------- | -------- | --------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`  | `STRING` | _(req.)_  | non-empty                                                     | AWS named profile; declaring this parameter triggers the `script.aws` provisioning seam (`AWS_PROFILE_PARAM_NAME`).                          |
| `operation`    | `STRING` | _(req.)_  | `oneOf(list, describe, get, put, copy, delete, delete-batch)` | Which of the seven operations this run performs.                                                                                             |
| `bucket`       | `STRING` | _(req.)_  | non-empty                                                     | Target bucket for every operation — also `copy`'s destination bucket.                                                                        |
| `key`          | `STRING` | _(unset)_ | non-empty when set                                            | Target object key for `describe`/`get`/`put`/`delete`, **and reused as `copy`'s destination key**.                                           |
| `prefix`       | `STRING` | _(unset)_ | non-empty when set                                            | Restrict `list` to keys beginning with this prefix.                                                                                          |
| `pageSize`     | `INT`    | _(unset)_ | `range(1, 1_000)`                                             | Page size (`MaxKeys`) for `list`; the SDK's own default (1000) applies when unset.                                                           |
| `sourceBucket` | `STRING` | _(unset)_ | non-empty when set                                            | Source bucket for `copy`.                                                                                                                    |
| `sourceKey`    | `STRING` | _(unset)_ | non-empty when set                                            | Source key for `copy`.                                                                                                                       |
| `contentType`  | `STRING` | _(unset)_ | non-empty when set                                            | `Content-Type` for `put`.                                                                                                                    |
| `input`        | `STRING` | _(unset)_ | non-empty when set                                            | Source file, resolved under `M3L_INPUT_DIR`: `put`'s object body (raw bytes), or `delete-batch`'s key list (JSONL `{"key": "..."}` records). |
| `output`       | `STRING` | _(unset)_ | non-empty when set                                            | Destination file, resolved under `M3L_OUTPUT_DIR`: `list`'s JSONL object summaries, `describe`'s JSON metadata, or `get`'s raw body bytes.   |
| `yes`          | `BOOL`   | `false`   | —                                                             | Bypass the destructive-operation confirmation prompt for `put`/`copy`/`delete`/`delete-batch` (bypass is logged as a warning).               |

`operation`, `bucket`, and `aws.profile` are declared `required: true` with
`Core.M3LConfigValidators.nonEmpty`/`oneOf`, so presence is enforced by the
library at **config-load time**. The remaining per-operation requirements
(e.g. `key` for `describe`, `input` for `put`) are **cross-parameter**
constraints the per-parameter validators cannot express, so they stay guards
at **run start** (top of `run-s3-objects`), the same pattern as
`dynamodb-crud`'s per-operation guard table (F1b backlog item).

| Operation      | Requires                                         |
| -------------- | ------------------------------------------------ |
| `list`         | `output`                                         |
| `describe`     | `key`, `output`                                  |
| `get`          | `key`, `output`                                  |
| `put`          | `key`, `input`                                   |
| `copy`         | `key` (destination), `sourceBucket`, `sourceKey` |
| `delete`       | `key`                                            |
| `delete-batch` | `input`                                          |

## Behavioral contract

Decisions that pin down what an implementer or test-author would otherwise
have to guess:

- **Run summary.** Every dispatch path returns
  `{ processed: number, failed: number }`. `processed` counts: total object
  summaries listed (`list`), `1` per invocation for `describe`/`get`/`put`/
  `copy`/`delete` regardless of hit/miss, and the confirmed-deleted count for
  `delete-batch`. `failed` is always `0` except for `delete-batch`, where it
  is the per-key failure count from `AWS.deleteObjects`'s `errors`.
- **`describe` on a missing object.** `AWS.headObject` returns `undefined` on
  the modeled not-found case (see `aws/s3`'s design choices). `describe`
  writes `JSON.stringify(metadata ?? null)` to `output`, logs a `warning`
  when `metadata` is `undefined`, and still counts `processed: 1` — a
  `describe` that confirms absence is not a failure.
- **`get` on a missing object.** `AWS.getObject` has no soft not-found path —
  it throws `M3LS3OperationError` on any rejection. `get` does not catch
  this; it propagates, failing the run.
- **`delete-batch`'s `failed.jsonl`.** Errors are collected across every
  1000-key chunk into one array, then written **once** at the end via
  `Core.M3LJSONListExporter` (overwrite semantics, not incremental
  `fs.appendFile`) — same pattern as `dynamodb-crud`'s `writeFailedRecords`.
  Each record is `{ key, message }`, carrying `AWS.deleteObjects`'s
  SDK-reported failure reason (`S3DeleteError`), not just the bare key.
- **Destructive-gate decline soft-lands.** When the operator declines the
  confirmation prompt (`destructiveGate` throws `ERR_S3_OBJECTS_ABORTED`),
  `run-s3-objects` catches that specific code, logs a `warning`, and returns
  an all-zero summary (`{ processed: 0, failed: 0 }`) — the run exits `0`,
  not as a crash. Any other error from the gate (e.g. a config error)
  propagates unmodified. This mirrors `dynamodb-crud`'s
  `ERR_DYNAMO_CRUD_ABORTED` handling, not `sqs-etl`'s.
- **Error codes.** The script's own `M3LError`s (never `aws/s3`'s
  `M3LS3OperationError`, which propagates unmodified) use this code family:
  `ERR_S3_OBJECTS_CONFIG` (missing/malformed cross-parameter requirement),
  `ERR_S3_OBJECTS_ABORTED` (destructive-gate decline),
  `ERR_S3_OBJECTS_OUTPUT` (a local read/write failure, e.g. writing
  `output`/`failed.jsonl`), and `ERR_S3_OBJECTS_FAILED_KEYS` (thrown at the
  end of a run when `delete-batch` leaves `failed > 0` — a partial batch
  failure must never be silent).

## Steps

One row per `src/steps/` module; each takes injected dependencies (config
values, the `s3` client via `script.aws`, `script.paths`, `script.prompt`,
logger) as a single options object and is unit-testable without the
`M3LScript` lifecycle.

| Step                | Responsibility                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-objects`      | `list`: paginated `AWS.listObjects`, streaming every `S3ObjectSummary` in every page to `output` as JSONL.                                                                                                                                                                                                                                                       |
| `single-object-ops` | `describe`/`get`/`put`/`copy`/`delete`: one call each via `AWS.headObject`/`getObject`/`putObject`/`copyObject`/`deleteObject`. `put`/`copy`/`delete` are destructive — the orchestrator decides whether to route them through the gate; this step never gates itself.                                                                                           |
| `delete-batch`      | `delete-batch`: reads keys from `input` (JSONL `{key}` records) via `Core.M3LJSONListImporter`, chunks into 1000-key groups (S3's own `DeleteObjects` cap), calls `AWS.deleteObjects` per chunk, aggregates `deleted`/`errors` across every chunk, and writes the collected failures once to `<output-dir>/failed.jsonl`. Destructive — routes through the gate. |
| `destructive-gate`  | Shared confirm-gate for `put`/`copy`/`delete`/`delete-batch`: prompts via `script.prompt.confirm(description)` unless `yes` is `true`, in which case the bypass is logged as a warning (fleet convention from `sqs-etl`, W5 promotion candidate).                                                                                                                |
| `run-s3-objects`    | Composes the pipeline — the only module that knows operation dispatch order: resolve + guard-check config → (destructive gate if applicable) → the operation-appropriate step → the run summary.                                                                                                                                                                 |

## Inputs and outputs

- **Reads:** `put`'s object body — the file named by `input`, resolved under
  `M3L_INPUT_DIR`, read as raw bytes. `delete-batch`'s key list — the file
  named by `input`, JSONL `{"key": "..."}` records.
- **Writes:** `list` streams every listed object summary to `output` as
  JSONL. `describe` writes the object's metadata (or `null` when not found)
  as a single JSON document to `output`. `get` writes the object's raw body
  bytes to `output`. `delete-batch` writes `<output-dir>/failed.jsonl` once,
  collecting every chunk's per-key failures (no in-script retry — retry
  policy stays the operator's concern, consistent with `aws/s3`'s own
  no-internal-retry design).
- **Reports:** a run summary — `{ processed, failed }` (see "Behavioral
  contract" above) — so a partial `delete-batch` failure is never silent; the
  run exits non-zero (`ERR_S3_OBJECTS_FAILED_KEYS`) when `failed > 0`.

## See also

- [`aws/s3`](../aws/s3.md) — the typed operations wrapper (`listObjects`/
  `headObject`/`getObject`/`putObject`/`copyObject`/`deleteObject`/
  `deleteObjects`) used throughout; the sole abstraction boundary over the AWS
  SDK commands.
- [`core/importers`](../core/importers.md) — `M3LJSONListImporter`, used by
  `delete-batch` to read its key list.
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script
  runs on.
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet
  conventions.
- [ADR-0033](../../adr/0033-aws-s3-operations-wrapper.md) — the `aws/s3`
  decision record this script consumes.
