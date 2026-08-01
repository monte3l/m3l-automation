# codepipeline-ops

Manage AWS CodePipeline pipelines (list, describe, create, update, delete),
inspect pipeline state and execution history, control execution (start,
stop, watch to a terminal status), and toggle stage transitions, over the
typed M3LCodePipelineOperations wrapper

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/codepipeline-ops.md`](../../docs/reference/scripts/codepipeline-ops.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/codepipeline-ops start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/codepipeline-ops/.env` is loaded automatically when present.

### Examples

```bash
# Minimal — list pipelines
node dist/main.js --operation list-pipelines --output pipelines.json

# Common — describe a pipeline and its current stage state
node dist/main.js --operation describe-pipeline --pipeline my-pipeline \
  --output pipeline.json
node dist/main.js --operation get-pipeline-state --pipeline my-pipeline \
  --output state.json

# Production — trigger a run, then watch it to a terminal status, unattended
# (the executionId below comes from start.json's own "pipelineExecutionId"
# field, written by the start-execution call just above)
node dist/main.js --operation start-execution --pipeline my-pipeline \
  --clientRequestToken my-pipeline-2026-07-27-01 --output start.json
node dist/main.js --operation watch-execution --pipeline my-pipeline \
  --executionId a1b2c3d4-5678-90ab-cdef-1234567890ab --waitMaxAttempts 120 \
  --waitIntervalSeconds 15 --output execution.json

# Edge case — update without --yes: the default interactive prompt warns
# that UpdatePipeline REPLACES the whole live declaration. --pipeline is not
# read here — the target name comes from updated-declaration.json's own
# "name" field.
node dist/main.js --operation update-pipeline \
  --input updated-declaration.json --output updated.json
```

`updated-declaration.json` must be a **complete** `M3LCodePipelineDeclaration`
(`name`, `roleArn`, `stages`, and every other field the live pipeline needs) —
never a mutated `describe-pipeline` result. See
[the contract page](../../docs/reference/scripts/codepipeline-ops.md#purpose-and-scope)
for why a partial declaration silently deletes fields from the live pipeline.

### Operations at a glance

| Operation                                                                                                                                              | Demonstrated by                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `list-pipelines`                                                                                                                                       | Minimal                                                                     |
| `describe-pipeline`                                                                                                                                    | Common                                                                      |
| `get-pipeline-state`                                                                                                                                   | Common                                                                      |
| `start-execution`                                                                                                                                      | Production                                                                  |
| `watch-execution`                                                                                                                                      | Production                                                                  |
| `update-pipeline`                                                                                                                                      | Edge case                                                                   |
| `list-executions`, `describe-execution`, `create-pipeline`, `delete-pipeline`, `stop-execution`, `enable-stage-transition`, `disable-stage-transition` | — see the [contract page](../../docs/reference/scripts/codepipeline-ops.md) |

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
M3L_CONFIG_DIR=<absolute-repo-path>/data/codepipeline-ops/config
M3L_INPUT_DIR=<absolute-repo-path>/data/codepipeline-ops/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/codepipeline-ops/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
