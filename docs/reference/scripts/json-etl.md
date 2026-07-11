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

| Parameter    | Type           | Default   | Validation                                     | Description                                                                                                                    |
| ------------ | -------------- | --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `input`      | `STRING`       | _(req.)_  | non-empty                                      | Input file name, resolved under `M3L_INPUT_DIR`. JSON array or JSONL — dispatched by the format detector.                      |
| `fields`     | `STRING_ARRAY` | _(req.)_  | non-empty                                      | Extraction specs `name=path` (e.g. `id=metadata.id`, `tags=items.*.tag`). **List order is the output column order.**           |
| `filters`    | `STRING_ARRAY` | `[]`      | —                                              | Filter rules `path op value`; ops: `eq ne contains regex gt lt exists`. A record must satisfy **every** rule.                  |
| `format`     | `STRING`       | `json`    | `oneOf(json, jsonl, csv, html)`                | Output format; selects the exporter (`M3LJSONListExporter` / `M3LCSVListExporter` / `M3LHTMLListExporter`).                    |
| `output`     | `STRING`       | _(req.)_  | non-empty                                      | Output file name, resolved under `M3L_OUTPUT_DIR`.                                                                             |
| `limit`      | `INT`          | _(unset)_ | `range(1, …)`; **required when `sort` is set** | Maximum records written. Enforced during the streamed pass; when `sort` is set, bounds the buffered set.                       |
| `sort`       | `STRING`       | _(unset)_ | `regex ^[^:]+:(asc\|desc)$`                    | `name:asc` or `name:desc` over an extracted field. The **only** buffering operation — fails config validation without `limit`. |
| `multiValue` | `STRING`       | `join`    | `oneOf(join, explode)`                         | How a multi-match (wildcard) extraction path collapses: `join` into one field, or `explode` into one record per match.         |

`sort` requiring `limit` is enforced at **run start** (an `onAfterConfigLoad`
hook / a guard at the top of `run-json-etl`), because the library's validators
are strictly per-parameter — there is no cross-parameter validator. The check
runs before any record is read, so a preset that asks to sort an unbounded
stream fails up front, not mid-stream. Required parameters (`input`, `fields`,
`output`) are likewise checked for presence at run start, since
`M3LConfigParameter` does not itself enforce required-ness.

## Steps

One row per `src/steps/` module; each takes injected dependencies (config
values, logger, paths) as a single options object and is unit-testable with
plain mocks — no `M3LScript` lifecycle. Every record-set step is an
`AsyncIterable`/async generator (O(1) memory) except where noted.

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

They are loadable with `Core.M3LScriptPresetLoader`. A named preset does not yet
drive a run's config end-to-end: `M3LScript`'s config loader wires only the CLI
and environment providers, with no seam to add the loaded preset — a library gap
recorded in the work log's friction section. Until it lands, pass parameters on
the command line.

## See also

- [`core/json`](../core/json.md) — field-path extraction (`extractAll`, wildcards).
- [`core/importers`](../core/importers.md) — `M3LJSONListImporter.importStream()`.
- [`core/exporters`](../core/exporters.md) — the JSON/CSV/HTML streaming exporters.
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on.
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions.
