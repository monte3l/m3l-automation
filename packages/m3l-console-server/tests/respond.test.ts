/**
 * Tests for src/http/respond.ts — `jsonResponse` and `writeResponse`
 * (m3l-console-server X2b contract, wave 1).
 *
 * `writeResponse` is exercised against a real ephemeral loopback
 * `node:http` server rather than a hand-built `ServerResponse` double — the
 * contract's own File 7 (`handler.ts`) test guidance sanctions this pattern
 * for this package ("use node:http against an ephemeral loopback server"),
 * and it avoids pinning the test to whichever internal call shape
 * (`writeHead` vs `setHeader`+`end`) the implementer picks. The client side
 * uses `node:http`'s own `request`, never the banned bare `fetch()`
 * (`no-restricted-syntax` in `eslint.config.js`).
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { jsonResponse, writeResponse } from "../src/http/respond.js";

/** The header `writeResponse` echoes the correlation id under. */
const CORRELATION_ID_HEADER = "x-correlation-id";

/** A captured client-side view of an HTTP response. */
interface CapturedResponse {
  readonly status: number;
  readonly headers: Readonly<NodeJS.Dict<string | string[]>>;
  readonly body: string;
}

/** Issues a single GET against `baseUrl` using node:http's own client. */
function requestOnce(baseUrl: string): Promise<CapturedResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(baseUrl, (res) => {
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

describe("jsonResponse", () => {
  test("serializes the payload with Core.safeJsonStringify and sets a UTF-8 JSON content-type", () => {
    const payload = { ok: true, count: 3 };

    const response = jsonResponse(200, payload);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.body).toBe(Core.safeJsonStringify(payload));
    expect(JSON.parse(response.body)).toEqual(payload);
  });

  test("merges caller-supplied headers alongside the content-type", () => {
    const response = jsonResponse(201, { id: "abc" }, { "x-custom": "yes" });

    expect(response.headers["x-custom"]).toBe("yes");
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
  });

  test("serializes a value safeJsonStringify handles specially (BigInt) without throwing", () => {
    const response = jsonResponse(200, { big: 10n });

    expect(() => {
      JSON.parse(response.body);
    }).not.toThrow();
  });
});

describe("writeResponse — happy path over a real loopback server", () => {
  test("writes status, headers, and the JSON body", async () => {
    await withServer(
      (_req, res) => {
        writeResponse(res, jsonResponse(201, { ok: true }), "corr-abc");
      },
      async (baseUrl) => {
        const response = await requestOnce(baseUrl);

        expect(response.status).toBe(201);
        expect(response.headers["content-type"]).toBe(
          "application/json; charset=utf-8",
        );
        expect(response.headers[CORRELATION_ID_HEADER]).toBe("corr-abc");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(JSON.parse(response.body)).toEqual({ ok: true });
      },
    );
  });
});

describe("writeResponse — nosniff and no-store are unconditional", () => {
  test("sets x-content-type-options: nosniff and cache-control: no-store even when caller-supplied headers try to override them", async () => {
    const response = jsonResponse(
      200,
      { ok: true },
      {
        "cache-control": "max-age=3600",
        "x-content-type-options": "sniff-anyway",
      },
    );

    await withServer(
      (_req, res) => {
        writeResponse(res, response, "corr-headers");
      },
      async (baseUrl) => {
        const captured = await requestOnce(baseUrl);

        expect(captured.headers["x-content-type-options"]).toBe("nosniff");
        expect(captured.headers["cache-control"]).toBe("no-store");
      },
    );
  });
});

describe("writeResponse — content-length is a byte length", () => {
  test("sets content-length to the UTF-8 byte length, not the string length, for a multi-byte body", async () => {
    const payload = { message: "café 🎉" };

    await withServer(
      (_req, res) => {
        writeResponse(res, jsonResponse(200, payload), "corr-multi");
      },
      async (baseUrl) => {
        const response = await requestOnce(baseUrl);
        const expectedByteLength = Buffer.byteLength(response.body, "utf8");

        // Proves this fixture is genuinely multi-byte — a naive
        // `body.length` (UTF-16 code units) would NOT equal the byte
        // length here, so the assertion below actually discriminates.
        expect(response.body.length).not.toBe(expectedByteLength);

        expect(response.headers["content-length"]).toBe(
          String(expectedByteLength),
        );
      },
    );
  });
});

describe("writeResponse — no-op on an already-finished response", () => {
  test("does not throw and does not clobber a response that has already ended", async () => {
    await withServer(
      (_req, res) => {
        res.end("already-done");
        expect(() =>
          writeResponse(res, jsonResponse(200, { ignored: true }), "corr-x"),
        ).not.toThrow();
      },
      async (baseUrl) => {
        const response = await requestOnce(baseUrl);
        expect(response.body).toBe("already-done");
      },
    );
  });

  test("does not throw and does not write when headers were already sent but the response has not ended", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        expect(() =>
          writeResponse(res, jsonResponse(200, { ignored: true }), "corr-y"),
        ).not.toThrow();
        res.end("manual-end");
      },
      async (baseUrl) => {
        const response = await requestOnce(baseUrl);
        expect(response.headers["content-type"]).toBe("text/plain");
        expect(response.body).toBe("manual-end");
      },
    );
  });
});
