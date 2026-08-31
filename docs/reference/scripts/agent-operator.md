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

**With this slice** the whole offline half is in place. The config schema, the
committed policy, and policy loading landed first; the typed `m3l` CLI seam
followed; this one adds the **audit spine** — the run ledger, the decision
recorder, and the decision-log preflight. There is still no Bedrock client, no
agent loop, and no network call anywhere — every CLI call is a locally spawned
child process, so the whole surface is exercisable without AWS.

The `health-check` operation now runs its **audit spine**: it loads the policy,
builds the run ledger, and performs the decision-log preflight. The preflight
writes **two** entries — the honest bootstrap escalation, then the verdict the
run actually concluded on — and the run then reports that the model loop is
still pending.

It exits cleanly only when that concluding verdict is auto-approved. Otherwise
it fails with `ERR_AGENT_OPERATOR_ESCALATED`, carrying the verdict and rule in
`context`. A run the policy declined must not report success, and the entry the
run concluded on must be as durable as the one it opened with — otherwise the
log records how the run started rather than how it ended. The gate is
`Core.isAgentActionAutoApproved`: `verdict !== "denied"` would let every
escalation through.

The Bedrock tool loop, the gate ordering, and the fleet health tools land in
the final slice.

One consequence is worth stating plainly rather than discovering later. The
evaluator checks budgets (step 3) **before** the decision-log rule (step 3b),
deliberately, so that a budget-exhausted action keeps reporting its own budget
rule. Because the committed policy declares all five budgets and no metering
exists until the workload slice, every action currently escalates on a
`budget.*.unobservable` rule, which masks `decision-log-unavailable*`
entirely. So the preflight ships here as tested machinery that becomes
_operative_ only once the metering invoker lands.

Concretely: against the committed policy, `health-check` fails with
`ERR_AGENT_OPERATOR_ESCALATED` rather than succeeding — correctly, because
nothing can yet observe the budgets that policy declares. The auto-approved
path is exercised against a budget-free policy in the tests. The fix is the
metering invoker, not a defaulted ledger field: reporting an unobserved budget
as `0` would convert "unobservable" into a silently passing check, which is the
one direction this design must never fail in.

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
  operations, budgets, and the `requireDecisionLog`/`dryRunFirst` flags, and
  exercises the CLI seam via `list` and `doctor`.
- `run-ledger` — the caller-maintained `Core.M3LAgentRunLedger` state. Every
  ledger field is optional and presence is read with `Object.hasOwn`, so a key
  **present but holding `undefined` throws**; snapshots are therefore built with
  conditional spreads and only ever carry genuinely observed fields. Omission
  means _unobservable_, not zero — which escalates rather than passes. The
  ledger reads no clock: `now` is sampled once by the caller and passed in.
  `dryRunCompletedShapes` is bounded at `Core.M3L_AGENT_MAX_DRY_RUN_SHAPES`
  (256) and rejects above it rather than truncating, so a shape can never be
  silently dropped from the dry-run-first record.
- `decision-recorder` — the agent identity, the local `AgentDecisionLogWriter`
  port, and the write helpers. The port exists because
  `Core.M3LAgentDecisionLog` has a TS `private` member and is therefore
  **nominal** — a structural fake is not assignable to it. An oversized entry
  fails closed _before_ the writer is touched, and a write failure is wrapped
  with the original as `cause`, never re-messaged.
- `preflight-log` — the two-phase bootstrap probe. Under
  `requireDecisionLog: true` the first evaluation necessarily has
  `decisionLogAvailable` absent and escalates on
  `decision-log-unavailable.unobservable`, so the agent could never act. The
  resolution is to evaluate honestly, **write that decision — the write is the
  observation** — then mark the log observed and re-evaluate.
  `decisionLogAvailable` is never seeded, and a failed write aborts the run
  before any model client could be constructed, so a broken audit trail costs
  zero tokens.
- `run-agent-operator` — dispatches the two operations over a closed `switch`
  with a `never` exhaustiveness arm.

Non-step helpers live in `src/lib/` (the established location — precedent:
`scripts/json-etl/src/lib/field-spec.ts`, `scripts/rds-data-sql/src/lib/defaults.ts`):

- `lib/errors` — `M3LAgentOperatorCliError` and the `ERR_AGENT_OPERATOR_*` codes.
- `lib/cli-names` — the script-name allowlist. The regex is copied verbatim from
  `packages/m3l-cli/src/scaffold/manifest.ts` (it cannot be imported — ADR-0029
  allows a script exactly one dependency), with a drift-guard test that reads
  that file as text. A length cap of 64 is added on top; the CLI's own regex
  imposes none.
- `lib/cli-envelopes` — local mirror types and parse-don't-trust functions
  returning `{ ok: true, value } | { ok: false, reason }` over a closed reason
  vocabulary.
- `lib/model-safety` — the outbound sanitizer and the per-shape projections.
- `lib/cli-process` — the **only** module importing `node:child_process`.
- `lib/cli-surface` — the typed `m3l` adapter: argv table, exit-code policy,
  error minting.

### The CLI seam

The executable entrypoint is `packages/m3l-cli/bin/m3l.mjs`, spawned as
`process.execPath` with an argv array. `packages/m3l-cli/dist/main.js` is
import-inert (it exports `runCli` and runs nothing), so it is not a valid
spawn target.

| Method    | argv after entrypoint                          | Acceptable exit |
| --------- | ---------------------------------------------- | --------------- |
| `list`    | `["list", "--json"]`                           | `{0}`           |
| `doctor`  | `["doctor", "--json"]`                         | `{0, 1}`        |
| `inspect` | `["inspect", <name>, "--json"]`                | `{0}`           |
| `dryRun`  | `["run", <name>, "--json", "--", "--dry-run"]` | any             |

`doctor` accepting exit `1` is the most important asymmetry here: **a failing
health check is the answer, not an error.** `dryRun` accepts any exit code
because the `m3l.run.result` envelope carries `exitCode` and `outcome` itself.

The `dryRun` ordering is load-bearing and verified against
`packages/m3l-cli/src/main.ts`: `splitAtFirstDoubleDash` runs first, so `--json`
must precede the bare `--` for `partitionJsonFlag` to strip it, and `--dry-run`
must follow it to be forwarded to the child script.

`doctor --json`, `list --json`, and `inspect --json` each emit a **bare JSON
array with no `schemaVersion`**. Only the run envelope carries
`kind: "m3l.run.result"` and `schemaVersion: 1`, and only its parser fails
closed on a version bump. `blocking` is not a CLI field — it is derived
script-side as `checks.some((c) => c.status === "fail")`.

An aborted call raises `Core.M3LOperationAbortedError`, never a script-local
code: ADR-0049 classifies by code, and `deriveCommandOutcome` maps
`ERR_OPERATION_ABORTED` to exit `5`. A local code would make Ctrl-C exit `1` on
the spawn path and `5` in-process.

## Model-facing safety boundary

Everything the model can read passes through `lib/model-safety`.

**Argument-injection defence, in order:**

1. `shell: false` plus an argv array — no command line exists to inject into.
2. The anchored, ReDoS-safe name regex — a name cannot begin with `-` and admits
   no shell metacharacter.
3. Membership in the `m3l list` set, and for probes in `dryRunAllowlist`.
4. The V6 policy gate.
5. Fixed argv positions built from a closed `switch`.

Net effect: **the model supplies exactly one value across the whole tool
surface — a script name.** Every future tool should have to argue against that
sentence.

`--dry-run` is a per-script convention (all 17 scripts opt in via
`process.argv.includes("--dry-run")` in their `main.ts`), **not** a CLI
contract. Nothing enforces it, which is why the dry-run tool carries a declared
allowlist rather than trusting the convention.

**Sanitization order** in `sanitizeForModel`: `Core.redactSensitiveLogText`
**first**, so truncation cannot slide a secret out of the redactor's matching
window; then the workspace-root path is replaced with `<workspace>`; then C0,
`U+007F`, C1, and `U+2028 U+2029 U+202D U+202E U+2066`–`U+2069` are escaped as
literal `\uXXXX` text; then the string is capped **by code point** using
`for...of` — never `.slice()`, which bisects a surrogate pair.

**Per-field policy, and why it is asymmetric:**

| Field                     | Treatment                                 | Why                                                  |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| doctor `detail`           | **kept**, sanitized                       | It is the diagnostic value the check exists to carry |
| list `loadError`          | **dropped** → `configLoadFailed: boolean` | The model needs the fact, not the text               |
| envelope `reportPath`     | **dropped** → `reportAvailable: boolean`  | A host path is not the model's business              |
| descriptor `defaultValue` | **dropped** when `secret === true`        | A secret's default must never be rendered unmasked   |

That asymmetry is deliberate; do not "fix" one side of it.

Tool results are emitted as `{ type: "json", json: … }` blocks, so untrusted
text only ever appears as a JSON leaf value — never concatenated into prose the
model reads as instruction.

**Honest limits.** Three, stated plainly rather than papered over:

1. **Escaping control characters does not neutralize instruction-shaped
   English** inside a `detail`. The mitigation is structural: untrusted text
   appears only as JSON leaves, and the policy gate — not the model —
   authorizes every action. This is not injection-proof and does not claim
   to be.
2. **`redactSensitiveLogText` is a denylist, not a parser.** Its own TSDoc
   says so. It catches `key=value`-shaped secrets, but a bare AWS key pair
   (`AKIA…` / a 40-char secret), a JWT, and a `postgres://user:pass@host` URL
   all pass through unredacted. `doctor`'s `detail` is the one field where
   un-allowlisted upstream text crosses to the model — it is kept because it
   is the diagnostic value the check exists to carry, but treat it as
   best-effort, not as a guarantee. `inspect`'s known `secret: true` parameter
   names are threaded in as an explicit `secrets` list to widen coverage where
   the script does know them.
3. **`sensitiveTargets` matches exactly, never by substring.**
   `matchesSensitiveList` (`core/prompt/M3LDestructiveGate.ts:208`) is
   `list.includes(value)`, so the committed policy's
   `profiles: ["prod", "production"]` grades a profile named exactly `prod`
   but **not** one named `acme-prod-admin`. A deployment whose profile naming
   differs must enumerate its own names in `data/input/agent-policy.json`.
   This does not bite the read-only health-check workload — grading only
   changes the verdict for mutations — but it will matter at V9.

## Error codes

| Code                                | Meaning                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `ERR_AGENT_OPERATOR_CONFIG`         | A required parameter is missing or a cross-check failed                     |
| `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT` | The CLI entrypoint could not be derived and was not supplied                |
| `ERR_AGENT_OPERATOR_CLI_SPAWN`      | Spawn failed, timed out, was signalled, or breached the output byte cap     |
| `ERR_AGENT_OPERATOR_CLI_OUTPUT`     | An unacceptable exit code, or a CLI payload that failed to parse            |
| `ERR_AGENT_OPERATOR_SCRIPT_NAME`    | A script name failed the allowlist, or is absent from `dryRunAllowlist`     |
| `ERR_AGENT_OPERATOR_POLICY`         | The policy file is missing, unreadable, malformed, or structurally invalid  |
| `ERR_AGENT_OPERATOR_DECISION_LOG`   | A decision-log entry could not be written, or breached an entry/shape cap   |
| `ERR_AGENT_OPERATOR_ESCALATED`      | The run concluded without an auto-approved verdict — the policy declined it |

A caller-driven abort raises `Core.M3LOperationAbortedError`
(`ERR_OPERATION_ABORTED`), not a code from this family — see § The CLI seam.

No thrown message ever carries a spawn `error.message` (an `ENOENT` message
embeds the resolved path), a `SyntaxError.message` from a failed parse (it
embeds a snippet of the file), raw CLI stdout, or a model-supplied script name.

## Inputs and outputs

**Reads.** `data/input/agent-policy.json` (or `policyFile`), resolved through
`M3LPaths.resolveInput` and `M3L_INPUT_DIR`. The file is **committed** —
`data/input/` is tracked — precisely so a missing policy is a loud failure
rather than a silent fallback. It declares `version: 1`, 17 script grants, a
`sensitiveTargets` spec, five budget ceilings, `requireDecisionLog: true`, and
`dryRunFirst: true`. Every grant declares `readOnlyOperations`, including the
`agent-operator` grant covering its own run.

**Writes.** In this slice, structured log output only. The workload slice adds a
JSON artifact under `M3L_OUTPUT_DIR` via `M3LJSONFileExporter` and JSONL decision
records under `data/agent-log/` (gitignored). The `m3l` CLI's discovery cache
lands in `data/cache/` on every spawned call; it is derived machine state and is
gitignored.

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
