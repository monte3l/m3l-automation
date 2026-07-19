# s3-objects

Thin op-dispatch over the `aws/s3` typed operations wrapper: list, describe,
get, put, copy, and delete S3 objects

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/s3-objects.md`](../../docs/reference/scripts/s3-objects.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/s3-objects start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/s3-objects/.env` is loaded automatically when present. The
`operation` config parameter selects the operation; see the
[contract page](../../docs/reference/scripts/s3-objects.md) for the full
per-operation config schema.

### Examples

```bash
# Minimal — list objects under a prefix to JSONL (non-destructive)
node dist/main.js --operation list --bucket reports --prefix "2026/" \
  --output listing.jsonl

# Common — download an object's body
node dist/main.js --operation get --bucket reports \
  --key "2026/07/summary.json" --output summary.json

# Production — delete up to 1000+ objects named in a JSONL key list,
# unattended (destructive; chunks internally)
node dist/main.js --operation delete-batch --bucket reports \
  --input to-delete.jsonl --yes

# Edge case — upload without --yes: overwrites, so it prompts interactively
node dist/main.js --operation put --bucket reports \
  --key "2026/07/summary.json" --input summary.json --contentType application/json
```

`describe` (metadata-only fetch) and `copy` (within/across buckets) share
`get`'s/`put`'s single-object shape. Every operation still requires
`aws.profile` (`AWS_PROFILE` in `.env`).

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/s3-objects/config
M3L_INPUT_DIR=<absolute-repo-path>/data/s3-objects/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/s3-objects/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
