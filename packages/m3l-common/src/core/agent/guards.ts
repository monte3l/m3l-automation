/**
 * `core/agent/guards` — the rule-id type predicate and the one correct
 * approval gate (ADR-0060).
 *
 * @packageDocumentation
 */

import type {
  M3LAgentDecision,
  M3LAgentPolicyRuleId,
} from "./verdict-types.js";

/**
 * The rule ids **this build** knows, as a `Record` rather than an array so
 * that adding a ninth {@link M3LAgentPolicyRuleId} member is a compile error
 * here instead of a silently drifting runtime set.
 */
const AGENT_POLICY_RULE_IDS: Record<M3LAgentPolicyRuleId, true> = {
  "script-not-allowlisted": true,
  "operation-not-allowlisted": true,
  "read-only-auto-approved": true,
  "target-ungraded-escalated": true,
  "policy-ungraded-escalated": true,
  "sensitive-target-escalated": true,
  "graded-mutation-auto-approved": true,
  "unclassifiable-escalated": true,
};

/**
 * Answers one question: is `value` one of the rule ids **this build** knows?
 *
 * @remarks
 * It takes `unknown` because its input is a value read back out of an
 * ADR-0061 log line, which is parsed JSON.
 *
 * The honest limitation, stated rather than implied: because the vocabulary
 * grows across minors, an older library reading a log written by a newer one
 * returns `false` for an id that is perfectly valid. That is a version-skew
 * answer, not a validity answer — a caller must not treat `false` as
 * "corrupt log".
 *
 * @param value - Any value; typically a `rule` field read back out of a log.
 * @returns `true` when `value` is a rule id this build recognises.
 *
 * @example
 * ```ts
 * import { isAgentPolicyRuleId } from "@m3l-automation/m3l-common/core";
 *
 * const parsed: unknown = JSON.parse('{"rule":"script-not-allowlisted"}');
 * const rule = (parsed as { rule: unknown }).rule;
 * if (isAgentPolicyRuleId(rule)) {
 *   // rule is narrowed to M3LAgentPolicyRuleId
 * }
 * ```
 */
export function isAgentPolicyRuleId(
  value: unknown,
): value is M3LAgentPolicyRuleId {
  return (
    typeof value === "string" && Object.hasOwn(AGENT_POLICY_RULE_IDS, value)
  );
}

/**
 * The one correct approval gate: `true` only for an `"auto-approved"`
 * decision.
 *
 * @remarks
 * It ships as a named export because the obvious hand-written alternative —
 * `if (decision.verdict !== "denied")` — **runs every escalation**. Shipping
 * the one correct gate is cheaper than relying on every consumer to pick the
 * right polarity.
 *
 * @param decision - A decision returned by `evaluateAgentAction`.
 * @returns `true` when the action may proceed without human review.
 *
 * @example
 * ```ts
 * import { isAgentActionAutoApproved } from "@m3l-automation/m3l-common/core";
 * import type { M3LAgentDecision } from "@m3l-automation/m3l-common/core";
 *
 * function mayProceed(decision: M3LAgentDecision): boolean {
 *   return isAgentActionAutoApproved(decision);
 * }
 * ```
 */
export function isAgentActionAutoApproved(decision: M3LAgentDecision): boolean {
  return decision.verdict === "auto-approved";
}
