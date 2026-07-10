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
`scripts/json-etl/.env` is loaded automatically when present.

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
