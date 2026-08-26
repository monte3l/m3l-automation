# ecs-ops

Manage AWS ECS services (list, describe, create, update, delete, wait-for-stable) and inspect clusters (read-only), over the typed M3LECSOperations wrapper

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/ecs-ops.md`](../../docs/reference/scripts/ecs-ops.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/ecs-ops start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/ecs-ops/.env` is loaded automatically when present.

### Examples

```bash
# Minimal — list services in a cluster
node dist/main.js --operation list-services --cluster my-cluster \
  --output services.json

# Common — describe a single service
node dist/main.js --operation describe-service --cluster my-cluster \
  --service my-service --output service.json

# Production — update desired count + wait for stability, unattended
node dist/main.js --operation update-service --cluster my-cluster \
  --input update.json --output updated.json --yes
node dist/main.js --operation wait-services-stable --cluster my-cluster \
  --services my-service --maxWaitTime 900 --output wait-result.json

# Edge case — delete without --yes: the default interactive prompt
node dist/main.js --operation delete-service --cluster my-cluster \
  --service decommissioned-service
```

`update.json` carries the `M3LECSUpdateServiceInput` fields (e.g.
`desiredCount`, `taskDefinition`, `forceNewDeployment`); `create-service`'s
`input` file carries `M3LECSCreateServiceInput` instead (requires an
already-registered task definition — this script does not register one).

### Operations at a glance

| Operation              | Description                                                                  | Demonstrated by |
| ---------------------- | ---------------------------------------------------------------------------- | --------------- |
| `list-services`        | List a cluster's services, one page per call.                                | Minimal         |
| `describe-service`     | Describe one service in a cluster.                                           | Common          |
| `create-service`       | Create a service from a JSON input document.                                 | —               |
| `update-service`       | Update an existing service from a JSON input document.                       | Production      |
| `delete-service`       | Delete a service, optionally forcing deletion without scaling to zero first. | Edge case       |
| `wait-services-stable` | Wait until the named services reach a stable state.                          | Production      |
| `list-clusters`        | List the account's ECS clusters, one page per call.                          | —               |
| `describe-cluster`     | Describe one cluster.                                                        | —               |

A `—` in **Demonstrated by** means the operation has no worked example in
§ Examples above — see the [contract page](../../docs/reference/scripts/ecs-ops.md) for its full
contract. Descriptions are the same strings the script declares in
`src/config.ts` and renders under `--help` (ADR-0055).

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
AWS_PROFILE=my-sso-profile
M3L_CONFIG_DIR=<absolute-repo-path>/data/ecs-ops/config
M3L_INPUT_DIR=<absolute-repo-path>/data/ecs-ops/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/ecs-ops/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
