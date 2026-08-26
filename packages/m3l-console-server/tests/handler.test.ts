/**
 * Tests for src/http/handler.ts — `createConsoleRequestListener`'s per-
 * request pipeline (m3l-console-server X2b contract, wave 2).
 * `src/http/handler.ts` does not exist yet; this suite is RED until wave-2
 * implementation lands.
 *
 * Drives an ephemeral loopback `node:http` server, exactly like
 * `respond.test.ts` — bare `fetch()` is banned in tests
 * (`no-restricted-syntax`, eslint.config.js), so the client side uses
 * `node:http`'s own `request`.
 */
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { jsonResponse } from "../src/http/respond.js";
import type { M3LConsoleResponse } from "../src/http/respond.js";
import { createRouter } from "../src/http/router.js";
import type { M3LRoute, M3LRouteAuth } from "../src/http/router.js";
import { createConsoleRequestListener } from "../src/http/handler.js";
import type { M3LConsoleMiddleware } from "../src/http/middleware.js";

/** A captured client-side view of an HTTP response. */
interface CapturedResponse {
  readonly status: number;
  readonly headers: Readonly<NodeJS.Dict<string | string[]>>;
  readonly body: string;
}

/** Request options for {@link requestOnce}; defaults to a GET with no extra headers. */
interface RequestOnceOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Issues a single request against `url` using node:http's own client. */
function requestOnce(
  url: string,
  options: RequestOnceOptions = {},
): Promise<CapturedResponse> {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
    };
    const req = httpRequest(url, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Starts an ephemeral loopback server running `handler`, awaits `run` with
 * its base URL, then always tears the server down — no leaked listeners
 * between tests.
 */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a TCP AddressInfo from an ephemeral listener");
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
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
 * `headers`) plus the `once`/`removeListener` pair it uses for the
 * connection-abort seam.
 */
function createFakeIncomingMessage(
  overrides: Partial<Pick<IncomingMessage, "method" | "url" | "headers">> = {},
): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(req, {
    method: "GET",
    url: "/api/v1/runs",
    headers: {},
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
    const { logger } = createCapturingLogger();
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
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      const response = await requestOnce(`${baseUrl}/api/v1/runs`);

      expect(response.status).toBe(200);
      const parsed: unknown = JSON.parse(response.body);
      expect(parsed).toEqual({ ok: true });
    });
  });

  test("attaches matched route params via withParams before running the middleware chain", async () => {
    const { logger } = createCapturingLogger();
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
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      const response = await requestOnce(`${baseUrl}/api/v1/runs/42`);
      const parsed: unknown = JSON.parse(response.body);
      expect(parsed).toEqual({ params: { id: "42" } });
    });

    expect(paramsSeenByMiddleware).toEqual({ id: "42" });
  });
});

describe("createConsoleRequestListener — 404 and 405 envelopes", () => {
  test("returns a well-formed 404 envelope for an unmatched path", async () => {
    const { logger } = createCapturingLogger();
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      const response = await requestOnce(`${baseUrl}/nope`);

      expect(response.status).toBe(404);
      const parsed: unknown = JSON.parse(response.body);
      expect(parsed).toMatchObject({ error: { status: 404 } });
    });
  });

  test("returns a well-formed 405 envelope for a matched path with the wrong method", async () => {
    const { logger } = createCapturingLogger();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      const response = await requestOnce(`${baseUrl}/api/v1/runs`, {
        method: "DELETE",
      });

      expect(response.status).toBe(405);
      const parsed: unknown = JSON.parse(response.body);
      expect(parsed).toMatchObject({
        error: { status: 405, code: "ERR_CONSOLE_METHOD_NOT_ALLOWED" },
      });
    });
  });
});

describe("createConsoleRequestListener — a handler that throws", () => {
  test("still yields a well-formed envelope and exactly one log line", async () => {
    const { logger, events } = createCapturingLogger();
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
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      const response = await requestOnce(`${baseUrl}/boom`);

      expect(response.status).toBe(500);
      const parsed: unknown = JSON.parse(response.body);
      expect(parsed).toMatchObject({
        error: {
          code: "ERR_CONSOLE_INTERNAL",
          message: "An unexpected error occurred.",
          status: 500,
        },
      });
      expect(JSON.stringify(parsed)).not.toContain("kaboom");
    });

    expect(events).toHaveLength(1);
  });

  test("a rejected handler promise is caught the same way as a synchronous throw", async () => {
    const { logger, events } = createCapturingLogger();
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
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      const response = await requestOnce(`${baseUrl}/async-boom`);
      expect(response.status).toBe(500);
    });

    expect(events).toHaveLength(1);
  });

  test("a middleware that throws is also caught and yields a well-formed envelope", async () => {
    const { logger, events } = createCapturingLogger();
    const throwingMiddleware: M3LConsoleMiddleware = () => {
      throw new Error("middleware kaboom");
    };
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [throwingMiddleware],
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      const response = await requestOnce(`${baseUrl}/api/v1/runs`);
      expect(response.status).toBe(500);
    });

    expect(events).toHaveLength(1);
  });
});

describe("createConsoleRequestListener — log level by status class", () => {
  test("logs a 5xx at error level", async () => {
    const { logger, events } = createCapturingLogger();
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
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      await requestOnce(`${baseUrl}/boom`);
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.ERROR);
  });

  test("logs a 4xx (not-found) at warning level", async () => {
    const { logger, events } = createCapturingLogger();
    const listener = createConsoleRequestListener({
      router: createRouter([]),
      middlewares: [],
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      await requestOnce(`${baseUrl}/nope`);
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.WARNING);
  });

  test("logs a successful 2xx at info level", async () => {
    const { logger, events } = createCapturingLogger();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      await requestOnce(`${baseUrl}/api/v1/runs`);
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.INFO);
  });
});

describe("createConsoleRequestListener — log line never leaks sensitive request data", () => {
  test("never logs the query string, request headers, or an unrelated body value", async () => {
    const { logger, events } = createCapturingLogger();
    const router = createRouter([
      route({ method: "GET", path: "/api/v1/runs" }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      logger,
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      await requestOnce(`${baseUrl}/api/v1/runs?apiKey=super-secret-value`, {
        headers: { "x-secret-header": "should-not-be-logged" },
      });
    });

    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("should-not-be-logged");
    expect(serialized).not.toContain("apiKey");
  });

  test.each<M3LRouteAuth>(["required", "exempt"])(
    "logs the matched route's auth mode (%s)",
    async (auth) => {
      const { logger, events } = createCapturingLogger();
      const router = createRouter([
        route({ method: "GET", path: "/api/v1/runs", auth }),
      ]);
      const listener = createConsoleRequestListener({
        router,
        middlewares: [],
        logger,
        signal: new AbortController().signal,
      });

      await withServer(listener, async (baseUrl) => {
        await requestOnce(`${baseUrl}/api/v1/runs`);
      });

      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0])).toContain(auth);
    },
  );
});

describe("createConsoleRequestListener — the abort seam is live", () => {
  test("aborting the drain signal aborts the in-flight request's ctx.signal", async () => {
    const { logger } = createCapturingLogger();
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
      logger,
      signal: drainController.signal,
    });

    await withServer(listener, async (baseUrl) => {
      const responsePromise = requestOnce(`${baseUrl}/slow`);
      await received;
      drainController.abort();
      await responsePromise;
    });

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

  test("the connection-abort listener no-ops once the response has already finished", async () => {
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
        logger,
        signal: new AbortController().signal,
      });
      listener(req, res);
    });

    await dispatchStarted;
    req.emit("close");
    resolveDispatch({ status: 200, headers: {}, body: "done" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(observedAborted).toBeUndefined();
  });
});

describe("createConsoleRequestListener — the outer safety net", () => {
  test("logs and swallows a failure outside runRequest's own try/catch instead of letting it become an unhandled rejection", async () => {
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
      logger,
      signal: new AbortController().signal,
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
