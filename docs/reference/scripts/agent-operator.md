# agent-operator

Policy-gated agent that operates and health-checks the m3l fleet

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/agent-operator/README.md`](../../../scripts/agent-operator/README.md).

## Purpose and scope

`agent-operator` is the consumer-script stage of ADR-0058's agent-operator
programme (tracker row V8). It composes four already-shipped library blocks into
a policy-gated operator over the `m3l` CLI's machine surface:

- **V4/V5** — `runBedrockToolLoop` + `M3LBedrockRuntimeOperations` (`…/aws`)
- **V6** — `validateAgentPolicy` + `evaluateAgentAction` (`…/core`)
- **V7** — `agentDecisionLogEntry` + `M3LAgentDecisionLog` (`…/core`)

Its tools drive the CLI rather than the AWS SDK directly: `m3l list --json`,
`m3l doctor --json`, `m3l inspect <name> --json`, and
`m3l run <name> --json -- --dry-run`. Every action is authorized by the declared
policy before it runs, and every verdict is written to the append-only decision
log before the action executes.

**This slice** ships the foundation: the config schema, the committed policy,
policy loading and runtime resolution, and the deterministic `explain-policy`
operation. There is no Bedrock client, no agent loop, no child process, and no
network call anywhere in it — the whole surface is exercisable without AWS.

Two later slices complete the picture. The **CLI seam** (`lib/cli-process`,
`lib/cli-surface`, `lib/cli-envelopes`, `lib/model-safety`) lands next and is
what gives `explain-policy` its `list`/`doctor` snapshot and the agent its
tools. The **workload** slice then adds the Bedrock tool loop, the policy gate,
the run ledger, and the decision-log writer. The `health-check` operation is
declared in the schema from the start but fails fast with
`ERR_AGENT_OPERATOR_CONFIG` until that slice lands, rather than silently
succeeding.

Several config parameters here (`cliEntrypoint`, `cliTimeoutMs`,
`dryRunTimeoutMs`, `maxOutputBytes`, `dryRunAllowlist`, `includeDryRunProbes`)
are declared and validated now but consumed by the CLI seam slice. They are
declared up front so the schema — and the `maxIterations` ≤
`budgets.loopIterations` cross-check that guards it — does not churn twice.

Explicitly out of scope: mutations of any kind (the policy grants only
`inspect`/`dry-run` on fleet scripts, all declared `readOnlyOperations`); a
generic `ask`/`prompt` operation, which would let model output choose the
workload rather than the operator choosing it; and budget parameters on argv —
budgets are policy-file fields, and exposing them on the command line would let
an operator widen a declared ceiling without a reviewable diff, defeating
ADR-0060's premise.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness is declared on the operation
declarations (ADR-0055) and enforced by `Core.deriveOperationValidators`.

| Parameter             | Type           | Default               | Validation                  | Required for | Description                                                                                                                     |
| --------------------- | -------------- | --------------------- | --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`         | `STRING`       | —                     | `nonEmpty`                  | all          | Local AWS profile; declaring it enables the `script.aws` provisioning seam                                                      |
| `command`             | `STRING`       | —                     | operation membership        | all          | `health-check` or `explain-policy`                                                                                              |
| `modelId`             | `STRING`       | —                     | `nonEmpty`                  | all          | Primary Bedrock model id for the workload loop                                                                                  |
| `fallbackModelIds`    | `STRING_ARRAY` | `[]`                  | each `nonEmpty`             | —            | Ordered fallback models handed to `M3LBedrockRuntimeOperations`                                                                 |
| `modelRates`          | `STRING_ARRAY` | `[]`                  | parsed in `resolve-runtime` | —            | Per-1k-token rates, `<id>=<in>,<out>` per entry; an absent rate makes cost **unobservable**, which escalates rather than passes |
| `policyFile`          | `STRING`       | `"agent-policy.json"` | `nonEmpty`                  | —            | Policy filename resolved through `M3L_INPUT_DIR`                                                                                |
| `agentName`           | `STRING`       | `"agent-operator"`    | `nonEmpty`                  | —            | Logical identity recorded on every decision-log entry                                                                           |
| `maxIterations`       | `INT`          | `8`                   | `range(1, 64)`              | —            | Tool-loop ceiling; cross-checked against `budgets.loopIterations`                                                               |
| `maxToolsPerTurn`     | `INT`          | `4`                   | `range(1, 16)`              | —            | Per-turn tool-call ceiling                                                                                                      |
| `maxOutputTokens`     | `INT`          | `2048`                | `range(1, 8192)`            | —            | `inferenceConfig.maxTokens`; bounds worst-case per-turn token overshoot                                                         |
| `scripts`             | `STRING_ARRAY` | `[]`                  | each an allowed script name | —            | Narrows the checked set; empty means every discovered script                                                                    |
| `includeDryRunProbes` | `BOOL`         | `false`               | requires `dryRunAllowlist`  | —            | Enables the `dry-run` tool                                                                                                      |
| `dryRunAllowlist`     | `STRING_ARRAY` | `[]`                  | each an allowed script name | —            | The only names `dry-run` may probe                                                                                              |
| `output`              | `STRING`       | —                     | `nonEmpty`                  | —            | Artifact filename under `M3L_OUTPUT_DIR`                                                                                        |
| `decisionLogDir`      | `STRING`       | —                     | `nonEmpty`                  | —            | Overrides the decision log's directory                                                                                          |
| `cliEntrypoint`       | `STRING`       | derived (see below)   | `nonEmpty`                  | —            | Absolute path to `packages/m3l-cli/bin/m3l.mjs`                                                                                 |
| `cliTimeoutMs`        | `INT`          | `30000`               | `range(1000, 600000)`       | —            | Per-call ceiling for `list`/`doctor`/`inspect`                                                                                  |
| `dryRunTimeoutMs`     | `INT`          | `120000`              | `range(1000, 900000)`       | —            | Per-call ceiling for a dry-run probe                                                                                            |
| `maxOutputBytes`      | `INT`          | `1048576`             | `range(1024, 16777216)`     | —            | Per-stream byte cap; a breach kills the child and reports `output-truncated`                                                    |

`cliEntrypoint` defaults to
`join(paths.getProjectRoot(), "packages", "m3l-cli", "bin", "m3l.mjs")`.
`getProjectRoot()` is unavailable in standalone mode (it throws
`M3LPathResolutionError`), so outside the monorepo the parameter must be set
explicitly or the run fails with `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT`.

One cross-parameter validator is declared beyond the ADR-0055 derivation:
`includeDryRunProbes: true` requires a non-empty `dryRunAllowlist`. Enabling the
probe tool with nothing allowlisted would leave it unable to probe anything, so
the mismatch fails loudly at config-load rather than silently at run time.
(`Core.M3LConfigSchemaValidators.requires` would be a no-op here — both operands
carry declared defaults, so neither is ever `undefined` by the time validators
run — so it is a value-based inline predicate, the `sqs-etl` shape.)

**Deliberately absent.** No budget parameters (see § Purpose and scope). No
`dryRun` parameter — that is ADR-0054's context flag, read once in `main.ts`.
No `yes`/`yesSensitive` — this workload never calls `confirmDestructive`.

## Steps

- `load-policy` — reads `policyFile` through `M3LInputFileReader.readJSONRecord`
  (not `readJSON`, so `asRecord` screens `__proto__`/`constructor`/`prototype`
  before the declaration reaches the validator) and hands it to
  `Core.validateAgentPolicy`. There is **no inline fallback**: a missing policy
  is a loud `ERR_AGENT_OPERATOR_POLICY`, never a silent degradation to a
  built-in grant.
- `resolve-runtime` — resolves config into model ids, rates, and ceilings, and
  performs the `maxIterations` ≤ `budgets.loopIterations` cross-check so a
  ceiling the policy declares cannot be widened from argv.
- `explain-policy` — the deterministic, no-Bedrock operation: renders grants,
  operations, budgets, and the `requireDecisionLog`/`dryRunFirst` flags through
  the injected logger, and returns a plain summary. The CLI-seam slice adds its
  `list`/`doctor` fleet snapshot.
- `run-agent-operator` — dispatches the two operations over a closed `switch`
  with a `never` exhaustiveness arm.

Non-step helpers live in `src/lib/` (the established location — precedent:
`scripts/json-etl/src/lib/field-spec.ts`, `scripts/rds-data-sql/src/lib/defaults.ts`):

- `lib/errors` — `M3LAgentOperatorCliError` and the `ERR_AGENT_OPERATOR_*` codes.
  The class is parameterized by a closed code union rather than split into one
  subclass per code, because ADR-0049 classifies by `code`, not by class. A
  `declare readonly code` re-narrow gives a catch-site `switch (error.code)`
  real exhaustiveness, which the base class's `code: string` would not.
- `lib/cli-names` — the script-name allowlist, and the branded
  `AgentOperatorScriptName` it mints. The regex is copied verbatim from
  `packages/m3l-cli/src/scaffold/manifest.ts` (it cannot be imported — ADR-0029
  allows a script exactly one dependency), with a drift-guard test that reads
  that file as text. A length cap of 64 is added on top; the CLI's own regex
  imposes none, and the length is checked **before** the regex. The brand is
  what stops an unvalidated, model-proposed string reaching an argv array once
  the CLI seam lands.

The CLI-seam slice adds `lib/cli-envelopes`, `lib/model-safety`,
`lib/cli-process`, and `lib/cli-surface` alongside these.

## Error codes

`M3LAgentOperatorErrorCode` declares the whole family up front so the union does
not churn across slices. The right-hand column marks which are reachable today.

| Code                                | Meaning                                                                    | Reachable      |
| ----------------------------------- | -------------------------------------------------------------------------- | -------------- |
| `ERR_AGENT_OPERATOR_CONFIG`         | A required parameter is missing or a cross-check failed                    | yes            |
| `ERR_AGENT_OPERATOR_POLICY`         | The policy file is missing, unreadable, malformed, or structurally invalid | yes            |
| `ERR_AGENT_OPERATOR_SCRIPT_NAME`    | A script name failed the allowlist, or is absent from `dryRunAllowlist`    | yes            |
| `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT` | The CLI entrypoint could not be derived and was not supplied               | yes            |
| `ERR_AGENT_OPERATOR_CLI_SPAWN`      | Spawn failed, timed out, was signalled, or breached the output byte cap    | CLI-seam slice |
| `ERR_AGENT_OPERATOR_CLI_OUTPUT`     | An unacceptable exit code, or a CLI payload that failed to parse           | CLI-seam slice |

No thrown message ever carries a `SyntaxError.message` from a failed parse (it
embeds a snippet of the file — the F10/W5 rule) or a model-supplied script name.
The CLI-seam slice extends that rule to spawn `error.message` (an `ENOENT`
message embeds the resolved path) and raw CLI stdout.

## Inputs and outputs

**Reads.** `data/input/agent-policy.json` (or `policyFile`), resolved through
`M3LPaths.resolveInput` and `M3L_INPUT_DIR`. The file is **committed** —
`data/input/` is tracked — precisely so a missing policy is a loud failure
rather than a silent fallback. It declares `version: 1`, 17 script grants, a
`sensitiveTargets` spec, five budget ceilings, `requireDecisionLog: true`, and
`dryRunFirst: true`. Every grant declares `readOnlyOperations`, including the
`agent-operator` grant covering its own run.

**Writes.** In this slice, structured log output only — nothing is persisted.
The workload slice adds a JSON artifact under `M3L_OUTPUT_DIR` via
`M3LJSONFileExporter` and JSONL decision records under `data/agent-log/`
(gitignored). Once the CLI seam lands, the `m3l` CLI's discovery cache lands in
`data/cache/` on every spawned call; it is derived machine state and is
gitignored ahead of that slice so a stray cache never reaches a diff.

## Command module

`src/command.ts` implements the ADR-0054 seam: `commandModule.execute` composes
`Core.M3LScript` and `Core.runScript` in-process, and `src/main.ts` delegates to
it rather than composing a second, independent script (the U7 shape).

`validate: configValidators` is wired at the `M3LScript` constructor — declaring
the array proves nothing about enforcement, and a validator wired in one
composition site is not wired in the other.

`context.signal` is forwarded as `host.signal` and reaches the CLI seam, so an
abort mid-spawn is classified as `interrupted` (exit `5`) rather than a failure.
`context.dryRun` reaches `Core.runScript`, never the config schema.

Outcome mapping is the fleet-standard `Core.deriveCommandOutcome` →
`Core.mapCommandOutcomeToExitCode`; `partial.recovered` reports
`script.recoveryTotal`, not `script.recovery.length` (the ring buffer truncates).

## See also

- [ADR-0058](../../adr/0058-agent-operator-programme.md) — the programme this
  script is the consumer-script stage of
- [ADR-0060](../../adr/0060-agent-policy-layer.md) — the policy layer the gate
  is built on
- [ADR-0061](../../adr/0061-agent-decision-log.md) — the decision log
- [ADR-0059](../../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md) —
  the Bedrock wrapper and tool-loop primitives
- [ADR-0049](../../adr/0049-cooperative-cancellation-contract.md) —
  code-based abort classification
- [`core/agent`](../core/agent.md) — `validateAgentPolicy`, `evaluateAgentAction`
- [`aws/bedrock-runtime`](../aws/bedrock-runtime.md) — `runBedrockToolLoop`
- [`core/cli-contract`](../core/cli-contract.md) — the exit-code registry and
  the `m3l.run.result` envelope
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
