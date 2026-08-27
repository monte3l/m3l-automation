/**
 * Tests for src/http/envelope.ts — `httpStatusForCode`, `errorEnvelope`, and
 * `errorResponse` (m3l-console-server X2b/X2c/X3-A1 contract).
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

/** One code's expected classification, mirroring `ErrorClassification`. */
interface ExpectedClassification {
  readonly status: number;
  readonly origin: Core.M3LErrorOrigin;
  readonly retryable: Core.M3LErrorRetryable;
  readonly fault: boolean;
}

/**
 * The documented code -> classification table (X2b/X2c/X3-A1), typed as a
 * `Record` keyed by the full `M3LConsoleErrorCode` union so a missing row is
 * a compile error here too — the same exhaustiveness discipline
 * `CLASSIFICATION_BY_CODE` itself uses. Every `test.each` block below is
 * derived from this single table via `CLASSIFICATION_ENTRIES`, so the next
 * code addition fails to compile in this file instead of silently going
 * unexercised.
 *
 * Two divergences between `retryable` and `fault` exist, in opposite
 * directions: `ERR_CONSOLE_UNAVAILABLE` is `retryable: true, fault: false` (a
 * drain refusal — expected shutdown, not a fault); `ERR_CONSOLE_STORE_BUSY`
 * is `retryable: true, fault: true` (a `SQLITE_BUSY` that survived the busy
 * handler means ADR-0069's single-writer invariant broke — genuinely
 * retryable, and genuinely worth an error-level line). See the dedicated
 * divergence tests below for both.
 */
const CLASSIFICATION_TABLE: Record<
  M3LConsoleErrorCode,
  ExpectedClassification
> = {
  ERR_CONSOLE_BAD_REQUEST: {
    status: 400,
    origin: "caller",
    retryable: false,
    fault: false,
  },
  ERR_CONSOLE_UNAUTHENTICATED: {
    status: 401,
    origin: "caller",
    retryable: false,
    fault: false,
  },
  ERR_CONSOLE_NOT_FOUND: {
    status: 404,
    origin: "caller",
    retryable: false,
    fault: false,
  },
  ERR_CONSOLE_METHOD_NOT_ALLOWED: {
    status: 405,
    origin: "caller",
    retryable: false,
    fault: false,
  },
  ERR_CONSOLE_CONFIG_INVALID: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_INTERNAL: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_ROUTE_CONFLICT: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_DRAIN_FAILED: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_LISTEN_FAILED: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_UNAVAILABLE: {
    status: 503,
    origin: "library",
    retryable: true,
    fault: false,
  },
  ERR_CONSOLE_STORE_UNSUPPORTED: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_STORE_OPEN_FAILED: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_STORE_QUERY_FAILED: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_STORE_BUSY: {
    status: 503,
    origin: "library",
    retryable: true,
    fault: true,
  },
  ERR_CONSOLE_STORE_CLOSED: {
    status: 503,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_STORE_MIGRATION_FAILED: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_STORE_SCHEMA_DRIFT: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
  ERR_CONSOLE_RUN_NOT_FOUND: {
    status: 404,
    origin: "caller",
    retryable: false,
    fault: false,
  },
  ERR_CONSOLE_RUN_TRANSITION_INVALID: {
    status: INTERNAL_STATUS,
    origin: "library",
    retryable: false,
    fault: true,
  },
};

// `Object.entries` widens the key to `string`; `CLASSIFICATION_TABLE`'s
// `Record` type already guarantees its keys are exhaustively
// `M3LConsoleErrorCode` (a missing/extra key is a compile error at the
// declaration above), so this cast only restores that narrowing — it does
// not weaken any check the `Record` type performs.
const CLASSIFICATION_ENTRIES = Object.entries(CLASSIFICATION_TABLE) as [
  M3LConsoleErrorCode,
  ExpectedClassification,
][];

const NON_FAULT_CODES = CLASSIFICATION_ENTRIES.filter(
  ([, expected]) => !expected.fault,
).map(([code]) => code);
const FAULT_CODES = CLASSIFICATION_ENTRIES.filter(
  ([, expected]) => expected.fault,
).map(([code]) => code);

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
  test.each(CLASSIFICATION_ENTRIES)(
    "maps %s to status %i",
    (code, expected) => {
      expect(httpStatusForCode(code)).toBe(expected.status);
    },
  );
});

describe("errorEnvelope — M3LConsoleError", () => {
  test.each(CLASSIFICATION_ENTRIES)(
    "uses the mapped status, the error's own code, and the error's own message for %s",
    (code, expected) => {
      const error = new M3LConsoleError(code, `failure detail for ${code}`);

      const envelope = errorEnvelope(error, "corr-1");

      expect(envelope.error.code).toBe(code);
      expect(envelope.error.message).toBe(`failure detail for ${code}`);
      expect(envelope.error.status).toBe(expected.status);
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
  test.each(CLASSIFICATION_ENTRIES)(
    "classifies %s with the mapped origin/retryable, both keys present",
    (code, expected) => {
      const error = new M3LConsoleError(code, "message");

      const envelope = errorEnvelope(error, "corr-classification");

      expect(envelope.error.origin).toBe(expected.origin);
      expect(envelope.error.retryable).toBe(expected.retryable);
      expect(Object.hasOwn(envelope.error, "origin")).toBe(true);
      expect(Object.hasOwn(envelope.error, "retryable")).toBe(true);
    },
  );
});

describe("errorEnvelope — ERR_CONSOLE_STORE_BUSY diverges from ERR_CONSOLE_UNAVAILABLE", () => {
  // ERR_CONSOLE_UNAVAILABLE is retryable:true, fault:false (a drain refusal —
  // expected shutdown, the caller did nothing wrong and the server isn't
  // malfunctioning). ERR_CONSOLE_STORE_BUSY diverges the OTHER way: a
  // SQLITE_BUSY that survived the busy handler means ADR-0069's
  // single-writer invariant is broken — genuinely retryable (a later attempt
  // may find the writer free again) AND genuinely a fault worth an
  // error-level diagnostic line, unlike an ordinary drain.
  test("[origin/retryable/fault divergence] is retryable=true AND fault=true, unlike ERR_CONSOLE_UNAVAILABLE's fault=false", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_STORE_BUSY",
      "SQLITE_BUSY persisted past the busy handler timeout",
    );

    const envelope = errorEnvelope(error, "corr-store-busy");

    expect(envelope.error.status).toBe(503);
    expect(envelope.error.origin).toBe("library");
    expect(envelope.error.retryable).toBe(true);
    expect(isFaultError(error)).toBe(true);
  });
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
  // Derived from CLASSIFICATION_TABLE via NON_FAULT_CODES/FAULT_CODES, so a
  // new code's fault decision is exercised here automatically. Every
  // caller-origin row is `fault: false`, and so is ERR_CONSOLE_UNAVAILABLE
  // (library-origin but not a fault); every other row, plus a non-console
  // value, is a fault — including ERR_CONSOLE_STORE_BUSY, whose divergence
  // from ERR_CONSOLE_UNAVAILABLE is covered by a dedicated test above.
  test.each(NON_FAULT_CODES)(
    "returns false for the non-fault code %s",
    (code) => {
      expect(isFaultError(new M3LConsoleError(code, "message"))).toBe(false);
    },
  );

  test.each(FAULT_CODES)("returns true for the fault code %s", (code) => {
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
