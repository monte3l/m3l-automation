/**
 * `aws/clients` — AWS SDK v3 client provisioning: lazily-cached,
 * profile-aware `AWSClientProvider` / `AWSMultiClientProvider`, and the
 * `AWSProvider` facade.
 *
 * @packageDocumentation
 */

export { AWSClientProvider } from "./provider.js";
export { AWSMultiClientProvider } from "./multi-provider.js";
export { AWSProvider } from "./aws-provider.js";
export { AWS_REGION } from "./region.js";
export { M3LAWSClientError } from "./error.js";
