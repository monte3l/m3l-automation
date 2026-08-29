/**
 * `aws/bedrock-runtime/stream-guard` -- {@link buildStreamSafeRequest}, the
 * `invokeStream`-only structural guard closing the M7 finding (2026-08-29
 * security pass round 5): `client.ts`'s `invokeStream()` calls this BEFORE
 * ever delegating into `stream.ts` (frozen). Split out of `client.ts`
 * (which would otherwise exceed the 25,000-byte per-file ceiling, ADR-0072)
 * as its own leaf module -- this is a self-contained concern ("is this
 * request safe for the text-only streaming path, and if so, what is the
 * SANITIZED version of it") independent of `client.ts`'s `invoke()`
 * request/response mapping.
 *
 * **Why a rebuild, not a boolean check:** the pre-fix guard
 * (`hasUnsupportedStreamingContent`) read `block.type` once to DECIDE
 * whether to refuse, then discarded that reading and let `stream.ts`
 * independently re-read `block.type`/`block.text` a second time while
 * building the actual `ConverseStreamCommand` -- so a `type` getter that
 * answered `"text"` on the first read and `"toolUse"` on the second put a
 * tool-use block on the wire despite the guard already having approved the
 * request (a validate-then-re-read seam). {@link buildStreamSafeRequest}
 * closes this structurally: it builds a FRESH, module-owned
 * `M3LBedrockInvokeRequest` from its own single, guarded read pass, and
 * `client.ts` threads THAT (never the caller's live object) into
 * `stream.ts`'s `invokeStream`. `stream.ts`'s own, independent re-read of
 * `messages`/`content` (once per fallback model attempt, frozen) then
 * operates on plain data with no getters left to diverge.
 *
 * Never imports `client.ts`/`stream.ts` (`import-x/no-cycle`, `maxDepth: Infinity`,
 * is a hard repo-wide gate) -- `client.ts` imports from here, never the
 * reverse. Internal module -- nothing here is re-exported through
 * `aws/bedrock-runtime/index`.
 *
 * @packageDocumentation
 */

import { readCallerString, readCallerValueOrElse } from "./document.js";
import { M3LBedrockRuntimeOperationError } from "./error.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
} from "./types.js";

/**
 * {@link buildStreamSafeRequest}'s refusal message -- shared so both the
 * top-level `tools`/`toolChoice` check and the per-block non-text check
 * throw byte-identical text.
 */
const UNSUPPORTED_STREAMING_MESSAGE =
  "invokeStream does not support tools/toolChoice or non-text message content blocks — streaming tool-use is out of scope for V5; use invoke() instead";

/**
 * Reads `block.type` guarded, treating an unreadable discriminant the same
 * as a non-`"text"` one (an unreadable `.type` cannot license "this block is
 * text", so the safe default is "not text" -- refuse streaming with a typed
 * error rather than let a raw exception escape `invokeStream`).
 */
function isTextTypeBlock(block: M3LBedrockContentBlock): boolean {
  return readCallerValueOrElse(() => block.type === "text", false);
}

/**
 * Reads and validates one message's `content` array into fresh,
 * module-owned {@link M3LBedrockContentBlock} literals -- every block's
 * `type`/`text` is read EXACTLY ONCE here (M7). See this module's doc
 * comment for why this rebuild, not a boolean check, is the fix.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} With
 *   {@link UNSUPPORTED_STREAMING_MESSAGE} when any block's discriminant is
 *   unreadable or not `"text"`. A plain `TypeError` when `rawContent` is not
 *   a real array -- caught by {@link buildStreamSafeRequest}'s enclosing
 *   `try`/`catch` and re-wrapped there, never surfaced raw.
 */
function sanitizeStreamContent(rawContent: unknown): M3LBedrockContentBlock[] {
  if (!Array.isArray(rawContent)) {
    throw new TypeError("message content is not an array");
  }
  const count = rawContent.length;
  const sanitized: M3LBedrockContentBlock[] = [];
  for (let index = 0; index < count; index += 1) {
    const block = rawContent[index] as M3LBedrockContentBlock;
    if (!isTextTypeBlock(block)) {
      throw new M3LBedrockRuntimeOperationError(UNSUPPORTED_STREAMING_MESSAGE, {
        origin: "caller",
        retryable: false,
      });
    }
    sanitized.push({
      type: "text",
      text: readCallerString(
        () => (block as { readonly text: unknown }).text,
        "a message content block's text",
      ),
    });
  }
  return sanitized;
}

/**
 * Reads and validates `request.messages` into fresh, module-owned
 * {@link M3LBedrockMessage} literals via {@link sanitizeStreamContent}.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} See
 *   {@link sanitizeStreamContent}. A plain `TypeError` when `rawMessages` is
 *   not a real array or an element is not object-shaped -- caught by
 *   {@link buildStreamSafeRequest}'s enclosing `try`/`catch`.
 */
function sanitizeStreamMessages(rawMessages: unknown): M3LBedrockMessage[] {
  if (!Array.isArray(rawMessages)) {
    throw new TypeError("request.messages is not an array");
  }
  const count = rawMessages.length;
  const sanitized: M3LBedrockMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const message = rawMessages[index] as {
      readonly role?: unknown;
      readonly content?: unknown;
    };
    sanitized.push({
      role: message.role as M3LBedrockInvokeRequest["messages"][number]["role"],
      content: sanitizeStreamContent(message.content),
    });
  }
  return sanitized;
}

/**
 * Validates `request` against `invokeStream`'s text-only scope and returns a
 * FRESH, module-owned `M3LBedrockInvokeRequest` built from that validation
 * pass -- never the caller's original object (M7; see this module's doc
 * comment for the exploit this closes).
 *
 * The `tools`/`toolChoice` check stays a structural, `Object.hasOwn`-gated
 * probe on `request` itself (S4: OWN properties only, deliberately -- this
 * is detecting a downcast past the narrower V4 request type, not asking
 * "does this field exist" in the general sense `tools.ts`'s
 * `buildToolConfig` does for `invoke()`'s `request.tools`/`toolChoice`; see
 * that function's doc comment for the contrasting, intentional choice
 * there). It is load-bearing, not decorative: a compile probe confirmed
 * that TypeScript's structural typing rejects a tool-bearing **object
 * literal** passed directly to `invokeStream` (an excess-property error --
 * see the dedicated `@ts-expect-error` test), but still **admits** a
 * structurally-typed non-literal `M3LBedrockToolInvokeRequest` value
 * assigned through a variable or a downcast, since structural width
 * subtyping only rejects excess properties on literals.
 *
 * `request.system`/`request.inferenceConfig` are passed through by
 * reference, not rebuilt -- `field-readers.ts`'s `readSystem`/
 * `readInferenceConfig` already guard and narrow both fields on every
 * `buildConverseInput` call `stream.ts` makes; only the content-block
 * discriminant read demonstrated the flip-flop this function closes.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} (`origin: caller`,
 *   `retryable: false`) with {@link UNSUPPORTED_STREAMING_MESSAGE} when
 *   `request` carries an own `tools`/`toolChoice` property or any
 *   `messages[].content` block is not `type: "text"`; with "invokeStream
 *   could not read request.messages/content" when `messages`/`content`
 *   is not real-array-shaped or reading it raises any other error.
 */
export function buildStreamSafeRequest(
  request: M3LBedrockInvokeRequest,
): M3LBedrockInvokeRequest {
  if (Object.hasOwn(request, "tools") || Object.hasOwn(request, "toolChoice")) {
    throw new M3LBedrockRuntimeOperationError(UNSUPPORTED_STREAMING_MESSAGE, {
      origin: "caller",
      retryable: false,
    });
  }

  let sanitizedMessages: M3LBedrockMessage[];
  try {
    sanitizedMessages = sanitizeStreamMessages(request.messages);
  } catch (cause) {
    if (cause instanceof M3LBedrockRuntimeOperationError) throw cause;
    throw new M3LBedrockRuntimeOperationError(
      "invokeStream could not read request.messages/content",
      { origin: "caller", retryable: false, cause },
    );
  }

  return {
    messages: sanitizedMessages,
    ...(request.system !== undefined && { system: request.system }),
    ...(request.inferenceConfig !== undefined && {
      inferenceConfig: request.inferenceConfig,
    }),
  };
}
