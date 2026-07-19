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

```bash
# Run a query against a named database, CSV output.
node dist/main.js \
  --aws.profile my-sso-profile \
  --queryString "SELECT * FROM orders WHERE order_date >= DATE '2026-07-01'" \
  --database analytics \
  --outputLocation s3://my-athena-results-bucket/query-results/ \
  --format csv --output orders.csv
```

Writes `orders.csv` to `M3L_OUTPUT_DIR`, plus an `orders.csv.checkpoint.json`
sidecar that's deleted automatically once the run completes successfully. If
the process is interrupted while the query is still running (or the query
itself fails), re-invoke the **exact same command** with `--resume true`
appended to reattach to the in-flight query instead of re-issuing it:

```bash
node dist/main.js \
  --aws.profile my-sso-profile \
  --queryString "SELECT * FROM orders WHERE order_date >= DATE '2026-07-01'" \
  --database analytics \
  --outputLocation s3://my-athena-results-bucket/query-results/ \
  --format csv --output orders.csv \
  --resume true
```

See the [contract page](../../docs/reference/scripts/athena-query.md) for the
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
