/**
 * Tests for src/http/stream-response.ts — the widened handler result that
 * lets a route return a stream instead of a fully-buffered
 * `M3LConsoleResponse` (X4, ADR-0066, slice 2). `src/http/stream-response.ts`
 * does not exist yet; this suite is RED until implementation lands.
 *
 * `withStreamCompletion` exists to fix the drain-release gap:
 * `http/drain-middleware.ts` releases its tracked drain unit in a `finally`
 * once `next()` resolves, which for a streaming route is at *open*, not at
 * stream completion — making an open stream invisible to the drain
 * controller's `inFlight` count. `withStreamCompletion` defers the release
 * (here modeled as `onComplete`) until the stream's `open()` promise
 * actually settles.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { jsonResponse } from "../src/http/respond.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import {
  isStreamResponse,
  withStreamCompletion,
} from "../src/http/stream-response.js";
import type {
  M3LConsoleResult,
  M3LConsoleStreamResponse,
  M3LStreamSink,
} from "../src/http/stream-response.js";

/** A stream response fixture; overrides let each test exercise one field. */
function buildStreamResponse(
  overrides: Partial<M3LConsoleStreamResponse> = {},
): M3LConsoleStreamResponse {
  return {
    kind: "stream",
    status: 200,
    headers: {},
    open: async () => {},
    ...overrides,
  };
}

/** A minimal sink double — never inspected by these tests, only passed through. */
function createFakeSink(): M3LStreamSink {
  return {
    emit: () => {},
    closed: false,
  };
}

describe("isStreamResponse", () => {
  test("returns true for a stream response", () => {
    expect(isStreamResponse(buildStreamResponse())).toBe(true);
  });

  test("returns false for a buffered M3LConsoleResponse built by jsonResponse", () => {
    const buffered: M3LConsoleResponse = jsonResponse(200, { ok: true });

    expect(isStreamResponse(buffered)).toBe(false);
  });
});

describe("type contract: M3LConsoleResult", () => {
  test("a buffered M3LConsoleResponse and a M3LConsoleStreamResponse are both assignable to M3LConsoleResult", () => {
    expectTypeOf<M3LConsoleResponse>().toMatchTypeOf<M3LConsoleResult>();
    expectTypeOf<M3LConsoleStreamResponse>().toMatchTypeOf<M3LConsoleResult>();
  });

  test("isStreamResponse narrows M3LConsoleResult correctly in both branches", () => {
    // A real function body, so tsc actually checks the narrowing inside each
    // branch (not just the boolean return value) — if `isStreamResponse`
    // narrowed incorrectly, the `expectTypeOf(result)` call in the wrong
    // branch would fail to type-check against the asserted type.
    function narrow(result: M3LConsoleResult): void {
      if (isStreamResponse(result)) {
        expectTypeOf(result).toMatchTypeOf<M3LConsoleStreamResponse>();
      } else {
        expectTypeOf(result).toMatchTypeOf<M3LConsoleResponse>();
      }
    }

    narrow(jsonResponse(200, { ok: true }));
    narrow(buildStreamResponse());
  });
});

describe("withStreamCompletion — buffered result", () => {
  test("calls onComplete immediately and returns the same result reference", () => {
    const buffered = jsonResponse(200, { ok: true });
    let completions = 0;

    const result = withStreamCompletion(buffered, () => {
      completions += 1;
    });

    expect(completions).toBe(1);
    expect(result).toBe(buffered);
  });
});

describe("withStreamCompletion — stream result", () => {
  test("does not call onComplete at wrap time, before open() is invoked", () => {
    const stream = buildStreamResponse();
    let completions = 0;

    withStreamCompletion(stream, () => {
      completions += 1;
    });

    expect(completions).toBe(0);
  });

  test("calls onComplete exactly once after open() resolves", async () => {
    let openSettled = false;
    const stream = buildStreamResponse({
      open: () => {
        openSettled = true;
        return Promise.resolve();
      },
    });
    let completions = 0;

    const wrapped = withStreamCompletion(stream, () => {
      completions += 1;
    });
    if (!isStreamResponse(wrapped)) {
      throw new Error("expected withStreamCompletion to preserve kind: stream");
    }

    expect(completions).toBe(0);
    await wrapped.open(createFakeSink());

    expect(openSettled).toBe(true);
    expect(completions).toBe(1);
  });

  test("calls onComplete when open() rejects, and the rejection propagates with the same identity", async () => {
    const boom = new Error("stream open failed");
    const stream = buildStreamResponse({
      open: () => Promise.reject(boom),
    });
    let completions = 0;

    const wrapped = withStreamCompletion(stream, () => {
      completions += 1;
    });
    if (!isStreamResponse(wrapped)) {
      throw new Error("expected withStreamCompletion to preserve kind: stream");
    }

    let thrown: unknown;
    try {
      await wrapped.open(createFakeSink());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    expect(completions).toBe(1);
  });

  test("preserves status, headers, and kind; only open is wrapped", () => {
    const stream = buildStreamResponse({
      status: 201,
      headers: { "x-foo": "bar" },
    });

    const wrapped = withStreamCompletion(stream, () => {});
    if (!isStreamResponse(wrapped)) {
      throw new Error("expected withStreamCompletion to preserve kind: stream");
    }

    expect(wrapped.kind).toBe("stream");
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers).toEqual({ "x-foo": "bar" });
    expect(wrapped.open).not.toBe(stream.open);
  });

  test("does not change how many times the underlying open is invoked, and releases exactly once", async () => {
    let openCalls = 0;
    const stream = buildStreamResponse({
      open: () => {
        openCalls += 1;
        return Promise.resolve();
      },
    });
    let completions = 0;

    const wrapped = withStreamCompletion(stream, () => {
      completions += 1;
    });
    if (!isStreamResponse(wrapped)) {
      throw new Error("expected withStreamCompletion to preserve kind: stream");
    }

    await wrapped.open(createFakeSink());

    expect(openCalls).toBe(1);
    expect(completions).toBe(1);
  });

  test("onComplete fires exactly once even when open() is invoked more than once", async () => {
    let openCalls = 0;
    const stream = buildStreamResponse({
      open: () => {
        openCalls += 1;
        return Promise.resolve();
      },
    });
    const onComplete = vi.fn();

    const wrapped = withStreamCompletion(stream, onComplete);
    if (!isStreamResponse(wrapped)) {
      throw new Error("expected withStreamCompletion to preserve kind: stream");
    }

    await wrapped.open(createFakeSink());
    await wrapped.open(createFakeSink());

    // The underlying open really was invoked twice — proving the guard
    // (not some other path skipping the second call) is what keeps
    // onComplete from firing twice.
    expect(openCalls).toBe(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
