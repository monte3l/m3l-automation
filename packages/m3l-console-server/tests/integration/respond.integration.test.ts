/**
 * Integration test for src/http/respond.ts — the one guarantee that
 * genuinely needs a real loopback `node:http` server rather than a
 * `ServerResponse` double: that `content-length` is byte-accurate once
 * actually written to and read back off the wire (see
 * `vitest.integration.config.ts`). A double that merely records the
 * `writeHead` argument (as `tests/respond.test.ts` does) proves
 * `writeResponse` COMPUTES the right number, but not that the real
 * transport actually delivers that many bytes — a naive `body.length`
 * (UTF-16 code units, not bytes) would pass every unit assertion on an
 * ASCII-only fixture and corrupt any multi-byte response the moment a real
 * client tries to read exactly `content-length` bytes.
 *
 * The client side uses `node:http`'s own `request` — bare `fetch()` is
 * banned in tests (`no-restricted-syntax`, eslint.config.js).
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { jsonResponse, writeResponse } from "../../src/http/respond.js";

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

describe("writeResponse — content-length is a byte length, proven over a real socket", () => {
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
