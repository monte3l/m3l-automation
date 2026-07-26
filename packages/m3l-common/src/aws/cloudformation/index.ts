/**
 * `aws/cloudformation` — typed wrapper over the raw
 * `@aws-sdk/client-cloudformation` `CloudFormationClient`, so callers never
 * import SDK command classes directly. Scoped to the CloudFormation stack
 * resource plus stack-lifecycle waiters; see
 * `docs/reference/aws/cloudformation.md`.
 *
 * @packageDocumentation
 */

export {
  M3LCloudFormationOperations,
  type M3LCloudFormationDescribeStackEventsOptions,
  type M3LCloudFormationListStacksOptions,
} from "./client.js";
export { M3LCloudFormationOperationError } from "./error.js";
export type {
  M3LCloudFormationCapability,
  M3LCloudFormationCreateStackInput,
  M3LCloudFormationCreateStackResult,
  M3LCloudFormationDeleteStackOptions,
  M3LCloudFormationDescribeStackEventsResult,
  M3LCloudFormationKeyValue,
  M3LCloudFormationListStacksResult,
  M3LCloudFormationOutput,
  M3LCloudFormationStack,
  M3LCloudFormationStackEvent,
  M3LCloudFormationStackSummary,
  M3LCloudFormationUpdateStackInput,
  M3LCloudFormationUpdateStackResult,
  M3LCloudFormationWaiterResult,
  M3LCloudFormationWaitOptions,
} from "./types.js";
