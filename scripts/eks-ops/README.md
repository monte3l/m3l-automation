# eks-ops

Operate EKS clusters and nodegroups: list, describe, create, update, delete, and wait for lifecycle transitions

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/eks-ops.md`](../../docs/reference/scripts/eks-ops.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/eks-ops start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/eks-ops/.env` is loaded automatically when present.

### Examples

```bash
# Minimal — list clusters
node dist/main.js --operation list-clusters --output clusters.json

# Common — describe a nodegroup
node dist/main.js --operation describe-nodegroup --cluster prod-eks \
  --nodegroup workers-a --output nodegroup.json

# Production — bump a nodegroup's release version + wait for active, unattended
node dist/main.js --operation update-nodegroup-version --cluster prod-eks \
  --nodegroup workers-a --releaseVersion 1.29.3-20260615 --yes \
  --output updated.json
node dist/main.js --operation wait-nodegroup-active --cluster prod-eks \
  --nodegroup workers-a --maxWaitTime 1800 --output wait-result.json

# Edge case — delete without --yes: the default interactive prompt
node dist/main.js --operation delete-nodegroup --cluster prod-eks \
  --nodegroup decommissioned-workers
```

`input` (required only for `create-cluster`/`update-cluster-config`/
`create-nodegroup`/`update-nodegroup-config`) resolves to a JSON file carrying
the operation's mutable payload fields — `M3LEKSCreateClusterInput`,
`M3LEKSUpdateClusterConfigInput`, `M3LEKSCreateNodegroupInput`, or
`M3LEKSUpdateNodegroupConfigInput` — never the resource identity, which always
comes from `cluster`/`nodegroup`. `update-nodegroup-version` above needs no
`input` file: it takes `kubernetesVersion`/`releaseVersion` directly.

### Operations at a glance

| Operation                                                                                                                                                                                                                                            | Demonstrated by                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `list-clusters`                                                                                                                                                                                                                                      | Minimal                                                            |
| `describe-nodegroup`                                                                                                                                                                                                                                 | Common                                                             |
| `update-nodegroup-version`                                                                                                                                                                                                                           | Production                                                         |
| `wait-nodegroup-active`                                                                                                                                                                                                                              | Production                                                         |
| `delete-nodegroup`                                                                                                                                                                                                                                   | Edge case                                                          |
| `describe-cluster`, `create-cluster`, `update-cluster-config`, `update-cluster-version`, `delete-cluster`, `wait-cluster-active`, `wait-cluster-deleted`, `list-nodegroups`, `create-nodegroup`, `update-nodegroup-config`, `wait-nodegroup-deleted` | — see the [contract page](../../docs/reference/scripts/eks-ops.md) |

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
M3L_CONFIG_DIR=<absolute-repo-path>/data/eks-ops/config
M3L_INPUT_DIR=<absolute-repo-path>/data/eks-ops/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/eks-ops/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
