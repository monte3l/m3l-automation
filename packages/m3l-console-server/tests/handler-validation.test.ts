/**
 * Tests for src/http/handler.ts — TRANSPORT-LEVEL request validation that
 * rejects a request before it is ever dispatched (m3l-console-server X2b
 * contract, wave 2).
 *
 * Split out of `handler.test.ts` (ADR-0072): that file pins the request-
 * pipeline mechanics (context creation, dispatch, logging, response writing,
 * the abort seam, the two middleware chains); this file is the distinct
 * concern of requests rejected at the seam, before routing ever runs — a
 * request target that fails to parse, and a request carrying duplicate
 * `Host` headers (RFC 9110 §7.2). Every case here drives
 * `createConsoleRequestListener`'s returned listener directly against
 * `IncomingMessage`/`ServerResponse` doubles — never a real loopback
 * `node:http` server.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createRouter } from "../src/http/router.js";
import type { M3LRoute } from "../src/http/router.js";
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

describe("createConsoleRequestListener — a request whose target fails to parse never logs the raw target (S1)", () => {
  // `parseRequestUrl` (context.ts) runs `new URL(rawUrl, "http://localhost")`
  // directly against `req.url` — a plain string per Node's `http` contract —
  // so a malformed target is reproduced by setting the fake
  // `IncomingMessage.url` directly, with no real socket/client involved at
  // all (verified against the source: this is a more direct reproduction
  // than routing a malformed request-line through an actual TCP connection).
  test.each<string>(["http://[", "http://%zz/", "//"])(
    "logs the fixed placeholder path, never the raw target or its query string, and pins the caller-origin diagnostic gate, for %s",
    async (rawTarget) => {
      const { logger, events, logged } = createResolvingLogger();
      const listener = createConsoleRequestListener({
        router: createRouter([]),
        middlewares: [],
        preRouting: [],
        logger,
        signal: new AbortController().signal,
      });
      const canaryTarget = `${rawTarget}${rawTarget.includes("?") ? "&" : "?"}token=CANARY123`;
      const req = createFakeIncomingMessage({ url: canaryTarget });
      const { res, written } = createRecordingServerResponse();

      listener(req, res);
      await logged;

      expect(written.status).toBe(400);
      expect(events).toHaveLength(1);
      const serialized = JSON.stringify(events[0]);
      // The canary — and the raw target it was embedded in — must never
      // appear anywhere in the logged event: this is the exact regression
      // a raw-`req.url` seed would reintroduce.
      expect(serialized).not.toContain("CANARY123");
      expect(serialized).not.toContain(canaryTarget);
      // The `path` field is logged as the fixed placeholder, never the raw,
      // unparsed target — this literal mirrors handler.ts's own
      // PATH_PLACEHOLDER_UNPARSED constant, which is not exported.
      expect(events[0]?.data).toMatchObject({ path: "(unparsed)" });
      // Unlike the not-found path, a malformed target genuinely throws
      // (`createRequestContext` raises `ERR_CONSOLE_BAD_REQUEST`) and is
      // caught in `runRequest`'s `catch`, which calls
      // `logDiagnosticIfFault` for real. That error is caller-origin, so
      // this is what actually pins `isCallerOriginError`'s gate: removing
      // the gate would emit a second diagnostic event here.
      expect(findDiagnosticEvent(events)).toBeUndefined();
    },
  );
});

describe("createConsoleRequestListener — a request with duplicate Host headers is rejected (security audit finding)", () => {
  // MEASURED on a real (unmocked) `node:http` server on Node v26.7.0: a
  // request sending `Host: 127.0.0.1` followed by `Host: evil.example` was
  // served a 200 — `toHeaderMap` casts `req.headers`, and Node's own parser
  // keeps only the FIRST `Host` value in that map, so the second (attacker)
  // value is invisible to every downstream check, including the origin
  // guard. The reverse order (evil first, loopback second) was already
  // rejected, since the first — and only visible — value was non-loopback.
  // RFC 9110 §7.2 requires a server to reject any request whose target URI
  // is ambiguous because of more than one `Host` field-line; a duplicate is
  // detectable ONLY via `req.rawHeaders` (the alternating raw key/value
  // list), never via `req.headers`, which cannot represent a repeated key at
  // all. No real socket is used: `rawHeaders` is set directly on the fake
  // `IncomingMessage`.
  test.each<[string, string[]]>([
    [
      "loopback first, then attacker-controlled",
      ["Host", "127.0.0.1", "Host", "evil.example"],
    ],
    [
      "attacker-controlled first, then loopback",
      ["Host", "evil.example", "Host", "127.0.0.1"],
    ],
    [
      "case-insensitive duplicate ('Host' then 'host')",
      ["Host", "127.0.0.1", "host", "evil.example"],
    ],
    [
      "both values loopback — still a duplicate field-line, not a content check",
      ["Host", "127.0.0.1", "Host", "localhost"],
    ],
  ])(
    "rejects with ERR_CONSOLE_BAD_REQUEST and never runs the route handler: %s",
    async (_label, rawHeaders) => {
      const { logger, logged } = createResolvingLogger();
      let handlerRan = false;
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
        preRouting: [],
        logger,
        signal: new AbortController().signal,
      });
      const req = createFakeIncomingMessage({
        url: "/api/v1/runs",
        headers: { host: rawHeaders[1] },
        rawHeaders,
      });
      const { res, written } = createRecordingServerResponse();

      listener(req, res);
      await logged;

      expect(written.status).toBe(400);
      const parsed: unknown = JSON.parse(written.body ?? "");
      expect(parsed).toMatchObject({
        error: { code: "ERR_CONSOLE_BAD_REQUEST", status: 400 },
      });
      expect(handlerRan).toBe(false);
    },
  );

  test("a single Host header still passes through to the matched route", async () => {
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
      url: "/api/v1/runs",
      headers: { host: "127.0.0.1" },
      rawHeaders: ["Host", "127.0.0.1"],
    });
    const { res, written } = createRecordingServerResponse();

    listener(req, res);
    await logged;

    expect(written.status).toBe(200);
  });
});
