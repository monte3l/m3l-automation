/**
 * Tests for src/http/handler.ts — `createConsoleRequestListener`'s per-
 * request pipeline (m3l-console-server X2b contract, wave 2).
 *
 * Every case here drives `createConsoleRequestListener`'s returned listener
 * directly against `IncomingMessage`/`ServerResponse` doubles — never a real
 * loopback `node:http` server. None of this module's own branches (context
 * creation, dispatch, logging, the write-failure fallback) depend on an
 * actual socket; the two guarantees that genuinely need one (byte-accurate
 * `content-length` over the wire, and a failed write really ending the
 * socket) live in `tests/integration/` instead (see
 * `vitest.integration.config.ts`).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { jsonResponse } from "../src/http/respond.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { createRouter } from "../src/http/router.js";
import type { M3LRoute, M3LRouteAuth } from "../src/http/router.js";
import { createConsoleRequestListener } from "../src/http/handler.js";
import type { M3LConsoleMiddleware } from "../src/http/middleware.js";
import { M3LConsoleError } from "../src/errors/console-error.js";

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

/**
 * Builds a minimal `IncomingMessage` double: an `EventEmitter` carrying just
 * the members `handler.ts` reads before dispatch (`method`, `url`,
 * `headers`, `rawHeaders`) plus the `once`/`removeListener` pair it uses for
 * the connection-abort seam. `rawHeaders` defaults to the flattened form of
 * `headers` (Node's own alternating key/value shape) when not overridden,
 * matching a request with no duplicate header lines.
 */
function createFakeIncomingMessage(
  overrides: Partial<
    Pick<IncomingMessage, "method" | "url" | "headers" | "rawHeaders">
  > = {},
): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  const headers = overrides.headers ?? {};
  Object.assign(req, {
    method: "GET",
    url: "/api/v1/runs",
    headers,
    rawHeaders: Object.entries(headers).flatMap(([key, value]) => [
      key,
      String(value),
    ]),
    ...overrides,
  });
  return req;
}

/**
 * Builds a minimal `ServerResponse` double exposing just the members
 * `handler.ts`/`writeResponse` touch: `writableEnded`, `headersSent`,
 * `writeHead`, and `end`.
 */
function createFakeServerResponse(
  overrides: Partial<{
    readonly writableEnded: boolean;
    readonly headersSent: boolean;
    readonly writeHead: (...args: readonly unknown[]) => unknown;
    readonly end: (...args: readonly unknown[]) => unknown;
  }> = {},
): ServerResponse {
  const res = new EventEmitter() as unknown as ServerResponse;
  Object.assign(res, {
    writableEnded: false,
    headersSent: false,
    writeHead: () => res,
    end: () => res,
    ...overrides,
  });
  return res;
}

/** What `writeResponse` actually wrote onto a {@link createRecordingServerResponse} double. */
interface RecordedWrite {
  status?: number;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
}

/**
 * Builds a `ServerResponse` double that records the arguments its
 * `writeHead`/`end` calls receive — the doubles-based replacement for
 * driving a real request through a real socket and inspecting the response
 * client-side. Also flips `headersSent`/`writableEnded` the way a real
 * `node:http` response would, so the no-op guards in `writeResponse` behave
 * identically.
 */
function createRecordingServerResponse(): {
  readonly res: ServerResponse;
  readonly written: RecordedWrite;
} {
  const written: RecordedWrite = {};
  const res = new EventEmitter() as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  Object.assign(res, {
    writableEnded: false,
    headersSent: false,
    writeHead: (status: number, headers?: Readonly<Record<string, string>>) => {
      written.status = status;
      written.headers = headers;
      res.headersSent = true;
      return res;
    },
    end: (body?: string) => {
      written.body = body;
      res.writableEnded = true;
      return res;
    },
  });
  return { res, written };
}

/** A mutable `ServerResponse` double that can flip its own state mid-call. */
type RaceyServerResponse = ServerResponse & {
  headersSent: boolean;
  writableEnded: boolean;
};

/** The observable call counts against a {@link RaceyServerResponse}. */
interface FallbackResponseCallLog {
  writeHeadCalls: number;
  endCalls: number;
}

/**
 * Builds a `ServerResponse` double plus a mutable call log, for exercising
 * `writeFallbackResponse`'s guard branches. `writeHeadBehavior`/`endBehavior`
 * receive the double itself (already constructed) so they can flip
 * `headersSent`/`writableEnded` as a side effect — modelling a real
 * `node:http` race (e.g. headers flushed just before the call that reports
 * the failure) rather than a static fixture.
 */
function createRaceyServerResponse(options: {
  readonly writeHeadBehavior: (res: RaceyServerResponse, call: number) => void;
  readonly endBehavior?: (res: RaceyServerResponse, call: number) => void;
}): {
  readonly res: RaceyServerResponse;
  readonly log: FallbackResponseCallLog;
} {
  const log: FallbackResponseCallLog = { writeHeadCalls: 0, endCalls: 0 };
  const res = new EventEmitter() as unknown as RaceyServerResponse;
  Object.assign(res, {
    writableEnded: false,
    headersSent: false,
    writeHead: () => {
      log.writeHeadCalls += 1;
      options.writeHeadBehavior(res, log.writeHeadCalls);
      return res;
    },
    end: () => {
      log.endCalls += 1;
      options.endBehavior?.(res, log.endCalls);
      return res;
    },
  });
  return { res, log };
}

/** Builds a minimal `M3LRoute`, defaulting `auth` and `handler`. */
function route(
  overrides: Pick<M3LRoute, "method" | "path"> &
    Partial<Pick<M3LRoute, "auth" | "handler">>,
): M3LRoute {
  return {
    auth: "required",
    handler: () => ({ status: 200, headers: {}, body: "ok" }),
    ...overrides,
  };
}

describe("createConsoleRequestListener — happy path", () => {
  test("dispatches to the matched route's handler and writes its response", async () => {
    const { logger, logged } = createResolvingLogger();
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => jsonResponse(200, { ok: true }),
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({
      method: "GET",
      url: "/api/v1/runs",
    });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(200);
    const parsed: unknown = JSON.parse(written.body ?? "");
    expect(parsed).toEqual({ ok: true });
  });

  test("attaches matched route params via withParams before running the middleware chain", async () => {
    const { logger, logged } = createResolvingLogger();
    let paramsSeenByMiddleware: Readonly<Record<string, string>> | undefined;
    const middleware: M3LConsoleMiddleware = (ctx, next) => {
      paramsSeenByMiddleware = ctx.params;
      return next(ctx);
    };
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs/:id",
        handler: (ctx) => jsonResponse(200, { params: ctx.params }),
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [middleware],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({
      method: "GET",
      url: "/api/v1/runs/42",
    });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    const parsed: unknown = JSON.parse(written.body ?? "");
    expect(parsed).toEqual({ params: { id: "42" } });
    expect(paramsSeenByMiddleware).toEqual({ id: "42" });
  });
});

describe("createConsoleRequestListener — 404 and 405 envelopes", () => {
  test("returns a well-formed 404 envelope for an unmatched path", async () => {
    const { logger, logged } = createResolvingLogger();
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/nope" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(404);
    const parsed: unknown = JSON.parse(written.body ?? "");
    expect(parsed).toMatchObject({ error: { status: 404 } });
  });

  test("returns a well-formed 405 envelope for a matched path with the wrong method", async () => {
    const { logger, logged } = createResolvingLogger();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({
      method: "DELETE",
      url: "/api/v1/runs",
    });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(405);
    const parsed: unknown = JSON.parse(written.body ?? "");
    expect(parsed).toMatchObject({
      error: { status: 405, code: "ERR_CONSOLE_METHOD_NOT_ALLOWED" },
    });
  });
});

/**
 * Finds the diagnostic event emitted by `logDiagnosticIfFault`/
 * `writeResponseGuarded` — the message they build always contains this
 * substring — distinct from the per-request outcome line `logOutcome` always
 * emits (`<method> <path> -> <status>`).
 */
function findDiagnosticEvent(
  events: readonly Core.M3LLogEvent[],
): Core.M3LLogEvent | undefined {
  return events.find(
    (event) =>
      event.message.includes("unhandled failure handling") ||
      event.message.includes("failed writing response for"),
  );
}

/** Finds the per-request outcome line: `<method> <path> -> <status>`. */
function findOutcomeEvent(
  events: readonly Core.M3LLogEvent[],
  status: number,
): Core.M3LLogEvent | undefined {
  return events.find((event) => event.message.includes(`-> ${String(status)}`));
}

describe("createConsoleRequestListener — a handler that throws", () => {
  test("yields a well-formed envelope, logs the outcome line, and logs a diagnostic line carrying the real cause", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const router = createRouter([
      route({
        method: "GET",
        path: "/boom",
        handler: () => {
          throw new Error("kaboom, and this text must never reach the caller");
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
    const req = createFakeIncomingMessage({ url: "/boom" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await new Promise((resolve) => setImmediate(resolve));

    expect(written.status).toBe(500);
    const parsed: unknown = JSON.parse(written.body ?? "");
    expect(parsed).toMatchObject({
      error: {
        code: "ERR_CONSOLE_INTERNAL",
        message: "An unexpected error occurred.",
        status: 500,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("kaboom");

    // Two events, not one: the outcome line and a separate diagnostic line
    // (ADR-0070's display-vs-persist split) — this is the whole point of the
    // fix, and would fail if the diagnostic call were ever removed.
    expect(events).toHaveLength(2);

    const outcome = findOutcomeEvent(events, 500);
    expect(outcome?.category).toBe(Core.M3LLogEventCategory.ERROR);
    expect(outcome?.message).toContain("GET");
    expect(outcome?.message).toContain("/boom");

    const diagnostic = findDiagnosticEvent(events);
    expect(diagnostic?.category).toBe(Core.M3LLogEventCategory.ERROR);
    expect(diagnostic?.message).toContain("unhandled failure handling");
    expect(diagnostic?.message).toContain("GET");
    expect(diagnostic?.message).toContain("/boom");
    // The real cause reaches the diagnostic line even though the response
    // body only ever shows the fixed generic message.
    expect(JSON.stringify(diagnostic)).toContain(
      "kaboom, and this text must never reach the caller",
    );
  });

  test("a rejected handler promise is caught the same way as a synchronous throw", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const router = createRouter([
      route({
        method: "GET",
        path: "/async-boom",
        handler: () => Promise.reject(new Error("async kaboom")),
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/async-boom" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(500);
    expect(events).toHaveLength(2);
    expect(findDiagnosticEvent(events)).toBeDefined();
    expect(findOutcomeEvent(events, 500)).toBeDefined();
  });

  test("a middleware that throws is also caught and yields a well-formed envelope", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const throwingMiddleware: M3LConsoleMiddleware = () => {
      throw new Error("middleware kaboom");
    };
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [throwingMiddleware],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(500);
    expect(events).toHaveLength(2);
    expect(findDiagnosticEvent(events)).toBeDefined();
    expect(findOutcomeEvent(events, 500)).toBeDefined();
  });

  test("a rejected handler promise wrapping a cause: the underlying cause survives into the diagnostic event", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const underlyingCause = new Error(
      "distinctive underlying cause: connection refused",
    );
    const router = createRouter([
      route({
        method: "GET",
        path: "/wrapped-boom",
        handler: () =>
          Promise.reject(
            new Error("wrapping failure", { cause: underlyingCause }),
          ),
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/wrapped-boom" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(500);
    const diagnostic = findDiagnosticEvent(events);
    // `errorFrom` walks the full `cause` chain via `serializeErrorChain` — a
    // flattened top-level message alone would not carry this.
    expect(JSON.stringify(diagnostic)).toContain(
      "distinctive underlying cause: connection refused",
    );
  });

  test("a handler that throws ERR_CONSOLE_UNAVAILABLE yields 503 and emits NO diagnostic line — exactly one outcome line total", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const router = createRouter([
      route({
        method: "GET",
        path: "/draining",
        handler: () => {
          throw new M3LConsoleError(
            "ERR_CONSOLE_UNAVAILABLE",
            "the server is draining and refuses new requests",
          );
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
    const req = createFakeIncomingMessage({ url: "/draining" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await new Promise((resolve) => setImmediate(resolve));

    expect(written.status).toBe(503);

    // This is the whole point of the `fault` field: an origin-only gate
    // (the old isCallerOriginError) would treat this library-origin code as
    // a fault and log a diagnostic line for it too, producing 2 events.
    expect(events).toHaveLength(1);
    expect(findDiagnosticEvent(events)).toBeUndefined();
    expect(findOutcomeEvent(events, 503)).toBeDefined();
  });

  test("a handler that throws ERR_CONSOLE_INTERNAL still emits its diagnostic line (the gate is not disabled wholesale)", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const router = createRouter([
      route({
        method: "GET",
        path: "/internal-boom",
        handler: () => {
          throw new M3LConsoleError(
            "ERR_CONSOLE_INTERNAL",
            "genuine internal failure, distinct from the generic envelope text",
          );
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
    const req = createFakeIncomingMessage({ url: "/internal-boom" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await new Promise((resolve) => setImmediate(resolve));

    expect(written.status).toBe(500);
    expect(events).toHaveLength(2);
    const diagnostic = findDiagnosticEvent(events);
    expect(diagnostic).toBeDefined();
    expect(JSON.stringify(diagnostic)).toContain(
      "genuine internal failure, distinct from the generic envelope text",
    );
    expect(findOutcomeEvent(events, 500)).toBeDefined();
  });
});

describe("createConsoleRequestListener — the abort seam is live", () => {
  test("aborting the drain signal aborts the in-flight request's ctx.signal", async () => {
    const { logger, logged } = createResolvingLogger();
    const drainController = new AbortController();
    let observedAborted: boolean | undefined;
    let resolveReceived: () => void = () => undefined;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    const router = createRouter([
      route({
        method: "GET",
        path: "/slow",
        handler: (ctx) =>
          new Promise<M3LConsoleResponse>((resolve) => {
            resolveReceived();
            ctx.signal.addEventListener("abort", () => {
              observedAborted = ctx.signal.aborted;
              resolve({ status: 200, headers: {}, body: "done" });
            });
          }),
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: drainController.signal,
    });
    const req = createFakeIncomingMessage({ url: "/slow" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await received;
    drainController.abort();
    await logged;

    expect(observedAborted).toBe(true);
  });

  test("aborts ctx.signal when the underlying connection's own 'close' event fires while dispatch is in-flight", async () => {
    const { logger } = createCapturingLogger();
    const req = createFakeIncomingMessage();
    const res = createFakeServerResponse();
    let resolveDispatch: (response: M3LConsoleResponse) => void = () =>
      undefined;
    let observedAborted: boolean | undefined;
    const dispatchStarted = new Promise<void>((resolveStarted) => {
      const router = createRouter([
        route({
          method: "GET",
          path: "/api/v1/runs",
          handler: (ctx) =>
            new Promise<M3LConsoleResponse>((resolveHandler) => {
              resolveDispatch = resolveHandler;
              ctx.signal.addEventListener("abort", () => {
                observedAborted = ctx.signal.aborted;
              });
              resolveStarted();
            }),
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
    });

    await dispatchStarted;
    req.emit("close");
    resolveDispatch({ status: 200, headers: {}, body: "done" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(observedAborted).toBe(true);
  });

  test("a late close does not abort mid-request, but the signal is released once the response is written", async () => {
    const { logger } = createCapturingLogger();
    const req = createFakeIncomingMessage();
    const res = createFakeServerResponse({ writableEnded: true });
    let resolveDispatch: (response: M3LConsoleResponse) => void = () =>
      undefined;
    let observedAborted: boolean | undefined;
    const dispatchStarted = new Promise<void>((resolveStarted) => {
      const router = createRouter([
        route({
          method: "GET",
          path: "/api/v1/runs",
          handler: (ctx) =>
            new Promise<M3LConsoleResponse>((resolveHandler) => {
              resolveDispatch = resolveHandler;
              ctx.signal.addEventListener("abort", () => {
                observedAborted = ctx.signal.aborted;
              });
              resolveStarted();
            }),
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
    });

    await dispatchStarted;
    req.emit("close");

    // The LISTENER no-ops: a late close must not report "cancelled" for a
    // request that has already succeeded.
    expect(observedAborted).toBeUndefined();

    resolveDispatch({ status: 200, headers: {}, body: "done" });
    await new Promise((resolve) => setImmediate(resolve));

    // ...but the composite pin IS released once the response has been
    // written, even though `res` was already ended: without this, an
    // `AbortSignal.any([drainSignal, perRequest])` that ever gets an abort
    // listener attached (exactly what `ctx.signal` is for) stays pinned by
    // the still-open, server-lifetime drain signal for the rest of the
    // process — a measured leak.
    expect(observedAborted).toBe(true);
  });
});

describe("createConsoleRequestListener — a writeResponse failure can never leave the socket open with no log line", () => {
  // Pins the FIXED behaviour (X2b, S3): a throw from `writeResponse` (e.g.
  // `res.writeHead` rejecting an out-of-range status) used to escape to the
  // outer `.catch`, which only logged and never touched the socket —
  // attacker-controlled FD exhaustion. `writeResponse` is now guarded
  // inside `runRequest` itself, so every request either writes a real
  // response or a fallback 500, and always logs the outcome line. A failed
  // write is always a genuine fault (never a routine caller-origin outcome),
  // so `writeResponseGuarded` also logs an UNCONDITIONAL diagnostic line via
  // `errorFrom` — two events total, not one. (The real-socket proof that
  // this fallback genuinely closes the connection lives in
  // `tests/integration/handler.integration.test.ts`.)
  test("falls back to a bare 500, still ends the response, and logs both the outcome line and an unconditional write-failure diagnostic", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const req = createFakeIncomingMessage();
    const res = createFakeServerResponse({
      writeHead: () => {
        throw new Error("writeHead exploded");
      },
    });
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
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

    // The socket was ended (via the default fake `end`, which does not
    // throw) rather than left open, and exactly two log lines were written —
    // never the outer-`.catch` "unhandled" message, since this failure was
    // fully handled inside `runRequest`.
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.message).not.toContain(
        "unhandled console request listener failure",
      );
    }

    const diagnostic = findDiagnosticEvent(events);
    expect(diagnostic?.message).toContain("failed writing response for");
    expect(JSON.stringify(diagnostic)).toContain("writeHead exploded");
  });
});

describe("createConsoleRequestListener — the outer safety net still guards runRequest's own boundary", () => {
  // `runRequest`'s internal try/catch now covers context creation, dispatch,
  // AND writing the response — but a failure BEFORE that guarded region
  // (e.g. the injected clock itself throwing) can still escape `runRequest`
  // entirely. This is the one remaining case the outer `.catch` guards.
  test("logs and swallows a failure that occurs before runRequest's own try/catch begins", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const req = createFakeIncomingMessage();
    const res = createFakeServerResponse();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      now: () => {
        throw new Error("clock exploded");
      },
    });

    listener(req, res);
    await logged;

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.ERROR);
    expect(events[0]?.message).toContain(
      "unhandled console request listener failure",
    );
  });
});

describe("createConsoleRequestListener — writeFallbackResponse's own guards", () => {
  test("attempts the fallback writeHead(500), swallows a further throw from it, and still ends the response", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const req = createFakeIncomingMessage();
    const { res, log } = createRaceyServerResponse({
      // Every writeHead call throws (both the primary attempt inside
      // writeResponse and the fallback's own writeHead(500)); state is never
      // flipped, so both guards ahead of writeHead(500) stay true.
      writeHeadBehavior: () => {
        throw new Error("writeHead exploded");
      },
    });
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => ({ status: 201, headers: {}, body: "created" }),
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

    // Two writeHead attempts: the primary (throws) and the fallback's own
    // writeHead(500) (also throws, caught, falls through to end()). A failed
    // write is always a genuine fault, so `writeResponseGuarded` logs an
    // unconditional diagnostic line in addition to the outcome line.
    expect(log.writeHeadCalls).toBe(2);
    expect(log.endCalls).toBe(1);
    expect(events).toHaveLength(2);
    const outcome = events.find((event) => event.data?.["status"] === 201);
    // The logged status is the REAL computed status from the route handler
    // (201) — never overwritten to the fallback's hard-coded 500, since
    // `response.status` is read from the already-computed response value.
    expect(outcome).toBeDefined();
    const diagnostic = findDiagnosticEvent(events);
    expect(diagnostic?.message).toContain("failed writing response for");
  });

  test("skips the fallback writeHead(500) once headers were already sent, but still retries end()", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const req = createFakeIncomingMessage();
    // Models the real writeResponse call sequence: writeHead succeeds
    // (flipping headersSent, as node:http itself would), but the
    // subsequent res.end(body) call throws. The fallback must then see
    // headersSent === true and skip re-sending a status line, retrying
    // only end().
    const { res, log } = createRaceyServerResponse({
      writeHeadBehavior: (raceyRes) => {
        raceyRes.headersSent = true;
      },
      endBehavior: (_raceyRes, call) => {
        if (call === 1) throw new Error("first end() exploded");
      },
    });
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => ({ status: 204, headers: {}, body: "" }),
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

    // writeHead was only ever called once (the primary attempt) — the
    // fallback's own writeHead(500) was skipped because headersSent was
    // already true. The failed `end()` is still a genuine fault, so an
    // unconditional diagnostic line accompanies the outcome line.
    expect(log.writeHeadCalls).toBe(1);
    expect(log.endCalls).toBe(2);
    expect(events).toHaveLength(2);
    const outcome = events.find((event) => event.data?.["status"] === 204);
    expect(outcome).toBeDefined();
    expect(findDiagnosticEvent(events)?.message).toContain(
      "failed writing response for",
    );
  });

  test("skips the fallback end() once the response was already reported as ended", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const req = createFakeIncomingMessage();
    // Models a concurrent close: the primary writeHead throws AND, as a
    // side effect of that same race, writableEnded flips to true — the
    // fallback must then skip both writeHead(500) (writableEnded guard) and
    // end() (writableEnded guard), never touching an already-finished
    // response.
    const { res, log } = createRaceyServerResponse({
      writeHeadBehavior: (raceyRes) => {
        raceyRes.writableEnded = true;
        throw new Error("writeHead exploded as the socket was closing");
      },
    });
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
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

    expect(log.writeHeadCalls).toBe(1);
    expect(log.endCalls).toBe(0);
    // The failed primary write is still a genuine fault: the outcome line
    // plus an unconditional write-failure diagnostic.
    expect(events).toHaveLength(2);
    expect(JSON.stringify(findDiagnosticEvent(events))).toContain(
      "writeHead exploded as the socket was closing",
    );
  });

  test("swallows a throw from the fallback's own end() call", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const req = createFakeIncomingMessage();
    const { res, log } = createRaceyServerResponse({
      writeHeadBehavior: () => {
        throw new Error("writeHead exploded");
      },
      endBehavior: () => {
        throw new Error("end() exploded too");
      },
    });
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
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

    // Neither writeHead nor end() ever succeeded, yet nothing escaped
    // runRequest: the outcome line plus one write-failure diagnostic line
    // were still written — never the outer-`.catch` "unhandled" message.
    expect(log.writeHeadCalls).toBe(2);
    expect(log.endCalls).toBe(1);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.message).not.toContain(
        "unhandled console request listener failure",
      );
    }
    expect(findDiagnosticEvent(events)?.message).toContain(
      "failed writing response for",
    );
  });
});

/**
 * Tests for `CreateConsoleRequestListenerOptions.preRouting` (X2b, wave 3):
 * a second middleware chain that runs around the WHOLE of `dispatch`, unlike
 * `middlewares`, which only wraps a matched route's handler and therefore
 * never sees an unmatched request. WHY this matters: a DNS-rebinding probe
 * to an unknown path would bypass an origin guard placed in `middlewares`
 * entirely, getting a clean 404 that still confirms an m3l console is
 * listening. A `preRouting` guard sees the probe regardless of outcome.
 */
describe("createConsoleRequestListener — the preRouting chain wraps the whole of dispatch", () => {
  test("a preRouting middleware runs for a request that 404s", async () => {
    const { logger, logged } = createResolvingLogger();
    let ran = false;
    const preRoutingMw: M3LConsoleMiddleware = (ctx, next) => {
      ran = true;
      return next(ctx);
    };
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      preRouting: [preRoutingMw],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/nope" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(ran).toBe(true);
    expect(written.status).toBe(404);
  });

  test("a preRouting middleware runs for a request that 405s", async () => {
    const { logger, logged } = createResolvingLogger();
    let ran = false;
    const preRoutingMw: M3LConsoleMiddleware = (ctx, next) => {
      ran = true;
      return next(ctx);
    };
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [preRoutingMw],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({
      method: "DELETE",
      url: "/api/v1/runs",
    });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(ran).toBe(true);
    expect(written.status).toBe(405);
  });

  test("a preRouting middleware runs for a request that matches a route", async () => {
    const { logger, logged } = createResolvingLogger();
    let ran = false;
    const preRoutingMw: M3LConsoleMiddleware = (ctx, next) => {
      ran = true;
      return next(ctx);
    };
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [preRoutingMw],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(ran).toBe(true);
    expect(written.status).toBe(200);
  });

  test("a middlewares member does NOT run for a 404 — the existing behaviour, now made explicit", async () => {
    const { logger, logged } = createResolvingLogger();
    let ran = false;
    const middleware: M3LConsoleMiddleware = (ctx, next) => {
      ran = true;
      return next(ctx);
    };
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [middleware],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/nope" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(404);
    expect(ran).toBe(false);
  });

  test("a preRouting middleware that short-circuits prevents routing entirely: the route handler never runs and the response is the middleware's own", async () => {
    const { logger, logged } = createResolvingLogger();
    let handlerRan = false;
    const shortCircuitResponse: M3LConsoleResponse = {
      status: 418,
      headers: {},
      body: "short-circuited",
    };
    const preRoutingMw: M3LConsoleMiddleware = () => shortCircuitResponse;
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => {
          handlerRan = true;
          return { status: 200, headers: {}, body: "ok" };
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [preRoutingMw],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(handlerRan).toBe(false);
    expect(written.status).toBe(418);
    expect(written.body).toBe("short-circuited");
  });

  test("preRouting members run outermost-first, before any middlewares member", async () => {
    const { logger, logged } = createResolvingLogger();
    const order: string[] = [];
    const preRoutingMw: M3LConsoleMiddleware = async (ctx, next) => {
      order.push("preRouting-in");
      const response = await next(ctx);
      order.push("preRouting-out");
      return response;
    };
    const middleware: M3LConsoleMiddleware = async (ctx, next) => {
      order.push("middlewares-in");
      const response = await next(ctx);
      order.push("middlewares-out");
      return response;
    };
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => {
          order.push("handler");
          return { status: 200, headers: {}, body: "ok" };
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [middleware],
      preRouting: [preRoutingMw],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(order).toEqual([
      "preRouting-in",
      "middlewares-in",
      "handler",
      "middlewares-out",
      "preRouting-out",
    ]);
  });

  test("when a preRouting middleware short-circuits, the outcome log's accessMode is undefined — routing never happened, so there is no route to report", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const preRoutingMw: M3LConsoleMiddleware = () => ({
      status: 418,
      headers: {},
      body: "short",
    });
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs", auth: "required" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [preRoutingMw],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(events).toHaveLength(1);
    // `logOutcome` only spreads `accessMode` onto the logged data when it is
    // defined — an undefined accessMode is therefore an absent key, not a
    // present key with value `undefined`.
    expect(events[0]?.data).not.toHaveProperty("accessMode");
  });

  test.each<M3LRouteAuth>(["required", "exempt"])(
    "ctx.accessMode inside a middlewares member equals the matched route's auth (%s)",
    async (auth) => {
      const { logger, logged } = createResolvingLogger();
      let observedAccessMode: M3LRouteAuth | undefined;
      const middleware: M3LConsoleMiddleware = (ctx, next) => {
        observedAccessMode = ctx.accessMode;
        return next(ctx);
      };
      const router = createRouter([
        route({ method: "GET", path: "/api/v1/runs", auth }),
      ]);
      const listener = createConsoleRequestListener({
        router,
        middlewares: [middleware],
        preRouting: [],
        logger,
        signal: new AbortController().signal,
      });
      const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
      const { res } = createRecordingServerResponse();

      listener(req, res);
      await logged;

      expect(observedAccessMode).toBe(auth);
    },
  );
});

/**
 * Tests for the abort-signal release fixed in `runRequest` (X2b, wave 3).
 * This is a MEASURED leak, not a hypothetical: on Node v26.7.0,
 * `AbortSignal.any([longLived, perRequest])` produces a composite that is
 * normally collectable, but once anything attaches a listener to that
 * composite and never removes it, the long-lived source (`options.signal`,
 * the drain signal, which lives as long as the server) pins the composite
 * for the life of the process. `runRequest` builds exactly this shape, and
 * `ctx.signal` exists precisely to be listened on by pollers and X4's run
 * orchestration — so every request must leave its `ctx.signal` aborted once
 * it completes, releasing the composite, regardless of which path the
 * request took.
 *
 * A `preRouting` middleware is used to capture `ctx.signal` uniformly across
 * all four paths below, since it is the only seam that runs on every one of
 * them (unlike a route handler, which never runs for a 404 or a
 * preRouting-level short-circuit).
 */
describe("createConsoleRequestListener — runRequest releases its composite abort signal after completion", () => {
  test("a normal 2xx response ends with ctx.signal aborted", async () => {
    const { logger, logged } = createResolvingLogger();
    let capturedSignal: AbortSignal | undefined;
    const captureSignal: M3LConsoleMiddleware = (ctx, next) => {
      capturedSignal = ctx.signal;
      return next(ctx);
    };
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [captureSignal],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(200);
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("a handler that throws (5xx) still ends with ctx.signal aborted", async () => {
    const { logger, logged } = createResolvingLogger();
    let capturedSignal: AbortSignal | undefined;
    const captureSignal: M3LConsoleMiddleware = (ctx, next) => {
      capturedSignal = ctx.signal;
      return next(ctx);
    };
    const router = createRouter([
      route({
        method: "GET",
        path: "/boom",
        handler: () => {
          throw new Error("kaboom");
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [captureSignal],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/boom" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await new Promise((resolve) => setImmediate(resolve));

    expect(written.status).toBe(500);
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("an unmatched 404 still ends with ctx.signal aborted", async () => {
    const { logger, logged } = createResolvingLogger();
    let capturedSignal: AbortSignal | undefined;
    const captureSignal: M3LConsoleMiddleware = (ctx, next) => {
      capturedSignal = ctx.signal;
      return next(ctx);
    };
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      preRouting: [captureSignal],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/nope" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(404);
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("a preRouting short-circuit still ends with ctx.signal aborted", async () => {
    const { logger, logged } = createResolvingLogger();
    let capturedSignal: AbortSignal | undefined;
    const shortCircuitMw: M3LConsoleMiddleware = (ctx) => {
      capturedSignal = ctx.signal;
      return { status: 418, headers: {}, body: "short" };
    };
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [shortCircuitMw],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(418);
    expect(capturedSignal?.aborted).toBe(true);
  });

  // NOTE TO FUTURE MAINTAINERS: this ordering is load-bearing, not
  // incidental. Do NOT "tidy away" the abort-after-write sequencing as
  // redundant with the abort-happens-eventually tests above — aborting the
  // composite signal BEFORE the response is written would cancel the very
  // write it is meant to follow (a poller or X4 run orchestration listening
  // on `ctx.signal` could tear down mid-write). This test fails if the abort
  // is ever moved ahead of `writeResponseGuarded`.
  test("ordering: runRequest aborts ctx.signal ONLY AFTER the response is fully written, never before", async () => {
    const { logger, logged } = createResolvingLogger();
    let capturedSignal: AbortSignal | undefined;
    let abortedAtWriteHeadTime: boolean | undefined;
    let abortedAtEndTime: boolean | undefined;
    let writtenStatus: number | undefined;
    let writtenBody: string | undefined;
    const captureSignal: M3LConsoleMiddleware = (ctx, next) => {
      capturedSignal = ctx.signal;
      return next(ctx);
    };
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => ({ status: 200, headers: {}, body: "ok-body" }),
      }),
    ]);
    const res = new EventEmitter() as unknown as ServerResponse & {
      writableEnded: boolean;
      headersSent: boolean;
    };
    Object.assign(res, {
      writableEnded: false,
      headersSent: false,
      writeHead: (status: number) => {
        writtenStatus = status;
        // The response write must observe the signal as NOT YET aborted.
        abortedAtWriteHeadTime = capturedSignal?.aborted;
        res.headersSent = true;
        return res;
      },
      end: (body?: string) => {
        writtenBody = body;
        // Same guarantee at the final `end()` call — still not aborted.
        abortedAtEndTime = capturedSignal?.aborted;
        res.writableEnded = true;
        return res;
      },
    });
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [captureSignal],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });

    listener(req, res);
    await logged;

    // The response was intact and fully written...
    expect(writtenStatus).toBe(200);
    expect(writtenBody).toBe("ok-body");
    // ...and at the moment of each write call, the signal had not yet been
    // aborted...
    expect(abortedAtWriteHeadTime).toBe(false);
    expect(abortedAtEndTime).toBe(false);
    // ...only AFTER the write completed does the signal end up aborted.
    expect(capturedSignal?.aborted).toBe(true);
  });
});
