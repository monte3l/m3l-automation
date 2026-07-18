/**
 * `aws/s3` — high-level S3 object operations over the `s3` client from
 * `aws/clients`.
 *
 * Every function takes an already-provisioned client (from
 * `AWSClientProvider`/`AWSProvider`) plus plain parameters, and constructs the
 * AWS SDK v3 command internally — callers never import `@aws-sdk/client-s3`
 * command classes themselves. This is the abstraction boundary: `aws/clients`
 * provisions the raw SDK client; `aws/s3` is the only place that builds SDK
 * commands against it (ADR-0033).
 *
 * @packageDocumentation
 */

export * from "./operations.js";
export { M3LS3OperationError } from "./error.js";
