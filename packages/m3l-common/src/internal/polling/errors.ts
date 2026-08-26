/**
 * `internal/polling/errors` — private M3LError subclasses thrown by the polling
 * primitives. These are intentionally NOT re-exported from the public barrel:
 * callers narrow on `instanceof M3LError` and the machine-readable `code`, not
 * on a subclass identity. Keeping them private preserves the module's public
 * surface, which only ever grows through `core/polling/index.ts`'s barrel.
 *
 * Private to `core/polling`; never re-exported through a public barrel.
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Thrown when a {@link M3LPoller} check returns a terminal `failure` decision.
 * Carries the stable code `ERR_POLL_FAILURE`.
 */
export class M3LPollFailureError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_POLL_FAILURE"`. */
  override readonly code: "ERR_POLL_FAILURE";

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, {
      code: "ERR_POLL_FAILURE",
      ...(context !== undefined ? { context } : {}),
    });
    this.code = "ERR_POLL_FAILURE";
  }
}

/**
 * Thrown when a {@link M3LPoller} exhausts its attempt bound while the check is
 * still returning `continue`. Carries the stable code `ERR_POLL_EXHAUSTED`;
 * `context.attempts` records the exhausted bound.
 */
export class M3LPollExhaustedError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_POLL_EXHAUSTED"`. */
  override readonly code: "ERR_POLL_EXHAUSTED";

  constructor(message: string, context: { readonly attempts: number }) {
    super(message, { code: "ERR_POLL_EXHAUSTED", context });
    this.code = "ERR_POLL_EXHAUSTED";
  }
}

/**
 * Thrown when a numeric configuration value is non-finite or out of range,
 * or when a `progress` witness throws or returns a non-primitive value while
 * sampling. Carries the stable code `ERR_POLLING_INVALID_OPTION`.
 */
export class M3LPollingInvalidOptionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_POLLING_INVALID_OPTION"`. */
  override readonly code: "ERR_POLLING_INVALID_OPTION";

  /**
   * @param message - Human-readable description of the failure. Never
   *   includes the caller-supplied value itself (only the option name).
   * @param options - Optional `cause`, e.g. the value a `progress.witness`
   *   threw while sampling.
   */
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, {
      code: "ERR_POLLING_INVALID_OPTION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_POLLING_INVALID_OPTION";
  }
}

/**
 * Thrown when a "no progress" observation repeats. Two independent families
 * of caller trip this class, each with its own comparison mechanism:
 * {@link M3LPoller}/{@link M3LRetryRunner} throw it when their caller-supplied
 * `progress` witness returns a value unchanged (per `Object.is`) for
 * `maxStalledAttempts` consecutive attempts; `internal/aws/pagination`'s page
 * cursor guards (used by `aws/dynamodb`'s `queryItems`/`scanSegment` and
 * `aws/s3`'s `listObjects`) throw it when a paginated operation's own page
 * cursor — there is no separate witness function, the cursor itself is
 * compared — normalizes to the same serialized string on two consecutive
 * pages. Carries the stable code `ERR_NO_PROGRESS`; `context.attempts`
 * records the 1-based count of relevant observations up to and including the
 * one that tripped the guard, and `context.stalledAttempts` records how many
 * consecutive unchanged observations triggered the rejection — for
 * `M3LPoller`/`M3LRetryRunner` this equals the caller's configured
 * `maxStalledAttempts`, while for the pagination guards it is always the
 * fixed value `1`, since pagination has no configurable threshold and trips
 * on the first repeat.
 */
export class M3LNoProgressError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_NO_PROGRESS"`. */
  override readonly code: "ERR_NO_PROGRESS";

  /**
   * @param message - Human-readable description of the failure.
   * @param context - `attempts` (1-based, the attempt that tripped the
   *   guard) and `stalledAttempts` (how many consecutive unchanged
   *   observations triggered the rejection — see the class doc for how this
   *   differs between the polling and pagination throwers).
   * @param options - Optional `cause`. `M3LRetryRunner` threads the
   *   operation's in-flight error through as `cause` so a no-progress
   *   rejection still carries what the operation was actually failing with;
   *   `M3LPoller` has no in-flight error and omits it.
   */
  constructor(
    message: string,
    context: { readonly attempts: number; readonly stalledAttempts: number },
    options?: { readonly cause?: unknown },
  ) {
    super(message, {
      code: "ERR_NO_PROGRESS",
      context,
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_NO_PROGRESS";
  }
}
