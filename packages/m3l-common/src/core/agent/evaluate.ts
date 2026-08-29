/**
 * `core/agent/evaluate` — the evaluator: a total function from a validated
 * policy plus an intended action to a typed verdict (ADR-0060).
 *
 * @packageDocumentation
 */

import type { M3LDestructiveTargetPredicate } from "../prompt/index.js";
import { validateEvaluationOptions } from "../../internal/agent/action.js";
import { decideAgentAction } from "../../internal/agent/decide.js";
import type { M3LAgentAction } from "./action-types.js";
import type { M3LAgentRunLedger } from "./ledger-types.js";
import type { M3LAgentPolicy } from "./policy-types.js";
import type { M3LAgentDecision } from "./verdict-types.js";

/**
 * The options bag {@link evaluateAgentAction} takes.
 *
 * @remarks
 * A single bag rather than positional parameters, chosen so slice 2 is
 * additive: its per-run state (`run`) is a new **optional** field on a bag
 * callers already construct. A required field there would be source-breaking
 * for every test fake.
 *
 * @example
 * ```ts
 * import type { M3LAgentEvaluationOptions } from "@m3l-automation/m3l-common/core";
 * import { validateAgentPolicy } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LAgentEvaluationOptions = {
 *   policy: validateAgentPolicy({
 *     version: 1,
 *     scripts: [{ script: "s3-report", allOperations: true }],
 *   }),
 *   action: { script: "s3-report", kind: "read-only" },
 * };
 * ```
 */
export interface M3LAgentEvaluationOptions {
  /** The intended action under judgement. */
  readonly action: M3LAgentAction;
  /**
   * The validated policy. Only `validateAgentPolicy` can produce one, so an
   * unvalidated declaration cannot reach the evaluator.
   */
  readonly policy: M3LAgentPolicy;
  /**
   * An optional caller-supplied predicate OR-ed with the declared grading
   * spec, so it can only **add** sensitivity and can never remove it. A throw
   * from it propagates unchanged: no verdict is produced, so the action
   * cannot proceed. Whether it is invoked at all when the declared spec has
   * already matched is unspecified — `||` short-circuits — and no consumer may
   * depend on a call count either way.
   */
  readonly additionalSensitiveTargets?: M3LDestructiveTargetPredicate;
  /**
   * The caller's observed run state, read for step 3 (budgets) and step 6
   * (dry-run-first). Absent means every declared budget is unobservable and
   * every dry-run-first shape is un-dry-run — see
   * docs/reference/core/agent.md § Budgets and exhaustion and § Dry-run-first.
   */
  readonly run?: M3LAgentRunLedger;
}

/**
 * Evaluates one intended action against a validated policy and returns the
 * decision.
 *
 * @remarks
 * The evaluation order is normative and every arm is terminal: boundary
 * validation and single-traversal projection (step 0), the script allowlist
 * (step 1), the operation allowlist (step 2), budgets and ceilings (step 3),
 * the autonomy tier and its declared cross-check (step 4), the ADR-0048
 * grading arms (step 5), dry-run-first (step 6), and the graded non-sensitive
 * mutation arm (step 7). Steps 3 and 6 are skipped entirely when the policy
 * declares no `budgets` and no `dryRunFirst`, respectively — a slice-1
 * declaration reaches exactly the arms slice 1 evaluated, in the same order,
 * and gets the same verdict.
 *
 * Every step reads the frozen `M3LAgentActionRecord` projected at step 0,
 * never the caller's object, and every decision carries that projection — so a
 * caller mutating their action afterwards cannot make the decision log and the
 * verdict disagree. The run ledger is projected the same way, at step 0;
 * steps 3 and 6 read that projection alone, never `options.run` again.
 *
 * The function is pure: no I/O, no clock read, no module-level state. It
 * throws on its own authority **only** for a malformed options bag; it never
 * throws to signal a verdict, though it does propagate a throw raised inside a
 * caller-supplied `additionalSensitiveTargets` unchanged.
 *
 * @param options - The action, the validated policy, the optional extra
 *   sensitivity predicate, and the optional run ledger.
 * @returns The decision — its `verdict`, the `rule` that produced it, a
 *   library-authored `reason`, and the frozen action projection.
 * @throws M3LAgentActionValidationError When the options bag is structurally
 *   malformed; its `context` names the offending field and the violation
 *   kind, never a value.
 *
 * @example
 * ```ts
 * import {
 *   evaluateAgentAction,
 *   isAgentActionAutoApproved,
 *   validateAgentPolicy,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const policy = validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "dynamodb-crud", operations: ["put-item"] }],
 *   sensitiveTargets: { profiles: ["prod"] },
 * });
 *
 * const decision = evaluateAgentAction({
 *   policy,
 *   action: {
 *     script: "dynamodb-crud",
 *     operation: "put-item",
 *     kind: "mutating",
 *     target: { profile: "sandbox", region: "eu-central-1" },
 *     parameterNames: ["table", "item"],
 *   },
 * });
 *
 * if (isAgentActionAutoApproved(decision)) {
 *   // decision.rule === "graded-mutation-auto-approved"
 * }
 * ```
 */
export function evaluateAgentAction(
  options: M3LAgentEvaluationOptions,
): M3LAgentDecision {
  // Step 0 first, unconditionally: a malformed options bag throws before any
  // verdict arm runs, so a bad action for a non-allowlisted script surfaces
  // the caller's bug rather than a plausible-looking `denied`.
  //
  // `policy` comes back OUT of step 0 rather than being re-read from
  // `options` here: step 0 is what proves it is a policy `validateAgentPolicy`
  // itself produced, and re-reading `options.policy` afterwards would hand the
  // decision arms a field nothing had checked. The run ledger comes back the
  // same way, for the same reason.
  const { record, policy, additionalSensitiveTargets, run } =
    validateEvaluationOptions(options);
  return decideAgentAction(record, policy, additionalSensitiveTargets, run);
}
