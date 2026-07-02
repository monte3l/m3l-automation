/**
 * `internal/polling/errors` — private M3LError subclasses thrown by the polling
 * primitives. These are intentionally NOT re-exported from the public barrel:
 * callers narrow on `instanceof M3LError` and the machine-readable `code`, not
 * on a subclass identity. Keeping them private preserves the module's exact
 * 13-symbol public surface.
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

  constructor(message: string) {
    super(message, { code: "ERR_POLL_FAILURE" });
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
