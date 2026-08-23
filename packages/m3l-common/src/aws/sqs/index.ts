/**
 * `aws/sqs` — typed SQS operations wrapper over the raw
 * `@aws-sdk/client-sqs` `SQSClient`, so callers never import SDK command
 * classes directly. See ADR-0026.
 *
 * @packageDocumentation
 */

export { M3LSQSOperations } from "./client.js";
export { M3LSQSOperationError } from "./error.js";
export type {
  M3LSQSBatchFailure,
  M3LSQSBatchResult,
  M3LSQSDeleteEntry,
  M3LSQSQueueAttributes,
  M3LSQSReceiveDeduplicationMode,
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
  M3LSQSRedriveAllowPolicy,
  M3LSQSRedriveDecision,
  M3LSQSRedriveOptions,
  M3LSQSRedrivePermission,
  M3LSQSRedrivePolicy,
  M3LSQSRedriveProcessor,
  M3LSQSRedriveResult,
  M3LSQSSendEntry,
} from "./types.js";
