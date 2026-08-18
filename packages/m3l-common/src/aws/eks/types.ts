/**
 * `aws/eks/types` — plain, library-owned shapes returned by and passed to
 * {@link M3LEKSOperations}. Every type here is a deliberate subset of the
 * corresponding `@aws-sdk/client-eks` shape — see `docs/reference/aws/eks.md`
 * for the field-by-field mapping and the fields intentionally omitted (most
 * notably `connectorConfig`, whose `activationCode`/`activationId` are
 * cluster-registration secrets).
 *
 * @packageDocumentation
 */

/**
 * The VPC configuration subset of {@link M3LEKSClusterSummary} — the network
 * plumbing an operator actually inspects, not the full SDK `VpcConfigResponse`
 * (e.g. `controlPlaneEgressMode`, `publicAccessCidrs` are omitted from v1).
 */
export interface M3LEKSVpcConfig {
  /** Subnets associated with the cluster control plane. */
  readonly subnetIds: readonly string[];
  /** Security groups for the cross-account ENIs used by the control plane. */
  readonly securityGroupIds?: readonly string[];
  /** The security group EKS created for the cluster (control-plane-to-node communication). */
  readonly clusterSecurityGroupId?: string;
  /** The VPC hosting the cluster. */
  readonly vpcId?: string;
  /** Whether the public Kubernetes API server endpoint is enabled. */
  readonly endpointPublicAccess?: boolean;
  /** Whether the private Kubernetes API server endpoint is enabled. */
  readonly endpointPrivateAccess?: boolean;
}

/**
 * The VPC configuration a caller supplies to {@link M3LEKSOperations.createCluster}
 * or {@link M3LEKSOperations.updateClusterConfig}. `subnetIds` is required by
 * `createCluster` (EKS requires at least two subnets) but optional when
 * updating an existing cluster's public/private access toggles only.
 */
export interface M3LEKSVpcConfigInput {
  /** Subnets for the cluster control plane (at least two, per EKS's own requirement). */
  readonly subnetIds?: readonly string[];
  /** Security groups for the cross-account ENIs used by the control plane. */
  readonly securityGroupIds?: readonly string[];
  /** Whether the public Kubernetes API server endpoint should be enabled. */
  readonly endpointPublicAccess?: boolean;
  /** Whether the private Kubernetes API server endpoint should be enabled. */
  readonly endpointPrivateAccess?: boolean;
}

/**
 * A cluster's control-plane description, mapped from the SDK's `Cluster`
 * shape. `name`/`arn`/`status` default to `""` when the SDK omits them
 * (`describeCluster`/`createCluster`/`deleteCluster` always populate these in
 * practice; the default only guards a malformed response); every other field
 * is included only when the SDK response defines it
 * (`exactOptionalPropertyTypes`-safe).
 *
 * Deliberately **not** mapped: `connectorConfig` (its `activationCode`/
 * `activationId` are one-time cluster-registration secrets — see
 * `docs/reference/aws/eks.md`), `encryptionConfig`, `kubernetesNetworkConfig`,
 * `logging`, `identity`, `health`, `outpostConfig`, `accessConfig`,
 * `upgradePolicy`, `zonalShiftConfig`, `remoteNetworkConfig`, `computeConfig`,
 * `storageConfig`, `clientRequestToken`, `id` — all out of scope for the
 * control-plane-listing/creation use case this v1 wrapper serves.
 * `deletionProtection` is settable via {@link M3LEKSUpdateClusterConfigInput}
 * but deliberately not read back here — write-only in this v1.
 */
export interface M3LEKSClusterSummary {
  /** The cluster's name. */
  readonly name: string;
  /** The cluster's ARN. */
  readonly arn: string;
  /** The cluster's current lifecycle status (e.g. `"ACTIVE"`, `"CREATING"`). */
  readonly status: string;
  /** The Kubernetes server version. */
  readonly version?: string;
  /** The EKS platform version. */
  readonly platformVersion?: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt?: string;
  /** The Kubernetes API server endpoint URL. */
  readonly endpoint?: string;
  /** The IAM role ARN the control plane assumes. */
  readonly roleArn?: string;
  /** The VPC configuration subset (see {@link M3LEKSVpcConfig}). */
  readonly resourcesVpcConfig?: M3LEKSVpcConfig;
  /**
   * Base64-encoded cluster CA certificate data (`certificateAuthority.data`
   * in the SDK). This is the **public** CA certificate for the
   * `kubeconfig`'s `certificate-authority-data` field, not a private key or
   * credential — safe to surface.
   */
  readonly certificateAuthorityData?: string;
  /** User-defined tags. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Result of {@link M3LEKSOperations.listClusters} — cluster **names**, not
 * ARNs (the SDK's `ListClusters` returns `clusters: string[]` of names; call
 * {@link M3LEKSOperations.describeCluster} for a name's ARN/detail).
 */
export interface M3LEKSListClustersResult {
  /** Cluster names in this page. */
  readonly clusters: readonly string[];
  /** Pagination token for the next page, when more results exist. */
  readonly nextToken?: string;
}

/** Input to {@link M3LEKSOperations.createCluster}. */
export interface M3LEKSCreateClusterInput {
  /** The new cluster's name. */
  readonly name: string;
  /** The IAM role ARN the control plane will assume. */
  readonly roleArn: string;
  /** The VPC configuration (subnets required — EKS needs at least two). */
  readonly resourcesVpcConfig: M3LEKSVpcConfigInput;
  /** The desired Kubernetes version; EKS picks its current default if omitted. */
  readonly version?: string;
  /** Tags to apply to the new cluster. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Input to {@link M3LEKSOperations.updateClusterConfig} — the VPC-access and
 * deletion-protection subset of `UpdateClusterConfig`'s full field set
 * (`logging`, `accessConfig`, `upgradePolicy`, `zonalShiftConfig`,
 * `computeConfig`, `kubernetesNetworkConfig`, `storageConfig`,
 * `remoteNetworkConfig`, `controlPlaneScalingConfig` are out of scope for v1).
 */
export interface M3LEKSUpdateClusterConfigInput {
  /** The cluster to update. */
  readonly name: string;
  /** VPC public/private access toggles and security-group changes. */
  readonly resourcesVpcConfig?: M3LEKSVpcConfigInput;
  /** Whether to enable EKS's own deletion-protection guard on the cluster. */
  readonly deletionProtection?: boolean;
}

/** Input to {@link M3LEKSOperations.updateClusterVersion}. */
export interface M3LEKSUpdateClusterVersionInput {
  /** The cluster to update. */
  readonly name: string;
  /** The target Kubernetes version. */
  readonly version: string;
  /** Forces the update even when EKS reports a health issue that would otherwise block it. */
  readonly force?: boolean;
}

/**
 * A nodegroup's control-plane description, mapped from the SDK's `Nodegroup`
 * shape. `nodegroupName`/`nodegroupArn`/`status` default to `""` when the SDK
 * omits them; every other field is included only when the SDK response
 * defines it (`exactOptionalPropertyTypes`-safe).
 *
 * Deliberately **not** mapped: `remoteAccess`, `resources`, `health`,
 * `updateConfig`, `nodeRepairConfig`, `launchTemplate`, `warmPoolConfig`,
 * `taints` — out of scope for v1 (see `docs/reference/aws/eks.md`).
 * `diskSize` is settable via {@link M3LEKSCreateNodegroupInput.diskSize} but
 * deliberately not read back here — write-only in this v1.
 */
export interface M3LEKSNodegroupSummary {
  /** The nodegroup's name. */
  readonly nodegroupName: string;
  /** The nodegroup's ARN. */
  readonly nodegroupArn: string;
  /** The nodegroup's current lifecycle status (e.g. `"ACTIVE"`, `"CREATING"`). */
  readonly status: string;
  /** The owning cluster's name. */
  readonly clusterName?: string;
  /** The Kubernetes version of the nodegroup's nodes. */
  readonly version?: string;
  /** The AMI release version. */
  readonly releaseVersion?: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt?: string;
  /** ISO-8601 last-modification timestamp. */
  readonly modifiedAt?: string;
  /** `"ON_DEMAND"`, `"SPOT"`, or `"CAPACITY_BLOCK"` — validated against the SDK enum on write, plain `string` on read. */
  readonly capacityType?: string;
  /** Min/max/desired node-count scaling bounds. */
  readonly scalingConfig?: M3LEKSNodegroupScalingConfig;
  /** EC2 instance types, when the nodegroup wasn't deployed via a launch template. */
  readonly instanceTypes?: readonly string[];
  /** Subnets the nodegroup's Auto Scaling group uses. */
  readonly subnets?: readonly string[];
  /** The AMI type (a large, SDK-versioned enum — validated on write, plain `string` on read). */
  readonly amiType?: string;
  /** The IAM role ARN the nodegroup's nodes assume. */
  readonly nodeRole?: string;
  /** Kubernetes labels applied via the EKS API (not necessarily all labels on the nodes). */
  readonly labels?: Readonly<Record<string, string>>;
  /** User-defined tags. */
  readonly tags?: Readonly<Record<string, string>>;
}

/** Min/max/desired node-count scaling bounds for a nodegroup. */
export interface M3LEKSNodegroupScalingConfig {
  /** Minimum node count the Auto Scaling group can scale in to. */
  readonly minSize?: number;
  /** Maximum node count the Auto Scaling group can scale out to. */
  readonly maxSize?: number;
  /** The node count EKS should maintain. */
  readonly desiredSize?: number;
}

/**
 * Result of {@link M3LEKSOperations.listNodegroups} — nodegroup **names**,
 * scoped to one cluster (the SDK's `ListNodegroups` requires `clusterName`).
 */
export interface M3LEKSListNodegroupsResult {
  /** Nodegroup names in this page. */
  readonly nodegroups: readonly string[];
  /** Pagination token for the next page, when more results exist. */
  readonly nextToken?: string;
}

/** Input to {@link M3LEKSOperations.createNodegroup}. */
export interface M3LEKSCreateNodegroupInput {
  /** The owning cluster's name. */
  readonly clusterName: string;
  /** The new nodegroup's name. */
  readonly nodegroupName: string;
  /** The IAM role ARN the nodegroup's nodes will assume. */
  readonly nodeRole: string;
  /** Subnets for the nodegroup's Auto Scaling group. */
  readonly subnets: readonly string[];
  /** Min/max/desired node-count scaling bounds. */
  readonly scalingConfig?: M3LEKSNodegroupScalingConfig;
  /** EC2 instance types (ignored if a launch template is later attached — out of scope for v1). */
  readonly instanceTypes?: readonly string[];
  /** The AMI type — validated against the SDK's known `AMITypes` enum members before `.send()`. */
  readonly amiType?: string;
  /** The capacity type — validated against the SDK's known `CapacityTypes` enum members before `.send()`. */
  readonly capacityType?: string;
  /** Root disk size, in GiB. */
  readonly diskSize?: number;
  /** Kubernetes labels to apply. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Tags to apply to the new nodegroup. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * The label-mutation payload for {@link M3LEKSOperations.updateNodegroupConfig},
 * mirroring the SDK's `UpdateLabelsPayload` (an additive/removal diff, not a
 * full replacement).
 */
export interface M3LEKSUpdateLabelsPayload {
  /** Labels to add or overwrite. */
  readonly addOrUpdateLabels?: Readonly<Record<string, string>>;
  /** Label keys to remove. */
  readonly removeLabels?: readonly string[];
}

/** Input to {@link M3LEKSOperations.updateNodegroupConfig}. */
export interface M3LEKSUpdateNodegroupConfigInput {
  /** The owning cluster's name. */
  readonly clusterName: string;
  /** The nodegroup to update. */
  readonly nodegroupName: string;
  /** Min/max/desired node-count scaling bounds. */
  readonly scalingConfig?: M3LEKSNodegroupScalingConfig;
  /** Kubernetes label additions/removals. */
  readonly labels?: M3LEKSUpdateLabelsPayload;
}

/** Input to {@link M3LEKSOperations.updateNodegroupVersion}. */
export interface M3LEKSUpdateNodegroupVersionInput {
  /** The owning cluster's name. */
  readonly clusterName: string;
  /** The nodegroup to update. */
  readonly nodegroupName: string;
  /** The target Kubernetes version (omit to move to `releaseVersion` only). */
  readonly version?: string;
  /** The target AMI release version. */
  readonly releaseVersion?: string;
  /** Forces the update even when EKS reports a health issue that would otherwise block it. */
  readonly force?: boolean;
}

/**
 * One error entry on an in-progress or failed {@link M3LEKSUpdate}.
 */
export interface M3LEKSUpdateError {
  /** The SDK's error code for this failure. */
  readonly errorCode?: string;
  /** Human-readable description of the failure. */
  readonly errorMessage?: string;
  /** IDs of the resources the failure relates to. */
  readonly resourceIds?: readonly string[];
}

/**
 * The asynchronous update-tracking object every `update*` method on
 * {@link M3LEKSOperations} resolves with. Unlike ECS/CodePipeline/
 * CloudFormation's synchronous `update*` calls, EKS's cluster/nodegroup
 * config and version updates are asynchronous: the call returns immediately
 * with an `Update` whose `status` starts `"InProgress"` — polling completion
 * is the caller's responsibility (there is no SDK waiter over `Update.status`;
 * the four waiters this wrapper exposes poll the target **resource**'s
 * `status` field instead, which reaches a terminal state once its most
 * recent update finishes).
 */
export interface M3LEKSUpdate {
  /** The update's ID (opaque; used only for correlating with a later `DescribeUpdate` call, out of scope for v1). */
  readonly id: string;
  /** `"InProgress"`, `"Failed"`, `"Cancelled"`, or `"Successful"`. */
  readonly status: string;
  /** The kind of update (e.g. version upgrade, config change). */
  readonly type?: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt?: string;
  /** Populated when `status` is `"Failed"`. */
  readonly errors?: readonly M3LEKSUpdateError[];
}

/**
 * Resolved by every `waitUntil*` method on {@link M3LEKSOperations}. Mirrors
 * `aws/ecs`'s waiter-result shape: a `TimeoutError`/`AbortError` resolves as
 * data (`"TIMEOUT"`/`"ABORTED"`) rather than throwing, since a caller
 * legitimately wants to distinguish "still not ready" from "the SDK call
 * itself failed".
 */
export interface M3LEKSWaiterResult {
  /** The waiter's terminal outcome. */
  readonly state: "SUCCESS" | "TIMEOUT" | "ABORTED";
  /**
   * Present for a `"TIMEOUT"`/`"ABORTED"` outcome — always a fresh, static,
   * library-constructed string naming the resource/method that was waited on
   * (e.g. `"waiter timed out before cluster name=my-cluster reached the expected state"`).
   * Never the raw SDK waiter error's own `message`: that message can embed
   * the entire last `DescribeCluster`/`DescribeNodegroup` response body —
   * including `connectorConfig`'s registration secrets — whenever
   * `@smithy/core`'s response-body deserialization fails or the response
   * omits `$metadata`.
   */
  readonly reason?: string;
}

/** Options common to every `waitUntil*` method on {@link M3LEKSOperations}. */
export interface M3LEKSWaiterOptions {
  /**
   * Bounds the wait, in seconds. Defaults to `1200` (20 minutes) when
   * omitted — see the corresponding `waitUntil*` method's TSDoc.
   */
  readonly maxWaitTime?: number;
  /**
   * When aborted while the SDK waiter is polling, the method throws
   * {@link M3LOperationAbortedError} instead of resolving. Forwarded to the
   * SDK waiter's `abortSignal` field in `WaiterConfiguration`.
   */
  readonly signal?: AbortSignal;
}
