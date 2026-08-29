/**
 * `aws/bedrock-runtime/tools` — V5 Slice A's tool-vocabulary machinery: the
 * request-side {@link M3LBedrockToolDefinition}/{@link M3LBedrockToolChoice}
 * → SDK `ToolConfiguration` mapping ({@link buildToolConfig}), and the
 * response-side SDK → library `toolUse` content-block narrowing/mapping
 * ({@link narrowToolUseMember}/{@link mapNarrowedToolUse}). The bounded
 * recursive document copy both directions share ({@link copyDocument})
 * lives in its own leaf module, `document.ts` — see that file's doc
 * comment. Internal module — nothing here is re-exported through
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
  copyDocument,
  isPlainObject,
  readOwn,
  sanitizeForMessage,
} from "./document.js";
import { M3LBedrockRuntimeOperationError } from "./error.js";
import type {
  M3LBedrockToolChoice,
  M3LBedrockToolDefinition,
  M3LBedrockToolInvokeRequest,
  M3LBedrockToolUseBlock,
} from "./types.js";

/** Maps one {@link M3LBedrockToolChoice} to exactly one SDK `ToolChoice` key — never a conditional spread, since every SDK union member declares its siblings `?: never`. */
function mapToolChoice(choice: M3LBedrockToolChoice): ToolChoice {
  if (choice === "auto") return { auto: {} };
  if (choice === "any") return { any: {} };
  return { tool: { name: choice.tool } };
}

/** Maps one {@link M3LBedrockToolDefinition} to the SDK's `Tool.ToolSpecMember` shape, recursively copying `inputSchema` — see {@link copyDocument}. */
function mapToolDefinition(tool: M3LBedrockToolDefinition): Tool {
  return {
    toolSpec: {
      name: tool.name,
      ...(tool.description !== undefined && {
        description: tool.description,
      }),
      inputSchema: { json: copyDocument(tool.inputSchema, 0) },
    },
  };
}

/**
 * Validates and maps `request.tools`/`request.toolChoice` into the Converse
 * API's single `toolConfig` field, `undefined` when `tools` is absent **or
 * empty** (an empty array is equivalent to absent throughout).
 *
 * Called by `client.ts`'s `invoke` before its `AbortSignal` check — a
 * malformed request is malformed regardless of whether it was also
 * cancelled, so this validation must run first (see
 * `docs/reference/aws/bedrock-runtime.md`'s ordering note).
 *
 * @throws {@link M3LBedrockRuntimeOperationError} (`origin: caller`,
 *   `retryable: false`) when `toolChoice` is present while `tools` is
 *   absent/empty, or `toolChoice` is `{ tool: name }` naming a tool absent
 *   from `tools` (an exact, case-sensitive match — nothing normalizes case).
 */
export function buildToolConfig(
  request: M3LBedrockToolInvokeRequest,
): ToolConfiguration | undefined {
  const tools = request.tools;
  const toolChoice = request.toolChoice;

  if (tools === undefined || tools.length === 0) {
    if (toolChoice !== undefined) {
      throw new M3LBedrockRuntimeOperationError(
        "toolChoice was provided but tools is absent or empty — a choice cannot constrain a vocabulary that isn't there",
        { origin: "caller", retryable: false },
      );
    }
    return undefined;
  }

  if (
    typeof toolChoice === "object" &&
    !tools.some((tool) => tool.name === toolChoice.tool)
  ) {
    throw new M3LBedrockRuntimeOperationError(
      `toolChoice named tool "${toolChoice.tool}" which is not present in tools`,
      { origin: "caller", retryable: false },
    );
  }

  return {
    tools: tools.map(mapToolDefinition),
    ...(toolChoice !== undefined && { toolChoice: mapToolChoice(toolChoice) }),
  };
}

/**
 * Narrows `raw` to its own, plain-object-shaped `toolUse` member, or
 * `undefined` when `raw` is not plain-object-shaped at all, or is but lacks
 * one — the single shape gate {@link refuseServerToolUse} and
 * `client.ts`'s `mapContent` both need. Previously, `isToolUseShaped`'s
 * boolean view and `mapToolUseBlock`'s mapping view independently re-derived
 * this exact shape (the same two-views-of-one-contract seam the M1
 * array-arm bypass exploited, 2026-08-29 security pass); this is the single
 * entry point both now go through, so "narrow before you look at `toolUse`"
 * is structural rather than documented convention.
 *
 * `client.ts`'s `mapContent` calls this directly (rather than a
 * boolean-returning wrapper) to distinguish "not `toolUse`-shaped at all"
 * (legitimately droppable — the model's reply simply used a content block
 * this wrapper doesn't represent) from "`toolUse`-shaped but malformed"
 * (which must not silently vanish from a `stopReason: "tool_use"` reply —
 * see {@link mapNarrowedToolUse}'s doc comment), and reuses the SAME
 * narrowed record for {@link mapNarrowedToolUse} instead of narrowing twice.
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
 * member marked `type: "server_tool_use"` — Bedrock already executed that
 * tool server-side, so mapping it like an ordinary request would let a V5
 * tool-use loop execute the side effect a second time. Dropping would be
 * merely lossy; this is actively unsafe, so it is refused instead.
 *
 * `client.ts`'s `mapContent` runs this **unconditionally, for every reply
 * block, before any `text`-member short-circuit** — the SDK's deserializer
 * does not enforce single-member unions, so one reply block can carry both
 * a `text` member and a `server_tool_use`-marked `toolUse` member at once,
 * and handling the `text` member first must never bypass this refusal.
 *
 * `toolUseId`/`name` are rendered through `sanitizeForMessage` before
 * interpolation — they are model-supplied strings, external data reaching
 * `error.message` and from there `M3LError.toJSON()`'s log projection, the
 * same channel the M2 finding covers for `formatDocumentPath`/
 * `formatDiscriminant`.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} When `raw` is
 *   `server_tool_use`-marked, naming the block's `toolUseId`/`name` (when
 *   both are strings) for log correlation — never the block's `input`.
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
 * malformed (missing, non-string, or empty-string `toolUseId` or `name`) —
 * the model's reply is external data, not a caller mistake, so a malformed
 * block is dropped rather than thrown on (see `client.ts`'s `mapContent`,
 * which distinguishes this from the "not `toolUse`-shaped at all" case via
 * {@link narrowToolUseMember}'s own `undefined` return).
 *
 * Takes the already-narrowed record — never the raw content block — so
 * `mapContent` narrows exactly once per block and reuses the same result
 * for both its shaped-count bookkeeping and this mapping, rather than
 * re-deriving the shape a second time here.
 *
 * `input` is forwarded exactly as the SDK decoded it, including `undefined`
 * when absent — never re-parsed, re-shaped, or validated.
 */
export function mapNarrowedToolUse(
  toolUse: Record<string, unknown>,
): M3LBedrockToolUseBlock | undefined {
  const toolUseId = readOwn(toolUse, "toolUseId");
  const name = readOwn(toolUse, "name");
  // An empty-string toolUseId/name is not well-formed either: Slice B's
  // tool-use loop keys one toolResult per toolUse by toolUseId and rejects
  // duplicates within a turn, so "" would both fail the Converse round-trip
  // and let two independently-empty ids collide with each other.
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
