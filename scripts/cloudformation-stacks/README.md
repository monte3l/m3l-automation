# cloudformation-stacks

Manage CloudFormation stacks (list, describe, create, update, delete, stack events, and lifecycle waiters) over the typed M3LCloudFormationOperations wrapper

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/cloudformation-stacks.md`](../../docs/reference/scripts/cloudformation-stacks.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/cloudformation-stacks start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/cloudformation-stacks/.env` is loaded automatically when present.

### Examples

```bash
# Minimal — list stacks
node dist/main.js --operation list-stacks --output stacks.json

# Common — describe a single stack
node dist/main.js --operation describe-stack --stackName my-stack \
  --output stack.json

# Production — create a stack from a template file, unattended, then wait
node dist/main.js --operation create-stack --input create.json \
  --template template.yaml --output created.json --yes
node dist/main.js --operation wait-stack-create-complete \
  --stackName my-stack --maxWaitTime 900 --output wait-result.json

# Edge case — delete without --yes: the default interactive prompt
node dist/main.js --operation delete-stack --stackName decommissioned-stack
```

`create.json` carries the `M3LCloudFormationCreateStackInput` fields
(`stackName`, `parameters`, `capabilities`, `roleArn`, `tags`, etc.) —
`stackName` lives inside this file, not as a CLI flag, for `create-stack`/
`update-stack`; `update.json` carries `M3LCloudFormationUpdateStackInput`
instead. `--template` is optional: when set and the input file sets neither
`templateBody` nor `templateUrl`, its contents become `templateBody`.

### Operations at a glance

| Operation                                                                                           | Demonstrated by                                                                  |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `list-stacks`                                                                                       | Minimal                                                                          |
| `describe-stack`                                                                                    | Common                                                                           |
| `create-stack`                                                                                      | Production                                                                       |
| `wait-stack-create-complete`                                                                        | Production                                                                       |
| `delete-stack`                                                                                      | Edge case                                                                        |
| `describe-stack-events`, `update-stack`, `wait-stack-update-complete`, `wait-stack-delete-complete` | — see the [contract page](../../docs/reference/scripts/cloudformation-stacks.md) |

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
M3L_CONFIG_DIR=<absolute-repo-path>/data/cloudformation-stacks/config
M3L_INPUT_DIR=<absolute-repo-path>/data/cloudformation-stacks/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/cloudformation-stacks/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
