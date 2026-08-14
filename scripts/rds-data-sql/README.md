# rds-data-sql

run parameterized SQL against an Aurora PostgreSQL cluster via the RDS Data API, transactionally

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/rds-data-sql.md`](../../docs/reference/scripts/rds-data-sql.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/rds-data-sql start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/rds-data-sql/.env` is loaded automatically when present.

### Examples

```bash
# Minimal — paged SELECT streamed to a JSON file
node dist/main.js --operation=query \
  --cluster.arn=arn:aws:rds:us-east-1:123456789012:cluster:my-cluster \
  --secret.arn=arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret \
  --database=appdb --sql="SELECT id, name FROM users ORDER BY id" \
  --output.file=users.json

# Common — bulk-insert a JSONL file into a table, 500 rows per transaction
node dist/main.js --operation=load \
  --cluster.arn=arn:aws:rds:us-east-1:123456789012:cluster:my-cluster \
  --secret.arn=arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret \
  --database=appdb --table=events --input.file=events.jsonl --batch.size=500

# Production — apply pending migrations in one transaction, tracked by filename
node dist/main.js --operation=migrate \
  --cluster.arn=arn:aws:rds:us-east-1:123456789012:cluster:my-cluster \
  --secret.arn=arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret \
  --database=appdb --migrations.dir=migrations \
  --migrations.table=schema_migrations

# Edge case — non-SELECT DML in a non-interactive run (CI), bypassing the
# destructive-op confirmation prompt with --yes
node dist/main.js --operation=execute \
  --cluster.arn=arn:aws:rds:us-east-1:123456789012:cluster:my-cluster \
  --secret.arn=arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret \
  --database=appdb --sql="DELETE FROM stale_sessions WHERE expires_at < now()" \
  --yes=true
```

See the [contract page](../../docs/reference/scripts/rds-data-sql.md) for the
full parameter table (`schema`, `sql.file`, `parameters.file`, `columns`,
`page.size`, `output.format`, and the rest) and each operation's exact
behavior.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/rds-data-sql/config
M3L_INPUT_DIR=<absolute-repo-path>/data/rds-data-sql/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/rds-data-sql/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
