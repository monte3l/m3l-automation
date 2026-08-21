/**
 * `internal/procedure/errors` — private `M3LError` subclasses thrown by
 * `core/procedure`. Never re-exported through a public barrel: callers
 * narrow on `instanceof M3LError` and the machine-readable `code`, not on a
 * subclass identity — see `docs/reference/core/procedure.md` § Public API.
 *
 * Slice 3a (`M3LProcedure.run()`) adds three more codes:
 * {@link M3LProcedureInvalidOptionError}, {@link M3LProcedureIterationLimitError},
 * and {@link M3LProcedureUndeclaredJumpError}. Slice 3c adds the sixteenth and
 * final code, {@link M3LProcedureNoProgressError} — the opt-in no-progress
 * guard's failure.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Thrown (synchronously) by `M3LProcedureBuilder.build` when a procedure's
 * declared definition violates one of the builder's structural or
 * cross-reference invariants — e.g. a duplicate step/case id, a `jumpsTo`
 * target that names no declared step, or a case priority collision. Carries
 * the stable code `ERR_PROCEDURE_INVALID_DEFINITION`.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // builder.build(fallback);
 * } catch (error) {
 *   if (error instanceof M3LError && error.code === "ERR_PROCEDURE_INVALID_DEFINITION") {
 *     console.error(error.context["problems"]);
 *   }
 * }
 * ```
 */
export class M3LProcedureInvalidDefinitionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_INVALID_DEFINITION"`. */
  override readonly code: "ERR_PROCEDURE_INVALID_DEFINITION";

  /**
   * @param message - Human-readable description; for the normal (structured
   *   `problems`) path, `renderProcedureProblemsMessage`'s output.
   * @param context - Structured diagnostics; normally `{ problems }`.
   * @param options - Optional `cause` — used only by `M3LProcedureBuilder.build()`'s
   *   defense-in-depth backstop, which chains the raw error a hostile
   *   getter (or any other unexpected throw during validation) produced.
   */
  constructor(
    message: string,
    context: Record<string, unknown>,
    options?: { readonly cause?: unknown },
  ) {
    super(message, {
      code: "ERR_PROCEDURE_INVALID_DEFINITION",
      context,
      cause: options?.cause,
    });
    this.code = "ERR_PROCEDURE_INVALID_DEFINITION";
  }
}

/**
 * Thrown synchronously by {@link M3LProcedure.run} when a caller-supplied run
 * option violates its contract — before any step executes. Distinct from
 * `ERR_PROCEDURE_INVALID_DEFINITION`, which is a `build()`-time problem with
 * the procedure's own declaration, not with a particular run's options.
 *
 * Also resolved (never thrown) as a `"failed"` outcome's `error`, mid-run,
 * by `sampleProgress` (`internal/procedure/progress.ts`) when the opt-in
 * `options.progress` witness throws or returns a non-primitive value while
 * being sampled after a step completes — a witness-vocabulary failure
 * re-wrapped under this engine-native code so a `core/procedure` caller never
 * observes the underlying polling code.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * declare const procedure: { run(options: unknown): Promise<unknown> };
 *
 * try {
 *   await procedure.run({ maxIterations: -1 });
 * } catch (error) {
 *   if (error instanceof M3LError && error.code === "ERR_PROCEDURE_INVALID_OPTION") {
 *     console.error(error.context["option"]);
 *   }
 * }
 * ```
 */
export class M3LProcedureInvalidOptionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_INVALID_OPTION"`. */
  override readonly code: "ERR_PROCEDURE_INVALID_OPTION";

  /**
   * @param message - Human-readable description of the failure.
   * @param context - Structured diagnostic context (e.g. `{ option, value }`).
   * @param options - Optional `cause` — a defense-in-depth chain for an
   *   unexpected throw (e.g. a hostile getter) encountered while reading a
   *   caller-supplied run option, distinct from the normal validation-failure
   *   path which needs no `cause`.
   */
  constructor(
    message: string,
    context: Record<string, unknown>,
    options?: { readonly cause?: unknown },
  ) {
    super(message, {
      code: "ERR_PROCEDURE_INVALID_OPTION",
      context,
      cause: options?.cause,
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
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * declare const outcome: { status: string; error?: unknown };
 *
 * if (outcome.status === "failed" && outcome.error instanceof M3LError) {
 *   if (outcome.error.code === "ERR_PROCEDURE_ITERATION_LIMIT") {
 *     console.error(outcome.error.context["limit"]);
 *   }
 * }
 * ```
 */
export class M3LProcedureIterationLimitError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_ITERATION_LIMIT"`. */
  override readonly code: "ERR_PROCEDURE_ITERATION_LIMIT";

  /**
   * @param message - Human-readable description of the failure.
   * @param context - Structured diagnostic context, always carrying `limit`.
   */
  constructor(message: string, context: Record<string, unknown>) {
    super(message, { code: "ERR_PROCEDURE_ITERATION_LIMIT", context });
    this.code = "ERR_PROCEDURE_ITERATION_LIMIT";
  }
}

/**
 * Resolved as a `"failed"` outcome's `error` (never a rejection) by
 * {@link M3LProcedure.run} when a step's `{ goTo }` flow directive names a
 * target that either isn't a declared step id, or is declared but absent
 * from the declaring step's own `jumpsTo` allowlist — or when the returned
 * result's `flow` is malformed entirely (missing, `null`, a non-string
 * `goTo`, or an unrecognized string outside the four recognized directive
 * forms). Reported instead of silently falling through to the next declared
 * step, silently succeeding a jump the declaring step never listed, or
 * throwing a bare `TypeError`. `context["stepId"]` names the step whose flow
 * directive was rejected; `context["goTo"]` carries the rejected target when
 * one was attempted.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * declare const outcome: { status: string; error?: unknown };
 *
 * if (outcome.status === "failed" && outcome.error instanceof M3LError) {
 *   if (outcome.error.code === "ERR_PROCEDURE_UNDECLARED_JUMP") {
 *     console.error(outcome.error.context["stepId"]);
 *   }
 * }
 * ```
 */
export class M3LProcedureUndeclaredJumpError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_UNDECLARED_JUMP"`. */
  override readonly code: "ERR_PROCEDURE_UNDECLARED_JUMP";

  /**
   * @param message - Human-readable description of the failure.
   * @param context - Structured diagnostic context, always carrying `stepId`.
   * @param options - Optional `cause` — a defense-in-depth chain for an
   *   unexpected throw (e.g. a hostile getter) encountered while reading a
   *   step result's `flow`/`output`/`note`/`values` properties, distinct
   *   from the normal malformed-flow path which needs no `cause`.
   */
  constructor(
    message: string,
    context: Record<string, unknown>,
    options?: { readonly cause?: unknown },
  ) {
    super(message, {
      code: "ERR_PROCEDURE_UNDECLARED_JUMP",
      context,
      cause: options?.cause,
    });
    this.code = "ERR_PROCEDURE_UNDECLARED_JUMP";
  }
}

/**
 * Resolved as a `"failed"` outcome's `error` (never a rejection) by
 * {@link M3LProcedure.run} when the opt-in no-progress guard's
 * `ProgressTracker` reports `maxStalledSteps` consecutive unchanged samples.
 * `context["stalledSteps"]` carries the configured threshold that was
 * reached; `context["lastStepId"]` names the step that just completed when
 * the trip was observed.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * declare const outcome: { status: string; error?: unknown };
 *
 * if (outcome.status === "failed" && outcome.error instanceof M3LError) {
 *   if (outcome.error.code === "ERR_PROCEDURE_NO_PROGRESS") {
 *     console.error(outcome.error.context["stalledSteps"]);
 *   }
 * }
 * ```
 */
export class M3LProcedureNoProgressError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PROCEDURE_NO_PROGRESS"`. */
  override readonly code: "ERR_PROCEDURE_NO_PROGRESS";

  /**
   * @param message - Human-readable description of the failure.
   * @param context - Structured diagnostic context, always carrying
   *   `stalledSteps` and `lastStepId`.
   */
  constructor(message: string, context: Record<string, unknown>) {
    super(message, { code: "ERR_PROCEDURE_NO_PROGRESS", context });
    this.code = "ERR_PROCEDURE_NO_PROGRESS";
  }
}
