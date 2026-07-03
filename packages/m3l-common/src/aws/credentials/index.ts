/**
 * `aws/credentials` — SSO credential validation, login, and
 * retry-on-relogin orchestration.
 *
 * Re-exports the manager and its typed error. The shared AWS model types it
 * consumes (`M3LAWSCredentialsManagerOptions`, `M3LAWSCredentialsErrorType`,
 * `M3LAWSCredentialsErrorAnalysis`, `M3LAWSRetryContext`,
 * `M3LAWSLoginResult`) live in `aws/models` and are not re-exported here.
 *
 * @packageDocumentation
 */

export * from "./error.js";
export * from "./manager.js";
