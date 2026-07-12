# sqs-etl

SQS message ETL: dump, send, redrive, delete, purge, and transform

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/sqs-etl.md`](../../docs/reference/scripts/sqs-etl.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/sqs-etl start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/sqs-etl/.env` is loaded automatically when present.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

This script touches AWS (SQS): set `AWS_PROFILE` (the config resolution order
is CLI > JSON > YAML > env/.env > preset > default) to the profile the
`aws.profile` config parameter should resolve to. It is a required parameter —
the script throws `M3LConfigMissingError` at startup if unresolved.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/sqs-etl/config
M3L_INPUT_DIR=<absolute-repo-path>/data/sqs-etl/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/sqs-etl/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
