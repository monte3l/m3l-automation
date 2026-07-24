# ecs-ops

Manage AWS ECS services (list, describe, create, update, delete,
wait-for-stable) and inspect clusters (read-only), over the typed
`M3LECSOperations` wrapper.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/ecs-ops/README.md`](../../../scripts/ecs-ops/README.md).
>
> **Scaffold status:** this script is scaffolded — the config schema and
> steps tables below are the ratified contract, but only the `aws.profile`
> parameter and a starter `run-ecs-ops` step exist in `src/` today.
> `implementing-scripts` fills the remaining config parameters and step
> modules in against this contract.

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
yet (F1b, deferred) — so `run-ecs-ops.ts` guard-checks presence per operation
before any AWS call (mirroring `lambda-ops`'s per-command guard).

| Parameter     | Type     | Default | Validation                                                                                                                                                        | Required for                                                                     | Description                                                                                                                                                         |
| ------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile` | `STRING` | —       | `required: true`, `nonEmpty`                                                                                                                                      | all                                                                              | AWS profile name; declaring it enables the `script.aws` dynamic-provisioning seam (`Core.AWS_PROFILE_PARAM_NAME`)                                                   |
| `operation`   | `STRING` | —       | `required: true`, `oneOf(list-services, describe-service, create-service, update-service, delete-service, wait-services-stable, list-clusters, describe-cluster)` | all                                                                              | Selects which of the 8 `M3LECSOperations` methods this run dispatches                                                                                               |
| `cluster`     | `STRING` | —       | `nonEmpty` (guard-checked)                                                                                                                                        | `describe-service`, `delete-service`, `wait-services-stable`, `describe-cluster` | Cluster name or ARN scoping the target service(s)/cluster                                                                                                           |
| `service`     | `STRING` | —       | `nonEmpty` (guard-checked)                                                                                                                                        | `describe-service`, `delete-service`                                             | The single target service's name or ARN                                                                                                                             |
| `services`    | `STRING` | —       | `nonEmpty` (guard-checked); comma-separated                                                                                                                       | `wait-services-stable`                                                           | One or more service names/ARNs to wait on, split on `,` and trimmed                                                                                                 |
| `input`       | `STRING` | —       | `nonEmpty` (guard-checked)                                                                                                                                        | `create-service`, `update-service`                                               | Path resolved via `M3LPaths.resolveInput` to a JSON file: the `M3LECSCreateServiceInput`/`M3LECSUpdateServiceInput` fields                                          |
| `nextToken`   | `STRING` | —       | `nonEmpty` (guard-checked)                                                                                                                                        | `list-services`, `list-clusters` (optional)                                      | Continuation token from a previous page's `nextToken`, forwarded to `listServices({ nextToken })`/`listClusters({ nextToken })`                                     |
| `force`       | `BOOL`   | `false` | —                                                                                                                                                                 | `delete-service` (optional)                                                      | Forwarded to `deleteService(cluster, service, force)` — forces deletion without scaling to 0 first                                                                  |
| `maxWaitTime` | `INT`    | —       | `range(1, 3600)` (guard-checked when set)                                                                                                                         | `wait-services-stable` (optional)                                                | Forwarded to `waitUntilServicesStable`'s `options.maxWaitTime`; the wrapper itself defaults to 600s when omitted, so this script only forwards an explicit override |
| `output`      | `STRING` | —       | `nonEmpty` (guard-checked)                                                                                                                                        | all (optional)                                                                   | Path resolved via `M3LPaths.resolveOutput`; when set, the operation's result is persisted as a single JSON document                                                 |
| `yes`         | `BOOL`   | `false` | —                                                                                                                                                                 | any mutating operation (optional)                                                | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                                                       |

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

| Step               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-ecs-ops`      | Composition/dispatcher: resolves and guard-checks config per operation (throws `ERR_ECS_OPS_CONFIG`), runs `destructive-gate` for every mutating operation, dynamic-imports and dispatches to the operation-appropriate step with already-resolved typed values, persists the returned result to `output` when configured (via `Core.M3LJSONFileExporter`, **before** the next check), and logs a run summary. For `wait-services-stable`, throws `ERR_ECS_OPS_WAIT_NOT_STABLE` when the resolved `M3LECSWaiterResult.state` is not `"SUCCESS"` — persisting the result first so the timeout/abort reason survives on disk even though the run then fails. |
| `destructive-gate` | Shared confirmation step (mirrors `lambda-ops`'s): prints the target operation + cluster/service, prompts via `script.prompt.confirm(description)`, and throws `ERR_ECS_OPS_ABORTED` when declined; bypassed by `yes` (bypass logged as a warning so an unattended run still leaves an audit trail).                                                                                                                                                                                                                                                                                                                                                       |
| `read-services`    | `list-services` (`listServices({ cluster, nextToken })`) and `describe-service` (`describeService(cluster, service)`) — never gated. Returns the raw `M3LECSListServicesResult` / `M3LECSServiceDescription`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `write-service`    | `create-service` (reads + parses `input` as `M3LECSCreateServiceInput`, calls `createService`), `update-service` (reads + parses `input` as `M3LECSUpdateServiceInput`, calls `updateService`), `delete-service` (calls `deleteService(cluster, service, force)`).                                                                                                                                                                                                                                                                                                                                                                                         |
| `wait-services`    | `wait-services-stable`: calls `waitUntilServicesStable(cluster, services, { maxWaitTime })`, returns the `M3LECSWaiterResult` unchanged — it does **not** itself inspect or throw on a non-`SUCCESS` state; that is `run-ecs-ops`'s decision to make, once the result has flowed back to the dispatcher.                                                                                                                                                                                                                                                                                                                                                   |
| `read-clusters`    | `list-clusters` (`listClusters({ nextToken })`) and `describe-cluster` (`describeCluster(cluster)`) — never gated, read-only context. Returns the raw `M3LECSListClustersResult` / `M3LECSClusterSummary`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Script-local error codes are plain `M3LError.code` strings (the field is an
open `string`, not a closed union — exactly like `lambda-ops`'s
`ERR_LAMBDA_OPS_*`), all prefixed `ERR_ECS_OPS_`:

- `ERR_ECS_OPS_CONFIG` — a guard-checked per-operation requirement was unmet
  (missing `cluster`/`service`/`services`/`input` for an operation that
  requires it, or a malformed `input`/`services` value), an unrecognized
  `operation` (unreachable through the declared `oneOf` validator, guarded
  defensively), or `script.aws` was not provisioned despite declaring
  `aws.profile` (guarded in `main.ts`, the same composition-root pattern
  `lambda-ops`/`dynamodb-crud` use).
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
