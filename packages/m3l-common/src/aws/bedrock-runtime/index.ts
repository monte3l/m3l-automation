/**
 * `aws/bedrock-runtime` — typed wrapper over the Amazon Bedrock Converse API
 * (`M3LBedrockRuntimeOperations`), so callers never import
 * `@aws-sdk/client-bedrock-runtime` command classes or touch its `Converse*`
 * types directly. See ADR-0059.
 *
 * Slice 1: `invoke()` single-shot Converse call, the model fallback
 * registry, token usage capture, and the three error classes. Slice 2:
 * `invokeStream()` over `ConverseStream`, `M3LBedrockStreamEvent` and its
 * three members, and `M3LBedrockRuntimeStreamError`. Slice 3: the tool
 * vocabulary — `toolUse`/`toolResult` content blocks, the tool
 * definition/choice/schema types, and `M3LBedrockToolInvokeRequest`. Slice B
 * (V5, this update): the tool-use loop (`runBedrockToolLoop`), its
 * handler/registry contract (`M3LBedrockToolHandler`,
 * `M3LBedrockToolRegistry`, `M3LBedrockToolContext`), and the per-execution/
 * per-iteration ledger types (`M3LBedrockToolExecution`,
 * `M3LBedrockToolLoopIteration`, `M3LBedrockToolLoopOutcome`), plus
 * `M3LBedrockToolLoopError` for a ceiling breach. `invokeStream` stays
 * text-only; see the reference page's scope-boundary note.
 *
 * @packageDocumentation
 */

export { M3LBedrockRuntimeOperations } from "./client.js";
export {
  appendBedrockMessage,
  appendBedrockUserText,
  createBedrockConversation,
} from "./conversation.js";
export type { M3LBedrockConversation } from "./conversation.js";
export {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeNoModelError,
  M3LBedrockRuntimeOperationError,
  M3LBedrockRuntimeStreamError,
  M3LBedrockToolLoopError,
} from "./error.js";
export { runBedrockToolLoop } from "./loop.js";
export type {
  M3LBedrockModelRate,
  M3LBedrockToolContext,
  M3LBedrockToolExecution,
  M3LBedrockToolHandler,
  M3LBedrockToolLoopInvoker,
  M3LBedrockToolLoopIteration,
  M3LBedrockToolLoopOptions,
  M3LBedrockToolLoopOutcome,
  M3LBedrockToolRegistration,
  M3LBedrockToolRegistry,
} from "./loop.js";
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
  M3LBedrockStreamEvent,
  M3LBedrockStreamStartEvent,
  M3LBedrockStreamStopEvent,
  M3LBedrockStreamTextDeltaEvent,
  M3LBedrockTextBlock,
  M3LBedrockTokenUsage,
  M3LBedrockToolChoice,
  M3LBedrockToolDefinition,
  M3LBedrockToolInputSchema,
  M3LBedrockToolInvokeRequest,
  M3LBedrockToolResultBlock,
  M3LBedrockToolResultContent,
  M3LBedrockToolResultJsonBlock,
  M3LBedrockToolResultStatus,
  M3LBedrockToolUseBlock,
} from "./types.js";
