# cloudwatch-logs-analysis

Analyze CloudWatch alarm evidence with a codified runbook procedure and produce an operator verdict

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/cloudwatch-logs-analysis.md`](../../docs/reference/scripts/cloudwatch-logs-analysis.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/cloudwatch-logs-analysis start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/cloudwatch-logs-analysis/.env` is loaded automatically when present.

### Examples

<!-- Add examples here — at least 3, labelled in-fence, spanning read-only →
     mutating → destructive/interactive. Scale the count to the script's
     operation count and complexity. See docs/contributing/script-docs-structure.md. -->

```bash
# Minimal — <describe what the simplest case shows>
node dist/main.js ...

# Common — <describe the most frequently reached case>
node dist/main.js ...

# Production — <describe a tuned, unattended run>
node dist/main.js ...

# Edge case — <describe a rare or destructive path and any caveats>
node dist/main.js ...
```

### Operations at a glance

<!-- Delete this section for single-purpose scripts with only one operation.
     For multi-operation scripts, list every operation and which example covers it.
     Column header must be "Operation" (not "Command" or "Mode"). -->

| Operation | Demonstrated by |
| --------- | --------------- |
| `example` | Minimal         |

### Operational flags

Every script composes through `Core.runScript` (ADR-0035), so these work uniformly:

- `--dry-run` — validate environment and configuration without running the
  script: `node dist/main.js --dry-run`.
- `--log-level=<level>` / `--debug`, or `M3L_LOG_LEVEL=<level>` / `M3L_DEBUG=1` —
  set the log severity floor (`debug`/`info`/`success`/`warning`/`error`/`fatal`).
  CLI wins over env; an unknown value fails loud.
- **Exit codes** map the failure origin: `0` success, `2` config/validation, `3`
  script-local error, `4` unhandled/unexpected. A non-zero exit always accompanies
  a logged error.

## Environment (`.env`)

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
M3L_CONFIG_DIR=<absolute-repo-path>/data/cloudwatch-logs-analysis/config
M3L_INPUT_DIR=<absolute-repo-path>/data/cloudwatch-logs-analysis/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/cloudwatch-logs-analysis/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
