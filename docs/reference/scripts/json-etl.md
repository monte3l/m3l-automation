# json-etl

JSON and NDJSON file ETL: extract fields, filter records, export to json, jsonl, csv, or html

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/json-etl/README.md`](../../../scripts/json-etl/README.md).

## Purpose and scope

<!-- What the automation does, for whom, and what is explicitly out of scope. -->

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam.

| Parameter   | Type  | Default | Validation         | Description               |
| ----------- | ----- | ------- | ------------------ | ------------------------- |
| `batchSize` | `INT` | `100`   | `range(1, 10_000)` | Items processed per batch |

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle.

| Step           | Responsibility        |
| -------------- | --------------------- |
| `run-json-etl` | <!-- what it does --> |

## Inputs and outputs

<!-- What the script reads from M3L_INPUT_DIR / config, and what it writes to
M3L_OUTPUT_DIR. -->

## See also

- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
