# json-etl

JSON and NDJSON file ETL: extract fields, filter records, export to json, jsonl, csv, or html

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/json-etl.md`](../../docs/reference/scripts/json-etl.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/json-etl start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/json-etl/.env` is loaded automatically when present. Pass the
per-run configuration on the command line (or via a preset — see below):

```bash
# Extract three fields, drop archived records, sort by id, write ordered CSV.
# (STRING_ARRAY params like --fields / --filters are comma-separated.)
node dist/main.js \
  --input records.ndjson \
  --fields "id=id,name=metadata.name,status=status" \
  --filters "status ne archived" \
  --sort id:asc --limit 1000 \
  --format csv --output report.csv
```

Reads `records.ndjson` from `M3L_INPUT_DIR`, writes `report.csv` to
`M3L_OUTPUT_DIR`. Malformed JSONL lines are skipped, counted, and logged (a
malformed whole-document JSON array instead aborts the run). See the
[contract page](../../docs/reference/scripts/json-etl.md) for the full config
schema and semantics.

### Presets

`data/config/presets/report.yaml` and `report-active.yaml` (the latter
`extends: report.yaml`) are example preset files showing the parameter bundle
and the library's `extends` inheritance. Load one directly with
`Core.M3LScriptPresetLoader`. Note: `M3LScript`'s config loader currently wires
only the CLI and environment providers, so a named preset cannot yet drive a
run's config end-to-end — pass parameters on the command line as shown above.
The missing preset seam is recorded as library friction in the work log.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/json-etl/config
M3L_INPUT_DIR=<absolute-repo-path>/data/json-etl/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/json-etl/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
