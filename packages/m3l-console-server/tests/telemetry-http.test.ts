/**
 * Tests for src/http/handler.ts's optional `telemetry` option (X8 slice 2b) —
 * `CreateConsoleRequestListenerOptions.telemetry: M3LTelemetryRecorder`,
 * wired through `finish-request.ts`'s request-completion tail so exactly one
 * `telemetry.httpRequest({ route, outcome, latencyMs })` call is made per
 * request.
 *
 * RED: `telemetry` does not exist on `CreateConsoleRequestListenerOptions`
 * yet. Vitest does not typecheck, so every case below runs — the option is
 * ignored at runtime, no sample is ever recorded, and the assertions below
 * fail for that reason. `pnpm typecheck` separately reports an excess-
 * property error on `telemetry` until the option is added; that diagnostic
 * is expected and is not worked around here (no cast, no `@ts-expect-error`).
 *
 * The literal strings asserted for `route` below (the matched pattern,
 * `"(not-found)"`, `"(method-not-allowed)"`, `"(unrouted)"`) are the durable
 * contract itself (a permanent `console_telemetry_rollup` primary-key
 * component) — asserted verbatim, never reconciled against a constant
 * imported from the implementation.
 *
 * Split out of `handler.test.ts` (50,307 bytes against a 60,000-byte
 * ceiling) rather than appended to it.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createConsoleRequestListener } from "../src/http/handler.js";
import type { M3LConsoleMiddleware } from "../src/http/middleware.js";
import { createRouter } from "../src/http/router.js";
import type { M3LRoute } from "../src/http/router.js";
import type {
  M3LConsoleResult,
  M3LStreamSink,
} from "../src/http/stream-response.js";
import type {
  M3LTelemetryHttpRequestSample,
  M3LTelemetryRecorder,
} from "../src/telemetry/port.js";

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

/** Finds the per-request outcome line: `<method> <path> -> <status>`. */
function findOutcomeEvent(
  events: readonly Core.M3LLogEvent[],
  status: number,
): Core.M3LLogEvent | undefined {
  return events.find((event) => event.message.includes(`-> ${String(status)}`));
}

/**
 * Builds a minimal `IncomingMessage` double: an `EventEmitter` carrying just
 * the members `handler.ts` reads before dispatch (`method`, `url`,
 * `headers`, `rawHeaders`) plus the `once`/`removeListener` pair it uses for
 * the connection-abort seam.
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
 * `writeHead`/`end` calls receive, flipping `headersSent`/`writableEnded`
 * the way a real `node:http` response would.
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

/** One recorded call against a {@link createStreamCapableServerResponse} double, in call order. */
interface RecordedCall {
  readonly kind: "writeHead" | "write" | "end" | "flushHeaders";
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly payload?: string | undefined;
}

/**
 * Builds a `ServerResponse` double capable of driving the streaming branch
 * (`stream-writer.ts`'s `writeStream`), mirroring
 * `handler-streaming.test.ts`'s double.
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

/**
 * Builds an `IncomingMessage` double whose `once`/`removeListener` behave
 * like a real `EventEmitter`, for driving a streaming request that must
 * stay open across several microtask turns.
 */
function createTrackingIncomingMessage(
  overrides: Partial<Pick<IncomingMessage, "method" | "url">> = {},
): { readonly req: IncomingMessage } {
  const emitter = new EventEmitter();
  Object.assign(emitter, {
    method: overrides.method ?? "GET",
    url: overrides.url ?? "/api/v1/stream",
    headers: {},
    rawHeaders: [],
  });
  return { req: emitter as unknown as IncomingMessage };
}

/** Yields the microtask queue a few times so a pending `await` chain settles. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
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
 * Builds a minimal `M3LRoute` whose handler returns a stream result, per
 * `handler-streaming.test.ts`'s own helper.
 */
function streamRoute(config: {
  readonly path?: string;
  readonly status?: number;
  readonly open: (sink: M3LStreamSink) => Promise<void>;
}): M3LRoute {
  const handler = (): M3LConsoleResult => ({
    kind: "stream",
    status: config.status ?? 200,
    headers: { "content-type": "text/event-stream" },
    open: config.open,
  });
  return {
    method: "GET",
    path: config.path ?? "/api/v1/stream",
    auth: "required",
    handler,
  };
}

/**
 * Builds a capturing {@link M3LTelemetryRecorder} test double: every method
 * is implemented (a plain interface can never be satisfied by a partial
 * object), and every `httpRequest` sample handed to it is captured, in
 * order, into `httpRequestCalls`. `onHttpRequest`, when supplied, runs
 * AFTER the sample is captured — so a throwing override (case 13) still
 * leaves a record that the call happened.
 */
function createCapturingTelemetryRecorder(
  onHttpRequest?: (sample: M3LTelemetryHttpRequestSample) => void,
): {
  readonly telemetry: M3LTelemetryRecorder;
  readonly httpRequestCalls: M3LTelemetryHttpRequestSample[];
} {
  const httpRequestCalls: M3LTelemetryHttpRequestSample[] = [];
  const telemetry: M3LTelemetryRecorder = {
    httpRequest: (sample) => {
      httpRequestCalls.push(sample);
      onHttpRequest?.(sample);
    },
    runFinished: () => undefined,
    sseStream: () => undefined,
    policyDecision: () => undefined,
    storeHealth: () => undefined,
  };
  return { telemetry, httpRequestCalls };
}

describe("createConsoleRequestListener — telemetry.httpRequest on a matched route", () => {
  test("records exactly one sample: route is the matched PATTERN, outcome is 2xx, latencyMs is the injected clock's delta", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    let current = 0;
    const now = (): number => current;
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs/:id",
        handler: () => {
          current = 42;
          return { status: 200, headers: {}, body: "ok" };
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      now,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs/42" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls).toHaveLength(1);
    const sample = httpRequestCalls[0];
    expect(sample?.route).toBe("/api/v1/runs/:id");
    expect(sample?.outcome).toBe("2xx");
    expect(sample?.latencyMs).toBe(42);
  });

  test("the recorded route never contains the request's captured parameter value", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs/:id" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs/42" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls).toHaveLength(1);
    const sample = httpRequestCalls[0];
    expect(sample?.route).not.toContain("42");
    expect(sample?.route).toBe("/api/v1/runs/:id");
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest on an unmatched lookup", () => {
  test("a 404 records route (not-found) and outcome 4xx", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/nope" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls).toHaveLength(1);
    expect(httpRequestCalls[0]?.route).toBe("(not-found)");
    expect(httpRequestCalls[0]?.outcome).toBe("4xx");
  });

  test("a 405 (known path, wrong method) records route (method-not-allowed) and outcome 4xx", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const req = createFakeIncomingMessage({
      method: "DELETE",
      url: "/api/v1/runs",
    });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls).toHaveLength(1);
    expect(httpRequestCalls[0]?.route).toBe("(method-not-allowed)");
    expect(httpRequestCalls[0]?.outcome).toBe("4xx");
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest when routing never resolves", () => {
  test("a preRouting middleware that short-circuits before routing records route (unrouted)", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    const preRoutingMw: M3LConsoleMiddleware = () => ({
      status: 418,
      headers: {},
      body: "short-circuited",
    });
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [preRoutingMw],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls).toHaveLength(1);
    expect(httpRequestCalls[0]?.route).toBe("(unrouted)");
  });

  test("a request whose target fails to parse records route (unrouted), with no '?' and no fragment of the raw target", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const canaryTarget = "http://[?token=CANARY123";
    const req = createFakeIncomingMessage({ url: canaryTarget });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls).toHaveLength(1);
    const recordedRoute = httpRequestCalls[0]?.route;
    expect(recordedRoute).toBe("(unrouted)");
    expect(recordedRoute).not.toContain("?");
    expect(recordedRoute).not.toContain("CANARY123");
    expect(recordedRoute).not.toContain(canaryTarget);
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest when a matched route's handler throws (central case)", () => {
  test("[CENTRAL] records the matched PATTERN — never (unrouted) — with outcome 5xx", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
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
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/boom" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await flushMicrotasks();

    expect(httpRequestCalls).toHaveLength(1);
    expect(httpRequestCalls[0]?.route).toBe("/boom");
    expect(httpRequestCalls[0]?.route).not.toBe("(unrouted)");
    expect(httpRequestCalls[0]?.outcome).toBe("5xx");
  });

  test("the access log's outcome line now carries accessMode for a matched route whose handler throws (deliberate, accepted behaviour change)", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { telemetry } = createCapturingTelemetryRecorder();
    const router = createRouter([
      route({
        method: "GET",
        path: "/boom",
        auth: "required",
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
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/boom" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await flushMicrotasks();

    const outcome = findOutcomeEvent(events, 500);
    expect(outcome?.data).toHaveProperty("accessMode");
    expect(outcome?.data?.["accessMode"]).toBe("required");
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest fires exactly once per request", () => {
  test("exactly one call for a buffered response", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls).toHaveLength(1);
  });

  test("exactly one call for a streaming response", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
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
      telemetry,
    });

    listener(req, res);
    await logged;
    await flushMicrotasks();

    // Sanity: the request really did complete (an outcome line was logged)
    // before asserting the call count against it.
    expect(events.some((event) => event.message.includes(" -> "))).toBe(true);
    expect(httpRequestCalls).toHaveLength(1);
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest's latencyMs shares the access log's clock read", () => {
  test("latencyMs equals the access log line's durationMs for the same request", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    let current = 0;
    const now = (): number => current;
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => {
          current = 77;
          return { status: 200, headers: {}, body: "ok" };
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      now,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    const outcome = findOutcomeEvent(events, 200);
    const durationMs = outcome?.data?.["durationMs"];
    expect(durationMs).toBe(77);
    expect(httpRequestCalls[0]?.latencyMs).toBe(durationMs);
  });
});

describe("createConsoleRequestListener — telemetry is optional", () => {
  test("with no telemetry option supplied, the request completes normally and nothing throws", async () => {
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
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res, written } = createRecordingServerResponse();

    expect(() => {
      listener(req, res);
    }).not.toThrow();
    await logged;

    expect(written.status).toBe(200);
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest's outcome is a total function of the response status", () => {
  test.each<[number, string]>([
    [100, "1xx"],
    [301, "3xx"],
    [599, "5xx"],
    [50, "other"],
    [700, "other"],
  ])("status %i maps to outcome %s", async (status, expectedOutcome) => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => ({ status, headers: {}, body: "ok" }),
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(httpRequestCalls[0]?.outcome).toBe(expectedOutcome);
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest is called LAST in the tail, unguarded", () => {
  test("a recorder whose httpRequest throws still leaves the response written and the outcome line logged", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder(
      () => {
        throw new Error("telemetry recorder exploded");
      },
    );
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;
    await flushMicrotasks();

    expect(httpRequestCalls).toHaveLength(1);
    expect(written.status).toBe(200);
    expect(events.some((event) => event.message.includes(" -> 200"))).toBe(
      true,
    );
  });
});

describe("createConsoleRequestListener — telemetry.httpRequest's latencyMs is a non-negative safe integer", () => {
  test("latencyMs is Number.isSafeInteger and >= 0", async () => {
    const { logger, logged } = createResolvingLogger();
    const { telemetry, httpRequestCalls } = createCapturingTelemetryRecorder();
    let current = 0;
    const now = (): number => current;
    const router = createRouter([
      route({
        method: "GET",
        path: "/api/v1/runs",
        handler: () => {
          current = 5;
          return { status: 200, headers: {}, body: "ok" };
        },
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      now,
      telemetry,
    });
    const req = createFakeIncomingMessage({ url: "/api/v1/runs" });
    const { res } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    const latencyMs = httpRequestCalls[0]?.latencyMs;
    expect(latencyMs).toBeDefined();
    expect(Number.isSafeInteger(latencyMs)).toBe(true);
    expect(latencyMs).toBeGreaterThanOrEqual(0);
  });
});
