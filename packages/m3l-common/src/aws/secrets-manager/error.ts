/**
 * `aws/secrets-manager/error` — typed error for Secrets Manager operation
 * failures (as distinct from client construction/teardown failures, which
 * are {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LSecretsManagerOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so
 * the options shape is an implementation detail of the constructor.
 */
interface M3LSecretsManagerOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection. Explicitly
   * widened to include `undefined` (rather than only being optional) so
   * callers that carry a `unknown | undefined`-typed cause can forward it
   * directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LSecretsManagerOperations} when a Secrets Manager
 * operation fails: a `GetSecretValue`/`CreateSecret`/`PutSecretValue`/
 * `DescribeSecret`/`DeleteSecret` request rejects after retries.
 *
 * @example
 * ```ts
 * import { M3LSecretsManagerOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await secretsManagerOperations.getSecretValue("db-password");
 * } catch (error) {
 *   if (error instanceof M3LSecretsManagerOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LSecretsManagerOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_SECRETS_MANAGER_OPERATION"`. */
  override readonly code = "ERR_SECRETS_MANAGER_OPERATION" as const;

  /**
   * Creates a new `M3LSecretsManagerOperationError`.
   *
   * @param message - Human-readable description of the failure. Must never
   *   contain the secret's value, only identifiers such as the secret's name
   *   or id.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always
   *   `"ERR_SECRETS_MANAGER_OPERATION"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LSecretsManagerOperationErrorOptions,
  ) {
    super(message, {
      code: "ERR_SECRETS_MANAGER_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
