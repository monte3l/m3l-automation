/**
 * `aws/credentials/error` — typed error for `M3LAWSCredentialsManager`.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";
import type { M3LAWSCredentialsErrorType } from "../models/index.js";

/**
 * Constructor options for {@link M3LAWSCredentialsError}.
 *
 * `type` and `profile` are folded into the inherited `context` bag rather
 * than exposed as top-level fields — this keeps the error's own surface
 * stable while still letting callers introspect the classification via
 * `error.context.type` / `error.context.profile`.
 */
interface M3LAWSCredentialsErrorOptions {
  /** The underlying cause: an SDK rejection, spawn failure, or import error. */
  readonly cause?: unknown;
  /**
   * The classified failure category, folded into `context.type`. Explicitly
   * widened to include `undefined` (rather than only being optional) so
   * callers that carry a `string | undefined`-typed classification —
   * e.g. `M3LAWSCredentialsErrorAnalysis["type"]` threaded through from
   * {@link M3LAWSCredentialsManager.analyzeError} — can forward it directly
   * under `exactOptionalPropertyTypes`.
   */
  readonly type?: M3LAWSCredentialsErrorType | undefined;
  /**
   * The affected AWS profile, folded into `context.profile`. Explicitly
   * widened to include `undefined` so callers that carry a
   * `string | undefined`-typed profile (e.g. the profile supplied at
   * construction time, which is optional) can forward it directly under
   * `exactOptionalPropertyTypes`.
   */
  readonly profile?: string | undefined;
}

/**
 * Thrown by {@link M3LAWSCredentialsManager} when a credential failure
 * cannot be recovered by re-authenticating, when an interactive re-login
 * confirmation is declined, or when a required optional-peer AWS SDK package
 * (`@aws-sdk/client-sts`, `@aws-sdk/credential-providers`) is not installed.
 *
 * `context.type` carries the classified {@link M3LAWSCredentialsErrorType}
 * and `context.profile` carries the affected profile name, when known; the
 * underlying SDK, spawn, or dynamic-import failure is chained via `cause`.
 *
 * `cause` may carry provider/SDK internals (e.g. raw STS or credential
 * provider errors); this class does not redact it — as with the rest of the
 * {@link M3LError} hierarchy, redaction before persistence or transmission
 * is delegated to the logging sink via `toJSON`.
 *
 * @example
 * ```ts
 * import { M3LAWSCredentialsError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   // ... validate credentials ...
 * } catch (cause) {
 *   throw new M3LAWSCredentialsError("could not validate profile 'default'", {
 *     type: "PROFILE_NOT_FOUND",
 *     profile: "default",
 *     cause,
 *   });
 * }
 * ```
 */
export class M3LAWSCredentialsError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_AWS_CREDENTIALS"`. */
  override readonly code: "ERR_AWS_CREDENTIALS";

  /**
   * Creates a new `M3LAWSCredentialsError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `type` and `profile` are folded
   *   into `context`, and `cause` carries the underlying failure. The error
   *   code is always `"ERR_AWS_CREDENTIALS"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LAWSCredentialsErrorOptions) {
    super(message, {
      code: "ERR_AWS_CREDENTIALS",
      context: {
        ...(options?.type !== undefined && { type: options.type }),
        ...(options?.profile !== undefined && { profile: options.profile }),
      },
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_AWS_CREDENTIALS";
  }
}
