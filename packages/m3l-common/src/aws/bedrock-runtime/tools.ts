/**
 * `aws/bedrock-runtime/tools` — V5 Slice A's tool-vocabulary machinery: the
 * request-side {@link M3LBedrockToolDefinition}/{@link M3LBedrockToolChoice}
 * → SDK `ToolConfiguration` mapping ({@link buildToolConfig}), the
 * response-side SDK → library `toolUse` content-block mapping
 * ({@link mapToolUseBlock}), and the bounded recursive document copy both
 * directions share ({@link copyDocument}) for the SDK's mutable
 * `DocumentType` boundary. Internal module — nothing here is re-exported
 * through `aws/bedrock-runtime/index`; `shared.ts` and `client.ts` import
 * directly from it.
 *
 * @packageDocumentation
 */

import type {
  Tool,
  ToolChoice,
  ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";

import { M3LBedrockRuntimeOperationError } from "./error.js";
import type {
  M3LBedrockToolChoice,
  M3LBedrockToolDefinition,
  M3LBedrockToolInvokeRequest,
  M3LBedrockToolUseBlock,
} from "./types.js";

/**
 * Nesting ceiling for {@link copyDocument} — see
 * `docs/reference/aws/bedrock-runtime.md`'s "`input`, `json`, and
 * `inputSchema` are `unknown`" note. No other numeric limit (tool count,
 * name length, byte size) is invented here; adversarial sizing is a later
 * slice's concern.
 */
const MAX_DOCUMENT_DEPTH = 32;

/**
 * A JSON-serializable document value, structurally identical to
 * `@smithy/types`' `DocumentType` (verified against installed dist-types,
 * 2026-08-29: `null | boolean | number | string | DocumentType[] | { [key: string]: DocumentType }`)
 * but declared locally rather than imported — this submodule never names an
 * `@smithy` type across its own boundary (ADR-0027), and this alias is
 * purely internal plumbing for building the SDK request literal that
 * `shared.ts`'s `toSdkMessage` and `buildConverseInput` assign into
 * `ConverseCommand`'s constructor argument.
 */
export type M3LBedrockPlainDocument =
  | null
  | boolean
  | number
  | string
  | M3LBedrockPlainDocument[]
  | { [key: string]: M3LBedrockPlainDocument };

/**
 * Module-local plain-object guard, mirroring `core/utils/guards.ts`'s
 * `isPlainObject` exactly (prototype-chain check, not just `typeof`).
 * `aws/**` may import only `core/errors` + `core/prompt` + `core/polling`
 * (ADR-0059's ESLint island, `eslint.config.js:851-870`, asserted by
 * `bin/check-eslint-zones.mjs`) — `core/utils/guards.ts` is out of reach, so
 * this is reimplemented locally rather than imported, matching the existing
 * local-guard precedent in `aws/sqs/attributes.ts` and
 * `aws/athena/template.ts`. Do not "fix" this into a `core/utils` import —
 * it would trip `pnpm check:zones`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads an own property of a plain-object-shaped `unknown` value, `Object.hasOwn`-gated
 * so an inherited (prototype-chain) property never impersonates one the model
 * actually sent — the same idiom already used by `aws/sqs/attributes.ts`'s
 * `readRequiredAttribute` and `aws/athena/template.ts`'s
 * `validateOccurrences`.
 */
function readOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Property names that manipulate an object's own prototype or shape when
 * assigned via plain bracket notation, refused outright rather than merely
 * made structurally inert — see {@link copyDocument}'s null-prototype note.
 */
const DANGEROUS_DOCUMENT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Formats a {@link copyDocument} key/index trail as a JSON-path-like string
 * for an error message — e.g. `$.tools[0].inputSchema.__proto__`. Every
 * segment here is a caller-supplied object KEY or array INDEX, never a
 * VALUE, so interpolating it is safe; the corresponding value is never
 * included (see the module's `for...in`-serializer safety note).
 */
function formatDocumentPath(path: readonly (string | number)[]): string {
  let rendered = "$";
  for (const segment of path) {
    rendered += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return rendered;
}

/**
 * Recursively copies `value` into fresh mutable structures for the SDK's
 * mutable `DocumentType` boundary (`@smithy/types`' array arm is
 * `DocumentType[]`, not `readonly`, so a `readonly` library value is not
 * assignable to it — spreading or casting does not produce a structurally
 * mutable copy at every depth). Used for
 * {@link M3LBedrockToolDefinition.inputSchema}, a `json` tool-result
 * content block, and (per `shared.ts`'s `mapContentBlockToSdk`) a `toolUse`
 * block's `input`.
 *
 * Bounded at {@link MAX_DOCUMENT_DEPTH} levels so an unbounded recursion
 * over caller input — including a cyclic object, which this depth bound
 * also catches by construction, since a cycle can never terminate and so
 * always reaches the ceiling — cannot escape the public boundary as a bare
 * `RangeError`. A value that cannot round-trip JSON at all (a `bigint`, a
 * function, a `symbol`, `undefined`) is likewise a caller error, not a
 * silent mis-serialization at send time.
 *
 * The object arm builds `copy` on a **null prototype**
 * (`Object.create(null)`), never a `{}` literal, and refuses
 * {@link DANGEROUS_DOCUMENT_KEYS} outright. This is not decorative: the AWS
 * SDK's request serializer (`@aws-sdk/core`'s protocol layer) walks a
 * `DocumentType` with `for...in`, which traverses the **prototype chain**.
 * `JSON.parse` can produce `__proto__` as a real own property (unlike an
 * object literal), so a `{}`-based `copy[key] = ...` assignment for
 * `key === "__proto__"` would fire `Object.prototype`'s `__proto__`
 * ACCESSOR instead of creating an own data property — silently dropping the
 * key from `Object.keys(copy)` while splicing the caller's nested data onto
 * `copy`'s own prototype, which the SDK's `for...in` walk would then
 * re-surface as sibling top-level members on the wire (proven end-to-end:
 * an `inputSchema`/`json` payload's `__proto__` value reaches Bedrock as
 * extra top-level document keys). A null-prototype `copy` has no such
 * accessor, so bracket assignment always creates a plain own property; the
 * explicit key refusal below is defense in depth on top of that structural
 * fix. Do not "simplify" this back to a `{}` literal.
 *
 * @param value - The value to copy; typically an `inputSchema`, a `json`
 *   tool-result payload, or a `toolUse.input`, all typed `unknown` at the
 *   public boundary.
 * @param depth - The current nesting depth; callers pass `0`.
 * @param path - The key/index trail from the root call, for error messages
 *   only; callers omit it (defaults to `[]`, meaning the root).
 * @throws {@link M3LBedrockRuntimeOperationError} (`origin: caller`,
 *   `retryable: false`) when nesting exceeds {@link MAX_DOCUMENT_DEPTH},
 *   `value` (at any depth) is not one of `null`/a plain object/an array/a
 *   string/a number/a boolean, or a plain object carries an own
 *   `__proto__`/`constructor`/`prototype` key — this is caller/handler data,
 *   not model output, so a key the caller thinks they sent is refused
 *   outright rather than silently dropped.
 */
export function copyDocument(
  value: unknown,
  depth = 0,
  path: readonly (string | number)[] = [],
): M3LBedrockPlainDocument {
  if (depth > MAX_DOCUMENT_DEPTH) {
    throw new M3LBedrockRuntimeOperationError(
      `document nesting exceeded ${MAX_DOCUMENT_DEPTH} levels while copying an inputSchema/tool-result value at ${formatDocumentPath(path)}`,
      { origin: "caller", retryable: false },
    );
  }
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) =>
      copyDocument(item, depth + 1, [...path, index]),
    );
  }
  if (isPlainObject(value)) {
    return copyPlainObjectDocument(value, depth, path);
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value as string | number | boolean;
  }
  throw new M3LBedrockRuntimeOperationError(
    `an inputSchema/tool-result value contained a non-JSON-serializable ${kind} at ${formatDocumentPath(path)} — bigint, function, symbol, and undefined cannot round-trip through the Converse API's document type`,
    { origin: "caller", retryable: false },
  );
}

/**
 * {@link copyDocument}'s plain-object arm, split out to keep the parent
 * function's cyclomatic complexity within the repo's lint ceiling — see
 * {@link copyDocument}'s doc comment for the null-prototype/reserved-key
 * rationale, which applies here unchanged.
 */
function copyPlainObjectDocument(
  value: Record<string, unknown>,
  depth: number,
  path: readonly (string | number)[],
): M3LBedrockPlainDocument {
  const copy: Record<string, M3LBedrockPlainDocument> = Object.create(
    null,
  ) as Record<string, M3LBedrockPlainDocument>;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_DOCUMENT_KEYS.has(key)) {
      throw new M3LBedrockRuntimeOperationError(
        `an inputSchema/tool-result value used the reserved key "${key}" at ${formatDocumentPath([...path, key])} — this cannot round-trip safely through the Converse API's document type`,
        { origin: "caller", retryable: false },
      );
    }
    copy[key] = copyDocument(value[key], depth + 1, [...path, key]);
  }
  return copy;
}

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
 * Returns `true` when `raw` carries an own, plain-object-shaped `toolUse`
 * member — the same shape gate {@link mapToolUseBlock} itself starts from —
 * independent of whether that member is well-formed enough to map
 * successfully.
 *
 * `client.ts`'s `mapContent` uses this to distinguish "not toolUse-shaped at
 * all" (legitimately droppable — the model's reply simply used a content
 * block this wrapper doesn't represent) from "toolUse-shaped but malformed"
 * (which must not silently vanish from a `stopReason: "tool_use"` reply — a
 * caller acting on that stop reason needs to know at least one tool call
 * existed and failed to map, not see an empty, indistinguishable-from-none
 * content array).
 */
export function isToolUseShaped(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  return isPlainObject(readOwn(raw, "toolUse"));
}

/**
 * Throws when `raw` carries a `toolUse` member marked
 * `type: "server_tool_use"` — Bedrock already executed that tool
 * server-side, so mapping it like an ordinary request would let a V5
 * tool-use loop execute the side effect a second time. Dropping would be
 * merely lossy; this is actively unsafe, so it is refused instead.
 *
 * Split out from {@link mapToolUseBlock} so `client.ts`'s `mapContent` can
 * run this refusal **unconditionally, for every reply block, before any
 * `text`-member short-circuit** — the SDK's deserializer does not enforce
 * single-member unions, so one reply block can carry both a `text` member
 * and a `server_tool_use`-marked `toolUse` member at once, and handling the
 * `text` member first must never bypass this refusal.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} When `raw` is
 *   `server_tool_use`-marked, naming the block's `toolUseId`/`name` (when
 *   both are strings) for log correlation — never the block's `input`.
 */
export function refuseServerToolUse(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  const toolUse = readOwn(raw, "toolUse");
  if (!isPlainObject(toolUse)) return;
  if (readOwn(toolUse, "type") !== "server_tool_use") return;

  const toolUseId = readOwn(toolUse, "toolUseId");
  const name = readOwn(toolUse, "name");
  const idSuffix =
    typeof toolUseId === "string" ? ` toolUseId=${toolUseId}` : "";
  const nameSuffix = typeof name === "string" ? ` name=${name}` : "";
  throw new M3LBedrockRuntimeOperationError(
    `Converse reply contained a server_tool_use block${idSuffix}${nameSuffix} — Bedrock already executed this tool server-side, so mapping it would risk a second, duplicate execution`,
  );
}

/**
 * Maps a raw, SDK-decoded reply content-block value onto
 * {@link M3LBedrockToolUseBlock}, or `undefined` when `raw` is not a
 * `toolUse`-shaped block at all, or is one but is malformed (missing,
 * non-string, or empty-string `toolUseId` or `name`) — the model's reply is
 * external data, not a caller mistake, so a malformed block is dropped
 * rather than thrown on (see `client.ts`'s `mapContent`, which distinguishes
 * this from the "not toolUse-shaped at all" case via
 * {@link isToolUseShaped}).
 *
 * `input` is forwarded exactly as the SDK decoded it, including `undefined`
 * when absent — never re-parsed, re-shaped, or validated.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} See {@link refuseServerToolUse}.
 */
export function mapToolUseBlock(
  raw: unknown,
): M3LBedrockToolUseBlock | undefined {
  refuseServerToolUse(raw);
  if (!isPlainObject(raw)) return undefined;
  const toolUse = readOwn(raw, "toolUse");
  if (!isPlainObject(toolUse)) return undefined;

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
