# athena-query

Run a single Amazon Athena query and export its results to JSON or CSV, with checkpointed resume

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/athena-query.md`](../../docs/reference/scripts/athena-query.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/athena-query start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/athena-query/.env` is loaded automatically when present. Pass the
per-run configuration on the command line:

### Examples

```bash
# Minimal — run a query, default JSON output
node dist/main.js \
  --aws.profile my-sso-profile \
  --queryString "SELECT * FROM orders LIMIT 10" \
  --output preview.json

# Common — named database, S3 results location, CSV output
node dist/main.js \
  --aws.profile my-sso-profile \
  --queryString "SELECT * FROM orders WHERE order_date >= DATE '2026-07-01'" \
  --database analytics \
  --outputLocation s3://my-athena-results-bucket/query-results/ \
  --format csv --output orders.csv

# Production — parameterized query against a dedicated workgroup/catalog
node dist/main.js \
  --aws.profile my-sso-profile \
  --queryString "SELECT * FROM orders WHERE region = ? AND status = ?" \
  --database analytics --catalog AwsDataCatalog --workGroup analytics-batch \
  --executionParameters "us-east-1,shipped" \
  --outputLocation s3://my-athena-results-bucket/query-results/ \
  --format csv --output orders.csv

# Edge case — reattach to the production run above after it was interrupted
# (re-invoke the exact same command with --resume true appended)
node dist/main.js \
  --aws.profile my-sso-profile \
  --queryString "SELECT * FROM orders WHERE region = ? AND status = ?" \
  --database analytics --catalog AwsDataCatalog --workGroup analytics-batch \
  --executionParameters "us-east-1,shipped" \
  --outputLocation s3://my-athena-results-bucket/query-results/ \
  --format csv --output orders.csv \
  --resume true
```

Writes the output file to `M3L_OUTPUT_DIR`, plus a `<output>.checkpoint.json`
sidecar that's deleted automatically once the run completes successfully. See
the [contract page](../../docs/reference/scripts/athena-query.md) for the
full config schema and resume/failure semantics.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

This script touches AWS (Athena). Set `AWS_PROFILE` (config parameter
`aws.profile`) to the local profile to run under; declaring that parameter is
what triggers the library's `script.aws` provisioning seam.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/athena-query/config
M3L_INPUT_DIR=<absolute-repo-path>/data/athena-query/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/athena-query/output
```

## Data directories

| Directory | Purpose                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `config/` | Presets / config files passed by explicit path                          |
| `input/`  | Unused — this script's only input is the Athena query API               |
| `output/` | Run results, the `.checkpoint.json` resume sidecar, and archived config |
