/**
 * `core/agent` — the authorization layer for an autonomous operator
 * (ADR-0060).
 *
 * This barrel surfaces slice 1's verdict vocabulary: the action, policy, and
 * verdict types, the declaration validator, the two guards, the two typed
 * errors, and the evaluator's allowlist plus autonomy-tier arms — twenty
 * exports total per the landing plan in `docs/reference/core/agent.md`. Slice
 * 2's budgets, ceilings, and dry-run-first discipline land here later.
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
export type {
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
