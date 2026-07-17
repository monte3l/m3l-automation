# api-gateway-client

Invoke HTTP APIs fronted by AWS API Gateway (`execute-api`) — single request or
bounded-concurrency batch, with `none` / `api-key` / `iam` (SigV4) auth.

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/api-gateway-client.md`](../../docs/reference/scripts/api-gateway-client.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/api-gateway-client start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/api-gateway-client/.env` is loaded automatically when present. The
`command` config parameter selects the mode and `auth` selects the auth scheme;
see the [contract page](../../docs/reference/scripts/api-gateway-client.md) for
the full config schema.

```bash
# Single GET, no auth
node dist/main.js --command request --auth none \
  --baseUrl "$API_BASE_URL" --method GET --path /health

# Single POST with an API key (the key comes from .env API_GATEWAY_API_KEY,
# never a CLI flag — mutating verb, so it prompts unless --yes)
node dist/main.js --command request --auth api-key \
  --baseUrl "$API_BASE_URL" --method POST --path /items \
  --body '{"name":"widget"}'

# Single GET with IAM (SigV4) auth — requires AWS_PROFILE in .env
node dist/main.js --command request --auth iam \
  --baseUrl "$API_BASE_URL" --method GET --path /secure/ping

# Batch: fan a JSONL file of { path, body? } records through the template
# (uniform method), bounded to 8 in flight; responses + failed.jsonl to output
node dist/main.js --command batch --auth iam \
  --baseUrl "$API_BASE_URL" --method POST \
  --input requests.jsonl --output responses.jsonl --maxInFlight 8
```

Mutating verbs (`POST`/`PUT`/`PATCH`/`DELETE`) prompt for confirmation before
dispatch — add `--yes` for unattended runs (the bypass is logged). `GET`/`HEAD`
are never gated.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

- `AWS_PROFILE` — required **only** for `auth: iam` (the profile the
  `aws.profile` config parameter resolves to; SigV4 credentials resolve via
  `fromIni`). Unused for `auth: none`/`api-key`.
- `API_GATEWAY_API_KEY` — required **only** for `auth: api-key`; the API Gateway
  API key. It is a **secret** — supply it here, never as a CLI flag. The
  `apiKey` config parameter (alias `api-gateway-api-key`) resolves this env var;
  the library has no automatic redaction, so the script never logs it.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
# auth: iam only
AWS_PROFILE=my-sso-profile

# auth: api-key only (secret — never a CLI flag)
API_GATEWAY_API_KEY=<your-api-gateway-api-key>

M3L_CONFIG_DIR=<absolute-repo-path>/data/api-gateway-client/config
M3L_INPUT_DIR=<absolute-repo-path>/data/api-gateway-client/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/api-gateway-client/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
