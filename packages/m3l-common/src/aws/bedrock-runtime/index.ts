/**
 * `aws/bedrock-runtime` — typed wrapper over the Amazon Bedrock Converse API
 * (`M3LBedrockRuntimeOperations`), so callers never import
 * `@aws-sdk/client-bedrock-runtime` command classes or touch its `Converse*`
 * types directly. See ADR-0059.
 *
 * Slice 1 (this submodule): `invoke()` single-shot Converse call, the model
 * fallback registry, token usage capture, and the three error classes.
 * `invokeStream`/`M3LBedrockStreamEvent` are added whole in slice 2.
 *
 * @packageDocumentation
 */

export { M3LBedrockRuntimeOperations } from "./client.js";
export {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeNoModelError,
  M3LBedrockRuntimeOperationError,
} from "./error.js";
export type {
  M3LBedrockContentBlock,
  M3LBedrockInferenceConfig,
  M3LBedrockInvocationResult,
  M3LBedrockInvokeOptions,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockRuntimeOptions,
  M3LBedrockRuntimeRole,
  M3LBedrockStopReason,
  M3LBedrockTextBlock,
  M3LBedrockTokenUsage,
} from "./types.js";
