/**
 * Tests for src/http/respond.ts — `jsonResponse` and `writeResponse`
 * (m3l-console-server X2b contract, wave 1).
 *
 * `writeResponse` is exercised against a recording `ServerResponse` double
 * rather than a real loopback `node:http` server — a double is sufficient
 * to prove which arguments `writeResponse` passes to `writeHead`/`end` and
 * to drive its no-op guard branches deterministically. The one guarantee
 * that genuinely needs a real socket — that the `content-length` header is
 * byte-accurate once actually written to the wire, for a multi-byte body —
 * lives in `tests/integration/respond.integration.test.ts` instead (see
 * `vitest.integration.config.ts`).
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { jsonResponse, writeResponse } from "../src/http/respond.js";

/** The header `writeResponse` echoes the correlation id under. */
const CORRELATION_ID_HEADER = "x-correlation-id";

/** What `writeResponse` actually wrote onto a {@link createRecordingServerResponse} double. */
interface RecordedWrite {
  status?: number;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
}

/**
 * Builds a `ServerResponse` double that records the arguments its
 * `writeHead`/`end` calls receive, and flips `headersSent`/`writableEnded`
 * the way a real `node:http` response would — so `writeResponse`'s no-op
 * guards behave identically to the real thing.
 */
function createRecordingServerResponse(
  overrides: Partial<{
    readonly writableEnded: boolean;
    readonly headersSent: boolean;
  }> = {},
): {
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
    ...overrides,
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

describe("writeResponse — happy path", () => {
  test("writes status, headers, and the JSON body", () => {
    const { res, written } = createRecordingServerResponse();

    writeResponse(res, jsonResponse(201, { ok: true }), "corr-abc");

    expect(written.status).toBe(201);
    expect(written.headers?.["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(written.headers?.[CORRELATION_ID_HEADER]).toBe("corr-abc");
    expect(written.headers?.["x-content-type-options"]).toBe("nosniff");
    expect(written.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(written.body ?? "")).toEqual({ ok: true });
  });

  test("sets content-length to the computed UTF-8 byte length of the body", () => {
    const payload = { message: "hello" };
    const { res, written } = createRecordingServerResponse();

    const response = jsonResponse(200, payload);
    writeResponse(res, response, "corr-len");

    expect(written.headers?.["content-length"]).toBe(
      String(Buffer.byteLength(response.body, "utf8")),
    );
  });
});

describe("writeResponse — nosniff and no-store are unconditional", () => {
  test("sets x-content-type-options: nosniff and cache-control: no-store even when caller-supplied headers try to override them", () => {
    const response = jsonResponse(
      200,
      { ok: true },
      {
        "cache-control": "max-age=3600",
        "x-content-type-options": "sniff-anyway",
      },
    );
    const { res, written } = createRecordingServerResponse();

    writeResponse(res, response, "corr-headers");

    expect(written.headers?.["x-content-type-options"]).toBe("nosniff");
    expect(written.headers?.["cache-control"]).toBe("no-store");
  });
});

describe("writeResponse — no-op on an already-finished response", () => {
  test("does not throw and does not write when the response has already ended", () => {
    const { res, written } = createRecordingServerResponse({
      writableEnded: true,
    });

    expect(() =>
      writeResponse(res, jsonResponse(200, { ignored: true }), "corr-x"),
    ).not.toThrow();
    expect(written.status).toBeUndefined();
    expect(written.body).toBeUndefined();
  });

  test("does not throw and does not write when headers were already sent but the response has not ended", () => {
    const { res, written } = createRecordingServerResponse({
      headersSent: true,
    });

    expect(() =>
      writeResponse(res, jsonResponse(200, { ignored: true }), "corr-y"),
    ).not.toThrow();
    expect(written.status).toBeUndefined();
    expect(written.body).toBeUndefined();
  });
});
