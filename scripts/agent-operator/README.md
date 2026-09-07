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

# Run an allowlisted json-etl preset. SPENDS MONEY *and MUTATES*: the model
# chooses a preset name, the gate dry-runs it, and ONLY a clean dry run
# authorizes the real run (V6 dryRunFirst). presetAllowlist is the gate, not
# the --preset flag: entries are "<name>=<workspace-relative-path>", and a
# name the model supplies that is not a key here is refused. Declare none and
# every call refuses — the prompt says so plainly rather than looking broken.
node dist/main.js --command run-preset \
  --modelId anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --modelRates "anthropic.claude-sonnet-4-5-20250929-v1:0=0.003,0.015" \
  --scripts json-etl \
  --presetAllowlist "report=data/config/presets/report.yaml"

# Rehearse it without spending or mutating anything
node dist/main.js --command run-preset --dry-run \
  --modelId anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --scripts json-etl \
  --presetAllowlist "report=data/config/presets/report.yaml"

# Triage a CloudWatch alarm. SPENDS MONEY but never mutates AWS state: the
# model chooses a preset name and the gate grades the action read-only, so
# there is no dry-run phase to clear. The target script is PINNED to
# cloudwatch-logs-analysis — buildTriageTools refuses to register the tool for
# any other script, because the read-only claim is only sound for the one
# script whose read-only verb set it knows.
node dist/main.js --command triage-logs \
  --modelId anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --modelRates "anthropic.claude-sonnet-4-5-20250929-v1:0=0.003,0.015" \
  --scripts cloudwatch-logs-analysis \
  --presetAllowlist "checkout-5xx=data/config/presets/triage-checkout-5xx.yaml"

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
| `run-preset`     | The preset run and its rehearsal                 |
| `triage-logs`    | The alarm triage run                             |

### What a `triage-logs` preset may declare

A triage preset is a **leaf**: `lib/triage-presets.ts` verifies every entry of
`presetAllowlist` before the `triage_logs` tool is registered at all, and
refuses three things outright.

- **`extends`** — refused so the preset's own keys are its whole resolved key
  set. `Core.M3LYAMLConfigProvider` does not follow `extends` (only
  `M3LScriptPresetLoader` does), so without this rule the two checks below
  could be blinded by a base preset and would be guards that cannot fire.
- **`aws.profile`** — refused because it would not do what it looks like it
  does. `M3LScript`'s config precedence puts environment variables at level 4
  and a preset at level 6, and the spawned child inherits this process's
  environment, so an `AWS_PROFILE` set here silently outranks the preset. The
  operator's own profile is the single graded target, as it is for
  `run-preset`.
- **Any `operation` other than `analyze`** — `convert` writes a preset skeleton
  to disk, and `validate`/`explain` are refused too even though
  `cloudwatch-logs-analysis` supports them: `triageRun` pins the verb to
  `analyze`, so accepting either would authorize a request that then dies at
  the child's own config load, since `analyze`'s `requiredParameters` are not
  what a `validate`/`explain` preset carries. Only `analyze` is reachable
  through this seam, and the accepted set says exactly that.

  This check screens **operator-authored config**; on its own it is not a
  closure, for the same reason the `aws.profile` refusal exists. A preset's
  `operation:` also sits at precedence level 6, so an `OPERATION=convert` in
  the operator's inherited environment would outrank it. What actually pins
  the verb is the surface's `triageRun` method, which emits a **fixed**
  `--operation=analyze` child passthrough token — level 1, above both the
  environment and the preset. The token is a literal in a closed `buildArgv`
  variant; no caller input, config value or model output can change it, which
  is why it adds no model-supplied value to argv.

### The graded profile is pinned the same way

`triageRun` also emits `--aws.profile=<the operator's own resolved profile>`,
at the same level 1. Without it, the parent could grade one account while the
child queried another: the parent resolves `aws.profile` through _its_ full
chain, including its own CLI argument at level 1 and config files at 2–3,
while the child sees only the inherited environment at level 4. So
`--command triage-logs --aws.profile sandbox` with `AWS_PROFILE=prod` set would
grade `sandbox`, auto-approve, and read `prod` — defeating
`sensitive-target-escalated`, since `prod` is a declared sensitive profile.

Unlike the verb token this one interpolates a value, but the value is
**operator-supplied** from agent-operator's own validated config, never
model-supplied, and it is the _same_ value stamped into the judged action's
`target` rather than a second lookup free to diverge from it. `run-preset` does
not need this pin because it refuses target scripts that declare an
`aws.profile` at all — a luxury triage does not have, since `analyze` is the
one fleet-facing operation that must reach AWS.

Two operational notes on the shipped example:

- `triggeredAt` is a fixed timestamp in
  `data/config/presets/triage-checkout-5xx.yaml`, not an incident-time value —
  the `run` seam carries a preset PATH, not scalars, and threading a live
  timestamp would add a third class of model-supplied input to argv. Copy the
  file and edit the timestamp for a live incident; that is a reviewable diff.
- The runbook the example resolves lives at
  `data/input/runbooks/checkout-5xx.json` (runbooks are JSON, and
  `runbookDir` defaults to `runbooks` under `M3L_INPUT_DIR`). The spawned
  child **inherits this process's environment**, so a per-script
  `M3L_INPUT_DIR` set for `agent-operator` (see below) is inherited by
  `cloudwatch-logs-analysis` too and the child will look for runbooks under
  the operator's own input tree. That is a property of the spawn seam, not of
  this operation — it applies equally to `run-preset`'s `json-etl` inputs.

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
