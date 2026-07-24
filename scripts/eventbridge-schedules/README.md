# eventbridge-schedules

Manage EventBridge rules (list, describe, create, update, delete, enable, disable) via M3LEventBridgeOperations.

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/eventbridge-schedules.md`](../../docs/reference/scripts/eventbridge-schedules.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/eventbridge-schedules start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/eventbridge-schedules/.env` is loaded automatically when present. The
`operation` config parameter selects the verb; see the
[contract page](../../docs/reference/scripts/eventbridge-schedules.md) for the
full config schema.

### Examples

```bash
# Minimal — list rules on the default event bus
node dist/main.js --operation list

# Common — describe one rule, writing detail to output/rule.json
node dist/main.js --operation describe --ruleName nightly-cleanup \
  --output rule.json

# Production — create a scheduled rule with targets attached in one call
node dist/main.js --operation create --ruleName nightly-cleanup \
  --scheduleExpression "rate(1 day)" --state ENABLED \
  --description "Nightly cleanup job" \
  --targets '[{"id":"lambda-target","arn":"arn:aws:lambda:...:function:cleanup"}]'

# Edge case — delete an AWS-managed rule (requires --force) unattended (--yes)
node dist/main.js --operation delete --ruleName legacy-rule --force --yes
```

`update`/`enable`/`disable` share `create`'s/`delete`'s shape (`update` takes
the same fields as `create` — EventBridge's own `PutRule` upsert semantics —
and `enable`/`disable` take only `--ruleName`). Mutating operations
(`create`/`update`/`delete`/`enable`/`disable`) prompt for confirmation before
dispatch — add `--yes` for unattended runs (the bypass is logged). `list`/
`describe` are never gated.

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

- `AWS_PROFILE` — required; the profile the `aws.profile` config parameter
  resolves to, provisioning `script.aws.clients.eventBridgeOperations`.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
AWS_PROFILE=my-sso-profile

M3L_CONFIG_DIR=<absolute-repo-path>/data/eventbridge-schedules/config
M3L_INPUT_DIR=<absolute-repo-path>/data/eventbridge-schedules/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/eventbridge-schedules/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
