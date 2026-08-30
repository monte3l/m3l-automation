/**
 * `core/agent` — the authorization layer for an autonomous operator
 * (ADR-0060).
 *
 * This barrel surfaces the action, policy, and verdict types, the
 * declaration validator, the two guards, the two typed errors, the
 * evaluator's allowlist plus autonomy-tier arms (slice 1), slice 2's
 * budgets, ceilings, run ledger, and dry-run-first discipline, and V7 slice
 * 1's decision-log entry schema, pure projector, and JSONL serializer —
 * thirty-one exports total per the landing plan in
 * `docs/reference/core/agent.md`.
 *
 * The exports are listed explicitly rather than star-re-exported so each
 * slice's added surface is visible in one diff.
 *
 * `M3LDestructiveTarget`, `M3LDestructiveTargetPredicate`,
 * `M3LSensitiveTargetSpec`, and `sensitiveTargets` are used here but stay
 * singly owned by `core/prompt`: the Core barrel star-exports each submodule,
 * so re-exporting any of them would be TS2308 at compile time and a silently
 * dropped export under ES module semantics.
 *
 * @packageDocumentation
 */

export type {
  M3LAgentAction,
  M3LAgentActionKind,
  M3LAgentActionRecord,
} from "./action-types.js";
export { M3L_AGENT_MAX_PARAMETER_NAMES } from "./action-types.js";
export type { M3LAgentRunLedger } from "./ledger-types.js";
export { M3L_AGENT_MAX_DRY_RUN_SHAPES } from "./ledger-types.js";
export type {
  M3LAgentBudgets,
  M3LAgentPolicy,
  M3LAgentPolicyDeclaration,
  M3LAgentScriptGrant,
} from "./policy-types.js";
export {
  M3L_AGENT_MAX_OPERATIONS_PER_GRANT,
  M3L_AGENT_MAX_SCRIPT_GRANTS,
  M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES,
} from "./policy-types.js";
export type {
  M3LAgentDecision,
  M3LAgentPolicyRuleId,
  M3LAgentVerdict,
} from "./verdict-types.js";
export { isAgentActionAutoApproved, isAgentPolicyRuleId } from "./guards.js";
export { M3LAgentActionValidationError } from "./M3LAgentActionValidationError.js";
export { M3LAgentPolicyDeclarationError } from "./M3LAgentPolicyDeclarationError.js";
export { validateAgentPolicy } from "./validate-policy.js";
export type { M3LAgentEvaluationOptions } from "./evaluate.js";
export { evaluateAgentAction } from "./evaluate.js";
export { agentActionShapeKey } from "./shape-key.js";
export type {
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionLogEntryOptions,
  M3LAgentDecisionOutcome,
  M3LAgentIdentity,
} from "./decision-log-types.js";
export { M3L_AGENT_MAX_LOG_ENTRY_BYTES } from "./decision-log-types.js";
export {
  agentDecisionLogEntry,
  serializeAgentDecisionLogEntry,
} from "./decision-log-entry.js";
export type { M3LAgentDecisionLogOptions } from "./decision-log.js";
export {
  M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS,
  M3L_AGENT_LOG_MAX_SEGMENT_BYTES,
  M3LAgentDecisionLog,
} from "./decision-log.js";
export { M3LAgentDecisionLogWriteError } from "./M3LAgentDecisionLogWriteError.js";
