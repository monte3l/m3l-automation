/**
 * AWS namespace — credential management and SDK client provisioning.
 *
 * Public submodules (documented under `docs/reference/aws/`) are re-exported
 * here as they are implemented, in dependency order: `models`, `credentials`,
 * `clients`, `dynamodb`.
 *
 * @packageDocumentation
 */

export * from "./models/index.js";
export * from "./credentials/index.js";
export * from "./clients/index.js";
export * from "./dynamodb/index.js";
