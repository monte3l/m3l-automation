/**
 * `core/orchestration/M3LStepReferenceError` — typed failure for a malformed
 * step-output reference, or a resolve-time walk that cannot match the data
 * actually present.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LStepReferenceError}.
 *
 * `cause` is optional; the error code is always
 * `"ERR_STEP_REFERENCE_INVALID"` and is set automatically — callers must not
 * supply it. There is deliberately no `context` field: every throw site
 * already folds the offending detail (reference text, segment name, or
 * index) into `message` at a bounded size — the reference grammar itself
 * caps digit runs at 15 characters and callers are expected to keep segment
 * names short — so a separate structured bag would duplicate `message`
 * without adding a safe way to carry arbitrarily large caller input (an
 * unbounded `context.text` on a multi-megabyte malformed reference would
 * produce a multi-megabyte error).
 */
interface M3LStepReferenceErrorOptions {
  /** The underlying cause, if this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link parseStepReference}, {@link formatStepReference}, and
 * {@link resolveStepReference} when reference text does not match the
 * grammar, or when a parsed reference cannot be walked against the data
 * actually present (e.g. indexing into a non-array value, or a forbidden
 * prototype-pollution vector property name).
 *
 * Callers that need to distinguish a step-reference problem from other
 * {@link M3LError} subclasses should catch this type specifically.
 *
 * @example
 * ```ts
 * import {
 *   M3LStepReferenceError,
 *   parseStepReference,
 * } from "@m3l-automation/m3l-common/core";
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   parseStepReference("not-a-reference");
 * } catch (e) {
 *   if (e instanceof M3LStepReferenceError) {
 *     // e.message already names the offending reference text and reason
 *   } else if (e instanceof M3LError) {
 *     throw e;
 *   }
 * }
 * ```
 */
export class M3LStepReferenceError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_STEP_REFERENCE_INVALID"`. */
  override readonly code: "ERR_STEP_REFERENCE_INVALID";

  /**
   * Creates a new `M3LStepReferenceError`.
   *
   * @param message - Human-readable description of the failure; callers
   *   should fold any offending-reference detail into this string.
   * @param options - Optional options bag; `cause` carries an underlying
   *   error if applicable. The error code is always
   *   `"ERR_STEP_REFERENCE_INVALID"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LStepReferenceErrorOptions) {
    super(message, {
      code: "ERR_STEP_REFERENCE_INVALID",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_STEP_REFERENCE_INVALID";
  }
}
