/**
 * `internal/procedure/flow` — interprets one step's flow directive and the
 * iteration/revisit ceiling.
 *
 * `docs/reference/core/procedure.md` § Flow directives states that a step's
 * returned result is caller data, not a trusted value: a flow that is
 * `null`, a `goTo` that isn't a string, an unrecognized string outside the
 * four recognized forms, or a result missing `flow` entirely is an
 * engine-level contract violation — every one of these resolves via the SAME
 * `ERR_PROCEDURE_UNDECLARED_JUMP` path a genuinely undeclared `goTo` target
 * uses, never a thrown `TypeError` and never a silent `"continue"`.
 *
 * {@link classifyFlowShape} is the one exhaustive classification this module
 * builds everything else on: it uses `isPlainObject` — not a raw
 * `typeof === "object"` check, which is also true for `null` — so a `null`
 * flow falls through to the malformed arm rather than crashing once a
 * `goTo` lookup reads a property off it, and it guards `goTo` with
 * `isString` before ever using it, so a non-string `goTo` (a `Symbol`, a
 * number) is classified as malformed rather than reaching a `Map` lookup or
 * a string-interpolated error message that would coerce it and throw. Any
 * flow value that isn't exactly `"continue"`, `"stop"`, `"resolve"`, or a
 * plain object naming a string `goTo` falls out of this classification as
 * `undefined` — there is no other fallthrough arm.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isPlainObject, isString } from "../../core/utils/guards.js";

import {
  M3LProcedureIterationLimitError,
  M3LProcedureUndeclaredJumpError,
} from "./errors.js";

import type {
  CasesPass,
  FlowDecision,
  ProcedureRuntime,
  StepExecutionOutcome,
} from "./run-state.js";
import type {
  M3LProcedureContext,
  M3LProcedureStep,
} from "../../core/procedure/step-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";

/** The syntactically well-formed shapes a flow directive may take. */
export type FlowShape =
  | { readonly kind: "continue" }
  | { readonly kind: "stop" }
  | { readonly kind: "resolve" }
  | { readonly kind: "goTo"; readonly target: string };

/**
 * Classifies `flow` syntactically, with no runtime/step-specific knowledge:
 * exactly `"continue"`, `"stop"`, `"resolve"`, or a plain object with a
 * string `goTo` resolve to their matching {@link FlowShape}; anything else —
 * `null`, a non-plain-object, a `goTo` that isn't a string, an unrecognized
 * string — is malformed and reported as `undefined`. This single exhaustive
 * classification is what fixes the three related defects together: treating
 * a `null` flow (whose `typeof` is `"object"`) as a candidate `goTo` shape,
 * reading an unguarded `goTo` off it, and silently falling through an
 * unrecognized string to an implicit advance.
 */
export function classifyFlowShape(flow: unknown): FlowShape | undefined {
  if (flow === "continue") return { kind: "continue" };
  if (flow === "stop") return { kind: "stop" };
  if (flow === "resolve") return { kind: "resolve" };
  if (isPlainObject(flow) && isString(flow["goTo"])) {
    return { kind: "goTo", target: flow["goTo"] };
  }
  return undefined;
}

/**
 * Resolves a `goTo` directive: `target` must both be a declared step id AND
 * appear in the declaring `step`'s own `jumpsTo` allowlist — a target
 * unknown to the procedure, or one the declaring step never declared,
 * reports a `"failed"` decision under {@link M3LProcedureUndeclaredJumpError}
 * (`ERR_PROCEDURE_UNDECLARED_JUMP`) rather than silently falling through to
 * the next declared step.
 */
function interpretGoTo<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  goTo: string,
  resolveChecks: number,
): FlowDecision<TShape> {
  const target = runtime.stepIndexById.get(goTo);
  const declaredJumps: readonly string[] = step.jumpsTo ?? [];
  if (target === undefined || !declaredJumps.includes(goTo)) {
    return {
      kind: "failed",
      stepId: step.id,
      error: new M3LProcedureUndeclaredJumpError(
        `step "${step.id}" returned an undeclared jump target "${goTo}"`,
        { stepId: step.id, goTo },
      ),
      resolveChecks,
    };
  }
  return { kind: "advance", index: target, resolveChecks };
}

/**
 * Interprets one step's flow directive: a malformed shape (per
 * {@link classifyFlowShape}) resolves as an undeclared-jump failure, a `goTo`
 * shape resolves to a declared index via {@link interpretGoTo}, `"stop"` or a
 * `"continue"` from the last step ends phase 1, a matching `"resolve"`
 * concludes the run early, and anything else advances to the next declared
 * step. Pure — returns the (possibly incremented) `resolveChecks` rather
 * than mutating a shared counter.
 *
 * @param evaluateCases - Evaluates every declared case against `context`;
 *   invoked only for a `"resolve"` directive.
 */
export function interpretFlow<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  flow: unknown,
  index: number,
  isLast: boolean,
  resolveChecks: number,
  evaluateCases: (context: M3LProcedureContext<TShape>) => CasesPass<TShape>,
): FlowDecision<TShape> {
  const shape = classifyFlowShape(flow);
  if (shape === undefined) {
    return {
      kind: "failed",
      stepId: step.id,
      error: new M3LProcedureUndeclaredJumpError(
        `step "${step.id}" returned a result with a missing or unrecognized flow directive`,
        { stepId: step.id },
      ),
      resolveChecks,
    };
  }
  if (shape.kind === "goTo") {
    return interpretGoTo(runtime, step, shape.target, resolveChecks);
  }
  if (shape.kind === "stop") return { kind: "ended", resolveChecks };

  let checks = resolveChecks;
  if (shape.kind === "resolve") {
    checks += 1;
    const pass = evaluateCases(context);
    if (pass.matches.length > 0) {
      return { kind: "matched", pass, resolveChecks: checks };
    }
  }
  if (isLast) return { kind: "ended", resolveChecks: checks };
  return { kind: "advance", index: index + 1, resolveChecks: checks };
}

/**
 * Checked at the top of every phase-1 loop pass, before `step.execute` ever
 * runs: refuses the run once `context.iteration` (the run's total executions
 * so far) has already reached `maxIterations`, or once `step`'s own declared
 * `loop.maxRevisits` ceiling has already been reached by its prior
 * executions — read off `context.results[step.id].attempt`, the same
 * per-step execution counter step execution maintains, so no separate
 * counter needs to be threaded through the loop. Pure — returns a failure
 * for the caller to fold into its own local state rather than throwing or
 * mutating anything.
 */
export function checkIterationCeiling<TShape extends M3LProcedureShape>(
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  maxIterations: number,
): Extract<StepExecutionOutcome<TShape>, { kind: "failed" }> | undefined {
  if (context.iteration >= maxIterations) {
    return {
      kind: "failed",
      // The overall iteration ceiling is a whole-run guard, not attributable
      // to this (or any) one step's own behavior — `stepId` is `undefined`
      // here, unlike the revisit-ceiling arm below.
      stepId: undefined,
      error: new M3LProcedureIterationLimitError(
        `procedure exceeded its iteration ceiling of ${maxIterations} step execution(s)`,
        { limit: "iterations", maxIterations },
      ),
    };
  }

  const { loop } = step;
  if (loop === undefined) return undefined;

  const priorExecutions = context.results[step.id]?.attempt ?? 0;
  if (priorExecutions <= loop.maxRevisits) return undefined;

  return {
    kind: "failed",
    stepId: step.id,
    error: new M3LProcedureIterationLimitError(
      `step "${step.id}" exceeded its revisit ceiling of ${loop.maxRevisits}`,
      { limit: "revisits", stepId: step.id, maxRevisits: loop.maxRevisits },
    ),
  };
}
