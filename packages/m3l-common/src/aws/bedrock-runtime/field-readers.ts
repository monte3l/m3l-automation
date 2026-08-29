/**
 * `aws/bedrock-runtime/field-readers` -- reader primitives: turn one
 * untrusted `request`-shaped field into one guarded, module-owned value
 * (`request.messages`/`.system`/`.inferenceConfig`, one message's `content`,
 * one content block). `request-builder.ts` (leaf importer of this module)
 * holds the exhaustive field TABLE that assembles a whole `ConverseInput`
 * from these readers -- see that module's doc comment for the
 * compile-error-on-missing-reader mechanism. Split out of that module
 * (25,956 / 25,000 bytes -- no room left for both concerns in one file) so
 * each file has a single job: this one reads, that one assembles.
 *
 * **`textOnly` (2026-08-29 security pass round 5, replacing
 * `stream-guard.ts`):** every reader here optionally takes a `textOnly`
 * flag -- `invokeStream`'s text-only/no-tools scope used to be enforced by
 * a second, parallel request-construction path that ran before these
 * readers, inheriting none of their guards. `textOnly` makes that scope a
 * mode of these SAME readers instead: `request-builder.ts`'s
 * `buildRequestFields` calls {@link assertNoToolsForStreaming} first, then
 * threads `textOnly` into {@link readMessages}, so streaming is governed by
 * the exact same reads/budget/rebuild as `invoke`'s ordinary build.
 *
 * Never imports `request-builder.ts` (`import-x/no-cycle`,
 * `maxDepth: Infinity`, is a hard repo-wide gate) -- `request-builder.ts`
 * imports from here, never the reverse. Internal module -- nothing here is
 * re-exported through `aws/bedrock-runtime/index`.
 *
 * @packageDocumentation
 */

import {
  chargeElementBudget,
  copyDocument,
  isPlainObject,
  readCallerElement,
  readCallerString,
  readCallerValue,
  requireCallerArray,
} from "./document.js";
import type {
  DocumentCopyBudget,
  M3LBedrockPlainDocument,
} from "./document.js";
import { M3LBedrockRuntimeOperationError } from "./error.js";
import { sanitizeForMessage } from "./message-safety.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockRuntimeRole,
  M3LBedrockTextBlock,
  M3LBedrockToolResultBlock,
  M3LBedrockToolResultContent,
  M3LBedrockToolResultJsonBlock,
  M3LBedrockToolUseBlock,
} from "./types.js";

export type SdkContentItem =
  | { readonly text: string }
  | {
      readonly toolUse: {
        readonly toolUseId: string;
        readonly name: string;
        // `| undefined`, never optional (`?:`) -- mirrors the SDK's own
        // `ToolUseBlock.input` field exactly (a REQUIRED property whose
        // value can be `undefined`; under this repo's
        // `exactOptionalPropertyTypes`, an optional `input?:` field is NOT
        // structurally assignable to that required field). The value is
        // `undefined` exactly when `block.input` is `undefined` (a
        // no-argument tool call replayed as history) -- never derived by
        // calling `copyDocument` on `undefined`, which throws.
        readonly input: M3LBedrockPlainDocument | undefined;
      };
    }
  | {
      readonly toolResult: {
        readonly toolUseId: string;
        // NOT `readonly (...)[]` -- the SDK's `ToolResultBlock.content`
        // field is a plain mutable array; this literal is what
        // `client.ts`/`stream.ts` hand straight to `new ConverseCommand(...)`.
        readonly content: (
          { readonly text: string } | { readonly json: M3LBedrockPlainDocument }
        )[];
        readonly status?: "success" | "error";
      };
    };

/**
 * Formats an already-read discriminant value for a diagnosable-but-safe
 * error message, once an exhaustive `switch`'s `default` arm has determined
 * `value` doesn't match any recognized member. `value` is the SAME read
 * this module's callers already performed (once, guarded) -- never re-read
 * here -- and only a string value is rendered, through
 * {@link sanitizeForMessage} (length-capped, control-character-escaped).
 */
function formatDiscriminant(value: unknown): string {
  return typeof value === "string" ? sanitizeForMessage(value) : "unknown";
}

/**
 * The `textOnly` policy's refusal message -- shared so the
 * top-level `tools`/`toolChoice` check ({@link assertNoToolsForStreaming})
 * and the per-block non-text check ({@link mapContentBlockToSdk}) throw
 * byte-identical text. Carried over verbatim from the deleted
 * `stream-guard.ts`'s `UNSUPPORTED_STREAMING_MESSAGE`.
 */
const UNSUPPORTED_STREAMING_MESSAGE =
  "invokeStream does not support tools/toolChoice or non-text message content blocks — streaming tool-use is out of scope for V5; use invoke() instead";

/**
 * `textOnly`'s top-level guard: refuses a `request` carrying an own
 * `tools`/`toolChoice` property, before any field is read. `Object.hasOwn`
 * -gated -- own properties only, deliberately -- since this detects a
 * downcast past the narrower V4 `M3LBedrockInvokeRequest` type (a literal
 * carrying either field is already an excess-property compile error; only a
 * structurally-typed non-literal reaches this runtime check).
 *
 * @throws {@link M3LBedrockRuntimeOperationError} (`origin: caller`,
 *   `retryable: false`) with {@link UNSUPPORTED_STREAMING_MESSAGE} when
 *   `request` carries an own `tools` or `toolChoice` property.
 */
export function assertNoToolsForStreaming(
  request: M3LBedrockInvokeRequest,
): void {
  if (Object.hasOwn(request, "tools") || Object.hasOwn(request, "toolChoice")) {
    throw new M3LBedrockRuntimeOperationError(UNSUPPORTED_STREAMING_MESSAGE, {
      origin: "caller",
      retryable: false,
    });
  }
}

/**
 * {@link requireCallerArray}, additionally rewording a shape failure to match
 * the wording the deleted `stream-guard.ts` produced for the same fault --
 * only reached when `textOnly` is set, so `invoke()`'s own
 * `request.messages`/`a message's content` wording is unaffected.
 */
function requireStreamShapedArray<T>(
  value: unknown,
  fieldLabel: string,
): readonly T[] {
  try {
    return requireCallerArray<T>(value, fieldLabel);
  } catch (cause) {
    throw new M3LBedrockRuntimeOperationError(
      "invokeStream could not read request.messages/content",
      { origin: "caller", retryable: false, cause },
    );
  }
}

/**
 * Maps one {@link M3LBedrockToolResultContent} member to the SDK's
 * `ToolResultContentBlock` shape, recursively copying a `json` payload.
 *
 * `item.type` is read exactly once, inside the `try`/`catch` below, into
 * `discriminant` -- a bare `switch (item.type)` would read `.type`
 * unprotected, letting a throwing getter escape as a raw `Error` before this
 * function's own `default` arm is ever reached.
 */
function mapToolResultContentItem(
  item: M3LBedrockToolResultContent,
  budget: DocumentCopyBudget,
): { readonly text: string } | { readonly json: M3LBedrockPlainDocument } {
  let discriminant: M3LBedrockToolResultContent["type"];
  try {
    discriminant = item.type;
  } catch (cause) {
    throw new M3LBedrockRuntimeOperationError(
      "unhandled tool-result content type: reading the discriminant raised an unexpected error",
      { origin: "caller", retryable: false, cause },
    );
  }
  switch (discriminant) {
    case "text":
      return {
        text: readCallerString(
          () => (item as M3LBedrockTextBlock).text,
          "a toolResult content item's text",
        ),
      };
    case "json": {
      const json = readCallerValue(
        () => (item as M3LBedrockToolResultJsonBlock).json,
        "a toolResult content item's json",
      );
      return { json: copyDocument(json, 0, budget) };
    }
    default: {
      const exhaustive: never = discriminant;
      throw new M3LBedrockRuntimeOperationError(
        `unhandled tool-result content type: ${formatDiscriminant(exhaustive)}`,
        { origin: "caller", retryable: false },
      );
    }
  }
}

/** {@link mapContentBlockToSdk}'s `toolUse` arm. See {@link SdkContentItem}'s doc comment for the `input: undefined` note. */
function mapToolUseBlockToSdk(
  block: M3LBedrockToolUseBlock,
  budget: DocumentCopyBudget,
): SdkContentItem {
  const toolUseId = readCallerString(
    () => block.toolUseId,
    "a toolUse block's toolUseId",
  );
  const name = readCallerString(() => block.name, "a toolUse block's name");
  const input = readCallerValue(() => block.input, "a toolUse block's input");
  return {
    toolUse: {
      toolUseId,
      name,
      input: input === undefined ? undefined : copyDocument(input, 0, budget),
    },
  };
}

/** {@link mapContentBlockToSdk}'s `toolResult` arm, split out to keep the parent function's line/complexity count under the repo's lint ceiling. Element reads are guarded ({@link readCallerElement}) and budget-charged ({@link chargeElementBudget}) -- M6/Should-fix #3. */
function mapToolResultBlockToSdk(
  block: M3LBedrockToolResultBlock,
  budget: DocumentCopyBudget,
): SdkContentItem {
  const toolUseId = readCallerString(
    () => block.toolUseId,
    "a toolResult block's toolUseId",
  );
  const rawContent = readCallerValue(
    () => block.content,
    "a toolResult block's content",
  );
  const content = requireCallerArray<M3LBedrockToolResultContent>(
    rawContent,
    "a toolResult block's content",
  );
  const contentCount = content.length;
  const mappedContent: (
    { readonly text: string } | { readonly json: M3LBedrockPlainDocument }
  )[] = [];
  for (let index = 0; index < contentCount; index += 1) {
    chargeElementBudget(budget, "a toolResult block's content");
    const item = readCallerElement(
      content,
      index,
      "a toolResult block's content item",
    );
    mappedContent.push(mapToolResultContentItem(item, budget));
  }
  const status = readCallerValue(
    () => block.status,
    "a toolResult block's status",
  );
  if (status !== undefined && status !== "success" && status !== "error") {
    throw new M3LBedrockRuntimeOperationError(
      `a toolResult block's status must be "success" or "error"`,
      { origin: "caller", retryable: false },
    );
  }
  return {
    toolResult: {
      toolUseId,
      content: mappedContent,
      ...(status !== undefined && { status }),
    },
  };
}

/**
 * Maps one {@link M3LBedrockContentBlock} to the SDK's wire shape --
 * `block.type` is read EXACTLY ONCE, into `discriminant`, and every
 * decision (the `textOnly` non-text refusal below, and the ordinary
 * `switch`) is made off that single read. `textOnly` set (only ever from
 * `request-builder.ts`'s `buildRequestFields`, in its `invokeStream` mode) refuses anything but a
 * `"text"` block with {@link UNSUPPORTED_STREAMING_MESSAGE} -- including an
 * unreadable discriminant, treated the same as a non-`"text"` one, since an
 * unreadable `.type` cannot license "this block is text" (mirrors the
 * deleted `stream-guard.ts`'s `isTextTypeBlock`, but without that module's
 * separate, second read of `.type` -- reading once here and branching on
 * that one value is what closes the flip-flop a two-read guard-then-rebuild
 * shape invites).
 */
function mapContentBlockToSdk(
  block: M3LBedrockContentBlock,
  budget: DocumentCopyBudget,
  textOnly: boolean,
): SdkContentItem {
  let discriminant: M3LBedrockContentBlock["type"];
  try {
    discriminant = block.type;
  } catch (cause) {
    if (textOnly) {
      throw new M3LBedrockRuntimeOperationError(UNSUPPORTED_STREAMING_MESSAGE, {
        origin: "caller",
        retryable: false,
        cause,
      });
    }
    throw new M3LBedrockRuntimeOperationError(
      "unhandled content block type: reading the discriminant raised an unexpected error",
      { origin: "caller", retryable: false, cause },
    );
  }
  if (textOnly && discriminant !== "text") {
    throw new M3LBedrockRuntimeOperationError(UNSUPPORTED_STREAMING_MESSAGE, {
      origin: "caller",
      retryable: false,
    });
  }
  switch (discriminant) {
    case "text":
      return {
        text: readCallerString(
          () => (block as M3LBedrockTextBlock).text,
          "a content block's text",
        ),
      };
    case "toolUse":
      return mapToolUseBlockToSdk(block as M3LBedrockToolUseBlock, budget);
    case "toolResult":
      return mapToolResultBlockToSdk(
        block as M3LBedrockToolResultBlock,
        budget,
      );
    default: {
      const exhaustive: never = discriminant;
      throw new M3LBedrockRuntimeOperationError(
        `unhandled content block type: ${formatDiscriminant(exhaustive)}`,
        { origin: "caller", retryable: false },
      );
    }
  }
}

/**
 * Converts a {@link M3LBedrockMessage} into the shape
 * `ConverseCommandInput.messages` expects -- `role`/`content` are guarded,
 * validated reads; `content` is walked with an index loop over
 * {@link readCallerElement}, never `.map()`.
 */
function toSdkMessage(
  message: M3LBedrockMessage,
  budget: DocumentCopyBudget,
  textOnly: boolean,
): { role: M3LBedrockRuntimeRole; content: SdkContentItem[] } {
  const role = readCallerString(() => message.role, "a message's role");
  if (role !== "user" && role !== "assistant") {
    throw new M3LBedrockRuntimeOperationError(
      `a message's role must be "user" or "assistant"`,
      { origin: "caller", retryable: false },
    );
  }
  const rawContent = readCallerValue(
    () => message.content,
    "a message's content",
  );
  const content = textOnly
    ? requireStreamShapedArray<M3LBedrockContentBlock>(
        rawContent,
        "a message's content",
      )
    : requireCallerArray<M3LBedrockContentBlock>(
        rawContent,
        "a message's content",
      );
  const contentCount = content.length;
  const mapped: SdkContentItem[] = [];
  for (let index = 0; index < contentCount; index += 1) {
    chargeElementBudget(budget, "a message's content");
    const block = readCallerElement(content, index, "a content block");
    mapped.push(mapContentBlockToSdk(block, budget, textOnly));
  }
  return { role, content: mapped };
}

/**
 * Maps `inferenceConfig.stopSequences` into a fresh mutable `string[]`,
 * `undefined` when `raw` is -- never `[...raw]` (a spread invokes the
 * value's own iterator, the same bypass class as `.map()`), and validates
 * each entry is a `string`. `raw` is `unknown` (read off an already-guarded
 * `inferenceConfig` object by {@link readInferenceConfig}), not statically
 * typed `readonly string[] | undefined`, since `inferenceConfig` itself is
 * caller data with no guaranteed shape (M2).
 */
function mapStopSequences(
  raw: unknown,
  budget: DocumentCopyBudget,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = requireCallerArray<unknown>(
    raw,
    "inferenceConfig.stopSequences",
  );
  const count = list.length;
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    chargeElementBudget(budget, "inferenceConfig.stopSequences");
    result.push(
      readCallerString(
        () => readCallerElement(list, index, "a stopSequences entry"),
        "a stopSequences entry",
      ),
    );
  }
  return result;
}

/**
 * Reads `request.system`, guarded and string-typed (M1, 2026-08-29 security
 * pass round 5) -- previously an unguarded, unvalidated
 * `[{ text: request.system }]` let
 * `{"system":[{"text":{"INJECTED":"sk-live-SECRET"}}]}` reach the wire
 * verbatim (any value, not just a string) and let a throwing getter escape
 * as a raw `TypeError`. `undefined` maps to `undefined` (system omitted
 * entirely); any other non-`string` value is a typed caller error.
 */
export function readSystem(
  request: M3LBedrockInvokeRequest,
): { text: string }[] | undefined {
  const raw = readCallerValue(() => request.system, "request.system");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new M3LBedrockRuntimeOperationError(
      "request.system must be a string",
      { origin: "caller", retryable: false },
    );
  }
  return [{ text: raw }];
}

/** {@link readInferenceConfig}'s `maxTokens` narrow: an integer of at least 1, or `undefined` when absent (M2). */
function readOptionalPositiveInteger(
  read: () => unknown,
  fieldLabel: string,
): number | undefined {
  const raw = readCallerValue(read, fieldLabel);
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new M3LBedrockRuntimeOperationError(
      `${fieldLabel} must be an integer >= 1`,
      { origin: "caller", retryable: false },
    );
  }
  return raw;
}

/** {@link readInferenceConfig}'s `temperature`/`topP` narrow: a finite number, or `undefined` when absent (M2). */
function readOptionalFiniteNumber(
  read: () => unknown,
  fieldLabel: string,
): number | undefined {
  const raw = readCallerValue(read, fieldLabel);
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new M3LBedrockRuntimeOperationError(
      `${fieldLabel} must be a finite number`,
      { origin: "caller", retryable: false },
    );
  }
  return raw;
}

/** `ConverseInput.inferenceConfig`'s shape -- all four fields optional, mirroring the SDK's own `InferenceConfiguration`. */
export interface SdkInferenceConfig {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: string[];
}

/**
 * Reads and narrows `request.inferenceConfig` (M2, 2026-08-29 security pass
 * round 5) -- previously all four sub-fields were forwarded completely
 * unguarded/unvalidated, letting
 * `{"maxTokens":{"LEAK":"AKIA..."},"temperature":["t","e"]}` reach the wire
 * verbatim and letting a throwing getter on any sub-field escape as a raw
 * `TypeError`/`RangeError`. `maxTokens` must be an integer of at least 1;
 * `temperature`/`topP` must be finite numbers; `stopSequences` must be an
 * array of strings (see {@link mapStopSequences}). `undefined` when
 * `request.inferenceConfig` itself is; a non-object `inferenceConfig` is a
 * typed caller error rather than silently treated as empty.
 */
export function readInferenceConfig(
  request: M3LBedrockInvokeRequest,
  budget: DocumentCopyBudget,
): SdkInferenceConfig | undefined {
  const raw = readCallerValue(
    () => request.inferenceConfig,
    "request.inferenceConfig",
  );
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new M3LBedrockRuntimeOperationError(
      "request.inferenceConfig must be an object",
      { origin: "caller", retryable: false },
    );
  }
  const maxTokens = readOptionalPositiveInteger(
    () => raw["maxTokens"],
    "inferenceConfig.maxTokens",
  );
  const temperature = readOptionalFiniteNumber(
    () => raw["temperature"],
    "inferenceConfig.temperature",
  );
  const topP = readOptionalFiniteNumber(
    () => raw["topP"],
    "inferenceConfig.topP",
  );
  const rawStopSequences = readCallerValue(
    () => raw["stopSequences"],
    "inferenceConfig.stopSequences",
  );
  const stopSequences = mapStopSequences(rawStopSequences, budget);
  return {
    ...(maxTokens !== undefined && { maxTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { topP }),
    ...(stopSequences !== undefined && { stopSequences }),
  };
}

/**
 * Reads `request.messages` into the SDK's mapped shape -- guarded array
 * read, guarded/budget-charged element reads (M6/Should-fix #3).
 */
export function readMessages(
  request: M3LBedrockInvokeRequest,
  budget: DocumentCopyBudget,
  textOnly: boolean,
): { role: M3LBedrockRuntimeRole; content: SdkContentItem[] }[] {
  const rawMessages = readCallerValue(
    () => request.messages,
    "request.messages",
  );
  const messages = textOnly
    ? requireStreamShapedArray<M3LBedrockMessage>(
        rawMessages,
        "request.messages",
      )
    : requireCallerArray<M3LBedrockMessage>(rawMessages, "request.messages");
  const messageCount = messages.length;
  const mapped: { role: M3LBedrockRuntimeRole; content: SdkContentItem[] }[] =
    [];
  for (let index = 0; index < messageCount; index += 1) {
    chargeElementBudget(budget, "request.messages");
    const message = readCallerElement(messages, index, "a message");
    mapped.push(toSdkMessage(message, budget, textOnly));
  }
  return mapped;
}
