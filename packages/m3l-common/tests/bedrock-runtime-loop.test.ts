/**
 * Tests for aws/bedrock-runtime's tool-use loop (V5 Slice B).
 *
 * Contract source: `<scratchpad>/slice-b/contract.md` §2.2-2.5 (Mode 1
 * contract, re-derived against live Slice A code + ADR-0059), authoritative
 * over `docs/plans/2026-08-29-v5-tool-use-loop-primitives.md` § "Slice B"
 * where they differ (see contract §4, C1-C7).
 *
 * Deliberately imports ONLY the loop symbols (`runBedrockToolLoop`,
 * `M3LBedrockToolLoopError`, and the loop-scoped types) plus
 * `M3LBedrockRuntimeOperationError` (the sibling caller-error class several
 * loop dispositions route through, per contract C2/C5) and pre-existing V4
 * base types — no `createBedrockConversation`/`appendBedrockMessage`/
 * `appendBedrockUserText` (conversation fixtures below are plain object
 * literals) — so `perFile` v8 coverage binds within this slice
 * (`vitest.config.ts:73`) and this file stays independent of
 * `tests/bedrock-runtime-conversation.test.ts`.
 *
 * `runBedrockToolLoop` takes a **port** (`M3LBedrockToolLoopInvoker`), not
 * the concrete nominally-typed `M3LBedrockRuntimeOperations` class (contract
 * §3, Q4: a hand-rolled structural fake is NOT assignable to the concrete
 * class — verified TS2345). Every fixture below is a two-line `{ invoke }`
 * fake against that port; none of these tests construct a real
 * `BedrockRuntimeClient` or mock `@aws-sdk/client-bedrock-runtime`.
 *
 * This is the TDD RED seam: `runBedrockToolLoop`, `M3LBedrockToolLoopError`,
 * and every loop-scoped type do not exist in `src/` yet — every test here is
 * expected to fail on import/typecheck, not on an assertion inside a
 * running test.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { inspect } from "node:util";

import {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeNoModelError,
  M3LBedrockRuntimeOperationError,
  M3LBedrockToolLoopError,
  runBedrockToolLoop,
} from "../src/aws/index.js";
import type {
  M3LBedrockConversation,
  M3LBedrockInvocationResult,
  M3LBedrockMessage,
  M3LBedrockModelRate,
  M3LBedrockStopReason,
  M3LBedrockToolContext,
  M3LBedrockToolHandler,
  M3LBedrockToolInvokeRequest,
  M3LBedrockToolLoopInvoker,
  M3LBedrockToolLoopOptions,
  M3LBedrockToolLoopOutcome,
  M3LBedrockToolRegistration,
  M3LBedrockToolRegistry,
  M3LBedrockToolResultContent,
  M3LBedrockTokenUsage,
} from "../src/aws/index.js";
// Aliased so the barrel/submodule reachability test can compare this type
// against the identically-named one re-exported through the aws barrel
// above, without a name collision.
import type { M3LBedrockToolLoopOutcome as M3LBedrockToolLoopOutcomeFromSubmodule } from "../src/aws/bedrock-runtime/index.js";
import {
  formatErrorChain,
  serializeErrorChain,
} from "../src/core/diagnostics/format-error.js";
import {
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";

const MODEL = "anthropic.claude-sonnet-5";

const USAGE_1: M3LBedrockTokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
};

const TEXT_RESULT: readonly M3LBedrockToolResultContent[] = [
  { type: "text", text: "42 degrees" },
];

const BASE_CONVERSATION: M3LBedrockConversation = {
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

/** Builds a fixture `M3LBedrockInvocationResult` with sensible defaults. */
function invocationResult(
  stopReason: M3LBedrockStopReason,
  content: M3LBedrockMessage["content"],
  options?: {
    readonly usage?: M3LBedrockTokenUsage;
    readonly modelId?: string;
  },
): M3LBedrockInvocationResult {
  return {
    modelId: options?.modelId ?? MODEL,
    message: { role: "assistant", content },
    stopReason,
    usage: options?.usage ?? USAGE_1,
  };
}

/**
 * A recording fake satisfying `M3LBedrockToolLoopInvoker`, replaying a fixed
 * queue of results. Declares its own `invoke` member (rather than
 * `extends M3LBedrockToolLoopInvoker`) so the shape is checked structurally
 * at each `runBedrockToolLoop(invoker, ...)` call site instead of via
 * nominal inheritance from a type this slice hasn't shipped yet.
 */
interface RecordingInvoker {
  readonly requests: M3LBedrockToolInvokeRequest[];
  invoke(
    request: M3LBedrockToolInvokeRequest,
  ): Promise<M3LBedrockInvocationResult>;
}

function queueInvoker(
  results: readonly M3LBedrockInvocationResult[],
): RecordingInvoker {
  const requests: M3LBedrockToolInvokeRequest[] = [];
  let index = 0;
  return {
    requests,
    invoke(request: M3LBedrockToolInvokeRequest) {
      requests.push(request);
      const result = results[index];
      index += 1;
      if (result === undefined) {
        return Promise.reject(
          new Error(`queueInvoker exhausted after ${index} call(s)`),
        );
      }
      return Promise.resolve(result);
    },
  };
}

function toolRegistry(
  entries: ReadonlyArray<readonly [string, M3LBedrockToolRegistration]>,
): M3LBedrockToolRegistry {
  return new Map<string, M3LBedrockToolRegistration>(entries);
}

function registration(
  handler: M3LBedrockToolHandler,
): M3LBedrockToolRegistration {
  return { inputSchema: {}, handler };
}

function handlerReturning(
  content: readonly M3LBedrockToolResultContent[],
): M3LBedrockToolHandler {
  return () => Promise.resolve(content);
}

/**
 * Runs a tool-use loop guaranteed to hit the default `maxIterations` (10)
 * ceiling with the model still requesting tools, and returns the resulting
 * `M3LBedrockToolLoopError` — shared by the catalog/barrel-reachability and
 * leak-audit groups below. `rejectMessage`, when supplied, makes every
 * `get_weather` call reject with an `Error` carrying that message (used to
 * plant a secret for the leak audit); otherwise every call succeeds.
 */
async function ceilingError(options?: {
  readonly rejectMessage?: string;
}): Promise<M3LBedrockToolLoopError> {
  const toolUseTurn = invocationResult("tool_use", [
    { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
  ]);
  const tools = toolRegistry([
    [
      "get_weather",
      registration(() =>
        options?.rejectMessage !== undefined
          ? Promise.reject(new Error(options.rejectMessage))
          : Promise.resolve(TEXT_RESULT),
      ),
    ],
  ]);
  const invoker = queueInvoker(Array.from({ length: 10 }, () => toolUseTurn));

  let thrown: unknown;
  try {
    await runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools });
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof M3LBedrockToolLoopError)) {
    throw new Error("expected ceilingError() to throw M3LBedrockToolLoopError");
  }
  return thrown;
}

// ---------------------------------------------------------------------------
// Batch 1, group "loop control flow" (6 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — control flow", () => {
  test("the port interface accepts a plain { invoke } fake, not only the concrete M3LBedrockRuntimeOperations class (contract §3 Q4)", () => {
    expectTypeOf(queueInvoker([])).toExtend<M3LBedrockToolLoopInvoker>();
  });

  test("happy path: end_turn on the first iteration resolves without calling any tool", async () => {
    const invoker = queueInvoker([
      invocationResult("end_turn", [{ type: "text", text: "hi there" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools: toolRegistry([]),
    });

    expect(outcome.stopReason).toBe("end_turn");
    expect(invoker.requests).toHaveLength(1);
    expect(outcome.iterations).toHaveLength(1);
    expect(outcome.iterations[0]).toMatchObject({
      index: 1,
      modelId: MODEL,
      stopReason: "end_turn",
      toolExecutions: [],
    });
    expect(outcome.usage).toEqual(USAGE_1);
    expect(outcome.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    });
    expect(Object.hasOwn(outcome, "cost")).toBe(false);
  });

  test("tool_use appends both the assistant toolUse turn and the toolResult turn before the next invoke", async () => {
    const calls: string[] = [];
    const tools = toolRegistry([
      [
        "get_weather",
        registration((_input: unknown, context: M3LBedrockToolContext) => {
          calls.push(context.toolUseId);
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(invoker.requests).toHaveLength(2);
    expect(calls).toEqual(["t1"]);

    const secondRequestMessages = invoker.requests[1]?.messages ?? [];
    // original user turn, appended assistant toolUse turn, appended user toolResult turn
    expect(secondRequestMessages).toHaveLength(3);
    expect(secondRequestMessages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ],
    });
    expect(secondRequestMessages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "toolResult",
          toolUseId: "t1",
          content: TEXT_RESULT,
        },
      ],
    });

    expect(outcome.iterations).toHaveLength(2);
    expect(outcome.iterations[0]?.toolExecutions).toEqual([
      { toolUseId: "t1", name: "get_weather", status: "success" },
    ]);
    expect(
      Object.hasOwn(outcome.iterations[0]?.toolExecutions[0] ?? {}, "cause"),
    ).toBe(false);
  });

  test("the input conversation is never mutated across a multi-iteration run (immutability)", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);
    const originalMessages = BASE_CONVERSATION.messages;

    await runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools });

    expect(BASE_CONVERSATION.messages).toBe(originalMessages);
    expect(BASE_CONVERSATION.messages).toHaveLength(1);
  });

  test("outcome.conversation includes the original messages plus every appended turn, in order", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.conversation.messages).toHaveLength(4);
    expect(outcome.conversation.messages[0]).toEqual(
      BASE_CONVERSATION.messages[0],
    );
    expect(outcome.conversation.messages[3]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  });

  test("inferenceConfig, when supplied, is forwarded unchanged on every iteration's invoke request", async () => {
    const inferenceConfig = { maxTokens: 256, temperature: 0.2 };
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
      inferenceConfig,
    });

    expect(invoker.requests).toHaveLength(2);
    expect(invoker.requests[0]?.inferenceConfig).toBe(inferenceConfig);
    expect(invoker.requests[1]?.inferenceConfig).toBe(inferenceConfig);
  });

  test("multiple tool calls within a single turn each appear in that iteration's toolExecutions, in block order", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
      ["get_time", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_time", input: {} },
        { type: "toolUse", toolUseId: "t2", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.iterations[0]?.toolExecutions).toEqual([
      { toolUseId: "t1", name: "get_time", status: "success" },
      { toolUseId: "t2", name: "get_weather", status: "success" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Batch 1, group "nine-stop-reason coverage" (11 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — exhaustive stopReason handling", () => {
  const STOP_REASON_CASES: ReadonlyArray<
    readonly [M3LBedrockStopReason, boolean]
  > = [
    ["end_turn", false],
    ["tool_use", true],
    ["max_tokens", false],
    ["stop_sequence", false],
    ["guardrail_intervened", false],
    ["content_filtered", false],
    ["malformed_tool_use", false],
    ["malformed_model_output", false],
    ["model_context_window_exceeded", false],
  ];

  test.each(STOP_REASON_CASES)(
    "stopReason %s → loop continues=%s",
    async (reason, continues) => {
      const handlerCalls: string[] = [];
      const tools = toolRegistry([
        [
          "get_weather",
          registration((_input: unknown, context: M3LBedrockToolContext) => {
            handlerCalls.push(context.toolUseId);
            return Promise.resolve(TEXT_RESULT);
          }),
        ],
      ]);
      const firstContent: M3LBedrockMessage["content"] =
        reason === "tool_use"
          ? [
              {
                type: "toolUse",
                toolUseId: "t1",
                name: "get_weather",
                input: {},
              },
            ]
          : [{ type: "text", text: "x" }];
      const results = continues
        ? [
            invocationResult(reason, firstContent),
            invocationResult("end_turn", [{ type: "text", text: "done" }]),
          ]
        : [invocationResult(reason, firstContent)];
      const invoker = queueInvoker(results);

      const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools,
      });

      expect(invoker.requests).toHaveLength(continues ? 2 : 1);
      expect(outcome.stopReason).toBe(continues ? "end_turn" : reason);
      expect(handlerCalls).toEqual(continues ? ["t1"] : []);
    },
  );

  test("stopReason is authoritative over content: a non-tool_use reason never executes a toolUse block in the same message", async () => {
    let called = false;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          called = true;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const content: M3LBedrockMessage["content"] = [
      { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
    ];
    const invoker = queueInvoker([invocationResult("max_tokens", content)]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.stopReason).toBe("max_tokens");
    expect(called).toBe(false);
    expect(invoker.requests).toHaveLength(1);
    expect(outcome.iterations[0]?.toolExecutions).toEqual([]);
  });

  // [C2] `client.ts:227-235` already throws `M3LBedrockRuntimeOperationError`
  // when every toolUse-shaped reply block was malformed, so the loop's own
  // "tool_use with zero toolUse blocks" arm is reachable ONLY when the reply
  // has zero toolUse-shaped blocks at all (a text-only reply carrying
  // stopReason: "tool_use") — exactly the fixture below.
  test("[C2] tool_use with zero toolUse-shaped content blocks throws M3LBedrockRuntimeOperationError", async () => {
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "text", text: "no tool call, but reason says tool_use" },
      ]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools: toolRegistry([]),
      }),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
  });
});

// ---------------------------------------------------------------------------
// Batch 2, group "ceilings" (8 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — ceilings", () => {
  test("default maxIterations is 10: the model still requesting tools past it throws M3LBedrockToolLoopError carrying the full context", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const toolUseTurn = invocationResult("tool_use", [
      { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
    ]);
    const invoker = queueInvoker(Array.from({ length: 11 }, () => toolUseTurn));

    let thrown: unknown;
    try {
      await runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockToolLoopError);
    // exactly 10 invokes happened — the 11th is never attempted once the
    // ceiling is reached with the model still requesting tools.
    expect(invoker.requests).toHaveLength(10);
    const error = thrown as M3LBedrockToolLoopError;
    expect(error.maxIterations).toBe(10);
    expect(error.iterationsCompleted).toBe(10);
    expect(error.lastStopReason).toBe("tool_use");
  });

  test("default maxToolsPerTurn is 8: a turn requesting 9 tools throws M3LBedrockToolLoopError before any handler in that turn runs", async () => {
    let handlerCalls = 0;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          handlerCalls += 1;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const nineBlocks: M3LBedrockMessage["content"] = Array.from(
      { length: 9 },
      (_unused, index) => ({
        type: "toolUse" as const,
        toolUseId: `t${index}`,
        name: "get_weather",
        input: {},
      }),
    );
    const invoker = queueInvoker([invocationResult("tool_use", nineBlocks)]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools }),
    ).rejects.toBeInstanceOf(M3LBedrockToolLoopError);
    expect(handlerCalls).toBe(0);
  });

  const INVALID_CEILINGS: ReadonlyArray<
    readonly ["maxIterations" | "maxToolsPerTurn", number]
  > = [
    ["maxIterations", 0],
    ["maxIterations", -1],
    ["maxIterations", 2.5],
    ["maxIterations", Number.NaN],
    ["maxIterations", Number.POSITIVE_INFINITY],
    ["maxToolsPerTurn", 0],
  ];

  test.each(INVALID_CEILINGS)(
    "%s = %p is rejected at the boundary with M3LBedrockRuntimeOperationError, before any invoke (Infinity makes 'no ceiling' unrepresentable)",
    async (field, value) => {
      const invoker = queueInvoker([
        invocationResult("end_turn", [{ type: "text", text: "unreached" }]),
      ]);
      const options = {
        tools: toolRegistry([]),
        [field]: value,
      } as M3LBedrockToolLoopOptions;

      await expect(
        runBedrockToolLoop(invoker, BASE_CONVERSATION, options),
      ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect(invoker.requests).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Batch 2, group "cancellation" (7 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — cancellation", () => {
  test("an already-aborted signal throws M3LOperationAbortedError before the first invoke", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoker = queueInvoker([
      invocationResult("end_turn", [{ type: "text", text: "unreached" }]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools: toolRegistry([]),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(M3LOperationAbortedError);
    expect(invoker.requests).toHaveLength(0);
  });

  test("abort between iterations: fired while the first handler runs (after Check 2 passed), before the second invoke", async () => {
    const controller = new AbortController();
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          controller.abort();
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "unreached" }]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(M3LOperationAbortedError);
    // the handler ran and the toolResult turn was appended fine — only the
    // NEXT invoke (Check 1) is what refuses to proceed.
    expect(invoker.requests).toHaveLength(1);
  });

  test("abort fired before the first handler dispatch throws M3LOperationAbortedError without ever calling that handler", async () => {
    const controller = new AbortController();
    let handlerCalled = false;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          handlerCalled = true;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker: RecordingInvoker = {
      requests: [],
      invoke(request: M3LBedrockToolInvokeRequest) {
        invoker.requests.push(request);
        // Fires as a side effect of THIS invoke resolving — Check 1 (before
        // this invoke) already passed, so only Check 2 (before the
        // resulting toolUse block's handler dispatch) can catch it.
        controller.abort();
        return Promise.resolve(
          invocationResult("tool_use", [
            {
              type: "toolUse",
              toolUseId: "t1",
              name: "get_weather",
              input: {},
            },
          ]),
        );
      },
    };

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(M3LOperationAbortedError);
    expect(handlerCalled).toBe(false);
    expect(invoker.requests).toHaveLength(1);
  });

  test("abort beats ceiling: a signal that fires exactly as maxIterations is reached wins over M3LBedrockToolLoopError", async () => {
    const controller = new AbortController();
    const toolUseTurn = invocationResult("tool_use", [
      { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
    ]);
    let callCount = 0;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          callCount += 1;
          if (callCount === 10) {
            controller.abort();
          }
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker(Array.from({ length: 10 }, () => toolUseTurn));

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(M3LOperationAbortedError);
    expect(invoker.requests).toHaveLength(10);
  });

  test("a handler that itself throws M3LOperationAbortedError propagates unwrapped, never becoming a status: error toolResult", async () => {
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() =>
          Promise.reject(
            new M3LOperationAbortedError("cancelled mid tool call"),
          ),
        ),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools }),
    ).rejects.toBeInstanceOf(M3LOperationAbortedError);
    // never advances to build the toolResult turn / call invoke again
    expect(invoker.requests).toHaveLength(1);
  });

  test("on abort mid-batch, no partial toolResult turn is appended: the second tool in the same batch never runs", async () => {
    const controller = new AbortController();
    let secondHandlerCalled = false;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          controller.abort();
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
      [
        "get_time",
        registration(() => {
          secondHandlerCalled = true;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
        { type: "toolUse", toolUseId: "t2", name: "get_time", input: {} },
      ]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(M3LOperationAbortedError);

    expect(secondHandlerCalled).toBe(false);
    // no second invoke was ever attempted — proves no partial toolResult
    // turn (covering t1 but missing t2) was ever assembled and sent.
    expect(invoker.requests).toHaveLength(1);
  });

  test("cancellation surfaces as M3LOperationAbortedError itself, never wrapped or double-classified into another error class", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoker = queueInvoker([]);

    let thrown: unknown;
    try {
      await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools: toolRegistry([]),
        signal: controller.signal,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect(thrown).not.toBeInstanceOf(M3LBedrockToolLoopError);
    expect(thrown).not.toBeInstanceOf(M3LBedrockRuntimeOperationError);
  });
});

// ---------------------------------------------------------------------------
// Batch 2, group "handler-failure feedback" (6 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — handler-failure feedback", () => {
  test("an ordinary handler rejection becomes a status: error toolResult and the loop continues", async () => {
    const failure = new Error("downstream API failed");
    const tools = toolRegistry([
      ["get_weather", registration(() => Promise.reject(failure))],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(invoker.requests).toHaveLength(2);
    const secondRequestMessages = invoker.requests[1]?.messages ?? [];
    expect(secondRequestMessages[2]).toMatchObject({
      role: "user",
      content: [
        expect.objectContaining({
          type: "toolResult",
          toolUseId: "t1",
          status: "error",
        }),
      ],
    });
    expect(outcome.stopReason).toBe("end_turn");
  });

  test("the outcome ledger records a handler rejection's cause on that iteration's toolExecutions entry", async () => {
    const failure = new Error("downstream API failed");
    const tools = toolRegistry([
      ["get_weather", registration(() => Promise.reject(failure))],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.iterations[0]?.toolExecutions).toEqual([
      { toolUseId: "t1", name: "get_weather", status: "error", cause: failure },
    ]);
  });

  test("an unknown tool name produces status: error with NO cause key (a model-input disposition, not a handler failure)", async () => {
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        {
          type: "toolUse",
          toolUseId: "t1",
          name: "not_registered",
          input: {},
        },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools: toolRegistry([]),
    });

    expect(outcome.iterations[0]?.toolExecutions).toEqual([
      { toolUseId: "t1", name: "not_registered", status: "error" },
    ]);
    expect(
      Object.hasOwn(outcome.iterations[0]?.toolExecutions[0] ?? {}, "cause"),
    ).toBe(false);
    expect(outcome.stopReason).toBe("end_turn");
  });

  test("a handler rejecting with a non-Error value still records it verbatim as cause (weakly-typed unknown channel)", async () => {
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentional non-Error rejection to prove the unknown `cause` channel is not re-typed/re-wrapped
          Promise.reject("boom"),
        ),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.iterations[0]?.toolExecutions).toEqual([
      { toolUseId: "t1", name: "get_weather", status: "error", cause: "boom" },
    ]);
  });

  test("a handler rejection for one tool in a batch does not prevent the other tool in the same batch from running", async () => {
    const failure = new Error("get_weather failed");
    let getTimeCalled = false;
    const tools = toolRegistry([
      ["get_weather", registration(() => Promise.reject(failure))],
      [
        "get_time",
        registration(() => {
          getTimeCalled = true;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} },
        { type: "toolUse", toolUseId: "t2", name: "get_time", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(getTimeCalled).toBe(true);
    expect(outcome.iterations[0]?.toolExecutions).toEqual([
      { toolUseId: "t1", name: "get_weather", status: "error", cause: failure },
      { toolUseId: "t2", name: "get_time", status: "success" },
    ]);
  });

  test("handlers execute strictly sequentially: no overlap between one handler's start/end and the next's (proven by observed interleaving, not call count)", async () => {
    const events: string[] = [];
    const tools = toolRegistry([
      [
        "slow",
        registration(async () => {
          events.push("slow:start");
          await Promise.resolve();
          await Promise.resolve();
          events.push("slow:end");
          return TEXT_RESULT;
        }),
      ],
      [
        "fast",
        registration(() => {
          events.push("fast:start");
          events.push("fast:end");
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "slow", input: {} },
        { type: "toolUse", toolUseId: "t2", name: "fast", input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    await runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools });

    // A Promise.all/concurrent implementation would let "fast" run to
    // completion while "slow" is still awaiting its microtask ticks,
    // producing ["slow:start", "fast:start", "fast:end", "slow:end"]
    // instead — this assertion discriminates strictly sequential dispatch
    // from that, which a call-count assertion alone cannot.
    expect(events).toEqual([
      "slow:start",
      "slow:end",
      "fast:start",
      "fast:end",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Batch 3, group "untrusted model input" (10 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — untrusted model input", () => {
  test("an unknown tool name becomes a status: error toolResult sent on the next invoke, and the loop continues", async () => {
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        {
          type: "toolUse",
          toolUseId: "t1",
          name: "not_registered",
          input: {},
        },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools: toolRegistry([]),
    });

    expect(invoker.requests).toHaveLength(2);
    const sentToolResult = invoker.requests[1]?.messages[2];
    expect(sentToolResult).toMatchObject({
      role: "user",
      content: [
        expect.objectContaining({
          type: "toolResult",
          toolUseId: "t1",
          status: "error",
        }),
      ],
    });
    expect(outcome.stopReason).toBe("end_turn");
  });

  const NON_OBJECT_INPUTS: readonly unknown[] = [
    "a string",
    null,
    ["an", "array"],
  ];

  test.each(NON_OBJECT_INPUTS)(
    "non-plain-object input (%p) becomes a status: error toolResult, loop continues",
    async (input) => {
      let handlerCalled = false;
      const tools = toolRegistry([
        [
          "get_weather",
          registration(() => {
            handlerCalled = true;
            return Promise.resolve(TEXT_RESULT);
          }),
        ],
      ]);
      const invoker = queueInvoker([
        invocationResult("tool_use", [
          { type: "toolUse", toolUseId: "t1", name: "get_weather", input },
        ]),
        invocationResult("end_turn", [{ type: "text", text: "done" }]),
      ]);

      const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools,
      });

      expect(handlerCalled).toBe(false);
      expect(outcome.iterations[0]?.toolExecutions).toEqual([
        { toolUseId: "t1", name: "get_weather", status: "error" },
      ]);
    },
  );

  test.each(["__proto__", "constructor"] as const)(
    "%s as a tool name resolves to unknown-tool status: error, never an inherited Map/Object member",
    async (name) => {
      let handlerCalled = false;
      const tools = toolRegistry([
        [
          "get_weather",
          registration(() => {
            handlerCalled = true;
            return Promise.resolve(TEXT_RESULT);
          }),
        ],
      ]);
      const invoker = queueInvoker([
        invocationResult("tool_use", [
          { type: "toolUse", toolUseId: "t1", name, input: {} },
        ]),
        invocationResult("end_turn", [{ type: "text", text: "done" }]),
      ]);

      const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
        tools,
      });

      expect(handlerCalled).toBe(false);
      expect(outcome.iterations[0]?.toolExecutions).toEqual([
        { toolUseId: "t1", name, status: "error" },
      ]);
    },
  );

  test("a missing/empty toolUseId throws M3LBedrockRuntimeOperationError before any handler runs", async () => {
    let handlerCalled = false;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          handlerCalled = true;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "", name: "get_weather", input: {} },
      ]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools }),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(handlerCalled).toBe(false);
  });

  test("a duplicate toolUseId within one turn throws M3LBedrockRuntimeOperationError before any handler runs", async () => {
    let handlerCalls = 0;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          handlerCalls += 1;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
      [
        "get_time",
        registration(() => {
          handlerCalls += 1;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "dup", name: "get_weather", input: {} },
        { type: "toolUse", toolUseId: "dup", name: "get_time", input: {} },
      ]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools }),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(handlerCalls).toBe(0);
  });

  test("a missing/empty tool name throws M3LBedrockRuntimeOperationError before any handler runs", async () => {
    let handlerCalled = false;
    const tools = toolRegistry([
      [
        "get_weather",
        registration(() => {
          handlerCalled = true;
          return Promise.resolve(TEXT_RESULT);
        }),
      ],
    ]);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: "", input: {} },
      ]),
    ]);

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools }),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(handlerCalled).toBe(false);
  });

  test("a ~500k-char tool name is treated as an unknown tool (status: error), never thrown or hung on", async () => {
    const hugeName = "x".repeat(500_000);
    const invoker = queueInvoker([
      invocationResult("tool_use", [
        { type: "toolUse", toolUseId: "t1", name: hugeName, input: {} },
      ]),
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools: toolRegistry([]),
    });

    expect(outcome.iterations[0]?.toolExecutions).toEqual([
      { toolUseId: "t1", name: hugeName, status: "error" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Batch 3, group "usage/cost" (5 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — usage/cost", () => {
  test("no rates supplied: the cost key is OMITTED from the outcome (not undefined)", async () => {
    const invoker = queueInvoker([
      invocationResult("end_turn", [{ type: "text", text: "done" }]),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools: toolRegistry([]),
    });

    expect(Object.hasOwn(outcome, "cost")).toBe(false);
    expect("cost" in outcome).toBe(false);
  });

  test("cumulative usage sums each iteration's token counts", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const invoker = queueInvoker([
      invocationResult(
        "tool_use",
        [{ type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} }],
        { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ),
      invocationResult("end_turn", [{ type: "text", text: "done" }], {
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      }),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
    });

    expect(outcome.usage).toEqual({
      inputTokens: 30,
      outputTokens: 13,
      totalTokens: 43,
    });
  });

  test("cost is summed per iteration using each iteration's own modelId rate", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const rates = new Map<string, M3LBedrockModelRate>([
      [MODEL, { inputPer1kTokens: 3, outputPer1kTokens: 6 }],
    ]);
    const invoker = queueInvoker([
      invocationResult(
        "tool_use",
        [{ type: "toolUse", toolUseId: "t1", name: "get_weather", input: {} }],
        {
          usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
          modelId: MODEL,
        },
      ),
      invocationResult("end_turn", [{ type: "text", text: "done" }], {
        usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
        modelId: MODEL,
      }),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools,
      rates,
    });

    // iteration 1: 1*3 + 1*6 = 9; iteration 2: 2*3 + 1*6 = 12; total = 21
    expect(outcome.cost).toBe(21);
  });

  test("a rates table missing the served modelId entirely OMITS cost (never partial, never NaN)", async () => {
    const rates = new Map<string, M3LBedrockModelRate>([
      ["some-other-model", { inputPer1kTokens: 1, outputPer1kTokens: 1 }],
    ]);
    const invoker = queueInvoker([
      invocationResult("end_turn", [{ type: "text", text: "done" }], {
        modelId: MODEL,
      }),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools: toolRegistry([]),
      rates,
    });

    expect(Object.hasOwn(outcome, "cost")).toBe(false);
  });

  test("rates lookup by modelId 'constructor' via a ReadonlyMap never resolves an inherited function (no silent NaN cost)", async () => {
    const rates = new Map<string, M3LBedrockModelRate>([
      ["constructor", { inputPer1kTokens: 1, outputPer1kTokens: 2 }],
    ]);
    const invoker = queueInvoker([
      invocationResult("end_turn", [{ type: "text", text: "done" }], {
        modelId: "constructor",
        usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      }),
    ]);

    const outcome = await runBedrockToolLoop(invoker, BASE_CONVERSATION, {
      tools: toolRegistry([]),
      rates,
    });

    expect(outcome.cost).toBe(3);
    expect(Number.isNaN(outcome.cost)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batch 3, group "M3LBedrockToolLoopError leak audit (per channel)" (5 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — M3LBedrockToolLoopError leak audit (per channel)", () => {
  const SECRET = "sk-super-secret-api-token-should-never-leak";

  test("context is EXACTLY the nine allowlisted primitive keys, no more, no fewer", async () => {
    const error = await ceilingError({
      rejectMessage: `auth failed: ${SECRET}`,
    });

    expect(Object.keys(error.context).sort()).toEqual(
      [
        "maxIterations",
        "iterationsCompleted",
        "lastStopReason",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "modelId",
        "pendingToolCount",
        "toolErrorCount",
      ].sort(),
    );
  });

  test("the constructor accepts no cause: error.cause is always undefined", async () => {
    const error = await ceilingError({
      rejectMessage: `auth failed: ${SECRET}`,
    });
    expect(error.cause).toBeUndefined();
  });

  test("a planted secret from a handler rejection never reaches toJSON()", async () => {
    const error = await ceilingError({
      rejectMessage: `auth failed: ${SECRET}`,
    });
    const json = JSON.stringify(error.toJSON());
    expect(json).not.toContain(SECRET);
  });

  test("a planted secret from a handler rejection never reaches util.inspect output", async () => {
    const error = await ceilingError({
      rejectMessage: `auth failed: ${SECRET}`,
    });
    const inspected = inspect(error, { depth: null, getters: true });
    expect(inspected).not.toContain(SECRET);
  });

  test("a planted secret from a handler rejection never reaches formatErrorChain/serializeErrorChain (they walk the live chain, not toJSON())", async () => {
    const error = await ceilingError({
      rejectMessage: `auth failed: ${SECRET}`,
    });
    expect(formatErrorChain(error)).not.toContain(SECRET);
    expect(JSON.stringify(serializeErrorChain(error))).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Batch 3, group "catalog/barrel reachability" (4 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — catalog/barrel reachability", () => {
  test("M3LBedrockToolLoopError is an M3LError carrying the ERR_BEDROCK_RUNTIME_TOOL_LOOP code", async () => {
    const error = await ceilingError();
    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_BEDROCK_RUNTIME_TOOL_LOOP");
  });

  test("M3LBedrockToolLoopError's catalog registration defaults to origin: caller, retryable: false", async () => {
    const error = await ceilingError();
    expect(error.origin).toBe("caller");
    expect(error.retryable).toBe(false);
  });

  test("runBedrockToolLoop and M3LBedrockToolLoopError are reachable identically through both the aws barrel and the bedrock-runtime submodule path", async () => {
    const submodule = await import("../src/aws/bedrock-runtime/index.js");

    expect(typeof submodule.runBedrockToolLoop).toBe("function");
    expect(submodule.runBedrockToolLoop).toBe(runBedrockToolLoop);
    expect(typeof submodule.M3LBedrockToolLoopError).toBe("function");
    expect(submodule.M3LBedrockToolLoopError).toBe(M3LBedrockToolLoopError);
  });

  test("[type-level] a loop-scoped type imported through the aws barrel matches the same type imported through the bedrock-runtime submodule path", () => {
    function typeOnly(): void {
      expectTypeOf<M3LBedrockToolLoopOutcome>().toEqualTypeOf<M3LBedrockToolLoopOutcomeFromSubmodule>();
    }
    expect(typeof typeOnly).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Batch 3, group "V4 interop (documented non-guarantees)" (4 tests)
// ---------------------------------------------------------------------------

describe("runBedrockToolLoop — V4 interop (documented non-guarantees)", () => {
  test("M3LBedrockRuntimeNoModelError thrown from invoke() mid-loop propagates unwrapped", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const failure = new M3LBedrockRuntimeNoModelError("every model exhausted", {
      attemptedModels: [MODEL],
    });
    let callCount = 0;
    const invoker: RecordingInvoker = {
      requests: [],
      invoke(request: M3LBedrockToolInvokeRequest) {
        invoker.requests.push(request);
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(
            invocationResult("tool_use", [
              {
                type: "toolUse",
                toolUseId: "t1",
                name: "get_weather",
                input: {},
              },
            ]),
          );
        }
        return Promise.reject(failure);
      },
    };

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools }),
    ).rejects.toBe(failure);
  });

  test("M3LBedrockRuntimeModelError thrown from invoke() mid-loop propagates unwrapped", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const failure = new M3LBedrockRuntimeModelError("model faulted", {
      modelId: MODEL,
    });
    let callCount = 0;
    const invoker: RecordingInvoker = {
      requests: [],
      invoke(request: M3LBedrockToolInvokeRequest) {
        invoker.requests.push(request);
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(
            invocationResult("tool_use", [
              {
                type: "toolUse",
                toolUseId: "t1",
                name: "get_weather",
                input: {},
              },
            ]),
          );
        }
        return Promise.reject(failure);
      },
    };

    await expect(
      runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools }),
    ).rejects.toBe(failure);
  });

  test("a mid-loop invoke() failure does not carry the accumulated usage from prior iterations", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const failure = new M3LBedrockRuntimeNoModelError("every model exhausted", {
      attemptedModels: [MODEL],
    });
    let callCount = 0;
    const invoker: RecordingInvoker = {
      requests: [],
      invoke(request: M3LBedrockToolInvokeRequest) {
        invoker.requests.push(request);
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(
            invocationResult(
              "tool_use",
              [
                {
                  type: "toolUse",
                  toolUseId: "t1",
                  name: "get_weather",
                  input: {},
                },
              ],
              {
                usage: {
                  inputTokens: 100,
                  outputTokens: 50,
                  totalTokens: 150,
                },
              },
            ),
          );
        }
        return Promise.reject(failure);
      },
    };

    let thrown: unknown;
    try {
      await runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(Object.hasOwn(thrown as object, "usage")).toBe(false);
  });

  test("the loop never re-classifies an invoke()-thrown V4 error into M3LBedrockToolLoopError", async () => {
    const tools = toolRegistry([
      ["get_weather", registration(handlerReturning(TEXT_RESULT))],
    ]);
    const failure = new M3LBedrockRuntimeModelError("model faulted", {
      modelId: MODEL,
    });
    const invoker: RecordingInvoker = {
      requests: [],
      invoke(request: M3LBedrockToolInvokeRequest) {
        invoker.requests.push(request);
        return Promise.reject(failure);
      },
    };

    let thrown: unknown;
    try {
      await runBedrockToolLoop(invoker, BASE_CONVERSATION, { tools });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeModelError);
    expect(thrown).not.toBeInstanceOf(M3LBedrockToolLoopError);
  });
});
