/**
 * `internal/procedure/run-loop` — phase 1: walks the declared steps,
 * interpreting each returned flow directive as
 * `docs/reference/core/procedure.md` § The run contract defines.
 *
 * Every function here is a free function taking a {@link ProcedureRuntime}
 * as an explicit parameter, rather than a private method reading `this.#field`
 * off a class instance — that is what lets `M3LProcedure.run()` build one
 * frozen runtime record and hand it to a plain function pipeline.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { checkAfterAdvance, checkStepBoundary } from "./guards.js";
import { interpretFlow } from "./flow.js";
import { evaluateCases } from "./outcome.js";
import { executeOneStep } from "./step-exec.js";
import { projectFlowToScalar } from "./trace.js";

import type {
  M3LProcedureContext,
  M3LProcedureStep,
} from "../../core/procedure/step-types.js";
import type {
  M3LProcedureConditionScope,
  M3LProcedureShape,
  M3LProcedureStepRecord,
} from "../../core/procedure/types.js";
import type {
  CasesPass,
  FlowDecision,
  FlowResolution,
  FoldedStepExecution,
  PhaseOneOutcome,
  PostAdvanceResolution,
  ProcedureRuntime,
  StepExecutionOutcome,
} from "./run-state.js";
import type {
  M3LProcedureStepTraceClassification,
  M3LProcedureTracer,
} from "./trace.js";

/** Projects a context into the read-only scope a condition evaluates against. */
export function toConditionScope<TShape extends M3LProcedureShape>(
  context: M3LProcedureContext<TShape>,
): M3LProcedureConditionScope<TShape> {
  return {
    results: context.results,
    values: context.values,
    parameters: context.parameters,
  };
}

/**
 * Folds one step's `StepExecutionOutcome` for the phase-1 loop: an
 * unabsorbed failure or an abort become a `"return"` — phase 1 ends here,
 * with no context transition — while an advance or an engine-synthesized
 * retry is passed through as-is for the caller to fold into its own local
 * `context`/`executedSteps`.
 */
function foldStepExecution<TShape extends M3LProcedureShape>(
  executed: Awaited<ReturnType<typeof executeOneStep<TShape>>>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
): FoldedStepExecution<TShape> {
  switch (executed.kind) {
    case "failed":
      return { kind: "return", result: executed };
    case "aborted":
      return {
        kind: "return",
        result: {
          kind: "aborted",
          abortedAt: step.id,
          error: executed.error,
        },
      };
    case "retry":
      return {
        kind: "retry",
        context: executed.context,
        record: executed.record,
      };
    case "advanced":
      return {
        kind: "advanced",
        context: executed.context,
        record: executed.record,
        flow: executed.flow,
      };
  }
}

/**
 * Classifies one step's settled {@link StepExecutionOutcome} for tracing: a
 * clean `"advanced"` whose record status is `"succeeded"` is
 * `failed: false` carrying its own projected flow; every other case — an
 * `"advanced"` with a `"recovered"` status (an absorbed
 * `continueOnFailure` throw on a step with no `loop`), a `"retry"` (the same
 * absorption on a step declaring `loop`), a `"failed"` (an unabsorbed throw
 * or a malformed result), or an `"aborted"` — is
 * `failed: true, flow: undefined` per `docs/reference/core/procedure.md` §
 * Tracing's "traced identically to a throw" rule.
 */
function classifyStepExecution<TShape extends M3LProcedureShape>(
  executed: StepExecutionOutcome<TShape>,
): M3LProcedureStepTraceClassification {
  switch (executed.kind) {
    case "advanced":
      return executed.record.status === "recovered"
        ? { failed: true, flow: undefined }
        : { failed: false, flow: projectFlowToScalar(executed.flow) };
    case "retry":
    case "failed":
    case "aborted":
      return { failed: true, flow: undefined };
  }
}

/**
 * Runs the pre-step boundary guard, then (only if it passed) executes
 * `step` through `tracer.runStep` — recording one `"procedure:step"` entry
 * when tracing is configured — folding the result: the whole "one step"
 * unit the phase-1 loop advances by. A pre-step guard failure (abort or
 * ceiling) never reaches the tracer: it fires before `step`'s own execution
 * would even begin.
 */
async function advanceOneStep<TShape extends M3LProcedureShape>(
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  maxIterations: number,
  tracer: M3LProcedureTracer<TShape>,
): Promise<FoldedStepExecution<TShape>> {
  const preStepFailure = checkStepBoundary(context, step, maxIterations);
  if (preStepFailure !== undefined) {
    return { kind: "return", result: preStepFailure };
  }
  const attempt = (context.results[step.id]?.attempt ?? 0) + 1;
  const executed = await tracer.runStep(
    step,
    context,
    attempt,
    () => executeOneStep(context, step, attempt),
    classifyStepExecution,
  );
  return foldStepExecution(executed, step);
}

/**
 * Resolves what the phase-1 loop does once a step has advanced and
 * `flow.ts`'s `interpretFlow` has classified its directive. `"failed"` (an
 * undeclared flow) ends the run immediately — it never reaches the
 * post-advance guard, since it was never a genuine advance. For the
 * `"advance"` arm, the post-advance guard (abort only, this slice) wins
 * first if it fires; otherwise the caller continues looping from the
 * resolved index.
 */
function resolveStepFlow<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  context: M3LProcedureContext<TShape>,
  decision: FlowDecision<TShape>,
): FlowResolution<TShape> {
  switch (decision.kind) {
    case "failed":
      return {
        kind: "return",
        result: {
          kind: "failed",
          stepId: decision.stepId,
          error: decision.error,
        },
      };
    case "ended":
      return { kind: "return", result: { kind: "ended" } };
    case "matched":
      return {
        kind: "return",
        result: { kind: "matched", pass: decision.pass },
      };
    case "advance": {
      const afterAdvance = checkAfterAdvance(runtime, context, decision);
      if (afterAdvance !== undefined) {
        return { kind: "return", result: afterAdvance };
      }
      return { kind: "continue", index: decision.index };
    }
  }
}

/**
 * Combines `flow.ts`'s `interpretFlow` and {@link resolveStepFlow} into the
 * single decision {@link resolveAfterFold} dispatches to for a genuine
 * advance, carrying the updated `resolveChecks` alongside either the outcome
 * to return now or the next `index` to continue from.
 */
function resolveAfterAdvance<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  flow: unknown,
  index: number,
  resolveChecks: number,
): PostAdvanceResolution<TShape> {
  const isLast = index === runtime.steps.length - 1;
  const decision = interpretFlow(
    runtime,
    context,
    step,
    flow,
    index,
    isLast,
    resolveChecks,
    (ctx): CasesPass<TShape> => evaluateCases(runtime, toConditionScope(ctx)),
  );
  const flowResolution = resolveStepFlow(runtime, context, decision);
  if (flowResolution.kind === "return") {
    return {
      kind: "return",
      resolveChecks: decision.resolveChecks,
      result: flowResolution.result,
    };
  }
  return {
    kind: "continue",
    resolveChecks: decision.resolveChecks,
    index: flowResolution.index,
  };
}

/**
 * What the phase-1 loop does once an engine-synthesized retry (an absorbed
 * `continueOnFailure` throw for a step declaring `loop`) has advanced: runs
 * the SAME post-advance guard a genuine advance would, but resolves the next
 * index as `index` itself — the very step being retried — rather than
 * through `flow.ts`'s flow interpretation.
 */
function resolveAfterRetry<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  context: M3LProcedureContext<TShape>,
  index: number,
  resolveChecks: number,
): PostAdvanceResolution<TShape> {
  const decision: Extract<FlowDecision<TShape>, { kind: "advance" }> = {
    kind: "advance",
    index,
    resolveChecks,
  };
  const guardFailure = checkAfterAdvance(runtime, context, decision);
  if (guardFailure !== undefined) {
    return { kind: "return", resolveChecks, result: guardFailure };
  }
  return { kind: "continue", resolveChecks, index };
}

/**
 * Dispatches one just-folded step advance to whichever post-advance resolver
 * matches its kind.
 */
function resolveAfterFold<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  folded: Extract<
    FoldedStepExecution<TShape>,
    { kind: "advanced" } | { kind: "retry" }
  >,
  index: number,
  resolveChecks: number,
): PostAdvanceResolution<TShape> {
  if (folded.kind === "retry") {
    return resolveAfterRetry(runtime, context, index, resolveChecks);
  }
  return resolveAfterAdvance(
    runtime,
    context,
    step,
    folded.flow,
    index,
    resolveChecks,
  );
}

/**
 * Phase 1: walks the declared steps starting at index 0, interpreting each
 * returned flow directive as the contract's Flow directives section
 * defines. Ends the run early (`"failed"`) on an unabsorbed step throw;
 * concludes early (`"matched"`) on a `"resolve"` pass that matched;
 * otherwise ends ordinarily (`"ended"`) once `"stop"` fires or the last
 * declared step returns `"continue"` — the caller then runs the final,
 * concluding case pass.
 */
export async function runPhaseOne<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  initialContext: M3LProcedureContext<TShape>,
  maxIterations: number,
  tracer: M3LProcedureTracer<TShape>,
): Promise<PhaseOneOutcome<TShape>> {
  let context = initialContext;
  const executedSteps: M3LProcedureStepRecord[] = [];
  let resolveChecks = 0;
  let index = 0;

  for (;;) {
    const step = runtime.steps[index];
    // Unreachable for a `build()`-validated procedure: `index` only ever
    // holds 0, `index + 1` bounded by the loop's own check below, or a
    // `goTo` target resolved through `runtime.stepIndexById` (which only
    // ever contains declared step ids). Kept so the loop stays total under
    // `noUncheckedIndexedAccess` rather than asserting the lookup.
    if (step === undefined) {
      return { kind: "ended", context, executedSteps, resolveChecks };
    }

    const folded = await advanceOneStep(context, step, maxIterations, tracer);
    if (folded.kind === "return") {
      return { ...folded.result, context, executedSteps, resolveChecks };
    }
    context = folded.context;
    executedSteps.push(folded.record);

    const afterAdvance = resolveAfterFold(
      runtime,
      context,
      step,
      folded,
      index,
      resolveChecks,
    );
    resolveChecks = afterAdvance.resolveChecks;
    if (afterAdvance.kind === "return") {
      return {
        ...afterAdvance.result,
        context,
        executedSteps,
        resolveChecks,
      };
    }
    index = afterAdvance.index;
  }
}
