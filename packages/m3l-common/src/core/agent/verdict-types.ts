/**
 * `core/agent/verdict-types` — the verdict vocabulary: the three closed
 * verdicts, the rule ids that name why, and the decision itself (ADR-0060).
 *
 * @packageDocumentation
 */

import type { M3LAgentActionRecord } from "./action-types.js";

/**
 * The verdict an evaluation produces.
 *
 * @remarks
 * **Closed, and it will never gain a member.** ADR-0060 fixes it at three
 * words. Budget exhaustion (slice 2) is an `escalate` carrying a new rule id —
 * "a named outcome, never a silent stop" — not a fourth verdict.
 *
 * Derived from {@link M3LAgentDecision}'s own arms rather than restated as an
 * independent union: the two are the same vocabulary, and a hand-written copy
 * could silently drift from the arms it is supposed to name.
 *
 * @example
 * ```ts
 * import type { M3LAgentVerdict } from "@m3l-automation/m3l-common/core";
 *
 * const verdict: M3LAgentVerdict = "escalate";
 * ```
 */
export type M3LAgentVerdict = M3LAgentDecision["verdict"];

/**
 * Names the rule that produced a verdict.
 *
 * @remarks
 * A closed literal union that **grows in later minors** — slice 2 adds twelve
 * ids (the five `"budget.*"` ids, `"dry-run-first"`,
 * `"kind-cross-check-escalated"`, and the five `"budget.*.unobservable"`
 * ids), and ADR-0061 (V7) adds its own: V7 slice 2 adds two more,
 * `"decision-log-unavailable"` and `"decision-log-unavailable.unobservable"`
 * (the log-unavailable escalation, step 3b), taking the union from twenty to
 * twenty-two. Growing it is additive, not breaking, because the type appears
 * only in **return** position: no caller constructs an `M3LAgentDecision`, so
 * a new member cannot invalidate a caller's value.
 *
 * What a new member *can* break is an exhaustive `switch`, so consumers must
 * **not** write one. Treat an unrecognised id as an opaque label — log it,
 * render it, branch on `verdict` instead.
 *
 * @example
 * ```ts
 * import type { M3LAgentPolicyRuleId } from "@m3l-automation/m3l-common/core";
 *
 * const rule: M3LAgentPolicyRuleId = "script-not-allowlisted";
 * ```
 */
export type M3LAgentPolicyRuleId =
  | "script-not-allowlisted"
  | "operation-not-allowlisted"
  | "read-only-auto-approved"
  | "target-ungraded-escalated"
  | "policy-ungraded-escalated"
  | "sensitive-target-escalated"
  | "graded-mutation-auto-approved"
  | "unclassifiable-escalated"
  | "budget.invocations-per-run"
  | "budget.invocations-per-day"
  | "budget.tokens-per-run"
  | "budget.cost-per-run"
  | "budget.loop-iterations"
  | "dry-run-first"
  | "kind-cross-check-escalated"
  | "budget.invocations-per-run.unobservable"
  | "budget.invocations-per-day.unobservable"
  | "budget.tokens-per-run.unobservable"
  | "budget.cost-per-run.unobservable"
  | "budget.loop-iterations.unobservable"
  | "decision-log-unavailable"
  | "decision-log-unavailable.unobservable";

/**
 * The discriminated verdict `evaluateAgentAction` returns.
 *
 * @remarks
 * `rule` is typed as the whole {@link M3LAgentPolicyRuleId} union on every
 * arm, so `{ verdict: "denied", rule: "read-only-auto-approved" }` is
 * representable and is a lie the type system will not catch. The pairing is
 * locked by a test, not by the type.
 *
 * The reason is **not** that per-arm rule aliases would be less additive —
 * they would be equally additive, since they too appear only in return
 * position, and adding a member to one of them could not invalidate a
 * caller's value either. The real cost is arm **reassignment**: with per-arm
 * unions, moving an existing id from `escalate` to `denied` — a policy
 * change, not a vocabulary change, and one this module should stay free to
 * make — becomes a breaking type change for anyone who wrote
 * `Extract<M3LAgentDecision, { verdict: "escalate" }>["rule"]`. The flat
 * union keeps reassignment a runtime-behaviour change with a test to prove
 * it, which is where it belongs.
 *
 * `reason` is library-authored prose composed only from `script`,
 * `operation`, `kind`, the target's `profile` / `region` / `accountId`, and —
 * for the budget arms — the budget's own key, its declared ceiling, and the
 * observed value. It never embeds a parameter value: every budget number
 * admitted is either a ceiling the deployment declared or a count the caller
 * itself reported, never data read out of the action under judgement. It is
 * not run through `escapeTerminalControls`: it is a data value flowing to a
 * log sink, not a display channel.
 *
 * @example
 * ```ts
 * import type { M3LAgentDecision } from "@m3l-automation/m3l-common/core";
 *
 * function label(decision: M3LAgentDecision): string {
 *   return `${decision.verdict} (${decision.rule})`;
 * }
 * ```
 */
export type M3LAgentDecision =
  | {
      readonly verdict: "auto-approved";
      readonly rule: M3LAgentPolicyRuleId;
      readonly reason: string;
      readonly action: M3LAgentActionRecord;
    }
  | {
      readonly verdict: "escalate";
      readonly rule: M3LAgentPolicyRuleId;
      readonly reason: string;
      readonly action: M3LAgentActionRecord;
    }
  | {
      readonly verdict: "denied";
      readonly rule: M3LAgentPolicyRuleId;
      readonly reason: string;
      readonly action: M3LAgentActionRecord;
    };
