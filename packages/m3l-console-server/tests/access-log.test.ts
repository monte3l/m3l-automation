/**
 * Tests for src/http/access-log.ts — the per-request logging seam
 * (`logOutcome`/`logDiagnosticIfFault`) that `handler.ts` calls after
 * dispatch (m3l-console-server X2b contract, wave 2).
 *
 * Every case here drives `createConsoleRequestListener`'s returned listener
 * against `IncomingMessage`/`ServerResponse` doubles rather than a real
 * loopback `node:http` server — the tests exercise the log level/redaction
 * behaviour through the real request pipeline, not `logOutcome` directly,
 * because that pipeline is what actually pins the observable logging
 * guarantee (status-class-to-level mapping, gated diagnostic line,
 * redaction of the query string/headers/body).
 *
 * Split out of `handler.test.ts` (ADR-0072): that file pins the request-
 * pipeline mechanics (context creation, dispatch, the abort seam, response
 * writing, the two middleware chains) and was near this package's test-file
 * size ceiling; this file is the distinct concern of what gets logged and
 * at what level once a request has been handled.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createRouter } from "../src/http/router.js";
import type { M3LRoute, M3LRouteAuth } from "../src/http/router.js";
import { createConsoleRequestListener } from "../src/http/handler.js";

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

describe("createConsoleRequestListener — log level by status class", () => {
  test("logs a 5xx at error level", async () => {
    const { logger, events, logged } = createResolvingLogger();
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
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/boom" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await new Promise((resolve) => setImmediate(resolve));

    // A genuine (library-origin) fault logs both the outcome line AND the
    // gated diagnostic line, both at error level.
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.category).toBe(Core.M3LLogEventCategory.ERROR);
    }
  });

  test("logs a 4xx (not-found) at warning level, as a single outcome line", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
    });
    const req = createFakeIncomingMessage({ url: "/nope" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    // An unmatched route resolves through `dispatch()`'s "not-found" branch
    // without ever throwing, so `logDiagnosticIfFault` (and its
    // caller-origin gate) is never reached on this path at all — this only
    // pins the not-found outcome's own status/level/single-line shape. The
    // origin gate itself is pinned by the S1 malformed-target tests below,
    // which throw a genuine caller-origin error and so actually exercise it.
    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.WARNING);
    expect(findDiagnosticEvent(events)).toBeUndefined();
  });

  test("logs a successful 2xx at info level", async () => {
    const { logger, events, logged } = createResolvingLogger();
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
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
  });
});

describe("createConsoleRequestListener — log line never leaks sensitive request data", () => {
  test("never logs the query string, request headers, or an unrelated body value", async () => {
    const { logger, events, logged } = createResolvingLogger();
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
      url: "/api/v1/runs?apiKey=super-secret-value",
      headers: { "x-secret-header": "should-not-be-logged" },
    });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    // A successful 2xx dispatch stays at exactly one event (no diagnostic
    // line is gated for a fault that never occurred) — asserted over every
    // captured event, not `events[0]` alone, so this still holds if that
    // count is ever wrong.
    expect(events).toHaveLength(1);
    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("super-secret-value");
      expect(serialized).not.toContain("should-not-be-logged");
      expect(serialized).not.toContain("apiKey");
    }
  });

  test("a genuine fault's diagnostic line is held to the same redaction rule as the outcome line", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => {
          throw new Error("boom while handling the request");
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
    const req = createFakeIncomingMessage({
      url: "/api/v1/runs?apiKey=super-secret-value",
      headers: { "x-secret-header": "should-not-be-logged" },
    });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await new Promise((resolve) => setImmediate(resolve));

    // The new diagnostic line is a new sink for request data — no captured
    // event (outcome OR diagnostic) may carry the query string or headers.
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("super-secret-value");
      expect(serialized).not.toContain("should-not-be-logged");
      expect(serialized).not.toContain("apiKey");
    }
  });

  test.each<M3LRouteAuth>(["required", "exempt"])(
    "logs the matched route's auth mode (%s)",
    async (auth) => {
      const { logger, events, logged } = createResolvingLogger();
      const router = createRouter([
        route({ method: "GET", path: "/api/v1/runs", auth }),
      ]);
      const listener = createConsoleRequestListener({
        router,
        middlewares: [],
        preRouting: [],
        logger,
        signal: new AbortController().signal,
      });
      const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
      const { res } = createRecordingServerResponse();

      listener(req, res);
      await logged;

      expect(events).toHaveLength(1);
      for (const event of events) {
        expect(JSON.stringify(event)).toContain(auth);
      }
    },
  );
});
