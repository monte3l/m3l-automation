/**
 * `aws/eks/client` — {@link M3LEKSOperations}, a typed wrapper over a raw
 * `EKSClient` so callers never import `@aws-sdk/client-eks` command classes
 * directly. Scoped to EKS control-plane cluster and nodegroup operations —
 * no kubectl-level workload operations (see `docs/reference/aws/eks.md`).
 *
 * @packageDocumentation
 */

import type {
  Cluster,
  EKSClient,
  ErrorDetail,
  Nodegroup,
  NodegroupScalingConfig as SdkNodegroupScalingConfig,
  Update,
  UpdateLabelsPayload as SdkUpdateLabelsPayload,
  VpcConfigRequest,
  VpcConfigResponse,
} from "@aws-sdk/client-eks";
import {
  AMITypes,
  CapacityTypes,
  CreateClusterCommand,
  CreateNodegroupCommand,
  DeleteClusterCommand,
  DeleteNodegroupCommand,
  DescribeClusterCommand,
  DescribeNodegroupCommand,
  ListClustersCommand,
  ListNodegroupsCommand,
  UpdateClusterConfigCommand,
  UpdateClusterVersionCommand,
  UpdateNodegroupConfigCommand,
  UpdateNodegroupVersionCommand,
  waitUntilClusterActive,
  waitUntilClusterDeleted,
  waitUntilNodegroupActive,
  waitUntilNodegroupDeleted,
} from "@aws-sdk/client-eks";

import { M3LOperationAbortedError } from "../../core/errors/index.js";
import { M3LEKSOperationError } from "./error.js";
import type {
  M3LEKSClusterSummary,
  M3LEKSCreateClusterInput,
  M3LEKSCreateNodegroupInput,
  M3LEKSListClustersResult,
  M3LEKSListNodegroupsResult,
  M3LEKSNodegroupScalingConfig,
  M3LEKSNodegroupSummary,
  M3LEKSUpdate,
  M3LEKSUpdateClusterConfigInput,
  M3LEKSUpdateClusterVersionInput,
  M3LEKSUpdateError,
  M3LEKSUpdateLabelsPayload,
  M3LEKSUpdateNodegroupConfigInput,
  M3LEKSUpdateNodegroupVersionInput,
  M3LEKSVpcConfig,
  M3LEKSVpcConfigInput,
  M3LEKSWaiterOptions,
  M3LEKSWaiterResult,
} from "./types.js";

/**
 * Default `maxWaitTime` (in seconds) passed to each SDK `waitUntil*` waiter
 * when the caller omits `options.maxWaitTime` — 1200 seconds (20 minutes),
 * chosen to allow several poll intervals at EKS's own documented 30s/120s
 * min/max delay cadence (40 attempts at the 30-second floor), mirroring the
 * AWS CLI's own default EKS waiter wait budget rather than `@smithy/core`'s
 * generic 2s/120s min/max delay default.
 */
const DEFAULT_MAX_WAIT_TIME_SECONDS = 1200;

/** The full member set of the SDK's closed `AMITypes` enum. */
const AMI_TYPE_VALUES = Object.values(AMITypes);
/** The full member set of the SDK's closed `CapacityTypes` enum. */
const CAPACITY_TYPE_VALUES = Object.values(CapacityTypes);

/**
 * Narrows a caller-supplied `string` into one of the SDK's closed enum
 * members, "earning" the narrowing rather than asserting it blindly with
 * `as`. `M3LEKSCreateNodegroupInput.amiType`/`.capacityType` stay plain
 * `string` on this module's public surface (per the enum-asymmetry
 * convention — read-path fields also stay `string`), but the SDK's own
 * `CreateNodegroupCommandInput` requires the real closed enum, so an invalid
 * caller value is validated and rejected here, client-side, before any
 * `.send()` call — rather than surfacing only as a validation failure from
 * EKS after a network round-trip.
 *
 * @param value - The caller-supplied string to validate.
 * @param knownValues - The SDK enum's full member set.
 * @param fieldLabel - The field name, folded into the thrown error.
 * @param methodName - The calling method's name, folded into the thrown
 *   error's message (reusable across call sites — never hardcode a caller name here).
 * @returns `value`, narrowed to `T`.
 * @throws {@link M3LEKSOperationError} when `value` is not a member of `knownValues`.
 */
function assertKnownEnumValue<T extends string>(
  value: string,
  knownValues: readonly T[],
  fieldLabel: string,
  methodName: string,
): T {
  if ((knownValues as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new M3LEKSOperationError(
    `M3LEKSOperations.${methodName}: invalid ${fieldLabel}=${value} (expected one of: ${knownValues.join(", ")})`,
  );
}

/**
 * Translates an SDK `VpcConfigResponse`-shaped object into the plain
 * {@link M3LEKSVpcConfig}. `subnetIds` defaults to `[]` when the SDK omits
 * it; every other field is included only when the SDK response defines it
 * (`exactOptionalPropertyTypes`-safe).
 *
 * @param vpcConfig - The SDK's `VpcConfigResponse`-shaped object.
 * @returns The plain, library-owned VPC-configuration shape.
 */
function mapVpcConfig(vpcConfig: VpcConfigResponse): M3LEKSVpcConfig {
  return {
    subnetIds: vpcConfig.subnetIds ?? [],
    ...(vpcConfig.securityGroupIds !== undefined && {
      securityGroupIds: vpcConfig.securityGroupIds,
    }),
    ...(vpcConfig.clusterSecurityGroupId !== undefined && {
      clusterSecurityGroupId: vpcConfig.clusterSecurityGroupId,
    }),
    ...(vpcConfig.vpcId !== undefined && { vpcId: vpcConfig.vpcId }),
    ...(vpcConfig.endpointPublicAccess !== undefined && {
      endpointPublicAccess: vpcConfig.endpointPublicAccess,
    }),
    ...(vpcConfig.endpointPrivateAccess !== undefined && {
      endpointPrivateAccess: vpcConfig.endpointPrivateAccess,
    }),
  };
}

/**
 * Builds an SDK `VpcConfigRequest`-shaped object from the plain
 * {@link M3LEKSVpcConfigInput}, each field included only when the caller
 * supplied it (`exactOptionalPropertyTypes`-safe).
 *
 * @param vpcConfig - The caller's plain VPC-configuration input.
 * @returns The SDK command-input `VpcConfigRequest` shape.
 */
function buildVpcConfigRequest(
  vpcConfig: M3LEKSVpcConfigInput,
): VpcConfigRequest {
  return {
    ...(vpcConfig.subnetIds !== undefined && {
      subnetIds: [...vpcConfig.subnetIds],
    }),
    ...(vpcConfig.securityGroupIds !== undefined && {
      securityGroupIds: [...vpcConfig.securityGroupIds],
    }),
    ...(vpcConfig.endpointPublicAccess !== undefined && {
      endpointPublicAccess: vpcConfig.endpointPublicAccess,
    }),
    ...(vpcConfig.endpointPrivateAccess !== undefined && {
      endpointPrivateAccess: vpcConfig.endpointPrivateAccess,
    }),
  };
}

/**
 * The optional-field subset of {@link M3LEKSClusterSummary} — every field
 * except `name`/`arn`/`status`. Split out of {@link mapClusterSummary} to
 * keep that function's cyclomatic complexity within the lint budget.
 * Deliberately omits `connectorConfig` — see `docs/reference/aws/eks.md`.
 *
 * @param cluster - The SDK's `Cluster`-shaped object.
 * @returns The optional-field subset of the plain cluster-summary shape.
 */
function mapOptionalClusterFields(
  cluster: Cluster,
): Omit<M3LEKSClusterSummary, "name" | "arn" | "status"> {
  return {
    ...(cluster.version !== undefined && { version: cluster.version }),
    ...(cluster.platformVersion !== undefined && {
      platformVersion: cluster.platformVersion,
    }),
    ...(cluster.createdAt !== undefined && {
      createdAt: cluster.createdAt.toISOString(),
    }),
    ...(cluster.endpoint !== undefined && { endpoint: cluster.endpoint }),
    ...(cluster.roleArn !== undefined && { roleArn: cluster.roleArn }),
    ...(cluster.resourcesVpcConfig !== undefined && {
      resourcesVpcConfig: mapVpcConfig(cluster.resourcesVpcConfig),
    }),
    ...(cluster.certificateAuthority?.data !== undefined && {
      certificateAuthorityData: cluster.certificateAuthority.data,
    }),
    ...(cluster.tags !== undefined && { tags: cluster.tags }),
  };
}

/**
 * Translates an SDK `Cluster`-shaped object into the plain
 * {@link M3LEKSClusterSummary}. `name`/`arn`/`status` default to `""` when
 * the SDK omits them; every other field is included only when the SDK
 * response defines it (`exactOptionalPropertyTypes`-safe). Never maps
 * `connectorConfig` — its `activationCode`/`activationId` are one-time
 * cluster-registration secrets (see `docs/reference/aws/eks.md`).
 *
 * @param cluster - The SDK's `Cluster`-shaped object.
 * @returns The plain, library-owned cluster-summary shape.
 */
function mapClusterSummary(cluster: Cluster): M3LEKSClusterSummary {
  return {
    name: cluster.name ?? "",
    arn: cluster.arn ?? "",
    status: cluster.status ?? "",
    ...mapOptionalClusterFields(cluster),
  };
}

/**
 * Translates an SDK `NodegroupScalingConfig`-shaped object into the plain
 * {@link M3LEKSNodegroupScalingConfig}, each field included only when the SDK
 * response defines it (`exactOptionalPropertyTypes`-safe).
 *
 * @param scalingConfig - The SDK's `NodegroupScalingConfig`-shaped object.
 * @returns The plain, library-owned scaling-configuration shape.
 */
function mapNodegroupScalingConfig(
  scalingConfig: SdkNodegroupScalingConfig,
): M3LEKSNodegroupScalingConfig {
  return {
    ...(scalingConfig.minSize !== undefined && {
      minSize: scalingConfig.minSize,
    }),
    ...(scalingConfig.maxSize !== undefined && {
      maxSize: scalingConfig.maxSize,
    }),
    ...(scalingConfig.desiredSize !== undefined && {
      desiredSize: scalingConfig.desiredSize,
    }),
  };
}

/**
 * Builds an SDK `NodegroupScalingConfig`-shaped object from the plain
 * {@link M3LEKSNodegroupScalingConfig}, each field included only when the
 * caller supplied it (`exactOptionalPropertyTypes`-safe).
 *
 * @param scalingConfig - The caller's plain scaling-configuration shape.
 * @returns The SDK command-input `NodegroupScalingConfig` shape.
 */
function buildNodegroupScalingConfig(
  scalingConfig: M3LEKSNodegroupScalingConfig,
): SdkNodegroupScalingConfig {
  return {
    ...(scalingConfig.minSize !== undefined && {
      minSize: scalingConfig.minSize,
    }),
    ...(scalingConfig.maxSize !== undefined && {
      maxSize: scalingConfig.maxSize,
    }),
    ...(scalingConfig.desiredSize !== undefined && {
      desiredSize: scalingConfig.desiredSize,
    }),
  };
}

/**
 * Builds an SDK `UpdateLabelsPayload`-shaped object from the plain
 * {@link M3LEKSUpdateLabelsPayload}, each field included only when the
 * caller supplied it (`exactOptionalPropertyTypes`-safe).
 *
 * @param labels - The caller's plain label-mutation payload.
 * @returns The SDK command-input `UpdateLabelsPayload` shape.
 */
function buildUpdateLabelsPayload(
  labels: M3LEKSUpdateLabelsPayload,
): SdkUpdateLabelsPayload {
  return {
    ...(labels.addOrUpdateLabels !== undefined && {
      addOrUpdateLabels: { ...labels.addOrUpdateLabels },
    }),
    ...(labels.removeLabels !== undefined && {
      removeLabels: [...labels.removeLabels],
    }),
  };
}

/**
 * The `clusterName`/`version`/`releaseVersion`/`createdAt`/`modifiedAt`/
 * `capacityType`/`scalingConfig` subset of {@link M3LEKSNodegroupSummary},
 * each included only when the SDK response defines the corresponding field
 * (`exactOptionalPropertyTypes`-safe). Split out of
 * {@link mapOptionalNodegroupFields} to keep that function's cyclomatic
 * complexity within the lint budget.
 *
 * @param nodegroup - The SDK's `Nodegroup`-shaped object.
 * @returns The descriptive-field subset of the plain nodegroup-summary shape.
 */
function mapNodegroupDescriptiveFields(
  nodegroup: Nodegroup,
): Pick<
  M3LEKSNodegroupSummary,
  | "clusterName"
  | "version"
  | "releaseVersion"
  | "createdAt"
  | "modifiedAt"
  | "capacityType"
  | "scalingConfig"
> {
  return {
    ...(nodegroup.clusterName !== undefined && {
      clusterName: nodegroup.clusterName,
    }),
    ...(nodegroup.version !== undefined && { version: nodegroup.version }),
    ...(nodegroup.releaseVersion !== undefined && {
      releaseVersion: nodegroup.releaseVersion,
    }),
    ...(nodegroup.createdAt !== undefined && {
      createdAt: nodegroup.createdAt.toISOString(),
    }),
    ...(nodegroup.modifiedAt !== undefined && {
      modifiedAt: nodegroup.modifiedAt.toISOString(),
    }),
    ...(nodegroup.capacityType !== undefined && {
      capacityType: nodegroup.capacityType,
    }),
    ...(nodegroup.scalingConfig !== undefined && {
      scalingConfig: mapNodegroupScalingConfig(nodegroup.scalingConfig),
    }),
  };
}

/**
 * The `instanceTypes`/`subnets`/`amiType`/`nodeRole`/`labels`/`tags` subset
 * of {@link M3LEKSNodegroupSummary}, each included only when the SDK
 * response defines the corresponding field
 * (`exactOptionalPropertyTypes`-safe). Split out of
 * {@link mapOptionalNodegroupFields} to keep that function's cyclomatic
 * complexity within the lint budget.
 *
 * @param nodegroup - The SDK's `Nodegroup`-shaped object.
 * @returns The deployment-field subset of the plain nodegroup-summary shape.
 */
function mapNodegroupDeploymentFields(
  nodegroup: Nodegroup,
): Pick<
  M3LEKSNodegroupSummary,
  "instanceTypes" | "subnets" | "amiType" | "nodeRole" | "labels" | "tags"
> {
  return {
    ...(nodegroup.instanceTypes !== undefined && {
      instanceTypes: nodegroup.instanceTypes,
    }),
    ...(nodegroup.subnets !== undefined && { subnets: nodegroup.subnets }),
    ...(nodegroup.amiType !== undefined && { amiType: nodegroup.amiType }),
    ...(nodegroup.nodeRole !== undefined && { nodeRole: nodegroup.nodeRole }),
    ...(nodegroup.labels !== undefined && { labels: nodegroup.labels }),
    ...(nodegroup.tags !== undefined && { tags: nodegroup.tags }),
  };
}

/**
 * The optional-field subset of {@link M3LEKSNodegroupSummary} — every field
 * except `nodegroupName`/`nodegroupArn`/`status`. Combines
 * {@link mapNodegroupDescriptiveFields} and
 * {@link mapNodegroupDeploymentFields}. Split out of
 * {@link mapNodegroupSummary} to keep that function's cyclomatic complexity
 * within the lint budget.
 *
 * @param nodegroup - The SDK's `Nodegroup`-shaped object.
 * @returns The optional-field subset of the plain nodegroup-summary shape.
 */
function mapOptionalNodegroupFields(
  nodegroup: Nodegroup,
): Omit<M3LEKSNodegroupSummary, "nodegroupName" | "nodegroupArn" | "status"> {
  return {
    ...mapNodegroupDescriptiveFields(nodegroup),
    ...mapNodegroupDeploymentFields(nodegroup),
  };
}

/**
 * Translates an SDK `Nodegroup`-shaped object into the plain
 * {@link M3LEKSNodegroupSummary}. `nodegroupName`/`nodegroupArn`/`status`
 * default to `""` when the SDK omits them; every other field is included
 * only when the SDK response defines it (`exactOptionalPropertyTypes`-safe).
 *
 * @param nodegroup - The SDK's `Nodegroup`-shaped object.
 * @returns The plain, library-owned nodegroup-summary shape.
 */
function mapNodegroupSummary(nodegroup: Nodegroup): M3LEKSNodegroupSummary {
  return {
    nodegroupName: nodegroup.nodegroupName ?? "",
    nodegroupArn: nodegroup.nodegroupArn ?? "",
    status: nodegroup.status ?? "",
    ...mapOptionalNodegroupFields(nodegroup),
  };
}

/**
 * Translates an SDK `ErrorDetail`-shaped object into the plain
 * {@link M3LEKSUpdateError}, each field included only when the SDK response
 * defines it (`exactOptionalPropertyTypes`-safe).
 *
 * @param error - The SDK's `ErrorDetail`-shaped object.
 * @returns The plain, library-owned update-error shape.
 */
function mapUpdateError(error: ErrorDetail): M3LEKSUpdateError {
  return {
    ...(error.errorCode !== undefined && { errorCode: error.errorCode }),
    ...(error.errorMessage !== undefined && {
      errorMessage: error.errorMessage,
    }),
    ...(error.resourceIds !== undefined && {
      resourceIds: error.resourceIds,
    }),
  };
}

/**
 * Translates an SDK `Update`-shaped object into the plain
 * {@link M3LEKSUpdate}. `id`/`status` default to `""` when the SDK omits
 * them; every other field is included only when the SDK response defines it
 * (`exactOptionalPropertyTypes`-safe). Deliberately omits `params`/
 * `cancellation` — see `docs/reference/aws/eks.md`.
 *
 * @param update - The SDK's `Update`-shaped object.
 * @returns The plain, library-owned update-tracking shape.
 */
function mapUpdate(update: Update): M3LEKSUpdate {
  return {
    id: update.id ?? "",
    status: update.status ?? "",
    ...(update.type !== undefined && { type: update.type }),
    ...(update.createdAt !== undefined && {
      createdAt: update.createdAt.toISOString(),
    }),
    ...(update.errors !== undefined && {
      errors: update.errors.map(mapUpdateError),
    }),
  };
}

/**
 * Validates and narrows `input.amiType`/`input.capacityType` against the
 * SDK's closed `AMITypes`/`CapacityTypes` enums, before any `.send()` call.
 * Split out of {@link M3LEKSOperations.createNodegroup} to keep that
 * method's cyclomatic complexity within the lint budget.
 *
 * @param input - The caller's nodegroup-creation input.
 * @param methodName - The calling method's name, forwarded to
 *   {@link assertKnownEnumValue} for its thrown error's message.
 * @returns The validated, narrowed `amiType`/`capacityType` pair — each
 *   included only when the caller supplied the corresponding field
 *   (`exactOptionalPropertyTypes`-safe).
 * @throws {@link M3LEKSOperationError} when either field is supplied but is
 *   not a member of its SDK enum.
 */
function resolveNodegroupEnumFields(
  input: M3LEKSCreateNodegroupInput,
  methodName: string,
): {
  readonly amiType?: AMITypes;
  readonly capacityType?: CapacityTypes;
} {
  return {
    ...(input.amiType !== undefined && {
      amiType: assertKnownEnumValue(
        input.amiType,
        AMI_TYPE_VALUES,
        "amiType",
        methodName,
      ),
    }),
    ...(input.capacityType !== undefined && {
      capacityType: assertKnownEnumValue(
        input.capacityType,
        CAPACITY_TYPE_VALUES,
        "capacityType",
        methodName,
      ),
    }),
  };
}

/**
 * Builds the SDK `CreateNodegroupCommand` input from the caller's plain
 * {@link M3LEKSCreateNodegroupInput} and the pre-validated `amiType`/
 * `capacityType` pair, each optional field included only when the caller
 * supplied it (`exactOptionalPropertyTypes`-safe). Split out of
 * {@link M3LEKSOperations.createNodegroup} to keep that method's cyclomatic
 * complexity within the lint budget.
 *
 * @param input - The caller's nodegroup-creation input.
 * @param enumFields - The pre-validated `amiType`/`capacityType` pair (see
 *   {@link resolveNodegroupEnumFields}).
 * @returns The SDK command-input `CreateNodegroupCommand` constructor argument.
 */
function buildCreateNodegroupInput(
  input: M3LEKSCreateNodegroupInput,
  enumFields: {
    readonly amiType?: AMITypes;
    readonly capacityType?: CapacityTypes;
  },
): {
  readonly clusterName: string;
  readonly nodegroupName: string;
  readonly nodeRole: string;
  readonly subnets: string[];
  readonly scalingConfig?: SdkNodegroupScalingConfig;
  readonly instanceTypes?: string[];
  readonly amiType?: AMITypes;
  readonly capacityType?: CapacityTypes;
  readonly diskSize?: number;
  readonly labels?: Record<string, string>;
  readonly tags?: Record<string, string>;
} {
  return {
    clusterName: input.clusterName,
    nodegroupName: input.nodegroupName,
    nodeRole: input.nodeRole,
    subnets: [...input.subnets],
    ...(input.scalingConfig !== undefined && {
      scalingConfig: buildNodegroupScalingConfig(input.scalingConfig),
    }),
    ...(input.instanceTypes !== undefined && {
      instanceTypes: [...input.instanceTypes],
    }),
    ...enumFields,
    ...(input.diskSize !== undefined && { diskSize: input.diskSize }),
    ...(input.labels !== undefined && { labels: { ...input.labels } }),
    ...(input.tags !== undefined && { tags: { ...input.tags } }),
  };
}

/**
 * Returns `true` when `signal` is defined and its `aborted` flag is set.
 * Extracted as a named helper to avoid a TS2367 false alarm: TypeScript
 * narrows `signal.aborted` to `false` after an inline check and unsoundly
 * keeps that narrowing across an `await` — reading it through a function call
 * bypasses the stale narrowing without deleting the check.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Runs one of the SDK's standalone `waitUntil*` waiter functions, translating
 * its own `TimeoutError`/`AbortError` rejections into a resolved
 * {@link M3LEKSWaiterResult} and wrapping any other rejection as a thrown
 * {@link M3LEKSOperationError}. Shared by all four `waitUntil*` methods to
 * keep each one a thin, one-line delegation (see
 * `docs/reference/aws/eks.md`'s "Waiters" section).
 *
 * **Caller-signal abort:** when `signal` is provided and the SDK waiter throws
 * an `AbortError` while `signal` is already aborted, this function rejects
 * with {@link M3LOperationAbortedError} instead of resolving. The
 * `"ABORTED"` resolved state is therefore only reachable when the SDK waiter
 * throws an `AbortError` with **no** matching caller signal (e.g. the SDK's
 * own internal abort path).
 *
 * @param invoke - Calls the underlying SDK waiter function.
 * @param methodName - The calling method's name, folded into the thrown
 *   error's message.
 * @param resourceDescription - A human-readable identifier for the resource
 *   being waited on (e.g. `cluster name=my-cluster`), built by the caller
 *   from parameters it already has — never derived from the SDK error.
 *   Folded into the `TIMEOUT`/`ABORTED` `reason` string.
 * @param signal - The caller's `AbortSignal`, forwarded to the SDK waiter and
 *   inspected in the `AbortError` arm to distinguish a caller-initiated abort
 *   from an SDK-internal one.
 * @returns `{ state: "SUCCESS" }`, or a resolved `TIMEOUT`/`ABORTED` state
 *   whose `reason` is always a fresh, library-constructed string. The
 *   `"ABORTED"` state is only reachable when an `AbortError` arrives with
 *   no aborted caller signal (i.e. an SDK-internal abort path).
 * @throws {@link M3LOperationAbortedError} when `signal` is aborted and the
 *   SDK waiter throws `AbortError`.
 * @throws {@link M3LEKSOperationError} on any other rejection. The SDK's own
 *   `FAILURE` terminal waiter state surfaces as a plain `Error` with
 *   `name === "Error"` — indistinguishable by identity from a genuine
 *   `Describe*` call failure, so it is treated as a fault. The FAILURE path,
 *   the SDK's `WaiterResult` on a successful resolve, **and** the raw
 *   `TimeoutError`/`AbortError`'s own `message` can all embed the entire last
 *   `DescribeCluster`/`DescribeNodegroup` response — via `@smithy/core`'s
 *   `checkExceptions`/`createMessageFromResponse`, which serializes the whole
 *   response into the message whenever `$metadata` is absent or response-body
 *   deserialization fails — and that response can carry
 *   `connectorConfig`'s registration secrets. So every outcome here (thrown
 *   error message, and the resolved `TIMEOUT`/`ABORTED` `reason`) is always a
 *   fresh, static string built only from `methodName`/`resourceDescription`;
 *   the raw waiter error's `message` is never read and never chained as `cause`.
 */
async function runEksWaiter(
  invoke: () => Promise<unknown>,
  methodName: string,
  resourceDescription: string,
  signal?: AbortSignal,
): Promise<M3LEKSWaiterResult> {
  try {
    await invoke();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return {
        state: "TIMEOUT",
        reason: `waiter timed out before ${resourceDescription} reached the expected state`,
      };
    }
    if (error instanceof Error && error.name === "AbortError") {
      if (isAborted(signal)) {
        throw new M3LOperationAbortedError();
      }
      return {
        state: "ABORTED",
        reason: `waiter aborted before ${resourceDescription} reached the expected state`,
      };
    }
    throw new M3LEKSOperationError(
      `M3LEKSOperations.${methodName}: waiter polling failed`,
    );
  }

  return { state: "SUCCESS" };
}

/** Optional filter/pagination parameters for {@link M3LEKSOperations.listClusters}. */
export interface M3LEKSListClustersOptions {
  /** Maximum clusters to return in this page. */
  readonly maxResults?: number;
  /** Continues a previous paginated call. */
  readonly nextToken?: string;
  /** Filters by cluster kind (e.g. connected/on-Outposts) — passed through verbatim to the SDK. */
  readonly include?: readonly string[];
}

/** Optional pagination parameters for {@link M3LEKSOperations.listNodegroups}. */
export interface M3LEKSListNodegroupsOptions {
  /** Maximum nodegroups to return in this page. */
  readonly maxResults?: number;
  /** Continues a previous paginated call. */
  readonly nextToken?: string;
}

/**
 * Typed operations wrapper over a raw `EKSClient`, covering EKS
 * **control-plane** cluster and nodegroup list/describe/create/update/delete
 * plus lifecycle waiters — without any caller ever importing an
 * `@aws-sdk/client-eks` command class directly (ADR-0029 — scripts depend
 * only on `@m3l-automation/m3l-common`). Kubectl-level workload operations
 * (pods/deployments/services) are out of scope; see
 * `docs/reference/aws/eks.md`.
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 *
 * const eksOperations = new AWS.M3LEKSOperations(script.aws.clients.eks);
 * const { clusters } = await eksOperations.listClusters();
 * ```
 */
export class M3LEKSOperations {
  /**
   * Creates a new `M3LEKSOperations`.
   *
   * @param client - The raw `EKSClient` this wrapper issues commands through
   *   (e.g. `script.aws.clients.eks`).
   */
  constructor(private readonly client: EKSClient) {}

  /**
   * Lists cluster **names** in the account/region, one page at a time (the
   * SDK's `ListClusters` returns names, not ARNs — call {@link describeCluster}
   * for detail on a specific name).
   *
   * @param options - Pagination/filter options.
   * @throws {@link M3LEKSOperationError} if the underlying `ListClusters` call fails.
   */
  async listClusters(
    options?: M3LEKSListClustersOptions,
  ): Promise<M3LEKSListClustersResult> {
    let response;
    try {
      response = await this.client.send(
        new ListClustersCommand({
          ...(options?.nextToken !== undefined && {
            nextToken: options.nextToken,
          }),
          ...(options?.maxResults !== undefined && {
            maxResults: options.maxResults,
          }),
          ...(options?.include !== undefined && {
            include: [...options.include],
          }),
        }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        "M3LEKSOperations.listClusters: ListClusters failed",
        { cause },
      );
    }

    return {
      clusters: response.clusters ?? [],
      ...(response.nextToken !== undefined && {
        nextToken: response.nextToken,
      }),
    };
  }

  /**
   * Retrieves a single cluster's full description.
   *
   * @param name - The cluster's name.
   * @throws {@link M3LEKSOperationError} if the underlying `DescribeCluster`
   *   call fails for a reason other than the cluster not existing.
   * @returns `undefined` if no cluster with this name exists (the SDK's
   *   `ResourceNotFoundException`), the cluster's description otherwise.
   */
  async describeCluster(
    name: string,
  ): Promise<M3LEKSClusterSummary | undefined> {
    let response;
    try {
      response = await this.client.send(new DescribeClusterCommand({ name }));
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.name === "ResourceNotFoundException"
      ) {
        return undefined;
      }
      throw new M3LEKSOperationError(
        `M3LEKSOperations.describeCluster: DescribeCluster failed for name=${name}`,
        { cause },
      );
    }

    return mapClusterSummary(response.cluster ?? {});
  }

  /**
   * Creates a new EKS cluster control plane.
   *
   * @param input - The new cluster's definition.
   * @throws {@link M3LEKSOperationError} if the underlying `CreateCluster` call fails.
   */
  async createCluster(
    input: M3LEKSCreateClusterInput,
  ): Promise<M3LEKSClusterSummary> {
    let response;
    try {
      response = await this.client.send(
        new CreateClusterCommand({
          name: input.name,
          roleArn: input.roleArn,
          resourcesVpcConfig: buildVpcConfigRequest(input.resourcesVpcConfig),
          ...(input.version !== undefined && { version: input.version }),
          ...(input.tags !== undefined && { tags: { ...input.tags } }),
        }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.createCluster: CreateCluster failed for name=${input.name}`,
        { cause },
      );
    }

    return mapClusterSummary(response.cluster ?? {});
  }

  /**
   * Starts an asynchronous VPC-access/deletion-protection config update on
   * an existing cluster. Returns immediately with an in-progress
   * {@link M3LEKSUpdate} — poll {@link waitUntilClusterActive} to observe the
   * cluster reach a terminal state.
   *
   * @param input - The cluster to update and the fields to change.
   * @throws {@link M3LEKSOperationError} if the underlying `UpdateClusterConfig` call fails.
   */
  async updateClusterConfig(
    input: M3LEKSUpdateClusterConfigInput,
  ): Promise<M3LEKSUpdate> {
    let response;
    try {
      response = await this.client.send(
        new UpdateClusterConfigCommand({
          name: input.name,
          ...(input.resourcesVpcConfig !== undefined && {
            resourcesVpcConfig: buildVpcConfigRequest(input.resourcesVpcConfig),
          }),
          ...(input.deletionProtection !== undefined && {
            deletionProtection: input.deletionProtection,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.updateClusterConfig: UpdateClusterConfig failed for name=${input.name}`,
        { cause },
      );
    }

    return mapUpdate(response.update ?? {});
  }

  /**
   * Starts an asynchronous Kubernetes-version upgrade on an existing
   * cluster. Returns immediately with an in-progress {@link M3LEKSUpdate} —
   * poll {@link waitUntilClusterActive} to observe the cluster reach a
   * terminal state.
   *
   * @param input - The cluster and target version.
   * @throws {@link M3LEKSOperationError} if the underlying `UpdateClusterVersion` call fails.
   */
  async updateClusterVersion(
    input: M3LEKSUpdateClusterVersionInput,
  ): Promise<M3LEKSUpdate> {
    let response;
    try {
      response = await this.client.send(
        new UpdateClusterVersionCommand({
          name: input.name,
          version: input.version,
          ...(input.force !== undefined && { force: input.force }),
        }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.updateClusterVersion: UpdateClusterVersion failed for name=${input.name}`,
        { cause },
      );
    }

    return mapUpdate(response.update ?? {});
  }

  /**
   * Deletes a cluster's control plane. Destructive — the caller
   * (`scripts/eks-ops`) is responsible for its own confirmation gate; this
   * wrapper performs no guard of its own.
   *
   * @param name - The cluster's name.
   * @throws {@link M3LEKSOperationError} if the underlying `DeleteCluster` call fails.
   */
  async deleteCluster(name: string): Promise<M3LEKSClusterSummary> {
    let response;
    try {
      response = await this.client.send(new DeleteClusterCommand({ name }));
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.deleteCluster: DeleteCluster failed for name=${name}`,
        { cause },
      );
    }

    return mapClusterSummary(response.cluster ?? {});
  }

  /**
   * Waits for a cluster to reach the `ACTIVE` state, wrapping the SDK's own
   * `waitUntilClusterActive` waiter in a `try`/`catch` that resolves a
   * timeout/abort as data instead of throwing (mirrors `aws/ecs`'s
   * `waitUntilServicesStable`).
   *
   * @param name - The cluster's name.
   * @param options - `maxWaitTime` bounds the wait, in seconds; defaults to
   *   `1200` (see {@link DEFAULT_MAX_WAIT_TIME_SECONDS}). When `options.signal`
   *   is supplied and aborts while the SDK waiter is polling, this method throws
   *   {@link M3LOperationAbortedError} instead of resolving.
   * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
   *   while the SDK waiter is polling.
   * @throws {@link M3LEKSOperationError} for any rejection other than the
   *   waiter's own timeout/abort.
   */
  waitUntilClusterActive(
    name: string,
    options?: M3LEKSWaiterOptions,
  ): Promise<M3LEKSWaiterResult> {
    const signal = options?.signal;
    return runEksWaiter(
      () =>
        waitUntilClusterActive(
          {
            client: this.client,
            maxWaitTime: options?.maxWaitTime ?? DEFAULT_MAX_WAIT_TIME_SECONDS,
            ...(signal !== undefined ? { abortSignal: signal } : {}),
          },
          { name },
        ),
      "waitUntilClusterActive",
      `cluster name=${name}`,
      signal,
    );
  }

  /**
   * Waits for a cluster to be fully deleted, wrapping the SDK's own
   * `waitUntilClusterDeleted` waiter.
   *
   * @param name - The cluster's name.
   * @param options - `maxWaitTime` bounds the wait, in seconds; defaults to
   *   `1200` (see {@link DEFAULT_MAX_WAIT_TIME_SECONDS}). When `options.signal`
   *   is supplied and aborts while the SDK waiter is polling, this method throws
   *   {@link M3LOperationAbortedError} instead of resolving.
   * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
   *   while the SDK waiter is polling.
   * @throws {@link M3LEKSOperationError} for any rejection other than the
   *   waiter's own timeout/abort.
   */
  waitUntilClusterDeleted(
    name: string,
    options?: M3LEKSWaiterOptions,
  ): Promise<M3LEKSWaiterResult> {
    const signal = options?.signal;
    return runEksWaiter(
      () =>
        waitUntilClusterDeleted(
          {
            client: this.client,
            maxWaitTime: options?.maxWaitTime ?? DEFAULT_MAX_WAIT_TIME_SECONDS,
            ...(signal !== undefined ? { abortSignal: signal } : {}),
          },
          { name },
        ),
      "waitUntilClusterDeleted",
      `cluster name=${name}`,
      signal,
    );
  }

  /**
   * Lists nodegroup **names** in a cluster, one page at a time.
   *
   * @param clusterName - The owning cluster's name.
   * @param options - Pagination options.
   * @throws {@link M3LEKSOperationError} if the underlying `ListNodegroups`
   *   call fails — including when `clusterName` doesn't exist
   *   (`ResourceNotFoundException` is not special-cased into an empty page
   *   here, unlike the single-resource `describe*` methods).
   */
  async listNodegroups(
    clusterName: string,
    options?: M3LEKSListNodegroupsOptions,
  ): Promise<M3LEKSListNodegroupsResult> {
    let response;
    try {
      response = await this.client.send(
        new ListNodegroupsCommand({
          clusterName,
          ...(options?.nextToken !== undefined && {
            nextToken: options.nextToken,
          }),
          ...(options?.maxResults !== undefined && {
            maxResults: options.maxResults,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.listNodegroups: ListNodegroups failed for clusterName=${clusterName}`,
        { cause },
      );
    }

    return {
      nodegroups: response.nodegroups ?? [],
      ...(response.nextToken !== undefined && {
        nextToken: response.nextToken,
      }),
    };
  }

  /**
   * Retrieves a single nodegroup's full description.
   *
   * @param clusterName - The owning cluster's name.
   * @param nodegroupName - The nodegroup's name.
   * @throws {@link M3LEKSOperationError} if the underlying `DescribeNodegroup`
   *   call fails for a reason other than the nodegroup not existing.
   * @returns `undefined` if no nodegroup with this name exists in this
   *   cluster (the SDK's `ResourceNotFoundException`), the nodegroup's
   *   description otherwise.
   */
  async describeNodegroup(
    clusterName: string,
    nodegroupName: string,
  ): Promise<M3LEKSNodegroupSummary | undefined> {
    let response;
    try {
      response = await this.client.send(
        new DescribeNodegroupCommand({ clusterName, nodegroupName }),
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.name === "ResourceNotFoundException"
      ) {
        return undefined;
      }
      throw new M3LEKSOperationError(
        `M3LEKSOperations.describeNodegroup: DescribeNodegroup failed for clusterName=${clusterName}, nodegroupName=${nodegroupName}`,
        { cause },
      );
    }

    return mapNodegroupSummary(response.nodegroup ?? {});
  }

  /**
   * Creates a new managed nodegroup in an existing cluster.
   *
   * @param input - The new nodegroup's definition.
   * @throws {@link M3LEKSOperationError} if the underlying `CreateNodegroup`
   *   call fails, or if `amiType`/`capacityType` is supplied but is not a
   *   member of the SDK's known enum values (validated before any `.send()` call).
   */
  async createNodegroup(
    input: M3LEKSCreateNodegroupInput,
  ): Promise<M3LEKSNodegroupSummary> {
    const enumFields = resolveNodegroupEnumFields(input, "createNodegroup");

    let response;
    try {
      response = await this.client.send(
        new CreateNodegroupCommand(
          buildCreateNodegroupInput(input, enumFields),
        ),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.createNodegroup: CreateNodegroup failed for nodegroupName=${input.nodegroupName}`,
        { cause },
      );
    }

    return mapNodegroupSummary(response.nodegroup ?? {});
  }

  /**
   * Starts an asynchronous scaling/label config update on an existing
   * nodegroup. Returns immediately with an in-progress {@link M3LEKSUpdate} —
   * poll {@link waitUntilNodegroupActive} to observe the nodegroup reach a
   * terminal state.
   *
   * @param input - The nodegroup to update and the fields to change.
   * @throws {@link M3LEKSOperationError} if the underlying `UpdateNodegroupConfig` call fails.
   */
  async updateNodegroupConfig(
    input: M3LEKSUpdateNodegroupConfigInput,
  ): Promise<M3LEKSUpdate> {
    let response;
    try {
      response = await this.client.send(
        new UpdateNodegroupConfigCommand({
          clusterName: input.clusterName,
          nodegroupName: input.nodegroupName,
          ...(input.scalingConfig !== undefined && {
            scalingConfig: buildNodegroupScalingConfig(input.scalingConfig),
          }),
          ...(input.labels !== undefined && {
            labels: buildUpdateLabelsPayload(input.labels),
          }),
        }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.updateNodegroupConfig: UpdateNodegroupConfig failed for nodegroupName=${input.nodegroupName}`,
        { cause },
      );
    }

    return mapUpdate(response.update ?? {});
  }

  /**
   * Starts an asynchronous Kubernetes-version/AMI-release upgrade on an
   * existing nodegroup. Returns immediately with an in-progress
   * {@link M3LEKSUpdate} — poll {@link waitUntilNodegroupActive} to observe
   * the nodegroup reach a terminal state.
   *
   * @param input - The nodegroup and target version/release.
   * @throws {@link M3LEKSOperationError} if the underlying `UpdateNodegroupVersion` call fails.
   */
  async updateNodegroupVersion(
    input: M3LEKSUpdateNodegroupVersionInput,
  ): Promise<M3LEKSUpdate> {
    let response;
    try {
      response = await this.client.send(
        new UpdateNodegroupVersionCommand({
          clusterName: input.clusterName,
          nodegroupName: input.nodegroupName,
          ...(input.version !== undefined && { version: input.version }),
          ...(input.releaseVersion !== undefined && {
            releaseVersion: input.releaseVersion,
          }),
          ...(input.force !== undefined && { force: input.force }),
        }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.updateNodegroupVersion: UpdateNodegroupVersion failed for nodegroupName=${input.nodegroupName}`,
        { cause },
      );
    }

    return mapUpdate(response.update ?? {});
  }

  /**
   * Deletes a nodegroup. Destructive — the caller (`scripts/eks-ops`) is
   * responsible for its own confirmation gate; this wrapper performs no
   * guard of its own.
   *
   * @param clusterName - The owning cluster's name.
   * @param nodegroupName - The nodegroup's name.
   * @throws {@link M3LEKSOperationError} if the underlying `DeleteNodegroup` call fails.
   */
  async deleteNodegroup(
    clusterName: string,
    nodegroupName: string,
  ): Promise<M3LEKSNodegroupSummary> {
    let response;
    try {
      response = await this.client.send(
        new DeleteNodegroupCommand({ clusterName, nodegroupName }),
      );
    } catch (cause) {
      throw new M3LEKSOperationError(
        `M3LEKSOperations.deleteNodegroup: DeleteNodegroup failed for clusterName=${clusterName}, nodegroupName=${nodegroupName}`,
        { cause },
      );
    }

    return mapNodegroupSummary(response.nodegroup ?? {});
  }

  /**
   * Waits for a nodegroup to reach the `ACTIVE` state, wrapping the SDK's
   * own `waitUntilNodegroupActive` waiter in a `try`/`catch` that resolves a
   * timeout/abort as data instead of throwing.
   *
   * @param clusterName - The owning cluster's name.
   * @param nodegroupName - The nodegroup's name.
   * @param options - `maxWaitTime` bounds the wait, in seconds; defaults to
   *   `1200` (see {@link DEFAULT_MAX_WAIT_TIME_SECONDS}). When `options.signal`
   *   is supplied and aborts while the SDK waiter is polling, this method throws
   *   {@link M3LOperationAbortedError} instead of resolving.
   * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
   *   while the SDK waiter is polling.
   * @throws {@link M3LEKSOperationError} for any rejection other than the
   *   waiter's own timeout/abort.
   */
  waitUntilNodegroupActive(
    clusterName: string,
    nodegroupName: string,
    options?: M3LEKSWaiterOptions,
  ): Promise<M3LEKSWaiterResult> {
    const signal = options?.signal;
    return runEksWaiter(
      () =>
        waitUntilNodegroupActive(
          {
            client: this.client,
            maxWaitTime: options?.maxWaitTime ?? DEFAULT_MAX_WAIT_TIME_SECONDS,
            ...(signal !== undefined ? { abortSignal: signal } : {}),
          },
          { clusterName, nodegroupName },
        ),
      "waitUntilNodegroupActive",
      `nodegroup clusterName=${clusterName}, nodegroupName=${nodegroupName}`,
      signal,
    );
  }

  /**
   * Waits for a nodegroup to be fully deleted, wrapping the SDK's own
   * `waitUntilNodegroupDeleted` waiter.
   *
   * @param clusterName - The owning cluster's name.
   * @param nodegroupName - The nodegroup's name.
   * @param options - `maxWaitTime` bounds the wait, in seconds; defaults to
   *   `1200` (see {@link DEFAULT_MAX_WAIT_TIME_SECONDS}). When `options.signal`
   *   is supplied and aborts while the SDK waiter is polling, this method throws
   *   {@link M3LOperationAbortedError} instead of resolving.
   * @throws {@link M3LOperationAbortedError} when `options.signal` is aborted
   *   while the SDK waiter is polling.
   * @throws {@link M3LEKSOperationError} for any rejection other than the
   *   waiter's own timeout/abort.
   */
  waitUntilNodegroupDeleted(
    clusterName: string,
    nodegroupName: string,
    options?: M3LEKSWaiterOptions,
  ): Promise<M3LEKSWaiterResult> {
    const signal = options?.signal;
    return runEksWaiter(
      () =>
        waitUntilNodegroupDeleted(
          {
            client: this.client,
            maxWaitTime: options?.maxWaitTime ?? DEFAULT_MAX_WAIT_TIME_SECONDS,
            ...(signal !== undefined ? { abortSignal: signal } : {}),
          },
          { clusterName, nodegroupName },
        ),
      "waitUntilNodegroupDeleted",
      `nodegroup clusterName=${clusterName}, nodegroupName=${nodegroupName}`,
      signal,
    );
  }
}
