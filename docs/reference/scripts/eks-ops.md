# eks-ops

Operate AWS EKS **control-plane** clusters and nodegroups — list, describe,
create, update, delete, and wait for lifecycle transitions — over the typed
`M3LEKSOperations` wrapper.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/eks-ops/README.md`](../../../scripts/eks-ops/README.md).

## Purpose and scope

Control-plane operations over AWS EKS (roadmap W4, closing the wave): 16
operations spanning **clusters** (list/describe/create/update-config/
update-version/delete plus an active/deleted lifecycle wait) and
**nodegroups** (the same six-shape set, scoped to one cluster), dispatched
over the library's `AWS.M3LEKSOperations` wrapper — never a hand-constructed
`@aws-sdk/client-eks` client (ADR-0029). The six mutating operations per
resource kind (`create-*`/`update-*-config`/`update-*-version`/`delete-*`) are
gated behind the shared destructive-operation confirmation convention
(`Core.confirmDestructive`, W5); the eight read/wait operations are not.

Out of scope, matching the wrapper's own v1 boundary
([`docs/reference/aws/eks.md`](../aws/eks.md)): kubectl-level workload
operations (pods/deployments/services), Fargate profiles, and access-entry
management — all out of scope for the control-plane-listing/creation use case
this wrapper and script serve.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness (the "Required for" column) is **not**
expressed by `M3LConfigParameter({ required: true })` beyond `aws.profile`/
`operation` — the library has no cross-parameter/conditional-required seam
yet (F1b, deferred) — so `run-eks-ops.ts` guard-checks **presence** per
operation before any AWS call (mirroring `ecs-ops`'s per-command guard).

**Two distinct validation mechanisms are in play — do not conflate them:**
the "Declarative `validate:`" column is a **factory attached in `config.ts`**,
evaluated by `M3LConfigParameter` at `getConfiguration()` time — it fires only
when the provider resolves a raw value for that parameter (an `undefined`/
absent optional parameter never runs its validator). An **empty-but-present**
`cluster`/`nodegroup`/etc. or an **out-of-range** `maxResults`/`maxWaitTime`
therefore fails at config-load with `M3LConfigValidationError` — **not**
`ERR_EKS_OPS_CONFIG`. `run-eks-ops.ts`'s own guard checks only **absence**
(`undefined`) of a parameter a given operation needs.

Only `create-cluster`/`update-cluster-config`/`create-nodegroup`/
`update-nodegroup-config` read an `input` JSON file (the resource identity —
`cluster`/`nodegroup` — always comes from its own config parameter, never
from `input`, so the same identity params work uniformly across every
per-resource operation). `update-cluster-version`/`update-nodegroup-version`
build their (small) request entirely from flat config parameters
(`kubernetesVersion`/`releaseVersion`/`force`) rather than requiring an input
file for a one- or two-field change.

| Parameter           | Type           | Default | Declarative `validate:`                                   | Required for                                                                                                                                                           | Description                                                                                                                              |
| ------------------- | -------------- | ------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`       | `STRING`       | —       | `required: true`, `nonEmpty`                              | all                                                                                                                                                                    | AWS profile name; declaring it enables the `script.aws` dynamic-provisioning seam (`Core.AWS_PROFILE_PARAM_NAME`)                        |
| `operation`         | `STRING`       | —       | `required: true`, `oneOf(EKS_OPS_OPERATIONS)` (16 values) | all                                                                                                                                                                    | Selects which of the 16 `M3LEKSOperations` methods this run dispatches                                                                   |
| `cluster`           | `STRING`       | —       | `nonEmpty`                                                | every operation **except** `list-clusters`                                                                                                                             | Cluster name; the sole identity source for every cluster/nodegroup operation — never read from `input`                                   |
| `nodegroup`         | `STRING`       | —       | `nonEmpty`                                                | `describe-nodegroup`, `create-nodegroup`, `update-nodegroup-config`, `update-nodegroup-version`, `delete-nodegroup`, `wait-nodegroup-active`, `wait-nodegroup-deleted` | Nodegroup name, scoped to `cluster`                                                                                                      |
| `input`             | `STRING`       | —       | `nonEmpty`                                                | `create-cluster`, `update-cluster-config`, `create-nodegroup`, `update-nodegroup-config`                                                                               | Path resolved via `M3LPaths.resolveInput` to a JSON file carrying the operation's mutable payload fields (never the resource identity)   |
| `output`            | `STRING`       | —       | `nonEmpty`                                                | all (optional)                                                                                                                                                         | Path resolved via `M3LPaths.resolveOutput`; when set, the operation's result is persisted as a single JSON document                      |
| `kubernetesVersion` | `STRING`       | —       | `nonEmpty`                                                | `update-cluster-version` (required); `update-nodegroup-version` (optional — may bump `releaseVersion` alone)                                                           | Target Kubernetes version, forwarded as `version` on the wrapper's `M3LEKSUpdateClusterVersionInput`/`M3LEKSUpdateNodegroupVersionInput` |
| `releaseVersion`    | `STRING`       | —       | `nonEmpty`                                                | `update-nodegroup-version` (optional)                                                                                                                                  | Target AMI release version                                                                                                               |
| `force`             | `BOOL`         | `false` | —                                                         | `update-cluster-version`, `update-nodegroup-version` (optional)                                                                                                        | Forces the update past an EKS-reported health-issue block                                                                                |
| `maxResults`        | `INT`          | —       | `range(1, 100)`                                           | `list-clusters`, `list-nodegroups` (optional)                                                                                                                          | Page size, forwarded to `listClusters`/`listNodegroups`                                                                                  |
| `nextToken`         | `STRING`       | —       | `nonEmpty`                                                | `list-clusters`, `list-nodegroups` (optional)                                                                                                                          | Continuation token from a previous page's `nextToken`                                                                                    |
| `include`           | `STRING_ARRAY` | —       | `nonEmpty`                                                | `list-clusters` (optional)                                                                                                                                             | Cluster-kind filter, forwarded to `listClusters({ include })`                                                                            |
| `maxWaitTime`       | `INT`          | `1200`  | `range(1, 3600)`                                          | `wait-cluster-active`, `wait-cluster-deleted`, `wait-nodegroup-active`, `wait-nodegroup-deleted` (optional)                                                            | Seconds bounding the wait; the wrapper's own waiters poll at `{minDelay: 30, maxDelay: 120}`, so the default allows several intervals    |
| `yes`               | `BOOL`         | `false` | —                                                         | any mutating operation (optional)                                                                                                                                      | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                            |

## Steps

One row per `src/steps/` module; each step takes injected, already-guard-checked
dependencies (never raw `Core.M3LConfig`) and returns its operation's result to
the dispatcher — it never persists `output` or logs a summary itself. This
keeps every step a pure `deps -> result` function, testable with plain values.
`run-eks-ops.ts` resolves and guard-checks the config once, then dispatches via
an exhaustive two-level type-predicate chain (never a single 16-arm `switch` —
that shape blows the `scripts/*/src/**` ESLint `complexity`/
`max-lines-per-function` caps past ~8–10 operations, per `codepipeline-ops`'s
precedent): a top-level split on cluster-vs-nodegroup, each side then splitting
on read/write/wait. Every mutating operation routes through
`Core.confirmDestructive` first (W5's promoted destructive-gate — not a
script-local step).

| Step              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-eks-ops`     | Composition/dispatcher: resolves and guard-checks config per operation (throws `ERR_EKS_OPS_CONFIG`); for the 4 `input`-bearing operations, reads + JSON-parses `input` here (into a `Record<string, unknown>` — never inside a `write-*` step); runs `Core.confirmDestructive` for every mutating operation; dispatches to the operation-appropriate step with already-resolved typed values; converts a `describe-cluster`/`describe-nodegroup` `undefined` result into `ERR_EKS_OPS_NOT_FOUND` **before** any persist attempt; persists the returned result to `output` when configured (via `Core.M3LJSONFileExporter`, **before** the next check); throws `ERR_EKS_OPS_UPDATE_FAILED` when a `write-*` result's `M3LEKSUpdate.status === "Failed"`, and `ERR_EKS_OPS_WAIT_NOT_COMPLETE` when a `wait-*` result's `state !== "SUCCESS"` — both **after** persisting; logs a run summary built only from `state`/`reason`/`status`, never a raw waiter error or the SDK's resolved `WaiterResult`/`Update.errors` verbatim (see § Security note below). |
| `config-helpers`  | Shared `readOptionalString`/`readOptionalNumber`/`readBoolWithDefault`/`requireString`/`readInputFileText`/`readJSONFile`/`asInputRecord` helpers used only by `run-eks-ops`'s dispatch functions (the `codepipeline-ops` precedent) — extracted to keep the dispatcher under the per-function line/complexity caps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `read-clusters`   | `list-clusters` (`listClusters({ nextToken, maxResults, include })`) and `describe-cluster` (`describeCluster(cluster)`) — never gated. `describeCluster` may resolve `undefined` (not-found); this step returns that `undefined` unchanged, leaving the not-found → error conversion to `run-eks-ops`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `write-cluster`   | `create-cluster` (`createCluster({ name: cluster, ...input })`), `update-cluster-config` (`updateClusterConfig({ name: cluster, ...input })`), `update-cluster-version` (`updateClusterVersion({ name: cluster, version: kubernetesVersion, force })`), `delete-cluster` (`deleteCluster(cluster)`). Returns `M3LEKSClusterSummary` for create/delete, `M3LEKSUpdate` for the two `update*` calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `wait-cluster`    | `wait-cluster-active` (`waitUntilClusterActive(cluster, { maxWaitTime })`), `wait-cluster-deleted` (`waitUntilClusterDeleted(cluster, { maxWaitTime })`). Returns the `M3LEKSWaiterResult` unchanged — it does **not** itself inspect or throw on a non-`SUCCESS` state; that is `run-eks-ops`'s decision to make once the result has flowed back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `read-nodegroups` | `list-nodegroups` (`listNodegroups(cluster, { nextToken, maxResults })`) and `describe-nodegroup` (`describeNodegroup(cluster, nodegroup)`) — never gated. Same `undefined`-on-not-found passthrough as `read-clusters`; `list-nodegroups` itself throws (not `undefined`) on an unknown `cluster` — that failure propagates unchanged as `M3LEKSOperationError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `write-nodegroup` | `create-nodegroup` (`createNodegroup({ clusterName: cluster, nodegroupName: nodegroup, ...input })`), `update-nodegroup-config` (`updateNodegroupConfig({ clusterName: cluster, nodegroupName: nodegroup, ...input })`), `update-nodegroup-version` (`updateNodegroupVersion({ clusterName: cluster, nodegroupName: nodegroup, version: kubernetesVersion, releaseVersion, force })`), `delete-nodegroup` (`deleteNodegroup(cluster, nodegroup)`). Returns `M3LEKSNodegroupSummary` for create/delete, `M3LEKSUpdate` for the two `update*` calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `wait-nodegroup`  | `wait-nodegroup-active` (`waitUntilNodegroupActive(cluster, nodegroup, { maxWaitTime })`), `wait-nodegroup-deleted` (`waitUntilNodegroupDeleted(cluster, nodegroup, { maxWaitTime })`). Same pass-through contract as `wait-cluster`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Step signatures (deps object + return type)

Every step takes a single `readonly`-field deps object (never raw
`Core.M3LConfig`) and no step does its own filesystem I/O except
`run-eks-ops` itself:

- `runEksOps(deps: { config: Core.M3LConfig; paths: Core.M3LPaths; logger: Core.M3LLogger; operations: AWS.M3LEKSOperations; prompt: Core.M3LPrompt }): Promise<void>`
- `readClusters(deps: { operations: AWS.M3LEKSOperations; operation: "list-clusters" | "describe-cluster"; cluster: string | undefined; nextToken: string | undefined; maxResults: number | undefined; include: readonly string[] | undefined }): Promise<M3LEKSListClustersResult | M3LEKSClusterSummary | undefined>`
- `writeCluster(deps: { operations: AWS.M3LEKSOperations; operation: "create-cluster" | "update-cluster-config" | "update-cluster-version" | "delete-cluster"; cluster: string; input: Record<string, unknown> | undefined; kubernetesVersion: string | undefined; force: boolean }): Promise<M3LEKSClusterSummary | M3LEKSUpdate>`
- `waitCluster(deps: { operations: AWS.M3LEKSOperations; operation: "wait-cluster-active" | "wait-cluster-deleted"; cluster: string; maxWaitTime: number }): Promise<M3LEKSWaiterResult>`
- `readNodegroups(deps: { operations: AWS.M3LEKSOperations; operation: "list-nodegroups" | "describe-nodegroup"; cluster: string; nodegroup: string | undefined; nextToken: string | undefined; maxResults: number | undefined }): Promise<M3LEKSListNodegroupsResult | M3LEKSNodegroupSummary | undefined>`
- `writeNodegroup(deps: { operations: AWS.M3LEKSOperations; operation: "create-nodegroup" | "update-nodegroup-config" | "update-nodegroup-version" | "delete-nodegroup"; cluster: string; nodegroup: string; input: Record<string, unknown> | undefined; kubernetesVersion: string | undefined; releaseVersion: string | undefined; force: boolean }): Promise<M3LEKSNodegroupSummary | M3LEKSUpdate>`
- `waitNodegroup(deps: { operations: AWS.M3LEKSOperations; operation: "wait-nodegroup-active" | "wait-nodegroup-deleted"; cluster: string; nodegroup: string; maxWaitTime: number }): Promise<M3LEKSWaiterResult>`

Script-local error codes are plain `M3LError.code` strings (the field is an
open `string`, not a closed union — exactly like `ecs-ops`'s `ERR_ECS_OPS_*`),
all prefixed `ERR_EKS_OPS_`:

- `ERR_EKS_OPS_CONFIG` — a guard-checked per-operation requirement was unmet
  (missing `cluster`/`nodegroup`/`input`/`kubernetesVersion` for an operation
  that requires it, an `input` file that fails to read, an `input` that is not
  valid JSON or does not decode to a JSON object, an unrecognized `operation`
  (unreachable through the declared `oneOf` validator, guarded defensively),
  or `script.aws` was not provisioned despite declaring `aws.profile` (guarded
  in `main.ts`, the same composition-root pattern the rest of the fleet uses).
  **Not** included here: an empty-but-present string parameter or an
  out-of-range `maxResults`/`maxWaitTime` — those fail earlier at config-load
  with `M3LConfigValidationError` (see § Configuration schema above).
- `ERR_EKS_OPS_ABORTED` — the `Core.confirmDestructive` confirmation was
  declined.
- `ERR_EKS_OPS_NOT_FOUND` — `describe-cluster`/`describe-nodegroup` resolved
  `undefined` (the wrapper's not-found convention, distinct from every other
  rejection, which throws `M3LEKSOperationError` and propagates unchanged).
- `ERR_EKS_OPS_UPDATE_FAILED` — an `update-*` call resolved an `M3LEKSUpdate`
  whose `status === "Failed"`; thrown **after** the result (including its
  `errors[]`) is persisted to `output`, mirroring `ecs-ops`'s persist-then-throw
  pattern for `wait-services-stable`. `"InProgress"` and `"Successful"` are
  both non-error outcomes — EKS's `update*` calls are asynchronous by design
  (see § Security note below); only `"Failed"` is treated as this script's
  failure.
- `ERR_EKS_OPS_WAIT_NOT_COMPLETE` — a `wait-*` call resolved an
  `M3LEKSWaiterResult` whose `state` is `"TIMEOUT"` or `"ABORTED"` (a genuine
  `FAILURE`/call-failure case already throws `M3LEKSOperationError` from the
  wrapper and propagates unchanged, per [`docs/reference/aws/eks.md`](../aws/eks.md)).
  Thrown **after** persisting `output`.

An `output`-write failure is **not** re-coded: `Core.M3LJSONFileExporter.export()`
already throws a chained `M3LError` (`ERR_JSON_FILE_EXPORT`) on any filesystem
or serialization failure, so it propagates unchanged rather than being wrapped
in a redundant script-local code.

### Security note — asynchronous updates and the waiter secret-leak surface

Two EKS-specific behaviors, both documented in
[`docs/reference/aws/eks.md`](../aws/eks.md), that a mechanical copy of
`ecs-ops`/`cloudformation-stacks` would get wrong:

1. **`update-cluster-config`/`update-cluster-version`/`update-nodegroup-config`/
   `update-nodegroup-version` are asynchronous** — the wrapper call returns
   immediately with an `M3LEKSUpdate` whose `status` starts `"InProgress"`,
   not the mutated resource. Observing completion needs a separate
   `wait-cluster-active`/`wait-nodegroup-active` call once the update lands
   (there is no SDK waiter over `Update.status` itself).
2. **Never log or persist more than `{ state, reason }` from a waiter result,
   and never chain a raw waiter error as `cause`.** The wrapper already
   reduces every waiter outcome to that shape specifically because the SDK's
   underlying `TimeoutError`/`AbortError`/`FAILURE` machinery can embed the
   entire last `DescribeCluster`/`DescribeNodegroup` response — including
   `connectorConfig.activationCode`/`activationId`, one-time
   cluster-registration secrets — in its own `.message`. `run-eks-ops`'s run
   summary must read only `M3LEKSWaiterResult.state`/`.reason` and
   `M3LEKSUpdate.status`/`.errors` (already-scrubbed per-field), never
   `JSON.stringify` an SDK error or the wrapper's rejected promise's `.message`
   from the waiter path.

## Inputs and outputs

- **Reads:** `input` (JSON, for `create-cluster`/`update-cluster-config`/
  `create-nodegroup`/`update-nodegroup-config`), resolved under
  `M3L_INPUT_DIR` via `M3LPaths.resolveInput`.
- **Writes:** when `output` is configured, the returned result persisted as a
  single JSON document via `Core.M3LJSONFileExporter` under `M3L_OUTPUT_DIR` —
  `M3LEKSListClustersResult`/`M3LEKSListNodegroupsResult` for the two `list-*`
  operations, `M3LEKSClusterSummary`/`M3LEKSNodegroupSummary` for
  `describe-*`/`create-*`/`delete-*`, `M3LEKSUpdate` for the four `update-*`
  operations, `M3LEKSWaiterResult` for the four `wait-*` operations. Omitting
  `output` logs only the run summary below — never the full result.
- **Reports:** a run summary (operation, cluster, and — where applicable —
  nodegroup) through the logger; `wait-*` exits non-zero when the wait did not
  resolve `SUCCESS`, and `update-*` exits non-zero when the resolved
  `M3LEKSUpdate.status` is `"Failed"` — never silently.

## See also

- [`aws/eks`](../aws/eks.md) — `M3LEKSOperations`, the typed wrapper this
  script dispatches over
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
