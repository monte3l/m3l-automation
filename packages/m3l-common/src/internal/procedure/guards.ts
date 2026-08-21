/**
 * `internal/procedure/guards` — the abort-boundary guards checked at every
 * phase-1 loop pass and after every genuine advance.
 *
 * `docs/reference/core/procedure.md` § Cancellation: the signal is checked
 * at every step boundary, before phase 2, and before phase 3 — an abort
 * always wins, over `continueOnFailure`, over a no-progress trip, and over a
 * step's own thrown error. `checkAfterAdvance` runs the abort check first
 * and, only once that passes, samples the opt-in no-progress guard —
 * re-checking abort a second time afterward, since the witness is caller
 * code and can itself fire the signal as a side effect of the very sample
 * that just tripped.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3LOperationAbortedError } from "../../core/errors/M3LOperationAbortedError.js";

import { checkIterationCeiling } from "./flow.js";
import { sampleProgress } from "./progress.js";

import type {
  M3LProcedureContext,
  M3LProcedureStep,
} from "../../core/procedure/step-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";
import type { ProgressTracker } from "../polling/progress.js";
import type { CapturedProgressConfig } from "./progress.js";
import type {
  FlowDecision,
  ProcedureRuntime,
  StepGuardFailure,
} from "./run-state.js";

/**
 * True when `signal` has fired. Routed through a function rather than
 * inlined — TypeScript's narrowing of a mutable external property is unsound
 * across an `await`, so a call site re-checking `signal?.aborted` after one
 * would otherwise report a spurious "no overlap" error; a function call
 * simply cannot be narrowed away.
 *
 * Exported (not just used locally) because `step-exec.ts`'s `catch` block
 * must re-verify `context.signal` directly rather than trusting only the
 * thrown error's own `code` — an ordinary error racing a just-fired signal
 * must still resolve as `"aborted"`, per this repo's established
 * abort-check-precedes-classifier precedent (`M3LRetryRunner`, ADR-0049).
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Returns a fresh {@link M3LOperationAbortedError} when `signal` has fired,
 * else `undefined`. Called at every abort boundary the engine enforces
 * (before each step, right after a step's context is derived, and before
 * phases 2 and 3) — it precedes every other guard at each of those
 * boundaries, so an aborted signal always wins over the iteration ceiling.
 */
export function checkAbortBoundary(
  signal: AbortSignal | undefined,
): M3LOperationAbortedError | undefined {
  return isAborted(signal) ? new M3LOperationAbortedError() : undefined;
}

/**
 * Checked at the top of every phase-1 loop pass, before `step.execute` ever
 * runs: cancellation first — it precedes every other guard at this
 * boundary, including the already-aborted case, which reaches here with
 * zero steps executed — then the iteration/revisit ceilings. Returns the
 * failure to fold into the caller's returned state, or `undefined` to let
 * the step run.
 */
export function checkStepBoundary<TShape extends M3LProcedureShape>(
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  maxIterations: number,
): StepGuardFailure<TShape> | undefined {
  const abortError = checkAbortBoundary(context.signal);
  if (abortError !== undefined) {
    return { kind: "aborted", abortedAt: step.id, error: abortError };
  }
  return checkIterationCeiling(context, step, maxIterations);
}

/** Projects a just-observed abort into the `"aborted"` arm of {@link StepGuardFailure}, naming the step at `index` as `abortedAt`. */
function toAbortedStepGuardFailure<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  error: M3LOperationAbortedError,
  index: number,
): Extract<StepGuardFailure<TShape>, { kind: "aborted" }> {
  return { kind: "aborted", abortedAt: runtime.steps[index]?.id, error };
}

/**
 * Runs the checks common to every step that just advanced: the abort
 * boundary right after this step's context was derived, so an abort always
 * wins — then, only once that passes, the opt-in no-progress guard's sample
 * for the step that just completed (`stepId`). Only ever called for a
 * genuine `"advance"` decision — a step whose flow directive already ended
 * phase 1 (`"ended"`/`"matched"`/`"failed"`) never reaches this guard.
 * `decision.index` names the step phase 1 would run next, which an abort
 * caught here reports as `abortedAt`.
 *
 * A no-progress trip is re-checked against abort a SECOND time before being
 * returned: the witness is caller code and can itself fire the signal as a
 * side effect of the very sample that just tripped, and an abort must still
 * win even then.
 */
export function checkAfterAdvance<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  context: M3LProcedureContext<TShape>,
  decision: Extract<FlowDecision<TShape>, { kind: "advance" }>,
  stepId: TShape["stepId"],
  progressTracker: ProgressTracker | undefined,
  progress: CapturedProgressConfig<TShape> | undefined,
): StepGuardFailure<TShape> | undefined {
  const abortError = checkAbortBoundary(context.signal);
  if (abortError !== undefined) {
    return toAbortedStepGuardFailure(runtime, abortError, decision.index);
  }
  if (progressTracker === undefined || progress === undefined) {
    return undefined;
  }
  const stallFailure = sampleProgress(
    progressTracker,
    progress.maxStalledSteps,
    stepId,
  );
  if (stallFailure === undefined) return undefined;

  const postSampleAbort = checkAbortBoundary(context.signal);
  if (postSampleAbort !== undefined) {
    return toAbortedStepGuardFailure(runtime, postSampleAbort, decision.index);
  }
  return stallFailure;
}
