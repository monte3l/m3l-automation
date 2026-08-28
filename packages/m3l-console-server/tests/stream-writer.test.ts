/**
 * Tests for src/http/stream-writer.ts — the transport that actually pumps
 * an `M3LConsoleStreamResponse`'s frames onto a real `node:http`
 * `ServerResponse` (X4, ADR-0066, slice 3). `src/http/stream-writer.ts` does
 * not exist yet; this suite is RED until implementation lands.
 *
 * Interpretation notes (an ambiguous brief, disambiguated with the hub —
 * these are now the settled contract, not a guess; a later reader should
 * not "fix" a test toward the alternative reading described below):
 *  - `M3LStreamWriteOutcome.frames`/`.dropped` count only frames the route
 *    itself pushed through `sink.emit()`; the initial `retry:` frame, any
 *    heartbeat comment, and the `stream.gap` frame are transport-internal
 *    and are not counted.
 *  - A heartbeat's comment text is not pinned — only that the write is shaped
 *    like an SSE comment frame (starts with `": "`, ends with `"\n\n"`), the same
 *    shape `encodeSseComment` produces, without importing that function.
 *  - Backpressure accounting: before writing a frame, if `pending >=
 *    maxPendingBytes` the frame is dropped without ever calling `res.write`;
 *    otherwise it is written and its own encoded byte length is added to
 *    `pending`. The check runs against the backlog left by *earlier* frames
 *    only — a frame's own size is never counted toward its own admission
 *    decision. `>=`, not `>`, is deliberate: it makes `maxPendingBytes` a
 *    real, reachable ceiling ("once the backlog reaches the cap, stop
 *    feeding the socket") rather than a value that is always overshot by at
 *    least one frame before anything drops.
 *  - `"drain"` resets `pending` to `0` — Node's own `drain` semantics mean
 *    the socket buffer has fully emptied, so a partial decrement would not
 *    be faithful. This is proven behaviourally (a frame emitted after drain
 *    is admitted again) rather than by reaching into the writer's internals.
 *  - The `stream.gap` frame's `data` is assumed to be
 *    `JSON.stringify({ lastEventId: <n> })`, naming the last id *successfully
 *    written*, never the last one the route merely attempted — those two
 *    values differ whenever a drop happens, and only the former is a safe
 *    re-sync pointer for a reconnecting client.
 *  - The `stream.gap` frame carries NO `id:` line of its own. Carrying one
 *    would move the client's `Last-Event-ID` cursor to a synthetic value
 *    that never corresponded to a real event, and `encodeSseFrame` throws
 *    on a non-positive-integer `id` besides, so a writer that tried to pass
 *    a sentinel would crash the stream rather than degrade.
 *  - When `open()` itself rejects (rather than a `res.write` throw), the
 *    outcome `reason` is assumed to be `"write-failed"` — the union only has
 *    three members and this is the closest fit.
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { encodeSseFrame, encodeSseRetry } from "../src/http/sse.js";
import type {
  M3LConsoleStreamResponse,
  M3LStreamSink,
} from "../src/http/stream-response.js";
import { writeStream } from "../src/http/stream-writer.js";
import type { WriteStreamOptions } from "../src/http/stream-writer.js";

/** One recorded call against a fake `ServerResponse`, in call order. */
interface RecordedCall {
  readonly kind: "writeHead" | "write" | "end" | "flushHeaders";
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: string;
}

/** A capturing `M3LLoggerHandler`: records every event it is handed. */
function createCapturingLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: Core.M3LLogEvent[];
} {
  const events: Core.M3LLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events };
}

/**
 * A `ServerResponse` double that is also an `EventEmitter` (so tests can
 * `emit("close")` / `emit("drain")`), and records `writeHead`/`write`/`end`/
 * `flushHeaders` into one shared, ordered array — the vehicle for every
 * ordering assertion in this file.
 */
function createFakeServerResponse(
  options: {
    writeReturns?: boolean;
    writeThrows?: Error;
    endThrows?: Error;
  } = {},
): {
  readonly res: ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  readonly calls: RecordedCall[];
  readonly setWriteReturn: (value: boolean) => void;
} {
  const calls: RecordedCall[] = [];
  let writeReturns = options.writeReturns ?? true;
  const res = new EventEmitter() as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  Object.assign(res, {
    headersSent: false,
    writableEnded: false,
    writeHead: (status: number, headers?: Readonly<Record<string, string>>) => {
      calls.push(
        headers === undefined
          ? { kind: "writeHead", status }
          : { kind: "writeHead", status, headers },
      );
      res.headersSent = true;
      return res;
    },
    flushHeaders: () => {
      calls.push({ kind: "flushHeaders" });
    },
    write: (chunk: string) => {
      if (options.writeThrows !== undefined) {
        throw options.writeThrows;
      }
      calls.push({ kind: "write", payload: chunk });
      return writeReturns;
    },
    end: () => {
      if (options.endThrows !== undefined) {
        throw options.endThrows;
      }
      calls.push({ kind: "end" });
      res.writableEnded = true;
      return res;
    },
  });
  return {
    res,
    calls,
    setWriteReturn: (value: boolean) => {
      writeReturns = value;
    },
  };
}

/** Every `write`-kind payload from `calls`, in call order. */
function writesOf(calls: readonly RecordedCall[]): string[] {
  return calls
    .filter((call) => call.kind === "write")
    .map((call) => call.payload ?? "");
}

/**
 * Route-emitted frame writes only — excludes transport-internal control
 * frames (`retry:` at open, `:` heartbeat comments, and the `stream.gap`
 * frame), which a backpressure assertion about *route* frames must not
 * count. `writesOf` deliberately stays unfiltered for the tests that assert
 * exact wire bytes.
 */
function routeFrameWritesOf(calls: readonly RecordedCall[]): string[] {
  return writesOf(calls).filter(
    (payload) =>
      !payload.startsWith("retry:") &&
      !payload.startsWith(":") &&
      !payload.includes("event: stream.gap"),
  );
}

/** A deferred promise, resolved/rejected from outside its own constructor. */
function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yields the microtask queue a few times so a pending `await` chain settles. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** A stream response fixture; `open` defaults to resolving immediately. */
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

/** Builds a full `WriteStreamOptions`, with sane defaults for every field. */
function buildOptions(
  res: ServerResponse,
  response: M3LConsoleStreamResponse,
  overrides: Partial<Omit<WriteStreamOptions, "res" | "response">> = {},
): WriteStreamOptions {
  const { logger } = createCapturingLogger();
  return {
    res,
    response,
    correlationId: "corr-1",
    logger,
    heartbeatMs: 30_000,
    maxPendingBytes: 1_000_000,
    retryMs: 2_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("writeStream — response head", () => {
  test("writes status 200 with the SSE-critical headers, including x-correlation-id from correlationId", async () => {
    const { res, calls } = createFakeServerResponse();
    const options = buildOptions(res, buildStreamResponse(), {
      correlationId: "corr-xyz",
    });

    await writeStream(options);

    const head = calls.find((call) => call.kind === "writeHead");
    expect(head?.status).toBe(200);
    expect(head?.headers).toMatchObject({
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
      "x-correlation-id": "corr-xyz",
    });
  });

  test("never sets a content-length header", async () => {
    const { res, calls } = createFakeServerResponse();
    const options = buildOptions(res, buildStreamResponse());

    await writeStream(options);

    const head = calls.find((call) => call.kind === "writeHead");
    const headerKeys = Object.keys(head?.headers ?? {}).map((key) =>
      key.toLowerCase(),
    );
    expect(headerKeys).not.toContain("content-length");
  });

  test("calls res.flushHeaders() so the client sees the head before the first frame", async () => {
    const { res, calls } = createFakeServerResponse();
    const options = buildOptions(res, buildStreamResponse());

    await writeStream(options);

    const headIndex = calls.findIndex((call) => call.kind === "writeHead");
    const flushIndex = calls.findIndex((call) => call.kind === "flushHeaders");
    expect(flushIndex).toBeGreaterThan(-1);
    expect(flushIndex).toBeGreaterThan(headIndex);
  });

  test("stream-critical headers win over a same-named entry from response.headers", async () => {
    const { res, calls } = createFakeServerResponse();
    const response = buildStreamResponse({
      headers: {
        "content-length": "999",
        "content-type": "application/json",
      },
    });
    const options = buildOptions(res, response);

    await writeStream(options);

    const head = calls.find((call) => call.kind === "writeHead");
    expect(head?.headers?.["content-type"]).toBe("text/event-stream");
    const headerKeys = Object.keys(head?.headers ?? {}).map((key) =>
      key.toLowerCase(),
    );
    expect(headerKeys).not.toContain("content-length");
  });

  test("writes the route's own status code rather than always 200 (PR #718 review, defect 3)", async () => {
    const { res, calls } = createFakeServerResponse();
    const options = buildOptions(res, buildStreamResponse({ status: 201 }));

    await writeStream(options);

    const head = calls.find((call) => call.kind === "writeHead");
    expect(head?.status).toBe(201);
  });

  test("emits one retry: frame at open, from options.retryMs", async () => {
    const { res, calls } = createFakeServerResponse();
    const options = buildOptions(res, buildStreamResponse(), {
      retryMs: 4_321,
    });

    await writeStream(options);

    const writes = writesOf(calls);
    expect(writes).toContain(encodeSseRetry(4_321));
  });

  test("emits the retry: frame at open, before any route frame, so a client that disconnects abruptly already has its backoff", async () => {
    // `retry:` sets the client's reconnect backoff — an EventSource can
    // only use a value it has already received. If it were written any
    // later than open (e.g. deferred until just before res.end()), an
    // abrupt disconnect (network drop, SIGKILL) would mean the client
    // never receives it at all, defeating the field's whole purpose.
    const { res, calls } = createFakeServerResponse();
    const frame = { id: 1, event: "run.output", data: "hello" };
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit(frame);
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response, { retryMs: 4_321 });

    await writeStream(options);

    const retryIndex = calls.findIndex(
      (call) => call.kind === "write" && call.payload === encodeSseRetry(4_321),
    );
    const frameIndex = calls.findIndex(
      (call) => call.kind === "write" && call.payload === encodeSseFrame(frame),
    );
    expect(retryIndex).toBeGreaterThan(-1);
    expect(frameIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeLessThan(frameIndex);
  });
});

describe("writeStream — an invalid retryMs reaching it directly (PR #718 review, defect 1)", () => {
  // `encodeSseRetry` legitimately throws for a bad retryMs (sse.ts's own
  // documented contract for an internal control value) — but writeStream's
  // own contract is "never throws and never rejects". Today the call sits
  // outside any try, so the throw propagates straight out of writeStream
  // as a rejection, after writeStreamHead has already written the head —
  // meaning a caller can no longer send a fallback error response either.
  test.each([
    ["a negative retryMs", -1],
    ["a non-integer retryMs", 1.5],
  ])(
    "does not throw or reject for %s — the stream still completes instead of crashing",
    async (_label, retryMs) => {
      const { res } = createFakeServerResponse();
      const options = buildOptions(res, buildStreamResponse(), { retryMs });

      const outcome = await writeStream(options);

      expect(outcome.reason).toBe("completed");
    },
  );
});

describe("writeStream — frame pumping", () => {
  test("every sink.emit(frame) reaches res.write encoded exactly as sse.ts would encode it", async () => {
    const { res, calls } = createFakeServerResponse();
    const frame = { id: 1, event: "run.output", data: "hello world" };
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit(frame);
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response);

    await writeStream(options);

    expect(writesOf(calls)).toContain(encodeSseFrame(frame));
  });

  test("frames in the outcome counts the frames the route successfully wrote", async () => {
    const { res } = createFakeServerResponse();
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit({ id: 1, event: "run.output", data: "a" });
        sink.emit({ id: 2, event: "run.output", data: "b" });
        sink.emit({ id: 3, event: "run.output", data: "c" });
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response);

    const outcome = await writeStream(options);

    expect(outcome.frames).toBe(3);
    expect(outcome.dropped).toBe(0);
    expect(outcome.reason).toBe("completed");
  });

  test("calls res.end() once open() resolves, and not before", async () => {
    const { res, calls } = createFakeServerResponse();
    const deferred = createDeferred<void>();
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit({ id: 1, event: "run.output", data: "frame-1" });
        await deferred.promise;
      },
    });
    const options = buildOptions(res, response);

    const outcomePromise = writeStream(options);
    await flushMicrotasks();

    expect(calls.some((call) => call.kind === "end")).toBe(false);
    expect(calls.some((call) => call.kind === "write")).toBe(true);

    deferred.resolve();
    await outcomePromise;

    expect(calls.some((call) => call.kind === "end")).toBe(true);
  });

  test("frames arrive on the wire before the response ends, in that order", async () => {
    const { res, calls } = createFakeServerResponse();
    const frame = { id: 1, event: "run.output", data: "frame-1" };
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit(frame);
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response);

    await writeStream(options);

    const writeIndex = calls.findIndex(
      (call) => call.kind === "write" && call.payload === encodeSseFrame(frame),
    );
    const endIndex = calls.findIndex((call) => call.kind === "end");
    expect(writeIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(writeIndex);
  });
});

describe("writeStream — sink.emit never throws, even for an invalid frame (PR #718 review, defect 4)", () => {
  // `encodeSseFrame` legitimately throws for a non-positive-integer `id` or a
  // newline-bearing `event` — sse.ts's own documented contract for those
  // internal control values. But `M3LStreamSink.emit`'s own documented
  // contract is "Never throws". Today the encode call sits outside
  // `attemptWrite`'s try, so the throw propagates straight out of
  // `sink.emit`, aborting the route's `open()` mid-stream. One bad frame
  // must not abort the whole stream: a later, valid frame from the same
  // route must still reach the wire.
  test.each([
    ["a non-positive id", { id: -1, event: "run.output", data: "bad" }],
    ["a non-integer id", { id: 1.5, event: "run.output", data: "bad" }],
  ])(
    "does not throw for a frame with %s, and a later valid frame from the same route is still written",
    async (_label, badFrame) => {
      const { res, calls } = createFakeServerResponse();
      const goodFrame = { id: 1, event: "run.output", data: "good" };
      // Captured locally rather than wrapped in `expect(...).not.toThrow()`
      // inside `open`: a throw from `sink.emit` there would reject `open()`
      // itself, which writeStream's own try/catch silently absorbs as a
      // generic "open failed" outcome — masking the real assertion failure
      // behind an unrelated one. Catching it here instead lets the "never
      // throws" contract be asserted directly, decoupled from whether a
      // later frame also happens to flow.
      let emitThrew = false;
      const response = buildStreamResponse({
        open: async (sink) => {
          try {
            sink.emit(badFrame);
          } catch {
            emitThrew = true;
          }
          sink.emit(goodFrame);
          await Promise.resolve();
        },
      });
      const options = buildOptions(res, response);

      await writeStream(options);

      expect(emitThrew).toBe(false);
      const writes = routeFrameWritesOf(calls);
      expect(writes).toContain(encodeSseFrame(goodFrame));
      expect(writes.some((payload) => payload.includes("bad"))).toBe(false);
    },
  );

  test("does not throw for an event name containing a newline, and a later valid frame from the same route is still written", async () => {
    const { res, calls } = createFakeServerResponse();
    const badFrame = { event: "run.output\ninjected", data: "bad" };
    const goodFrame = { id: 1, event: "run.output", data: "good" };
    let emitThrew = false;
    const response = buildStreamResponse({
      open: async (sink) => {
        try {
          sink.emit(badFrame);
        } catch {
          emitThrew = true;
        }
        sink.emit(goodFrame);
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response);

    await writeStream(options);

    expect(emitThrew).toBe(false);
    const writes = routeFrameWritesOf(calls);
    expect(writes).toContain(encodeSseFrame(goodFrame));
    expect(writes.some((payload) => payload.includes("injected"))).toBe(false);
  });
});

describe("writeStream — heartbeat", () => {
  test("emits a heartbeat comment frame once heartbeatMs elapses while open() is still pending", async () => {
    vi.useFakeTimers();
    const { res, calls } = createFakeServerResponse();
    const deferred = createDeferred<void>();
    const response = buildStreamResponse({
      open: async () => {
        await deferred.promise;
      },
    });
    const options = buildOptions(res, response, { heartbeatMs: 10_000 });

    const outcomePromise = writeStream(options);
    await vi.advanceTimersByTimeAsync(10_000);

    const comments = writesOf(calls).filter((payload) =>
      /^: .*\n\n$/u.test(payload),
    );
    expect(comments).toHaveLength(1);

    deferred.resolve();
    await outcomePromise;
  });

  test("emits a second heartbeat comment frame after a second interval elapses", async () => {
    vi.useFakeTimers();
    const { res, calls } = createFakeServerResponse();
    const deferred = createDeferred<void>();
    const response = buildStreamResponse({
      open: async () => {
        await deferred.promise;
      },
    });
    const options = buildOptions(res, response, { heartbeatMs: 10_000 });

    const outcomePromise = writeStream(options);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    const comments = writesOf(calls).filter((payload) =>
      /^: .*\n\n$/u.test(payload),
    );
    expect(comments).toHaveLength(2);

    deferred.resolve();
    await outcomePromise;
  });

  test("stops emitting heartbeats once open() has settled", async () => {
    vi.useFakeTimers();
    const { res, calls } = createFakeServerResponse();
    const response = buildStreamResponse({ open: async () => {} });
    const options = buildOptions(res, response, { heartbeatMs: 10_000 });

    await writeStream(options);
    const commentsAfterCompletion = writesOf(calls).filter((payload) =>
      /^: .*\n\n$/u.test(payload),
    ).length;

    await vi.advanceTimersByTimeAsync(50_000);

    const commentsAfterAdvance = writesOf(calls).filter((payload) =>
      /^: .*\n\n$/u.test(payload),
    ).length;
    expect(commentsAfterAdvance).toBe(commentsAfterCompletion);
  });

  test("the heartbeat timer is unref()'d so it cannot hold the process open", async () => {
    vi.useFakeTimers();
    const originalSetInterval = globalThis.setInterval;
    const unrefMock = vi.fn();
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      (
        handler: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) => {
        const timer = originalSetInterval(handler, ms, ...args) as unknown as {
          unref: () => unknown;
        };
        const originalUnref = timer.unref.bind(timer);
        timer.unref = (...unrefArgs: unknown[]) => {
          unrefMock(...unrefArgs);
          return originalUnref();
        };
        return timer as unknown as ReturnType<typeof setInterval>;
      },
    );

    const { res } = createFakeServerResponse();
    const deferred = createDeferred<void>();
    const response = buildStreamResponse({
      open: async () => {
        await deferred.promise;
      },
    });
    const options = buildOptions(res, response, { heartbeatMs: 10_000 });

    const outcomePromise = writeStream(options);
    await flushMicrotasks();

    expect(unrefMock).toHaveBeenCalled();

    deferred.resolve();
    await outcomePromise;
  });
});

describe("writeStream — client disconnect", () => {
  test("res.emit('close') while open() is pending flips sink.closed to true", async () => {
    const { res } = createFakeServerResponse();
    let capturedSink: M3LStreamSink | undefined;
    const deferred = createDeferred<void>();
    const response = buildStreamResponse({
      open: async (sink) => {
        capturedSink = sink;
        await deferred.promise;
      },
    });
    const options = buildOptions(res, response);

    const outcomePromise = writeStream(options);
    await flushMicrotasks();

    expect(capturedSink?.closed).toBe(false);
    res.emit("close");
    await flushMicrotasks();
    expect(capturedSink?.closed).toBe(true);

    deferred.resolve();
    await outcomePromise;
  });

  test("resolves with reason client-disconnected when the client goes away before open() resolves", async () => {
    const { res } = createFakeServerResponse();
    const response = buildStreamResponse({
      open: () => new Promise<void>(() => {}),
    });
    const options = buildOptions(res, response);

    const outcomePromise = writeStream(options);
    await flushMicrotasks();
    res.emit("close");

    await expect(outcomePromise).resolves.toMatchObject({
      reason: "client-disconnected",
    });
  });

  test("does not write to the dead socket after close, even if the route keeps emitting", async () => {
    const { res, calls } = createFakeServerResponse();
    let capturedSink: M3LStreamSink | undefined;
    const deferred = createDeferred<void>();
    const response = buildStreamResponse({
      open: async (sink) => {
        capturedSink = sink;
        await deferred.promise;
      },
    });
    const options = buildOptions(res, response);

    const outcomePromise = writeStream(options);
    await flushMicrotasks();
    res.emit("close");
    await flushMicrotasks();

    const writesBeforeLateEmit = writesOf(calls).length;
    capturedSink?.emit({ id: 99, event: "run.output", data: "too-late" });
    expect(writesOf(calls).length).toBe(writesBeforeLateEmit);

    deferred.resolve();
    await outcomePromise;
  });
});

describe("writeStream — write failure is logged, never thrown", () => {
  test("a throwing res.write does not propagate out of sink.emit, and resolves with reason write-failed", async () => {
    const { res } = createFakeServerResponse({
      writeThrows: new Error("socket exploded"),
    });
    const response = buildStreamResponse({
      open: async (sink) => {
        expect(() => {
          sink.emit({ id: 1, event: "run.output", data: "boom" });
        }).not.toThrow();
        await Promise.resolve();
      },
    });
    const { logger, events } = createCapturingLogger();
    const options = buildOptions(res, response, { logger });

    const outcome = await writeStream(options);

    expect(outcome.reason).toBe("write-failed");
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.some((event) => event.category === Core.M3LLogEventCategory.ERROR),
    ).toBe(true);
  });

  test("open() rejecting resolves writeStream (never rejects), logs the rejection, and still ends the response", async () => {
    const { res, calls } = createFakeServerResponse();
    const response = buildStreamResponse({
      open: async () => {
        await Promise.resolve();
        throw new Error("route blew up");
      },
    });
    const { logger, events } = createCapturingLogger();
    const options = buildOptions(res, response, { logger });

    await expect(writeStream(options)).resolves.toBeDefined();

    expect(events.length).toBeGreaterThan(0);
    expect(
      events.some((event) => event.category === Core.M3LLogEventCategory.ERROR),
    ).toBe(true);
    expect(calls.some((call) => call.kind === "end")).toBe(true);
  });

  test("open() rejecting only AFTER the client has already disconnected still reaches options.logger (PR #718 review, defect 2)", async () => {
    // `Promise.race([open(sink), closeSignal.promise])` settles on
    // `closeSignal` the moment the client disconnects, and writeStream
    // returns — but the route's own `open()` promise is still pending at
    // that point. If it later rejects, that rejection is absorbed by the
    // already-settled race and today is never logged or surfaced anywhere.
    const { res } = createFakeServerResponse();
    const deferred = createDeferred<void>();
    const response = buildStreamResponse({
      open: () => deferred.promise,
    });
    const { logger, events } = createCapturingLogger();
    const options = buildOptions(res, response, { logger });

    const outcomePromise = writeStream(options);
    await flushMicrotasks();

    res.emit("close");
    const outcome = await outcomePromise;

    // Sanity: the race genuinely settled on the close signal, with open()
    // still pending — otherwise the later rejection below would land inside
    // the try/catch that already logs an open() failure, proving nothing
    // about the absorbed-rejection path this test targets.
    expect(outcome.reason).toBe("client-disconnected");
    expect(events).toHaveLength(0);

    deferred.reject(new Error("route blew up after the client disconnected"));
    await flushMicrotasks();

    expect(
      events.some((event) => event.category === Core.M3LLogEventCategory.ERROR),
    ).toBe(true);
  });

  test("a failing res.end() is logged and does not shadow the computed outcome", async () => {
    const { res } = createFakeServerResponse({
      endThrows: new Error("end() exploded"),
    });
    const frame = { id: 1, event: "run.output", data: "hello" };
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit(frame);
        await Promise.resolve();
      },
    });
    const { logger, events } = createCapturingLogger();
    const options = buildOptions(res, response, { logger });

    const outcome = await writeStream(options);

    // The "does not shadow" half: the outcome reflects the stream's actual
    // progress computed before end() was ever called — not "write-failed"
    // just because a later, unrelated end() call blew up.
    expect(outcome.reason).toBe("completed");
    expect(outcome.frames).toBe(1);
    expect(outcome.dropped).toBe(0);

    // The "does not swallow" half: a best-effort catch is only acceptable
    // because it logs — a version of the code with the errorFrom call
    // deleted would still pass every assertion above.
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.some((event) => event.category === Core.M3LLogEventCategory.ERROR),
    ).toBe(true);
  });
});

describe("writeStream — backpressure and gap-on-drop (ADR-0066)", () => {
  const frame1 = { id: 1, event: "run.output", data: "x".repeat(64) };
  const frameBytes = Buffer.byteLength(encodeSseFrame(frame1), "utf8");

  test("a false return from res.write keeps accounting pending bytes without immediately dropping", async () => {
    const { res, setWriteReturn } = createFakeServerResponse();
    setWriteReturn(false);
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit({ id: 1, event: "run.output", data: "x".repeat(64) });
        sink.emit({ id: 2, event: "run.output", data: "y".repeat(64) });
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response, {
      maxPendingBytes: frameBytes * 10,
    });

    const outcome = await writeStream(options);

    expect(outcome.frames).toBe(2);
    expect(outcome.dropped).toBe(0);
  });

  test("drops frames once pending exceeds maxPendingBytes, without unbounded res.write growth", async () => {
    const { res, calls, setWriteReturn } = createFakeServerResponse();
    setWriteReturn(false);
    const response = buildStreamResponse({
      open: async (sink) => {
        // frame1 always fits (pending starts at 0); maxPendingBytes is set
        // one byte short of a single frame, so once frame1's bytes are
        // accounted for, pending already exceeds the ceiling regardless of
        // whether the implementation checks before or after adding the
        // current frame's own size — every subsequent frame is unambiguously
        // over budget.
        sink.emit({ id: 1, event: "run.output", data: "x".repeat(64) });
        sink.emit({ id: 2, event: "run.output", data: "y".repeat(64) });
        await Promise.resolve();
        sink.emit({ id: 3, event: "run.output", data: "z".repeat(64) });
      },
    });
    const options = buildOptions(res, response, {
      maxPendingBytes: frameBytes - 1,
    });

    const outcome = await writeStream(options);

    expect(outcome.frames).toBe(1);
    expect(outcome.dropped).toBe(2);
    expect(routeFrameWritesOf(calls)).toHaveLength(1);
  });

  test("drops the next frame once pending reaches maxPendingBytes exactly (>= not >)", async () => {
    const { res, calls, setWriteReturn } = createFakeServerResponse();
    setWriteReturn(false);
    const response = buildStreamResponse({
      open: async (sink) => {
        // maxPendingBytes is set to exactly one frame's encoded byte length.
        // After frame1 is written, pending === maxPendingBytes — not yet
        // over it. The settled semantics drop on `>=`, so frame2 is dropped
        // even though pending never strictly exceeded the ceiling.
        sink.emit({ id: 1, event: "run.output", data: "x".repeat(64) });
        await Promise.resolve();
        sink.emit({ id: 2, event: "run.output", data: "y".repeat(64) });
      },
    });
    const options = buildOptions(res, response, {
      maxPendingBytes: frameBytes,
    });

    const outcome = await writeStream(options);

    expect(outcome.frames).toBe(1);
    expect(outcome.dropped).toBe(1);
    expect(routeFrameWritesOf(calls)).toHaveLength(1);
  });

  test("the gap frame names the last id successfully written, not the last attempted", async () => {
    const { res, calls, setWriteReturn } = createFakeServerResponse();
    setWriteReturn(false);
    const response = buildStreamResponse({
      open: async (sink) => {
        // Last successfully written id is 1 (frame1); last attempted id is
        // 3 (frame3, dropped). The two values differ in this fixture on
        // purpose — that is what makes the `lastEventId` assertion below
        // actually discriminate "last written" from "last attempted"
        // rather than passing under either reading.
        sink.emit({ id: 1, event: "run.output", data: "x".repeat(64) });
        sink.emit({ id: 2, event: "run.output", data: "y".repeat(64) });
        sink.emit({ id: 3, event: "run.output", data: "z".repeat(64) });
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response, {
      maxPendingBytes: frameBytes - 1,
    });

    await writeStream(options);
    const writeCountBeforeDrain = writesOf(calls).length;

    res.emit("drain");

    const newWrites = writesOf(calls).slice(writeCountBeforeDrain);
    expect(newWrites).toHaveLength(1);
    const gapWrite = newWrites[0] ?? "";
    expect(gapWrite).toContain("event: stream.gap");
    expect(gapWrite).not.toMatch(/^id: /mu);
    const dataLine = gapWrite
      .split("\n")
      .find((line) => line.startsWith("data: "));
    const payload = JSON.parse((dataLine ?? "").slice("data: ".length)) as {
      lastEventId?: number;
    };
    expect(payload.lastEventId).toBe(1);
  });

  test("an id-less frame does not clobber the last-written id the gap frame reports", async () => {
    // An id-less route frame is not a hypothetical: the writer itself emits
    // one by design (the `stream.gap` frame carries no `id:` line — see the
    // header note above), and a route is free to emit its own advisory
    // frames the same way. Recording it must not overwrite the pointer the
    // next gap frame relies on to tell a reconnecting client where to
    // resume from.
    const { res, calls, setWriteReturn } = createFakeServerResponse();
    setWriteReturn(false);
    const frameWithId = { id: 1, event: "run.output", data: "x".repeat(64) };
    const frameNoId = { event: "run.output", data: "y".repeat(64) };
    const frameBytesNoId = Buffer.byteLength(encodeSseFrame(frameNoId), "utf8");
    const frameDropped = { id: 3, event: "run.output", data: "z".repeat(64) };
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit(frameWithId);
        sink.emit(frameNoId);
        sink.emit(frameDropped);
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response, {
      // Admits frameWithId and frameNoId (their combined backlog is still
      // one byte short of the ceiling when frameDropped is considered), but
      // not frameDropped — deterministic regardless of any off-by-one in
      // how "combined" is read, since the margin is exactly one byte.
      maxPendingBytes: frameBytes + frameBytesNoId - 1,
    });

    const outcome = await writeStream(options);
    expect(outcome.frames).toBe(2);
    expect(outcome.dropped).toBe(1);
    const writeCountBeforeDrain = writesOf(calls).length;

    res.emit("drain");

    const newWrites = writesOf(calls).slice(writeCountBeforeDrain);
    expect(newWrites).toHaveLength(1);
    const dataLine = (newWrites[0] ?? "")
      .split("\n")
      .find((line) => line.startsWith("data: "));
    const payload = JSON.parse((dataLine ?? "").slice("data: ".length)) as {
      lastEventId?: number;
    };
    // The id-less frame must not have reset the pointer to `undefined` —
    // it must still name `1`, the last frame that actually carried an id.
    expect(payload.lastEventId).toBe(1);
  });

  test("resets pending on drain, admitting a later frame again without duplicating the dropped one", async () => {
    const { res, calls, setWriteReturn } = createFakeServerResponse();
    setWriteReturn(false);
    const deferred = createDeferred<void>();
    const frame1 = { id: 1, event: "run.output", data: "x".repeat(64) };
    const frame2 = { id: 2, event: "run.output", data: "y".repeat(64) };
    const frame3 = { id: 3, event: "run.output", data: "z".repeat(64) };
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit(frame1);
        sink.emit(frame2);
        await deferred.promise;
        sink.emit(frame3);
      },
    });
    const options = buildOptions(res, response, {
      maxPendingBytes: frameBytes - 1,
    });

    const outcomePromise = writeStream(options);
    await flushMicrotasks();

    // frame1 fit (pending -> frameBytes), frame2 was dropped (pending was
    // already >= max). If drain did not reset `pending`, frame3 would be
    // dropped too, since `pending` would still sit above the ceiling.
    res.emit("drain");
    deferred.resolve();
    const outcome = await outcomePromise;

    expect(outcome.frames).toBe(2);
    expect(outcome.dropped).toBe(1);
    const writes = writesOf(calls);
    expect(writes).toContain(encodeSseFrame(frame3));
    expect(writes).not.toContain(encodeSseFrame(frame2));
  });

  test("emits no stream.gap frame when nothing was ever dropped", async () => {
    const { res, calls } = createFakeServerResponse();
    const response = buildStreamResponse({
      open: async (sink) => {
        sink.emit({ id: 1, event: "run.output", data: "hello" });
        await Promise.resolve();
      },
    });
    const options = buildOptions(res, response);

    await writeStream(options);
    res.emit("drain");

    expect(
      writesOf(calls).some((payload) => payload.includes("stream.gap")),
    ).toBe(false);
  });
});
