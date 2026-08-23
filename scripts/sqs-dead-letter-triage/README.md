# sqs-dead-letter-triage

Triage and remediate messages stranded in SQS dead-letter queues against codified runbook presets

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/sqs-dead-letter-triage.md`](../../docs/reference/scripts/sqs-dead-letter-triage.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # library first (turbo orders it)
pnpm --filter @m3l-automation/sqs-dead-letter-triage start
```

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/sqs-dead-letter-triage/.env` is loaded automatically when present.

### Examples

```bash
# Minimal — validate every preset in the runbook directory. Offline: no AWS
# calls, no credentials. This is the form CI runs as a gate.
node dist/main.js --operation=validate

# Common — validate a preset directory kept outside the repo, where operators
# actually maintain their runbooks.
M3L_INPUT_DIR=~/ops/dlq-runbooks node dist/main.js \
  --operation=validate --runbookDir=presets

# Production — print the compiled nine-step graph, every case in priority
# order, the mandatory fallback, and the digest for one queue. Use this to
# review what a preset will actually do before trusting it.
node dist/main.js --operation=explain --queue=orders-dlq

# Edge case — convert a prose runbook into a preset skeleton. Gaps it cannot
# derive are recorded as todos, and a non-empty todos list makes validate
# fail: the skeleton is deliberately not runnable until a human closes them.
node dist/main.js --operation=convert --source=runbooks/orders-dlq.md
```

> **Not yet available.** The AWS-facing `triage` and `execute` operations —
> draining a queue, reaching a verdict per message, and applying remediation
> behind the destructive gate — are not implemented in this slice. Every
> example above is offline and read-only apart from `convert`, which writes a
> skeleton to `M3L_OUTPUT_DIR`.

### Operations at a glance

| Operation  | Demonstrated by |
| ---------- | --------------- |
| `validate` | Minimal, Common |
| `explain`  | Production      |
| `convert`  | Edge case       |

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
M3L_CONFIG_DIR=<absolute-repo-path>/data/sqs-dead-letter-triage/config
M3L_INPUT_DIR=<absolute-repo-path>/data/sqs-dead-letter-triage/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/sqs-dead-letter-triage/output
```

## Data directories

| Directory | Purpose                                        |
| --------- | ---------------------------------------------- |
| `config/` | Presets / config files passed by explicit path |
| `input/`  | Files the script consumes                      |
| `output/` | Run results and archived inputs/configs        |
