# ecs-ops

Manage AWS ECS services (list, describe, create, update, delete,
wait-for-stable) and inspect clusters (read-only), over the typed
`M3LECSOperations` wrapper.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/ecs-ops/README.md`](../../../scripts/ecs-ops/README.md).

## Purpose and scope

Control-plane operations over AWS ECS (roadmap W3): 8 operations spanning
**ECS services** (the deployable unit — full list/describe/create/update/
delete plus a stabilization wait) and **read-only cluster context**
(list/describe), dispatched over the library's `AWS.M3LECSOperations`
wrapper — never a hand-constructed `@aws-sdk/client-ecs` client (ADR-0029).
`create-service`/`update-service`/`delete-service` are gated behind the shared
destructive-operation confirmation convention used by the other W2/W3
scripts; the remaining 5 operations (reads plus the stabilization wait) are
not gated.

Out of scope, matching the wrapper's own v1 boundary
([`docs/reference/aws/ecs.md`](../aws/ecs.md) § Out of scope): cluster
mutation (create/update/delete), task-definition registration/deregistration,
and task-level operations (run/stop/list/describe tasks). A consumer needing
any of those waits for a future revision of the wrapper this script
dispatches over.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness (the "Required for" column) is **not**
expressed by `M3LConfigParameter({ required: true })` beyond `aws.profile`/
`operation` — the library has no cross-parameter/conditional-required seam
yet (F1b, deferred) — so `run-ecs-ops.ts` guard-checks **presence** per
operation before any AWS call (mirroring `lambda-ops`'s per-command guard).

**Two distinct validation mechanisms are in play — do not conflate them:**
the "Validation" column below is a **declarative `validate:` factory
attached in `config.ts`**, evaluated by `M3LConfigParameter` at
`getConfiguration()` time — it fires only when the provider resolves a raw
value for that parameter (an `undefined`/absent optional parameter never runs
its validator, confirmed against
`M3LConfigParameter.getValueAsync`). An **empty-but-present** `cluster`/
`service`/etc. or an **out-of-range** `maxWaitTime` therefore fails at
config-load with `M3LConfigValidationError` — **not** `ERR_ECS_OPS_CONFIG`.
`run-ecs-ops.ts`'s own guard (the "Required for" column) checks only
**absence** (`undefined`) of a parameter a given operation needs, and throws
`ERR_ECS_OPS_CONFIG` for that. A test building `Core.M3LConfig` directly
(bypassing declarative validation, as `lambda-ops`'s tests do) can still pass
an empty string through to the guard, which only re-checks type/presence, not
emptiness — match that behavior.

| Parameter     | Type     | Default | Declarative `validate:`                                                                                                                                           | Required for                                                                     | Description                                                                                                                                                               |
| ------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile` | `STRING` | —       | `required: true`, `nonEmpty`                                                                                                                                      | all                                                                              | AWS profile name; declaring it enables the `script.aws` dynamic-provisioning seam (`Core.AWS_PROFILE_PARAM_NAME`)                                                         |
| `operation`   | `STRING` | —       | `required: true`, `oneOf(list-services, describe-service, create-service, update-service, delete-service, wait-services-stable, list-clusters, describe-cluster)` | all                                                                              | Selects which of the 8 `M3LECSOperations` methods this run dispatches                                                                                                     |
| `cluster`     | `STRING` | —       | `nonEmpty`                                                                                                                                                        | `describe-service`, `delete-service`, `wait-services-stable`, `describe-cluster` | Cluster name or ARN scoping the target service(s)/cluster; presence guard-checked by `run-ecs-ops`                                                                        |
| `service`     | `STRING` | —       | `nonEmpty`                                                                                                                                                        | `describe-service`, `delete-service`                                             | The single target service's name or ARN; presence guard-checked by `run-ecs-ops`                                                                                          |
| `services`    | `STRING` | —       | `nonEmpty`; comma-separated                                                                                                                                       | `wait-services-stable`                                                           | One or more service names/ARNs to wait on. `run-ecs-ops` splits on `,`, trims each segment, and drops empty segments; if the result is empty, throws `ERR_ECS_OPS_CONFIG` |
| `input`       | `STRING` | —       | `nonEmpty`                                                                                                                                                        | `create-service`, `update-service`                                               | Path resolved via `M3LPaths.resolveInput` to a JSON file: the `M3LECSCreateServiceInput`/`M3LECSUpdateServiceInput` fields                                                |
| `nextToken`   | `STRING` | —       | `nonEmpty`                                                                                                                                                        | `list-services`, `list-clusters` (optional)                                      | Continuation token from a previous page's `nextToken`, forwarded to `listServices({ nextToken })`/`listClusters({ nextToken })`                                           |
| `force`       | `BOOL`   | `false` | —                                                                                                                                                                 | `delete-service` (optional)                                                      | Forwarded to `deleteService(cluster, service, force)` — forces deletion without scaling to 0 first                                                                        |
| `maxWaitTime` | `INT`    | —       | `range(1, 3600)` — fires only when the caller sets a value (no `defaultValue`); safe on an optional field that seven of eight operations leave unset              | `wait-services-stable` (optional)                                                | Forwarded to `waitUntilServicesStable`'s `options.maxWaitTime`; the wrapper itself defaults to 600s when omitted, so this script only forwards an explicit override       |
| `output`      | `STRING` | —       | `nonEmpty`                                                                                                                                                        | all (optional)                                                                   | Path resolved via `M3LPaths.resolveOutput`; when set, the operation's result is persisted as a single JSON document                                                       |
| `yes`         | `BOOL`   | `false` | —                                                                                                                                                                 | any mutating operation (optional)                                                | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                                                             |

## Steps

One row per `src/steps/` module; each step takes injected, already-guard-checked
dependencies (never raw `Core.M3LConfig`) and returns its operation's result to
the dispatcher — it never persists `output` or logs a summary itself. This
keeps every step a pure `deps -> result` function, testable with plain values.
`run-ecs-ops.ts` resolves and guard-checks the config once, then
**dynamic-imports** (`await import(...)`, not a static import) the matching
step module — the same reason `lambda-ops`'s dispatcher does: so
`steps/*.test.ts` can `vi.mock` a step before dispatch resolves it. Every
mutating operation (`create-service`/`update-service`/`delete-service`) routes
through `destructive-gate` first.

| Step               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run-ecs-ops`      | Composition/dispatcher: resolves and guard-checks config per operation (throws `ERR_ECS_OPS_CONFIG`); for `create-service`/`update-service`, reads + JSON-parses `input` here (into a `Record<string, unknown>` — never inside `write-service`, keeping every step a pure `deps -> result` function); runs `destructive-gate` for every mutating operation; dynamic-imports and dispatches to the operation-appropriate step with already-resolved typed values; persists the returned result to `output` when configured (via `Core.M3LJSONFileExporter`, **before** the next check); logs a run summary. For `wait-services-stable`, throws `ERR_ECS_OPS_WAIT_NOT_STABLE` when the resolved `M3LECSWaiterResult.state` is not `"SUCCESS"` — persisting the result first so the timeout/abort reason survives on disk even though the run then fails. |
| `destructive-gate` | Shared confirmation step (mirrors `lambda-ops`'s): prompts via `prompt.confirm(description)` and throws `ERR_ECS_OPS_ABORTED` when declined; bypassed by `yes` (bypass logged as a warning so an unattended run still leaves an audit trail). `run-ecs-ops` builds `description` before calling this step — for `delete-service`, from the `cluster`/`service` config values; for `create-service`/`update-service` (whose target lives in the already-parsed `input` record, not a config param), a **best-effort** read of `record.serviceName ?? record.service` and `record.cluster` from the parsed JSON, falling back to a generic `"(see input file)"` phrase when absent — this is informational only, not a validation step, since full required-field enforcement happens inside `write-service` after confirmation.                         |
| `read-services`    | `list-services` (`listServices({ cluster, nextToken })`) and `describe-service` (`describeService(cluster, service)`) — never gated. Returns the raw `M3LECSListServicesResult` / `M3LECSServiceDescription`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `write-service`    | Receives the already-parsed `input` record from `run-ecs-ops` (never touches the filesystem itself): `create-service` narrows/validates it into `M3LECSCreateServiceInput` (requires `cluster`, `serviceName`, `taskDefinition` — throws `ERR_ECS_OPS_CONFIG` if any is missing) and calls `createService`; `update-service` narrows into `M3LECSUpdateServiceInput` (requires `cluster`, `service`) and calls `updateService`; `delete-service` takes `cluster`/`service`/`force` from config and calls `deleteService`. Returns the `M3LECSServiceDescription` for all three.                                                                                                                                                                                                                                                                        |
| `wait-services`    | `wait-services-stable`: calls `waitUntilServicesStable(cluster, services, { maxWaitTime })`, returns the `M3LECSWaiterResult` unchanged — it does **not** itself inspect or throw on a non-`SUCCESS` state; that is `run-ecs-ops`'s decision to make, once the result has flowed back to the dispatcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `read-clusters`    | `list-clusters` (`listClusters({ nextToken })`) and `describe-cluster` (`describeCluster(cluster)`) — never gated, read-only context. Returns the raw `M3LECSListClustersResult` / `M3LECSClusterSummary`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Step signatures (deps object + return type)

Every step takes a single `readonly`-field deps object (never raw
`Core.M3LConfig`) and no step does its own filesystem I/O except
`run-ecs-ops` itself:

- `runEcsOps(deps: { config: Core.M3LConfig; paths: Core.M3LPaths; logger: Core.M3LLogger; correlationId: string; operations: AWS.M3LECSOperations; prompt: Core.M3LPrompt }): Promise<void>`
- `destructiveGate(deps: { prompt: Core.M3LPrompt; logger: Core.M3LLogger; description: string; yes: boolean }): Promise<void>`
- `readServices(deps: { operations: AWS.M3LECSOperations; operation: "list-services" | "describe-service"; cluster: string | undefined; service: string | undefined; nextToken: string | undefined }): Promise<M3LECSListServicesResult | M3LECSServiceDescription>`
- `writeService(deps: { operations: AWS.M3LECSOperations; operation: "create-service" | "update-service" | "delete-service"; input: Record<string, unknown> | undefined; cluster: string | undefined; service: string | undefined; force: boolean }): Promise<M3LECSServiceDescription>`
- `waitServices(deps: { operations: AWS.M3LECSOperations; cluster: string; services: readonly string[]; maxWaitTime: number | undefined }): Promise<M3LECSWaiterResult>`
- `readClusters(deps: { operations: AWS.M3LECSOperations; operation: "list-clusters" | "describe-cluster"; cluster: string | undefined; nextToken: string | undefined }): Promise<M3LECSListClustersResult | M3LECSClusterSummary>`

Script-local error codes are plain `M3LError.code` strings (the field is an
open `string`, not a closed union — exactly like `lambda-ops`'s
`ERR_LAMBDA_OPS_*`), all prefixed `ERR_ECS_OPS_`:

- `ERR_ECS_OPS_CONFIG` — a guard-checked per-operation requirement was unmet
  (missing `cluster`/`service`/`services`/`input` for an operation that
  requires it, an `input` file that fails to read (mirrors `lambda-ops`'s
  `readInputFileText` treatment of a missing file), an `input` that is not
  valid JSON or does not decode to a JSON object, an `input` missing a
  required create/update field, or a `services` value that is empty after
  split+trim+drop-empty), an unrecognized `operation` (unreachable through the
  declared `oneOf` validator, guarded defensively), or `script.aws` was not
  provisioned despite declaring `aws.profile` (guarded in `main.ts`, the same
  composition-root pattern `lambda-ops`/`dynamodb-crud` use). **Not** included
  here: an empty-but-present string parameter or an out-of-range `maxWaitTime`
  — those fail earlier at config-load with `M3LConfigValidationError` (see
  the Configuration schema section above).
- `ERR_ECS_OPS_ABORTED` — the destructive-gate confirmation was declined.
- `ERR_ECS_OPS_WAIT_NOT_STABLE` — `wait-services-stable` resolved a
  `M3LECSWaiterResult` whose `state` is `"TIMEOUT"` or `"ABORTED"` (a genuine
  `FAILURE`/call-failure case already throws `M3LECSOperationError` from the
  wrapper and propagates unchanged, per
  [`docs/reference/aws/ecs.md`](../aws/ecs.md)).
- `ERR_ECS_OPS_NO_CORRELATION_ID` — thrown by `getCorrelationId()` when read
  before `onBeforeRun` has captured it (mirrors `lambda-ops`'s hook guard) — a
  wiring bug, not a runtime condition.

An `output`-write failure is **not** re-coded: `Core.M3LJSONFileExporter.export()`
already throws a chained `M3LError` (`ERR_JSON_FILE_EXPORT`) on any filesystem
or serialization failure, so it propagates unchanged rather than being wrapped
in a redundant script-local code.

## Inputs and outputs

- **Reads:** `input` (JSON, for `create-service`/`update-service`), resolved
  under `M3L_INPUT_DIR` via `M3LPaths.resolveInput`.
- **Writes:** when `output` is configured, the returned result persisted as a
  single JSON document via `Core.M3LJSONFileExporter` under `M3L_OUTPUT_DIR` —
  `M3LECSListServicesResult` for `list-services`, `M3LECSServiceDescription`
  for `describe-service`/`create-service`/`update-service`/`delete-service`,
  `M3LECSWaiterResult` for `wait-services-stable`, `M3LECSListClustersResult`
  for `list-clusters`, or `M3LECSClusterSummary` for `describe-cluster`.
  Omitting `output` logs only the run summary below — never the full result.
- **Reports:** a run summary (operation, cluster, and — where applicable —
  service/services) through the `correlationId`-tagged logger;
  `wait-services-stable` exits non-zero when the wait did not resolve
  `SUCCESS`, never silently.

## See also

- [`aws/ecs`](../aws/ecs.md) — `M3LECSOperations`, the typed wrapper this
  script dispatches over
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
