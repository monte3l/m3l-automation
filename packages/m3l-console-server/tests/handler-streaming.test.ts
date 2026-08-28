/**
 * Tests for src/http/handler.ts's STREAMING branch (X4, ADR-0066) — split
 * out from `tests/handler.test.ts` purely for file-size budget reasons (see
 * that file's own header). `handler.ts` today never invokes a stream
 * response's `open()` at all: `finishRequest` unconditionally calls
 * `writeResponseGuarded`/`writeResponse`, which crashes on
 * `Buffer.byteLength(response.body, "utf8")` for a stream-shaped result
 * (no `body` field) and falls back to a bare 500. This suite is RED until
 * the streaming branch is wired in, alongside two measured leaks it must
 * fix at the same time:
 *
 *  - Bug 1: the request-level `close` disconnect detector (`req.once("close", ...)`
 *    in `beginRequest`/`runRequest`) is removed in a `finally` that runs the
 *    moment the route handler *returns* — for a stream, that is at *open*,
 *    so a mid-stream disconnect goes undetected.
 *  - Bug 2: `finishRequest` aborts `connectionController` (releasing the
 *    composite `ctx.signal`) immediately after the write — for a stream,
 *    that is again at *open*, aborting the very signal the stream's `open()`
 *    depends on while it is still running.
 *
 * Several tests below assert `res.writableEnded === false` as a sanity
 * precondition before checking a bug-specific behavior — that assertion is
 * itself expected to fail on the current pipeline, since without the
 * streaming branch a "stream" request is never actually left open: it is
 * already fully finished (crashed-and-fallen-back) by the time any test
 * checkpoint runs.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createConsoleRequestListener } from "../src/http/handler.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { jsonResponse } from "../src/http/respond.js";
import { createRouter } from "../src/http/router.js";
import type { M3LRoute } from "../src/http/router.js";
import type {
  M3LConsoleResult,
  M3LStreamSink,
} from "../src/http/stream-response.js";

/** A capturing `M3LLoggerHandler` whose `logged` promise resolves on the first event. */
function createResolvingLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: Core.M3LLogEvent[];
  readonly logged: Promise<void>;
} {
  const events: Core.M3LLogEvent[] = [];
  let resolveLogged: () => void = () => undefined;
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve;
  });
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
      resolveLogged();
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events, logged };
}

/** A deferred promise, resolved/rejected from outside its own constructor. */
function createDeferred<Value = void>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Yields the microtask queue a few times so a pending `await` chain settles. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

/** One recorded call against a {@link createStreamCapableServerResponse} double, in call order. */
interface RecordedCall {
  readonly kind: "writeHead" | "write" | "end" | "flushHeaders";
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly payload?: string | undefined;
}

/**
 * Builds a `ServerResponse` double that is also a real `EventEmitter` (so a
 * test can `emit("close")`/`emit("drain")` on it) and records
 * `writeHead`/`write`/`end`/`flushHeaders` into one shared, ordered array —
 * the vehicle for the ordering assertion in this file. Exercises the REAL
 * `writeStream`/`sse.ts` (never mocked): this double is deliberately shaped
 * to satisfy both `respond.ts`'s `writeResponse` and `stream-writer.ts`'s
 * `writeStream`, since which one handles a given request is exactly what is
 * under test.
 */
function createStreamCapableServerResponse(): {
  readonly res: ServerResponse;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const res = new EventEmitter() as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  Object.assign(res, {
    writableEnded: false,
    headersSent: false,
    writeHead: (status: number, headers?: Readonly<Record<string, string>>) => {
      calls.push({ kind: "writeHead", status, headers });
      res.headersSent = true;
      return res;
    },
    flushHeaders: () => {
      calls.push({ kind: "flushHeaders" });
    },
    write: (chunk: string) => {
      calls.push({ kind: "write", payload: chunk });
      return true;
    },
    end: (body?: string) => {
      calls.push({ kind: "end", payload: body });
      res.writableEnded = true;
      return res;
    },
  });
  return { res, calls };
}

/** One `add`/`remove` call recorded against a {@link createTrackingIncomingMessage} double's listeners. */
interface ListenerLogEntry {
  readonly action: "add" | "remove";
  readonly event: string;
}

/**
 * Builds an `IncomingMessage` double that records every `once`/`removeListener`
 * call into `listenerLog`, so a test can assert exactly when the request-level
 * `close` listener is attached/detached relative to the rest of the pipeline —
 * "removed after the stream ends" must assert this timing directly, not a proxy.
 */
function createTrackingIncomingMessage(
  overrides: Partial<Pick<IncomingMessage, "method" | "url">> = {},
): {
  readonly req: IncomingMessage;
  readonly listenerLog: ListenerLogEntry[];
  readonly triggerClose: () => void;
} {
  const emitter = new EventEmitter();
  const listenerLog: ListenerLogEntry[] = [];
  Object.assign(emitter, {
    method: overrides.method ?? "GET",
    url: overrides.url ?? "/api/v1/stream",
    headers: {},
    rawHeaders: [],
    once: (event: string, listener: (...args: readonly unknown[]) => void) => {
      listenerLog.push({ action: "add", event });
      EventEmitter.prototype.once.call(emitter, event, listener);
      return emitter;
    },
    removeListener: (
      event: string,
      listener: (...args: readonly unknown[]) => void,
    ) => {
      listenerLog.push({ action: "remove", event });
      EventEmitter.prototype.removeListener.call(emitter, event, listener);
      return emitter;
    },
  });
  return {
    req: emitter as unknown as IncomingMessage,
    listenerLog,
    triggerClose: () => {
      emitter.emit("close");
    },
  };
}

/**
 * Builds a minimal `M3LRoute` whose handler returns an
 * `M3LConsoleStreamResponse`. `M3LRoute["handler"]` is not yet widened to
 * accept a stream result (that widening is part of the fix under test), so
 * this is expected to fail `tsc` in RED — the diagnostic IS the missing
 * feature, not a defect in this helper.
 */
function streamRoute(config: {
  readonly path?: string;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly onCtx?: (ctx: M3LRequestContext) => void;
  readonly open: (sink: M3LStreamSink) => Promise<void>;
}): M3LRoute {
  const handler = (ctx: M3LRequestContext): M3LConsoleResult => {
    config.onCtx?.(ctx);
    return {
      kind: "stream",
      status: config.status ?? 200,
      headers: config.headers ?? { "content-type": "text/event-stream" },
      open: config.open,
    };
  };
  return {
    method: "GET",
    path: config.path ?? "/api/v1/stream",
    auth: "required",
    handler,
  };
}

/** Finds every logged outcome line (`<method> <path> -> <status>`). */
function outcomeEventsOf(
  events: readonly Core.M3LLogEvent[],
): readonly Core.M3LLogEvent[] {
  return events.filter((event) => event.message.includes(" -> "));
}

describe("createConsoleRequestListener — invalid stream options are rejected at construction (PR #718 review, defect 1)", () => {
  // `retryMs`/`heartbeatMs`/`maxPendingBytes` arrive unvalidated from this
  // public options bag and flow, unvalidated, all the way down to
  // `writeStream` (via `stream-dispatch.ts`) — where an invalid `retryMs` in
  // particular throws `ERR_CONSOLE_INTERNAL` out of a module documented as
  // "never throws and never rejects", and only after the stream head has
  // already been written, so no fallback error response can be sent. The
  // fix validates at this boundary instead: reject a bad value synchronously
  // at construction, before any request is ever accepted.
  test.each([
    ["a negative retryMs", { retryMs: -1 }],
    ["a non-integer retryMs", { retryMs: 1.5 }],
    ["a negative heartbeatMs", { heartbeatMs: -1 }],
    ["a negative maxPendingBytes", { maxPendingBytes: -1 }],
  ])(
    "throws M3LConsoleError(ERR_CONSOLE_CONFIG_INVALID) for %s, before any request is accepted",
    (_label, overrides) => {
      const { logger } = createResolvingLogger();
      const router = createRouter([]);

      let thrown: unknown;
      try {
        createConsoleRequestListener({
          router,
          middlewares: [],
          preRouting: [],
          logger,
          signal: new AbortController().signal,
          ...overrides,
        });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_CONFIG_INVALID",
      );
    },
  );
});

describe("createConsoleRequestListener — Bug 1: disconnect detector survives past stream open", () => {
  test("a mid-stream client disconnect still aborts ctx.signal", async () => {
    const { logger, logged } = createResolvingLogger();
    const { req, triggerClose } = createTrackingIncomingMessage();
    const { res } = createStreamCapableServerResponse();
    const deferred = createDeferred<void>();
    let capturedSignal: AbortSignal | undefined;
    const router = createRouter([
      streamRoute({
        onCtx: (ctx) => {
          capturedSignal = ctx.signal;
        },
        open: async (sink) => {
          sink.emit({ event: "run.output", data: "1" });
          await deferred.promise;
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await flushMicrotasks();

    // Sanity: still genuinely mid-stream — otherwise the assertion below
    // would pass for the wrong reason (a finished request trivially has an
    // aborted signal already).
    expect(res.writableEnded).toBe(false);

    triggerClose();
    expect(capturedSignal?.aborted).toBe(true);

    deferred.resolve();
    await logged;
  });

  test("the close listener is removed only after the stream ends, not when the handler returns", async () => {
    const { logger, logged } = createResolvingLogger();
    const { req, listenerLog } = createTrackingIncomingMessage();
    const { res } = createStreamCapableServerResponse();
    const deferred = createDeferred<void>();
    const router = createRouter([
      streamRoute({
        open: async (sink) => {
          sink.emit({ event: "run.output", data: "1" });
          await deferred.promise;
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await flushMicrotasks();

    expect(res.writableEnded).toBe(false);
    expect(
      listenerLog.some(
        (entry) => entry.action === "remove" && entry.event === "close",
      ),
    ).toBe(false);

    deferred.resolve();
    await logged;
    await flushMicrotasks();

    expect(
      listenerLog.some(
        (entry) => entry.action === "remove" && entry.event === "close",
      ),
    ).toBe(true);
  });
});

describe("createConsoleRequestListener — Bug 2: ctx.signal outlives stream open", () => {
  test("ctx.signal is not aborted while the stream is still open", async () => {
    const { logger, logged } = createResolvingLogger();
    const { req } = createTrackingIncomingMessage();
    const { res, calls } = createStreamCapableServerResponse();
    const deferred = createDeferred<void>();
    let capturedSignal: AbortSignal | undefined;
    const router = createRouter([
      streamRoute({
        onCtx: (ctx) => {
          capturedSignal = ctx.signal;
        },
        open: async (sink) => {
          sink.emit({ event: "run.output", data: "1" });
          await deferred.promise;
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await flushMicrotasks();

    expect(res.writableEnded).toBe(false);
    expect(calls.some((call) => call.kind === "write")).toBe(true);
    expect(capturedSignal?.aborted).toBe(false);

    deferred.resolve();
    await logged;
  });

  test("ctx.signal is aborted once the stream completes", async () => {
    const { logger, logged } = createResolvingLogger();
    const { req } = createTrackingIncomingMessage();
    const { res } = createStreamCapableServerResponse();
    const deferred = createDeferred<void>();
    let capturedSignal: AbortSignal | undefined;
    const router = createRouter([
      streamRoute({
        onCtx: (ctx) => {
          capturedSignal = ctx.signal;
        },
        open: async (sink) => {
          sink.emit({ event: "run.output", data: "1" });
          await deferred.promise;
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await flushMicrotasks();
    expect(capturedSignal?.aborted).toBe(false);

    deferred.resolve();
    await logged;

    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("createConsoleRequestListener — the streaming branch itself", () => {
  test("a stream route writes text/event-stream headers with no content-length, and every frame is written before res.end()", async () => {
    const { logger, logged } = createResolvingLogger();
    const { req } = createTrackingIncomingMessage();
    const { res, calls } = createStreamCapableServerResponse();
    const router = createRouter([
      streamRoute({
        open: (sink) => {
          sink.emit({ event: "run.output", data: "hello" });
          sink.emit({ event: "run.output", data: "world" });
          return Promise.resolve();
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await logged;
    await flushMicrotasks();

    const headCall = calls.find((call) => call.kind === "writeHead");
    expect(headCall?.status).toBe(200);
    const headers = headCall?.headers ?? {};
    expect(headers["content-type"]).toBe("text/event-stream");
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      "content-length",
    );

    const writeIndexes = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.kind === "write")
      .map(({ index }) => index);
    const endIndex = calls.findIndex((call) => call.kind === "end");

    expect(writeIndexes.length).toBeGreaterThan(0);
    expect(endIndex).toBeGreaterThan(-1);
    expect(writeIndexes.every((index) => index < endIndex)).toBe(true);
  });

  test("a buffered route on the same listener is unaffected: same status, content-length present, one outcome line", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { req } = createTrackingIncomingMessage({ url: "/api/v1/buffered" });
    const { res, calls } = createStreamCapableServerResponse();
    const bufferedRoute: M3LRoute = {
      method: "GET",
      path: "/api/v1/buffered",
      auth: "required",
      handler: () => jsonResponse(200, { ok: true }),
    };
    const router = createRouter([bufferedRoute]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await logged;
    await flushMicrotasks();

    const headCall = calls.find((call) => call.kind === "writeHead");
    expect(headCall?.status).toBe(200);
    expect(headCall?.headers?.["content-length"]).toBeDefined();
    expect(outcomeEventsOf(events)).toHaveLength(1);
  });

  test("exactly one outcome line is emitted for a stream request, carrying frames/dropped/reason", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { req } = createTrackingIncomingMessage();
    const { res } = createStreamCapableServerResponse();
    const router = createRouter([
      streamRoute({
        open: (sink) => {
          sink.emit({ event: "run.output", data: "hello" });
          return Promise.resolve();
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await logged;
    await flushMicrotasks();

    const outcomeEvents = outcomeEventsOf(events);
    expect(outcomeEvents).toHaveLength(1);
    expect(outcomeEvents[0]?.data).toMatchObject({
      streamOutcome: { frames: 1, dropped: 0, reason: "completed" },
    });
  });

  test("the outcome line's durationMs reflects the stream's full lifetime, not the time to open", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { req } = createTrackingIncomingMessage();
    const { res } = createStreamCapableServerResponse();
    const deferred = createDeferred<void>();
    let openStarted = false;
    const router = createRouter([
      streamRoute({
        open: async (sink) => {
          openStarted = true;
          sink.emit({ event: "run.output", data: "1" });
          await deferred.promise;
        },
      }),
    ]);
    let currentTime = 1_000;
    const now = (): number => currentTime;
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      now,
    });

    listener(req, res);
    await flushMicrotasks();
    // Sanity: open() must have actually been invoked before we advance the
    // clock, or a passing durationMs assertion below would prove nothing.
    expect(openStarted).toBe(true);

    currentTime = 1_750;
    deferred.resolve();
    await logged;

    const outcomeEvents = outcomeEventsOf(events);
    expect(outcomeEvents[0]?.data?.["durationMs"]).toBe(750);
  });

  test("a stream route whose open() rejects still ends the response, logs, and emits one outcome line", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { req } = createTrackingIncomingMessage();
    const { res } = createStreamCapableServerResponse();
    let openWasCalled = false;
    const router = createRouter([
      streamRoute({
        open: () => {
          openWasCalled = true;
          return Promise.reject(new Error("route explosion"));
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });

    listener(req, res);
    await logged;
    await flushMicrotasks();

    // Sanity: open() must have actually been invoked (and rejected) for the
    // assertions below to mean anything — a request that never reaches the
    // streaming branch at all would also happen to end the response and log
    // once, via the unrelated write-crash fallback path.
    expect(openWasCalled).toBe(true);
    expect(res.writableEnded).toBe(true);
    expect(outcomeEventsOf(events)).toHaveLength(1);
  });
});
