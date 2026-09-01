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

`health-check` runs its offline **audit spine** today: it loads the policy,
seeds the per-day invocation baseline from the cross-run counter, and writes
both decision-log entries. It does **not** yet call Bedrock — the model-driven
workload lands in the follow-up slice. Against the committed
`data/input/agent-policy.json` it therefore still exits non-zero with
`ERR_AGENT_OPERATOR_ESCALATED` on `budget.tokens-per-run.unobservable`: that
policy declares five budgets and only two are observable so far. That is the
correct outcome — reporting an unmeasured budget as `0` would convert
"unobservable" into a silently passing check. Run it against a budget-free
policy to see the auto-approved path.

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

# The audit spine, end to end: two decision-log entries under data/agent-log/,
# and the day's invocation total under data/agent-state/. Still no Bedrock
# call, so it costs nothing.
node dist/main.js --command health-check

# Outside the monorepo — M3LPaths.getProjectRoot() is unavailable in
# standalone mode, so the CLI entrypoint must be named explicitly or the run
# fails with ERR_AGENT_OPERATOR_CLI_ENTRYPOINT
node dist/main.js --command explain-policy \
  --cliEntrypoint /opt/m3l/packages/m3l-cli/bin/m3l.mjs
```

### Operations at a glance

| Operation        | Demonstrated by                                     |
| ---------------- | --------------------------------------------------- |
| `explain-policy` | Minimal, Common, Production, Edge case              |
| `health-check`   | Audit spine — the model loop lands in a later slice |

### Operational flags

Every script composes through `Core.runScript` (ADR-0035), so these work uniformly:

- `--dry-run` — validate environment, configuration, and AWS credentials without
  running the script: `node dist/main.js --dry-run`.
- `--log-level=<level>` / `--debug`, or `M3L_LOG_LEVEL=<level>` / `M3L_DEBUG=1` —
  set the log severity floor (`debug`/`info`/`success`/`warning`/`error`/`fatal`).
  CLI wins over env; an unknown value fails loud.
- **Exit codes** map the failure origin: `0` success, `2` config/validation, `3`
  script-local error, `4` unhandled/unexpected. A non-zero exit always accompanies
  a logged error.

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

`agent-state/` deliberately sits beside `output/` rather than inside it.
`output/` holds run artifacts and is the natural thing for an operator to
clear between runs — and clearing it must never silently reset a policy budget
ceiling. Deleting `agent-state/` restarts today's count at `0`; that is
permissive, so it is stated rather than hidden.
