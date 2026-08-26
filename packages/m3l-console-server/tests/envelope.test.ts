/**
 * Tests for src/http/envelope.ts — `httpStatusForCode`, `errorEnvelope`, and
 * `errorResponse` (m3l-console-server X2b contract, wave 1).
 *
 * Security-critical: only an `M3LConsoleError`'s own message ever reaches
 * the envelope. Every other value — a foreign `Core.M3LError`, a plain
 * `Error`, a string, `null` — must collapse to the fixed generic message,
 * never the original text, and no `stack` may ever appear in the serialized
 * body.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  errorEnvelope,
  errorResponse,
  httpStatusForCode,
  isFaultError,
} from "../src/http/envelope.js";
import type { M3LConsoleErrorEnvelope } from "../src/http/envelope.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleErrorCode } from "../src/errors/console-error.js";

/** The fixed generic message every non-M3LConsoleError value collapses to. */
const GENERIC_MESSAGE = "An unexpected error occurred.";
/** The status every non-M3LConsoleError value maps to. */
const INTERNAL_STATUS = 500;

/** The documented code -> HTTP status table from the X2b/X2c contract. */
const STATUS_TABLE: readonly (readonly [M3LConsoleErrorCode, number])[] = [
  ["ERR_CONSOLE_BAD_REQUEST", 400],
  ["ERR_CONSOLE_UNAUTHENTICATED", 401],
  ["ERR_CONSOLE_NOT_FOUND", 404],
  ["ERR_CONSOLE_METHOD_NOT_ALLOWED", 405],
  ["ERR_CONSOLE_CONFIG_INVALID", INTERNAL_STATUS],
  ["ERR_CONSOLE_INTERNAL", INTERNAL_STATUS],
  ["ERR_CONSOLE_ROUTE_CONFLICT", INTERNAL_STATUS],
  ["ERR_CONSOLE_DRAIN_FAILED", INTERNAL_STATUS],
  ["ERR_CONSOLE_LISTEN_FAILED", INTERNAL_STATUS],
  ["ERR_CONSOLE_UNAVAILABLE", 503],
];

/**
 * The documented code -> classified origin/retryable table (X2b/X2c): every
 * code a caller-triggered failure (4xx) classifies as `"caller"`; every
 * library-side failure (the remaining 500s) classifies as `"library"`.
 * `ERR_CONSOLE_UNAVAILABLE` is the first row whose `retryable` is not
 * `false` — it is `origin: "library"` (the caller did nothing wrong) but
 * `retryable: true` (a drained server can succeed on a later attempt).
 * Every other code is `retryable: false`.
 */
const ORIGIN_TABLE: readonly (readonly [
  M3LConsoleErrorCode,
  Core.M3LErrorOrigin,
  Core.M3LErrorRetryable,
])[] = [
  ["ERR_CONSOLE_BAD_REQUEST", "caller", false],
  ["ERR_CONSOLE_UNAUTHENTICATED", "caller", false],
  ["ERR_CONSOLE_NOT_FOUND", "caller", false],
  ["ERR_CONSOLE_METHOD_NOT_ALLOWED", "caller", false],
  ["ERR_CONSOLE_CONFIG_INVALID", "library", false],
  ["ERR_CONSOLE_INTERNAL", "library", false],
  ["ERR_CONSOLE_ROUTE_CONFLICT", "library", false],
  ["ERR_CONSOLE_DRAIN_FAILED", "library", false],
  ["ERR_CONSOLE_LISTEN_FAILED", "library", false],
  ["ERR_CONSOLE_UNAVAILABLE", "library", true],
];

/** Recursively asserts no object in `value`'s graph carries a `stack` key. */
function assertNoStackKey(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoStackKey(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      expect(key).not.toBe("stack");
      assertNoStackKey(nested);
    }
  }
}

describe("httpStatusForCode", () => {
  test.each(STATUS_TABLE)("maps %s to status %i", (code, status) => {
    expect(httpStatusForCode(code)).toBe(status);
  });
});

describe("errorEnvelope — M3LConsoleError", () => {
  test.each(STATUS_TABLE)(
    "uses the mapped status, the error's own code, and the error's own message for %s",
    (code, status) => {
      const error = new M3LConsoleError(code, `failure detail for ${code}`);

      const envelope = errorEnvelope(error, "corr-1");

      expect(envelope.error.code).toBe(code);
      expect(envelope.error.message).toBe(`failure detail for ${code}`);
      expect(envelope.error.status).toBe(status);
      expect(envelope.error.correlationId).toBe("corr-1");
    },
  );

  test("never includes a stack key in the serialized envelope", () => {
    const error = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "boom");

    const envelope = errorEnvelope(error, "corr-3");

    assertNoStackKey(envelope);
  });
});

describe("errorEnvelope — classified origin/retryable per code (always defined via CLASSIFICATION_BY_CODE)", () => {
  test.each(ORIGIN_TABLE)(
    "classifies %s as origin=%s, retryable=%s, with both keys present",
    (code, origin, retryable) => {
      const error = new M3LConsoleError(code, "message");

      const envelope = errorEnvelope(error, "corr-classification");

      expect(envelope.error.origin).toBe(origin);
      expect(envelope.error.retryable).toBe(retryable);
      expect(Object.hasOwn(envelope.error, "origin")).toBe(true);
      expect(Object.hasOwn(envelope.error, "retryable")).toBe(true);
    },
  );
});

describe("classificationForCode — fallback for a code outside the union", () => {
  test("falls back to the internal/library/non-retryable classification when code defeats the compile-time exhaustiveness check", () => {
    // A cast is required to construct this: no real M3LConsoleErrorCode
    // reaches this path at compile time. This models a boundary that
    // decoded an external value into M3LConsoleError without validating it
    // against the union first — the runtime guard against `writeHead(undefined)`.
    const offUnionCode =
      "ERR_CONSOLE_NOT_A_REAL_CODE" as unknown as M3LConsoleErrorCode;
    const error = new M3LConsoleError(offUnionCode, "boom");

    expect(httpStatusForCode(offUnionCode)).toBe(INTERNAL_STATUS);

    const envelope = errorEnvelope(error, "corr-fallback");

    expect(envelope.error.status).toBe(INTERNAL_STATUS);
    expect(envelope.error.origin).toBe("library");
    expect(envelope.error.retryable).toBe(false);
  });
});

describe("classificationForCode — a code naming an inherited Object.prototype member", () => {
  // Before the `Object.hasOwn` fix, a `code` that happens to name an
  // inherited `Object.prototype` member (e.g. `"toString"`) resolved via
  // plain bracket access to that prototype FUNCTION rather than `undefined`
  // — and a function is never `null`/`undefined`, so a `??` lookup would
  // never fall back to `FALLBACK_CLASSIFICATION`. The result was a
  // classification with an `undefined` `status`, which reaches
  // `res.writeHead(undefined)` and hangs the socket — exactly the failure
  // `FALLBACK_CLASSIFICATION` exists to prevent. `Object.hasOwn` closes this:
  // every one of these off-union codes now falls back cleanly.
  test.each<string>([
    "constructor",
    "toString",
    "valueOf",
    "__proto__",
    "hasOwnProperty",
  ])(
    "falls back to the internal/library classification for the prototype-key code %s",
    (prototypeKeyCode) => {
      const offUnionCode = prototypeKeyCode as unknown as M3LConsoleErrorCode;
      const error = new M3LConsoleError(offUnionCode, "boom");

      expect(httpStatusForCode(offUnionCode)).toBe(INTERNAL_STATUS);
      expect(isFaultError(error)).toBe(true);

      const envelope = errorEnvelope(error, "corr-proto");
      expect(envelope.error.status).toBe(INTERNAL_STATUS);
      expect(envelope.error.origin).toBe("library");
      expect(envelope.error.retryable).toBe(false);
    },
  );

  test("a real code is unaffected: ERR_CONSOLE_NOT_FOUND still classifies as 404/caller", () => {
    const error = new M3LConsoleError("ERR_CONSOLE_NOT_FOUND", "not found");

    expect(httpStatusForCode("ERR_CONSOLE_NOT_FOUND")).toBe(404);
    expect(isFaultError(error)).toBe(false);

    const envelope = errorEnvelope(error, "corr-real");
    expect(envelope.error.status).toBe(404);
    expect(envelope.error.origin).toBe("caller");
  });
});

describe("errorEnvelope — any other value collapses to the fixed generic message", () => {
  test("a foreign Core.M3LError never leaks its own message, but may still carry a classified origin/retryable", () => {
    const foreign = new Core.M3LError(
      "do not leak this secret path /etc/shadow",
      { code: "ERR_CONFIG_MISSING" },
    );
    const classification = Core.classifyErrorCode(foreign.code);
    // ERR_CONFIG_MISSING is a real, classified m3l-common code — otherwise
    // this test would not actually exercise the "may still supply
    // origin/retryable" branch the contract describes.
    expect(classification).toEqual({ origin: "caller", retryable: false });

    const envelope = errorEnvelope(foreign, "corr-4");

    expect(envelope.error.code).toBe("ERR_CONSOLE_INTERNAL");
    expect(envelope.error.status).toBe(INTERNAL_STATUS);
    expect(envelope.error.message).toBe(GENERIC_MESSAGE);
    expect(envelope.error.message).not.toContain("secret");
    expect(envelope.error.correlationId).toBe("corr-4");
    if (envelope.error.origin !== undefined) {
      expect(envelope.error.origin).toBe(classification?.origin);
    }
    if (envelope.error.retryable !== undefined) {
      expect(envelope.error.retryable).toBe(classification?.retryable);
    }
  });

  test("a foreign Core.M3LError with an unclassifiable code omits origin/retryable entirely", () => {
    const foreign = new Core.M3LError("message", {
      code: "ERR_TOTALLY_MADE_UP_NOT_IN_CATALOG",
    });
    expect(Core.classifyErrorCode(foreign.code)).toBeUndefined();

    const envelope = errorEnvelope(foreign, "corr-5");

    expect(envelope.error.code).toBe("ERR_CONSOLE_INTERNAL");
    expect(Object.hasOwn(envelope.error, "origin")).toBe(false);
    expect(Object.hasOwn(envelope.error, "retryable")).toBe(false);
  });

  test("a plain Error carrying a secret-looking message never reaches the envelope", () => {
    const error = new Error("AWS_SECRET_ACCESS_KEY=abcd1234 leaked");

    const envelope = errorEnvelope(error, "corr-6");

    expect(envelope.error.code).toBe("ERR_CONSOLE_INTERNAL");
    expect(envelope.error.status).toBe(INTERNAL_STATUS);
    expect(envelope.error.message).toBe(GENERIC_MESSAGE);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(serialized).not.toContain("abcd1234");
  });

  test.each<[string, unknown]>([
    ["a string", "raw thrown string carrying a secret token xyz"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
  ])(
    "%s produces the fixed generic message and ERR_CONSOLE_INTERNAL",
    (_label, value) => {
      const envelope = errorEnvelope(value, "corr-7");

      expect(envelope.error.code).toBe("ERR_CONSOLE_INTERNAL");
      expect(envelope.error.status).toBe(INTERNAL_STATUS);
      expect(envelope.error.message).toBe(GENERIC_MESSAGE);
      expect(envelope.error.correlationId).toBe("corr-7");
    },
  );

  test("never getErrorMessage()'s a plain Error's text into the message (would leak a path/token fragment)", () => {
    const error = new Error("s3://my-bucket/private/token-abc123.csv");

    const envelope = errorEnvelope(error, "corr-8");

    expect(envelope.error.message).toBe(GENERIC_MESSAGE);
    expect(envelope.error.message).not.toContain("my-bucket");
  });
});

describe("errorResponse", () => {
  test("builds an M3LConsoleResponse whose status and JSON body match errorEnvelope", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_NOT_FOUND",
      "route not found",
    );

    const response = errorResponse(error, "corr-9");
    const envelope = errorEnvelope(error, "corr-9");

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual(envelope);
  });

  test("never includes a stack key in the serialized body, for an M3LConsoleError", () => {
    const error = new M3LConsoleError("ERR_CONSOLE_INTERNAL", "boom");

    const response = errorResponse(error, "corr-10");

    assertNoStackKey(JSON.parse(response.body));
  });

  test("never includes a stack key in the serialized body, for a plain Error", () => {
    const error = new Error("plain failure with a real stack trace");

    const response = errorResponse(error, "corr-11");

    assertNoStackKey(JSON.parse(response.body));
    expect(response.body).not.toContain(
      "plain failure with a real stack trace",
    );
  });

  test("ERR_CONSOLE_UNAVAILABLE builds a 503 response whose envelope is origin=library, retryable=true", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_UNAVAILABLE",
      "the server is draining",
    );

    const response = errorResponse(error, "corr-12");
    const parsed: unknown = JSON.parse(response.body);

    expect(response.status).toBe(503);
    expect(parsed).toMatchObject({
      error: {
        code: "ERR_CONSOLE_UNAVAILABLE",
        status: 503,
        origin: "library",
        retryable: true,
      },
    });
  });
});

describe("isFaultError", () => {
  // isFaultError replaces isCallerOriginError with the inverted sense, gated
  // on ErrorClassification's new `fault` field rather than on `origin`.
  // Every caller-origin row is `fault: false`, and so is
  // ERR_CONSOLE_UNAVAILABLE (library-origin but not a fault — see the
  // dedicated divergence test below); every other row, plus a non-console
  // value, is a fault.
  test.each<M3LConsoleErrorCode>([
    "ERR_CONSOLE_BAD_REQUEST",
    "ERR_CONSOLE_UNAUTHENTICATED",
    "ERR_CONSOLE_NOT_FOUND",
    "ERR_CONSOLE_METHOD_NOT_ALLOWED",
    "ERR_CONSOLE_UNAVAILABLE",
  ])("returns false for the non-fault code %s", (code) => {
    expect(isFaultError(new M3LConsoleError(code, "message"))).toBe(false);
  });

  test.each<M3LConsoleErrorCode>([
    "ERR_CONSOLE_CONFIG_INVALID",
    "ERR_CONSOLE_INTERNAL",
    "ERR_CONSOLE_ROUTE_CONFLICT",
    "ERR_CONSOLE_DRAIN_FAILED",
    "ERR_CONSOLE_LISTEN_FAILED",
  ])("returns true for the fault code %s", (code) => {
    expect(isFaultError(new M3LConsoleError(code, "message"))).toBe(true);
  });

  test("returns true for a foreign Core.M3LError", () => {
    const foreign = new Core.M3LError("boom", { code: "ERR_CONFIG_MISSING" });
    expect(isFaultError(foreign)).toBe(true);
  });

  test("returns true for a plain Error", () => {
    expect(isFaultError(new Error("boom"))).toBe(true);
  });

  test("returns true for a thrown string", () => {
    expect(isFaultError("boom")).toBe(true);
  });

  test("returns true for null", () => {
    expect(isFaultError(null)).toBe(true);
  });

  test("returns true for undefined", () => {
    expect(isFaultError(undefined)).toBe(true);
  });

  // THE KEY REGRESSION TEST: origin and fault genuinely disagree for
  // ERR_CONSOLE_UNAVAILABLE. Fails if `fault` is ever folded back into
  // `origin` (i.e. if isFaultError is reimplemented as `origin !== "library"`
  // or similar) — that reimplementation would report `true` here, emitting
  // an error-level diagnostic line for every request refused during an
  // ordinary drain-triggered shutdown.
  test("[origin vs fault divergence] ERR_CONSOLE_UNAVAILABLE is origin=library yet not a fault", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_UNAVAILABLE",
      "the server is draining",
    );

    const envelope = errorEnvelope(error, "corr-unavailable");

    expect(envelope.error.origin).toBe("library");
    expect(isFaultError(error)).toBe(false);
  });
});

describe("M3LConsoleErrorEnvelope", () => {
  test("has the exact shape the contract declares", () => {
    expectTypeOf<M3LConsoleErrorEnvelope>().toEqualTypeOf<{
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly status: number;
        readonly correlationId: string;
        readonly origin?: Core.M3LErrorOrigin;
        readonly retryable?: Core.M3LErrorRetryable;
      };
    }>();
  });
});
