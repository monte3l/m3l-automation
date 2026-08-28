/**
 * Tests for aws/bedrock-runtime submodule (slice 1 — core wrapper, no
 * streaming).
 *
 * Contract source: docs/reference/aws/bedrock-runtime.md, ADR-0059.
 *
 * Exports under test (from `../src/aws/index.js`, the package's public
 * barrel — this submodule has no `bedrockRuntimeOperations` convenience
 * getter, so callers always construct `M3LBedrockRuntimeOperations`
 * directly): `M3LBedrockRuntimeOperations`, `M3LBedrockRuntimeOperationError`,
 * `M3LBedrockRuntimeModelError`, `M3LBedrockRuntimeNoModelError`, and the
 * `M3LBedrock*` plain types.
 *
 * Scope: slice 1 only. `invokeStream` / `M3LBedrockStreamEvent` do not exist
 * yet (added whole in slice 2) and are neither imported nor exercised here.
 *
 * Mocking strategy: `@aws-sdk/client-bedrock-runtime` is mocked with a
 * top-level `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/sqs.test.ts`), with a `.send()` spy dispatching every
 * `ConverseCommand` call — the only command class this slice sends.
 *
 * Fake-timer strategy mirrors `tests/athena.test.ts`: `vi.useFakeTimers()` in
 * `beforeEach`, `settleWithTimers` to drive retry/backoff delays without
 * real wall-clock waits, and a `Promise.race` against a short
 * `vi.advanceTimersByTimeAsync` window to prove an abort abandons a pending
 * backoff delay rather than sleeping it out.
 *
 * This is the TDD RED seam: none of these symbols exist in `src/` yet, so
 * every test here is expected to fail on import ("Cannot find module" / "has
 * no exported member"), not on an assertion inside a running test.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class ConverseCommand {
    constructor(readonly input: unknown) {}
  }
  class BedrockRuntimeClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return { send, destroy, BedrockRuntimeClient, ConverseCommand };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: h.BedrockRuntimeClient,
  ConverseCommand: h.ConverseCommand,
}));

import {
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";

import {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeNoModelError,
  M3LBedrockRuntimeOperationError,
  M3LBedrockRuntimeOperations,
} from "../src/aws/index.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInferenceConfig,
  M3LBedrockInvocationResult,
  M3LBedrockInvokeOptions,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockRuntimeOptions,
  M3LBedrockRuntimeRole,
  M3LBedrockStopReason,
  M3LBedrockTextBlock,
  M3LBedrockTokenUsage,
} from "../src/aws/index.js";

import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

const MODEL_A = "anthropic.claude-opus-5";
const MODEL_B = "anthropic.claude-sonnet-5";

/** Casts the hoisted fake `BedrockRuntimeClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): BedrockRuntimeClient {
  return new h.BedrockRuntimeClient() as unknown as BedrockRuntimeClient;
}

/**
 * Builds `M3LBedrockRuntimeOptions` from an ordered model-id list.
 *
 * Deliberately keeps its parameter typed as `readonly string[]`, NOT the
 * type-level non-empty tuple `M3LBedrockRuntimeOptions["models"]` — the
 * empty-`models` test below (exercising the constructor's runtime guard)
 * must keep compiling. The cast on return models exactly the doc's "a
 * config- or JSON-sourced `string[]` can still arrive empty after being
 * downcast to satisfy the type" scenario.
 */
function buildOptions(models: readonly string[]): M3LBedrockRuntimeOptions {
  return { models } as M3LBedrockRuntimeOptions;
}

/** Builds a fake SDK exception carrying the given `name`, matching how `@aws-sdk` errors surface their exception type. */
function sdkError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * Fires `controller.abort()` after exactly `ticks` microtask turns, by
 * nesting `queueMicrotask` `ticks` levels deep before aborting on the
 * innermost turn.
 *
 * Used to land an abort precisely between two internal checks in
 * `client.ts` that are each separated from a settled `send()` rejection by
 * one microtask hop under V8's single-tick `await` optimization:
 * `M3LRetryRunner.run`'s own catch-time `isAborted` check (0 ticks after
 * `send()` rejects), `#invokeOnModel`'s own catch-time `isAborted`
 * re-check (2 ticks — after the retry runner's classifier resolves and
 * rethrows), and `invoke()`'s loop-level `isAborted` re-check between
 * fallback attempts (3 ticks — one more hop, after `#invokeOnModel`
 * returns its `"advance"` outcome). Verified empirically via the coverage
 * gate (`pnpm --filter @m3l-automation/m3l-common exec vitest run
 * tests/bedrock-runtime.test.ts --coverage...`) that these tick counts
 * land on the intended branch; a behavior-preserving refactor that changes
 * the number of `await` hops between these checks would require
 * recalibrating the tick count here, not rewriting the test's intent.
 */
function scheduleAbortAfterTicks(
  controller: AbortController,
  ticks: number,
): void {
  if (ticks <= 0) {
    controller.abort();
    return;
  }
  queueMicrotask(() => {
    scheduleAbortAfterTicks(controller, ticks - 1);
  });
}

const USER_ROLE: M3LBedrockRuntimeRole = "user";

const USER_MESSAGE: M3LBedrockMessage = {
  role: USER_ROLE,
  content: [{ type: "text", text: "hi" }],
};

const BASE_REQUEST: M3LBedrockInvokeRequest = {
  messages: [USER_MESSAGE],
};

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

/**
 * Drives a promise to settlement while flushing pending fake timers, so
 * retry/backoff delays resolve without real wall-clock waits (mirrors
 * `settleWithTimers` in `tests/athena.test.ts`).
 */
async function settleWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const settledOutcome = Promise.allSettled([promise]).then((results) => {
    settled = true;
    return results[0];
  });
  for (let i = 0; i < 1000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  const outcome = await settledOutcome;
  if (outcome !== undefined && outcome.status === "rejected") {
    throw outcome.reason;
  }
  if (outcome === undefined) {
    throw new Error("settleWithTimers: promise never settled");
  }
  return outcome.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.send.mockReset();
  h.destroy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("M3LBedrockRuntimeOperations constructor", () => {
  test("throws M3LBedrockRuntimeNoModelError synchronously for an empty models list, with attemptedModels: []", () => {
    let thrown: unknown;
    try {
      new M3LBedrockRuntimeOperations(fakeClient(), buildOptions([]));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeNoModelError);
    expect((thrown as M3LBedrockRuntimeNoModelError).attemptedModels).toEqual(
      [],
    );
    // Construction-time throw carries no cause — no attempt was ever made.
    expect((thrown as M3LBedrockRuntimeNoModelError).cause).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
  });

  test("a non-empty models list constructs without throwing and performs no I/O before invoke()", () => {
    expect(() => {
      new M3LBedrockRuntimeOperations(fakeClient(), buildOptions([MODEL_A]));
    }).not.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("M3LBedrockRuntimeOperations.invoke() — model fallback state machine", () => {
  test("single model, immediate success maps modelId/message/stopReason/usage from a well-formed response", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({ content: [{ text: "hi there" }] }),
    );
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.modelId).toBe(MODEL_A);
    expect(result.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual(FULL_USAGE);
  });

  test("ThrottlingException retried twice on the SAME model before succeeding — not fallback (send called exactly 3 times, all for the same model)", async () => {
    h.send
      .mockRejectedValueOnce(sdkError("ThrottlingException"))
      .mockRejectedValueOnce(sdkError("ThrottlingException"))
      .mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.modelId).toBe(MODEL_A);
    expect(h.send).toHaveBeenCalledTimes(3);
    for (const call of h.send.mock.calls) {
      const [command] = call as [{ input: { modelId: string } }];
      expect(command.input.modelId).toBe(MODEL_A);
    }
  });

  test("InternalServerException retried on the SAME model before succeeding — not fallback (send called exactly 3 times, all for the same model)", async () => {
    h.send
      .mockRejectedValueOnce(sdkError("InternalServerException"))
      .mockRejectedValueOnce(sdkError("InternalServerException"))
      .mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.modelId).toBe(MODEL_A);
    expect(h.send).toHaveBeenCalledTimes(3);
    for (const call of h.send.mock.calls) {
      const [command] = call as [{ input: { modelId: string } }];
      expect(command.input.modelId).toBe(MODEL_A);
    }
  });

  test("ModelNotReadyException on models[0] advances fallback to models[1] immediately, with NO same-model retry", async () => {
    h.send
      .mockRejectedValueOnce(sdkError("ModelNotReadyException"))
      .mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.modelId).toBe(MODEL_B);
    expect(h.send).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = h.send.mock.calls as [
      [{ input: { modelId: string } }],
      [{ input: { modelId: string } }],
    ];
    expect(firstCall[0].input.modelId).toBe(MODEL_A);
    expect(secondCall[0].input.modelId).toBe(MODEL_B);
  });

  test("ModelTimeoutException on models[0] advances fallback to models[1] immediately, with NO same-model retry", async () => {
    h.send
      .mockRejectedValueOnce(sdkError("ModelTimeoutException"))
      .mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.modelId).toBe(MODEL_B);
    expect(h.send).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = h.send.mock.calls as [
      [{ input: { modelId: string } }],
      [{ input: { modelId: string } }],
    ];
    expect(firstCall[0].input.modelId).toBe(MODEL_A);
    expect(secondCall[0].input.modelId).toBe(MODEL_B);
  });

  // Regression target: reusing awsThrottling()'s generic 5xx status classifier
  // unmodified would retry a 503 ServiceUnavailableException on the SAME
  // model, contradicting the contract's "advance fallback immediately, no
  // same-model retry" rule for this exception. Assert precisely: exactly one
  // call for models[0], then exactly one call for models[1].
  test("ServiceUnavailableException (a 503) advances fallback immediately — NOT retried on the same model despite matching the generic 5xx retry classifier", async () => {
    h.send
      .mockRejectedValueOnce(sdkError("ServiceUnavailableException"))
      .mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.modelId).toBe(MODEL_B);
    expect(h.send).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = h.send.mock.calls as [
      [{ input: { modelId: string } }],
      [{ input: { modelId: string } }],
    ];
    expect(firstCall[0].input.modelId).toBe(MODEL_A);
    expect(secondCall[0].input.modelId).toBe(MODEL_B);
  });

  test("ModelErrorException throws M3LBedrockRuntimeModelError immediately — no retry, no fallback (models[1] is never called)", async () => {
    const cause = sdkError("ModelErrorException", "the model faulted");
    h.send.mockRejectedValueOnce(cause);
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    let thrown: unknown;
    try {
      await settleWithTimers(ops.invoke(BASE_REQUEST));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeModelError);
    expect((thrown as M3LBedrockRuntimeModelError).modelId).toBe(MODEL_A);
    expect((thrown as M3LBedrockRuntimeModelError).context["modelId"]).toBe(
      MODEL_A,
    );
    expect((thrown as M3LBedrockRuntimeModelError).cause).toBe(cause);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  const CALLER_FAULT_EXCEPTIONS = [
    "ValidationException",
    "AccessDeniedException",
    "ResourceNotFoundException",
    "ServiceQuotaExceededException",
  ] as const;

  test.each(CALLER_FAULT_EXCEPTIONS)(
    "%s throws M3LBedrockRuntimeOperationError immediately with a caller/false override — no retry, no fallback (models[1] is never called)",
    async (exceptionName) => {
      h.send.mockRejectedValueOnce(sdkError(exceptionName));
      const ops = new M3LBedrockRuntimeOperations(
        fakeClient(),
        buildOptions([MODEL_A, MODEL_B]),
      );

      let thrown: unknown;
      try {
        await settleWithTimers(ops.invoke(BASE_REQUEST));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("caller");
      expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(false);
      expect(h.send).toHaveBeenCalledTimes(1);
    },
  );

  test("every model exhausted by availability faults throws M3LBedrockRuntimeNoModelError naming every attempted model id, in order, with cause chaining the LAST attempt's fault", async () => {
    const notReadyError = sdkError("ModelNotReadyException");
    h.send.mockRejectedValue(notReadyError);
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    let thrown: unknown;
    try {
      await settleWithTimers(ops.invoke(BASE_REQUEST));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeNoModelError);
    expect((thrown as M3LBedrockRuntimeNoModelError).attemptedModels).toEqual([
      MODEL_A,
      MODEL_B,
    ]);
    expect(
      (thrown as M3LBedrockRuntimeNoModelError).context["attemptedModels"],
    ).toEqual([MODEL_A, MODEL_B]);
    // cause chains the LAST attempted model's rejection (models[1]'s fault,
    // since h.send.mockRejectedValue reuses the same instance for every call).
    expect((thrown as M3LBedrockRuntimeNoModelError).cause).toBe(notReadyError);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  // Highest-value regression in this suite: an exhausted same-model retry
  // (Throttling/InternalServerException) on the LAST model in the list must
  // still advance fallback (finding no models remain) and throw
  // M3LBedrockRuntimeNoModelError — never M3LBedrockRuntimeOperationError,
  // which the "any other rejection" catch-all row could wrongly produce if
  // exhaustion were mishandled as a bare send() failure.
  test("throttling retries exhausted on the LAST model throws M3LBedrockRuntimeNoModelError, never M3LBedrockRuntimeOperationError", async () => {
    const throttleError = sdkError("ThrottlingException");
    h.send.mockRejectedValue(throttleError);
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    let thrown: unknown;
    try {
      await settleWithTimers(ops.invoke(BASE_REQUEST));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeNoModelError);
    expect(thrown).not.toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeNoModelError).attemptedModels).toEqual([
      MODEL_A,
    ]);
    // cause chains the last (10th) attempt's rejection.
    expect((thrown as M3LBedrockRuntimeNoModelError).cause).toBe(throttleError);
    // Default M3LRetryRunner exhaustion bound (see M3LRetryRunner.ts
    // DEFAULT_RETRY_MAX_ATTEMPTS = 10, and tests/sqs.test.ts's identical
    // "exhausted after exactly 10 attempts" assertion for the same default).
    expect(h.send).toHaveBeenCalledTimes(10);
  });

  test("an unclassified rejection (unknown exception name) throws M3LBedrockRuntimeOperationError with the default external/true classification", async () => {
    const cause = new Error("boom");
    h.send.mockRejectedValueOnce(cause);
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    let thrown: unknown;
    try {
      await settleWithTimers(ops.invoke(BASE_REQUEST));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("external");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(true);
    expect((thrown as M3LBedrockRuntimeOperationError).cause).toBe(cause);
  });

  // Covers readErrorName's non-Error branch: a rejection value with no
  // `.name` to classify by falls through every named-exception check to the
  // "any other rejection" row, same default classification as the
  // unclassified-Error case above.
  test("a non-Error rejection value (no name to classify) throws M3LBedrockRuntimeOperationError with the default external/true classification", async () => {
    const cause = "boom";

    h.send.mockRejectedValueOnce(cause);
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    let thrown: unknown;
    try {
      await settleWithTimers(ops.invoke(BASE_REQUEST));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("external");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(true);
    expect((thrown as M3LBedrockRuntimeOperationError).cause).toBe(cause);
  });
});

describe("M3LBedrockRuntimeOperations.invoke() — request/response mapping", () => {
  test("request.system present sends system: [{ text: <value> }] on the command input", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    await settleWithTimers(ops.invoke({ ...BASE_REQUEST, system: "be terse" }));

    const [command] = h.send.mock.calls[0] as [
      { input: Record<string, unknown> },
    ];
    expect(command.input["system"]).toEqual([{ text: "be terse" }]);
  });

  test("request.system absent carries NO system key on the command input (not system: undefined)", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    await settleWithTimers(ops.invoke(BASE_REQUEST));

    const [command] = h.send.mock.calls[0] as [
      { input: Record<string, unknown> },
    ];
    expect(Object.hasOwn(command.input, "system")).toBe(false);
  });

  test("request.inferenceConfig maps through to the command input's inferenceConfig unchanged", async () => {
    h.send.mockResolvedValueOnce(converseOutput());
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );
    const inferenceConfig: M3LBedrockInferenceConfig = {
      maxTokens: 256,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["STOP"],
    };

    await settleWithTimers(ops.invoke({ ...BASE_REQUEST, inferenceConfig }));

    const [command] = h.send.mock.calls[0] as [
      { input: Record<string, unknown> },
    ];
    expect(command.input["inferenceConfig"]).toEqual(inferenceConfig);
  });

  const MALFORMED_RESPONSE_CASES: ReadonlyArray<
    readonly [label: string, response: Record<string, unknown>]
  > = [
    ["missing output", { stopReason: "end_turn", usage: FULL_USAGE }],
    [
      "missing stopReason",
      {
        output: { message: { role: "assistant", content: [{ text: "x" }] } },
        usage: FULL_USAGE,
      },
    ],
    [
      "missing usage",
      {
        output: { message: { role: "assistant", content: [{ text: "x" }] } },
        stopReason: "end_turn",
      },
    ],
    [
      "output matching $UnknownMember rather than the expected message member",
      {
        output: { $unknown: ["future", {}] },
        stopReason: "end_turn",
        usage: FULL_USAGE,
      },
    ],
    [
      "a stopReason outside the 9 documented M3LBedrockStopReason members (a well-formed response otherwise)",
      {
        output: { message: { role: "assistant", content: [{ text: "x" }] } },
        stopReason: "some_future_reason",
        usage: FULL_USAGE,
      },
    ],
  ];

  test.each(MALFORMED_RESPONSE_CASES)(
    "a response with %s throws M3LBedrockRuntimeOperationError (malformed-but-successful response), default external/true, never retried",
    async (_label, response) => {
      h.send.mockResolvedValueOnce(response);
      const ops = new M3LBedrockRuntimeOperations(
        fakeClient(),
        buildOptions([MODEL_A]),
      );

      let thrown: unknown;
      try {
        await settleWithTimers(ops.invoke(BASE_REQUEST));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe(
        "external",
      );
      expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
    },
  );

  test('a response message.role of "user" maps through to M3LBedrockRuntimeRole "user" (mapRole\'s true branch)', async () => {
    h.send.mockResolvedValueOnce({
      output: {
        message: { role: "user", content: [{ text: "echoed" }] },
      },
      stopReason: "end_turn",
      usage: FULL_USAGE,
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.message.role).toBe("user");
  });

  test("a response message with no content field maps to an empty content array (mapContent's ?? [] fallback)", async () => {
    h.send.mockResolvedValueOnce({
      output: {
        message: { role: "assistant" },
      },
      stopReason: "end_turn",
      usage: FULL_USAGE,
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    expect(result.message.content).toEqual([]);
  });

  test("a non-text content block in the reply is dropped silently, keeping only text blocks (no throw)", async () => {
    h.send.mockResolvedValueOnce(
      converseOutput({
        content: [
          { toolUse: { toolUseId: "t-1", name: "lookup", input: {} } },
          { text: "kept" },
        ],
      }),
    );
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const result: M3LBedrockInvocationResult = await settleWithTimers(
      ops.invoke(BASE_REQUEST),
    );

    const expectedContent: readonly M3LBedrockContentBlock[] = [
      { type: "text", text: "kept" },
    ];
    expect(result.message.content).toEqual(expectedContent);
  });
});

describe("M3LBedrockRuntimeOperations.invoke() — cancellation", () => {
  test("a signal already aborted before invoke() is called rejects with M3LOperationAbortedError without calling send", async () => {
    const controller = new AbortController();
    controller.abort();
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );
    const options: M3LBedrockInvokeOptions = { signal: controller.signal };

    const thrown = await settleWithTimers(
      ops.invoke(BASE_REQUEST, options).catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect((thrown as M3LOperationAbortedError).code).toBe(
      "ERR_OPERATION_ABORTED",
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  test("a signal aborting mid-retry-backoff rejects immediately with M3LOperationAbortedError and never advances fallback past the in-flight model", async () => {
    const controller = new AbortController();
    h.send.mockImplementation(() => {
      controller.abort();
      return Promise.reject(sdkError("ThrottlingException"));
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const promise = ops.invoke(BASE_REQUEST, { signal: controller.signal });

    // Advance only 100ms — less than the 200ms minimum awsThrottling-style
    // backoff. A signal-aware retry runner abandons the pending delay
    // immediately (0ms) and the race resolves to M3LOperationAbortedError; a
    // signal-unaware runner is still sleeping and the sentinel wins instead.
    const result = await Promise.race([
      promise.catch((error: unknown) => error),
      vi.advanceTimersByTimeAsync(100).then(() => "no-rejection"),
    ]);

    expect(result).toBeInstanceOf(M3LOperationAbortedError);
    expect(h.send).toHaveBeenCalledTimes(1);
    const [command] = h.send.mock.calls[0] as [{ input: { modelId: string } }];
    expect(command.input.modelId).toBe(MODEL_A);
  });

  // Targets invoke()'s own loop-level `isAborted` re-check between fallback
  // attempts — distinct from #invokeOnModel's catch-time re-check (the next
  // test) and from M3LRetryRunner's own catch-time check (the mid-retry-backoff
  // test above). ModelNotReadyException advances fallback WITHOUT entering the
  // retry runner's backoff, so #invokeOnModel must return its "advance"
  // outcome normally (not aborted yet) before the abort lands in the gap
  // right before invoke() would try models[1].
  test("an abort landing in the gap between fallback attempts stops the walk before trying the next model — models[1] is never called", async () => {
    const controller = new AbortController();
    h.send.mockImplementationOnce(() => {
      scheduleAbortAfterTicks(controller, 3);
      return Promise.reject(sdkError("ModelNotReadyException"));
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const thrown = await settleWithTimers(
      ops
        .invoke(BASE_REQUEST, { signal: controller.signal })
        .catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect(h.send).toHaveBeenCalledTimes(1);
    const [command] = h.send.mock.calls[0] as [{ input: { modelId: string } }];
    expect(command.input.modelId).toBe(MODEL_A);
  });

  // Targets #invokeOnModel's own catch-time `isAborted` re-check — distinct
  // from the pre-send() abort check (first test above) and from the
  // loop-level fallback-gap check (previous test). The reactive check is
  // stricter than the two proactive `isAborted`-only checks: it promotes a
  // caught rejection to M3LOperationAbortedError only when the rejection
  // itself is ALSO abort-shaped (`isAbortError`). A plain unclassified
  // `Error("boom")` — not `M3LOperationAbortedError`, not retriable, and not
  // named `"AbortError"` — reaches the catch block while the signal happens
  // to already be aborted for an unrelated reason; it must NOT be silently
  // reclassified as an abort. It falls through classifySendFailure's every
  // named-exception check to the "any other rejection" tier and surfaces as
  // its real type, M3LBedrockRuntimeOperationError with the default
  // external/true classification.
  test("a non-abort-shaped rejection is NOT reclassified as aborted, even when the signal is already aborted by catch time", async () => {
    const controller = new AbortController();
    h.send.mockImplementationOnce(() => {
      scheduleAbortAfterTicks(controller, 2);
      return Promise.reject(new Error("boom"));
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const thrown = await settleWithTimers(
      ops
        .invoke(BASE_REQUEST, { signal: controller.signal })
        .catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((thrown as M3LBedrockRuntimeOperationError).origin).toBe("external");
    expect((thrown as M3LBedrockRuntimeOperationError).retryable).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  // Targets the reactive check's OTHER branch: a rejection that genuinely IS
  // abort-shaped (`isAbortError` true) racing an already-aborted signal is
  // the case the reactive check exists to catch — it IS reclassified as
  // M3LOperationAbortedError, unlike the non-abort-shaped rejection above.
  test("an AbortError-shaped rejection racing an already-aborted signal is reclassified as M3LOperationAbortedError", async () => {
    const controller = new AbortController();
    h.send.mockImplementationOnce(() => {
      scheduleAbortAfterTicks(controller, 2);
      return Promise.reject(sdkError("AbortError", "aborted"));
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const thrown = await settleWithTimers(
      ops
        .invoke(BASE_REQUEST, { signal: controller.signal })
        .catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("Bedrock runtime error classes", () => {
  test("M3LBedrockRuntimeModelError carries modelId as both an own field and mirrored into context.modelId", () => {
    const cause = new Error("model fault");
    const error = new M3LBedrockRuntimeModelError("model faulted", {
      modelId: MODEL_A,
      cause,
    });

    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeModelError);
    expect(error.code).toBe("ERR_BEDROCK_RUNTIME_MODEL");
    expect(error.modelId).toBe(MODEL_A);
    expect(error.context["modelId"]).toBe(MODEL_A);
    expect(error.cause).toBe(cause);
  });

  test("M3LBedrockRuntimeNoModelError carries attemptedModels as both an own field and mirrored into context.attemptedModels, with caller/false classification", () => {
    const error = new M3LBedrockRuntimeNoModelError("no model available", {
      attemptedModels: [MODEL_A, MODEL_B],
    });

    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeNoModelError);
    expect(error.code).toBe("ERR_BEDROCK_RUNTIME_NO_MODEL");
    expect(error.attemptedModels).toEqual([MODEL_A, MODEL_B]);
    expect(error.context["attemptedModels"]).toEqual([MODEL_A, MODEL_B]);
    expect(error.origin).toBe("caller");
    expect(error.retryable).toBe(false);
  });

  test("M3LBedrockRuntimeNoModelError constructed WITH a cause option carries it as error.cause (matching M3LBedrockRuntimeModelError's cause pattern above)", () => {
    const cause = sdkError("ModelNotReadyException");
    const error = new M3LBedrockRuntimeNoModelError("no model available", {
      attemptedModels: [MODEL_A, MODEL_B],
      cause,
    });

    expect(error.cause).toBe(cause);
  });

  test("type pins: the three error classes extend M3LError; modelId/attemptedModels are real, non-optional members", () => {
    expectTypeOf<M3LBedrockRuntimeOperationError>().toExtend<M3LError>();
    expectTypeOf<M3LBedrockRuntimeModelError>().toExtend<M3LError>();
    expectTypeOf<M3LBedrockRuntimeNoModelError>().toExtend<M3LError>();
    expectTypeOf<
      M3LBedrockRuntimeModelError["modelId"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      M3LBedrockRuntimeNoModelError["attemptedModels"]
    >().toEqualTypeOf<readonly string[]>();
  });

  test("invoke's second parameter is typed M3LBedrockInvokeOptions | undefined, and it returns Promise<M3LBedrockInvocationResult>", () => {
    // Function-value form (matches tests/s3.test.ts's
    // `expectTypeOf(listObjects).returns...` precedent) — the generic-type
    // form (`expectTypeOf<Klass["method"]>()`) does not chain `.returns`
    // reliably. A local function-type alias (rather than indexing
    // `M3LBedrockRuntimeOperations["invoke"]` directly) keeps `.returns`
    // extraction well-typed even while the class itself is still
    // unresolved. `invokeFn` is never called, only used for type
    // introspection; `as unknown as` (rather than `declare const`, which
    // erases to no runtime binding and throws ReferenceError under vitest's
    // transform) keeps a real `undefined` runtime value under the right
    // compile-time type.
    type InvokeFn = (
      request: M3LBedrockInvokeRequest,
      options?: M3LBedrockInvokeOptions,
    ) => Promise<M3LBedrockInvocationResult>;
    const invokeFn = undefined as unknown as InvokeFn;
    expectTypeOf(invokeFn)
      .parameter(1)
      .toEqualTypeOf<M3LBedrockInvokeOptions | undefined>();
    expectTypeOf(invokeFn).returns.toEqualTypeOf<
      Promise<M3LBedrockInvocationResult>
    >();
  });

  test("M3LBedrockContentBlock is a single-member tagged union (M3LBedrockTextBlock) in this V4 slice", () => {
    expectTypeOf<M3LBedrockContentBlock>().toEqualTypeOf<M3LBedrockTextBlock>();
  });

  test("M3LBedrockStopReason mirrors the SDK's StopReason enum verbatim", () => {
    expectTypeOf<M3LBedrockStopReason>().toEqualTypeOf<
      | "end_turn"
      | "tool_use"
      | "max_tokens"
      | "stop_sequence"
      | "guardrail_intervened"
      | "content_filtered"
      | "malformed_tool_use"
      | "malformed_model_output"
      | "model_context_window_exceeded"
    >();
  });
});
