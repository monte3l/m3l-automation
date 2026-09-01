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

**V8 is complete with this slice.** The config schema, the committed policy,
and policy loading landed first; the typed `m3l` CLI seam followed; then the
**audit spine** — the run ledger, the decision recorder, and the decision-log
preflight; then the **cross-run daily invocation counter**; and now the
**fleet health-check workload** itself — the Bedrock tool loop, the four gated
tools, the anomaly report, and the exit-code contract a scheduler reads.

The `health-check` operation runs a real, policy-gated, read-only pass over
the fleet: it loads the policy, seeds the per-day baseline from the cross-run
counter, builds the metered Bedrock invoker, runs the decision-log preflight,
assembles a gated tool registry, drives `runBedrockToolLoop`, and writes an
anomaly summary. Every action the model requests is authorized before it runs,
and every verdict reaches the append-only decision log.

It reaches the model only when the preflight's concluding verdict is
auto-approved. Otherwise it fails with `ERR_AGENT_OPERATOR_ESCALATED`, carrying
the verdict and rule in `context`. A run the policy declined must not report
success, and the entry the run concluded on must be as durable as the one it
opened with — otherwise the log records how the run started rather than how it
ended. The gate is `Core.isAgentActionAutoApproved`: `verdict !== "denied"`
would let every escalation through.

### An unhealthy fleet exits 6

| Condition                                   | Outcome       | Exit |
| ------------------------------------------- | ------------- | ---- |
| Loop completed, zero anomalies              | `success`     | 0    |
| 1+ fleet anomaly, gated refusal, or ceiling | `partial`     | 6    |
| Ctrl-C / `signal`                           | `interrupted` | 5    |
| A Bedrock transport/API failure             | `failure`     | 3    |
| Every declared model exhausted              | `failure`     | 2    |

**Exit 0 would be wrong.** `core/script/run-script.ts` states the governing
principle: _"the exit code is the only thing a scheduler reads."_ This workload
exists for unattended monitoring; exiting 0 on a blocking `doctor` failure
means cron sees green while the fleet is broken.

**Throwing would be wrong twice.** ADR-0049 classifies exit 1–4 by _fault
origin_, and a fleet script reporting a failing status is none of them — the
health check _worked_. Exit 3 would make "Bedrock is unreachable" and "the
fleet is unhealthy" indistinguishable, destroying the one discrimination this
workload exists to provide. And mechanically, throwing from `mainFn` means the
anomaly summary — the deliverable — is never written. `partial` is defined for
exactly this: _"the run completed with absorbed per-item failures — neither
success nor failure"_. `steps/gate-tool` already calls `reportRecovery` on
every refusal, so a policy refusal lands on the same 6, coherently.

The last two rows differ, and the split is the library's: `core/errors/catalog.ts`
classifies `ERR_BEDROCK_RUNTIME_OPERATION` as `origin: "external"` (exit 3) but
`ERR_BEDROCK_RUNTIME_NO_MODEL` as `origin: "caller"` (exit 2) — "every model
you declared is unavailable" is your model list being wrong, not an external
fault.

Note the CLI seam's documented asymmetry is scoped to the **tool** — `doctor`
exiting 1 must _resolve_ `surface.doctor()`. That says nothing about this
script's own exit code, and the two must not be conflated.

### Three ordering constraints

1. **`createMeteredInvoker` is constructed before `runDecisionLogPreflight`.**
   It seeds `observeSpend({tokens: 0, loopIterations: 0, cost: 0})` at
   construction, because zero spend must be an _observed_ fact. Built after
   the preflight, the preflight escalates on
   `budget.tokens-per-run.unobservable` and the run dies before a single tool
   exists. Constructing the Bedrock client makes no network call, so this costs
   nothing on a run the preflight then refuses.
2. **`modelRates` must cover `modelId` and every `fallbackModelIds` entry.**
   `sumObservedCost` returns `undefined` the moment a served model lacks a
   rate, which makes `snapshot()` omit `costThisRun`, which makes _every_ gated
   call escalate on `budget.cost-per-run.unobservable` and get refused. The
   seeded `0` covers the preflight only — the first tool call already arrives
   after turn 1. An operator who declares `costPerRun` but forgets a rate for
   one fallback model gets a run that spends tokens and learns nothing.
3. **The same `rates` map object goes to both `createMeteredInvoker` and
   `runBedrockToolLoop`.** A conditional spread on one side only creates a
   divergence `reconcileMeteredCost` would then correctly, confusingly, throw
   on.

Plus: **one shared recorder instance** across the preflight and the gate deps,
or the audit trail splits across two identities.

One consequence is worth stating plainly rather than discovering later. The
evaluator checks budgets (step 3) **before** the decision-log rule (step 3b),
deliberately, so that a budget-exhausted action keeps reporting its own budget
rule. It checks the five ceilings in a **fixed** order —
`invocationsPerRun -> invocationsPerDay -> tokensPerRun -> costPerRun ->
loopIterations` — and reports the first unsatisfied one, so a single
unobservable ceiling masks every rule below it, `decision-log-unavailable*`
included.

The committed policy declares all five, and **all five are now observable**:

| Ceiling                   | Made observable by                                       |
| ------------------------- | -------------------------------------------------------- |
| `invocationsPerRun` (60)  | the run ledger's own `recordInvocation`                  |
| `invocationsPerDay` (400) | `steps/daily-counter`, seeded before the preflight       |
| `tokensPerRun` (200000)   | `createMeteredInvoker`, constructed before the preflight |
| `costPerRun` (2)          | the same, given a `modelRates` entry per served model    |
| `loopIterations` (8)      | the same                                                 |

So `health-check` now runs clean against the committed policy. The fix for
each ceiling was metering, never a defaulted ledger field: reporting an
unobserved budget as `0` would convert "unobservable" into a silently passing
check, which is the one direction this design must never fail in.

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
No `yes`/`yesSensitive` — this workload never calls `confirmDestructive`. No
`agentStateDir`, and no `agentName`-derived counter filename: `agentName` is
argv-settable, so either one would let `--agentName foo` mint a fresh
400-invocation per-day budget with no policy diff — the same objection
ADR-0060 raises against budget parameters on argv. (`decisionLogDir` is
different and stays: relocating an audit record widens no authority.)

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
  silently dropped from the dry-run-first record. `invocationsToday` and
  `todayCountedAt` are emitted by a **single** conditional spread — both or
  neither — because the evaluator checks presence of all three of
  `invocationsToday`/`todayCountedAt`/`now` _before_ it applies the UTC-day
  window: a half-present pair is unobservable anyway, and looks observed to a
  reader, which is worse. `invocationsToday` is **composed**
  (`baseline + invocationsThisRun`), never stored, because both names count the
  same event.
- `daily-counter` — the cross-run daily invocation counter, and the only reason
  `budgets.invocationsPerDay` is observable at all. It counts model
  **invocations**, not runs: the library defines the unit, and the two counters
  share one `M3LAgentBudgets` bag, so a per-day counter of runs would read the
  committed `60`/`400` pair as 24,000 turns a day. State is a
  `Core.M3LCheckpointStore` envelope under `getDataDir()/agent-state` — never
  `getOutputDir()`, which an operator clears between runs — behind a fixed
  filename. The day boundary is **UTC**, re-deriving the library's own
  `Math.floor(t / 86_400_000)` (it is `internal/`, so ADR-0029 forbids
  importing it) with a drift-guard test; a local-day roll would disagree with
  the evaluator by up to fourteen hours. A corrupt or unverifiable file
  **rejects** with `ERR_AGENT_OPERATOR_BUDGET_STATE` — it never degrades to
  zero, which would turn tampering into a budget reset. Two caveats, both
  permissive and both deliberate: concurrent runs lose updates (last write
  wins, bounded by concurrent runs x `invocationsPerRun`; `data/agent-log/` is
  the compensating control, since every verdict is durably recorded), and a
  deleted file starts today at `0`.
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
  before any model **invocation**, so a broken audit trail costs zero tokens.
  (It no longer aborts before the model _client_ is constructed — the metered
  invoker must exist before this step, per ordering constraint 1 — but
  construction makes no network call, so the property that matters is
  unchanged.) The counter is seeded **before** this step too: the preflight
  snapshots the ledger twice, so an unseeded ledger escalates on the per-day
  rule at _both_ phases and the two-phase bootstrap can never resolve.
- `create-invoker` — the one place a Bedrock client is constructed, and
  therefore the network seam. Its own module so a test can replace it with
  `vi.mock` without faking anything else.
- `health-observations` — the script-owned collector every gated tool writes
  its **projected** result into. It exists because the loop's outcome carries
  only `{toolUseId, name, status}` per tool execution, never the payload — so
  fleet findings must be captured on the way past or they are gone. It stores
  only `MODEL_SAFE_BRAND`-carrying values, so nothing unsanitized can reach the
  artifact by construction.
- `build-health-tools` — the four `AgentToolSpec`s (`fleet_list`,
  `fleet_doctor`, `script_inspect`, `script_dry_run`) over `AgentCliSurface`.
  It never gates them itself: `buildAgentToolRegistry` is the only door.
- `health-prompt` — the system and user prompts. Every string is script- or
  config-authored; no CLI output and no prior model output ever reaches a
  prompt.
- `health-report` — the `m3l.agent-operator.health-check` artifact
  (`schemaVersion: 1`) and `deriveHealthAnomalies`.
- `run-health-check` — the orchestrator, and the owner of the three ordering
  constraints above.
- `run-agent-operator` — dispatches the two operations over a closed `switch`
  with a `never` exhaustiveness arm. Both operations live in their own step
  modules; this file is a dispatcher and nothing else.

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

### `describeAction` is the one trust boundary

Everything a model can influence enters through it:

- `scriptName` is read with `Object.hasOwn`, never a bracket or dot read — a
  model can literally send `{"__proto__": {"scriptName": "…"}}`.
- The name must pass `isAllowedScriptName`, **not** because the CLI surface
  would not check (it does, immediately before any spawn) but to bound what
  reaches the evaluator and the append-only log. Without the length cap a
  hostile 100 KB name builds an entry that breaches the log's single-line byte
  ceiling; the gate reads that as a _write_ failure, calls
  `observeDecisionLog(false)`, and every subsequent action escalates on
  `decision-log-unavailable`. **That is a model-triggerable self-DOS.**
  Rejecting here refuses with `malformedInput`, writes nothing, and leaves the
  ledger clean.
- `kind` is **never** derived from input.
- `fleet_list`/`fleet_doctor` accept any object and never read it. The ignoring
  _is_ the guarantee that preserves "the model supplies exactly one value
  across the whole tool surface."

`script_dry_run` is fail-closed in **two independent layers**: its spec is not
built at all unless `includeDryRunProbes` is true _and_ the allowlist is
non-empty, and the CLI surface separately receives an empty allowlist when the
flag is off.

### The model's free text: exactly one untrusted leaf

It lands at `model.summary` in the artifact and nowhere else, never
concatenated into prose. The final message is filtered to `text` blocks
(`toolUse`/`toolResult` are dropped, never stringified), then run through
**`sanitizeForModel`** — the outbound sanitizer, used inbound, deliberately:
the four hazards are identical in both directions (an echoed secret, an
absolute host path, a bidi/C1 control that turns `cat report.json` into
terminal injection, unbounded length), and a second denylist would be one more
thing to keep in step. It yields `null`, never `""`, when there is no text. A
consequence worth stating: the sanitizer escapes C0 including line feed, so
`summary` is single-line by construction and a paragraph break renders as
escaped text.

The prompt tells the model, in as many words, that it has **no
machine-readable output channel** — the report is assembled by the operator
from the tool results themselves. That removes the incentive to invent one,
and removes the temptation for a future maintainer to parse its reply.

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

| Code                                | Meaning                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `ERR_AGENT_OPERATOR_CONFIG`         | A required parameter is missing or a cross-check failed                                       |
| `ERR_AGENT_OPERATOR_CLI_ENTRYPOINT` | The CLI entrypoint could not be derived and was not supplied                                  |
| `ERR_AGENT_OPERATOR_CLI_SPAWN`      | Spawn failed, timed out, was signalled, or breached the output byte cap                       |
| `ERR_AGENT_OPERATOR_CLI_OUTPUT`     | An unacceptable exit code, or a CLI payload that failed to parse                              |
| `ERR_AGENT_OPERATOR_SCRIPT_NAME`    | A script name failed the allowlist, or is absent from `dryRunAllowlist`                       |
| `ERR_AGENT_OPERATOR_POLICY`         | The policy file is missing, unreadable, malformed, or structurally invalid                    |
| `ERR_AGENT_OPERATOR_DECISION_LOG`   | A decision-log entry could not be written, or breached an entry/shape cap                     |
| `ERR_AGENT_OPERATOR_ESCALATED`      | The run concluded without an auto-approved verdict — the policy declined it                   |
| `ERR_AGENT_OPERATOR_BUDGET_STATE`   | The cross-run daily invocation counter could not be read, is corrupt, or could not be written |

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

**Writes.** Four things:

- Structured log output.
- JSONL decision records under `data/agent-log/` (gitignored). A `health-check`
  run writes at least three: the preflight's bootstrap escalation, its
  concluding verdict, two per approved tool call, and a **third** run-level
  entry carrying `tokens`/`cost` — the first caller ever to populate the fields
  ADR-0061 added. JSONL is append-only, so that is a third entry rather than an
  amendment of the second; it re-records the concluding decision rather than
  re-evaluating, because the question it answers is _"what did the authorized
  run cost"_, not _"would it be authorized now"_.
- The cross-run daily invocation counter at
  `data/agent-state/daily-invocations.checkpoint.json` (gitignored). Written
  from a `finally`, so a crash mid-loop cannot forget invocations already made.
- The `m3l.agent-operator.health-check` artifact under `M3L_OUTPUT_DIR` via
  `M3LJSONFileExporter` — `agent-operator-health-check.json` by default, or the
  `output` override. Written **before** `reportRecovery` fires, so no later
  branch can cost the deliverable on the unhealthy path, which is the path it
  exists for.

The `m3l` CLI's discovery cache lands in `data/cache/` on every spawned call;
it is derived machine state and is gitignored too.

### The `m3l.agent-operator.health-check` artifact

`schemaVersion: 1`. `blocking` is the field a scheduler reads; `anomalies` is
derived **only** from what the gated tools observed, never from the model's
message, over a closed `kind` vocabulary (`doctor-check-failed`,
`doctor-check-warned`, `script-config-load-failed`, `dry-run-probe-failed`) in
a stable order, so two runs over the same fleet produce byte-identical
artifacts. A `warn` counts as an anomaly deliberately — a scheduler that only
hears about hard failures learns nothing from a fleet degrading gradually — and
`kind` is what lets a consumer ignore warns explicitly, in its own code.

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
