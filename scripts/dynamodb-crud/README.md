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

### Examples

```bash
# Minimal — fetch one item by its primary key
node dist/main.js --operation get --tableName orders \
  --key '{"orderId":"A-100"}' --output item.json

# Common — merge-patch one field into an existing item
# (destructive: this operation always prompts for confirmation —
# dynamodb-crud has no --yes bypass for any operation)
node dist/main.js --operation update --tableName orders \
  --key '{"orderId":"A-100"}' --item '{"status":"shipped"}' \
  --output result.json

# Production — parallel segmented export at scale, tuned for RCUs
node dist/main.js --operation export --tableName orders \
  --totalSegments 8 --batchSize 500 --maxInFlightBatches 8 \
  --maxPagesPerSecond 20 --checkpointEveryPages 10 \
  --runName orders-export --output orders-export.jsonl

# Edge case — resume the export above after it was killed mid-run
# (same --runName reattaches the checkpoint; resume only covers the
# read side — scan/query/export — not batch-write/batch-delete/import)
node dist/main.js --operation export --tableName orders \
  --totalSegments 8 --batchSize 500 --maxInFlightBatches 8 \
  --maxPagesPerSecond 20 --checkpointEveryPages 10 \
  --runName orders-export --output orders-export.jsonl --resume true
```

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
