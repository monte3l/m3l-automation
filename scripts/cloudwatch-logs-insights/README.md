# cloudwatch-logs-insights

Run CloudWatch Logs Insights queries and export results, splitting by time window for the 10k-row cap

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/cloudwatch-logs-insights.md`](../../docs/reference/scripts/cloudwatch-logs-insights.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/cloudwatch-logs-insights start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/cloudwatch-logs-insights/.env` is loaded automatically when present. Pass the
per-run configuration on the command line:

### Examples

```bash
# Minimal — one log group, default 60-minute window, default JSON output
node dist/main.js \
  --aws.profile my-sso-profile \
  --logGroups "/aws/lambda/checkout" \
  --query 'fields @timestamp, @message | filter @message like /ERROR/' \
  --start 2026-07-01T00:00:00Z --end 2026-07-01T01:00:00Z \
  --output errors.json

# Common — two log groups, 15-minute windows, CSV output
node dist/main.js \
  --aws.profile my-sso-profile \
  --logGroups "/aws/lambda/checkout,/aws/lambda/payments" \
  --query 'fields @timestamp, @message | filter @message like /ERROR/' \
  --start 2026-07-01T00:00:00Z --end 2026-07-01T01:00:00Z \
  --windowMinutes 15 \
  --format csv --output errors.csv

# Production — 24h range across three log groups, per-window row cap
node dist/main.js \
  --aws.profile my-sso-profile \
  --logGroups "/aws/lambda/checkout,/aws/lambda/payments,/aws/lambda/fulfillment" \
  --query 'fields @timestamp, @message | filter @message like /ERROR/' \
  --start 2026-07-01T00:00:00Z --end 2026-07-02T00:00:00Z \
  --windowMinutes 15 --limit 5000 \
  --format csv --output errors.csv

# Edge case — reattach to the production run above after it was interrupted
# (re-invoke the exact same command with --resume true appended)
node dist/main.js \
  --aws.profile my-sso-profile \
  --logGroups "/aws/lambda/checkout,/aws/lambda/payments,/aws/lambda/fulfillment" \
  --query 'fields @timestamp, @message | filter @message like /ERROR/' \
  --start 2026-07-01T00:00:00Z --end 2026-07-02T00:00:00Z \
  --windowMinutes 15 --limit 5000 \
  --format csv --output errors.csv \
  --resume true
```

Writes the output file to `M3L_OUTPUT_DIR`, plus a `<output>.checkpoint.json`
sidecar that's deleted automatically once the run completes successfully;
`--resume true` continues from the first incomplete window instead of
re-querying already-fetched ones. See the
[contract page](../../docs/reference/scripts/cloudwatch-logs-insights.md) for
the full config schema and resume/failure semantics.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

This script touches AWS (CloudWatch Logs Insights). Set `AWS_PROFILE` (config
parameter `aws.profile`) to the local profile to run under; declaring that
parameter is what triggers the library's `script.aws` provisioning seam.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/cloudwatch-logs-insights/config
M3L_INPUT_DIR=<absolute-repo-path>/data/cloudwatch-logs-insights/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/cloudwatch-logs-insights/output
```

## Data directories

| Directory | Purpose                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `config/` | Presets / config files passed by explicit path                          |
| `input/`  | Unused — this script's only input is the CloudWatch Logs Insights API   |
| `output/` | Run results, the `.checkpoint.json` resume sidecar, and archived config |
