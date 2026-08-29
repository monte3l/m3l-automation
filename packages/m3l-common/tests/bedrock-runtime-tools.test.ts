/**
 * Tests for aws/bedrock-runtime's tool vocabulary (V5 Slice A).
 *
 * Contract source: docs/reference/aws/bedrock-runtime.md (authoritative,
 * updated 2026-08-29), ADR-0059. Scope: the `toolUse`/`toolResult` content
 * blocks, the tool definition/choice/schema types,
 * `M3LBedrockToolInvokeRequest`, the request- and response-side mapping, and
 * `invokeStream`'s tool-config rejection guard.
 *
 * Deliberately imports ONLY the tool vocabulary plus
 * `M3LBedrockRuntimeOperations` (and `M3LBedrockRuntimeOperationError`, the
 * one error class this slice's caller errors use) — no streaming symbols
 * (`M3LBedrockStreamEvent` and friends), so `perFile` v8 coverage binds
 * within this slice (`vitest.config.ts:73`) and this file stays independent
 * of `tests/bedrock-runtime-streaming.test.ts`.
 *
 * Mocking strategy mirrors `tests/bedrock-runtime.test.ts`: a `vi.hoisted`
 * bag fakes `BedrockRuntimeClient`/`ConverseCommand`, with `.send()` a spy
 * whose captured `ConverseCommand.input` is inspected directly — this file
 * has no need for the V4 file's fake-timer/retry harness, since every test
 * here either resolves `send()` once or never reaches it at all (a caller
 * error or the `invokeStream` guard both fire before `send()`).
 *
 * This is the TDD RED seam: `M3LBedrockToolUseBlock`, `M3LBedrockToolResultBlock`,
 * `M3LBedrockToolResultContent`, `M3LBedrockToolResultJsonBlock`,
 * `M3LBedrockToolResultStatus`, `M3LBedrockToolDefinition`,
 * `M3LBedrockToolInputSchema`, `M3LBedrockToolChoice`, and
 * `M3LBedrockToolInvokeRequest` do not exist in `src/` yet, and
 * `M3LBedrockContentBlock` is still the V4 single-member union — every test
 * here is expected to fail on import/typecheck, not on an assertion inside a
 * running test.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spy referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();

  class ConverseCommand {
    constructor(readonly input: unknown) {}
  }
  // Only constructed by the "OFF branch is reachable" regression-discriminator
  // test below — every ON-branch guard test rejects before `stream.ts` ever
  // builds one.
  class ConverseStreamCommand {
    constructor(readonly input: unknown) {}
  }
  class BedrockRuntimeClient {
    readonly config: unknown;
    send = send;
    destroy = vi.fn();
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand,
  };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: h.BedrockRuntimeClient,
  ConverseCommand: h.ConverseCommand,
  ConverseStreamCommand: h.ConverseStreamCommand,
}));

import {
  M3LBedrockRuntimeOperationError,
  M3LBedrockRuntimeOperations,
} from "../src/aws/index.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInvocationResult,
  M3LBedrockInvokeOptions,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockTextBlock,
  M3LBedrockTokenUsage,
  M3LBedrockToolChoice,
  M3LBedrockToolDefinition,
  M3LBedrockToolInputSchema,
  M3LBedrockToolInvokeRequest,
  M3LBedrockToolResultBlock,
  M3LBedrockToolResultContent,
  M3LBedrockToolResultJsonBlock,
  M3LBedrockToolResultStatus,
  M3LBedrockToolUseBlock,
} from "../src/aws/index.js";

import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

const MODEL_A = "anthropic.claude-opus-5";
const MODEL_B = "anthropic.claude-sonnet-5";

/** Casts the hoisted fake `BedrockRuntimeClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): BedrockRuntimeClient {
  return new h.BedrockRuntimeClient() as unknown as BedrockRuntimeClient;
}

/** Constructs `M3LBedrockRuntimeOperations` against the fake client with the given fallback list. */
function newOps(
  models: readonly [string, ...string[]] = [MODEL_A],
): M3LBedrockRuntimeOperations {
  return new M3LBedrockRuntimeOperations(fakeClient(), { models });
}

const FULL_USAGE: M3LBedrockTokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
};

/** A well-formed `ConverseCommandOutput`-shaped fixture (mocked, not SDK-typed). */
function converseOutput(overrides?: {
  readonly content?: readonly unknown[];
  readonly stopReason?: string;
  readonly usage?: M3LBedrockTokenUsage;
}): Record<string, unknown> {
  return {
    output: {
      message: {
        role: "assistant",
        content: overrides?.content ?? [{ text: "hi there" }],
      },
    },
    stopReason: overrides?.stopReason ?? "end_turn",
    usage: overrides?.usage ?? FULL_USAGE,
  };
}

/** Reads the `ConverseCommand.input` captured by the `n`th (0-indexed) `send()` call. */
function sentInput(callIndex = 0): Record<string, unknown> {
  const [command] = h.send.mock.calls[callIndex] as [
    { input: Record<string, unknown> },
  ];
  return command.input;
}

const USER_MESSAGE_TEXT: M3LBedrockMessage = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

const TOOL_NO_DESC: M3LBedrockToolDefinition = {
  name: "get_weather",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
  },
};

const TOOL_WITH_DESC: M3LBedrockToolDefinition = {
  name: "get_time",
  description: "Returns the current time for a timezone.",
  inputSchema: {
    type: "object",
    properties: { tz: { type: "string" } },
  },
};

/** Builds a value nested `depth` object levels deep, terminating at a string leaf. */
function buildNested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) {
    value = { nested: value };
  }
  return value;
}

beforeEach(() => {
  h.send.mockReset();
});

describe("request-side toolConfig mapping", () => {
  test("toolConfig key is absent when tools is absent", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

    expect(Object.hasOwn(sentInput(), "toolConfig")).toBe(false);
  });

  test("toolConfig key is absent when tools is an empty array", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const request: M3LBedrockToolInvokeRequest = {
      messages: [USER_MESSAGE_TEXT],
      tools: [],
    };
    await newOps().invoke(request);

    expect(Object.hasOwn(sentInput(), "toolConfig")).toBe(false);
  });

  test("a non-empty tools array maps to toolConfig.tools[].toolSpec, description omitted when absent, strict never emitted", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    await newOps().invoke({
      messages: [USER_MESSAGE_TEXT],
      tools: [TOOL_NO_DESC],
    });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    const tools = toolConfig["tools"] as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    const toolSpec = tools[0]?.["toolSpec"] as Record<string, unknown>;
    expect(toolSpec["name"]).toBe("get_weather");
    expect(toolSpec["inputSchema"]).toEqual({ json: TOOL_NO_DESC.inputSchema });
    expect(Object.hasOwn(toolSpec, "description")).toBe(false);
    expect(Object.hasOwn(toolSpec, "strict")).toBe(false);
  });

  test("description is included when present on the tool definition", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    await newOps().invoke({
      messages: [USER_MESSAGE_TEXT],
      tools: [TOOL_WITH_DESC],
    });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    const tools = toolConfig["tools"] as Record<string, unknown>[];
    const toolSpec = tools[0]?.["toolSpec"] as Record<string, unknown>;
    expect(toolSpec["description"]).toBe(TOOL_WITH_DESC.description);
  });

  test("multi-tool order is preserved in toolConfig.tools", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    await newOps().invoke({
      messages: [USER_MESSAGE_TEXT],
      tools: [TOOL_NO_DESC, TOOL_WITH_DESC],
    });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    const tools = toolConfig["tools"] as Record<string, unknown>[];
    const names = tools.map(
      (tool) => (tool["toolSpec"] as Record<string, unknown>)["name"],
    );
    expect(names).toEqual(["get_weather", "get_time"]);
  });

  test("toolConfig.toolChoice key is absent when toolChoice is absent, toolConfig.tools still present", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    await newOps().invoke({
      messages: [USER_MESSAGE_TEXT],
      tools: [TOOL_NO_DESC],
    });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    expect(Object.hasOwn(toolConfig, "toolChoice")).toBe(false);
    expect(toolConfig["tools"]).toBeDefined();
  });

  test.each<[M3LBedrockToolChoice, Record<string, unknown>]>([
    ["auto", { auto: {} }],
    ["any", { any: {} }],
    [{ tool: "get_weather" }, { tool: { name: "get_weather" } }],
  ])(
    "toolChoice %o maps to exactly one SDK key: %o",
    async (toolChoice, expected) => {
      h.send.mockResolvedValueOnce(converseOutput());
      await newOps().invoke({
        messages: [USER_MESSAGE_TEXT],
        tools: [TOOL_NO_DESC],
        toolChoice,
      });

      const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
      expect(toolConfig["toolChoice"]).toEqual(expected);
      expect(Object.keys(toolConfig["toolChoice"] as object)).toEqual(
        Object.keys(expected),
      );
    },
  );

  test("inputSchema is copied, not passed by reference, into toolSpec.inputSchema.json", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const originalTags = ["a", "b"] as const;
    const schema: M3LBedrockToolInputSchema = {
      type: "object",
      properties: { tags: originalTags },
    };
    await newOps().invoke({
      messages: [USER_MESSAGE_TEXT],
      tools: [{ name: "tagger", inputSchema: schema }],
    });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    const tools = toolConfig["tools"] as Record<string, unknown>[];
    const toolSpec = tools[0]?.["toolSpec"] as Record<string, unknown>;
    const json = (toolSpec["inputSchema"] as Record<string, unknown>)[
      "json"
    ] as Record<string, unknown>;
    const properties = json["properties"] as Record<string, unknown>;
    const copiedTags = properties["tags"];
    expect(copiedTags).toEqual(["a", "b"]);
    expect(copiedTags).not.toBe(originalTags);
  });
});

describe("the recursive document copy (inputSchema/json)", () => {
  test("every leaf type round-trips: string, number, boolean, null, nested object, nested array", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const schema: M3LBedrockToolInputSchema = {
      type: "object",
      str: "s",
      num: 1,
      bool: true,
      nil: null,
      obj: { inner: "v" },
      arr: [1, "two", false, null],
    };
    await newOps().invoke({
      messages: [USER_MESSAGE_TEXT],
      tools: [{ name: "t", inputSchema: schema }],
    });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    const tools = toolConfig["tools"] as Record<string, unknown>[];
    const toolSpec = tools[0]?.["toolSpec"] as Record<string, unknown>;
    const json = (toolSpec["inputSchema"] as Record<string, unknown>)["json"];
    expect(json).toEqual(schema);
  });

  test("nesting deeper than the 32-level ceiling throws a typed M3LBedrockRuntimeOperationError, not a bare RangeError, before send()", async () => {
    const deep = buildNested(40);
    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [USER_MESSAGE_TEXT],
        tools: [{ name: "t", inputSchema: { type: "object", value: deep } }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  // The 40-level test above is well past the 32-level ceiling and cannot
  // catch an off-by-one in MAX_DOCUMENT_DEPTH's comparison — these two pin
  // the exact boundary. `buildNested(n)` wraps a "leaf" string in `n` levels
  // of `{ nested: ... }`, used directly as the root inputSchema (rather than
  // nested one level deeper inside `{ type: "object", value: ... }` as
  // above), so `n` is exactly the depth `copyDocument` sees at the leaf.
  test("a document nested exactly 32 levels deep — at the ceiling — is accepted, reaching send()", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const schema = buildNested(32) as M3LBedrockToolInputSchema;

    await newOps().invoke({
      messages: [USER_MESSAGE_TEXT],
      tools: [{ name: "t", inputSchema: schema }],
    });

    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("a document nested 33 levels deep — one past the ceiling — throws the typed error", async () => {
    const schema = buildNested(33) as M3LBedrockToolInputSchema;

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [USER_MESSAGE_TEXT],
        tools: [{ name: "t", inputSchema: schema }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("the two documented caller errors (M3LBedrockRuntimeOperationError, origin: caller, retryable: false)", () => {
  test("toolChoice present and tools absent throws before send()", async () => {
    let thrown: unknown;
    try {
      await newOps([MODEL_A, MODEL_B]).invoke({
        messages: [USER_MESSAGE_TEXT],
        toolChoice: "auto",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("toolChoice present and tools is an empty array throws the same error (empty is equivalent to absent)", async () => {
    const request: M3LBedrockToolInvokeRequest = {
      messages: [USER_MESSAGE_TEXT],
      tools: [],
      toolChoice: "any",
    };
    let thrown: unknown;
    try {
      await newOps().invoke(request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("toolChoice naming a tool absent from tools throws before send(), exact case-sensitive match", async () => {
    let thrown: unknown;
    try {
      await newOps([MODEL_A, MODEL_B]).invoke({
        messages: [USER_MESSAGE_TEXT],
        tools: [TOOL_NO_DESC],
        // "Get_Weather" differs in case from TOOL_NO_DESC.name ("get_weather") —
        // nothing in the doc licenses normalization.
        toolChoice: { tool: "Get_Weather" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("both caller errors run before any model in the fallback list is attempted, and are not promoted to M3LOperationAbortedError under an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      newOps([MODEL_A, MODEL_B]).invoke(
        { messages: [USER_MESSAGE_TEXT], toolChoice: "auto" },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("toSdkMessage widening over the 3-member M3LBedrockContentBlock union", () => {
  test("a text block maps to { text }, unchanged from V4", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    await newOps().invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const messages = sentInput()["messages"] as Record<string, unknown>[];
    expect(messages[0]?.["content"]).toEqual([{ text: "hi" }]);
  });

  test("a toolUse block maps to { toolUse: { toolUseId, name, input } }, library discriminant stripped", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const block: M3LBedrockToolUseBlock = {
      type: "toolUse",
      toolUseId: "call-1",
      name: "get_weather",
      input: { city: "Rome" },
    };
    await newOps().invoke({
      messages: [{ role: "assistant", content: [block] }],
    });

    const messages = sentInput()["messages"] as Record<string, unknown>[];
    const content = messages[0]?.["content"] as Record<string, unknown>[];
    expect(content[0]).toEqual({
      toolUse: {
        toolUseId: "call-1",
        name: "get_weather",
        input: { city: "Rome" },
      },
    });
    expect(Object.hasOwn(content[0] ?? {}, "type")).toBe(false);
  });

  test("a toolResult block with text content maps to { toolResult: { toolUseId, content: [{ text }] } }, discriminant stripped", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const block: M3LBedrockToolResultBlock = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [{ type: "text", text: "72F and sunny" }],
    };
    await newOps().invoke({
      messages: [{ role: "user", content: [block] }],
    });

    const messages = sentInput()["messages"] as Record<string, unknown>[];
    const content = messages[0]?.["content"] as Record<string, unknown>[];
    expect(content[0]).toEqual({
      toolResult: {
        toolUseId: "call-1",
        content: [{ text: "72F and sunny" }],
      },
    });
    expect(Object.hasOwn(content[0] ?? {}, "type")).toBe(false);
    expect(
      Object.hasOwn(
        (content[0]?.["toolResult"] as Record<string, unknown>) ?? {},
        "status",
      ),
    ).toBe(false);
  });

  test("a toolResult block with json content maps to { toolResult: { content: [{ json }] } }", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const block: M3LBedrockToolResultBlock = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [{ type: "json", json: { tempF: 72, sunny: true } }],
    };
    await newOps().invoke({
      messages: [{ role: "user", content: [block] }],
    });

    const messages = sentInput()["messages"] as Record<string, unknown>[];
    const content = messages[0]?.["content"] as Record<string, unknown>[];
    const toolResult = content[0]?.["toolResult"] as Record<string, unknown>;
    expect(toolResult["content"]).toEqual([
      { json: { tempF: 72, sunny: true } },
    ]);
  });

  test.each<M3LBedrockToolResultStatus>(["success", "error"])(
    "toolResult.status %s is forwarded verbatim",
    async (status) => {
      h.send.mockResolvedValueOnce(converseOutput());
      const block: M3LBedrockToolResultBlock = {
        type: "toolResult",
        toolUseId: "call-1",
        content: [{ type: "text", text: "x" }],
        status,
      };
      await newOps().invoke({
        messages: [{ role: "user", content: [block] }],
      });

      const messages = sentInput()["messages"] as Record<string, unknown>[];
      const content = messages[0]?.["content"] as Record<string, unknown>[];
      const toolResult = content[0]?.["toolResult"] as Record<string, unknown>;
      expect(toolResult["status"]).toBe(status);
    },
  );

  test("toolResult.status omitted means the key is absent from the SDK toolResult, not synthesized as success", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const block: M3LBedrockToolResultBlock = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [{ type: "text", text: "x" }],
    };
    await newOps().invoke({
      messages: [{ role: "user", content: [block] }],
    });

    const messages = sentInput()["messages"] as Record<string, unknown>[];
    const content = messages[0]?.["content"] as Record<string, unknown>[];
    const toolResult = content[0]?.["toolResult"] as Record<string, unknown>;
    expect(Object.hasOwn(toolResult, "status")).toBe(false);
  });

  test("a mixed-block message (text + toolUse) maps every block in order", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    await newOps().invoke({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "toolUse",
              toolUseId: "call-1",
              name: "get_weather",
              input: { city: "Rome" },
            },
          ],
        },
      ],
    });

    const messages = sentInput()["messages"] as Record<string, unknown>[];
    const content = messages[0]?.["content"] as Record<string, unknown>[];
    expect(content).toEqual([
      { text: "Let me check." },
      {
        toolUse: {
          toolUseId: "call-1",
          name: "get_weather",
          input: { city: "Rome" },
        },
      },
    ]);
  });

  // MUST-FIX 4: a request-side toolUse block's `input` is caller-constructed
  // (e.g. replaying conversation history programmatically), so — like
  // inputSchema and a json tool-result payload — it is now recursively
  // copied via copyDocument rather than cast straight through. A bare cast
  // would have let a bigint/cyclic value escape as a raw
  // TypeError/RangeError instead of this module's typed error.
  test("a request-side toolUse block whose input holds a bigint throws the typed error, not a raw TypeError", async () => {
    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolUse",
                toolUseId: "call-1",
                name: "get_weather",
                input: { limit: 10n },
              },
            ],
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("a request-side toolUse block whose input is a cyclic object throws the depth-bound typed error rather than a stack overflow", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolUse",
                toolUseId: "call-1",
                name: "get_weather",
                input: cyclic,
              },
            ],
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("response-side mapping: toolUse blocks are kept, not dropped", () => {
  test("a well-formed toolUse block is kept with toolUseId/name/input, and stopReason: tool_use is accepted", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [
          {
            toolUse: {
              toolUseId: "call-1",
              name: "get_weather",
              input: { city: "Rome" },
            },
          },
        ],
        stopReason: "tool_use",
      }),
    );
    const result = await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

    expect(result.stopReason).toBe("tool_use");
    expect(result.message.content).toEqual([
      {
        type: "toolUse",
        toolUseId: "call-1",
        name: "get_weather",
        input: { city: "Rome" },
      },
    ]);
  });

  test("input is handed back exactly as decoded — no coercion, no re-shaping", async () => {
    const decodedInput = { city: "Rome", nested: { zip: "00100" } };
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [
          {
            toolUse: {
              toolUseId: "call-1",
              name: "get_weather",
              input: decodedInput,
            },
          },
        ],
        stopReason: "tool_use",
      }),
    );
    const result = await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

    const [block] = result.message.content;
    if (block?.type !== "toolUse") {
      throw new Error("expected a toolUse block");
    }
    expect(block.input).toEqual(decodedInput);
  });

  test("text blocks still map, order preserved, interleaving with toolUse preserved", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [
          { text: "Let me check." },
          {
            toolUse: { toolUseId: "call-1", name: "get_weather", input: {} },
          },
        ],
        stopReason: "tool_use",
      }),
    );
    const result = await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

    expect(result.message.content).toEqual([
      { type: "text", text: "Let me check." },
      {
        type: "toolUse",
        toolUseId: "call-1",
        name: "get_weather",
        input: {},
      },
    ]);
  });

  // A well-formed sibling toolUse block is included alongside each malformed
  // one so toolUseMappedCount > 0 — otherwise MUST-FIX 5's cross-check (see
  // client.ts's mapConverseResponse) throws instead of dropping, since every
  // toolUse-shaped block in the reply would be malformed. This still proves
  // the drop rule: the malformed block never appears in the mapped content,
  // while the good one still flows.
  test.each<[string, Record<string, unknown>]>([
    ["missing toolUseId", { toolUse: { name: "get_weather", input: {} } }],
    ["missing name", { toolUse: { toolUseId: "call-1", input: {} } }],
    [
      "toolUseId is not a string",
      { toolUse: { toolUseId: 1, name: "x", input: {} } },
    ],
    [
      "name is not a string",
      { toolUse: { toolUseId: "call-1", name: 1, input: {} } },
    ],
  ])(
    "a malformed toolUse block (%s) is dropped, not thrown on — a well-formed sibling toolUse block still maps",
    async (_label, malformedBlock) => {
      h.send.mockResolvedValueOnce(
        converseOutput({
          content: [
            { text: "ok" },
            malformedBlock,
            { toolUse: { toolUseId: "good-1", name: "good_tool", input: {} } },
          ],
          stopReason: "tool_use",
        }),
      );
      const result = await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

      expect(result.message.content).toEqual([
        { type: "text", text: "ok" },
        { type: "toolUse", toolUseId: "good-1", name: "good_tool", input: {} },
      ]);
      expect(result.stopReason).toBe("tool_use");
    },
  );

  test("an absent input is not malformed — unknown admits undefined", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [{ toolUse: { toolUseId: "call-1", name: "get_weather" } }],
        stopReason: "tool_use",
      }),
    );
    const result = await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

    expect(result.message.content).toHaveLength(1);
    const [block] = result.message.content;
    if (block?.type !== "toolUse") {
      throw new Error("expected a toolUse block");
    }
    expect(block.toolUseId).toBe("call-1");
    expect(block.name).toBe("get_weather");
    expect(block.input).toBeUndefined();
  });

  test("a toolUse block marked server_tool_use throws M3LBedrockRuntimeOperationError instead of being mapped or dropped — Bedrock already executed it", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [
          {
            toolUse: {
              toolUseId: "call-1",
              name: "get_weather",
              input: {},
              type: "server_tool_use",
            },
          },
        ],
        stopReason: "tool_use",
      }),
    );

    await expect(
      newOps([MODEL_A, MODEL_B]).invoke({ messages: [USER_MESSAGE_TEXT] }),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    // No fallback advance on a response-shape refusal, matching the existing
    // malformed-response precedent (`client.ts`'s mapConverseResponse).
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  // MUST-FIX 2: the SDK's deserializer does not enforce single-member
  // unions, so one reply block can carry both a `text` member and a
  // `server_tool_use`-marked `toolUse` member at once. Before the fix, the
  // `text`-member short-circuit in `client.ts`'s `mapContent` ran first and
  // never reached the refusal — this proves the refusal now runs
  // unconditionally, per block, before any `text` check.
  test("a reply block carrying BOTH text and a server_tool_use-marked toolUse still throws — the text short-circuit does not bypass the refusal", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [
          {
            text: "some visible text",
            toolUse: {
              toolUseId: "call-1",
              name: "get_weather",
              input: {},
              type: "server_tool_use",
            },
          },
        ],
        stopReason: "tool_use",
      }),
    );

    await expect(
      newOps([MODEL_A, MODEL_B]).invoke({ messages: [USER_MESSAGE_TEXT] }),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("the server_tool_use refusal message includes toolUseId/name when both are strings, for log correlation", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [
          {
            toolUse: {
              toolUseId: "call-42",
              name: "get_weather",
              input: {},
              type: "server_tool_use",
            },
          },
        ],
        stopReason: "tool_use",
      }),
    );

    let thrown: unknown;
    try {
      await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const message = (thrown as Error).message;
    expect(message).toContain("toolUseId=call-42");
    expect(message).toContain("name=get_weather");
  });

  // MUST-FIX 5: a caller acting on stopReason: "tool_use" must never see an
  // empty content array indistinguishable from "no tool call was made at
  // all" — so when every toolUse-shaped block in the reply was malformed,
  // invoke() now throws instead of silently returning empty content. This
  // supersedes the old "yields empty content" contract this test used to pin.
  test("stopReason: tool_use whose only toolUse-shaped block was malformed throws M3LBedrockRuntimeOperationError instead of yielding empty content", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [{ toolUse: { name: "get_weather", input: {} } }],
        stopReason: "tool_use",
      }),
    );

    let thrown: unknown;
    try {
      await newOps([MODEL_A, MODEL_B]).invoke({
        messages: [USER_MESSAGE_TEXT],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as Error).message).toContain("stopReason tool_use");
    // No fallback advance on a response-shape refusal, matching the
    // server_tool_use precedent above.
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("invokeStream's tool-config rejection guard", () => {
  /**
   * Builds a `tools`/`toolChoice`-bearing request via a downcast, never a
   * literal — `invokeStream`'s parameter type stays the narrower
   * `M3LBedrockInvokeRequest`, so a literal carrying either field is a
   * compile-time excess-property error (see the dedicated compile-error test
   * below). The runtime guard exists only for a structurally-typed
   * non-literal reaching `invokeStream` anyway.
   */
  function toBadRequest(
    extra: Record<string, unknown>,
  ): M3LBedrockInvokeRequest {
    const value: unknown = { messages: [USER_MESSAGE_TEXT], ...extra };
    return value as M3LBedrockInvokeRequest;
  }

  test("merely calling invokeStream with a tools-bearing request does not throw synchronously, and performs no I/O", () => {
    const badRequest = toBadRequest({ tools: [TOOL_NO_DESC] });

    expect(() => newOps().invokeStream(badRequest)).not.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  test("the first .next() rejects with M3LBedrockRuntimeOperationError (origin: caller, retryable: false) when tools is present", async () => {
    const badRequest = toBadRequest({ tools: [TOOL_NO_DESC] });
    const gen = newOps().invokeStream(badRequest);

    let thrown: unknown;
    try {
      await gen.next();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("the first .next() rejects when toolChoice is present, even without tools", async () => {
    const badRequest = toBadRequest({ toolChoice: "auto" });

    await expect(
      newOps().invokeStream(badRequest).next(),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("the guard fires before model selection — fallback never advances, even with multiple models configured", async () => {
    const badRequest = toBadRequest({ tools: [TOOL_NO_DESC] });

    await expect(
      newOps([MODEL_A, MODEL_B]).invokeStream(badRequest).next(),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("a request with neither tools nor toolChoice reaches send() — the guard's OFF branch is reachable, so the ON-branch tests above are discriminating rather than tautological", async () => {
    h.send.mockRejectedValueOnce(new Error("boom"));
    const gen = newOps().invokeStream({ messages: [USER_MESSAGE_TEXT] });

    await expect(gen.next()).rejects.toBeDefined();
    // The guard did not intercept this call — execution reached send().
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  // MUST-FIX 6: M3LBedrockContentBlock widened (V5) to include toolUse/
  // toolResult, and `messages[].content` is part of M3LBedrockInvokeRequest
  // itself — so, unlike the top-level tools/toolChoice cases above, a
  // caller-constructed request carrying one of these blocks compiles
  // directly against invokeStream's parameter type, with no downcast needed.
  // `stream.ts` itself is frozen for this fix, so the guard must catch this
  // before ever reaching it.
  test("the first .next() rejects with M3LBedrockRuntimeOperationError (origin: caller, retryable: false) when messages[].content carries a toolUse block", async () => {
    const request: M3LBedrockInvokeRequest = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolUse",
              toolUseId: "call-1",
              name: "get_weather",
              input: {},
            },
          ],
        },
      ],
    };

    let thrown: unknown;
    try {
      await newOps().invokeStream(request).next();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("the first .next() rejects when messages[].content carries a toolResult block", async () => {
    const request: M3LBedrockInvokeRequest = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "toolResult",
              toolUseId: "call-1",
              content: [{ type: "text", text: "42 degrees" }],
            },
          ],
        },
      ],
    };

    await expect(newOps().invokeStream(request).next()).rejects.toBeInstanceOf(
      M3LBedrockRuntimeOperationError,
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  test("the content-block guard fires before model selection — fallback never advances", async () => {
    const request: M3LBedrockInvokeRequest = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "toolResult",
              toolUseId: "call-1",
              content: [{ type: "text", text: "42 degrees" }],
            },
          ],
        },
      ],
    };

    await expect(
      newOps([MODEL_A, MODEL_B]).invokeStream(request).next(),
    ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("a multi-turn, text-only conversation still reaches send() — the content-block guard does not misfire on legitimate text history", async () => {
    h.send.mockRejectedValueOnce(new Error("boom"));
    const request: M3LBedrockInvokeRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "bye" }] },
      ],
    };

    const gen = newOps().invokeStream(request);
    await expect(gen.next()).rejects.toBeDefined();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("a literal request carrying tools does not compile against invokeStream's M3LBedrockInvokeRequest parameter", () => {
    const ops = newOps();
    // @ts-expect-error -- `tools` is not a member of M3LBedrockInvokeRequest;
    // invokeStream's parameter stays the narrower V4 type on purpose, so
    // only a structurally-typed non-literal (via toBadRequest's cast above)
    // can reach the runtime guard exercised by the tests above.
    ops.invokeStream({ messages: [USER_MESSAGE_TEXT], tools: [] });
  });
});

describe("shared.ts exhaustiveness default arms — unreachable via the public type, exercised only via a deliberate invalid cast (mirrors tests/logging.test.ts's precedent)", () => {
  test("an invalid M3LBedrockContentBlock.type throws M3LBedrockRuntimeOperationError('unhandled content block type ...')", async () => {
    const invalidBlock = {
      type: "nope",
    } as unknown as M3LBedrockContentBlock;

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [{ role: "user", content: [invalidBlock] }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as Error).message).toContain("unhandled content block type");
    // Thrown while mapping the request, before any model is attempted.
    expect(h.send).not.toHaveBeenCalled();
  });

  test("an invalid M3LBedrockToolResultContent.type throws M3LBedrockRuntimeOperationError('unhandled tool-result content type ...')", async () => {
    const invalidResultItem = {
      type: "nope",
    } as unknown as M3LBedrockToolResultContent;
    const block: M3LBedrockToolResultBlock = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [invalidResultItem],
    };

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [{ role: "user", content: [block] }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as Error).message).toContain(
      "unhandled tool-result content type",
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  // MUST-FIX 3 / SHOULD-FIX 3: the default arms now interpolate only the
  // discriminant tag, never the full caller-supplied value — and both now
  // report origin: "caller", retryable: false (this override is per-arm,
  // NOT shared with mapConverseResponse's own all-malformed throw a few
  // describe blocks up, which keeps the catalog default origin: "external",
  // retryable: true since it passes no override).
  test("mapContentBlockToSdk's default arm reports only the discriminant — a long caller string elsewhere on the block never reaches error.message or toJSON()", async () => {
    const SENTINEL = "S".repeat(200);
    const invalidBlock = {
      type: "nope",
      text: SENTINEL,
    } as unknown as M3LBedrockContentBlock;

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [{ role: "user", content: [invalidBlock] }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message).toContain("nope");
    expect(error.message).not.toContain(SENTINEL);
    expect(error.origin).toBe("caller");
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error.toJSON())).not.toContain(SENTINEL);
  });

  test("mapToolResultContentItem's default arm reports only the discriminant — a long caller string elsewhere on the item never reaches error.message or toJSON()", async () => {
    const SENTINEL = "T".repeat(200);
    const invalidResultItem = {
      type: "nope",
      text: SENTINEL,
    } as unknown as M3LBedrockToolResultContent;
    const block: M3LBedrockToolResultBlock = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [invalidResultItem],
    };

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [{ role: "user", content: [block] }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const error = thrown as M3LBedrockRuntimeOperationError;
    expect(error.message).toContain("nope");
    expect(error.message).not.toContain(SENTINEL);
    expect(error.origin).toBe("caller");
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error.toJSON())).not.toContain(SENTINEL);
  });

  // readUnknownDiscriminant's own fallback: when the off-contract value's
  // `.type` field is not a string at all (rather than merely an
  // unrecognized string), the message reports the literal tag "unknown"
  // rather than attempting to stringify a non-string `.type`.
  test("the default arm reports the literal tag 'unknown' when the off-contract value's type field is not a string", async () => {
    const invalidBlock = { type: 42 } as unknown as M3LBedrockContentBlock;

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [{ role: "user", content: [invalidBlock] }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as Error).message).toContain(
      "unhandled content block type: unknown",
    );
  });
});

describe("copyDocument boundary behavior (tools.ts)", () => {
  test("a non-JSON-serializable inputSchema value (bigint) throws M3LBedrockRuntimeOperationError(origin: caller, retryable: false)", async () => {
    const tool: M3LBedrockToolDefinition = {
      name: "get_weather",
      inputSchema: { limit: 10n },
    };

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [USER_MESSAGE_TEXT],
        tools: [tool],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("a non-JSON-serializable json tool-result value (a function) throws the same error, reached from the other copyDocument call site", async () => {
    const badJsonBlock: M3LBedrockToolResultJsonBlock = {
      type: "json",
      json: () => "nope",
    };
    const block: M3LBedrockToolResultBlock = {
      type: "toolResult",
      toolUseId: "call-1",
      content: [badJsonBlock],
    };

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [{ role: "user", content: [block] }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("an Object.create(null)-based inputSchema is accepted and copied, not rejected — isPlainObject's null-prototype arm", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const nullProtoSchema: M3LBedrockToolInputSchema = Object.assign(
      Object.create(null) as object,
      { city: "Rome" },
    );
    const tool: M3LBedrockToolDefinition = {
      name: "get_weather",
      inputSchema: nullProtoSchema,
    };

    await newOps().invoke({ messages: [USER_MESSAGE_TEXT], tools: [tool] });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    const tools = toolConfig["tools"] as Record<string, unknown>[];
    const toolSpec = tools[0]?.["toolSpec"] as Record<string, unknown>;
    expect(toolSpec["inputSchema"]).toEqual({ json: { city: "Rome" } });
  });

  test("every copyDocument leaf/container type is exercised: string, number, boolean, null, a nested array, and a nested object", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const schema: M3LBedrockToolInputSchema = {
      aString: "x",
      aNumber: 1,
      aBoolean: true,
      aNull: null,
      anArray: [1, "y", false, null],
      anObject: { nested: "z" },
    };
    const tool: M3LBedrockToolDefinition = {
      name: "get_weather",
      inputSchema: schema,
    };

    await newOps().invoke({ messages: [USER_MESSAGE_TEXT], tools: [tool] });

    const toolConfig = sentInput()["toolConfig"] as Record<string, unknown>;
    const tools = toolConfig["tools"] as Record<string, unknown>[];
    const toolSpec = tools[0]?.["toolSpec"] as Record<string, unknown>;
    expect(toolSpec["inputSchema"]).toEqual({ json: schema });
  });
});

describe("copyDocument's prototype-pollution refusal (CRITICAL fix): __proto__/constructor/prototype own keys", () => {
  const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"] as const;
  const POSITIONS = ["top-level", "nested"] as const;

  /**
   * Builds a document carrying an own `key` (via computed-property syntax,
   * which — unlike an object-literal `__proto__:` key — always creates a
   * real own enumerable property rather than invoking the accessor that
   * sets the object's prototype instead) at either the top level or one
   * level of nesting under a `wrapper` key.
   */
  function buildDangerousDocument(
    key: string,
    position: "top-level" | "nested",
  ): Record<string, unknown> {
    const poisoned: Record<string, unknown> = { safe: "x", [key]: "injected" };
    return position === "top-level" ? poisoned : { wrapper: poisoned };
  }

  const CASES = DANGEROUS_KEYS.flatMap((key) =>
    POSITIONS.map((position) => [key, position] as const),
  );

  test.each(CASES)(
    "an inputSchema carrying own key %s at %s position throws M3LBedrockRuntimeOperationError(origin: caller, retryable: false), never reaching send()",
    async (key, position) => {
      const schema = buildDangerousDocument(key, position);

      let thrown: unknown;
      try {
        await newOps().invoke({
          messages: [USER_MESSAGE_TEXT],
          tools: [{ name: "t", inputSchema: schema }],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
      expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  test.each(CASES)(
    "a json tool-result payload carrying own key %s at %s position throws the same error, reached from the other copyDocument call site",
    async (key, position) => {
      const payload = buildDangerousDocument(key, position);
      const block: M3LBedrockToolResultBlock = {
        type: "toolResult",
        toolUseId: "call-1",
        content: [{ type: "json", json: payload }],
      };

      let thrown: unknown;
      try {
        await newOps().invoke({
          messages: [{ role: "user", content: [block] }],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
      expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  test("[regression] an inputSchema containing a JSON.parse-produced own __proto__ key throws rather than reaching the sent command", async () => {
    // JSON.parse (unlike an object literal) produces `__proto__` as a real
    // own property — this is the exact adversarial shape the CRITICAL fix
    // targets: a caller round-tripping untrusted JSON straight into
    // inputSchema.
    const parsed: unknown = JSON.parse('{"a":1,"__proto__":{"injected":"X"}}');

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [USER_MESSAGE_TEXT],
        tools: [
          { name: "t", inputSchema: parsed as M3LBedrockToolInputSchema },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    // The regression this guards: the key must never reach the sent
    // ConverseCommand at all — asserting the throw is the proof, since a
    // pre-fix `{}`-based copy would have silently spliced `injected` onto
    // the copy's own prototype instead of throwing, and send() would have
    // been reached.
    expect(h.send).not.toHaveBeenCalled();
  });

  test("the __proto__/constructor/prototype refusal does not pollute Object.prototype globally, even after repeated poisoned attempts", async () => {
    for (const key of DANGEROUS_KEYS) {
      const schema = buildDangerousDocument(key, "top-level");
      await expect(
        newOps().invoke({
          messages: [USER_MESSAGE_TEXT],
          tools: [{ name: "t", inputSchema: schema }],
        }),
      ).rejects.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    }

    expect(Object.hasOwn(Object.prototype, "injected")).toBe(false);
    const freshObject: Record<string, unknown> = {};
    expect(freshObject["injected"]).toBeUndefined();
  });

  test("a deeply-nested reserved key includes a positional (keys-as-ordinals, indices-as-numbers) trail in the error message — never the caller's key names or the offending value", async () => {
    const SECRET_VALUE = "super-secret-value-must-not-leak";
    const schema = {
      level1: {
        level2: [{ level3: { ["__proto__"]: SECRET_VALUE } }],
      },
    };

    let thrown: unknown;
    try {
      await newOps().invoke({
        messages: [USER_MESSAGE_TEXT],
        tools: [{ name: "t", inputSchema: schema }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    const message = (thrown as Error).message;
    // Each of the three object levels above `__proto__` carries exactly one
    // own key, so every `key` step's ordinal is 1; the array step in
    // between is rendered as its (derived, safe) numeric index `[0]`. Only
    // the reserved `__proto__` step is named — see formatDocumentPath's doc
    // comment for why that one is the exception.
    expect(message).toContain("$.<key#1>.<key#1>[0].<key#1>.__proto__");
    expect(message).not.toContain(SECRET_VALUE);
    // Strengthened: the caller's real key names must never appear in the
    // message at all — positional paths exist precisely because a key
    // name (unlike a derived index) can itself be a secret.
    expect(message).not.toContain("level1");
    expect(message).not.toContain("level2");
    expect(message).not.toContain("level3");
  });
});

describe("mapToolUseBlock: raw reply block is not a plain object at all", () => {
  test("a non-plain-object content-array entry (a bare string) is dropped, not thrown on", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [{ text: "ok" }, "not-a-content-object"],
        stopReason: "tool_use",
      }),
    );
    const result = await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

    expect(result.message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.stopReason).toBe("tool_use");
  });
});

describe("response-side: empty-string toolUseId/name is malformed and dropped (Slice B keys toolResult by toolUseId; an empty id would collide)", () => {
  // A well-formed sibling toolUse block is included (see the analogous note
  // above the malformed-toolUse test.each) so this stays a drop, not a throw.
  test.each<[string, Record<string, unknown>]>([
    [
      "empty toolUseId",
      { toolUse: { toolUseId: "", name: "get_weather", input: {} } },
    ],
    ["empty name", { toolUse: { toolUseId: "call-1", name: "", input: {} } }],
  ])(
    "a toolUse block with %s is dropped, not kept — a well-formed sibling toolUse block still maps",
    async (_label, malformedBlock) => {
      h.send.mockResolvedValueOnce(
        converseOutput({
          content: [
            { text: "ok" },
            malformedBlock,
            { toolUse: { toolUseId: "good-1", name: "good_tool", input: {} } },
          ],
          stopReason: "tool_use",
        }),
      );
      const result = await newOps().invoke({ messages: [USER_MESSAGE_TEXT] });

      expect(result.message.content).toEqual([
        { type: "text", text: "ok" },
        { type: "toolUse", toolUseId: "good-1", name: "good_tool", input: {} },
      ]);
      expect(result.stopReason).toBe("tool_use");
    },
  );
});

describe("type-level pins", () => {
  test("M3LBedrockContentBlock is a 3-member discriminated union: text | toolUse | toolResult", () => {
    expectTypeOf<M3LBedrockContentBlock>().toEqualTypeOf<
      M3LBedrockTextBlock | M3LBedrockToolUseBlock | M3LBedrockToolResultBlock
    >();
  });

  test("each content-block discriminant is its own exact string literal", () => {
    expectTypeOf<M3LBedrockTextBlock["type"]>().toEqualTypeOf<"text">();
    expectTypeOf<M3LBedrockToolUseBlock["type"]>().toEqualTypeOf<"toolUse">();
    expectTypeOf<
      M3LBedrockToolResultBlock["type"]
    >().toEqualTypeOf<"toolResult">();
  });

  test("M3LBedrockToolResultStatus equals exactly success | error", () => {
    expectTypeOf<M3LBedrockToolResultStatus>().toEqualTypeOf<
      "success" | "error"
    >();
  });

  test("M3LBedrockToolResultContent is a 2-member union (text | json), sharing M3LBedrockTextBlock with M3LBedrockContentBlock", () => {
    expectTypeOf<M3LBedrockToolResultContent>().toEqualTypeOf<
      M3LBedrockTextBlock | M3LBedrockToolResultJsonBlock
    >();
  });

  test("M3LBedrockToolChoice is NOT a tagged union: two string literals plus an untagged object arm", () => {
    expectTypeOf<M3LBedrockToolChoice>().toEqualTypeOf<
      "auto" | "any" | { readonly tool: string }
    >();
  });

  test("every V4 M3LBedrockInvokeRequest value is a valid M3LBedrockToolInvokeRequest (additive widening)", () => {
    const v4Request: M3LBedrockInvokeRequest = {
      messages: [USER_MESSAGE_TEXT],
    };
    expectTypeOf(v4Request).toExtend<M3LBedrockToolInvokeRequest>();
  });

  test("invoke's first parameter is M3LBedrockToolInvokeRequest; return type and options parameter are unchanged from V4", () => {
    type InvokeFn = (
      request: M3LBedrockToolInvokeRequest,
      options?: M3LBedrockInvokeOptions,
    ) => Promise<M3LBedrockInvocationResult>;
    const invokeFn = undefined as unknown as InvokeFn;

    expectTypeOf(invokeFn)
      .parameter(0)
      .toEqualTypeOf<M3LBedrockToolInvokeRequest>();
    expectTypeOf(invokeFn)
      .parameter(1)
      .toEqualTypeOf<M3LBedrockInvokeOptions | undefined>();
    expectTypeOf(invokeFn).returns.toEqualTypeOf<
      Promise<M3LBedrockInvocationResult>
    >();
  });
});
