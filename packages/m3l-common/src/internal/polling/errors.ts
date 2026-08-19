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
 * Thrown when a numeric configuration value is non-finite or out of range.
 * Carries the stable code `ERR_POLLING_INVALID_OPTION`.
 */
export class M3LPollingInvalidOptionError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_POLLING_INVALID_OPTION"`. */
  override readonly code: "ERR_POLLING_INVALID_OPTION";

  constructor(message: string) {
    super(message, { code: "ERR_POLLING_INVALID_OPTION" });
    this.code = "ERR_POLLING_INVALID_OPTION";
  }
}

/**
 * Thrown when a {@link M3LPoller}/{@link M3LRetryRunner} progress witness
 * stays unchanged (per `Object.is`) for `maxStalledAttempts` consecutive
 * attempts. Carries the stable code `ERR_NO_PROGRESS`; `context.attempts`
 * records the 1-based attempt that tripped the guard and
 * `context.stalledAttempts` the configured threshold that was reached.
 */
export class M3LNoProgressError extends M3LError {
  /** Narrows the inherited `code` to the literal `"ERR_NO_PROGRESS"`. */
  override readonly code: "ERR_NO_PROGRESS";

  constructor(
    message: string,
    context: { readonly attempts: number; readonly stalledAttempts: number },
  ) {
    super(message, { code: "ERR_NO_PROGRESS", context });
    this.code = "ERR_NO_PROGRESS";
  }
}
