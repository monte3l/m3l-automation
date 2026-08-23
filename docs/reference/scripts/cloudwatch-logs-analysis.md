# cloudwatch-logs-analysis

Analyze CloudWatch alarm evidence with a codified runbook procedure and produce an operator verdict

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/cloudwatch-logs-analysis/README.md`](../../../scripts/cloudwatch-logs-analysis/README.md).

## Purpose and scope

<!-- What the automation does, for whom, and what is explicitly out of scope.
     Fold out-of-scope content into this section's prose — do not create a
     standalone "## Out of scope" H2. -->

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam.

| Parameter   | Type  | Default | Validation         | Required for | Description               |
| ----------- | ----- | ------- | ------------------ | ------------ | ------------------------- |
| `batchSize` | `INT` | `100`   | `range(1, 10_000)` | all          | Items processed per batch |

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle.

| Step                           | Responsibility        |
| ------------------------------ | --------------------- |
| `run-cloudwatch-logs-analysis` | <!-- what it does --> |

## Error codes

<!-- List script-local M3LErrorCode values here. Omit this section only when the
     script has no script-local code family (relies entirely on Core codes such as
     ERR_CHECKPOINT_* or ERR_IMPORT_*) — in that case replace this section with a
     prose note: "This script defines no script-local error codes; see core/errors." -->

| Code      | Meaning              |
| --------- | -------------------- |
| `ERR_...` | <!-- description --> |

## Inputs and outputs

<!-- What the script reads from M3L_INPUT_DIR / config, and what it writes to
     M3L_OUTPUT_DIR. -->

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
