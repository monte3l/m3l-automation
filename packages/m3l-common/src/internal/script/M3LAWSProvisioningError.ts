/**
 * `internal/script/M3LAWSProvisioningError` — private M3LError subclass
 * thrown when `M3LScript`'s stage-5 AWS client facade fails to load.
 *
 * Intentionally NOT re-exported from any public barrel: callers narrow on
 * `instanceof M3LError` and the machine-readable `code`, not on this
 * subclass's identity. Keeping it private also avoids a static core-to-aws
 * module dependency — `M3LScript` only needs the error *shape*, not the
 * `aws` namespace's own error types, to type this seam.
 *
 * Private to `core/script`; never re-exported through a public barrel.
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LAWSProvisioningError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LAWSProvisioningErrorOptions {
  /**
   * The underlying cause: the raw dynamic-import rejection or `AWSProvider`
   * constructor throw. Explicitly widened to include `undefined` (rather
   * than only being optional) so callers that carry an `unknown`-typed
   * `catch` binding can forward it directly under
   * `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by `M3LScript`'s stage-5 AWS provisioning seam
 * (`provisionAws`) when the dynamic `aws/clients` facade module fails to
 * load or `AWSProvider` construction throws.
 *
 * This is the internal seam error for a failed AWS facade load; it is
 * surfaced to consumers only as an {@link M3LError} narrowable by
 * `code === "ERR_AWS_PROVISIONING"` — the concrete subclass is never
 * exported. The originating failure is always chained via `cause`.
 */
export class M3LAWSProvisioningError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_AWS_PROVISIONING"`. */
  override readonly code = "ERR_AWS_PROVISIONING" as const;

  /**
   * Creates a new `M3LAWSProvisioningError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   dynamic-import or `AWSProvider` constructor failure. The error code
   *   is always `"ERR_AWS_PROVISIONING"` — it cannot be overridden.
   */
  constructor(message: string, options: M3LAWSProvisioningErrorOptions = {}) {
    super(message, {
      code: "ERR_AWS_PROVISIONING",
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
  }
}
