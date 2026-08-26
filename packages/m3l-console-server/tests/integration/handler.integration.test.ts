/**
 * Integration tests for src/http/handler.ts — the one guarantee that
 * genuinely needs a real loopback `node:http` server rather than an
 * `IncomingMessage`/`ServerResponse` double: that a write failure inside
 * `writeResponse` really ends the socket instead of leaving the client
 * hanging (see `vitest.integration.config.ts`).
 *
 * Every other `handler.ts` scenario is covered from doubles alone in
 * `tests/handler.test.ts` (the unit run remains the sole coverage
 * authority; this project runs with coverage OFF). The client side uses
 * `node:http`'s own `request` — bare `fetch()` is banned in tests
 * (`no-restricted-syntax`, eslint.config.js).
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createRouter } from "../../src/http/router.js";
import type { M3LRoute } from "../../src/http/router.js";
import { createConsoleRequestListener } from "../../src/http/handler.js";

/** A captured client-side view of an HTTP response. */
interface CapturedResponse {
  readonly status: number;
  readonly headers: Readonly<NodeJS.Dict<string | string[]>>;
  readonly body: string;
}

/** Issues a single GET against `url` using node:http's own client. */
function requestOnce(url: string): Promise<CapturedResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, (res) => {
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

/** A no-op `M3LLoggerHandler`: these tests assert on the wire, not the log. */
function createSilentLogger(): Core.M3LLogger {
  return new Core.M3LLogger([
    { handle: () => undefined, reset: () => undefined },
  ]);
}

/** Builds a minimal `M3LRoute`, defaulting `auth`. */
function route(
  overrides: Pick<M3LRoute, "method" | "path" | "handler"> &
    Partial<Pick<M3LRoute, "auth">>,
): M3LRoute {
  return { auth: "required", ...overrides };
}

describe("createConsoleRequestListener — a real writeHead failure genuinely ends the socket", () => {
  // Pins the X2b, S3 fix against Node's REAL `ServerResponse.writeHead`
  // validation (not a double's): a route handler that echoes caller-
  // influenced content into a response header value (e.g. a route param,
  // per the fix's own reproduction) makes the primary `writeHead` throw for
  // real (`ERR_INVALID_CHAR`). Before the fix this escaped to the outer
  // `.catch`, which only logs and never touches the socket — the client
  // would hang until `server.timeout` (0 = never) or its own timeout. The
  // client here must actually receive a well-formed fallback response, not
  // hang, proving the socket was genuinely ended rather than merely
  // `res.end()` being called on a double that can't detect a leaked
  // connection.
  test("the client still receives a well-formed fallback response instead of hanging", async () => {
    const router = createRouter([
      route({
        method: "GET",
        path: "/echo/:value",
        handler: (ctx) => ({
          status: 200,
          // A CR/LF in a header value is invalid per RFC 7230 and Node's
          // real `writeHead` rejects it synchronously — a fake
          // `ServerResponse` would happily accept any string here.
          headers: { "x-echo": ctx.params["value"] ?? "" },
          body: "ok",
        }),
      }),
    ]);
    const listener = createConsoleRequestListener({
      router,
      middlewares: [],
      logger: createSilentLogger(),
      signal: new AbortController().signal,
    });

    await withServer(listener, async (baseUrl) => {
      // The malicious header value is embedded via a raw request target
      // (`%0d%0a` decodes to CR LF once the router captures the `:value`
      // param) rather than the client rejecting it up front.
      const response = await requestOnce(`${baseUrl}/echo/bad%0d%0avalue`);

      // `writeFallbackResponse` writes a bare status with no body (it is a
      // last-resort recovery, not a real envelope) — the point being proven
      // here is that the client's request genuinely completes (the `end`
      // event fires with a real status) rather than hanging on a socket
      // `writeResponse`'s throw left open.
      expect(response.status).toBe(500);
      expect(response.body).toBe("");
    });
  });
});
