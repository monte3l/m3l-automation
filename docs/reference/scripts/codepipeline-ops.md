# codepipeline-ops

Manage AWS CodePipeline pipelines (list, describe, create, update, delete),
inspect pipeline state and execution history, control execution (start, stop,
watch to a terminal status), and toggle stage transitions — over the typed
`M3LCodePipelineOperations` wrapper.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/codepipeline-ops/README.md`](../../../scripts/codepipeline-ops/README.md).

## Purpose and scope

Control-plane operations over AWS CodePipeline (roadmap W3, closing the
wave): 13 operations spanning **pipeline declarations**
(list/describe/create/update/delete), **pipeline state**
(read-only stage/action status), **execution history**
(list/describe), **execution control** (start/stop/watch), and **stage
transitions** (enable/disable), dispatched over the library's
`AWS.M3LCodePipelineOperations` wrapper — never a hand-constructed
`@aws-sdk/client-codepipeline` client (ADR-0029).
`create-pipeline`/`update-pipeline`/`delete-pipeline` are gated behind the
shared destructive-operation confirmation convention used by the other
W2/W3 scripts; the remaining 10 operations (reads, execution control, stage
transitions, and watch) are not gated.

**`update-pipeline` is a destructive-anti-pattern trap, not a convenience.**
The wrapper's own contract
([`docs/reference/aws/codepipeline.md`](../aws/codepipeline.md) § "The
pipeline declaration is a lossy round-trip") documents that
`UpdatePipeline` **replaces** the whole declaration and silently deletes
every field the wrapper does not model (V2 `triggers`, the cross-region
`artifactStores` map, per-stage `onFailure`/`onSuccess`/`beforeEntry`/
`blockers`, action `commands`/`environmentVariables`/`outputVariables`,
`OutputArtifact.files`) — with no error anywhere in the call chain. This
script never offers a get-mutate-put convenience path: `create-pipeline`/
`update-pipeline` always read a **caller-authored, complete** declaration
from an `input` JSON file (the `--cli-input-json` idiom), never a mutated
`describe-pipeline` result. The destructive-gate description for
`update-pipeline` states this risk explicitly (see the `write-pipeline`
step below) so an interactive operator sees the warning before confirming.

**`watch-execution` has no SDK waiter to lean on.** CodePipeline ships zero
package-level `waitUntil*` functions, so `watch-execution` composes its own
`Core.M3LPoller` loop over `getPipelineExecution` with a script-owned
constant-delay policy — see the `watch-execution` step below for the full
terminal-status handling, including the `Superseded` sharp edge documented
by the wrapper.

Out of scope, matching the wrapper's own v1 boundary
([`docs/reference/aws/codepipeline.md`](../aws/codepipeline.md) § "Out of
scope"): `PutApprovalResult` (manual approval actions), webhooks, custom
action types, and third-party/regular job polling. A consumer needing any
of those waits for a future revision of the wrapper this script dispatches
over.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness (the "Required for" column) is **not**
expressed by `M3LConfigParameter({ required: true })` beyond `aws.profile`/
`operation` — the library has no cross-parameter/conditional-required seam
yet (F1b, deferred) — so `run-codepipeline-ops.ts` guard-checks **presence**
per operation before any AWS call (mirroring `ecs-ops`'s/`cloudformation-stacks`'s
per-command guard).

**Two distinct validation mechanisms are in play — do not conflate them:**
the "Declarative `validate:`" column below is evaluated by
`M3LConfigParameter` at `getConfiguration()` time — it fires only when the
provider resolves a raw value for that parameter (an `undefined`/absent
optional parameter never runs its validator). An **empty-but-present**
`pipeline`/`stage`/etc. or an **out-of-range** `version`/`maxResults`/
`waitMaxAttempts`/`waitIntervalSeconds` therefore fails at config-load with
`M3LConfigValidationError` — **not** `ERR_CODEPIPELINE_OPS_CONFIG`.
`run-codepipeline-ops.ts`'s own guard (the "Required for" column) checks
only **absence** (`undefined`) of a parameter a given operation needs, and
throws `ERR_CODEPIPELINE_OPS_CONFIG` for that.

| Parameter             | Type     | Default | Declarative `validate:`                                                                                                                                                                                                                                                       | Required for                                                       | Description                                                                                                                                                                                                              |
| --------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws.profile`         | `STRING` | —       | `required: true`, `nonEmpty`                                                                                                                                                                                                                                                  | all                                                                | AWS profile name; declaring it enables the `script.aws` dynamic-provisioning seam (`Core.AWS_PROFILE_PARAM_NAME`)                                                                                                        |
| `operation`           | `STRING` | —       | `required: true`, `oneOf(list-pipelines, describe-pipeline, get-pipeline-state, list-executions, describe-execution, create-pipeline, update-pipeline, delete-pipeline, start-execution, stop-execution, enable-stage-transition, disable-stage-transition, watch-execution)` | all                                                                | Selects which of the 13 dispatched operations this run performs                                                                                                                                                          |
| `pipeline`            | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                                                                                    | all but `list-pipelines`, `create-pipeline`, `update-pipeline`     | The target pipeline name; presence guard-checked by `run-codepipeline-ops`. `create-pipeline`/`update-pipeline` do **not** read this parameter — the pipeline name comes from `input`'s `declaration.name` field instead |
| `executionId`         | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                                                                                    | `describe-execution`, `stop-execution`, `watch-execution`          | The target `pipelineExecutionId`; presence guard-checked by `run-codepipeline-ops`                                                                                                                                       |
| `stage`               | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                                                                                    | `enable-stage-transition`, `disable-stage-transition`              | The target stage name                                                                                                                                                                                                    |
| `transitionType`      | `STRING` | —       | `oneOf(Inbound, Outbound)`                                                                                                                                                                                                                                                    | `enable-stage-transition`, `disable-stage-transition`              | Which transition to toggle — matches the wrapper's closed `M3LCodePipelineStageTransitionType` write-only union                                                                                                          |
| `reason`              | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                                                                                    | `disable-stage-transition` (required); `stop-execution` (optional) | Human-readable reason; **required** for `disable-stage-transition` (the wrapper's input type has no default), optional and forwarded as-is for `stop-execution`                                                          |
| `input`               | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                                                                                    | `create-pipeline`, `update-pipeline`                               | Path resolved via `M3LPaths.resolveInput` to a JSON file: a **complete** `M3LCodePipelineDeclaration` (never a mutated `describe-pipeline` result — see Purpose and scope)                                               |
| `output`              | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                                                                                    | all (optional)                                                     | Path resolved via `M3LPaths.resolveOutput`; when set, the operation's result is persisted as a single JSON document (skipped for the `void`-returning operations)                                                        |
| `version`             | `INT`    | —       | `range(1, 1_000_000)`                                                                                                                                                                                                                                                         | `describe-pipeline` (optional)                                     | Forwarded to `getPipeline(pipeline, { version })` — a specific pipeline version, omitted for the latest                                                                                                                  |
| `maxResults`          | `INT`    | —       | `range(1, 1000)`                                                                                                                                                                                                                                                              | `list-pipelines`, `list-executions` (optional)                     | Page size forwarded to `listPipelines`/`listPipelineExecutions` — one page per call, no auto-pagination (see wrapper doc)                                                                                                |
| `clientRequestToken`  | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                                                                                    | `start-execution` (optional)                                       | Idempotency token; `start-execution` is **not** idempotent without it — a retry without the same token starts a _second_ execution                                                                                       |
| `abandon`             | `BOOL`   | `false` | —                                                                                                                                                                                                                                                                             | `stop-execution` (optional)                                        | Forwarded to `stopPipelineExecution`; `true` abandons in-flight actions rather than waiting for them to finish gracefully                                                                                                |
| `yes`                 | `BOOL`   | `false` | —                                                                                                                                                                                                                                                                             | any mutating pipeline operation (optional)                         | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                                                                                                            |
| `waitMaxAttempts`     | `INT`    | `60`    | `range(1, 1000)`                                                                                                                                                                                                                                                              | `watch-execution` (optional)                                       | `Core.M3LPoller`'s `maxAttempts` — the attempt-count bound (there is no wall-clock timeout)                                                                                                                              |
| `waitIntervalSeconds` | `INT`    | `15`    | `range(1, 300)`                                                                                                                                                                                                                                                               | `watch-execution` (optional)                                       | The constant delay (via `Core.M3LBackoff.constant`) between polls, in seconds                                                                                                                                            |

## Steps

One row per `src/steps/` module; each step takes injected, already-guard-checked
dependencies (never raw `Core.M3LConfig`) and returns its operation's result to
the dispatcher — it never persists `output` or logs a summary itself. This
keeps every step a pure `deps -> result` function, testable with plain values.
`run-codepipeline-ops.ts` resolves and guard-checks the config once, then
**dynamic-imports** (`await import(...)`, not a static import) the matching
step module — the same reason `ecs-ops`'s dispatcher does: so
`steps/*.test.ts` can `vi.mock` a step before dispatch resolves it. Every
mutating pipeline operation (`create-pipeline`/`update-pipeline`/
`delete-pipeline`) routes through `Core.confirmDestructive` first; none of
the remaining 10 operations are gated.

| Step                   | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-codepipeline-ops` | Composition/dispatcher: resolves and guard-checks config per operation (throws `ERR_CODEPIPELINE_OPS_CONFIG`); for `create-pipeline`/`update-pipeline`, reads + JSON-parses `input` here (into a `Record<string, unknown>` — never inside `write-pipeline`, keeping every step a pure `deps -> result` function; throws `ERR_CODEPIPELINE_OPS_INPUT` on a missing/unreadable/malformed file); runs `Core.confirmDestructive` for every mutating pipeline operation (the gate description for `update-pipeline` states the replace-not-patch risk explicitly); dynamic-imports and dispatches to the operation-appropriate step via an exhaustive operation-narrowing chain (a new operation added without a branch fails to compile); persists the returned result to `output` when configured and non-`undefined` (via `Core.M3LJSONFileExporter`, **before** the next check); logs a run summary. For `watch-execution`, throws `ERR_CODEPIPELINE_OPS_WATCH_FAILED` when the resolved `M3LCodePipelineExecution.status` is `Failed`/`Stopped`/`Cancelled` — persisting the result first so the terminal status survives on disk even though the run then fails. `Succeeded` and `Superseded` both complete the run normally.                            |
| `read-pipelines`       | `list-pipelines` (`listPipelines({ nextToken, maxResults })`) and `describe-pipeline` (`getPipeline(pipeline, { version })`) — never gated. Converts a `getPipeline` `undefined` result (the wrapper's `PipelineNotFoundException` signal) into `ERR_CODEPIPELINE_OPS_NOT_FOUND`. Returns the raw `M3LCodePipelineListPipelinesResult` / `M3LCodePipelineDefinition`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `read-state`           | `get-pipeline-state` (`getPipelineState(pipeline)`) — never gated. Converts an `undefined` result into `ERR_CODEPIPELINE_OPS_NOT_FOUND`. Returns the `M3LCodePipelineState` unchanged (a pipeline with zero stages resolves an empty `stageStates` array — the wrapper's own `undefined → []` mapping, not a not-found signal).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `read-executions`      | `list-executions` (`listPipelineExecutions(pipeline, { nextToken, maxResults })`) and `describe-execution` (`getPipelineExecution(pipeline, executionId)`) — never gated. `list-executions` **throws** (never an empty page) when `pipeline` itself does not exist — the wrapper treats a listing call as "operate on this named pipeline". Converts a `describe-execution` `undefined` result into `ERR_CODEPIPELINE_OPS_NOT_FOUND`. Returns the raw `M3LCodePipelineListExecutionsResult` / `M3LCodePipelineExecution`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `write-pipeline`       | Receives the already-parsed declaration record from `run-codepipeline-ops` (never touches the filesystem itself): `create-pipeline`/`update-pipeline` guard-check `name`/`roleArn`/a non-empty `stages` array present (throws `ERR_CODEPIPELINE_OPS_INPUT` if any is missing — every other field is trusted as-is, matching the wrapper's own no-pre-flight-validation stance on everything but its six write-path enum fields) and call `createPipeline`/`updatePipeline`; `delete-pipeline` takes `pipeline` from config (throws `ERR_CODEPIPELINE_OPS_CONFIG` if missing) and calls `deletePipeline` — a no-op success on an already-absent pipeline, per the wrapper's contract. Returns the `M3LCodePipelineDeclaration` for `create`/`update`, `undefined` for `delete`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `execute`              | `start-execution` (`startPipelineExecution(pipeline, { clientRequestToken })`) and `stop-execution` (`stopPipelineExecution({ pipelineName, pipelineExecutionId, abandon, reason })`) — never gated (triggering/stopping is not the destructive-gate's "irreversible mutation" concern the CRUD ops are). `stop-execution` is **not** forgiving of an already-terminal or already-stopping execution — it throws, unlike `delete-pipeline`. Returns `M3LCodePipelineStartExecutionResult` / `M3LCodePipelineStopExecutionResult`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `transitions`          | `enable-stage-transition` (`enableStageTransition({ pipelineName, stageName, transitionType })`) and `disable-stage-transition` (`disableStageTransition({ pipelineName, stageName, transitionType, reason })`) — never gated. Enforces the wrapper's input-type asymmetry: `enable-stage-transition` never sends a `reason` key at all; `disable-stage-transition` requires one (throws `ERR_CODEPIPELINE_OPS_CONFIG` if absent). Both resolve `void`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `watch-execution`      | `watch-execution`: polls `getPipelineExecution(pipeline, executionId)` via `Core.M3LPoller` (`Core.M3LBackoff.constant(waitIntervalSeconds * 1000)`, `maxAttempts: waitMaxAttempts`) until a terminal `PipelineExecutionStatus`. An `undefined` result (the eventual-consistency window right after `start-execution`) continues polling rather than failing. Every terminal status — `Succeeded`, `Failed`, `Stopped`, `Cancelled`, and `Superseded` — resolves the poll successfully with the execution record; this step **never** throws on a failed terminal status (that decision is `run-codepipeline-ops`'s, made after the result is persisted). `Superseded` is logged as a warning — under CodePipeline's default execution mode a later execution can overtake this one without it ever reaching `Succeeded`/`Failed`, and that is routine, not a failure. An unrecognized status string also continues polling (with a warning) rather than being misclassified either way. Exhausting `waitMaxAttempts` while still non-terminal rejects with `Core.M3LError` coded `ERR_POLL_EXHAUSTED` (the poller's own error, uncoded by this script — catch by `.code`, never `instanceof`, since the poller's error classes are internal/unexported). |

### Step signatures (deps object + return type)

Every step takes a single `readonly`-field deps object (never raw
`Core.M3LConfig`) and no step does its own filesystem I/O except
`run-codepipeline-ops` itself:

- `runCodepipelineOps(deps: { config: Core.M3LConfig; paths: Core.M3LPaths; logger: Core.M3LLogger; correlationId: string; operations: AWS.M3LCodePipelineOperations; prompt: Core.M3LPrompt }): Promise<void>`
- `readPipelines(deps: { operations: AWS.M3LCodePipelineOperations; operation: "list-pipelines" | "describe-pipeline"; pipeline: string | undefined; version: number | undefined; nextToken: string | undefined; maxResults: number | undefined }): Promise<M3LCodePipelineListPipelinesResult | M3LCodePipelineDefinition>`
- `readState(deps: { operations: AWS.M3LCodePipelineOperations; pipeline: string }): Promise<M3LCodePipelineState>`
- `readExecutions(deps: { operations: AWS.M3LCodePipelineOperations; operation: "list-executions" | "describe-execution"; pipeline: string; executionId: string | undefined; nextToken: string | undefined; maxResults: number | undefined }): Promise<M3LCodePipelineListExecutionsResult | M3LCodePipelineExecution>`
- `writePipeline(deps: { operations: AWS.M3LCodePipelineOperations; operation: "create-pipeline" | "update-pipeline" | "delete-pipeline"; declaration: Record<string, unknown> | undefined; pipeline: string | undefined }): Promise<M3LCodePipelineDeclaration | undefined>`
- `execute(deps: { operations: AWS.M3LCodePipelineOperations; operation: "start-execution" | "stop-execution"; pipeline: string; executionId: string | undefined; clientRequestToken: string | undefined; abandon: boolean; reason: string | undefined }): Promise<M3LCodePipelineStartExecutionResult | M3LCodePipelineStopExecutionResult>`
- `transitions(deps: { operations: AWS.M3LCodePipelineOperations; operation: "enable-stage-transition" | "disable-stage-transition"; pipeline: string; stage: string; transitionType: M3LCodePipelineStageTransitionType; reason: string | undefined }): Promise<void>`
- `watchExecution(deps: { operations: AWS.M3LCodePipelineOperations; logger: Core.M3LLogger; pipeline: string; executionId: string; waitMaxAttempts: number; waitIntervalSeconds: number }): Promise<M3LCodePipelineExecution>`

Script-local error codes are plain `M3LError.code` strings (the field is an
open `string`, not a closed union — exactly like `ecs-ops`'s
`ERR_ECS_OPS_*`), all prefixed `ERR_CODEPIPELINE_OPS_`:

- `ERR_CODEPIPELINE_OPS_CONFIG` — a guard-checked per-operation requirement
  was unmet (missing `pipeline`/`executionId`/`stage`/`transitionType`/
  `reason`/`input` for an operation that requires it, or `delete-pipeline`'s
  `pipeline`), an unrecognized `operation` (unreachable through the declared
  `oneOf` validator, guarded defensively), a present-but-wrongly-typed value
  (only reachable when a caller — e.g. a test — builds `Core.M3LConfig`
  directly, bypassing the declarative coercion `getConfiguration()` applies),
  or `script.aws` was not provisioned despite declaring `aws.profile`
  (guarded in `main.ts`, the same composition-root pattern
  `ecs-ops`/`cloudformation-stacks` use). **Not** included here: an
  empty-but-present string parameter or an out-of-range numeric parameter —
  those fail earlier at config-load with `M3LConfigValidationError` (see the
  Configuration schema section above).
- `ERR_CODEPIPELINE_OPS_INPUT` — `create-pipeline`/`update-pipeline`'s
  `input` file failed to read, was not valid JSON (via
  `Core.M3LInputFileReader.readJSON` — deliberately never chains the raw
  `SyntaxError` as `cause`, closing fleet-wide finding F10: V8's
  `SyntaxError.message` can embed a snippet of the malformed content), did
  not decode to a JSON object, contained a top-level prototype-pollution
  vector key (`__proto__`/`constructor`/`prototype`), or the parsed
  declaration was missing `name`/`roleArn`/a non-empty `stages` array. The
  reader is constructed with this code specifically (not
  `ERR_CODEPIPELINE_OPS_CONFIG`), preserving the pre-existing CONFIG/INPUT
  split.
- `ERR_CODEPIPELINE_OPS_NOT_FOUND` — a read operation's wrapper call
  resolved `undefined` (`describe-pipeline`, `get-pipeline-state`,
  `describe-execution`) — the wrapper's signal that the modeled
  `*NotFoundException` fired.
- `ERR_CODEPIPELINE_OPS_ABORTED` — the destructive-gate confirmation was
  declined for `create-pipeline`/`update-pipeline`/`delete-pipeline`.
- `ERR_CODEPIPELINE_OPS_WATCH_FAILED` — `watch-execution` resolved a
  `M3LCodePipelineExecution` whose `status` is `Failed`/`Stopped`/
  `Cancelled` — thrown by `run-codepipeline-ops` **after** the result was
  persisted to `output` (when configured). `Succeeded` and `Superseded` do
  not throw.
- `ERR_CODEPIPELINE_OPS_NO_CORRELATION_ID` — thrown by `getCorrelationId()`
  when read before `onBeforeRun` has captured it (mirrors `ecs-ops`'s hook
  guard) — a wiring bug, not a runtime condition.

An `output`-write failure is **not** re-coded: `Core.M3LJSONFileExporter.export()`
already throws a chained `M3LError` (`ERR_JSON_FILE_EXPORT`) on any filesystem
or serialization failure, so it propagates unchanged rather than being wrapped
in a redundant script-local code. A poll exhaustion in `watch-execution` is
similarly not re-coded — `Core.M3LPoller` already throws `M3LError` coded
`ERR_POLL_EXHAUSTED`, and it propagates unchanged.

## Inputs and outputs

- **Reads:** `input` (JSON, a complete `M3LCodePipelineDeclaration`, for
  `create-pipeline`/`update-pipeline`), resolved under `M3L_INPUT_DIR` via
  `M3LPaths.resolveInput`.
- **Writes:** when `output` is configured, the returned result persisted as
  a single JSON document via `Core.M3LJSONFileExporter` under
  `M3L_OUTPUT_DIR` — `M3LCodePipelineListPipelinesResult` for
  `list-pipelines`, `M3LCodePipelineDefinition` for `describe-pipeline`,
  `M3LCodePipelineState` for `get-pipeline-state`,
  `M3LCodePipelineListExecutionsResult` for `list-executions`,
  `M3LCodePipelineExecution` for `describe-execution`/`watch-execution`,
  `M3LCodePipelineDeclaration` for `create-pipeline`/`update-pipeline`,
  `M3LCodePipelineStartExecutionResult`/`M3LCodePipelineStopExecutionResult`
  for `start-execution`/`stop-execution`. `delete-pipeline` and both
  stage-transition operations resolve `undefined` and are never persisted,
  regardless of whether `output` is configured. Omitting `output` logs only
  the run summary below — never the full result.
- **Reports:** a run summary (operation, and — where applicable —
  pipeline/executionId) through the `correlationId`-tagged logger;
  `watch-execution` exits non-zero when the terminal status is
  `Failed`/`Stopped`/`Cancelled`, never silently.

## See also

- [`aws/codepipeline`](../aws/codepipeline.md) — `M3LCodePipelineOperations`,
  the typed wrapper this script dispatches over
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [`core/polling`](../core/polling.md) — `M3LPoller`/`M3LBackoff`, used by `watch-execution`
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
