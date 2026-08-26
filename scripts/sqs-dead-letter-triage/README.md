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

# Mutating (locally only) — drain a dead-letter queue, reach a verdict for
# every message, and write the report. Reads from AWS and writes two
# artifacts to M3L_OUTPUT_DIR; it never deletes or re-sends a message, so the
# queue itself is left exactly as found.
node dist/main.js --operation=triage \
  --queue=orders-dlq \
  --queueUrl=https://sqs.eu-west-1.amazonaws.com/000000000000/orders-dlq \
  --aws.profile=ops-readonly

# Bounded run — cap how much of a deep queue one pass pulls, and set how long
# the drained batch stays held. For --apply that timeout is also the window to
# finish the confirmation: let it lapse and the receipt handles expire, the
# affected sends and deletes fail, and those messages stay in the queue.
node dist/main.js --operation=triage \
  --queue=shipments-dlq \
  --queueUrl=https://sqs.eu-west-1.amazonaws.com/000000000000/shipments-dlq \
  --maxMessages=50 --visibilityTimeout=900 \
  --aws.profile=ops-readonly

# Destructive (plan only) — reach a verdict for every message and print the
# action plan it implies. Prints and stops: execute mutates nothing without
# --apply, so this is safe to run against production.
node dist/main.js --operation=execute \
  --queue=orders-dlq \
  --queueUrl=https://sqs.eu-west-1.amazonaws.com/000000000000/orders-dlq \
  --aws.profile=ops-write

# Destructive (applies) — same run, but carries out the plan behind the graded
# confirmation gate. A sensitive target escalates to typing the queue name;
# declining aborts with a non-zero exit and mutates nothing. --sourceQueueUrl
# is required only when the plan actually contains a reinsert.
node dist/main.js --operation=execute --apply \
  --queue=orders-dlq \
  --queueUrl=https://sqs.eu-west-1.amazonaws.com/000000000000/orders-dlq \
  --sourceQueueUrl=https://sqs.eu-west-1.amazonaws.com/000000000000/orders \
  --aws.profile=ops-write
```

> **Both AWS operations archive before they do anything else.** The full
> drained batch — raw bodies included — is written to `M3L_OUTPUT_DIR` before
> any verdict is reached, and a failed archive write fails the run. That
> artifact is the evidence `execute` is allowed to destroy against.
>
> **`execute` mutates nothing without `--apply`.** Without it the plan is
> printed and the run stops. With it, the graded confirmation gate
> ([ADR-0048](../../docs/adr/0048-target-graded-destructive-confirmation.md))
> runs first and always escalates to typing the queue name. A queue's declared
> prohibitions downgrade an executable verdict to a follow-up and always win.
>
> **`--apply` requires an explicit `--aws.profile`.** Without one the library
> provisions AWS from the default credential chain but resolves no identity to
> grade against, so the gate would degrade to an ungraded prompt that `--yes`
> could bypass outright. `execute --apply` therefore refuses to run rather than
> mutate under an unidentifiable credential. The plan-only path has no such
> requirement.

### Operations at a glance

| Operation  | Description                                                                           | Demonstrated by                                |
| ---------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `validate` | Build every preset offline and fail on any problem.                                   | Minimal, Common                                |
| `explain`  | Print one preset's compiled step graph, cases and digest.                             | Production                                     |
| `convert`  | Turn one runbook markdown file into a preset skeleton.                                | Edge case                                      |
| `triage`   | Drain the queue, run the compiled preset per message, and write the triage report.    | Mutating, Bounded run                          |
| `execute`  | Re-run the triage pass, build the remediation plan, and apply it when 'apply' is set. | Destructive (plan only), Destructive (applies) |

A `—` in **Demonstrated by** means the operation has no worked example in
§ Examples above — see the [contract page](../../docs/reference/scripts/sqs-dead-letter-triage.md) for its full
contract. Descriptions are the same strings the script declares in
`src/config.ts` and exposes via `getOperations()` (ADR-0055).

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
