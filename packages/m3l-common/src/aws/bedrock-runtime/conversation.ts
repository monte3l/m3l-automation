/**
 * `aws/bedrock-runtime/conversation` — the immutable conversation-state value
 * (`M3LBedrockConversation`) and the pure helpers that build/extend it, so a
 * caller driving `runBedrockToolLoop` (`loop.ts`) or repeated `invoke()` calls
 * never hand-assembles the `{ messages, system? }` shape or mutates a shared
 * `messages` array in place.
 *
 * There is no `with*` builder-method precedent anywhere in the repo (V5
 * Slice B contract §2.1) — every value here is a `readonly` interface plus
 * free functions, not a class with mutating or chaining methods.
 *
 * @packageDocumentation
 */

import type { M3LBedrockMessage } from "./types.js";

/**
 * Options for {@link createBedrockConversation}. Not exported — the contract
 * for this module names no `M3LBedrockConversationOptions` symbol, so this
 * stays an inline-equivalent local shape rather than a new public export.
 */
interface CreateBedrockConversationOptions {
  /** An optional system prompt, carried verbatim onto {@link M3LBedrockConversation.system}. */
  readonly system?: string;
  /** Initial messages, copied (never aliased) into the new conversation. */
  readonly messages?: readonly M3LBedrockMessage[];
}

/**
 * Immutable conversation state threaded through repeated
 * {@link M3LBedrockRuntimeOperations.invoke} calls or a
 * `runBedrockToolLoop` run: an ordered list of messages plus an optional
 * system prompt.
 *
 * `system` is **omitted** (not present as an own key) when no system prompt
 * was supplied — `exactOptionalPropertyTypes` makes `{ system: undefined }`
 * a distinct, observable shape from an absent key, and every helper in this
 * module preserves that distinction rather than ever writing `undefined`.
 *
 * @example
 * ```ts
 * import type { M3LBedrockConversation } from "@m3l-automation/m3l-common/aws";
 *
 * const conversation: M3LBedrockConversation = {
 *   messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
 * };
 * ```
 */
export interface M3LBedrockConversation {
  /** The conversation's messages, in order. */
  readonly messages: readonly M3LBedrockMessage[];
  /** An optional system prompt; omitted (not `undefined`) when none was supplied. */
  readonly system?: string;
}

/**
 * Creates a fresh {@link M3LBedrockConversation}.
 *
 * Always returns a new `messages` array (never aliasing `options.messages`),
 * so a caller mutating the array they passed in afterward cannot retroactively
 * change the returned conversation. `system` is omitted entirely when
 * `options.system` is absent — never written as `system: undefined`.
 *
 * @param options - Optional initial `system` prompt and/or `messages`. Both
 *   default to empty/absent when omitted.
 * @returns A new, independent `M3LBedrockConversation` value.
 * @example
 * ```ts
 * import { createBedrockConversation } from "@m3l-automation/m3l-common/aws";
 *
 * const conversation = createBedrockConversation({ system: "be terse" });
 * ```
 */
export function createBedrockConversation(
  options?: CreateBedrockConversationOptions,
): M3LBedrockConversation {
  return {
    messages: options?.messages !== undefined ? [...options.messages] : [],
    ...(options?.system !== undefined && { system: options.system }),
  };
}

/**
 * Returns a NEW conversation with `message` appended after every existing
 * message, preserving order. Never mutates `conversation` or its `messages`
 * array; the returned value's `messages` is always a fresh array.
 *
 * @param conversation - The conversation to extend. Left unmodified.
 * @param message - The message to append.
 * @returns A new `M3LBedrockConversation` with `message` appended.
 * @example
 * ```ts
 * import { appendBedrockMessage } from "@m3l-automation/m3l-common/aws";
 * import type { M3LBedrockConversation } from "@m3l-automation/m3l-common/aws";
 *
 * declare const conversation: M3LBedrockConversation;
 * const updated = appendBedrockMessage(conversation, {
 *   role: "assistant",
 *   content: [{ type: "text", text: "hello" }],
 * });
 * ```
 */
export function appendBedrockMessage(
  conversation: M3LBedrockConversation,
  message: M3LBedrockMessage,
): M3LBedrockConversation {
  return {
    messages: [...conversation.messages, message],
    ...(conversation.system !== undefined && { system: conversation.system }),
  };
}

/**
 * Convenience over {@link appendBedrockMessage} for the common case of
 * appending a user turn carrying a single plain-text block.
 *
 * @param conversation - The conversation to extend. Left unmodified.
 * @param text - The user turn's text.
 * @returns A new `M3LBedrockConversation` with a
 *   `{ role: "user", content: [{ type: "text", text }] }` message appended.
 * @example
 * ```ts
 * import { appendBedrockUserText } from "@m3l-automation/m3l-common/aws";
 * import type { M3LBedrockConversation } from "@m3l-automation/m3l-common/aws";
 *
 * declare const conversation: M3LBedrockConversation;
 * const updated = appendBedrockUserText(conversation, "hello there");
 * ```
 */
export function appendBedrockUserText(
  conversation: M3LBedrockConversation,
  text: string,
): M3LBedrockConversation {
  return appendBedrockMessage(conversation, {
    role: "user",
    content: [{ type: "text", text }],
  });
}
