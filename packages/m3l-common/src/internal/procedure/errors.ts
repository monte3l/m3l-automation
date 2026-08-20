/**
 * `internal/procedure/errors` — private `M3LError` subclasses thrown by
 * `core/procedure`. Never re-exported through a public barrel: callers
 * narrow on `instanceof M3LError` and the machine-readable `code`, not on a
 * subclass identity — see `docs/reference/core/procedure.md` § Public API.
 *
 * Additional `ERR_PROCEDURE_*` codes documented in
 * `docs/reference/core/procedure.md` § Errors and § Build-time validation
 * are added — each in the subclass and validation logic that emits it — as
 * the remaining GREEN passes fill in `build()`, `run()`, and
 * `evaluateProcedureCondition`.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Thrown (synchronously) or used to reject (from `M3LProcedure.run`) by
 * every currently-unimplemented `core/procedure` entry point in this
 * scaffold. Carries the stable code `ERR_PROCEDURE_INVALID_DEFINITION` — the
 * same code `build()`'s real validation failure will carry once
 * implemented, since a stub body is, from a caller's perspective, exactly
 * that: a procedure that cannot yet produce a valid definition.
 */
export class M3LProcedureInvalidDefinitionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_INVALID_DEFINITION"`. */
  override readonly code: "ERR_PROCEDURE_INVALID_DEFINITION";

  constructor(message: string, context: Record<string, unknown>) {
    super(message, { code: "ERR_PROCEDURE_INVALID_DEFINITION", context });
    this.code = "ERR_PROCEDURE_INVALID_DEFINITION";
  }
}

/**
 * Thrown synchronously by {@link M3LProcedure.run} when a caller-supplied
 * run option violates its contract — before any step executes. Distinct
 * from `ERR_PROCEDURE_INVALID_DEFINITION`, which is a `build()`-time problem
 * with the procedure's own declaration, not with a particular run's options.
 *
 * Also resolved (never rejected) as a run's `"failed"` outcome `error` when
 * an in-flight `progress.witness` rejects a sample — `ProgressTracker`
 * (`internal/polling/progress.ts`) reports that as `ERR_POLLING_INVALID_OPTION`,
 * a polling-vocabulary code a `core/procedure` caller must never observe; the
 * optional `cause` lets the run() caller chain the witness's own thrown value.
 */
export class M3LProcedureInvalidOptionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_INVALID_OPTION"`. */
  override readonly code: "ERR_PROCEDURE_INVALID_OPTION";

  /**
   * @param message - Human-readable description of the failure.
   * @param context - Structured diagnostic context.
   * @param cause - The underlying failure, when this instance re-wraps one
   *   (e.g. the value a `progress.witness` threw while sampling).
   */
  constructor(
    message: string,
    context: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code: "ERR_PROCEDURE_INVALID_OPTION",
      context,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.code = "ERR_PROCEDURE_INVALID_OPTION";
  }
}

/**
 * Resolved as a `"failed"` outcome's `error` (never a rejection) by
 * {@link M3LProcedure.run} when a run's step executions exceed a ceiling:
 * either the overall run's iteration ceiling (`options.maxIterations`,
 * defaulting to `M3L_PROCEDURE_MAX_ITERATIONS`) or one step's own declared
 * `loop.maxRevisits` ceiling. `context["limit"]` discriminates the two —
 * `"iterations"` or `"revisits"`.
 */
export class M3LProcedureIterationLimitError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_ITERATION_LIMIT"`. */
  override readonly code: "ERR_PROCEDURE_ITERATION_LIMIT";

  constructor(message: string, context: Record<string, unknown>) {
    super(message, { code: "ERR_PROCEDURE_ITERATION_LIMIT", context });
    this.code = "ERR_PROCEDURE_ITERATION_LIMIT";
  }
}

/**
 * Resolved as a `"failed"` outcome's `error` (never a rejection) by
 * {@link M3LProcedure.run} when the opt-in no-progress guard's
 * `ProgressTracker` reports `maxStalledSteps` consecutive unchanged samples.
 * `context["stalledSteps"]` carries the configured threshold that was
 * reached; `context["lastStepId"]` names the step whose completion produced
 * the tripping sample.
 */
export class M3LProcedureNoProgressError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_NO_PROGRESS"`. */
  override readonly code: "ERR_PROCEDURE_NO_PROGRESS";

  constructor(message: string, context: Record<string, unknown>) {
    super(message, { code: "ERR_PROCEDURE_NO_PROGRESS", context });
    this.code = "ERR_PROCEDURE_NO_PROGRESS";
  }
}
