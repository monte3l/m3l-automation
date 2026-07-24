/**
 * `aws/ecs` — typed ECS service operations wrapper over the raw
 * `@aws-sdk/client-ecs` `ECSClient`, so callers never import SDK command
 * classes directly. Scoped to the ECS service control-plane resource plus
 * read-only cluster context; see `docs/reference/aws/ecs.md`.
 *
 * @packageDocumentation
 */

export { M3LECSOperations } from "./client.js";
export { M3LECSOperationError } from "./error.js";
export type {
  M3LECSClusterSummary,
  M3LECSCreateServiceInput,
  M3LECSListClustersResult,
  M3LECSListServicesResult,
  M3LECSLoadBalancer,
  M3LECSNetworkConfiguration,
  M3LECSServiceDescription,
  M3LECSUpdateServiceInput,
  M3LECSWaiterResult,
} from "./types.js";
