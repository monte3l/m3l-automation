/**
 * `aws/signing` — {@link M3LRequestSigner}, an AWS SigV4 signer for a bespoke
 * HTTP request no service-specific SDK client models (e.g. a raw
 * `execute-api` call to AWS API Gateway with IAM auth). See ADR-0029.
 *
 * @packageDocumentation
 */

export { M3LRequestSigner } from "./client.js";
export { M3LSigningError } from "./error.js";
export type { M3LRequestSignerOptions, M3LSignableRequest } from "./types.js";
