/**
 * `aws/secrets-manager` — typed Secrets Manager operations wrapper over the
 * raw `@aws-sdk/client-secrets-manager` `SecretsManagerClient`, so callers
 * never import SDK command classes directly. See
 * `docs/reference/aws/secrets-manager.md`.
 *
 * @packageDocumentation
 */

export { M3LSecretsManagerOperations } from "./client.js";
export { M3LSecretsManagerOperationError } from "./error.js";
export type {
  M3LCreateSecretInput,
  M3LCreateSecretResult,
  M3LDeleteSecretOptions,
  M3LDeleteSecretResult,
  M3LGetSecretValueOptions,
  M3LPutSecretValueInput,
  M3LPutSecretValueResult,
  M3LSecretMetadata,
  M3LSecretValue,
  M3LSecretsManagerTag,
} from "./types.js";
