/**
 * Tests for src/http/handler.ts's REQUEST-BODY layer (X4 slice 7-pre): the
 * `maxBodyBytes` construction guard and `attachBodyIfApplicable`'s actual
 * `readJsonBody` read. Split out of `tests/handler.test.ts` purely for file
 * budget reasons (see that file's own header) — mirrors
 * `tests/handler-streaming.test.ts`'s doubles-based harness shape (a real
 * stream-capable request/response pair driven through the real listener,
 * never a real loopback `node:http` server).
 *
 * `tests/body.test.ts` already covers `readJsonBody` itself in isolation; the
 * cases here prove the seam is actually WIRED end to end through
 * `createConsoleRequestListener` — a 413/415 rejection reaching the real
 * `responseForThrownError`/envelope path, and a parsed body actually landing
 * on the route handler's `M3LRequestContext`, neither of which a unit test
 * calling `readJsonBody` directly can show.
 */
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createConsoleRequestListener } from "../src/http/handler.js";
import type { M3LRequestContext } from "../src/http/context.js";
import { jsonResponse } from "../src/http/respond.js";
import { createRouter } from "../src/http/router.js";
import type { M3LRoute } from "../src/http/router.js";

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
 * A REAL `node:stream` `Readable` standing in for `IncomingMessage` (the
 * same reasoning as `tests/body.test.ts`'s `FakeBodyRequest`: `readJsonBody`
 * attaches real `data`/`end` listeners, so a hand-rolled `EventEmitter`
 * double would prove nothing about actual chunked delivery). Serves `parts`
 * one chunk per `_read()` call; an empty `parts` array models a body-less
 * request (ends on the very first `_read()`), which is what every non-POST
 * case below uses.
 */
class FakeConsoleRequest extends Readable {
  public readonly headers: Record<string, string | undefined>;
  public readonly rawHeaders: string[];
  public readonly method: string;
  public readonly url: string;
  private served = 0;
  private readonly parts: readonly Buffer[];

  constructor(config: {
    readonly method?: string;
    readonly url?: string;
    readonly headers?: Record<string, string | undefined>;
    readonly parts?: readonly Buffer[];
  }) {
    super();
    this.method = config.method ?? "GET";
    this.url = config.url ?? "/api/v1/echo";
    this.headers = config.headers ?? {};
    this.rawHeaders = Object.entries(this.headers).flatMap(([key, value]) => [
      key,
      String(value),
    ]);
    this.parts = config.parts ?? [];
  }

  override _read(): void {
    const next = this.parts[this.served];
    if (next === undefined) {
      this.push(null);
      return;
    }
    this.served += 1;
    this.push(next);
  }
}

/** What `writeResponse` actually wrote onto a {@link createRecordingServerResponse} double. */
interface RecordedWrite {
  status?: number;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
}

/**
 * Builds a `ServerResponse` double that records the arguments its
 * `writeHead`/`end` calls receive, matching `tests/handler-validation.test.ts`'s
 * shape.
 */
function createRecordingServerResponse(): {
  readonly res: ServerResponse;
  readonly written: RecordedWrite;
} {
  const written: RecordedWrite = {};
  const res = {
    writableEnded: false,
    headersSent: false,
    writeHead(status: number, headers?: Readonly<Record<string, string>>) {
      written.status = status;
      written.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(body?: string) {
      written.body = body;
      res.writableEnded = true;
      return res;
    },
  } as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  return { res, written };
}

/** Builds a minimal `M3LRoute` whose handler reports the context it was invoked with, then returns a fixed 200 body. */
function bodyCapturingRoute(config: {
  readonly method: string;
  readonly path: string;
  readonly onCtx: (ctx: M3LRequestContext) => void;
}): M3LRoute {
  return {
    method: config.method,
    path: config.path,
    auth: "required",
    handler: (ctx) => {
      config.onCtx(ctx);
      return jsonResponse(200, { ok: true });
    },
  };
}

describe("createConsoleRequestListener — request body is attached for a body-bearing method", () => {
  test("a POST with a valid application/json body: the parsed body reaches the route handler", async () => {
    const { logger, logged } = createResolvingLogger();
    const payload = { scriptName: "hello-world", dryRun: true };
    const raw = JSON.stringify(payload);
    const req = new FakeConsoleRequest({
      method: "POST",
      url: "/api/v1/echo",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(raw, "utf8")),
      },
      parts: [Buffer.from(raw, "utf8")],
    }) as unknown as IncomingMessage;
    const { res } = createRecordingServerResponse();
    let capturedBody: unknown = "unset";
    const router = createRouter([
      bodyCapturingRoute({
        method: "POST",
        path: "/api/v1/echo",
        onCtx: (ctx) => {
          capturedBody = ctx.body;
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

    expect(capturedBody).toEqual(payload);
  });

  test("a GET request never invokes readJsonBody: the route handler sees an undefined body", async () => {
    const { logger, logged } = createResolvingLogger();
    const req = new FakeConsoleRequest({
      method: "GET",
      url: "/api/v1/echo",
    }) as unknown as IncomingMessage;
    const { res } = createRecordingServerResponse();
    let capturedBody: unknown = "unset";
    const router = createRouter([
      bodyCapturingRoute({
        method: "GET",
        path: "/api/v1/echo",
        onCtx: (ctx) => {
          capturedBody = ctx.body;
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

    expect(capturedBody).toBeUndefined();
  });
});

describe("createConsoleRequestListener — maxBodyBytes construction guard", () => {
  test.each([
    ["zero", 0],
    ["a negative value", -1],
    ["a non-integer value", 1.5],
  ])(
    "throws M3LConsoleError(ERR_CONSOLE_CONFIG_INVALID) for %s",
    (_label, maxBodyBytes) => {
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
          maxBodyBytes,
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

  test("constructs without throwing for a valid maxBodyBytes", () => {
    const { logger } = createResolvingLogger();
    const router = createRouter([]);

    expect(() =>
      createConsoleRequestListener({
        router,
        middlewares: [],
        preRouting: [],
        logger,
        signal: new AbortController().signal,
        maxBodyBytes: 1_024,
      }),
    ).not.toThrow();
  });
});

describe("createConsoleRequestListener — body-read failures surface through the real envelope", () => {
  test("an over-cap POST body surfaces as 413 with ERR_CONSOLE_BODY_TOO_LARGE", async () => {
    const { logger, logged } = createResolvingLogger();
    const raw = "x".repeat(50);
    const req = new FakeConsoleRequest({
      method: "POST",
      url: "/api/v1/echo",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(raw, "utf8")),
      },
      parts: [Buffer.from(raw, "utf8")],
    }) as unknown as IncomingMessage;
    const { res, written } = createRecordingServerResponse();
    const router = createRouter([
      bodyCapturingRoute({
        method: "POST",
        path: "/api/v1/echo",
        onCtx: () => undefined,
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      preRouting: [],
      logger,
      signal: new AbortController().signal,
      maxBodyBytes: 10,
    });

    listener(req, res);
    await logged;

    expect(written.status).toBe(413);
    const parsed: unknown = JSON.parse(written.body ?? "");
    expect(parsed).toMatchObject({
      error: { code: "ERR_CONSOLE_BODY_TOO_LARGE", status: 413 },
    });
  });

  test("a non-JSON content-type surfaces as 415 with ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE", async () => {
    const { logger, logged } = createResolvingLogger();
    const raw = "plain text body";
    const req = new FakeConsoleRequest({
      method: "POST",
      url: "/api/v1/echo",
      headers: {
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(raw, "utf8")),
      },
      parts: [Buffer.from(raw, "utf8")],
    }) as unknown as IncomingMessage;
    const { res, written } = createRecordingServerResponse();
    const router = createRouter([
      bodyCapturingRoute({
        method: "POST",
        path: "/api/v1/echo",
        onCtx: () => undefined,
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

    expect(written.status).toBe(415);
    const parsed: unknown = JSON.parse(written.body ?? "");
    expect(parsed).toMatchObject({
      error: { code: "ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE", status: 415 },
    });
  });
});
