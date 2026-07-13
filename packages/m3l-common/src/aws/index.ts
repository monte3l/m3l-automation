/**
 * AWS namespace — credential management, SDK client provisioning, and typed
 * AWS operation wrappers.
 *
 * Public submodules (documented under `docs/reference/aws/`) are re-exported
 * here as they are implemented, in dependency order: `models`, `credentials`,
 * `clients`, `dynamodb`, `logs-insights`, `sqs`.
 *
 * @packageDocumentation
 */

export * from "./models/index.js";
export * from "./credentials/index.js";
export * from "./clients/index.js";
export * from "./dynamodb/index.js";
export * from "./logs-insights/index.js";
export * from "./sqs/index.js";
