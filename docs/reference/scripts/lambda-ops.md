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

> **Scaffold status:** this page currently reflects the scaffolded contract
> seam. The concrete per-operation configuration parameters and the `steps/`
> decomposition are designed by the `implementing-scripts` TDD pipeline; this
> table will grow an `operation` parameter (and its per-operation siblings)
> once that lands.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam.

| Parameter     | Type     | Default | Validation             | Description                                                                                                                                                              |
| ------------- | -------- | ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws.profile` | `STRING` | —       | `nonEmpty`, `required` | AWS profile name; enables the `script.aws` dynamic-provisioning seam (`Core.AWS_PROFILE_PARAM_NAME`)                                                                     |
| `batchSize`   | `INT`    | `100`   | `range(1, 10_000)`     | Starter placeholder from the scaffold template; superseded once the real per-operation parameters (`operation`, `functionName`, etc.) are declared during implementation |

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle.

| Step             | Responsibility                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `run-lambda-ops` | Starter placeholder (logs and returns) pending the real operation-dispatch implementation. |

## Inputs and outputs

Pending implementation. Expected shape, matching the W2/W3 scripts already
shipped: `list`/`describe` write JSON/CSV to `M3L_OUTPUT_DIR`; `create`/
`update` read a function definition from `M3L_INPUT_DIR` or an explicit config
path; `invoke` reads a payload from `M3L_INPUT_DIR` and writes the Lambda
response to `M3L_OUTPUT_DIR`; `delete` reads only a `functionName`/`operation`
pair from config.

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
