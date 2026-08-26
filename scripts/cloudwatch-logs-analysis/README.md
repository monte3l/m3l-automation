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

The one command an alarm's runbook should link to is the first example below:
an alarm name and the time it fired.

### Examples

```bash
# Minimal — analyze one alarm from the time it fired. Read-only against AWS;
# writes a JSON report to M3L_OUTPUT_DIR named after the run's correlation id.
node dist/main.js --operation analyze \
  --alarm example-gateway-5xx \
  --triggeredAt 2026-08-23T14:32:00Z

# Common — check every preset in the runbook directory builds. No AWS call, no
# credentials, no network: this is the operation to run in CI.
node dist/main.js --operation validate

# Common — print what one alarm's compiled procedure would do: every step with
# its jump targets and loop bound, every case in priority order, and the
# definition digest. Also offline.
node dist/main.js --operation explain --alarm example-gateway-5xx

# Production — a tuned unattended run: widen the window, cap the trace chain,
# and name the report explicitly so a scheduler can collect it.
node dist/main.js --operation analyze \
  --alarm example-gateway-5xx \
  --triggeredAt 2026-08-23T14:32:00Z \
  --leadMinutes 30 --lagMinutes 30 --maxDepth 2 \
  --output gateway-5xx-2026-08-23.json

# Edge case — interactive: ask before following the trace chain, and how far.
# Needs a TTY; without --interactive the configured maxDepth is used silently.
node dist/main.js --operation analyze \
  --alarm example-gateway-5xx \
  --triggeredAt 2026-08-23T14:32:00Z \
  --interactive

# Edge case — convert a runbook markdown file into a preset skeleton. Reads
# from M3L_INPUT_DIR and writes to M3L_OUTPUT_DIR, so point both at your own
# store. Anything it cannot extract is left as an explicit TODO, and a preset
# with TODOs deliberately fails `--operation validate`.
node dist/main.js --operation convert --source runbooks/queue-backlog.md
```

### Operations at a glance

| Operation  | Description                                                                                 | Demonstrated by      |
| ---------- | ------------------------------------------------------------------------------------------- | -------------------- |
| `analyze`  | Load a preset, compile it, run it against CloudWatch Logs Insights, and persist the report. | Minimal / Production |
| `validate` | Build every preset in the runbook directory offline and report every problem at once.       | Common               |
| `explain`  | Print one preset's compiled step graph, cases and digest.                                   | Common               |
| `convert`  | Turn one runbook markdown file into a preset skeleton.                                      | Edge case            |

A `—` in **Demonstrated by** means the operation has no worked example in
§ Examples above — see the [contract page](../../docs/reference/scripts/cloudwatch-logs-analysis.md) for its full
contract. Descriptions are the same strings the script declares in
`src/config.ts` and exposes via `getOperations()` (ADR-0055).

### Trying it against the shipped examples

Three anonymised example presets ship in `presets/`, one per stage combination.
Point the input directory at the package to run against them:

```bash
cd scripts/cloudwatch-logs-analysis
M3L_INPUT_DIR="$PWD" M3L_OUTPUT_DIR=/tmp/analysis \
  node dist/main.js --operation validate --runbookDir presets
```

### Operational flags

Every script composes through `Core.runScript` (ADR-0035), so these work uniformly:

- `--dry-run` — validate environment, configuration, and AWS credentials
  (pipeline stages 1-5) without running the script:
  `node dist/main.js --dry-run`.
- `--log-level=<level>` / `--debug`, or `M3L_LOG_LEVEL=<level>` / `M3L_DEBUG=1` —
  set the log severity floor (`debug`/`info`/`success`/`warning`/`error`/`fatal`).
  CLI wins over env; an unknown value fails loud.
- **Exit codes** map the failure origin: `0` success, `2` config/validation, `3`
  script-local error, `4` unhandled/unexpected. A non-zero exit always accompanies
  a logged error. `--operation validate` exits non-zero when any preset has a
  problem, which is what makes it usable as a CI gate.

## Environment (`.env`)

This script touches AWS. Set `AWS_PROFILE` (config parameter `aws.profile`)
to the local profile to use; declaring that parameter is what triggers the
library's `script.aws` provisioning seam. It is **not** required for
`validate`, `explain` or `convert`, which never construct a client.

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree — or, for a preset store you keep outside this repository,
at that store:

```dotenv
AWS_PROFILE=my-sso-profile
M3L_CONFIG_DIR=<absolute-repo-path>/data/cloudwatch-logs-analysis/config
M3L_INPUT_DIR=<absolute-repo-path>/data/cloudwatch-logs-analysis/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/cloudwatch-logs-analysis/output
```

`--runbookDir` is resolved **relative to `M3L_INPUT_DIR`** and cannot escape it,
so pointing `M3L_INPUT_DIR` at your own preset store is how the script reads
presets that live outside this checkout.

## Data directories

| Directory | Purpose                                                            |
| --------- | ------------------------------------------------------------------ |
| `config/` | Presets / config files passed by explicit path                     |
| `input/`  | Runbook presets (`--runbookDir`) and markdown sources (`--source`) |
| `output/` | Analysis reports and converted preset skeletons                    |

**The JSON report contains gathered log rows** (capped per stage) — it is
evidence, and should be handled like the logs it came from. The console summary
deliberately carries counts, case ids and the runbook's own prose only, so a
screen-shared incident channel does not become an unintended log-content sink.
