/**
 * `aws/bedrock-runtime/request-builder` -- the exhaustive Converse-request
 * field TABLE ({@link FIELDS}) and its two entry points,
 * {@link buildRequestFields} and {@link buildConverseInput}: every field
 * this module ever hands to the SDK's `ConverseCommand`/
 * `ConverseStreamCommand` constructor input is produced by exactly one
 * entry in {@link FIELDS}, keyed by {@link WireField}
 * (= `keyof ConverseInput`). Adding a field to {@link ConverseInput}
 * without adding a matching reader to {@link FIELDS} is a compile error --
 * `FIELDS` is declared `as const satisfies FieldReaders` (itself a mapped type over
 * `WireField`), so TypeScript's `satisfies` operator raises a
 * missing-property error the moment `WireField` widens and `FIELDS` does
 * not (2026-08-29 security pass round 5, closing the class of bug where a
 * field reached the wire unguarded because nothing forced every field to
 * go through a reader at all).
 *
 * Delegates every actual field READ to `field-readers.ts`'s guarded reader
 * functions (`readMessages`/`readSystem`/`readInferenceConfig`/
 * `assertNoToolsForStreaming`) -- this module's own job is assembling a
 * WHOLE `ConverseInput` by iterating the table, never reading a
 * caller-supplied value directly itself. Split out of `field-readers.ts`
 * (25,956 / 25,000 bytes -- no room left for both concerns in one file).
 *
 * `client.ts` imports {@link buildConverseInput} from here directly (it
 * used to import it from `shared.ts`, which used to import
 * `buildRequestFields` from `field-readers.ts` -- both indirections
 * collapsed once the table got its own file). `stream.ts` imports the
 * {@link ConverseInput} type from here for its per-attempt `modelId` swap.
 *
 * Never imports `shared.ts` (`import-x/no-cycle`, `maxDepth: Infinity`, is
 * a hard repo-wide gate) -- `shared.ts` has no need to import from here
 * either, now that `buildConverseInput` lives here instead. Internal
 * module -- nothing here is re-exported through `aws/bedrock-runtime/index`.
 *
 * @packageDocumentation
 */

import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";

import { DocumentCopyBudget } from "./document.js";
import {
  assertNoToolsForStreaming,
  readInferenceConfig,
  readMessages,
  readSystem,
} from "./field-readers.js";
import type { SdkContentItem, SdkInferenceConfig } from "./field-readers.js";
import type {
  M3LBedrockInvokeRequest,
  M3LBedrockRuntimeRole,
} from "./types.js";

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
type WireField = keyof ConverseInput;

/** The inputs every {@link FIELDS} reader needs; threaded through unchanged rather than closed over, so `FIELDS` stays a plain, inspectable table. */
interface FieldReaderContext {
  readonly modelId: string;
  readonly request: M3LBedrockInvokeRequest;
  readonly toolConfig: ToolConfiguration | undefined;
  readonly budget: DocumentCopyBudget;
  /**
   * `invokeStream`'s text-only, no-tools scope (see this module's doc
   * comment's "The `textOnly` policy" section) -- `undefined`/`false` for
   * `invoke()`'s ordinary build. When `true`, {@link buildRequestFields}
   * refuses an own `tools`/`toolChoice` property on `request` before any
   * field is read, and every content block across every message must be
   * `type: "text"`.
   */
  readonly textOnly?: boolean;
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
  messages: (ctx) =>
    readMessages(ctx.request, ctx.budget, ctx.textOnly ?? false),
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
 *
 * `ctx.textOnly` is checked FIRST, before any {@link FIELDS} reader runs --
 * `invokeStream`'s tools/toolChoice refusal must fire before model
 * selection and before any other field is read (see
 * {@link assertNoToolsForStreaming}).
 */
function buildRequestFields(ctx: FieldReaderContext): ConverseInput {
  if (ctx.textOnly === true) {
    assertNoToolsForStreaming(ctx.request);
  }
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

/**
 * Builds the plain request-input object `client.ts`'s `buildConverseCommand`
 * uses directly, and that `client.ts`'s `invokeStream` builds ONCE (with
 * `policy: { textOnly: true }`) before handing it to `stream.ts`, which
 * swaps only `modelId` per fallback attempt -- `ConverseCommandInput` and
 * `ConverseStreamCommandInput` are field-identical for this slice's
 * surface. Delegates the actual field-by-field construction to
 * {@link buildRequestFields} above.
 *
 * `toolConfig` is already-built (via `tools.ts`'s `buildToolConfig`, called
 * once by `client.ts`'s `invoke` before the fallback loop) rather than
 * derived from `request` here -- `request`'s own type stays
 * `M3LBedrockInvokeRequest`.
 *
 * @param policy - `{ textOnly: true }` for `client.ts`'s `invokeStream` (see
 *   `field-readers.ts`'s doc comment's "`textOnly`" section) -- refuses
 *   `tools`/`toolChoice` and any non-`text` content block, with the same
 *   typed error the deleted `stream-guard.ts` produced. Omitted (the
 *   default) for `invoke`'s ordinary build.
 */
export function buildConverseInput(
  modelId: string,
  request: M3LBedrockInvokeRequest,
  toolConfig?: ToolConfiguration,
  policy?: { readonly textOnly: true },
): ConverseInput {
  return buildRequestFields({
    modelId,
    request,
    toolConfig,
    budget: new DocumentCopyBudget(),
    ...(policy?.textOnly !== undefined && { textOnly: policy.textOnly }),
  });
}
