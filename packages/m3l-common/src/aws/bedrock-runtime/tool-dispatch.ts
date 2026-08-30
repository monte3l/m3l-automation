/**
 * `aws/bedrock-runtime/tool-dispatch` — the tool registry/handler contract
 * (`M3LBedrockToolContext`, `M3LBedrockToolHandler`, `M3LBedrockToolRegistration`,
 * `M3LBedrockToolRegistry`) and the per-block validation + dispatch path
 * `loop.ts`'s `runBedrockToolLoop` drives for one `tool_use` turn: whole-batch
 * validation (V5 Slice B contract C5's malformed-reply dispositions),
 * registry lookup, the `input` shape guard, the Check-2 abort (immediately
 * before every handler dispatch), the actual handler call, and toolResult
 * assembly.
 *
 * Split out of `loop.ts` as its own leaf module (ADR-0072's per-file size
 * ratchet) — dispatching one already-classified `toolUse` block to its
 * handler and building that block's ledger entry + toolResult reply is a
 * self-contained concern independent of `loop.ts`'s own concern (the
 * iteration state machine: ceilings, cumulative usage, and the
 * invoke/append cycle). `loop.ts` re-exports every type here through its own
 * export list, so the submodule barrel (`index.ts`) has exactly one place to
 * source the tool-use-loop public surface from.
 *
 * @packageDocumentation
 */

import { M3LOperationAbortedError } from "../../core/errors/index.js";

import { copyDocument, isPlainObject } from "./document.js";
import { M3LBedrockRuntimeOperationError } from "./error.js";
import { isAborted, isAbortError } from "./shared.js";
import { sanitizeForMessage } from "./message-safety.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockToolInputSchema,
  M3LBedrockToolResultBlock,
  M3LBedrockToolResultContent,
  M3LBedrockToolUseBlock,
} from "./types.js";
import type { M3LBedrockToolExecution } from "./tool-ledger.js";

/**
 * Per-call context passed to a {@link M3LBedrockToolHandler}.
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolContext } from "@m3l-automation/m3l-common/aws";
 *
 * function logCall(context: M3LBedrockToolContext): void {
 *   console.log(context.toolUseId, context.name);
 * }
 * ```
 */
export interface M3LBedrockToolContext {
  /** Correlates this call to the model's {@link M3LBedrockToolUseBlock.toolUseId}. */
  readonly toolUseId: string;
  /** The tool's registry key / declared name. */
  readonly name: string;
  /** The loop's own `AbortSignal`, forwarded unchanged; omitted when the caller supplied none. */
  readonly signal?: AbortSignal;
}

/**
 * A registered tool's implementation, invoked once per matching
 * {@link M3LBedrockToolUseBlock} the model requests.
 *
 * `input` is deliberately `unknown` — the model's decoded call arguments,
 * never validated against the tool's own `inputSchema` by this library. The
 * return type is `Promise<...>` only (never `T | Promise<T>`); do not widen
 * it.
 *
 * **A rejection's `message` is transmitted to the model.** A thrown/rejected
 * value is rendered (via `describeToolFailure`) into the `toolResult` content
 * sent back on the next turn — sanitized (control characters escaped) and
 * length-capped, but never redacted for secrets. Do not throw a message
 * containing anything the model must not see (a credential, an internal
 * stack frame, another tenant's data); throw a caller-controlled, deliberately
 * generic message instead and log the real detail separately.
 *

 * @example
 * ```ts
 * import type { M3LBedrockToolHandler } from "@m3l-automation/m3l-common/aws";
 *
 * const getWeather: M3LBedrockToolHandler = async (input, context) => {
 *   console.log(context.toolUseId);
 *   return [{ type: "text", text: "72°F, sunny" }];
 * };
 * ```
 */
export type M3LBedrockToolHandler = (
  input: unknown,
  context: M3LBedrockToolContext,
) => Promise<readonly M3LBedrockToolResultContent[]>;

/**
 * One tool's registration in a {@link M3LBedrockToolRegistry}. There is no
 * `name` field here — the tool's name is the registry **key**, so a
 * name/handler mismatch is structurally unrepresentable.
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolRegistration } from "@m3l-automation/m3l-common/aws";
 *
 * const registration: M3LBedrockToolRegistration = {
 *   inputSchema: { type: "object", properties: {} },
 *   handler: async () => [{ type: "text", text: "ok" }],
 * };
 * ```
 */
export interface M3LBedrockToolRegistration {
  /** Optional human-readable description shown to the model. Omitted when absent. */
  readonly description?: string;
  /** The tool's call-argument schema, forwarded to the Converse API. */
  readonly inputSchema: M3LBedrockToolInputSchema;
  /** The tool's implementation. */
  readonly handler: M3LBedrockToolHandler;
}

/**
 * The tools a {@link runBedrockToolLoop} call may dispatch to, keyed by tool
 * name.
 *
 * A `Map`, never a plain record: `({})["constructor"]` resolves to a
 * **function** and `({})["__proto__"]` to an **object**, while
 * `new Map().get("constructor")`/`.get("__proto__")` are both `undefined`. A
 * model that names its tool `"constructor"` would, against a record, resolve
 * an inherited *function* that the loop would then call as a handler; with a
 * `Map`, "unknown tool" is the only reachable outcome (V5 Slice B contract
 * §2.2).
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolRegistration, M3LBedrockToolRegistry } from "@m3l-automation/m3l-common/aws";
 *
 * const tools: M3LBedrockToolRegistry = new Map<string, M3LBedrockToolRegistration>([
 *   ["get_weather", { inputSchema: {}, handler: async () => [{ type: "text", text: "sunny" }] }],
 * ]);
 * ```
 */
export type M3LBedrockToolRegistry = ReadonlyMap<
  string,
  M3LBedrockToolRegistration
>;

/** Narrows a content block to a `toolUse`-typed one. */
function isToolUseBlock(
  block: M3LBedrockContentBlock,
): block is M3LBedrockToolUseBlock {
  return block.type === "toolUse";
}

/** Extracts every `toolUse`-typed block from a message's content, in order. */
export function filterToolUseBlocks(
  content: readonly M3LBedrockContentBlock[],
): readonly M3LBedrockToolUseBlock[] {
  const blocks: M3LBedrockToolUseBlock[] = [];
  for (const block of content) {
    if (isToolUseBlock(block)) {
      blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Validates one `toolUse` block's `input` against the exact grammar
 * `document.ts`'s {@link copyDocument} enforces on the request-build path —
 * reserved keys (`__proto__`/`constructor`/`prototype`), its depth ceiling,
 * and its node-count budget — BEFORE any handler runs (M1, 2026-08 security
 * pass). This is the load-bearing reason the check lives here and not in
 * `dispatchToolUse`'s own per-block gate: a model-controlled `input` that
 * survives unexamined is re-appended, byte-for-byte, into `messages` on this
 * very turn (`loop.ts` appends `result.message` verbatim) and would only be
 * re-copied by that SAME `copyDocument` machinery on the NEXT iteration's
 * `invoke()` call — by which point this turn's handler has ALREADY run with
 * real side effects. Throwing here, before `dispatchToolUseTurn` calls a
 * single handler, means a `__proto__`/`constructor`/`prototype`-carrying or
 * over-deep/over-large `input` is refused with zero side effects and a clean
 * typed error, instead of a mutation running on iteration N and the
 * conversation becoming permanently unsendable on iteration N+1. This also
 * closes the secondary half of the finding: an `input` with an own
 * `__proto__` DATA property (as `JSON.parse` can produce, unlike an object
 * literal) never reaches a handler's `Object.assign({}, input)` at all once
 * this throws first.
 *
 * `undefined` is skipped, not validated — mirrors `mapContentBlockToSdk`'s
 * own `input === undefined ? undefined : copyDocument(input, ...)` guard in
 * `field-readers.ts` exactly: a tool call the model made with no arguments at
 * all is not "malformed" at the batch level, `dispatchToolUse`'s own
 * `isPlainObject` gate still refuses it as a per-block `status: "error"`
 * disposition, never a batch-level throw.
 *
 * Deliberately reuses `copyDocument`'s own machinery rather than a second
 * copy of the depth/node/reserved-key grammar — its thrown message is already
 * safe to reuse verbatim (a positional key/index trail, a fixed reserved-key
 * vocabulary; see `message-safety.ts`'s `formatDocumentPath`), so this only
 * adds the block's own `toolUseId`/`name`, themselves routed through
 * {@link sanitizeForMessage}. The caught `copyDocument` failure is chained as
 * `cause` (review follow-up, 2026-08-30) — matching `document.ts`'s own
 * `readCallerValue`/`copyDocument` wrapping convention — so the structured
 * chain survives for `toJSON()`/`formatErrorChain` even though the rendered
 * `message` already embeds the same (already-safe, positional) detail text.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} Using the catalog's default
 *   classification (`origin: "external"`, `retryable: true`) — this is model
 *   output, joining the sibling malformed-reply checks in
 *   {@link validateToolUseBatch}, not a caller-input fault. Chains the
 *   underlying `copyDocument` failure as `cause`.
 */
function validateToolUseInputShape(block: M3LBedrockToolUseBlock): void {
  if (block.input === undefined) {
    return;
  }
  try {
    copyDocument(block.input);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "invalid input";
    throw new M3LBedrockRuntimeOperationError(
      `toolUse block "${sanitizeForMessage(block.toolUseId)}" for tool "${sanitizeForMessage(block.name)}" carries an unsafe input: ${detail}`,
      { cause },
    );
  }
}

/**
 * Validates a `tool_use` turn's whole batch BEFORE any handler runs (V5
 * Slice B contract C5, "malformed-reply dispositions"): every `toolUseId`
 * must be non-empty and unique within the turn, every `name` must be
 * non-empty, and every `input` must pass {@link validateToolUseInputShape}
 * (M1). Throws {@link M3LBedrockRuntimeOperationError} on the first violation
 * found, using the catalog's default classification (matching `client.ts`'s
 * sibling all-malformed throw — no per-instance override).
 */
export function validateToolUseBatch(
  blocks: readonly M3LBedrockToolUseBlock[],
): void {
  const seenIds = new Set<string>();
  for (const block of blocks) {
    if (block.toolUseId.length === 0) {
      throw new M3LBedrockRuntimeOperationError(
        "a toolUse block is missing its toolUseId",
      );
    }
    if (seenIds.has(block.toolUseId)) {
      throw new M3LBedrockRuntimeOperationError(
        `duplicate toolUseId "${sanitizeForMessage(block.toolUseId)}" within one turn`,
      );
    }
    seenIds.add(block.toolUseId);
    if (block.name.length === 0) {
      throw new M3LBedrockRuntimeOperationError(
        `toolUse block "${sanitizeForMessage(block.toolUseId)}" is missing its name`,
      );
    }
    validateToolUseInputShape(block);
  }
}

/** One tool call's dispatch outcome: its ledger entry plus the `toolResult` block to send back. */
interface ToolDispatchOutcome {
  readonly execution: M3LBedrockToolExecution;
  readonly resultBlock: M3LBedrockToolResultBlock;
}

/** Builds the `status: "error"` disposition for a `toolUse` block naming no registered tool — a model-input disposition, never a handler failure, so it carries no `cause`. */
function unknownToolDisposition(
  block: M3LBedrockToolUseBlock,
): ToolDispatchOutcome {
  return {
    execution: {
      toolUseId: block.toolUseId,
      name: block.name,
      status: "error",
    },
    resultBlock: {
      type: "toolResult",
      toolUseId: block.toolUseId,
      content: [
        {
          type: "text",
          text: `no tool named "${sanitizeForMessage(block.name)}" is registered`,
        },
      ],
      status: "error",
    },
  };
}

/** Builds the `status: "error"` disposition for a `toolUse` block whose `input` is not a plain object — never dispatched to a handler, so it carries no `cause`. */
function malformedInputDisposition(
  block: M3LBedrockToolUseBlock,
): ToolDispatchOutcome {
  return {
    execution: {
      toolUseId: block.toolUseId,
      name: block.name,
      status: "error",
    },
    resultBlock: {
      type: "toolResult",
      toolUseId: block.toolUseId,
      content: [
        {
          type: "text",
          text: `tool "${sanitizeForMessage(block.name)}" received a non-object input`,
        },
      ],
      status: "error",
    },
  };
}

/**
 * Dispatches ONE `toolUse` block: resolves the registry, guards `input`,
 * checks the abort signal immediately before the actual handler call (Check
 * 2 — `invoke()` provably never re-checks the signal after its own SDK call
 * resolves, so this is the only place a mid-batch cancel is ever observed),
 * and classifies the outcome.
 *
 * A handler rejection whose value is an `M3LOperationAbortedError` — or that
 * is itself an SDK/`fetch`-shaped `AbortError` (`isAbortError`) while the
 * loop's own `signal` has already aborted — is rethrown unwrapped, never
 * converted into a `status: "error"` toolResult — continuing the loop past a
 * cancellation would be wrong regardless of which specific awaited call
 * observed it first. An ORDINARY handler rejection that merely happens to
 * race an unrelated `signal` abort (a shared `AbortController` across
 * concurrent operations) is NOT reclassified this way — see the `catch`
 * block's own comment (M3, 2026-08 security pass).
 */
async function dispatchToolUse(
  block: M3LBedrockToolUseBlock,
  tools: M3LBedrockToolRegistry,
  signal: AbortSignal | undefined,
): Promise<ToolDispatchOutcome> {
  const registration = tools.get(block.name);
  if (registration === undefined) {
    return unknownToolDisposition(block);
  }
  if (!isPlainObject(block.input)) {
    return malformedInputDisposition(block);
  }

  // Check 2 — immediately before every handler dispatch, including the
  // first. `invoke()`'s own abort check (`client.ts:356-425`) never re-fires
  // after its SDK call resolves, and handlers drive real, side-effectful AWS
  // mutations, so this is load-bearing, not redundant with Check 1.
  if (isAborted(signal)) {
    throw new M3LOperationAbortedError();
  }

  const context: M3LBedrockToolContext = {
    toolUseId: block.toolUseId,
    name: block.name,
    ...(signal !== undefined && { signal }),
  };

  try {
    const content = await registration.handler(block.input, context);
    return {
      execution: {
        toolUseId: block.toolUseId,
        name: block.name,
        status: "success",
      },
      resultBlock: { type: "toolResult", toolUseId: block.toolUseId, content },
    };
  } catch (cause) {
    // Already-typed abort: rethrow unchanged, never re-wrapped (checked
    // first, independent of `signal`, exactly like `client.ts:422`).
    if (cause instanceof M3LOperationAbortedError) {
      throw cause;
    }
    // `signal.aborted && isAbortError(cause)` — NOT `isAborted(signal)`
    // alone (M3, 2026-08 security pass): a shared `AbortController` across
    // concurrent operations means the signal can be aborted for a reason
    // that has nothing to do with THIS handler's rejection, and reclassifying
    // every rejection racing an unrelated cancel into a contentless
    // `M3LOperationAbortedError` (which structurally carries no `cause`)
    // would make a genuine handler fault — e.g. `AccessDeniedException` —
    // permanently unrecoverable. Matches `client.ts:423`'s exact precedent
    // for `invoke()`'s own SDK-call rejections. Do NOT restore a
    // signal-only or `instanceof`-only check: a handler that itself honors
    // `signal` (e.g. `fetch(url, { signal })`, an AWS SDK call) rejects with
    // a DOMException-shaped `AbortError`, which `isAbortError` recognizes —
    // dropping this clause would let that cancellation surface as an
    // ordinary `status: "error"` toolResult and the loop would continue past
    // it.
    if (isAborted(signal) && isAbortError(cause)) {
      throw new M3LOperationAbortedError();
    }
    return {
      execution: {
        toolUseId: block.toolUseId,
        name: block.name,
        status: "error",
        cause,
      },
      resultBlock: {
        type: "toolResult",
        toolUseId: block.toolUseId,
        content: [{ type: "text", text: describeToolFailure(cause) }],
        status: "error",
      },
    };
  }
}

/**
 * Max length one {@link describeToolFailure}-rendered `toolResult` text is
 * allowed before truncation — wider than `sanitizeForMessage`'s 100-char
 * default (an internal-facing `M3LError.message` segment): this text is
 * conversational content shown to the MODEL, which reasonably benefits from
 * more diagnostic detail than an error message does (M2, 2026-08 security
 * pass).
 */
const MAX_TOOL_FAILURE_MESSAGE_LENGTH = 1024;

/**
 * Renders a handler rejection's reason as text for the `toolResult` sent
 * back to the model. This text reaches Bedrock verbatim on the next turn, so
 * it is routed through {@link sanitizeForMessage} (control characters
 * escaped, capped at {@link MAX_TOOL_FAILURE_MESSAGE_LENGTH} code points, a
 * truncation marker appended) exactly like every other caller/model string
 * this module sends outbound (M2, 2026-08 security pass: an unsanitized,
 * uncapped rejection message previously let a secret embedded in a handler's
 * `Error.message` reach the wire verbatim, let a 5 MB message balloon the
 * request body, and let raw ANSI/RLO control characters pass through
 * unescaped). {@link M3LBedrockToolHandler}'s own doc comment warns callers
 * that a rejection's message is transmitted to the model — this sanitizes
 * the TRANSPORT-level hazards (log/terminal injection, unbounded size), it
 * does not and cannot redact application-level secrets a handler chooses to
 * throw.
 */
function describeToolFailure(cause: unknown): string {
  const rendered =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "tool call failed";
  return sanitizeForMessage(rendered, MAX_TOOL_FAILURE_MESSAGE_LENGTH);
}

/**
 * Dispatches every `toolUse` block in one turn strictly **sequentially**, in
 * block order — never `Promise.all`, which would let sibling handlers keep
 * mutating AWS state after one has already rejected, and would surface any
 * discarded sibling rejection as an unhandled promise rejection.
 */
export async function dispatchToolUseTurn(
  blocks: readonly M3LBedrockToolUseBlock[],
  tools: M3LBedrockToolRegistry,
  signal: AbortSignal | undefined,
): Promise<{
  readonly executions: readonly M3LBedrockToolExecution[];
  readonly resultBlocks: readonly M3LBedrockToolResultBlock[];
}> {
  const executions: M3LBedrockToolExecution[] = [];
  const resultBlocks: M3LBedrockToolResultBlock[] = [];
  for (const block of blocks) {
    const outcome = await dispatchToolUse(block, tools, signal);
    executions.push(outcome.execution);
    resultBlocks.push(outcome.resultBlock);
  }
  return { executions, resultBlocks };
}
