# lambda-ops

Manage AWS Lambda functions: list, describe, create, update, delete, and invoke

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/lambda-ops.md`](../../docs/reference/scripts/lambda-ops.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/lambda-ops start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/lambda-ops/.env` is loaded automatically when present.

### Examples

```bash
# Minimal — list functions in the account/region
node dist/main.js --operation list --output functions.json

# Common — invoke a function with a JSON payload
# (invoke is confirm-gated too, not just create/update/delete)
node dist/main.js --operation invoke --functionName my-function \
  --input payload.json --output result.json

# Production — create a function from a zip + config, unattended
node dist/main.js --operation create --functionName orders-processor \
  --zipFilePath dist/orders-processor.zip --input function-def.json \
  --output orders-processor.json --yes

# Edge case — delete without --yes: the default interactive prompt
node dist/main.js --operation delete --functionName decommissioned-worker
```

`function-def.json` must carry at least `runtime`, `role`, and `handler` for
`create` — those three fields are guard-checked present before the call.

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

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/lambda-ops/config
M3L_INPUT_DIR=<absolute-repo-path>/data/lambda-ops/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/lambda-ops/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
