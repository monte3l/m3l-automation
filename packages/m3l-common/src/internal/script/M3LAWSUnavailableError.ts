/**
 * `internal/script/M3LAWSUnavailableError` — internal seam error thrown when
 * a script declares an `aws.profile` config parameter but AWS credential
 * management is not yet available in this package.
 *
 * Deliberately **not** re-exported through any public barrel: callers can
 * only observe it as an {@link M3LError} (via `instanceof M3LError`). This
 * keeps the seam swappable — once AWS credential management ships, this
 * class (and the call site that throws it) can be replaced without a public
 * API change.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/** Machine-readable code for {@link M3LAWSUnavailableError}. */
const AWS_NOT_AVAILABLE_CODE = "AWS_NOT_AVAILABLE";

/**
 * Thrown by {@link M3LScript.run}'s stage-5 AWS credential seam when the
 * script's config schema declares an `aws.profile` parameter, since AWS
 * credential management is not yet implemented in this package.
 *
 * @internal
 */
export class M3LAWSUnavailableError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"AWS_NOT_AVAILABLE"`. */
  override readonly code: typeof AWS_NOT_AVAILABLE_CODE =
    AWS_NOT_AVAILABLE_CODE;

  /**
   * Creates a new `M3LAWSUnavailableError`.
   *
   * @param message - Human-readable description of the failure.
   */
  constructor(message: string) {
    super(message, { code: AWS_NOT_AVAILABLE_CODE });
  }
}
