/**
 * Tests for aws/bedrock-runtime submodule (slice 2 — streaming extension:
 * `invokeStream()`, `M3LBedrockStreamEvent`, `M3LBedrockRuntimeStreamError`).
 *
 * Contract source: docs/reference/aws/bedrock-runtime.md ("Fault handling and
 * model fallback" § "invokeStream's two-phase fault handling", "AbortSignal
 * cancellation", `M3LBedrockStreamEvent`, `M3LBedrockRuntimeStreamError`),
 * ADR-0059.
 *
 * Scope: slice 2 only. Imports only the streaming-facing symbols
 * (`M3LBedrockRuntimeOperations` — reused, `M3LBedrockRuntimeStreamError`,
 * the streaming plain types) plus the three slice-1 error classes that
 * `invokeStream`'s pre-first-yield fault table reuses verbatim, so `perFile`
 * v8 coverage binds within this slice and `invoke()` itself is never
 * re-exercised here — that is `tests/bedrock-runtime.test.ts`'s job, and this
 * file must not modify it.
 *
 * Mocking strategy: mirrors `tests/bedrock-runtime.test.ts` — a top-level
 * `vi.mock` + `vi.hoisted` bag over `@aws-sdk/client-bedrock-runtime`, with a
 * `.send()` spy. `send()` for `invokeStream` resolves to
 * `{ stream: AsyncIterable<ConverseStreamOutput> }`; `buildStream()` below
 * constructs a fake async iterable with per-chunk control (yield a chunk,
 * throw an SDK-shaped exception, or run an arbitrary side effect such as
 * firing an `AbortController`) so fault/ordering/abort scenarios can be
 * driven precisely without a real network stream.
 *
 * This is the TDD RED seam: `invokeStream`/`M3LBedrockStreamEvent`/
 * `M3LBedrockRuntimeStreamError` do not exist in `src/` yet, so every test
 * here is expected to fail on import ("does not provide an export named…"),
 * not on an assertion inside a running test.
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

  class ConverseCommand {
    constructor(readonly input: unknown) {}
  }
  class ConverseStreamCommand {
    constructor(readonly input: unknown) {}
  }
  class BedrockRuntimeClient {
    readonly config: unknown;
    send = send;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return { send, BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: h.BedrockRuntimeClient,
  ConverseCommand: h.ConverseCommand,
  ConverseStreamCommand: h.ConverseStreamCommand,
}));

import {
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";

import {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeOperationError,
  M3LBedrockRuntimeOperations,
  M3LBedrockRuntimeStreamError,
} from "../src/aws/index.js";
import type {
  M3LBedrockInvokeOptions,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockRuntimeOptions,
  M3LBedrockRuntimeRole,
  M3LBedrockStopReason,
  M3LBedrockStreamEvent,
  M3LBedrockStreamStartEvent,
  M3LBedrockStreamStopEvent,
  M3LBedrockStreamTextDeltaEvent,
  M3LBedrockTokenUsage,
} from "../src/aws/index.js";

import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

const MODEL_A = "anthropic.claude-opus-5";
const MODEL_B = "anthropic.claude-sonnet-5";

/** Casts the hoisted fake `BedrockRuntimeClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): BedrockRuntimeClient {
  return new h.BedrockRuntimeClient() as unknown as BedrockRuntimeClient;
}

/** Builds `M3LBedrockRuntimeOptions` from an ordered, non-empty model-id list. */
function buildOptions(
  models: readonly [string, ...(readonly string[])],
): M3LBedrockRuntimeOptions {
  return { models };
}

/** Builds a fake SDK exception carrying the given `name`, matching how `@aws-sdk` errors surface their exception type. */
function sdkError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
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

/**
 * Drives a promise to settlement while flushing pending fake timers, so
 * retry/backoff delays resolve without real wall-clock waits (mirrors
 * `settleWithTimers` in `tests/bedrock-runtime.test.ts` / `tests/athena.test.ts`).
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

// ---------------------------------------------------------------------------
// Fake ConverseStreamOutput chunk builders (shapes verified against
// @aws-sdk/client-bedrock-runtime@3.1115.0's dist-types, see the research
// scratchpad §1.5 cited in the contract doc).
// ---------------------------------------------------------------------------

type FakeChunk = Record<string, unknown>;

function messageStartChunk(role = "assistant"): FakeChunk {
  return { messageStart: { role } };
}

function textDeltaChunk(text: string, contentBlockIndex?: number): FakeChunk {
  return {
    contentBlockDelta: {
      delta: { text },
      ...(contentBlockIndex !== undefined && { contentBlockIndex }),
    },
  };
}

/** A `contentBlockDelta` whose delta is a non-text member — must be dropped, never thrown on. */
function nonTextDeltaChunk(deltaKey: string, contentBlockIndex = 0): FakeChunk {
  return {
    contentBlockDelta: {
      delta: { [deltaKey]: {} },
      contentBlockIndex,
    },
  };
}

function contentBlockStartChunk(contentBlockIndex = 0): FakeChunk {
  return {
    contentBlockStart: { start: { toolUse: {} }, contentBlockIndex },
  };
}

function contentBlockStopChunk(contentBlockIndex = 0): FakeChunk {
  return { contentBlockStop: { contentBlockIndex } };
}

function messageStopChunk(stopReason: string): FakeChunk {
  return { messageStop: { stopReason } };
}

function metadataChunk(
  usage: M3LBedrockTokenUsage | Record<string, unknown>,
): FakeChunk {
  return { metadata: { usage, metrics: { latencyMs: 10 } } };
}

/** An in-band exception-shaped union member (§3.3's defence-in-depth path), rather than a thrown value. */
function exceptionChunk(key: string, error: unknown): FakeChunk {
  return { [key]: error };
}

type StreamStep =
  | { readonly kind: "yield"; readonly chunk: FakeChunk }
  | { readonly kind: "throw"; readonly error: unknown };

function yieldStep(chunk: FakeChunk): StreamStep {
  return { kind: "yield", chunk };
}

function throwStep(error: unknown): StreamStep {
  return { kind: "throw", error };
}

/**
 * Builds a fake `AsyncIterable<ConverseStreamOutput>` driven by an ordered
 * list of steps (yield a chunk, or throw mid-iteration — mirroring how a real
 * SDK exception surfaces per the contract's §1.3 "thrown from iteration"
 * finding). Exposes a `returnSpy` so tests can assert `invokeStream`'s
 * `finally` block best-effort calls `.return()` on the inner iterator (the
 * contract's §5.3 leaky-teardown note).
 */
function buildStream(steps: readonly StreamStep[]): {
  readonly stream: AsyncIterable<unknown>;
  readonly returnSpy: ReturnType<typeof vi.fn>;
} {
  const returnSpy = vi.fn(async () => {
    await Promise.resolve();
    return { done: true, value: undefined };
  });
  let index = 0;
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          await Promise.resolve();
          if (index >= steps.length) {
            return { done: true, value: undefined };
          }
          const step = steps[index];
          index += 1;
          if (step === undefined) {
            return { done: true, value: undefined };
          }
          if (step.kind === "throw") {
            throw step.error;
          }
          return { done: false, value: step.chunk };
        },
        return: returnSpy,
      };
    },
  };
  return { stream: iterable, returnSpy };
}

/**
 * A fake `AsyncIterable` whose single `next()` call fires an `AbortController`
 * as a side effect, then either throws a non-`AbortError`-shaped error (a
 * destroyed-socket rejection, per the contract's §1.7 finding) or ends
 * cleanly (the "silent-end" case) — used to drive the mid-stream abort tests,
 * which need the abort to land precisely inside the pending `next()` await.
 */
function buildAbortDuringPullStream(
  controller: AbortController,
  after:
    | { readonly kind: "throw"; readonly error: unknown }
    | { readonly kind: "end" },
): AsyncIterable<unknown> {
  let called = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          await Promise.resolve();
          if (!called) {
            called = true;
            controller.abort();
            if (after.kind === "throw") {
              throw after.error;
            }
            return { done: true, value: undefined };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** `{ stream }` — the `ConverseStreamCommandOutput`-shaped fixture `send()` resolves with. */
function converseStreamOutput(
  stream: AsyncIterable<unknown> | undefined,
): Record<string, unknown> {
  return { stream };
}

/**
 * Drains `gen` via `for await`, returning every event yielded before either
 * clean completion or a rejection — so a test can assert both the partial
 * output the caller already consumed (`events`) and the terminal fault
 * (`error`), matching how `M3LBedrockRuntimeStreamError.eventsEmitted` is
 * meant to be checked mechanically against the caller's own count.
 */
async function collectUntilThrow(
  gen: AsyncGenerator<M3LBedrockStreamEvent, void, void>,
): Promise<{
  readonly events: M3LBedrockStreamEvent[];
  readonly error: unknown;
}> {
  const events: M3LBedrockStreamEvent[] = [];
  try {
    for await (const event of gen) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  h.send.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("M3LBedrockRuntimeOperations.invokeStream() — laziness", () => {
  test("invokeStream() returns a generator synchronously and performs no I/O until the first .next()/for-await", () => {
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const gen: AsyncGenerator<M3LBedrockStreamEvent, void, void> =
      ops.invokeStream(BASE_REQUEST);

    expect(h.send).not.toHaveBeenCalled();
    expect(typeof gen.next).toBe("function");
  });

  test("a client.send() rejection surfaces only on the first .next(), not at the call to invokeStream()", async () => {
    h.send.mockRejectedValue(sdkError("ValidationException"));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const gen: AsyncGenerator<M3LBedrockStreamEvent, void, void> =
      ops.invokeStream(BASE_REQUEST);
    expect(h.send).not.toHaveBeenCalled();

    const { error } = await settleWithTimers(collectUntilThrow(gen));

    expect(error).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("invokeStream() — pre-first-yield fault handling (Phase A, hasYielded === false)", () => {
  test("ThrottlingException exhausted on the SAME model, then success on model B — yields B's events, message-start.modelId === B, no partial A output leaks", async () => {
    let callCount = 0;
    h.send.mockImplementation(() => {
      callCount += 1;
      if (callCount <= 10) {
        return Promise.reject(sdkError("ThrottlingException"));
      }
      const { stream } = buildStream([
        yieldStep(messageStartChunk()),
        yieldStep(textDeltaChunk("hello", 0)),
        yieldStep(messageStopChunk("end_turn")),
        yieldStep(metadataChunk(FULL_USAGE)),
      ]);
      return Promise.resolve(converseStreamOutput(stream));
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(error).toBeUndefined();
    expect(events).toHaveLength(3);
    const start = events[0] as M3LBedrockStreamStartEvent;
    expect(start.type).toBe("message-start");
    expect(start.modelId).toBe(MODEL_B);
    const stop = events[2] as M3LBedrockStreamStopEvent;
    expect(stop.type).toBe("message-stop");
    expect(stop.modelId).toBe(MODEL_B);
    expect(h.send).toHaveBeenCalledTimes(11);
  });

  test("ServiceUnavailableException from send() advances fallback immediately, with NO same-model retry", async () => {
    const { stream: bStream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send
      .mockRejectedValueOnce(sdkError("ServiceUnavailableException"))
      .mockResolvedValueOnce(converseStreamOutput(bStream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(error).toBeUndefined();
    expect((events[0] as M3LBedrockStreamStartEvent).modelId).toBe(MODEL_B);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  test("ServiceUnavailableException thrown from ITERATION (before any event yielded) also advances fallback to the next model", async () => {
    const { stream: aStream } = buildStream([
      throwStep(sdkError("ServiceUnavailableException")),
    ]);
    const { stream: bStream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send
      .mockResolvedValueOnce(converseStreamOutput(aStream))
      .mockResolvedValueOnce(converseStreamOutput(bStream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(error).toBeUndefined();
    expect((events[0] as M3LBedrockStreamStartEvent).modelId).toBe(MODEL_B);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  test("ModelErrorException from send() throws M3LBedrockRuntimeModelError immediately — no retry, no fallback (models[1] is never called)", async () => {
    const cause = sdkError("ModelErrorException", "the model faulted");
    h.send.mockRejectedValueOnce(cause);
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeModelError);
    expect((error as M3LBedrockRuntimeModelError).modelId).toBe(MODEL_A);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("ModelStreamErrorException thrown from ITERATION before any event is yielded throws M3LBedrockRuntimeModelError — not fallback, not M3LBedrockRuntimeStreamError (arrives only from iteration, never send())", async () => {
    const { stream } = buildStream([
      throwStep(sdkError("ModelStreamErrorException")),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeModelError);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  const CALLER_FAULT_EXCEPTIONS = [
    "ValidationException",
    "AccessDeniedException",
    "ResourceNotFoundException",
  ] as const;

  test.each(CALLER_FAULT_EXCEPTIONS)(
    "%s from send() throws M3LBedrockRuntimeOperationError immediately with a caller/false override — no retry, no fallback (models[1] is never called)",
    async (exceptionName) => {
      h.send.mockRejectedValueOnce(sdkError(exceptionName));
      const ops = new M3LBedrockRuntimeOperations(
        fakeClient(),
        buildOptions([MODEL_A, MODEL_B]),
      );

      const { events, error } = await settleWithTimers(
        collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
      );

      expect(events).toEqual([]);
      expect(error).toBeInstanceOf(M3LBedrockRuntimeOperationError);
      expect((error as M3LBedrockRuntimeOperationError).origin).toBe("caller");
      expect((error as M3LBedrockRuntimeOperationError).retryable).toBe(false);
      expect(h.send).toHaveBeenCalledTimes(1);
    },
  );

  test("ValidationException thrown from ITERATION before any event is yielded also throws M3LBedrockRuntimeOperationError with the caller/false override — no fallback", async () => {
    const { stream } = buildStream([
      throwStep(sdkError("ValidationException")),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((error as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("ConverseStreamCommandOutput.stream === undefined throws M3LBedrockRuntimeOperationError, and fallback does NOT advance", async () => {
    h.send.mockResolvedValueOnce(converseStreamOutput(undefined));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect((error as M3LBedrockRuntimeOperationError).origin).toBe("external");
    expect((error as M3LBedrockRuntimeOperationError).retryable).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("invokeStream() — post-first-yield fault handling (Phase B) and M3LBedrockRuntimeStreamError", () => {
  test("ThrottlingException thrown from ITERATION after two text-deltas rejects with M3LBedrockRuntimeStreamError, eventsEmitted === 2, modelId === A, and models[1] is never sent to", async () => {
    const { stream } = buildStream([
      yieldStep(textDeltaChunk("a")),
      yieldStep(textDeltaChunk("b")),
      throwStep(sdkError("ThrottlingException")),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toHaveLength(2);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeStreamError);
    const streamError = error as M3LBedrockRuntimeStreamError;
    expect(streamError.eventsEmitted).toBe(2);
    expect(streamError.modelId).toBe(MODEL_A);
    // Mid-stream fault (eventsEmitted >= 1): a retry would duplicate the two
    // already-delivered text-deltas, so retrySafe must be false.
    expect(streamError.retrySafe).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  // Defence-in-depth (contract §3.3): even though the shipped SDK throws
  // exception-shaped union members from iteration rather than yielding them,
  // invokeStream must also discriminate a YIELDED exception-shaped chunk and
  // route it through the identical classifier — producing the identical
  // caller-visible outcome as the thrown-value case directly above.
  test("an in-band ThrottlingException YIELDED as a union member (not thrown) produces the IDENTICAL outcome as the thrown case above", async () => {
    const { stream } = buildStream([
      yieldStep(textDeltaChunk("a")),
      yieldStep(textDeltaChunk("b")),
      yieldStep(
        exceptionChunk("throttlingException", sdkError("ThrottlingException")),
      ),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toHaveLength(2);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeStreamError);
    const streamError = error as M3LBedrockRuntimeStreamError;
    expect(streamError.eventsEmitted).toBe(2);
    expect(streamError.modelId).toBe(MODEL_A);
    expect(streamError.retrySafe).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  const COLLAPSING_EXCEPTIONS = [
    "InternalServerException",
    "ServiceUnavailableException",
  ] as const;

  test.each(COLLAPSING_EXCEPTIONS)(
    "%s thrown from iteration AFTER one event has been yielded collapses to M3LBedrockRuntimeStreamError — no retry, no fallback, regardless of its pre-boundary tier",
    async (exceptionName) => {
      const { stream } = buildStream([
        yieldStep(messageStartChunk()),
        throwStep(sdkError(exceptionName)),
      ]);
      h.send.mockResolvedValueOnce(converseStreamOutput(stream));
      const ops = new M3LBedrockRuntimeOperations(
        fakeClient(),
        buildOptions([MODEL_A, MODEL_B]),
      );

      const { events, error } = await settleWithTimers(
        collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
      );

      expect(events).toHaveLength(1);
      expect(error).toBeInstanceOf(M3LBedrockRuntimeStreamError);
      expect((error as M3LBedrockRuntimeStreamError).eventsEmitted).toBe(1);
      expect((error as M3LBedrockRuntimeStreamError).retrySafe).toBe(false);
      expect(h.send).toHaveBeenCalledTimes(1);
    },
  );

  // Asymmetry vs. the collapsing exceptions above: ModelStreamErrorException
  // was ALREADY no-retry/no-fallback pre-boundary, so it stays
  // M3LBedrockRuntimeModelError post-boundary too — it does NOT collapse to
  // M3LBedrockRuntimeStreamError the way Throttling/InternalServer/
  // ServiceUnavailable do.
  test("ModelStreamErrorException thrown from iteration AFTER a yield still throws M3LBedrockRuntimeModelError, NOT M3LBedrockRuntimeStreamError", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      throwStep(sdkError("ModelStreamErrorException")),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toHaveLength(1);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeModelError);
    expect(error).not.toBeInstanceOf(M3LBedrockRuntimeStreamError);
  });

  // Same asymmetry for ValidationException: its caller/false-override tier is
  // unchanged post-boundary, never reclassified as a stream lifecycle fault.
  test("ValidationException thrown from iteration AFTER a yield still throws M3LBedrockRuntimeOperationError with the caller/false override, NOT M3LBedrockRuntimeStreamError", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      throwStep(sdkError("ValidationException")),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toHaveLength(1);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(error).not.toBeInstanceOf(M3LBedrockRuntimeStreamError);
    expect((error as M3LBedrockRuntimeOperationError).origin).toBe("caller");
    expect((error as M3LBedrockRuntimeOperationError).retryable).toBe(false);
  });

  test("messageStop arrives but the stream ends with NO metadata event — rejects with M3LBedrockRuntimeStreamError", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(textDeltaChunk("hi")),
      yieldStep(messageStopChunk("end_turn")),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toHaveLength(2);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeStreamError);
    expect((error as M3LBedrockRuntimeStreamError).eventsEmitted).toBe(2);
    // Two events already reached the caller before truncation — a retry
    // would duplicate them, so retrySafe must be false despite this being
    // the same "drained without both messageStop+metadata" fault tier as
    // the zero-event case below (retrySafe hinges on eventsEmitted, not on
    // which fault tier fired).
    expect((error as M3LBedrockRuntimeStreamError).retrySafe).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("metadata arriving BEFORE messageStop (out-of-order) still produces exactly ONE fused message-stop event with both stopReason and usage", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(metadataChunk(FULL_USAGE)),
      yieldStep(messageStopChunk("end_turn")),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(error).toBeUndefined();
    expect(events).toHaveLength(2);
    const stopEvents = events.filter((event) => event.type === "message-stop");
    expect(stopEvents).toHaveLength(1);
    const stop = stopEvents[0] as M3LBedrockStreamStopEvent;
    expect(stop.stopReason).toBe("end_turn");
    expect(stop.usage).toEqual(FULL_USAGE);
  });

  test("a zero-event stream (drains cleanly without ever emitting anything) rejects with M3LBedrockRuntimeStreamError, eventsEmitted: 0, retrySafe: true", async () => {
    const { stream } = buildStream([]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeStreamError);
    expect((error as M3LBedrockRuntimeStreamError).eventsEmitted).toBe(0);
    // The one M3LBedrockRuntimeStreamError case reachable with retrySafe:
    // true — nothing reached the caller, so a retry duplicates nothing.
    expect((error as M3LBedrockRuntimeStreamError).retrySafe).toBe(true);
    // Truncation is its own fault tier, never fallen back from.
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("invokeStream() — dropped/unmapped chunks (tolerate, never throw)", () => {
  test("a contentBlockDelta with a reasoningContent delta is silently dropped; iteration continues to a clean finish", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(textDeltaChunk("a", 0)),
      yieldStep(nonTextDeltaChunk("reasoningContent")),
      yieldStep(textDeltaChunk("b", 0)),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(error).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      "message-start",
      "text-delta",
      "text-delta",
      "message-stop",
    ]);
  });

  const NON_TEXT_DELTA_KEYS = [
    "toolUse",
    "toolResult",
    "citation",
    "image",
    "$unknown",
  ] as const;

  test.each(NON_TEXT_DELTA_KEYS)(
    "a contentBlockDelta whose delta is `%s` (not text) is silently dropped — no throw, no yielded event for it",
    async (deltaKey) => {
      const { stream } = buildStream([
        yieldStep(messageStartChunk()),
        yieldStep(nonTextDeltaChunk(deltaKey)),
        yieldStep(messageStopChunk("end_turn")),
        yieldStep(metadataChunk(FULL_USAGE)),
      ]);
      h.send.mockResolvedValueOnce(converseStreamOutput(stream));
      const ops = new M3LBedrockRuntimeOperations(
        fakeClient(),
        buildOptions([MODEL_A]),
      );

      const { events, error } = await settleWithTimers(
        collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
      );

      expect(error).toBeUndefined();
      expect(events.map((event) => event.type)).toEqual([
        "message-start",
        "message-stop",
      ]);
    },
  );

  test("contentBlockStart and contentBlockStop events are silently dropped — no yielded event for either", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(contentBlockStartChunk(0)),
      yieldStep(textDeltaChunk("hi", 0)),
      yieldStep(contentBlockStopChunk(0)),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(error).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      "message-start",
      "text-delta",
      "message-stop",
    ]);
  });

  test("contentBlockIndex defaults to 0 when the SDK chunk omits it", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep({ contentBlockDelta: { delta: { text: "hi" } } }),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(error).toBeUndefined();
    const delta = events[1] as M3LBedrockStreamTextDeltaEvent;
    expect(delta.type).toBe("text-delta");
    expect(delta.contentBlockIndex).toBe(0);
  });
});

describe("invokeStream() — malformed terminal response (never M3LBedrockRuntimeStreamError, even when hasYielded is already true)", () => {
  test("a terminal stopReason outside the closed 9-member M3LBedrockStopReason set throws M3LBedrockRuntimeOperationError — NOT M3LBedrockRuntimeStreamError, despite events already having been yielded", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(textDeltaChunk("hi")),
      yieldStep(messageStopChunk("some_future_reason")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toHaveLength(2);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(error).not.toBeInstanceOf(M3LBedrockRuntimeStreamError);
    expect((error as M3LBedrockRuntimeOperationError).origin).toBe("external");
    expect((error as M3LBedrockRuntimeOperationError).retryable).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("terminal usage missing a required field (totalTokens) throws M3LBedrockRuntimeOperationError — NOT M3LBedrockRuntimeStreamError", async () => {
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk({ inputTokens: 1, outputTokens: 2 })),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(ops.invokeStream(BASE_REQUEST)),
    );

    expect(events).toHaveLength(1);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeOperationError);
    expect(error).not.toBeInstanceOf(M3LBedrockRuntimeStreamError);
  });
});

describe("invokeStream() — cancellation", () => {
  test("a signal already aborted before the first .next() rejects with M3LOperationAbortedError without calling send", async () => {
    const controller = new AbortController();
    controller.abort();
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );
    const options: M3LBedrockInvokeOptions = { signal: controller.signal };

    const gen: AsyncGenerator<M3LBedrockStreamEvent, void, void> =
      ops.invokeStream(BASE_REQUEST, options);
    const thrown = await settleWithTimers(
      gen.next().catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect(h.send).not.toHaveBeenCalled();
  });

  test("a signal aborting mid-retry-backoff (pre-first-yield, during send()) rejects with M3LOperationAbortedError", async () => {
    const controller = new AbortController();
    h.send.mockImplementation(() => {
      controller.abort();
      return Promise.reject(sdkError("ThrottlingException"));
    });
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const gen: AsyncGenerator<M3LBedrockStreamEvent, void, void> =
      ops.invokeStream(BASE_REQUEST, { signal: controller.signal });
    const promise = gen.next();

    const result = await Promise.race([
      promise.catch((error: unknown) => error),
      vi.advanceTimersByTimeAsync(100).then(() => "no-rejection"),
    ]);

    expect(result).toBeInstanceOf(M3LOperationAbortedError);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("mid-stream abort: catch checks isAborted(signal) FIRST — a non-AbortError-shaped rejection (a destroyed-socket error) is still classified as M3LOperationAbortedError", async () => {
    const controller = new AbortController();
    const socketError = Object.assign(new Error("read ECONNRESET"), {
      name: "Error",
    });
    const stream = buildAbortDuringPullStream(controller, {
      kind: "throw",
      error: socketError,
    });
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A, MODEL_B]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(
        ops.invokeStream(BASE_REQUEST, { signal: controller.signal }),
      ),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(M3LOperationAbortedError);
    // Fallback never advances on abort.
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("mid-stream abort, silent-end case: a destroyed socket that makes the iterator simply END (no throw) is STILL classified as M3LOperationAbortedError, not M3LBedrockRuntimeStreamError from the truncated-stream rule", async () => {
    const controller = new AbortController();
    const stream = buildAbortDuringPullStream(controller, { kind: "end" });
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const { events, error } = await settleWithTimers(
      collectUntilThrow(
        ops.invokeStream(BASE_REQUEST, { signal: controller.signal }),
      ),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(M3LOperationAbortedError);
    expect(error).not.toBeInstanceOf(M3LBedrockRuntimeStreamError);
  });

  test("an abort landing AFTER a yield resumes is re-checked before pulling the next chunk — the next .next() rejects with M3LOperationAbortedError rather than draining further", async () => {
    const controller = new AbortController();
    const { stream } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(textDeltaChunk("should not be reached")),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    const gen: AsyncGenerator<M3LBedrockStreamEvent, void, void> =
      ops.invokeStream(BASE_REQUEST, { signal: controller.signal });
    const first = await settleWithTimers(gen.next());
    expect(first.done).toBe(false);

    controller.abort();
    const second = await settleWithTimers(
      gen.next().catch((error: unknown) => error),
    );

    expect(second).toBeInstanceOf(M3LOperationAbortedError);
  });

  test("a caller break()ing out of a for-await loop runs the generator's finally, which best-effort calls .return() on the inner iterator — no error is thrown", async () => {
    const { stream, returnSpy } = buildStream([
      yieldStep(messageStartChunk()),
      yieldStep(textDeltaChunk("x")),
      yieldStep(messageStopChunk("end_turn")),
      yieldStep(metadataChunk(FULL_USAGE)),
    ]);
    h.send.mockResolvedValueOnce(converseStreamOutput(stream));
    const ops = new M3LBedrockRuntimeOperations(
      fakeClient(),
      buildOptions([MODEL_A]),
    );

    async function breakEarly(): Promise<void> {
      for await (const event of ops.invokeStream(BASE_REQUEST)) {
        if (event.type === "message-start") {
          break;
        }
      }
    }

    await expect(settleWithTimers(breakEarly())).resolves.toBeUndefined();
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("M3LBedrockRuntimeStreamError", () => {
  test("carries modelId, eventsEmitted, and retrySafe as own fields mirrored into context, origin external / retryable situational, cause chained (mid-stream fault: retrySafe false)", () => {
    const cause = sdkError("ThrottlingException");
    const error = new M3LBedrockRuntimeStreamError(
      "stream faulted mid-flight",
      { modelId: MODEL_A, eventsEmitted: 2, retrySafe: false, cause },
    );

    expect(error).toBeInstanceOf(M3LError);
    expect(error).toBeInstanceOf(M3LBedrockRuntimeStreamError);
    expect(error.code).toBe("ERR_BEDROCK_RUNTIME_STREAM");
    expect(error.modelId).toBe(MODEL_A);
    expect(error.eventsEmitted).toBe(2);
    expect(error.retrySafe).toBe(false);
    expect(error.context["modelId"]).toBe(MODEL_A);
    expect(error.context["eventsEmitted"]).toBe(2);
    expect(error.context["retrySafe"]).toBe(false);
    expect(error.origin).toBe("external");
    expect(error.retryable).toBe("situational");
    expect(error.cause).toBe(cause);
  });

  // Direct-construction counterpart to the zero-event integration scenario
  // above — retrySafe: true is reachable ONLY for the zero-event clean-drain
  // case (eventsEmitted === 0), where there is no underlying SDK fault to
  // chain, so cause stays absent per the contract.
  test("constructed with eventsEmitted: 0 and retrySafe: true (the zero-event clean-drain case) mirrors retrySafe into context and leaves cause undefined", () => {
    const error = new M3LBedrockRuntimeStreamError("truncated stream", {
      modelId: MODEL_A,
      eventsEmitted: 0,
      retrySafe: true,
    });

    expect(error.retrySafe).toBe(true);
    expect(error.context["retrySafe"]).toBe(true);
    expect(error.cause).toBeUndefined();
  });
});

describe("Type pins", () => {
  test("invokeStream's signature: (request, options?) => AsyncGenerator<M3LBedrockStreamEvent, void, void>", () => {
    // Function-value form (see tests/bedrock-runtime.test.ts's identical
    // precedent for `invoke`) — a local function-type alias keeps `.returns`
    // extraction well-typed even while the class itself is still unresolved.
    type InvokeStreamFn = (
      request: M3LBedrockInvokeRequest,
      options?: M3LBedrockInvokeOptions,
    ) => AsyncGenerator<M3LBedrockStreamEvent, void, void>;
    const invokeStreamFn = undefined as unknown as InvokeStreamFn;

    expectTypeOf(invokeStreamFn)
      .parameter(1)
      .toEqualTypeOf<M3LBedrockInvokeOptions | undefined>();
    expectTypeOf(invokeStreamFn).returns.toEqualTypeOf<
      AsyncGenerator<M3LBedrockStreamEvent, void, void>
    >();
  });

  test("M3LBedrockStreamEvent is a discriminated union of exactly the three documented member interfaces, tagged by `type`", () => {
    expectTypeOf<M3LBedrockStreamEvent>().toEqualTypeOf<
      | M3LBedrockStreamStartEvent
      | M3LBedrockStreamTextDeltaEvent
      | M3LBedrockStreamStopEvent
    >();
  });

  test("M3LBedrockStreamStartEvent/TextDeltaEvent/StopEvent field shapes match the contract exactly", () => {
    expectTypeOf<M3LBedrockStreamStartEvent>().toEqualTypeOf<{
      readonly type: "message-start";
      readonly role: M3LBedrockRuntimeRole;
      readonly modelId: string;
    }>();
    expectTypeOf<M3LBedrockStreamTextDeltaEvent>().toEqualTypeOf<{
      readonly type: "text-delta";
      readonly text: string;
      readonly contentBlockIndex: number;
    }>();
    expectTypeOf<M3LBedrockStreamStopEvent>().toEqualTypeOf<{
      readonly type: "message-stop";
      readonly stopReason: M3LBedrockStopReason;
      readonly usage: M3LBedrockTokenUsage;
      readonly modelId: string;
    }>();
  });

  test("M3LBedrockRuntimeStreamError extends M3LError; code/modelId/eventsEmitted/retrySafe are real, non-optional members of the documented types", () => {
    expectTypeOf<M3LBedrockRuntimeStreamError>().toExtend<M3LError>();
    expectTypeOf<
      M3LBedrockRuntimeStreamError["code"]
    >().toEqualTypeOf<"ERR_BEDROCK_RUNTIME_STREAM">();
    expectTypeOf<
      M3LBedrockRuntimeStreamError["modelId"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      M3LBedrockRuntimeStreamError["eventsEmitted"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      M3LBedrockRuntimeStreamError["retrySafe"]
    >().toEqualTypeOf<boolean>();
  });
});
