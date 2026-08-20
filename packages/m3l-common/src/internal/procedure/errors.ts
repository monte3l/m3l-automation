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

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, {
      code: "ERR_PROCEDURE_INVALID_DEFINITION",
      ...(context !== undefined ? { context } : {}),
    });
    this.code = "ERR_PROCEDURE_INVALID_DEFINITION";
  }
}

/**
 * Thrown synchronously by {@link M3LProcedure.run} when a caller-supplied
 * run option violates its contract — before any step executes. Distinct
 * from `ERR_PROCEDURE_INVALID_DEFINITION`, which is a `build()`-time problem
 * with the procedure's own declaration, not with a particular run's options.
 */
export class M3LProcedureInvalidOptionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_INVALID_OPTION"`. */
  override readonly code: "ERR_PROCEDURE_INVALID_OPTION";

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, {
      code: "ERR_PROCEDURE_INVALID_OPTION",
      ...(context !== undefined ? { context } : {}),
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
