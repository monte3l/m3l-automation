/**
 * `aws/bedrock-runtime/tools` -- V5 Slice A's tool-vocabulary machinery: the
 * request-side {@link M3LBedrockToolDefinition}/{@link M3LBedrockToolChoice}
 * → SDK `ToolConfiguration` mapping ({@link buildToolConfig}), and the
 * response-side SDK → library `toolUse` content-block narrowing/mapping
 * ({@link narrowToolUseMember}/{@link mapNarrowedToolUse}). The bounded
 * recursive document copy both directions share ({@link copyDocument})
 * lives in its own leaf module, `document.ts` -- see that file's doc
 * comment. Internal module -- nothing here is re-exported through
 * `aws/bedrock-runtime/index`; `shared.ts` and `client.ts` import directly
 * from it.
 *
 * @packageDocumentation
 */

import type {
  Tool,
  ToolChoice,
  ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";

import {
  chargeElementBudget,
  copyDocument,
  DocumentCopyBudget,
  isPlainObject,
  readCallerElement,
  readCallerString,
  readCallerValue,
  readOwn,
  requireCallerArray,
} from "./document.js";
import { M3LBedrockRuntimeOperationError } from "./error.js";
import { sanitizeForMessage } from "./message-safety.js";
import type {
  M3LBedrockToolChoice,
  M3LBedrockToolDefinition,
  M3LBedrockToolInvokeRequest,
  M3LBedrockToolUseBlock,
} from "./types.js";

/**
 * Maps one {@link M3LBedrockToolDefinition} to the SDK's `Tool.ToolSpecMember`
 * shape (plus the tool's already-read `name`, reused by
 * {@link resolveToolChoice} so the match check never re-reads
 * `tool.name` off caller data a second time -- see this function's
 * `.name` field). Recursively copies `inputSchema` -- see
 * {@link copyDocument}. `budget` is shared across every tool in
 * {@link buildToolConfig}'s loop, so the node/element ceiling bounds the
 * whole tool list, not each schema in isolation. `name`/`description` are
 * guarded, string-typed reads -- a throwing getter or a non-string value on
 * either is a typed caller error rather than a raw exception or a forged
 * non-string reaching the wire.
 */
function mapToolDefinition(
  tool: M3LBedrockToolDefinition,
  budget: DocumentCopyBudget,
): { readonly name: string; readonly tool: Tool } {
  const name = readCallerString(() => tool.name, "a tool's name");
  const description = readCallerValue(
    () => tool.description,
    "a tool's description",
  );
  const inputSchema = readCallerValue(
    () => tool.inputSchema,
    "a tool's inputSchema",
  );
  return {
    name,
    tool: {
      toolSpec: {
        name,
        ...(description !== undefined && {
          description: readCallerString(
            () => description,
            "a tool's description",
          ),
        }),
        inputSchema: { json: copyDocument(inputSchema, 0, budget) },
      },
    },
  };
}

/**
 * Resolves `request.toolChoice` against the tool names already read by
 * {@link buildToolConfig}'s single mapping pass (`toolNames`, in `tools[]`
 * order) -- never re-reads a raw `tools[index].name` a second time, closing
 * the same read-twice class M5 fixed for `toolChoice.tool` itself (a
 * structurally identical sibling: the pre-fix code re-derived a tool's name
 * once for the match check and again inside {@link mapToolDefinition}, so a
 * throwing/flip-flopping getter could make the two diverge).
 *
 * `toolChoice` is read (from `request.toolChoice`) once by the caller of
 * this function and passed in verbatim; here it is validated defensively
 * against every runtime shape, not just the three the {@link M3LBedrockToolChoice}
 * type licenses -- `typeof null === "object"` (M3, round 5: a bare
 * `typeof choice === "object"` check previously let `toolChoice: null`
 * reach `.tool` and throw a raw `TypeError`) and an array are both refused
 * explicitly rather than falling through to a property read that would
 * silently see `undefined`.
 *
 * `toolChoice.tool` is read EXACTLY ONCE here (M5) and, when it fails to
 * match `toolNames`, rendered through {@link sanitizeForMessage} (length-capped,
 * control-character-escaped) before interpolation into the thrown error's
 * message (M4, round 5: a 200 KB unsanitized name previously produced a
 * 401 KB `toJSON()` and let ANSI/newline injection through).
 *
 * @throws {@link M3LBedrockRuntimeOperationError} (`origin: caller`,
 *   `retryable: false`) when `toolChoice` is present but is neither
 *   `"auto"`, `"any"`, nor a plain (non-`null`, non-array) object; when its
 *   `.tool` property is not a non-empty string; or when `.tool` does not
 *   case-sensitively match any entry in `toolNames`.
 */
function resolveToolChoice(
  toolChoice: M3LBedrockToolChoice | undefined,
  toolNames: readonly string[],
): ToolChoice | undefined {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === "auto") return { auto: {} };
  if (toolChoice === "any") return { any: {} };
  if (
    toolChoice === null ||
    typeof toolChoice !== "object" ||
    Array.isArray(toolChoice)
  ) {
    throw new M3LBedrockRuntimeOperationError(
      'toolChoice must be "auto", "any", or { tool: string }',
      { origin: "caller", retryable: false },
    );
  }

  const toolName = readCallerString(
    () => (toolChoice as { readonly tool: unknown }).tool,
    "toolChoice.tool",
  );

  if (!toolNames.includes(toolName)) {
    throw new M3LBedrockRuntimeOperationError(
      `toolChoice named tool "${sanitizeForMessage(toolName)}" which is not present in tools`,
      { origin: "caller", retryable: false },
    );
  }

  return { tool: { name: toolName } };
}

/**
 * Validates and maps `request.tools`/`request.toolChoice` into the Converse
 * API's single `toolConfig` field, `undefined` when `tools` is absent **or
 * empty** (an empty array is equivalent to absent throughout).
 *
 * Called by `client.ts`'s `invoke` before its `AbortSignal` check -- a
 * malformed request is malformed regardless of whether it was also
 * cancelled, so this validation must run first (see
 * `docs/reference/aws/bedrock-runtime.md`'s ordering note).
 *
 * `request.tools`/`request.toolChoice` are read via a guarded closure
 * (S4: an inherited `tools`/`toolChoice` property, e.g. supplied via
 * prototype rather than an own property, is picked up here exactly like an
 * own one -- ordinary JS property-access semantics. This is deliberately
 * DIFFERENT from `client.ts`'s `invokeStream` structural guard, which checks
 * `Object.hasOwn` specifically to detect a downcast past the narrower V4
 * request type, not "does this field exist" in general; see that function's
 * doc comment).
 *
 * @throws {@link M3LBedrockRuntimeOperationError} (`origin: caller`,
 *   `retryable: false`) when `toolChoice` is present while `tools` is
 *   absent/empty, or `toolChoice` is malformed/names a tool absent from
 *   `tools` (see {@link resolveToolChoice}).
 */
export function buildToolConfig(
  request: M3LBedrockToolInvokeRequest,
): ToolConfiguration | undefined {
  const rawTools = readCallerValue(() => request.tools, "request.tools");
  const toolChoice = readCallerValue(
    () => request.toolChoice,
    "request.toolChoice",
  );
  // `Array.isArray` FIRST, before any `.length`/index read -- a duck-typed
  // object exposing `length`/`map` but not a real array defeats a bare
  // `.map()` call; a real array is the only shape this function ever walks.
  // `rawTools === undefined` is legitimate (no tools at all), so it is
  // handled separately, never routed through the array guard.
  const tools =
    rawTools === undefined
      ? []
      : requireCallerArray<M3LBedrockToolDefinition>(rawTools, "request.tools");
  const toolCount = tools.length;

  if (toolCount === 0) {
    if (toolChoice !== undefined) {
      throw new M3LBedrockRuntimeOperationError(
        "toolChoice was provided but tools is absent or empty — a choice cannot constrain a vocabulary that isn't there",
        { origin: "caller", retryable: false },
      );
    }
    return undefined;
  }

  // One budget shared across the whole tool list -- see
  // `mapToolDefinition`'s doc comment. Never `.map()` over `tools` (caller
  // data, see the array guard above): the loop reads `toolCount` once,
  // guards each element read (M6), charges the shared budget per element
  // (Should-fix #3), and pushes into a module-owned literal.
  const budget = new DocumentCopyBudget();
  const mappedTools: Tool[] = [];
  const toolNames: string[] = [];
  for (let index = 0; index < toolCount; index += 1) {
    chargeElementBudget(budget, "request.tools");
    const tool = readCallerElement(tools, index, "a tool in request.tools");
    const mapped = mapToolDefinition(tool, budget);
    mappedTools.push(mapped.tool);
    toolNames.push(mapped.name);
  }

  const resolvedToolChoice = resolveToolChoice(toolChoice, toolNames);

  return {
    tools: mappedTools,
    ...(resolvedToolChoice !== undefined && {
      toolChoice: resolvedToolChoice,
    }),
  };
}

/**
 * Narrows `raw` to its own, plain-object-shaped `toolUse` member, or
 * `undefined` when `raw` is not plain-object-shaped at all, or is but lacks
 * one -- the single shape gate {@link refuseServerToolUse} and
 * `client.ts`'s `mapContent` both need.
 *
 * `client.ts`'s `mapContent` calls this directly (rather than a
 * boolean-returning wrapper) to distinguish "not `toolUse`-shaped at all"
 * (legitimately droppable) from "`toolUse`-shaped but malformed" (which
 * must not silently vanish from a `stopReason: "tool_use"` reply -- see
 * {@link mapNarrowedToolUse}'s doc comment), and reuses the SAME narrowed
 * record for {@link mapNarrowedToolUse} instead of narrowing twice.
 */
export function narrowToolUseMember(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const toolUse = readOwn(raw, "toolUse");
  return isPlainObject(toolUse) ? toolUse : undefined;
}

/**
 * Throws when `raw` narrows (via {@link narrowToolUseMember}) to a `toolUse`
 * member marked `type: "server_tool_use"` -- Bedrock already executed that
 * tool server-side, so mapping it like an ordinary request would let a V5
 * tool-use loop execute the side effect a second time. Dropping would be
 * merely lossy; this is actively unsafe, so it is refused instead.
 *
 * `client.ts`'s `mapContent` runs this **unconditionally, for every reply
 * block, before any `text`-member short-circuit** -- the SDK's deserializer
 * does not enforce single-member unions, so one reply block can carry both
 * a `text` member and a `server_tool_use`-marked `toolUse` member at once,
 * and handling the `text` member first must never bypass this refusal.
 *
 * `toolUseId`/`name` are rendered through `sanitizeForMessage` before
 * interpolation -- they are model-supplied strings, external data reaching
 * `error.message` and from there `M3LError.toJSON()`'s log projection.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} When `raw` is
 *   `server_tool_use`-marked, naming the block's `toolUseId`/`name` (when
 *   both are strings) for log correlation -- never the block's `input`.
 */
export function refuseServerToolUse(raw: unknown): void {
  const toolUse = narrowToolUseMember(raw);
  if (toolUse === undefined) return;
  if (readOwn(toolUse, "type") !== "server_tool_use") return;

  const toolUseId = readOwn(toolUse, "toolUseId");
  const name = readOwn(toolUse, "name");
  const idSuffix =
    typeof toolUseId === "string"
      ? ` toolUseId=${sanitizeForMessage(toolUseId)}`
      : "";
  const nameSuffix =
    typeof name === "string" ? ` name=${sanitizeForMessage(name)}` : "";
  throw new M3LBedrockRuntimeOperationError(
    `Converse reply contained a server_tool_use block${idSuffix}${nameSuffix} — Bedrock already executed this tool server-side, so mapping it would risk a second, duplicate execution`,
  );
}

/**
 * Maps an already-narrowed (via {@link narrowToolUseMember}) `toolUse`
 * record onto {@link M3LBedrockToolUseBlock}, or `undefined` when it is
 * malformed (missing, non-string, or empty-string `toolUseId` or `name`) --
 * the model's reply is external data, not a caller mistake, so a malformed
 * block is dropped rather than thrown on.
 *
 * Takes the already-narrowed record -- never the raw content block -- so
 * `mapContent` narrows exactly once per block and reuses the same result
 * for both its shaped-count bookkeeping and this mapping.
 *
 * `input` is forwarded exactly as the SDK decoded it, including `undefined`
 * when absent -- never re-parsed, re-shaped, or validated.
 */
export function mapNarrowedToolUse(
  toolUse: Record<string, unknown>,
): M3LBedrockToolUseBlock | undefined {
  const toolUseId = readOwn(toolUse, "toolUseId");
  const name = readOwn(toolUse, "name");
  if (
    typeof toolUseId !== "string" ||
    toolUseId === "" ||
    typeof name !== "string" ||
    name === ""
  ) {
    return undefined;
  }

  return {
    type: "toolUse",
    toolUseId,
    name,
    input: readOwn(toolUse, "input"),
  };
}
