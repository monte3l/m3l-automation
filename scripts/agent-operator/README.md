# agent-operator

Policy-gated agent that operates and health-checks the m3l fleet

> **This README covers how to run the script.** The contract — configuration
> schema, steps, inputs/outputs — lives in the reference page:
> [`docs/reference/scripts/agent-operator.md`](../../docs/reference/scripts/agent-operator.md).
> Keep the two disjoint: run instructions here, contract there.

## Run

```bash
pnpm build                                        # whole workspace; turbo orders deps first
pnpm --filter @m3l-automation/agent-operator start
```

`pnpm build` is unfiltered on purpose. Besides the library, every operation here
spawns the `m3l` CLI (`packages/m3l-cli/bin/m3l.mjs`) for its `list` and
`doctor` calls, so `packages/m3l-cli` must be built too — a library-only build
leaves the CLI entrypoint importing a missing `dist/`.

`start` runs `node --env-file-if-exists=.env dist/main.js`, so a local
`scripts/agent-operator/.env` is loaded automatically when present.

Before the first run, confirm `data/input/agent-policy.json` is present — it is
committed, and there is **no inline fallback**. A missing or unreadable policy
fails the run loudly with `ERR_AGENT_OPERATOR_POLICY` rather than degrading to a
built-in grant.

### Examples

> **`health-check` is the first operation in this repo that spends money.** It
> calls Bedrock. Rehearse with `--dry-run` first (see the Edge case example
> below): that stops at ADR-0054's context flag, validates environment,
> configuration, and AWS credentials, and never invokes a model.

`explain-policy` remains fully offline and costs nothing.

```bash
# Minimal — print the declared policy: grants, operations, budgets, and the
# requireDecisionLog / dryRunFirst flags. Deterministic, no Bedrock call, no
# model in the loop, so it costs nothing and needs no model access.
node dist/main.js --command explain-policy

# Common — the same, against an explicitly named policy file rather than the
# default agent-policy.json, resolved through M3L_INPUT_DIR
node dist/main.js --command explain-policy --policyFile agent-policy.json

# Production — unattended, machine-readable: quiet the human-facing log down to
# warnings so only anomalies reach the journal, and pre-declare the model rates
# the workload slice will meter against (validated now, used later)
node dist/main.js --command explain-policy \
  --modelId anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --modelRates "anthropic.claude-sonnet-4-5-20250929-v1:0=0.003,0.015" \
  --log-level warning

# Edge case — validate environment, configuration, and AWS credentials without
# running anything (ADR-0054's context flag, read once in main.ts)
node dist/main.js --command explain-policy --dry-run

# Rehearse the health check without spending anything: --dry-run stops at
# ADR-0054's context flag, so no model is ever invoked
node dist/main.js --command health-check --dry-run

# The real fleet health check. SPENDS MONEY: it drives a Bedrock tool loop.
# Declare a rate for every model that can serve a turn — modelId AND every
# fallbackModelIds entry — or cost goes unobservable and every gated call is
# refused
node dist/main.js --command health-check \
  --modelId anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --modelRates "anthropic.claude-sonnet-4-5-20250929-v1:0=0.003,0.015"

# Arm the destructive-adjacent dry-run probe. Fail-closed twice over: the tool
# is not even built unless BOTH the flag and a non-empty allowlist are present
node dist/main.js --command health-check \
  --modelRates "anthropic.claude-sonnet-4-5-20250929-v1:0=0.003,0.015" \
  --includeDryRunProbes --dryRunAllowlist json-etl,s3-objects

# Outside the monorepo — M3LPaths.getProjectRoot() is unavailable in
# standalone mode, so the CLI entrypoint must be named explicitly or the run
# fails with ERR_AGENT_OPERATOR_CLI_ENTRYPOINT
node dist/main.js --command explain-policy \
  --cliEntrypoint /opt/m3l/packages/m3l-cli/bin/m3l.mjs
```

### Operations at a glance

| Operation        | Demonstrated by                                  |
| ---------------- | ------------------------------------------------ |
| `explain-policy` | Minimal, Common, Production, Edge case           |
| `health-check`   | Dry-run rehearsal, the real run, and probe-armed |

### Operational flags

Every script composes through `Core.runScript` (ADR-0035), so these work uniformly:

- `--dry-run` — validate environment, configuration, and AWS credentials without
  running the script: `node dist/main.js --dry-run`.
- `--log-level=<level>` / `--debug`, or `M3L_LOG_LEVEL=<level>` / `M3L_DEBUG=1` —
  set the log severity floor (`debug`/`info`/`success`/`warning`/`error`/`fatal`).
  CLI wins over env; an unknown value fails loud.
- **Exit codes** map the failure origin: `0` success, `2` config/validation (a
  bad policy file, a missing parameter, a policy that declined the run, or a
  model list where every entry is unavailable), `3` an external fault (a
  spawned `m3l` child, the decision log, the cross-run counter file), `5`
  interrupted, `6` **partial**. A non-zero exit always accompanies a logged
  error.

  **`health-check` exits `6` when the fleet is unhealthy** — not `0`, and not a
  throw. `partial` means "the run completed with absorbed per-item failures";
  a blocking `doctor` check, a script whose config will not load, a failing
  dry-run probe, a policy refusal, and a loop-ceiling breach all land there. A
  scheduler reading only the exit code can therefore tell "the fleet is broken"
  (`6`) from "the health check itself broke" (`2`/`3`), which is the one
  discrimination this operation exists to provide.

Ctrl-C exits `5` (`INTERRUPTED`) on both the in-process and the spawned-tool
path: an aborted CLI tool call raises `Core.M3LOperationAbortedError`, never a
script-local code, so ADR-0049's code-based classification stays consistent.

## Environment (`.env`)

This script touches AWS. Set `AWS_PROFILE` (config parameter `aws.profile`)
to the local profile to use; declaring that parameter is what triggers the
library's `script.aws` provisioning seam.

The `.env` file is gitignored (and listed in `.worktreeinclude` so worktrees
inherit it). Secrets go **only** here or in config `secretNames` — never in
source or fixtures.

Per-script data isolation (ADR-0022): the library shares one flat
`data/{config,input,output}` root across all scripts, so point the overrides at
a per-script subtree:

```dotenv
AWS_PROFILE=my-sso-profile
M3L_CONFIG_DIR=<absolute-repo-path>/data/agent-operator/config
M3L_INPUT_DIR=<absolute-repo-path>/data/agent-operator/input
M3L_OUTPUT_DIR=<absolute-repo-path>/data/agent-operator/output
```

Pointing `M3L_INPUT_DIR` at a per-script subtree means the policy file must live
there too — copy `data/input/agent-policy.json` across, or leave
`M3L_INPUT_DIR` unset to read the committed one.

## Data directories

| Directory      | Purpose                                                   |
| -------------- | --------------------------------------------------------- |
| `config/`      | Presets / config files passed by explicit path            |
| `input/`       | Files the script consumes (including `agent-policy.json`) |
| `output/`      | Run results and archived inputs/configs                   |
| `agent-log/`   | Append-only JSONL decision records (gitignored)           |
| `agent-state/` | The cross-run daily invocation counter (gitignored)       |

`health-check` writes its `m3l.agent-operator.health-check` artifact to
`output/agent-operator-health-check.json` (override with `--output`).

`agent-state/` deliberately sits beside `output/` rather than inside it.
`output/` holds run artifacts and is the natural thing for an operator to
clear between runs — and clearing it must never silently reset a policy budget
ceiling. Deleting `agent-state/` restarts today's count at `0`; that is
permissive, so it is stated rather than hidden.
