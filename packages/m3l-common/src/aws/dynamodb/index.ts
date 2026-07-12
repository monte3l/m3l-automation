/**
 * `aws/dynamodb` — high-level DynamoDB item operations over the
 * `dynamoDBDocument`/`dynamoDB` clients from `aws/clients`.
 *
 * Every function takes an already-provisioned client (from
 * `AWSClientProvider`/`AWSProvider`) plus plain-JS-object parameters, and
 * constructs the AWS SDK v3 command internally — callers never import
 * `@aws-sdk/lib-dynamodb` or `@aws-sdk/client-dynamodb` command classes
 * themselves. This is the abstraction boundary: `aws/clients` provisions raw
 * SDK clients; `aws/dynamodb` is the only place that builds SDK commands
 * against them.
 *
 * @packageDocumentation
 */

export * from "./operations.js";
export { M3LDynamoDBOperationError } from "./error.js";
