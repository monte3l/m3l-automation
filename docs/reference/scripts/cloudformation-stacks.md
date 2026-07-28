# cloudformation-stacks

Manage AWS CloudFormation stacks (list, describe, create, update, delete,
stack-event streaming) and their lifecycle waiters, over the typed
`M3LCloudFormationOperations` wrapper.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/cloudformation-stacks/README.md`](../../../scripts/cloudformation-stacks/README.md).

## Purpose and scope

Control-plane operations over AWS CloudFormation **stacks** (roadmap W3): 9
operations — full stack CRUD, stack-event streaming, and the three
stack-lifecycle waiters (create/update/delete-complete) — dispatched over the
library's `AWS.M3LCloudFormationOperations` wrapper, never a hand-constructed
`@aws-sdk/client-cloudformation` client (ADR-0029). `create-stack`/
`update-stack`/`delete-stack` are gated behind the shared destructive-operation
confirmation convention (`Core.confirmDestructive`) used by the other W2/W3
scripts; the remaining 6 operations (reads, events, and the three waits) are
not gated.

Out of scope, matching the wrapper's own v1 boundary
([`docs/reference/aws/cloudformation.md`](../aws/cloudformation.md) § Out of
scope): change sets, stack sets, drift detection, stack refactor, template
validation/estimation, and stack-policy management. A consumer needing any of
those waits for a future revision of the wrapper this script dispatches over.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness (the "Required for" column) is **not**
expressed by `M3LConfigParameter({ required: true })` beyond `aws.profile`/
`operation` — the library has no cross-parameter/conditional-required seam yet
(F1b, deferred) — so `run-cloudformation-stacks.ts` guard-checks **presence**
per operation before any AWS call (mirroring `ecs-ops`'s per-command guard).

**Two distinct validation mechanisms are in play — do not conflate them:** the
"Declarative `validate:`" column below is attached in `config.ts` and evaluated
by `M3LConfigParameter` at `getConfiguration()` time — it fires only when the
provider resolves a raw value for that parameter (an `undefined`/absent
optional parameter never runs its validator). An **empty-but-present**
`stackName`/`input`/etc. or an **out-of-range** `maxWaitTime` therefore fails at
config-load with `M3LConfigValidationError` — **not**
`ERR_CLOUDFORMATION_STACKS_CONFIG`. The dispatcher's own guard (the "Required
for" column) checks only **absence** (`undefined`) of a parameter a given
operation needs. A test building `Core.M3LConfig` directly (bypassing
declarative validation, as `ecs-ops`'s tests do) can still pass an empty
string through to the guard, which only re-checks type/presence, not
emptiness — match that behavior.

**`stackName` sourcing differs by operation**, mirroring `ecs-ops`'s `cluster`/
`service` split: for `describe-stack`, `delete-stack`,
`describe-stack-events`, and the three `wait-stack-*-complete` operations, the
target stack comes from the flat `stackName` config parameter. For
`create-stack`/`update-stack`, `stackName` is instead a **required field of the
`input` JSON record** (`M3LCloudFormationCreateStackInput`/`UpdateStackInput`
both declare it) — the flat `stackName` parameter is not read for those two
operations. Likewise `roleArn`/`retainResources` are flat config parameters
used only by `delete-stack` (whose SDK call takes them as loose options, not a
JSON record); `create-stack`/`update-stack` carry their own `roleArn` inside the
`input` record instead.

| Parameter           | Type     | Default | Declarative `validate:`                                                                                                                                                                                     | Required for                                                                                                                                        | Description                                                                                                                                                            |
| ------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`       | `STRING` | —       | `required: true`, `nonEmpty`                                                                                                                                                                                | all                                                                                                                                                 | AWS profile name; declaring it enables the `script.aws` dynamic-provisioning seam (`Core.AWS_PROFILE_PARAM_NAME`)                                                      |
| `operation`         | `STRING` | —       | `required: true`, `oneOf(list-stacks, describe-stack, describe-stack-events, create-stack, update-stack, delete-stack, wait-stack-create-complete, wait-stack-update-complete, wait-stack-delete-complete)` | all                                                                                                                                                 | Selects which of the 9 `M3LCloudFormationOperations` methods this run dispatches                                                                                       |
| `stackName`         | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                  | `describe-stack`, `delete-stack`, `describe-stack-events`, `wait-stack-create-complete`, `wait-stack-update-complete`, `wait-stack-delete-complete` | Target stack name or ID; **not** read for `create-stack`/`update-stack` (see above) or `list-stacks`                                                                   |
| `input`             | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                  | `create-stack`, `update-stack`                                                                                                                      | Path resolved via `M3LPaths.resolveInput` to a JSON file: the `M3LCloudFormationCreateStackInput`/`UpdateStackInput` fields, including `stackName`                     |
| `template`          | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                  | `create-stack`, `update-stack` (optional)                                                                                                           | Path resolved via `M3LPaths.resolveInput` to a template file; its contents fill `templateBody` when the `input` record sets neither `templateBody` nor `templateUrl`   |
| `stackStatusFilter` | `STRING` | —       | `nonEmpty`; comma-separated                                                                                                                                                                                 | `list-stacks` (optional)                                                                                                                            | Status values to filter by; split on `,`, trimmed, empty segments dropped, forwarded to `listStacks({ stackStatusFilter })`                                            |
| `retainResources`   | `STRING` | —       | `nonEmpty`; comma-separated                                                                                                                                                                                 | `delete-stack` (optional)                                                                                                                           | Logical resource IDs to retain; split/trim/drop-empty, forwarded to `deleteStack(stackName, { retainResources })`                                                      |
| `roleArn`           | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                  | `delete-stack` (optional)                                                                                                                           | IAM role ARN CloudFormation assumes for the deletion; forwarded to `deleteStack`'s options — `create-stack`/`update-stack` set their own `roleArn` inside `input`      |
| `nextToken`         | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                  | `list-stacks`, `describe-stack-events` (optional)                                                                                                   | Continuation token from a previous page's `nextToken`                                                                                                                  |
| `maxWaitTime`       | `INT`    | —       | `range(1, 3600)` — fires only when the caller sets a value (no `defaultValue`); safe on an optional field six of nine operations leave unset                                                                | the three `wait-stack-*-complete` operations (optional)                                                                                             | Forwarded to the waiter's `options.maxWaitTime`; the wrapper itself defaults to 3600s when omitted, so this script only forwards an explicit override                  |
| `output`            | `STRING` | —       | `nonEmpty`                                                                                                                                                                                                  | all except `delete-stack` (optional)                                                                                                                | Path resolved via `M3LPaths.resolveOutput`; when set, the operation's result is persisted as a single JSON document. `delete-stack` resolves `void` — nothing to write |
| `yes`               | `BOOL`   | `false` | —                                                                                                                                                                                                           | `create-stack`, `update-stack`, `delete-stack` (optional)                                                                                           | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                                                          |

## Steps

One row per `src/steps/` module; each step takes injected, already-guard-checked
dependencies (never raw `Core.M3LConfig`) and returns its operation's result to
the dispatcher — it never persists `output` or logs a summary itself. This
keeps every step a pure `deps -> result` function, testable with plain values.
`run-cloudformation-stacks.ts` resolves and guard-checks the config once, then
**dynamic-imports** (`await import(...)`, not a static import) the matching
step module — the same reason `ecs-ops`'s dispatcher does: so `steps/*.test.ts`
can `vi.mock` a step before dispatch resolves it. Every mutating operation
(`create-stack`/`update-stack`/`delete-stack`) routes through
`Core.confirmDestructive` first.

| Step                        | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-cloudformation-stacks` | Composition/dispatcher: resolves and guard-checks config per operation (throws `ERR_CLOUDFORMATION_STACKS_CONFIG`); for `create-stack`/`update-stack`, reads + JSON-parses `input` (into a `Record<string, unknown>`), then — **before ever touching the template file** — checks for a conflict: if `template` is set **and** the record already sets `templateBody` or `templateUrl`, throws `ERR_CLOUDFORMATION_STACKS_CONFIG` without attempting the template-file read. Only when no conflict exists and `template` is set does it read the template file's text; runs `Core.confirmDestructive` for every mutating operation; dynamic-imports and dispatches to the operation-appropriate step with already-resolved typed values. Two distinct check-then-persist orderings apply, one per operation family: for `describe-stack`, the `NOT_FOUND` check runs **first** — `ERR_CLOUDFORMATION_STACKS_NOT_FOUND` is thrown as soon as the step resolves `undefined`, before any persistence is attempted, since there is no result object to persist in that case. For the three wait operations, the ordering is reversed — `output` (when configured) is persisted **first** via `Core.M3LJSONFileExporter`, and only then does the dispatcher throw `ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE` if `M3LCloudFormationWaiterResult.state` is not `"SUCCESS"`, so the timeout/abort reason survives on disk even though the run then fails. Every other operation simply persists a non-`void` result to `output` when configured, with nothing further to check, then logs a run summary. |
| `read-stacks`               | `list-stacks` (`listStacks({ stackStatusFilter, nextToken })`) and `describe-stack` (`describeStack(stackName)`) — never gated. Returns the raw `M3LCloudFormationListStacksResult` / `M3LCloudFormationStack \| undefined` (the wrapper's own does-not-exist classification; see [`aws/cloudformation`](../aws/cloudformation.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `read-stack-events`         | `describe-stack-events` (`describeStackEvents(stackName, { nextToken })`) — never gated, read-only. Returns the raw `M3LCloudFormationDescribeStackEventsResult`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `write-stack`               | Receives the already-parsed `input` record and (for `create-stack`/`update-stack`) the already-read template text from `run-cloudformation-stacks` (never touches the filesystem itself): `create-stack` narrows/validates the record into `M3LCloudFormationCreateStackInput` (requires `stackName`; injects `templateBody` from the template text when the record set neither template field) and calls `createStack`; `update-stack` does the same into `M3LCloudFormationUpdateStackInput` and calls `updateStack` — its result may legitimately be `{ changed: false }` (a no-op success, not an error); `delete-stack` takes `stackName`/`retainResources`/`roleArn` from config (no `input` record involved) and calls `deleteStack`, returning `void`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `wait-stack`                | The three `wait-stack-*-complete` operations: calls `waitUntilStackCreateComplete`/`UpdateComplete`/`DeleteComplete(stackName, { maxWaitTime })`, returns the `M3LCloudFormationWaiterResult` unchanged — it does **not** itself inspect or throw on a non-`SUCCESS` state; that is `run-cloudformation-stacks`'s decision to make, once the result has flowed back to the dispatcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Step signatures (deps object + return type)

Every step takes a single `readonly`-field deps object (never raw
`Core.M3LConfig`) and no step does its own filesystem I/O except
`run-cloudformation-stacks` itself:

- `runCloudformationStacks(deps: { config: Core.M3LConfig; paths: Core.M3LPaths; logger: Core.M3LLogger; correlationId: string; operations: AWS.M3LCloudFormationOperations; prompt: Core.M3LPrompt }): Promise<void>`
- `readStacks(deps: { operations: AWS.M3LCloudFormationOperations; operation: "list-stacks" | "describe-stack"; stackName: string | undefined; stackStatusFilter: readonly string[] | undefined; nextToken: string | undefined }): Promise<M3LCloudFormationListStacksResult | M3LCloudFormationStack | undefined>`
- `readStackEvents(deps: { operations: AWS.M3LCloudFormationOperations; stackName: string; nextToken: string | undefined }): Promise<M3LCloudFormationDescribeStackEventsResult>`
- `writeStack(deps: { operations: AWS.M3LCloudFormationOperations; operation: "create-stack" | "update-stack" | "delete-stack"; input: Record<string, unknown> | undefined; templateText: string | undefined; stackName: string | undefined; retainResources: readonly string[] | undefined; roleArn: string | undefined }): Promise<M3LCloudFormationCreateStackResult | M3LCloudFormationUpdateStackResult | void>`
- `waitStack(deps: { operations: AWS.M3LCloudFormationOperations; operation: "wait-stack-create-complete" | "wait-stack-update-complete" | "wait-stack-delete-complete"; stackName: string; maxWaitTime: number | undefined }): Promise<M3LCloudFormationWaiterResult>`

Script-local error codes are plain `M3LError.code` strings (the field is an
open `string`, not a closed union — exactly like `ecs-ops`'s `ERR_ECS_OPS_*`),
all prefixed `ERR_CLOUDFORMATION_STACKS_`:

- `ERR_CLOUDFORMATION_STACKS_CONFIG` — a guard-checked per-operation
  requirement was unmet (missing `stackName`/`input` for an operation that
  requires it, an `input` file that fails to read, is not valid JSON (via
  `Core.M3LInputFileReader.readJSON` — deliberately never chains the raw
  `SyntaxError` as `cause`, closing fleet-wide finding F10: V8's
  `SyntaxError.message` can embed a snippet of the malformed content), does
  not decode to a JSON object, or contains a top-level prototype-pollution
  vector key (`__proto__`/`constructor`/`prototype`), an `input` missing a required create/update
  field, a `template` config set alongside an `input` record that already sets
  `templateBody`/`templateUrl` (conflict), a `template` file that fails to
  read, a `stackStatusFilter`/`retainResources` value that is empty after
  split+trim+drop-empty, an unrecognized `operation` (unreachable through the
  declared `oneOf` validator, guarded defensively)), or `script.aws` was not
  provisioned despite declaring `aws.profile` (guarded in `main.ts`, the same
  composition-root pattern `ecs-ops`/`lambda-ops` use). **Not** included here:
  an empty-but-present string parameter or an out-of-range `maxWaitTime` —
  those fail earlier at config-load with `M3LConfigValidationError` (see the
  Configuration schema section above).
- `ERR_CLOUDFORMATION_STACKS_ABORTED` — the destructive-gate confirmation was
  declined.
- `ERR_CLOUDFORMATION_STACKS_NOT_FOUND` — `describe-stack` resolved
  `undefined` (the wrapper's does-not-exist classification for a
  `ValidationError`; see [`aws/cloudformation`](../aws/cloudformation.md)). A
  run that explicitly asked to describe a named stack treats its absence as a
  failure, unlike the wrapper itself, which treats it as data.
- `ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE` — a `wait-stack-*-complete`
  operation resolved a `M3LCloudFormationWaiterResult` whose `state` is
  `"TIMEOUT"` or `"ABORTED"` (a genuine call failure already throws
  `M3LCloudFormationOperationError` from the wrapper and propagates unchanged).
- `ERR_CLOUDFORMATION_STACKS_NO_CORRELATION_ID` — thrown by
  `getCorrelationId()` when read before `onBeforeRun` has captured it (mirrors
  `ecs-ops`'s hook guard) — a wiring bug, not a runtime condition.

An `output`-write failure is **not** re-coded: `Core.M3LJSONFileExporter.export()`
already throws a chained `M3LError` (`ERR_JSON_FILE_EXPORT`) on any filesystem
or serialization failure, so it propagates unchanged rather than being wrapped
in a redundant script-local code.

## Inputs and outputs

- **Reads:** `input` (JSON, for `create-stack`/`update-stack`) and `template`
  (plain text, optional, for the same two operations), both resolved under
  `M3L_INPUT_DIR` via `M3LPaths.resolveInput`.
- **Writes:** when `output` is configured, the returned result persisted as a
  single JSON document via `Core.M3LJSONFileExporter` under `M3L_OUTPUT_DIR` —
  `M3LCloudFormationListStacksResult` for `list-stacks`, `M3LCloudFormationStack`
  for `describe-stack`, `M3LCloudFormationDescribeStackEventsResult` for
  `describe-stack-events`, `M3LCloudFormationCreateStackResult` for
  `create-stack`, `M3LCloudFormationUpdateStackResult` for `update-stack`, or
  `M3LCloudFormationWaiterResult` for the three wait operations. `delete-stack`
  resolves `void` — there is nothing to persist. Omitting `output` logs only
  the run summary below — never the full result.
- **Reports:** a run summary (operation and, where applicable, stack name)
  through the `correlationId`-tagged logger; a wait operation exits non-zero
  when the wait did not resolve `SUCCESS`, never silently.

## See also

- [`aws/cloudformation`](../aws/cloudformation.md) — `M3LCloudFormationOperations`,
  the typed wrapper this script dispatches over
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
