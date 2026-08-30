/**
 * `aws/bedrock-runtime/loop` — the tool-use loop (`runBedrockToolLoop`) that
 * drives repeated {@link M3LBedrockToolLoopInvoker.invoke} calls against a
 * caller-registered {@link M3LBedrockToolRegistry}, dispatching every
 * model-requested tool call to its handler and feeding the results back until
 * the model reaches a terminal `stopReason` or a configured ceiling fires.
 *
 * `runBedrockToolLoop` is a **free function**, not a method on
 * {@link M3LBedrockRuntimeOperations} — that class declares private fields
 * (`#client`/`#models`/`#invokeOnModel`) and is therefore nominally typed, so
 * a hand-rolled structural fake (exactly what every test in
 * `tests/bedrock-runtime-loop.test.ts` uses) is not assignable to it
 * (TS2345). The narrow {@link M3LBedrockToolLoopInvoker} port accepts both
 * the fake and the real class (V5 Slice B contract §3).
 *
 * @packageDocumentation
 */

import { M3LOperationAbortedError } from "../../core/errors/index.js";

import {
  M3LBedrockRuntimeOperationError,
  M3LBedrockToolLoopError,
} from "./error.js";
import { readCallerValue, requireCallerArray } from "./document.js";
import { isAborted } from "./shared.js";
import { sanitizeForMessage } from "./message-safety.js";
import {
  dispatchToolUseTurn,
  filterToolUseBlocks,
  validateToolUseBatch,
} from "./tool-dispatch.js";
import {
  computeCost,
  countToolErrors,
  requireLastIteration,
  sumUsage,
} from "./tool-ledger.js";
import type {
  M3LBedrockInferenceConfig,
  M3LBedrockInvocationResult,
  M3LBedrockInvokeOptions,
  M3LBedrockMessage,
  M3LBedrockStopReason,
  M3LBedrockTokenUsage,
  M3LBedrockToolDefinition,
  M3LBedrockToolInvokeRequest,
  M3LBedrockToolUseBlock,
} from "./types.js";
import type { M3LBedrockConversation } from "./conversation.js";
import type { M3LBedrockToolRegistry } from "./tool-dispatch.js";
import type {
  M3LBedrockModelRate,
  M3LBedrockToolLoopIteration,
  M3LBedrockToolLoopOutcome,
} from "./tool-ledger.js";

export type {
  M3LBedrockToolContext,
  M3LBedrockToolHandler,
  M3LBedrockToolRegistration,
  M3LBedrockToolRegistry,
} from "./tool-dispatch.js";
export type {
  M3LBedrockModelRate,
  M3LBedrockToolExecution,
  M3LBedrockToolLoopIteration,
  M3LBedrockToolLoopOutcome,
} from "./tool-ledger.js";

/** Default `maxIterations` (V5 Slice B contract §5): each iteration is a paid, latency-bearing model call, unlike `core/procedure`'s free in-process steps — hence far lower than that module's `100`. */
const DEFAULT_MAX_ITERATIONS = 10;

/** Default `maxToolsPerTurn` (V5 Slice B contract §5). */
const DEFAULT_MAX_TOOLS_PER_TURN = 8;

/**
 * Options for {@link runBedrockToolLoop}.
 *
 * `toolChoice` is deliberately absent (V5 Slice B contract C6): a persisted
 * `"any"` would force a tool call every turn, making `end_turn` unreachable
 * and turning `maxIterations` from a safety net into the loop's normal exit
 * path.
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolLoopOptions } from "@m3l-automation/m3l-common/aws";
 *
 * const options: M3LBedrockToolLoopOptions = {
 *   tools: new Map(),
 *   maxIterations: 5,
 * };
 * ```
 */
export interface M3LBedrockToolLoopOptions {
  /** The tools the model may call. Required — pass an empty `Map` for a tool-free run. */
  readonly tools: M3LBedrockToolRegistry;
  /** Iteration ceiling; defaults to `10`. Must be a positive integer (`Infinity` is rejected). */
  readonly maxIterations?: number;
  /** Per-turn tool-call ceiling; defaults to `8`. Must be a positive integer. */
  readonly maxToolsPerTurn?: number;
  /** Optional `AbortSignal` for cooperative cancellation, checked before every invoke and every handler dispatch. */
  readonly signal?: AbortSignal;
  /** Optional per-model pricing, keyed by `modelId`, used to populate {@link M3LBedrockToolLoopOutcome.cost}. */
  readonly rates?: ReadonlyMap<string, M3LBedrockModelRate>;
  /** Optional inference tuning parameters, forwarded unchanged on every iteration's invoke. */
  readonly inferenceConfig?: M3LBedrockInferenceConfig;
}

/**
 * The port {@link runBedrockToolLoop} drives — deliberately narrower than
 * {@link M3LBedrockRuntimeOperations}, whose private fields make it nominally
 * typed and therefore unusable with a hand-rolled structural fake (V5 Slice B
 * contract §3, Q4). `M3LBedrockRuntimeOperations` satisfies this interface
 * structurally, so passing the real class works unchanged.
 *
 * @example
 * ```ts
 * import type { M3LBedrockToolLoopInvoker } from "@m3l-automation/m3l-common/aws";
 *
 * declare const ops: M3LBedrockToolLoopInvoker;
 * const result = await ops.invoke({ messages: [] });
 * ```
 */
export interface M3LBedrockToolLoopInvoker {
  /** Performs one Converse call. See {@link M3LBedrockRuntimeOperations.invoke}. */
  invoke(
    request: M3LBedrockToolInvokeRequest,
    options?: M3LBedrockInvokeOptions,
  ): Promise<M3LBedrockInvocationResult>;
}

/** Rejects a ceiling option that fails `Number.isInteger(n) && n >= 1` — `Infinity` included, so "no ceiling" is unrepresentable. */
function validatePositiveIntegerCeiling(
  value: number,
  fieldName: string,
): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new M3LBedrockRuntimeOperationError(
      `${fieldName} must be a positive integer, got ${String(value)}`,
      { origin: "caller", retryable: false },
    );
  }
  return value;
}

/**
 * Exhaustive over the nine-member {@link M3LBedrockStopReason} union: `true`
 * only for `"tool_use"`. AWS's Smithy enum is open at the wire level, but by
 * the time `invoke()` returns successfully the value has already been
 * validated against the closed set (`client.ts`'s `STOP_REASON_LOOKUP`), so
 * the `default` arm here is a compile-time-`never` safety net, not a
 * reachable runtime path.
 */
function isContinuingStopReason(stopReason: M3LBedrockStopReason): boolean {
  switch (stopReason) {
    case "tool_use":
      return true;
    case "end_turn":
    case "max_tokens":
    case "stop_sequence":
    case "guardrail_intervened":
    case "content_filtered":
    case "malformed_tool_use":
    case "malformed_model_output":
    case "model_context_window_exceeded":
      return false;
    default: {
      const exhaustive: never = stopReason;
      throw new M3LBedrockRuntimeOperationError(
        `unhandled Bedrock stop reason: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Maps a {@link M3LBedrockToolRegistry} into the Converse request's `tools`
 * array, or `[]` when the registry is empty (the caller omits `tools`
 * entirely for an empty array, per {@link M3LBedrockToolInvokeRequest.tools}'s
 * own contract).
 *
 * The whole body runs through {@link readCallerValue} (S2, 2026-08 security
 * pass): `tools` is caller-supplied and only *typed* as
 * {@link M3LBedrockToolRegistry} (a `ReadonlyMap`) — a caller passing
 * `undefined`/`null`/a plain `{}` makes the `for...of` below throw a raw,
 * un-typed `TypeError` ("tools is not iterable") that previously escaped the
 * public boundary unwrapped. `readCallerValue` re-throws anything that isn't
 * already this module's typed error as {@link M3LBedrockRuntimeOperationError}
 * (`origin: "caller"`, `retryable: false`), matching every other
 * caller-supplied-value read in this submodule.
 */
function buildToolDefinitions(
  tools: M3LBedrockToolRegistry,
): readonly M3LBedrockToolDefinition[] {
  return readCallerValue(() => {
    const definitions: M3LBedrockToolDefinition[] = [];
    for (const [name, registration] of tools) {
      definitions.push({
        name,
        ...(registration.description !== undefined && {
          description: registration.description,
        }),
        inputSchema: registration.inputSchema,
      });
    }
    return definitions;
  }, "options.tools");
}

/**
 * Check 1 — before each invoke, abort checked BEFORE the ceiling: a signal
 * that fires exactly as `maxIterations` is reached must report
 * `M3LOperationAbortedError`, never `M3LBedrockToolLoopError` (V5 Slice B
 * contract §5, "abort beats ceiling").
 */
function enforceIterationCeiling(
  signal: AbortSignal | undefined,
  index: number,
  maxIterations: number,
  iterations: readonly M3LBedrockToolLoopIteration[],
  cumulativeUsage: M3LBedrockTokenUsage,
): void {
  if (isAborted(signal)) {
    throw new M3LOperationAbortedError();
  }
  if (index <= maxIterations) {
    return;
  }
  const last = requireLastIteration(iterations);
  throw new M3LBedrockToolLoopError(
    `tool-use loop exceeded maxIterations (${maxIterations}) with the model still requesting tools`,
    {
      maxIterations,
      iterationsCompleted: iterations.length,
      lastStopReason: last.stopReason,
      usage: cumulativeUsage,
      modelId: last.modelId,
      pendingToolCount: 0,
      toolErrorCount: countToolErrors(iterations),
    },
  );
}

/** Builds one iteration's Converse request (never `toolChoice`, C6) and performs the invoke. */
function invokeIteration(
  ops: M3LBedrockToolLoopInvoker,
  messages: readonly M3LBedrockMessage[],
  system: string | undefined,
  inferenceConfig: M3LBedrockToolInvokeRequest["inferenceConfig"],
  toolDefinitions: readonly M3LBedrockToolDefinition[],
  signal: AbortSignal | undefined,
): Promise<M3LBedrockInvocationResult> {
  const request: M3LBedrockToolInvokeRequest = {
    messages,
    ...(system !== undefined && { system }),
    ...(inferenceConfig !== undefined && { inferenceConfig }),
    ...(toolDefinitions.length > 0 && { tools: toolDefinitions }),
  };
  const invokeOptions: M3LBedrockInvokeOptions = {
    ...(signal !== undefined && { signal }),
  };
  return ops.invoke(request, invokeOptions);
}

/**
 * V5 Slice B contract C2: `invoke()` already throws
 * {@link M3LBedrockRuntimeOperationError} when a `tool_use` reply's
 * toolUse-shaped blocks were all malformed — this is the loop's OWN arm,
 * reachable only when the reply carried zero toolUse-shaped blocks at all
 * (a text-only reply with `stopReason: "tool_use"`).
 */
function ensureToolUseContentPresent(
  stopReason: M3LBedrockStopReason,
  toolUseBlockCount: number,
  modelId: string,
): void {
  if (stopReason === "tool_use" && toolUseBlockCount === 0) {
    throw new M3LBedrockRuntimeOperationError(
      `the model's reply for model ${sanitizeForMessage(modelId)} carried stopReason "tool_use" but no toolUse-shaped content blocks`,
    );
  }
}

/**
 * Throws {@link M3LBedrockToolLoopError} when one turn's tool-call batch
 * exceeds `maxToolsPerTurn` — before any handler in that turn runs.
 *
 * Pushes THIS iteration's own ledger entry (empty `toolExecutions`, since no
 * handler ever ran) BEFORE throwing (S1, 2026-08 security-pass follow-up):
 * `cumulativeUsage` (passed in as `nextUsage` by `performIteration`) already
 * folds in this iteration's tokens, so `iterationsCompleted` must count this
 * iteration too, or the two fields disagree by exactly one invoke — see
 * {@link M3LBedrockToolLoopError}'s own doc comment for the convention this
 * establishes: "completed" means "performed an `invoke()` round-trip",
 * independent of whether the ensuing tool dispatch was allowed to proceed.
 */
function enforceToolsPerTurnCeiling(
  toolUseBlockCount: number,
  maxToolsPerTurn: number,
  maxIterations: number,
  index: number,
  iterations: M3LBedrockToolLoopIteration[],
  cumulativeUsage: M3LBedrockTokenUsage,
  result: M3LBedrockInvocationResult,
): void {
  if (toolUseBlockCount <= maxToolsPerTurn) {
    return;
  }
  iterations.push({
    index,
    modelId: result.modelId,
    stopReason: result.stopReason,
    usage: result.usage,
    toolExecutions: [],
  });
  throw new M3LBedrockToolLoopError(
    `tool-use turn requested ${toolUseBlockCount} tool call(s), exceeding maxToolsPerTurn (${maxToolsPerTurn})`,
    {
      maxIterations,
      iterationsCompleted: iterations.length,
      lastStopReason: result.stopReason,
      usage: cumulativeUsage,
      modelId: result.modelId,
      pendingToolCount: toolUseBlockCount,
      toolErrorCount: countToolErrors(iterations),
    },
  );
}

/** Builds the final {@link M3LBedrockToolLoopOutcome} once a terminal (non-`tool_use`) iteration is reached. */
function buildTerminalOutcome(
  messages: readonly M3LBedrockMessage[],
  system: string | undefined,
  iterations: readonly M3LBedrockToolLoopIteration[],
  cumulativeUsage: M3LBedrockTokenUsage,
  result: M3LBedrockInvocationResult,
  rates: ReadonlyMap<string, M3LBedrockModelRate> | undefined,
): M3LBedrockToolLoopOutcome {
  const cost = computeCost(iterations, rates);
  return {
    conversation: {
      messages,
      ...(system !== undefined && { system }),
    },
    message: result.message,
    stopReason: result.stopReason,
    usage: cumulativeUsage,
    iterations,
    ...(cost !== undefined && { cost }),
  };
}

/**
 * Per-run values that never change across iterations, grouped to keep
 * {@link performIteration}'s own parameter count sane.
 *
 * Holds only the FIELDS each downstream function actually reads —
 * `tools`/`signal`/`rates`/`inferenceConfig` — never the raw `options` object
 * itself (S4, 2026-08 security-pass follow-up): the ceiling fields
 * (`maxIterations`/`maxToolsPerTurn`) are already validated/defaulted copies
 * living alongside these; embedding the unvalidated `options` object too let
 * a future edit reach for `context.options.maxIterations` and silently get
 * the un-defaulted, unvalidated raw value instead.
 */
interface LoopRunContext {
  readonly ops: M3LBedrockToolLoopInvoker;
  readonly conversation: M3LBedrockConversation;
  readonly toolDefinitions: readonly M3LBedrockToolDefinition[];
  readonly maxIterations: number;
  readonly maxToolsPerTurn: number;
  readonly tools: M3LBedrockToolRegistry;
  readonly signal: AbortSignal | undefined;
  readonly rates: ReadonlyMap<string, M3LBedrockModelRate> | undefined;
  readonly inferenceConfig: M3LBedrockInferenceConfig | undefined;
}

/** One iteration's outcome: either the run is over, or the next iteration should proceed with the returned `messages`/`cumulativeUsage`. */
type IterationStep =
  | { readonly kind: "done"; readonly outcome: M3LBedrockToolLoopOutcome }
  | {
      readonly kind: "continue";
      readonly messages: readonly M3LBedrockMessage[];
      readonly cumulativeUsage: M3LBedrockTokenUsage;
    };

/** Finalizes the outcome for a terminal (non-`tool_use`) iteration: pushes its ledger entry and builds the returned {@link M3LBedrockToolLoopOutcome}. */
function finishTerminalIteration(
  index: number,
  messages: readonly M3LBedrockMessage[],
  system: string | undefined,
  iterations: M3LBedrockToolLoopIteration[],
  cumulativeUsage: M3LBedrockTokenUsage,
  result: M3LBedrockInvocationResult,
  rates: ReadonlyMap<string, M3LBedrockModelRate> | undefined,
): IterationStep {
  const finalMessages = [...messages, result.message];
  iterations.push({
    index,
    modelId: result.modelId,
    stopReason: result.stopReason,
    usage: result.usage,
    toolExecutions: [],
  });
  return {
    kind: "done",
    outcome: buildTerminalOutcome(
      finalMessages,
      system,
      iterations,
      cumulativeUsage,
      result,
      rates,
    ),
  };
}

/** Enforces the per-turn tool-batch ceiling, validates the batch, dispatches every tool call, and pushes this iteration's ledger entry — the whole `tool_use`-continuing path for one iteration. */
async function continueWithToolUseTurn(
  context: LoopRunContext,
  index: number,
  messages: readonly M3LBedrockMessage[],
  iterations: M3LBedrockToolLoopIteration[],
  cumulativeUsage: M3LBedrockTokenUsage,
  toolUseBlocks: readonly M3LBedrockToolUseBlock[],
  result: M3LBedrockInvocationResult,
): Promise<IterationStep> {
  const { maxIterations, maxToolsPerTurn, tools, signal } = context;
  enforceToolsPerTurnCeiling(
    toolUseBlocks.length,
    maxToolsPerTurn,
    maxIterations,
    index,
    iterations,
    cumulativeUsage,
    result,
  );
  validateToolUseBatch(toolUseBlocks);

  const { executions, resultBlocks } = await dispatchToolUseTurn(
    toolUseBlocks,
    tools,
    signal,
  );
  iterations.push({
    index,
    modelId: result.modelId,
    stopReason: result.stopReason,
    usage: result.usage,
    toolExecutions: executions,
  });

  return {
    kind: "continue",
    messages: [
      ...messages,
      result.message,
      { role: "user", content: resultBlocks },
    ],
    cumulativeUsage,
  };
}

/**
 * Performs exactly one invoke-and-classify round: builds and sends this
 * iteration's request, then either finalizes the outcome (a terminal
 * `stopReason`) or continues into the requested tool batch. Mutates
 * `iterations` by pushing (via {@link finishTerminalIteration}/
 * {@link continueWithToolUseTurn}) — a method call, not a property
 * reassignment, so `no-param-reassign` does not apply — the caller's own
 * `messages`/`cumulativeUsage` bindings are otherwise only ever updated via
 * this function's return value, never in place.
 */
async function performIteration(
  context: LoopRunContext,
  index: number,
  messages: readonly M3LBedrockMessage[],
  cumulativeUsage: M3LBedrockTokenUsage,
  iterations: M3LBedrockToolLoopIteration[],
): Promise<IterationStep> {
  const { ops, conversation, toolDefinitions, signal, inferenceConfig, rates } =
    context;
  const result = await invokeIteration(
    ops,
    messages,
    conversation.system,
    inferenceConfig,
    toolDefinitions,
    signal,
  );
  const nextUsage = sumUsage(cumulativeUsage, result.usage);
  const toolUseBlocks = filterToolUseBlocks(result.message.content);
  ensureToolUseContentPresent(
    result.stopReason,
    toolUseBlocks.length,
    result.modelId,
  );

  if (!isContinuingStopReason(result.stopReason)) {
    return finishTerminalIteration(
      index,
      messages,
      conversation.system,
      iterations,
      nextUsage,
      result,
      rates,
    );
  }

  return continueWithToolUseTurn(
    context,
    index,
    messages,
    iterations,
    nextUsage,
    toolUseBlocks,
    result,
  );
}

/**
 * Drives {@link M3LBedrockToolLoopInvoker.invoke} in a loop, dispatching
 * every model-requested tool call to its registered handler and feeding the
 * results back, until the model reaches a terminal `stopReason` or a
 * configured ceiling fires.
 *
 * Never sends `toolChoice` (V5 Slice B contract C6). Never mutates
 * `conversation`; the returned outcome's `conversation` is a wholly new
 * value.
 *
 * Exactly two loop-owned abort checks, in this order every iteration:
 * **before each invoke** (abort beats a simultaneous ceiling breach — an
 * operator cancel must report `M3LOperationAbortedError`, not a caller-origin
 * ceiling failure, when both fire on the same iteration boundary), and
 * **immediately before every handler dispatch**, including the first, since
 * `invoke()` never re-checks the signal after its own SDK call resolves.
 *
 * @param ops - The port performing each Converse call.
 * @param conversation - The conversation to continue from. Never mutated.
 * @param options - Tool registry, ceilings, `signal`, `rates`, and
 *   `inferenceConfig`.
 * @returns The final outcome once a terminal `stopReason` is reached.
 * @throws {@link M3LOperationAbortedError} When `options.signal` fires (or a
 *   handler itself throws it), before or during any iteration.
 * @throws {@link M3LBedrockRuntimeOperationError} For an invalid
 *   `maxIterations`/`maxToolsPerTurn`, a malformed tool-use reply (missing/
 *   duplicate `toolUseId`, missing `name`), or a `tool_use` reply carrying no
 *   toolUse-shaped content blocks at all.
 * @throws {@link M3LBedrockToolLoopError} When `maxIterations` is reached with
 *   the model still requesting tools, or one turn's tool-call batch exceeds
 *   `maxToolsPerTurn`.
 * @example
 * ```ts
 * import { runBedrockToolLoop } from "@m3l-automation/m3l-common/aws";
 * import type {
 *   M3LBedrockToolLoopInvoker,
 *   M3LBedrockToolRegistration,
 * } from "@m3l-automation/m3l-common/aws";
 *
 * declare const ops: M3LBedrockToolLoopInvoker;
 * const getWeather: M3LBedrockToolRegistration = {
 *   inputSchema: {},
 *   handler: async () => [{ type: "text", text: "sunny" }],
 * };
 *
 * const outcome = await runBedrockToolLoop(
 *   ops,
 *   { messages: [{ role: "user", content: [{ type: "text", text: "weather?" }] }] },
 *   { tools: new Map([["get_weather", getWeather]]) },
 * );
 * console.log(outcome.stopReason);
 * ```
 */
export async function runBedrockToolLoop(
  ops: M3LBedrockToolLoopInvoker,
  conversation: M3LBedrockConversation,
  options: M3LBedrockToolLoopOptions,
): Promise<M3LBedrockToolLoopOutcome> {
  const maxIterations = validatePositiveIntegerCeiling(
    options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    "maxIterations",
  );
  const maxToolsPerTurn = validatePositiveIntegerCeiling(
    options.maxToolsPerTurn ?? DEFAULT_MAX_TOOLS_PER_TURN,
    "maxToolsPerTurn",
  );
  const context: LoopRunContext = {
    ops,
    conversation,
    toolDefinitions: buildToolDefinitions(options.tools),
    maxIterations,
    maxToolsPerTurn,
    tools: options.tools,
    signal: options.signal,
    rates: options.rates,
    inferenceConfig: options.inferenceConfig,
  };

  // `conversation` itself is caller-supplied and only *typed* as
  // `M3LBedrockConversation` — a `null`/`undefined` conversation (or any
  // non-object masquerading as one) makes the property read below throw a
  // raw `TypeError` ("Cannot read properties of ... (reading 'messages')"),
  // which previously escaped this public boundary unwrapped (review
  // follow-up, 2026-08-30 — the same class of gap S2 already closed for
  // `tools`/`messages`, finished here for the containing object).
  // `readCallerValue` catches that and re-throws
  // {@link M3LBedrockRuntimeOperationError} (`origin: "caller"`) instead;
  // `conversation.messages` is then, additionally, only *typed* as an
  // array — a duck-typed `{ length: 2 }` value spread with `[...x]` throws
  // its own raw `TypeError` ("x is not iterable"), so `requireCallerArray`
  // guards that separately. No defensive copy is needed since `messages` is
  // only ever reassigned (never mutated in place) from here on.
  const rawMessages = readCallerValue(
    () => conversation.messages,
    "conversation.messages",
  );
  let messages: readonly M3LBedrockMessage[] =
    requireCallerArray<M3LBedrockMessage>(rawMessages, "conversation.messages");
  const iterations: M3LBedrockToolLoopIteration[] = [];
  let cumulativeUsage: M3LBedrockTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  for (let index = 1; ; index += 1) {
    enforceIterationCeiling(
      options.signal,
      index,
      maxIterations,
      iterations,
      cumulativeUsage,
    );

    const step = await performIteration(
      context,
      index,
      messages,
      cumulativeUsage,
      iterations,
    );
    if (step.kind === "done") {
      return step.outcome;
    }
    messages = step.messages;
    cumulativeUsage = step.cumulativeUsage;
  }
}
