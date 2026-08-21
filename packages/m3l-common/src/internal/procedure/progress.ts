/**
 * `internal/procedure/progress` — the opt-in no-progress guard: captures and
 * validates `options.progress`, builds a `ProgressTracker` reusing the
 * shared `internal/polling/progress.ts` stall-counting primitive rather than
 * duplicating it, and translates its failure modes into `core/procedure`'s
 * own error vocabulary (never leaking a polling-vocabulary code to a
 * `core/procedure` caller).
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isFunction, isNumber } from "../../core/utils/guards.js";

import { M3LPollingInvalidOptionError } from "../polling/errors.js";
import { ProgressTracker } from "../polling/progress.js";

import {
  M3LProcedureInvalidOptionError,
  M3LProcedureNoProgressError,
} from "./errors.js";

import type { M3LProcedureContext } from "../../core/procedure/step-types.js";
import type {
  M3LProcedureProgressOptions,
  M3LProcedureProgressWitness,
} from "../../core/procedure/run-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";
import type { StepGuardFailure } from "./run-state.js";

/**
 * The opt-in no-progress guard's `witness`/`maxStalledSteps`, captured by
 * value exactly once from `options.progress`.
 */
export interface CapturedProgressConfig<TShape extends M3LProcedureShape> {
  readonly witness: M3LProcedureProgressWitness<TShape>;
  readonly maxStalledSteps: number;
}

/**
 * Reads `progress` off the caller's run options exactly once — `witness` and
 * `maxStalledSteps` are each read into a local `const` before being copied
 * into the frozen result, so a getter-backed caller object cannot disagree
 * between this read and a later one (the same "two observations of a
 * mutable caller graph" hazard `parameters`/`initialValues`/`trace` capture
 * already close). Returns `undefined` when `progress` is `undefined` — the
 * guard is opt-in.
 */
export function captureProgressOptions<TShape extends M3LProcedureShape>(
  progress: M3LProcedureProgressOptions<TShape> | undefined,
): CapturedProgressConfig<TShape> | undefined {
  if (progress === undefined) return undefined;
  const witness = progress.witness;
  const maxStalledSteps = progress.maxStalledSteps;
  return Object.freeze({ witness, maxStalledSteps });
}

/**
 * Validates the opt-in `progress` guard's already-captured shape: `witness`
 * must be a function and `maxStalledSteps` a finite integer greater than 0.
 * A no-op when `progress` is `undefined`. Reads only the captured copy
 * {@link captureProgressOptions} produced — never the caller's original
 * `options.progress` a second time.
 *
 * @throws {@link M3LProcedureInvalidOptionError} when either field is malformed.
 */
export function validateProgressOptions<TShape extends M3LProcedureShape>(
  progress: CapturedProgressConfig<TShape> | undefined,
): void {
  if (progress === undefined) return;
  if (!isFunction(progress.witness)) {
    throw new M3LProcedureInvalidOptionError(
      "progress.witness must be a function",
      { option: "progress.witness" },
    );
  }
  if (
    !isNumber(progress.maxStalledSteps) ||
    !Number.isInteger(progress.maxStalledSteps) ||
    progress.maxStalledSteps <= 0
  ) {
    throw new M3LProcedureInvalidOptionError(
      "progress.maxStalledSteps must be a finite integer greater than 0",
      { option: "progress.maxStalledSteps", value: progress.maxStalledSteps },
    );
  }
}

/**
 * Builds the opt-in no-progress guard's `ProgressTracker`, reusing
 * `internal/polling/progress.ts`'s stall-counting primitive — or
 * `undefined` when the caller declined `options.progress`. `getContext` is
 * called at SAMPLE time, not at construction time: the tracker is
 * instantiated once per `run()` call frame (never stored anywhere longer-
 * lived), and phase 1's `context` binding is reassigned every step, so the
 * witness must read it through a closure over the run loop's own local
 * variable rather than capturing the initial value.
 *
 * `ProgressTracker.maxStalledAttempts` is documented as "consecutive
 * unchanged samples after the baseline that trip the guard" — exactly what
 * `M3LProcedureProgressOptions.maxStalledSteps` documents for itself, so it
 * is passed straight through with no translation.
 *
 * Deliberately does NOT wrap this construction in a try/catch:
 * `ProgressTracker`'s constructor performs no validation of its own (it
 * only assigns its two fields) and therefore cannot throw —
 * `validateProgressOptions` is the sole place a malformed `progress` shape
 * is rejected, and only `sampleProgress`'s guarded `tracker.record()` call
 * can ever observe an `M3LPollingInvalidOptionError` (from the witness
 * itself, at sample time).
 */
export function createProgressTracker<TShape extends M3LProcedureShape>(
  progress: CapturedProgressConfig<TShape> | undefined,
  getContext: () => M3LProcedureContext<TShape>,
): ProgressTracker | undefined {
  if (progress === undefined) return undefined;
  return new ProgressTracker({
    witness: () => progress.witness(getContext()),
    maxStalledAttempts: progress.maxStalledSteps,
  });
}

/**
 * Samples `tracker` once for the step that just completed (`stepId`),
 * translating both of its failure modes into engine-native ones: a tripped
 * guard becomes {@link M3LProcedureNoProgressError}
 * (`ERR_PROCEDURE_NO_PROGRESS`), and a witness that threw or returned a
 * non-primitive — surfaced by `ProgressTracker.record()` as
 * `ERR_POLLING_INVALID_OPTION` — is re-wrapped as
 * {@link M3LProcedureInvalidOptionError} (`ERR_PROCEDURE_INVALID_OPTION`) so
 * a `core/procedure` caller never observes a polling-vocabulary code. The
 * witness's own original thrown value — not the
 * `M3LPollingInvalidOptionError` wrapper — is chained as `cause`
 * (`undefined` when the failure was a non-primitive return, which carries
 * no original cause).
 */
export function sampleProgress<TShape extends M3LProcedureShape>(
  tracker: ProgressTracker,
  maxStalledSteps: number,
  stepId: TShape["stepId"],
): Extract<StepGuardFailure<TShape>, { kind: "failed" }> | undefined {
  let tripped: boolean;
  try {
    tripped = tracker.record();
  } catch (cause) {
    const originalCause =
      cause instanceof M3LPollingInvalidOptionError ? cause.cause : cause;
    return {
      kind: "failed",
      stepId,
      error: new M3LProcedureInvalidOptionError(
        "the procedure's progress witness rejected a sample",
        { option: "progress.witness" },
        { cause: originalCause },
      ),
    };
  }
  if (!tripped) return undefined;
  return {
    kind: "failed",
    stepId,
    error: new M3LProcedureNoProgressError(
      `no progress observed for ${maxStalledSteps} consecutive step(s)`,
      { stalledSteps: maxStalledSteps, lastStepId: stepId },
    ),
  };
}
