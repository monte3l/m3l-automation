# EKS Operations

`M3LEKSOperations` is a typed wrapper over a raw `EKSClient`, so callers never
import `@aws-sdk/client-eks` command classes directly. Surfaced by
`scripts/eks-ops` (roadmap W4) needing to avoid importing the SDK directly
(ADR-0029 — scripts depend only on `@m3l-automation/m3l-common`).

> **Status:** implemented and reviewed. The contract below was verified
> against the installed `@aws-sdk/client-eks@3.1079.0` (resolved and read
> directly from `dist-types/**`/`dist-es/**`, not assumed from training data)
> by a `spec-conformance-reviewer` pass before implementation began, and the
> implementation was independently re-verified against the same SDK source —
> including by executing the real waiter machinery — by a security review
> after. 103 tests, `client.ts` at 100% statements/functions/lines and 90.29%
> branches.

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `AWSClientProvider.eks` returns the
raw `EKSClient`; `M3LEKSOperations` wraps it with bespoke, typed methods,
translating SDK request/response shapes into plain, library-owned types so a
caller never touches an `@aws-sdk/client-eks` type.

Scoped to EKS **control-plane** cluster and nodegroup operations only.
**Deliberately out of scope for this v1**: addon management (`*Addon`
commands/waiters), Fargate profiles (`*FargateProfile`
commands/waiters), identity-provider/access-entry/pod-identity association
management, and — per ADR-0029 — any kubectl-level workload operation
(pods/deployments/services/configmaps). A consumer needing any of those
composes its own SDK client or waits for a future revision of this wrapper.

- `M3LEKSOperations` — the wrapper class, constructed from a raw `EKSClient`.
- `M3LEKSOperationError` — thrown on a request-level EKS failure.
- Plain types: `M3LEKSClusterSummary`, `M3LEKSListClustersResult`,
  `M3LEKSCreateClusterInput`, `M3LEKSUpdateClusterConfigInput`,
  `M3LEKSUpdateClusterVersionInput`, `M3LEKSNodegroupSummary`,
  `M3LEKSListNodegroupsResult`, `M3LEKSCreateNodegroupInput`,
  `M3LEKSUpdateNodegroupConfigInput`, `M3LEKSUpdateNodegroupVersionInput`,
  `M3LEKSUpdate`, `M3LEKSUpdateError`, `M3LEKSUpdateLabelsPayload`,
  `M3LEKSVpcConfig`, `M3LEKSVpcConfigInput`, `M3LEKSNodegroupScalingConfig`,
  `M3LEKSWaiterResult`.
- Options types (declared alongside the methods that take them):
  `M3LEKSListClustersOptions`, `M3LEKSListNodegroupsOptions`,
  `M3LEKSWaiterOptions` (shared by all four `waitUntil*` methods).

## Public API

### `M3LEKSOperations`

**Constructor** — `new M3LEKSOperations(client)`, where `client` is a raw
`EKSClient` (e.g. `script.aws.clients.eks`).

| Method                                                            | Returns                                        | Throws                 |
| ----------------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| `listClusters(options?)`                                          | `Promise<M3LEKSListClustersResult>`            | `M3LEKSOperationError` |
| `describeCluster(name)`                                           | `Promise<M3LEKSClusterSummary \| undefined>`   | `M3LEKSOperationError` |
| `createCluster(input)`                                            | `Promise<M3LEKSClusterSummary>`                | `M3LEKSOperationError` |
| `updateClusterConfig(input)`                                      | `Promise<M3LEKSUpdate>`                        | `M3LEKSOperationError` |
| `updateClusterVersion(input)`                                     | `Promise<M3LEKSUpdate>`                        | `M3LEKSOperationError` |
| `deleteCluster(name)`                                             | `Promise<M3LEKSClusterSummary>`                | `M3LEKSOperationError` |
| `waitUntilClusterActive(name, options?)`                          | `Promise<M3LEKSWaiterResult>`                  | `M3LEKSOperationError` |
| `waitUntilClusterDeleted(name, options?)`                         | `Promise<M3LEKSWaiterResult>`                  | `M3LEKSOperationError` |
| `listNodegroups(clusterName, options?)`                           | `Promise<M3LEKSListNodegroupsResult>`          | `M3LEKSOperationError` |
| `describeNodegroup(clusterName, nodegroupName)`                   | `Promise<M3LEKSNodegroupSummary \| undefined>` | `M3LEKSOperationError` |
| `createNodegroup(input)`                                          | `Promise<M3LEKSNodegroupSummary>`              | `M3LEKSOperationError` |
| `updateNodegroupConfig(input)`                                    | `Promise<M3LEKSUpdate>`                        | `M3LEKSOperationError` |
| `updateNodegroupVersion(input)`                                   | `Promise<M3LEKSUpdate>`                        | `M3LEKSOperationError` |
| `deleteNodegroup(clusterName, nodegroupName)`                     | `Promise<M3LEKSNodegroupSummary>`              | `M3LEKSOperationError` |
| `waitUntilNodegroupActive(clusterName, nodegroupName, options?)`  | `Promise<M3LEKSWaiterResult>`                  | `M3LEKSOperationError` |
| `waitUntilNodegroupDeleted(clusterName, nodegroupName, options?)` | `Promise<M3LEKSWaiterResult>`                  | `M3LEKSOperationError` |

12 operations + 4 waiters = 16 methods total.

#### Options types (field-by-field)

- `M3LEKSListClustersOptions` — `maxResults?: number`, `nextToken?: string`,
  `include?: readonly string[]` (a 1:1 map of the SDK's `ListClustersRequest`).
- `M3LEKSListNodegroupsOptions` — `maxResults?: number`, `nextToken?: string`
  (a 1:1 map of the SDK's `ListNodegroupsRequest`, minus the positional
  `clusterName` parameter this method already takes separately).
- `M3LEKSWaiterOptions` — `maxWaitTime?: number` (seconds), shared by all four
  `waitUntil*` methods. Defaults to `1200` (20 minutes) when the caller omits
  it, chosen to allow several poll intervals at EKS's own 30s/120s min/max
  delay cadence rather than `@smithy/core`'s generic 2s/120s default (see
  "Waiters" below).

### Cluster listing and lookup

`listClusters` pages via `nextToken` (mirrors the SDK's own `nextToken`
pagination — one page per call, no auto-pagination). **`ListClusters` returns
cluster _names_, not ARNs** — this differs from `aws/ecs`'s
`listClusters`/`listServices`, which return ARNs. Call `describeCluster` for a
name's ARN/detail.

`describeCluster` distinguishes the SDK's `ResourceNotFoundException` from
every other failure: a missing cluster **resolves `undefined`** rather than
throwing (the `aws/codepipeline` `getPipeline` precedent), so a caller can
write `if ((await ops.describeCluster(name)) === undefined) { … }` instead of
a `try`/`catch`. Any other rejection (`ClientException`, `ServerException`,
`ServiceUnavailableException`, or an unclassified error) throws
`M3LEKSOperationError`. Same distinguishing behavior applies to
`describeNodegroup`, which additionally documents `InvalidParameterException`
(not thrown by `describeCluster`) among its other-rejection cases.
`listNodegroups` itself can also throw `ResourceNotFoundException` (an
unknown `clusterName`) — this one is **not** resolved as empty/`undefined`;
it throws `M3LEKSOperationError` like any other `listNodegroups` failure,
since there is no empty-list-vs-not-found ambiguity to resolve (unlike a
single-resource `describe*` call).

### Mutations are asynchronous — `update*` returns an `M3LEKSUpdate`, not the resource

Unlike `aws/ecs`/`aws/cloudformation`/`aws/codepipeline`'s synchronous
`update*` calls (which return the mutated resource directly),
**`updateClusterConfig`/`updateClusterVersion`/`updateNodegroupConfig`/
`updateNodegroupVersion` are asynchronous** in the underlying EKS API: the
call returns immediately with an `M3LEKSUpdate` whose `status` starts
`"InProgress"`. There is no SDK waiter over `Update.status` — this wrapper
does not expose a "wait for update complete" method. To observe an update
finish, poll the target resource itself: `waitUntilClusterActive`/
`waitUntilNodegroupActive` resolve once the resource's own `status` field
reaches its terminal `"ACTIVE"` state, which happens once its most recent
update completes.

`createCluster`/`createNodegroup`/`deleteCluster`/`deleteNodegroup` are
synchronous and return the resource directly (`Cluster`/`Nodegroup`'s
just-created or just-deleted snapshot) — only the four `update*` calls carry
this asynchronous shape.

`M3LEKSUpdate` deliberately omits the SDK `Update`'s `params` (an
`UpdateParam[]` of `{ type?, value? }` — `value` can carry the caller-supplied
config value the update is applying) and `cancellation`
(`{ status?, reason? }`) fields, alongside `connectorConfig` in the omission
list above — same "out of scope for v1" rationale, not an oversight.

### Waiters

`waitUntilClusterActive`/`waitUntilClusterDeleted`/
`waitUntilNodegroupActive`/`waitUntilNodegroupDeleted` wrap the SDK's own
`waitUntilClusterActive`/`waitUntilClusterDeleted`/`waitUntilNodegroupActive`/
`waitUntilNodegroupDeleted` waiters (mirrors `aws/ecs`'s
`waitUntilServicesStable` shape): a `TimeoutError`/`AbortError` resolves as
data (`{ state: "TIMEOUT" | "ABORTED", reason }`) instead of throwing, so a
caller can distinguish "still not ready" from "the SDK call itself failed".
Any other rejection throws `M3LEKSOperationError`.

`maxWaitTime` is **required** by the SDK's `WaiterConfiguration` (not
optional, per `@smithy/types`) — this wrapper's `options?.maxWaitTime` must
be defaulted before constructing the SDK call, the same way `aws/ecs`
defaults `waitUntilServicesStable`'s. All four EKS waiters poll at
`{ minDelay: 30, maxDelay: 120 }` (not `@smithy/core`'s generic
`{ minDelay: 2, maxDelay: 120 }`) — pick a default `maxWaitTime` that allows
at least a few poll intervals at that cadence, not the generic default.

**Non-timeout FAILURE fires fast, and is asymmetric between `*Active` and
`*Deleted` — confirmed from the SDK's generated waiter source
(`@smithy/core`-based `dist-es/waiters/*.js`), not assumed:**

- `waitUntilClusterActive` reaches the terminal `FAILURE` state the moment
  the cluster's own `status` is `"DELETING"` or `"FAILED"` — not a timeout,
  it fires on the very next poll. **`waitUntilNodegroupActive` is narrower**:
  its generated `checkState` tests only `"CREATE_FAILED"`, with no
  `"DELETE_FAILED"`/`"DELETING"` branch at all — a nodegroup stuck deleting
  polls to TIMEOUT on this waiter, it does not fail fast (verified against
  the real generated waiter source, `dist-es/waiters/waitForNodegroupActive.js`
  — do not assume full symmetry with the cluster waiter).
- `waitUntilClusterDeleted` reaches `FAILURE` on `"ACTIVE"`/`"CREATING"`/
  `"PENDING"` (the cluster unexpectedly still exists in a non-deleting
  state). **`waitUntilNodegroupDeleted` is narrower here too**: its generated
  `checkState` tests only `"DELETE_FAILED"`, with no `"ACTIVE"`/`"CREATING"`/
  `"PENDING"` branch — same caveat as above (`dist-es/waiters/waitForNodegroupDeleted.js`).
  Both `*Deleted` waiters reach **`SUCCESS`** the moment the SDK's
  `DescribeCluster`/`DescribeNodegroup` call itself rejects with
  `ResourceNotFoundException` (deletion confirmed by the resource becoming
  unresolvable — mirrors `aws/cloudformation`'s `waitUntilStackDeleteComplete`);
  that part is symmetric.
- **Asymmetric acceptor for `*Active`:** its `checkState` catches _every_
  exception from the underlying `DescribeCluster`/`DescribeNodegroup` call —
  including `ResourceNotFoundException` — and returns RETRY, not FAILURE. So
  `waitUntilClusterActive`/`waitUntilNodegroupActive` against a resource that
  does not exist (or was deleted mid-wait) polls all the way to **TIMEOUT**,
  never a fast failure. Do not assume symmetry with the `*Deleted` waiters'
  fast-`SUCCESS`-on-not-found behavior when implementing.

Error discrimination is by `.name`: `TimeoutError`/`AbortError` are plain
`Error`s with `name` reassigned by the SDK; the FAILURE path throws a plain
`Error` with `name === "Error"` (indistinguishable by identity from a genuine
`DescribeCluster`/`DescribeNodegroup` call failure — treat it as a fault, the
same choice `aws/ecs`'s waiter doc makes).

**Both the FAILURE and SUCCESS paths leak the full last `Describe*` response —
confirmed from `@smithy/core`'s waiter source, not assumed:**

- **FAILURE (must-fix):** `checkExceptions` throws
  `new Error(JSON.stringify(result))`, where `result` is
  `{ state, reason, final, observedResponses }` and `reason`/`final` is the
  **entire `DescribeClusterCommandOutput`/`DescribeNodegroupCommandOutput`**
  (the waiter module assigns `reason = result` from the raw `client.send(...)`
  call). This lands in the thrown `Error`'s **`message`**, not its `cause` —
  the earlier draft of this doc had the channel wrong. `DescribeCluster`'s
  payload can include `connectorConfig.activationCode`/`activationId`
  (registration secrets), so `M3LEKSOperationError` must never forward that
  message verbatim and must never chain the raw waiter error as `cause` (per
  `.claude/rules/library-src.md`'s "do not chain the raw error as `cause` if
  it may hold sensitive content" rule) — construct a fresh, static message
  instead.
- **SUCCESS (must-fix, previously undocumented):** the SDK's own
  `WaiterResult<DescribeClusterCommandOutput>` on a successful resolve also
  carries `reason`/`final` set to the full Describe payload. `M3LEKSWaiterResult`
  must be built from an explicit `{ state: "SUCCESS" }` literal — **never**
  spread or forward the SDK's resolved `WaiterResult` object.
- **TIMEOUT/ABORTED (must-fix — an earlier draft of this doc called this
  path "safe in the common case"; a security review proved that wrong by
  executing the real waiter machinery):** the SDK's `TimeoutError`/`AbortError`
  message is **not** reliably a short, safe string. `checkExceptions` builds it
  from `JSON.stringify({ ...result, reason: "Waiter has timed out" })`, and
  `result.observedResponses`' keys come from `createMessageFromResponse`,
  which serializes the **entire observed response** into the key whenever
  `$metadata` is absent from it — reachable in normal operation via at least
  a `$responseBodyText` deserialization-failure branch, independent of
  whether the caller ever sees a clean `$metadata`-bearing response. So the
  raw SDK timeout/abort error's `.message` can carry `connectorConfig.activationCode`
  the same way the FAILURE path's message can. **`M3LEKSWaiterResult.reason`
  on the TIMEOUT/ABORTED path must therefore also be a fresh, static,
  library-constructed string — built only from the resource name/cluster
  name already available to the caller, never from the raw SDK error's
  `.message`** — the same rule as the FAILURE path above, not a relaxed one.

### Field mapping — what's included and what's deliberately omitted

`M3LEKSClusterSummary`/`M3LEKSNodegroupSummary` are pragmatic subsets of the
SDK's `Cluster`/`Nodegroup` shapes — `M3LEKSClusterSummary` maps 11 of
`Cluster`'s 28 fields, `M3LEKSNodegroupSummary` maps 16 of `Nodegroup`'s 25.
Deliberately **not** mapped:

- **`connectorConfig`** (on `Cluster`) — `activationCode`/`activationId` are
  one-time cluster-registration secrets. Never map this field onto
  `M3LEKSClusterSummary`; regression-lock the omission against a real
  SDK-shaped fixture carrying it (the `aws/codepipeline` precedent), not just
  an `expectTypeOf` assertion.
- `encryptionConfig`, `kubernetesNetworkConfig`, `logging`, `identity`,
  `health`, `outpostConfig`, `accessConfig`, `upgradePolicy`,
  `zonalShiftConfig`, `remoteNetworkConfig`, `computeConfig`,
  `storageConfig`, `clientRequestToken`, `id` (on `Cluster`) — out of scope
  for the control-plane listing/creation use case this v1 wrapper serves.
- `remoteAccess`, `resources`, `health`, `updateConfig`, `nodeRepairConfig`,
  `launchTemplate`, `warmPoolConfig`, `taints` (on `Nodegroup`) — same
  rationale.

Two fields are **write-only in this v1 — settable but not readable back**,
which implementation must either fix or knowingly accept before shipping:

- **`deletionProtection`** — settable via `M3LEKSUpdateClusterConfigInput`,
  but absent from `M3LEKSClusterSummary` (`Cluster.deletionProtection` is
  currently in the "out of scope" list above alongside
  `controlPlaneScalingConfig`, which genuinely is out of scope). Decide during
  implementation whether to add it to the summary or document the asymmetry
  explicitly.
- **`diskSize`** — settable via `M3LEKSCreateNodegroupInput.diskSize`, but
  absent from `M3LEKSNodegroupSummary`. Same decision.

`certificateAuthorityData` (mapped from `Cluster.certificateAuthority.data`)
**is** included — it is the Base64-encoded **public** CA certificate for a
`kubeconfig`'s `certificate-authority-data` field, not a private key or
credential.

Two write-path fields are validated against the SDK's known enum members
before `.send()`, matching the "no unearned casts on enum-backed fields" rule
(`aws/codepipeline`'s single must-fix): `M3LEKSCreateNodegroupInput.amiType`
against `AMITypes`, and `.capacityType` against `CapacityTypes`. Both are
value objects (`export declare const AMITypes: { readonly … }`), re-exported
from the package root — confirmed present at runtime, not just as types, so
`Object.values(AMITypes)`/`Object.values(CapacityTypes)` resolve correctly.
**Mock `@aws-sdk/client-eks` with the `importOriginal`-preserving async
factory from the start** (per `.claude/rules/tests.md`'s SDK-mocking-gotcha
rule) — a plain object-literal `vi.mock` would silently omit these enum
objects and make the validation throw `TypeError: Cannot convert undefined
… to object` before a single test assertion runs. Every other enum-backed
field (`M3LEKSClusterSummary.status`, `M3LEKSNodegroupSummary.status`) stays
plain `string` on the read path, per this repo's enum-asymmetry convention.

`M3LEKSVpcConfig.subnetIds` is a required `readonly string[]`, but the SDK's
`VpcConfigResponse.subnetIds` is `string[] | undefined` — the response
mapper needs a `?? []` default (the same pattern `aws/ecs`'s
`mapNetworkConfiguration` uses for `subnets`).

### Plain types (field-by-field)

- `M3LEKSClusterSummary` — `name`, `arn`, `status` always present (defaulted
  from the SDK's `Cluster` shape); `version`, `platformVersion`, `createdAt`
  (ISO-8601 string), `endpoint`, `roleArn`, `resourcesVpcConfig`,
  `certificateAuthorityData`, `tags` present only when the SDK response
  includes them. See "Field mapping" above for the full omission list
  (`connectorConfig` in particular) and the `deletionProtection` write-only
  asymmetry.
- `M3LEKSListClustersResult` — `clusters` (names, not ARNs) always an array;
  `nextToken` present only when the SDK returns one.
- `M3LEKSCreateClusterInput` — `name`, `roleArn`, `resourcesVpcConfig` are
  required (`resourcesVpcConfig.subnetIds` in turn required — EKS needs at
  least two subnets, validated server-side, not by this type); `version`,
  `tags` are optional.
- `M3LEKSUpdateClusterConfigInput` — `name` required; `resourcesVpcConfig`,
  `deletionProtection` optional (each included in the SDK command only when
  the caller supplies it — `exactOptionalPropertyTypes`-safe). Resolves an
  `M3LEKSUpdate`, not the mutated cluster (see "Mutations are asynchronous"
  above).
- `M3LEKSUpdateClusterVersionInput` — `name`, `version` required; `force`
  optional. Resolves an `M3LEKSUpdate`.
- `M3LEKSNodegroupSummary` — `nodegroupName`, `nodegroupArn`, `status` always
  present; `clusterName`, `version`, `releaseVersion`, `createdAt`,
  `modifiedAt` (ISO-8601 strings), `capacityType`, `scalingConfig`,
  `instanceTypes`, `subnets`, `amiType`, `nodeRole`, `labels`, `tags` present
  only when the SDK response includes them. See "Field mapping" above for the
  full omission list and the `diskSize` write-only asymmetry.
- `M3LEKSListNodegroupsResult` — `nodegroups` (names) always an array;
  `nextToken` present only when the SDK returns one.
- `M3LEKSCreateNodegroupInput` — `clusterName`, `nodegroupName`, `nodeRole`,
  `subnets` required; `scalingConfig`, `instanceTypes`, `amiType`,
  `capacityType`, `diskSize`, `labels`, `tags` optional. `amiType`/
  `capacityType` are validated against the SDK's `AMITypes`/`CapacityTypes`
  enum members before `.send()` — an unrecognized value throws
  `M3LEKSOperationError` without ever calling `.send()`.
- `M3LEKSUpdateNodegroupConfigInput` — `clusterName`, `nodegroupName`
  required; `scalingConfig`, `labels` (an `M3LEKSUpdateLabelsPayload`
  add/remove diff, not a full replacement) optional. Resolves an
  `M3LEKSUpdate`.
- `M3LEKSUpdateNodegroupVersionInput` — `clusterName`, `nodegroupName`
  required; `version`, `releaseVersion`, `force` optional. Resolves an
  `M3LEKSUpdate`.
- `M3LEKSUpdate` — `id`, `status` always present (`status` one of
  `"InProgress"`/`"Failed"`/`"Cancelled"`/`"Successful"`, kept as plain
  `string` per this module's enum-asymmetry convention); `type`, `createdAt`,
  `errors` present only when the SDK response includes them. `errors` is
  populated when `status` is `"Failed"`. Deliberately omits the SDK `Update`'s
  `params`/`cancellation` — see "Mutations are asynchronous" above.
- `M3LEKSUpdateError` — `errorCode`, `errorMessage`, `resourceIds` all
  optional, a 1:1 map of the SDK's `ErrorDetail`.
- `M3LEKSUpdateLabelsPayload` — `addOrUpdateLabels`, `removeLabels` both
  optional; an empty payload is legal (a no-op update).
- `M3LEKSVpcConfig` — `subnetIds` always an array (`?? []` when the SDK
  omits it); `securityGroupIds`, `clusterSecurityGroupId`, `vpcId`,
  `endpointPublicAccess`, `endpointPrivateAccess` present only when the SDK
  response includes them.
- `M3LEKSVpcConfigInput` — all fields optional; `subnetIds` is the one
  `createCluster` requires in practice (EKS's own ≥2-subnet rule, enforced
  server-side) but does not enforce at the type level.
- `M3LEKSNodegroupScalingConfig` — `minSize`, `maxSize`, `desiredSize` all
  optional; EKS validates `minSize ≤ desiredSize ≤ maxSize` server-side, not
  this type.
- `M3LEKSWaiterResult` — `state` is one of `"SUCCESS"` / `"TIMEOUT"` /
  `"ABORTED"`; `reason` is present only on the `"TIMEOUT"`/`"ABORTED"` states,
  and is always a fresh, library-constructed string — never the raw SDK
  waiter error's own message (see "Waiters" above).

There are no pre-flight validation guards beyond the `amiType`/`capacityType`
enum checks in this module (contrast `M3LSQSOperations`'s batch-size/
duplicate-id guards) — every other method's only failure mode is a rejected
`.send()`/waiter call.

### `M3LEKSOperationError`

`code: "ERR_EKS_OPERATION"`. Thrown when the underlying SDK `.send()` call
rejects (chaining the rejection as `cause`), when `createNodegroup` is
supplied an `amiType`/`capacityType` not recognized by the SDK's own enum
(no `cause` — a caller-input validation failure, not an SDK rejection), or
when a `waitUntil*` waiter's polling fails for any reason other than a
timeout/abort (deliberately **no** `cause` chained here — the SDK's waiter
machinery embeds the full last `DescribeCluster`/`DescribeNodegroup` response,
including `connectorConfig.activationCode`, into its own error; see
"Waiters" above).

## Not implemented (v1)

- Addon management (`listAddons`/`describeAddon`/`createAddon`/
  `updateAddon`/`deleteAddon`, `waitUntilAddonActive`/`waitUntilAddonDeleted`).
- Fargate profiles (`listFargateProfiles`/`describeFargateProfile`/
  `createFargateProfile`/`deleteFargateProfile`,
  `waitUntilFargateProfileActive`/`waitUntilFargateProfileDeleted`).
- Identity-provider config, access-entry, and pod-identity-association
  management.
- `DescribeUpdate` (polling an in-progress `M3LEKSUpdate`'s own status
  directly, rather than via the resource-state waiters above).
- Any kubectl-level workload operation (ADR-0029).

These are candidate follow-on wrapper PRs, filed under the ADR-0021 D4 intake
rule — unblock on a consumer actually needing one.
