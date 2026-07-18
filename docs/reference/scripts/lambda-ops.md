# lambda-ops

Manage AWS Lambda functions: list, describe, create, update, delete, and invoke

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/lambda-ops/README.md`](../../../scripts/lambda-ops/README.md).

## Purpose and scope

Control-plane CRUD over AWS Lambda (roadmap W3): `list`/`describe`/`create`/
`update`/`delete` plus the Lambda-specific `invoke` verb, dispatched over the
library's existing `lambda` getter — never a hand-constructed
`@aws-sdk/client-lambda` client (ADR-0029). Mutating operations
(`create`/`update`/`delete`/`invoke` against non-dry-run targets) are gated
behind the shared destructive-operation confirmation convention used by the
other W2/W3 scripts.

Out of scope: function _code_ deployment/packaging (zip/image build, layers),
event-source-mapping management, and the still-gated D4 "Lambda-invoke
wrapper" library seam — this script calls the existing getter directly, it
does not add a new library wrapper.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness (the "Required for" column) is **not**
expressed by `M3LConfigParameter({ required: true })` beyond `operation` itself
— the library has no cross-parameter/conditional-required seam yet (F1b,
deferred). Every parameter besides `aws.profile`/`operation` is declared
optional, and `run-lambda-ops.ts` guard-checks presence per operation before
any AWS call (mirroring `api-gateway-client`'s per-command guard).

| Parameter      | Type     | Default | Validation                                                                                           | Required for                                            | Description                                                                                                                                                                                                                                      |
| -------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws.profile`  | `STRING` | —       | `required: true`, `nonEmpty`                                                                         | all                                                     | AWS profile name; declaring it enables the `script.aws` dynamic-provisioning seam (`Core.AWS_PROFILE_PARAM_NAME`)                                                                                                                                |
| `operation`    | `STRING` | —       | `required: true`, `oneOf(list, describe, invoke, create, update-code, update-configuration, delete)` | all                                                     | Selects which of the 7 `M3LLambdaOperations` methods this run dispatches                                                                                                                                                                         |
| `functionName` | `STRING` | —       | `nonEmpty` (guard-checked)                                                                           | all except `list`                                       | The target function's name or ARN                                                                                                                                                                                                                |
| `marker`       | `STRING` | —       | `nonEmpty` (guard-checked)                                                                           | `list` (optional)                                       | Continuation token from a previous page's `nextMarker`, forwarded to `listFunctions({ marker })`                                                                                                                                                 |
| `zipFilePath`  | `STRING` | —       | `nonEmpty` (guard-checked)                                                                           | `create`, `update-code`                                 | Path to a deployment-package zip, resolved via `M3LPaths.resolveInput` and read as raw bytes for the SDK's `zipFile: Uint8Array` field. No packaging/build happens here — the zip must already exist                                             |
| `input`        | `STRING` | —       | `nonEmpty` (guard-checked)                                                                           | `create`, `update-configuration`; optional for `invoke` | Path resolved via `M3LPaths.resolveInput` to a JSON file: the function-definition fields (`runtime`/`role`/`handler`/`description`/`timeout`/`memorySize`/`environment`) for `create`/`update-configuration`, or the invoke payload for `invoke` |
| `output`       | `STRING` | —       | `nonEmpty` (guard-checked)                                                                           | all (optional)                                          | Path resolved via `M3LPaths.resolveOutput`; when set, the operation's result is persisted as a single JSON document (not JSONL — these are single-item calls, never streamed)                                                                    |
| `yes`          | `BOOL`   | `false` | —                                                                                                    | any mutating operation (optional)                       | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                                                                                                                                    |

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle. `run-lambda-ops.ts` dispatches on the
resolved `operation`; every operation except `list`/`describe` routes through
`destructive-gate` first.

| Step               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-lambda-ops`   | Composition/dispatcher: resolves and guard-checks config per operation, runs `destructive-gate` for every mutating operation, dispatches to the operation-appropriate step, persists `output` when configured, and logs a run summary. For `invoke`, throws `ERR_LAMBDA_OPS_FUNCTION_ERROR` when the result's `functionError` is populated — `M3LLambdaOperations.invokeFunction` never throws for a function-level error, so this is the layer that turns a handler failure into a non-zero exit. |
| `destructive-gate` | Shared confirmation step (mirrors `api-gateway-client`'s): prints the target operation + function name, prompts via `script.prompt.confirm(description)`, and throws `ERR_LAMBDA_OPS_ABORTED` when declined; bypassed by `yes` (bypass logged as a warning so an unattended run still leaves an audit trail).                                                                                                                                                                                      |
| `read-functions`   | `list` (`listFunctions({ marker })`) and `describe` (`getFunction(functionName)`) — never gated.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `write-function`   | `create` (reads `zipFilePath` bytes + parsed `input` fields, calls `createFunction`), `update-code` (reads `zipFilePath` bytes, calls `updateFunctionCode`), `update-configuration` (parsed `input` fields, calls `updateFunctionConfiguration`), `delete` (calls `deleteFunction`, writes no output).                                                                                                                                                                                             |
| `invoke-function`  | `invoke`: reads an optional JSON payload from `input`, calls `invokeFunction(functionName, payload)`.                                                                                                                                                                                                                                                                                                                                                                                              |

Script-local error codes are plain `M3LError.code` strings (the field is an
open `string`, not a closed union — exactly like `sqs-etl`'s `ERR_SQS_ETL_*`
and `api-gateway-client`'s `ERR_API_GATEWAY_CLIENT_*`), all prefixed
`ERR_LAMBDA_OPS_`:

- `ERR_LAMBDA_OPS_CONFIG` — a guard-checked per-operation requirement was
  unmet, or `script.aws` was not provisioned despite declaring `aws.profile`.
- `ERR_LAMBDA_OPS_ABORTED` — the destructive-gate confirmation was declined.
- `ERR_LAMBDA_OPS_FUNCTION_ERROR` — `invoke` returned a populated
  `functionError` (the handler threw or timed out).
- `ERR_LAMBDA_OPS_OUTPUT` — writing the resolved `output` file failed.

## Inputs and outputs

- **Reads:** `zipFilePath` (raw bytes, for `create`/`update-code`) and `input`
  (JSON, for `create`/`update-configuration`/`invoke`), both resolved under
  `M3L_INPUT_DIR`.
- **Writes:** when `output` is configured, the single JSON result document
  (the function configuration for `list`/`describe`/`create`/`update-code`/
  `update-configuration`, or the invoke result for `invoke`) under
  `M3L_OUTPUT_DIR`. `delete` writes nothing. Omitting `output` logs the result
  instead of persisting it.
- **Reports:** a run summary (operation, function name, and — for `invoke` —
  the resolved `statusCode`) through the `correlationId`-tagged logger; `invoke`
  exits non-zero when the function itself errored (`functionError` populated),
  never silently.

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
