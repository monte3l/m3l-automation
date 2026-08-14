/**
 * `steps/preflight-secret` — validates `secret.arn` before any RDS Data API
 * operation runs.
 *
 * Business logic lives here — never in `main.ts`. One
 * `secretsManager.describeSecret(secretArn)` call turns a typo'd or
 * wrong-account secret ARN into a typed {@link Core.M3LError} instead of an
 * opaque Data API `BadRequestException` surfacing mid-statement.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

/** The `Core.M3LError` code `preflightSecret` throws with on a failed `describeSecret` call. */
const SECRET_PREFLIGHT_CODE = "ERR_RDS_DATA_SQL_SECRET_PREFLIGHT";

/** Injected dependencies for {@link preflightSecret}. */
export interface PreflightSecretDeps {
  /** The provisioned Secrets Manager operations wrapper (`script.aws.services.secretsManager`). */
  readonly secretsManager: AWS.M3LSecretsManagerOperations;
  /** The Secrets Manager ARN to preflight-validate (the resolved `secret.arn`). */
  readonly secretArn: string;
}

/**
 * Preflight-validates `deps.secretArn` via one `describeSecret` call before
 * any operation runs.
 *
 * @param deps - See {@link PreflightSecretDeps}.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_SECRET_PREFLIGHT"`
 *   when the underlying `describeSecret` call rejects, chaining the raw
 *   rejection as `cause`.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { preflightSecret } from "./preflight-secret.js";
 *
 * async function run(script: Core.M3LScript, secretArn: string): Promise<void> {
 *   await preflightSecret({
 *     secretsManager: script.aws.services.secretsManager,
 *     secretArn,
 *   });
 * }
 * ```
 */
export async function preflightSecret(
  deps: PreflightSecretDeps,
): Promise<void> {
  try {
    await deps.secretsManager.describeSecret(deps.secretArn);
  } catch (cause) {
    throw new Core.M3LError(
      `secret preflight failed for secret.arn=${deps.secretArn}`,
      { code: SECRET_PREFLIGHT_CODE, cause },
    );
  }
}
