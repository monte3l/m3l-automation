/**
 * `aws/eventbridge` — typed EventBridge rules-operations wrapper over the
 * raw `@aws-sdk/client-eventbridge` `EventBridgeClient`, so callers never
 * import SDK command classes directly. See `docs/reference/aws/eventbridge.md`.
 *
 * @packageDocumentation
 */

export { M3LEventBridgeOperations } from "./client.js";
export { M3LEventBridgeOperationError } from "./error.js";
export type {
  M3LEventBridgeDeleteRuleOptions,
  M3LEventBridgeEventBusOptions,
  M3LEventBridgeListRulesOptions,
  M3LEventBridgeListRulesResult,
  M3LEventBridgeListTargetsOptions,
  M3LEventBridgeListTargetsResult,
  M3LEventBridgePutRuleInput,
  M3LEventBridgePutRuleResult,
  M3LEventBridgePutTargetsFailure,
  M3LEventBridgePutTargetsResult,
  M3LEventBridgeRemoveTargetsFailure,
  M3LEventBridgeRemoveTargetsOptions,
  M3LEventBridgeRemoveTargetsResult,
  M3LEventBridgeRule,
  M3LEventBridgeRuleDetail,
  M3LEventBridgeRuleState,
  M3LEventBridgeTarget,
} from "./types.js";
