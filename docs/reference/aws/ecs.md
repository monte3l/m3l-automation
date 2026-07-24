# ECS Operations

`M3LECSOperations` is a typed wrapper over a raw `ECSClient`, so callers never
import `@aws-sdk/client-ecs` command classes directly. Surfaced by
`scripts/ecs-ops` (roadmap W3) needing to avoid importing the SDK directly
(ADR-0029 — scripts depend only on `@m3l-automation/m3l-common`).

> **Scaffold status:** this submodule is scaffolded — signatures, TSDoc, and
> this spec are final, but every `M3LECSOperations` method currently returns a
> `Promise` rejected with `M3LECSOperationError("... not yet implemented")`.
> `implementing-submodules` fills the bodies in against this contract.

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `AWSClientProvider.ecs` returns the
raw `ECSClient`; `M3LECSOperations` wraps it with bespoke, typed methods,
translating SDK request/response shapes into plain, library-owned types so a
caller never touches an `@aws-sdk/client-ecs` type.

Scoped to the ECS **service** control-plane resource — the deployable
unit — plus the read-only cluster context a service operation needs.
**Deliberately out of scope for this v1**: cluster mutation (create/update/
delete), task-definition registration/deregistration, and task run/stop. A
consumer needing any of those composes its own SDK client or waits for a
future revision of this wrapper.

- `M3LECSOperations` — the wrapper class, constructed from a raw `ECSClient`.
- `M3LECSOperationError` — thrown on a request-level ECS failure.
- Plain types: `M3LECSListServicesResult`, `M3LECSServiceDescription`,
  `M3LECSCreateServiceInput`, `M3LECSUpdateServiceInput`,
  `M3LECSWaiterResult`, `M3LECSListClustersResult`, `M3LECSClusterSummary`,
  `M3LECSLoadBalancer`, `M3LECSNetworkConfiguration`.

## Public API

### `M3LECSOperations`

**Constructor** — `new M3LECSOperations(client)`, where `client` is a raw
`ECSClient` (e.g. `script.aws.clients.ecs`).

| Method                                                 | Returns                             | Throws                 |
| ------------------------------------------------------ | ----------------------------------- | ---------------------- |
| `listServices(options?)`                               | `Promise<M3LECSListServicesResult>` | `M3LECSOperationError` |
| `describeService(cluster, service)`                    | `Promise<M3LECSServiceDescription>` | `M3LECSOperationError` |
| `createService(input)`                                 | `Promise<M3LECSServiceDescription>` | `M3LECSOperationError` |
| `updateService(input)`                                 | `Promise<M3LECSServiceDescription>` | `M3LECSOperationError` |
| `deleteService(cluster, service, force?)`              | `Promise<M3LECSServiceDescription>` | `M3LECSOperationError` |
| `waitUntilServicesStable(cluster, services, options?)` | `Promise<M3LECSWaiterResult>`       | `M3LECSOperationError` |
| `listClusters(options?)`                               | `Promise<M3LECSListClustersResult>` | `M3LECSOperationError` |
| `describeCluster(cluster)`                             | `Promise<M3LECSClusterSummary>`     | `M3LECSOperationError` |

`listServices` pages via `nextToken` (mirrors the SDK's own `NextToken`
pagination — one page per call, no auto-pagination); `nextToken` is present
only when another page exists. `ListServices` returns ARNs only — call
`describeService` for detail on a specific service.

`describeService`/`deleteService` call the SDK's `DescribeServices`/
`DeleteService` with a single-element `services`/`service` argument; the SDK
itself accepts up to 10 services per `DescribeServices` call, but this
wrapper's per-service methods issue one call per invocation (no batching in
this v1 — `waitUntilServicesStable` is the one method that accepts multiple
service names, matching the SDK waiter's own signature).

`deleteService` is **destructive**. This wrapper performs no confirmation
gate of its own — the caller (`scripts/ecs-ops`) is responsible for its own
destructive-operation confirmation, matching every other AWS-consumer script's
convention (§1.5 of the fleet's shared conventions).

`describeService`/`describeCluster` **resolve a defaulted description rather
than throw** when the underlying call succeeds but the target is absent (an
empty `services`/`clusters` array in the response — the SDK reports _why_ via
a parallel `failures` array of `{ arn, reason, detail }` entries, e.g.
`MISSING`/`ACCESS_DENIED`). This wrapper intentionally does **not** surface
`failures` — there is no field on `M3LECSServiceDescription`/
`M3LECSClusterSummary` a caller can inspect to learn why a target was absent,
only that the field-by-field defaults (`""`/`0`) came back. A caller that
needs to distinguish "not found" from "found but empty" must call
`describeService`/`describeCluster` and treat an all-default result as
"absent" itself; this module does not thread the SDK's own reason through.

`waitUntilServicesStable` wraps the SDK's own (current, non-deprecated)
`waitUntilServicesStable` waiter function (not a `Command` — ECS waiters are
standalone exports from `@aws-sdk/client-ecs`), inside a `try`/`catch`: unlike
every other method here, the waiter itself throws on a non-`SUCCESS` terminal
state rather than resolving with one, so this method's whole contract is
translating that catch back into a resolved value where it can.

`options?.maxWaitTime` defaults to **600 seconds** when the caller omits it —
matching the AWS CLI's own default ECS `services-stable` wait budget (40
attempts at a 15-second poll delay).

**Only the two terminal states the SDK identifies by a distinct error
name resolve rather than throw**: a caught error named `"TimeoutError"`
resolves `{ state: "TIMEOUT", reason: error.message }`; a caught error named
`"AbortError"` (the waiter's own abort signal, not a caller-driven abort in
this v1) resolves `{ state: "ABORTED", reason: error.message }`. Every other
rejection — including the SDK's `FAILURE` terminal waiter state (a service
that definitively cannot stabilize, e.g. a task repeatedly failing its health
check) — throws `M3LECSOperationError` chaining the cause. This is narrower
than "any non-stable outcome resolves": the SDK's own `checkExceptions` helper
surfaces a `FAILURE` terminal state as a plain, unnamed `Error` —
indistinguishable by identity from a genuine `DescribeServices` call failure
(credentials, throttling exhausted, network) — so there is no reliable way to
resolve one without also silently swallowing the other. A well-formed
"it timed out" or "it was aborted" answer is data, not a fault (the same
principle behind `M3LAthenaClient.awaitResults`'s terminal-status handling);
an unclassifiable non-success is treated as a fault instead of guessed at.

No retry/backoff wrapping beyond what `waitUntilServicesStable` already
performs internally (contrast `M3LSQSOperations`'s batch-send retry): none of
the other methods here has a transient-fault profile that justifies an
automatic retry. A caller wanting resilience composes its own
`M3LRetryRunner` around a call.

### Plain types (field-by-field)

- `M3LECSListServicesResult` — `serviceArns` is always an array (`[]` when
  the SDK omits `serviceArns`); `nextToken` is present only when the SDK
  returns one.
- `M3LECSServiceDescription` — `serviceArn`, `serviceName`, `clusterArn`,
  `status`, `desiredCount`, `runningCount`, `pendingCount` are always present
  (defaulted from the SDK's `Service` shape); `taskDefinition`, `launchType`,
  `roleArn`, `createdAt` (ISO-8601 string), `loadBalancers`, and
  `networkConfiguration` are present only when the SDK response includes
  them. Returned by `describeService`, `createService`, `updateService`, and
  `deleteService`. `describeService` defaults an absent `services[0]` (see
  above); `createService`/`updateService`/`deleteService` do **not** — AWS
  guarantees `.service` populated on a successful `CreateService`/
  `UpdateService`/`DeleteService` response, so its absence there is a genuine
  API/SDK anomaly, not a documented "not found" case, and each of those three
  methods throws `M3LECSOperationError` rather than silently defaulting.
- `M3LECSCreateServiceInput` — `cluster`, `serviceName`, `taskDefinition` are
  required (an existing task definition family:revision or ARN — this module
  does not register task definitions); `desiredCount`, `launchType`,
  `loadBalancers`, `networkConfiguration` are optional.
- `M3LECSUpdateServiceInput` — `cluster`, `service` are required;
  `desiredCount`, `taskDefinition`, `forceNewDeployment`,
  `networkConfiguration` are optional (each included in the SDK command only
  when the caller supplies it — `exactOptionalPropertyTypes`-safe).
- `M3LECSWaiterResult` — `state` is one of `"SUCCESS" | "ABORTED" |
"TIMEOUT"`; `reason` is present only when the waiter supplies one.
- `M3LECSListClustersResult` — `clusterArns` always an array; `nextToken`
  present only when the SDK returns one.
- `M3LECSClusterSummary` — `clusterArn`, `clusterName` always present;
  `status`, `activeServicesCount`, `runningTasksCount`, `pendingTasksCount`
  present only when the SDK response includes them. Read-only — returned by
  `listClusters`/`describeCluster` for scoping context; no cluster-mutation
  method exists in this module.
- `M3LECSLoadBalancer` — `targetGroupArn`, `loadBalancerName`,
  `containerName`, `containerPort` are all optional (an SDK load-balancer
  entry populates exactly one of `targetGroupArn`/`loadBalancerName`
  depending on target type).
- `M3LECSNetworkConfiguration` — `subnets` required, `securityGroups` and
  `assignPublicIp` optional; maps to the SDK's nested
  `awsvpcConfiguration`. Only relevant for `awsvpc`-network-mode services
  (Fargate, or `awsvpc`-mode EC2 tasks).

There are no pre-flight validation guards in this module (contrast
`M3LSQSOperations`'s batch-size/duplicate-id guards) — every method's only
failure mode is a rejected `.send()`/waiter call.

### `M3LECSOperationError`

`code: "ERR_ECS_OPERATION"`. Thrown when the underlying SDK `.send()` or the
`waitUntilServicesStable` waiter's polling call rejects, chaining the
rejection as `cause`.

## Out of scope (v1)

Recorded here rather than left implicit, so a future revision has a named
starting point instead of rediscovering the boundary:

- **Cluster mutation** — `CreateCluster`/`UpdateCluster`/`DeleteCluster` and
  capacity-provider management. `listClusters`/`describeCluster` are
  read-only context only.
- **Task-definition registration** — `RegisterTaskDefinition`/
  `DeregisterTaskDefinition`. `createService`/`updateService` require an
  already-registered task definition family:revision or ARN.
- **Task-level operations** — `RunTask`/`StopTask`/`ListTasks`/
  `DescribeTasks`. Out of scope because `scripts/ecs-ops` (per the roadmap)
  operates at the service level; a task-level consumer would need its own
  wrapper extension.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider.ecs`, the raw client
  getter this wrapper is constructed from.
- [Lambda Operations](./lambda.md) — the closest sibling wrapper in shape
  (control-plane CRUD over a single resource type), followed here for
  shape/error-handling consistency.
- [Athena](./athena.md) — precedent for a waiter/poll method resolving a
  terminal non-success state rather than throwing
  (`M3LAthenaClient.awaitResults`).
