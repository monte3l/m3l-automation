/**
 * `aws/eks` — typed wrapper over the raw `@aws-sdk/client-eks` `EKSClient`,
 * so callers never import SDK command classes directly. Scoped to EKS
 * **control-plane** cluster and nodegroup operations — no kubectl-level
 * workload operations (pods/deployments/services), which ADR-0029 places
 * out of scope for the script-dependency boundary; see
 * `docs/reference/aws/eks.md`.
 *
 * @packageDocumentation
 */

export {
  M3LEKSOperations,
  type M3LEKSListClustersOptions,
  type M3LEKSListNodegroupsOptions,
} from "./client.js";
export { M3LEKSOperationError } from "./error.js";
export type {
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
