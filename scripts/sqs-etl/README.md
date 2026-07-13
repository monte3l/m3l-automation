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
`scripts/sqs-etl/.env` is loaded automatically when present. The `command`
config parameter selects the operation; see the
[contract page](../../docs/reference/scripts/sqs-etl.md) for the full
per-command config schema.

```bash
# Drain a queue to JSONL (non-destructive; add --deleteAfterDump to drain-and-delete)
node dist/main.js --command dump --queueUrl "$QUEUE_URL" --output dump.jsonl

# Batch-publish JSONL records to a queue
node dist/main.js --command send --queueUrl "$QUEUE_URL" --input records.jsonl

# Move messages from a DLQ back to their source queue (destructive — prompts
# for confirmation unless --yes)
node dist/main.js --command redrive --queueUrl "$QUEUE_URL" --dlqUrl "$DLQ_URL"

# Delete specific messages by receipt handle (destructive)
node dist/main.js --command delete --queueUrl "$QUEUE_URL" --input to-delete.jsonl

# Clear a queue entirely (destructive; SQS enforces a 60s cooldown between purges)
node dist/main.js --command purge --queueUrl "$QUEUE_URL"

# Map/filter a JSONL file locally — no SQS calls
node dist/main.js --command transform \
  --input dump.jsonl --output filtered.jsonl \
  --fields "id=messageId,body=body" --filters "body contains error"
```

Every command still requires `aws.profile` (`AWS_PROFILE` in `.env`), even
`transform`, since it never skips AWS provisioning — see the contract page's
"Out of scope for this iteration" note.

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
