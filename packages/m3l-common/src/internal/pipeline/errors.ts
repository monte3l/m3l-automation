/**
 * `internal/pipeline/errors` — private M3LError subclass thrown by
 * {@link M3LOperationPipeline}'s constructor-time option validation. This is
 * intentionally NOT re-exported from the public barrel: callers narrow on
 * `instanceof M3LError` and the machine-readable `code`, not on a subclass
 * identity.
 *
 * Private to `core/pipeline`; never re-exported through a public barrel.
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Thrown by {@link M3LOperationPipeline}'s constructor when
 * `M3LOperationPipelineOptions` fails eager validation (an empty or
 * duplicate-containing `operations` list, or a `destructive.operations`
 * member absent from `operations`). Carries the stable code
 * `ERR_PIPELINE_INVALID_OPTION`.
 */
export class M3LPipelineInvalidOptionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_PIPELINE_INVALID_OPTION"`. */
  override readonly code: "ERR_PIPELINE_INVALID_OPTION";

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, {
      code: "ERR_PIPELINE_INVALID_OPTION",
      ...(context !== undefined ? { context } : {}),
    });
    this.code = "ERR_PIPELINE_INVALID_OPTION";
  }
}
