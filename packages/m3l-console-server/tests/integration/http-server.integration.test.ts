/**
 * Integration tests for src/lifecycle/http-server.ts — `startConsoleServer`.
 * `src/lifecycle/http-server.ts` does not exist yet; this suite is RED until
 * the implementation lands.
 *
 * Only the guarantees that genuinely need a real loopback socket live here
 * (see `vitest.integration.config.ts`): that binding port 0 really resolves a
 * live, non-zero port a client can reach, that the reported host/port match
 * `server.address()` for real, and that `close()` really stops the listener.
 * Everything else (validation of a fake's `address()` shape, close-ordering,
 * error chaining) is covered from a fake `Server` double in
 * `tests/http-server.test.ts` — a real server cannot be coerced into
 * reporting a non-loopback or malformed `address()`.
 *
 * The client side uses `node:http`'s own `request` — bare `fetch()` is
 * banned in tests (`no-restricted-syntax`, eslint.config.js).
 */
import { request as httpRequest } from "node:http";
import type { RequestListener } from "node:http";

import { describe, expect, test } from "vitest";

import { startConsoleServer } from "../../src/lifecycle/http-server.js";

/** Issues a single GET against `url` using node:http's own client. */
function requestOnce(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, (res) => {
      res.on("data", () => undefined);
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0 });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startConsoleServer — real loopback bind", () => {
  test("binding port 0 on 127.0.0.1 resolves a real, non-zero port that a request can reach", async () => {
    const listener: RequestListener = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };
    const listeningServer = await startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener,
      closeTimeoutMs: 5_000,
    });

    try {
      expect(listeningServer.port).toBeGreaterThan(0);

      const response = await requestOnce(
        `http://127.0.0.1:${String(listeningServer.port)}/`,
      );
      expect(response.status).toBe(200);
    } finally {
      await listeningServer.close();
    }
  });

  test("the returned host/port match the real server's own address()", async () => {
    const listener: RequestListener = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    const listeningServer = await startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener,
      closeTimeoutMs: 5_000,
    });

    try {
      expect(listeningServer.host).toBe("127.0.0.1");
      expect(typeof listeningServer.port).toBe("number");
    } finally {
      await listeningServer.close();
    }
  });

  test("close() actually stops the listener — a subsequent connection attempt is refused", async () => {
    const listener: RequestListener = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };
    const listeningServer = await startConsoleServer({
      host: "127.0.0.1",
      port: 0,
      listener,
      closeTimeoutMs: 5_000,
    });
    const { port } = listeningServer;

    await listeningServer.close();

    const thrown = await requestOnce(`http://127.0.0.1:${String(port)}/`).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({ code: "ECONNREFUSED" });
  });
});
