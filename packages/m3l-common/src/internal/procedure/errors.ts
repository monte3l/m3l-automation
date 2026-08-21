/**
 * `internal/procedure/errors` — private `M3LError` subclasses thrown by
 * `core/procedure`. Never re-exported through a public barrel: callers
 * narrow on `instanceof M3LError` and the machine-readable `code`, not on a
 * subclass identity — see `docs/reference/core/procedure.md` § Public API.
 *
 * Slice 2a (build-time validation) ships only
 * {@link M3LProcedureInvalidDefinitionError}; the run-loop codes
 * (`ERR_PROCEDURE_INVALID_OPTION`, `ERR_PROCEDURE_ITERATION_LIMIT`,
 * `ERR_PROCEDURE_NO_PROGRESS`, `ERR_PROCEDURE_UNDECLARED_JUMP`) land with the
 * `run()` slice that actually emits them.
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
