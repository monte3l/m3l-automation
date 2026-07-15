# dynamodb-crud

CRUD, batch, and streaming operations against a DynamoDB table with checkpoint resume and destructive-op confirmation

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/dynamodb-crud.md`](../../docs/reference/scripts/dynamodb-crud.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/dynamodb-crud start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/dynamodb-crud/.env` is loaded automatically when present.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/dynamodb-crud/config
M3L_INPUT_DIR=<absolute-repo-path>/data/dynamodb-crud/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/dynamodb-crud/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
