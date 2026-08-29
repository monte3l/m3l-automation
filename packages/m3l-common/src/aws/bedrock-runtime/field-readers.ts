/**
 * `aws/bedrock-runtime/field-readers` -- the exhaustive Converse-request
 * field table: every field this module ever hands to the SDK's
 * `ConverseCommand`/`ConverseStreamCommand` constructor input is produced by
 * exactly one entry in {@link FIELDS}, keyed by {@link WireField} (=
 * `keyof ConverseInput`). Adding a field to {@link ConverseInput} without
 * adding a matching reader to {@link FIELDS} is a compile error -- `FIELDS`
 * is declared `as const satisfies Record<WireField, ...>`, so TypeScript's
 * `satisfies` operator raises a missing-property error the moment
 * `WireField` widens and `FIELDS` does not (2026-08-29 security pass round
 * 5, closing the class of bug where a field reached the wire unguarded
 * because nothing forced every field to go through a reader at all).
 *
 * Split out of `shared.ts` (24,884 / 25,000 bytes -- no room left) as its
 * own leaf module: this is where `request.messages`/`request.system`/
 * `request.inferenceConfig` are read, validated, and rebuilt into the SDK's
 * `ConverseCommandInput`/`ConverseStreamCommandInput` shape. `shared.ts`
 * keeps only what's genuinely shared beyond request construction (retry
 * runner, abort helpers, stop-reason membership, `classifySendFailure`) and
 * re-exports {@link buildConverseInput} unchanged, so `stream.ts` (frozen)
 * and `client.ts` -- both of which import `buildConverseInput` from
 * `shared.js` -- keep working without modification.
 *
 * Internal module -- nothing here is re-exported through
 * `aws/bedrock-runtime/index`.
 *
 * @packageDocumentation
 */

import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";

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

/**
 * The shape one mapped {@link M3LBedrockContentBlock} takes in
 * `ConverseCommandInput.messages[].content` -- a 3-arm union mirroring the
 * SDK's `ContentBlock`'s `text`/`toolUse`/`toolResult` members exactly (see
 * `types.ts`'s "Why the tool discriminants are camelCase" note). Declared
 * locally, rather than importing the SDK's own `ContentBlock`, so this
 * module states exactly the subset it produces.
 */
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

function mapContentBlockToSdk(
  block: M3LBedrockContentBlock,
  budget: DocumentCopyBudget,
): SdkContentItem {
  let discriminant: M3LBedrockContentBlock["type"];
  try {
    discriminant = block.type;
  } catch (cause) {
    throw new M3LBedrockRuntimeOperationError(
      "unhandled content block type: reading the discriminant raised an unexpected error",
      { origin: "caller", retryable: false, cause },
    );
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
  const content = requireCallerArray<M3LBedrockContentBlock>(
    rawContent,
    "a message's content",
  );
  const contentCount = content.length;
  const mapped: SdkContentItem[] = [];
  for (let index = 0; index < contentCount; index += 1) {
    chargeElementBudget(budget, "a message's content");
    const block = readCallerElement(content, index, "a content block");
    mapped.push(mapContentBlockToSdk(block, budget));
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
function readSystem(
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

/** {@link ConverseInput.inferenceConfig}'s shape -- all four fields optional, mirroring the SDK's own `InferenceConfiguration`. */
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
function readInferenceConfig(
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
function readMessages(
  request: M3LBedrockInvokeRequest,
  budget: DocumentCopyBudget,
): { role: M3LBedrockRuntimeRole; content: SdkContentItem[] }[] {
  const rawMessages = readCallerValue(
    () => request.messages,
    "request.messages",
  );
  const messages = requireCallerArray<M3LBedrockMessage>(
    rawMessages,
    "request.messages",
  );
  const messageCount = messages.length;
  const mapped: { role: M3LBedrockRuntimeRole; content: SdkContentItem[] }[] =
    [];
  for (let index = 0; index < messageCount; index += 1) {
    chargeElementBudget(budget, "request.messages");
    const message = readCallerElement(messages, index, "a message");
    mapped.push(toSdkMessage(message, budget));
  }
  return mapped;
}

/**
 * Shape shared by `ConverseCommandInput` and `ConverseStreamCommandInput`
 * for this slice -- both request types are field-identical for the
 * `modelId`/`messages`/`system`/`inferenceConfig`/`toolConfig` surface this
 * wrapper exposes. `toolConfig` is only ever populated by `client.ts`'s
 * `invoke` -- `stream.ts` never supplies one.
 */
export interface ConverseInput {
  readonly modelId: string;
  readonly messages: {
    role: M3LBedrockRuntimeRole;
    content: SdkContentItem[];
  }[];
  readonly system?: { text: string }[];
  readonly inferenceConfig?: SdkInferenceConfig;
  readonly toolConfig?: ToolConfiguration;
}

/** Every field {@link ConverseInput} carries -- the exhaustive wire-field vocabulary {@link FIELDS} is checked against. */
export type WireField = keyof ConverseInput;

/** The inputs every {@link FIELDS} reader needs; threaded through unchanged rather than closed over, so `FIELDS` stays a plain, inspectable table. */
export interface FieldReaderContext {
  readonly modelId: string;
  readonly request: M3LBedrockInvokeRequest;
  readonly toolConfig: ToolConfiguration | undefined;
  readonly budget: DocumentCopyBudget;
}

/**
 * One reader per {@link WireField}, mapped over `ConverseInput` itself so
 * each reader's return type matches its own field exactly (`modelId`'s
 * reader returns a `string`, `system`'s returns an optional array of `text`
 * objects) -- a plain `Record` from `WireField` to a single, shared function
 * type would type-check a reader returning the WRONG field's shape; this
 * mapped type does not.
 */
type FieldReaders = {
  readonly [K in WireField]: (ctx: FieldReaderContext) => ConverseInput[K];
};

/**
 * THE exhaustive Converse-request field table (2026-08-29 security pass
 * round 5, the maintainer-approved structural fix closing four rounds of
 * per-field/per-arm patching): every field {@link buildRequestFields} hands
 * to the SDK is produced by exactly one entry here, keyed by
 * {@link WireField}.
 *
 * **How a missing reader becomes a compile error:** `FIELDS` is declared
 * `as const satisfies Record<WireField, ...>` (via the {@link FieldReaders}
 * mapped type above) rather than merely typed `FieldReaders`. If
 * {@link ConverseInput} ever gains a new field -- say
 * `additionalModelRequestFields` -- `WireField` (`keyof ConverseInput`)
 * widens automatically, `FieldReaders`'s mapped type then requires a
 * matching key, and the `satisfies` check on the object literal below fails
 * to compile ("Property 'additionalModelRequestFields' is missing") the
 * moment that field is added -- BEFORE anyone writes the reader, not after
 * a review finds the gap. This is the mechanism that makes "every wire
 * field has a reader" a property `pnpm typecheck` enforces, not a
 * convention this module's authors have to remember.
 */
const FIELDS = {
  modelId: (ctx) => ctx.modelId,
  messages: (ctx) => readMessages(ctx.request, ctx.budget),
  system: (ctx) => readSystem(ctx.request),
  inferenceConfig: (ctx) => readInferenceConfig(ctx.request, ctx.budget),
  toolConfig: (ctx) => ctx.toolConfig,
} as const satisfies FieldReaders;

/**
 * Assembles a {@link ConverseInput} by invoking every {@link FIELDS} reader
 * exactly once -- the single place the SDK's request literal is
 * constructed. `system`/`inferenceConfig`/`toolConfig` are included only
 * when their reader returns non-`undefined` (a conditional spread, never a
 * key set to `undefined` -- `exactOptionalPropertyTypes`); `modelId`/
 * `messages` are always present.
 */
export function buildRequestFields(ctx: FieldReaderContext): ConverseInput {
  const modelId = FIELDS.modelId(ctx);
  const messages = FIELDS.messages(ctx);
  const system = FIELDS.system(ctx);
  const inferenceConfig = FIELDS.inferenceConfig(ctx);
  const toolConfig = FIELDS.toolConfig(ctx);
  return {
    modelId,
    messages,
    ...(system !== undefined && { system }),
    ...(inferenceConfig !== undefined && { inferenceConfig }),
    ...(toolConfig !== undefined && { toolConfig }),
  };
}
