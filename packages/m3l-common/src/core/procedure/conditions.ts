/**
 * `core/procedure/conditions` — pure evaluation of a
 * {@link M3LProcedureCondition} tree against a {@link
 * M3LProcedureConditionScope}.
 *
 * @packageDocumentation
 */

import { evaluateCondition } from "../../internal/procedure/evaluate.js";

import type {
  M3LProcedureCondition,
  M3LProcedureConditionEvaluation,
  M3LProcedureConditionScope,
  M3LProcedureShape,
} from "./types.js";

/**
 * Evaluates a {@link M3LProcedureCondition} tree against `scope`, returning
 * the full evaluation tree — not just a boolean — so a run can report _why_
 * it concluded what it did without re-running anything.
 *
 * Pure: no `deps`, no signal, no I/O. Public because a consumer must be able
 * to unit-test its own case list without standing up a whole procedure.
 * `and`/`or` deliberately do not short-circuit — every operand is evaluated,
 * so the evaluation tree is fully determined by `condition` and `scope`.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @param condition - The condition tree to evaluate.
 * @param scope - The read-only view of run state the condition addresses.
 * @returns The evaluation tree mirroring `condition`, one node per node.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * interface Shape extends Core.M3LProcedureShape {
 *   deps: unknown;
 *   values: { errorCount: number };
 *   parameters: Record<never, never>;
 *   conclusion: void;
 *   stepId: "count-errors";
 *   caseId: "quiet";
 * }
 *
 * const evaluation = Core.evaluateProcedureCondition<Shape>(
 *   {
 *     kind: "compare",
 *     left: { source: "value", key: "errorCount" },
 *     operator: "==",
 *     right: { source: "literal", literal: 0 },
 *   },
 *   { results: {}, values: { errorCount: 0 }, parameters: {} },
 * );
 *
 * console.log(evaluation.satisfied); // true
 * ```
 */
export function evaluateProcedureCondition<TShape extends M3LProcedureShape>(
  condition: M3LProcedureCondition<TShape>,
  scope: M3LProcedureConditionScope<TShape>,
): M3LProcedureConditionEvaluation {
  return evaluateCondition(condition, scope);
}
