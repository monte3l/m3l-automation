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

```bash
# List rules on the default event bus
node dist/main.js --operation list

# List, filtered by prefix, writing the result to output/rules.json
node dist/main.js --operation list --namePrefix nightly- --output rules.json

# Describe one rule
node dist/main.js --operation describe --ruleName nightly-cleanup

# Create a scheduled rule (mutating — prompts for confirmation unless --yes)
node dist/main.js --operation create --ruleName nightly-cleanup \
  --scheduleExpression "rate(1 day)" --state ENABLED \
  --description "Nightly cleanup job"

# Create with targets attached in the same call
node dist/main.js --operation create --ruleName nightly-cleanup \
  --scheduleExpression "rate(1 day)" \
  --targets '[{"id":"lambda-target","arn":"arn:aws:lambda:...:function:cleanup"}]'

# Update an existing rule's pattern (upsert — same PutRule call as create)
node dist/main.js --operation update --ruleName nightly-cleanup \
  --eventPattern '{"source":["custom.myapp"]}'

# Disable, then delete
node dist/main.js --operation disable --ruleName nightly-cleanup
node dist/main.js --operation delete --ruleName nightly-cleanup
```

Mutating operations (`create`/`update`/`delete`/`enable`/`disable`) prompt for
confirmation before dispatch — add `--yes` for unattended runs (the bypass is
logged). `list`/`describe` are never gated.

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
