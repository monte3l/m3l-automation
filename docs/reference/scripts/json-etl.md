# json-etl

JSON and NDJSON file ETL: extract fields, filter records, and export to json,
jsonl, csv, or html.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/json-etl/README.md`](../../../scripts/json-etl/README.md).

## Purpose and scope

`json-etl` reads a JSON or newline-delimited JSON (JSONL/NDJSON) file, extracts a
chosen, ordered set of fields from each record (with array-index and wildcard
paths), keeps the records that satisfy a set of filter rules, optionally sorts
and limits them, and writes the result in one of four formats. It is the
dependency-free ETL backbone of the consumer fleet: its `extract` / `filter` /
`export` steps are the pattern every later script reuses.

**In scope:** local file → local file transformation over record streams, using
the library's streaming importer/exporter and `core/json` extraction. Processing
is O(1) in memory except for `sort`, which buffers and therefore requires an
explicit `limit`. **Out of scope:** any network or AWS I/O (this script declares
no AWS profile), schema inference, and joins across files.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam (never `process.env`). Resolution order is CLI > JSON > YAML >
env/.env > preset > default.

| Parameter    | Type           | Default   | Validation                                     | Description                                                                                                                                      |
| ------------ | -------------- | --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input`      | `STRING`       | _(req.)_  | non-empty                                      | Input file name, resolved under `M3L_INPUT_DIR`. JSON array or JSONL — dispatched by the format detector.                                        |
| `fields`     | `STRING_ARRAY` | _(req.)_  | non-empty                                      | Extraction specs `name=path` (e.g. `id=metadata.id`, `tags=items.*.tag`). **List order is the output column order.**                             |
| `filters`    | `STRING_ARRAY` | `[]`      | —                                              | Filter rules `path op value`; ops: `eq ne contains regex gt lt exists`. A record must satisfy **every** rule.                                    |
| `format`     | `STRING`       | `json`    | `oneOf(json, jsonl, csv, html)`                | Output format; selects the exporter (`M3LJSONListExporter` / `M3LCSVListExporter` / `M3LHTMLListExporter`).                                      |
| `output`     | `STRING`       | _(req.)_  | non-empty                                      | Output file name, resolved under `M3L_OUTPUT_DIR`.                                                                                               |
| `limit`      | `INT`          | _(unset)_ | `range(1, …)`; **required when `sort` is set** | Maximum records written. Enforced during the streamed pass; when `sort` is set, bounds the buffered set.                                         |
| `sort`       | `STRING`       | _(unset)_ | `regex ^[^:]+:(asc\|desc)$`                    | `name:asc` or `name:desc` over an extracted field. The **only** buffering operation — requires `limit` (config-load-time cross-parameter check). |
| `multiValue` | `STRING`       | `join`    | `oneOf(join, explode)`                         | How a multi-match (wildcard) extraction path collapses: `join` into one field, or `explode` into one record per match.                           |

Required parameters (`input`, `fields`, `output`) are declared `required: true`
with `Core.M3LConfigValidators.nonEmpty`, so presence and non-emptiness are
enforced by the library at **config-load time** — a missing value throws
`M3LConfigMissingError`, an empty one `M3LConfigValidationError`, before the run
body executes.

`sort` requiring `limit`, and `sort`'s name being one of the `fields` output
columns, are **cross-parameter** constraints a single parameter's own
`validate` cannot express. Both are declared as `Core.M3LConfigSchemaValidator`s
in `config.ts` (`configValidators`, F1b) and enforced at **config-load time** —
before `main.ts`'s `runJsonEtl` is ever invoked — throwing
`Core.M3LConfigValidationError` (`ERR_CONFIG_VALIDATION`). A preset that asks to
sort an unbounded stream fails at config load, not mid-stream.

## Steps

One row per `src/steps/` **record-set pipeline** module; each takes injected
dependencies (config values, logger, paths) as a single options object and is
unit-testable with plain mocks — no `M3LScript` lifecycle. Every record-set
step is an `AsyncIterable`/async generator (O(1) memory) except where noted.
`src/steps/resolve-preset.ts` is a composition-time config helper (reads
`--preset` before `M3LScript` construction) rather than a pipeline step, so it
is not in this table — see [Presets](#presets).

| Step             | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import-records` | Stream records from `input` via `Core.M3LJSONListImporter.importStream()` (an `AsyncGenerator<unknown>`). Malformed **JSONL lines** are tolerated: the importer omits them from the stream and emits `import:error`, so the step counts skips via that event (`skipped = processed − yielded`) and reports them — never silently dropped. A malformed whole-document **JSON array** is not tolerable — it aborts the run with `ERR_IMPORT_PARSE`.     |
| `extract-fields` | Map each record's `fields` specs through W0-L1 `Core.extractAll` / `M3LJSONFieldExtractor` into an **ordered flat record** (keys in `fields` order). A multi-match path is `join`-ed or `explode`-d per `multiValue`.                                                                                                                                                                                                                                 |
| `filter-records` | Yield only records satisfying every `filters` rule; ops `eq ne contains regex gt lt exists`, numerics parsed via `Core.parseLocaleNumber`. Predicates evaluate over the raw or extracted paths.                                                                                                                                                                                                                                                       |
| `export-results` | Dispatch on `format` to the exporter **class** (JSON/JSONL → `M3LJSONListExporter`; CSV → `M3LCSVListExporter`; HTML → `M3LHTMLListExporter`) and stream via its `exportStream()` → `append()` / `close()`. CSV derives its columns from the first appended record's keys (so `extract-fields` must emit them in `fields` order); HTML uses the exporter's built-in report template with a `columns: fields` selection (no caller-supplied template). |
| `run-json-etl`   | Composes the pipeline — the **only** module that knows the order: import → extract → filter → (sort → limit) → export. Emits the run summary (records in / out / skipped) through the `ctx`-correlated logger.                                                                                                                                                                                                                                        |

`sort` and `limit` are applied inside `run-json-etl` between filter and export:
`sort` buffers up to `limit` records (the buffering operation), a bare `limit`
truncates the stream without buffering.

## Inputs and outputs

- **Reads:** the file named by `input`, resolved under `M3L_INPUT_DIR`
  (per-script isolation via `M3L_INPUT_DIR=data/json-etl/input` in `.env`).
- **Writes:** the file named by `output`, resolved under `M3L_OUTPUT_DIR`, in
  the `format`-selected encoding. Stage-9 run archival captures it as usual.
- **Reports:** a run summary line — records read, written, and skipped
  (malformed/unparseable) — so a tolerant parse never hides data loss.

## Presets

Two example presets under `data/config/presets/` document the parameter bundle
and the library's `extends` inheritance (`M3LScriptPresetLoader`):

- `report.yaml` — a CSV report with an ordered `fields` column list and a base
  set of `filters`.
- `report-active.yaml` — `extends: ./report.yaml`, overriding `filters` to a
  narrower subset (only active records) and the `output` name.

Pass one by explicit path with the `--preset` CLI flag (run instructions,
including that flag's exact invocation, live in the
[README](../../../scripts/json-etl/README.md#presets), not here).

`main.ts` resolves `--preset` (`src/steps/resolve-preset.ts`) into
`M3LScriptOptions.preset`, so the loaded preset's values drive the run at
config precedence level 6 — below CLI/env, above the declared `defaultValue`s
(see the resolution order above). There is no name-to-path resolution or
library search root: `--preset` takes the file's explicit path.

## Command module

This script has adopted the optional ADR-0054 command-module seam, so a host
(the `m3l` CLI today, an agent runtime later) can invoke it **in-process**
rather than spawning `dist/main.js` and reading an integer off a dead child.

- **`src/command.ts`** exports `commandModule: Core.M3LCommandModule`. Its
  `execute` constructs `M3LScript` and calls `Core.runScript` itself, which is
  what makes ADR-0054's parity guarantee true rather than aspirational:
  configuration resolution, lifecycle hooks, and
  `run-report.json` all still happen.
- **`src/main.ts` now delegates to `execute`** (U7): it builds `output` via
  `Core.createCommandOutput()`, `logger` via `Core.createCommandLogger()` — the
  library seam that resolves the log-level floor and this script's derived
  `secrets`, closing the gap that used to keep the two composition sites
  independent — and calls `commandModule.execute({}, { output, logger, signal:
undefined, dryRun })`. `tests/command.test.ts` is the anti-drift guard.

### Context ports honoured today

| Port             | U7 status                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `context.dryRun` | **Honoured** — forwarded as `Core.runScript`'s `dryRun`, so stages 1-5 run and the main function does not. |
| `context.output` | Accepted, not used by `execute` itself; `main.ts` builds it via `Core.createCommandOutput()`.              |
| `context.logger` | **Honoured** — forwarded straight into `M3LScriptOptions.logger`.                                          |
| `context.signal` | **Honoured** — bridged into `M3LScriptOptions.host.signal` when present.                                   |

`TParameters` stays the default `Record<string, never>`, and `execute` still
ignores its `_parameters` argument: `M3LScriptOptions.host.parameterValues`
exists as a seam (bound at precedence level 1, replacing rather than
layering over `process.argv`), but nothing here binds through it yet, so
configuration still resolves ambiently through the library's 8-level
precedence chain on both paths. Direct parameter binding is the CLI's
in-process host's job, not yet built. One consequence worth naming:
`resolvePresetOption()` reads `process.argv` too, so under a future
in-process host it would read the HOST's argv, not this script's — precisely
the ambient coupling parameter binding through `host.parameterValues` would
retire.

### Outcome to exit code

`execute` resolves an `M3LCommandOutcome` whose
`Core.mapCommandOutcomeToExitCode(...)` equals the code `Core.runScript`
already assigned to `process.exitCode` — a scheduler cannot tell the two
invocation paths apart.

| Observed end state                                                     | Outcome       | Exit code                              |
| ---------------------------------------------------------------------- | ------------- | -------------------------------------- |
| Any pipeline stage threw a cooperative abort (`ERR_OPERATION_ABORTED`) | `interrupted` | `5`                                    |
| Any pipeline stage threw anything else                                 | `failure`     | `Core.mapErrorToExitCode(error)` (1-4) |
| No throw, no recovery entries are possible (this script reports none)  | `partial`     | `6`                                    |
| No throw, `--dry-run`                                                  | `dry-run`     | `0`                                    |
| No throw, clean run                                                    | `success`     | `0`                                    |

Failures are captured through a composed `onError` hook rather than a
`try`/`catch` around the run body: the main function is stage 7 of nine, and
stages 1-6, 8 and 9 — `config-load` above all — throw outside it. `partial`
reports `script.recoveryTotal`, not `recovery.length`, because the recovery
buffer is a ring truncated at `M3L_RECOVERY_LIMIT`.

## See also

- [`core/json`](../core/json.md) — field-path extraction (`extractAll`, wildcards).
- [`core/importers`](../core/importers.md) — `M3LJSONListImporter.importStream()`.
- [`core/exporters`](../core/exporters.md) — the JSON/CSV/HTML streaming exporters.
- [`core/cli-contract`](../core/cli-contract.md) — the `M3LCommandModule` seam this script adopts.
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on.
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions.
