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

### Examples

```bash
# Minimal — drain a queue to JSONL (non-destructive)
node dist/main.js --command dump --queueUrl "$QUEUE_URL" --output dump.jsonl

# Common — batch-publish JSONL records to a queue
node dist/main.js --command send --queueUrl "$QUEUE_URL" --input records.jsonl

# Production — redrive a DLQ back to its source, tuned batch size, unattended
node dist/main.js --command redrive --queueUrl "$QUEUE_URL" \
  --dlqUrl "$DLQ_URL" --batchSize 500 --yes

# Edge case — purge a queue entirely; SQS enforces a 60s cooldown between
# purges on the same queue, so a rapid retry fails with PurgeQueueInProgress
node dist/main.js --command purge --queueUrl "$QUEUE_URL"
```

`delete` (by receipt handle) shares `redrive`'s destructive-gate shape;
`transform`'s `--fields`/`--filters` grammar is the same one taught in
[json-etl's examples](../json-etl/README.md#examples) — it maps/filters a
JSONL file locally, with no SQS calls. Every command still requires
`aws.profile` (`AWS_PROFILE` in `.env`), even `transform`, since it never
skips AWS provisioning — see the contract page's "Out of scope for this
iteration" note.

### Operational flags

Every script composes through `Core.runScript` (ADR-0035), so these work uniformly:

- `--dry-run` — validate environment, configuration, and AWS credentials
  (pipeline stages 1–5) without running the script: `node dist/main.js --dry-run`.
- `--log-level=<level>` / `--debug`, or `M3L_LOG_LEVEL=<level>` / `M3L_DEBUG=1` —
  set the log severity floor (`debug`/`info`/`success`/`warning`/`error`/`fatal`).
  CLI wins over env; an unknown value fails loud.
- **Exit codes** map the failure origin for schedulers: `0` success, `2`
  configuration/usage (do not retry), `3` external system (retry with backoff is
  reasonable), `4` library-internal (file a report), `5` interrupted (signal).
- Each run writes its inputs, configs, and `run-report.json` under one
  per-run `data/output/<timestamp>/` directory.

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
