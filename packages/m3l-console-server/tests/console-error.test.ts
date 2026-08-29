/**
 * Tests for src/errors/console-error.ts — the `M3LConsoleError` hierarchy
 * (m3l-console-server X2a contract).
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  isConsoleError,
  M3LConsoleError,
} from "../src/errors/console-error.js";
import type { M3LConsoleErrorCode } from "../src/errors/console-error.js";

describe("M3LConsoleErrorCode", () => {
  test("is the exact thirty-four-member union the contract declares (X2/X3-A1/X4/X6)", () => {
    expectTypeOf<M3LConsoleErrorCode>().toEqualTypeOf<
      | "ERR_CONSOLE_CONFIG_INVALID"
      | "ERR_CONSOLE_BAD_REQUEST"
      | "ERR_CONSOLE_UNAUTHENTICATED"
      | "ERR_CONSOLE_NOT_FOUND"
      | "ERR_CONSOLE_METHOD_NOT_ALLOWED"
      | "ERR_CONSOLE_ROUTE_CONFLICT"
      | "ERR_CONSOLE_INTERNAL"
      | "ERR_CONSOLE_DRAIN_FAILED"
      | "ERR_CONSOLE_LISTEN_FAILED"
      | "ERR_CONSOLE_UNAVAILABLE"
      | "ERR_CONSOLE_STORE_UNSUPPORTED"
      | "ERR_CONSOLE_STORE_OPEN_FAILED"
      | "ERR_CONSOLE_STORE_BUSY"
      | "ERR_CONSOLE_STORE_CLOSED"
      | "ERR_CONSOLE_STORE_QUERY_FAILED"
      | "ERR_CONSOLE_STORE_MIGRATION_FAILED"
      | "ERR_CONSOLE_STORE_SCHEMA_DRIFT"
      | "ERR_CONSOLE_STREAM_CLOSED"
      | "ERR_CONSOLE_STREAM_DUPLICATE"
      | "ERR_CONSOLE_RUN_NOT_FOUND"
      | "ERR_CONSOLE_RUN_TRANSITION_INVALID"
      | "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND"
      | "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED"
      | "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED"
      | "ERR_CONSOLE_BODY_TOO_LARGE"
      | "ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE"
      | "ERR_CONSOLE_SESSION_NOT_FOUND"
      | "ERR_CONSOLE_SESSION_STEP_NOT_FOUND"
      | "ERR_CONSOLE_SESSION_TRANSITION_INVALID"
      | "ERR_CONSOLE_SESSION_CLOSED"
      | "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED"
      | "ERR_CONSOLE_SESSION_REFERENCE_INVALID"
      | "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE"
      | "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT"
    >();
  });

  test("rejects an invalid code literal at the type level", () => {
    // @ts-expect-error -- "verbose" is not a member of M3LConsoleErrorCode
    const invalid: M3LConsoleErrorCode = "ERR_CONSOLE_VERBOSE";
    expect(invalid).toBeDefined();
  });
});

describe("M3LConsoleError", () => {
  test("extends Core.M3LError and Error, exposing code/name/message", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      "malformed request body",
    );

    expect(error).toBeInstanceOf(Core.M3LError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(M3LConsoleError);
    expect(error.name).toBe("M3LConsoleError");
    expect(error.code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(error.message).toBe("malformed request body");
  });

  test("round-trips an explicit context bag", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_NOT_FOUND",
      "route not found",
      { context: { path: "/api/does-not-exist" } },
    );

    expect(error.context).toEqual({ path: "/api/does-not-exist" });
  });

  test("defaults context to an empty object when not supplied", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "unexpected failure",
    );

    expect(error.context).toEqual({});
  });

  test("chains an explicit cause through to Core.M3LError's cause handling", () => {
    const cause = new Error("socket EADDRINUSE");
    const error = new M3LConsoleError(
      "ERR_CONSOLE_LISTEN_FAILED",
      "failed to bind the listening socket",
      { cause },
    );

    expect(error.cause).toBe(cause);
  });

  test("cause defaults to undefined when not supplied", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_DRAIN_FAILED",
      "graceful drain timed out",
    );

    expect(error.cause).toBeUndefined();
  });

  test("code narrows to the M3LConsoleErrorCode literal union at the type level", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_ROUTE_CONFLICT",
      "duplicate route registration",
    );

    expectTypeOf(error.code).toEqualTypeOf<M3LConsoleErrorCode>();
  });

  test("m3l-common's classifyErrorCode does not classify a console-only code (never added to M3L_ERROR_CODES)", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_UNAUTHENTICATED",
      "missing operator credentials",
    );

    expect(Core.classifyErrorCode(error.code)).toBeUndefined();
  });

  test("carries ERR_CONSOLE_UNAVAILABLE and is caught by isConsoleError and instanceof Core.M3LError", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_UNAVAILABLE",
      "the server is draining and refuses new requests",
    );

    expect(error.code).toBe("ERR_CONSOLE_UNAVAILABLE");
    expect(isConsoleError(error)).toBe(true);
    expect(error).toBeInstanceOf(Core.M3LError);
  });

  test.each<[M3LConsoleErrorCode, string]>([
    [
      "ERR_CONSOLE_STORE_UNSUPPORTED",
      "the configured store backend is not supported on this platform",
    ],
    [
      "ERR_CONSOLE_STORE_OPEN_FAILED",
      "failed to open the console persistence store",
    ],
    ["ERR_CONSOLE_STORE_BUSY", "SQLITE_BUSY persisted past the busy handler"],
    ["ERR_CONSOLE_STORE_CLOSED", "the store is closed and refuses new work"],
    [
      "ERR_CONSOLE_STORE_QUERY_FAILED",
      "the query against the console store failed",
    ],
    [
      "ERR_CONSOLE_STORE_MIGRATION_FAILED",
      "a pending schema migration failed to apply",
    ],
    [
      "ERR_CONSOLE_STORE_SCHEMA_DRIFT",
      "the on-disk schema does not match the expected version",
    ],
    [
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
      "no script directory was found for the requested run",
    ],
    [
      "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
      "the run requires explicit confirmation before it will execute",
    ],
    [
      "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
      "the run queue is at capacity and cannot accept another request",
    ],
  ])(
    "constructs %s and is caught by isConsoleError and instanceof Core.M3LError (X3-A1)",
    (code, message) => {
      const error = new M3LConsoleError(code, message);

      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(isConsoleError(error)).toBe(true);
      expect(error).toBeInstanceOf(Core.M3LError);
      expect(error).toBeInstanceOf(Error);
      // ERR_CONSOLE_* is deliberately absent from Core's own classification
      // catalog (see the module doc comment) — every one of these ten new
      // codes (the seven ERR_CONSOLE_STORE_* codes plus the three X4
      // run-governor codes) stays unclassified by Core.classifyErrorCode,
      // same as every existing ERR_CONSOLE_* code.
      expect(Core.classifyErrorCode(error.code)).toBeUndefined();
    },
  );

  test.each<[M3LConsoleErrorCode, string]>([
    ["ERR_CONSOLE_RUN_NOT_FOUND", "no run exists with the given id"],
    [
      "ERR_CONSOLE_RUN_TRANSITION_INVALID",
      "the guarded status transition matched zero rows",
    ],
  ])(
    "constructs %s and is caught by isConsoleError and instanceof Core.M3LError (X4)",
    (code, message) => {
      const error = new M3LConsoleError(code, message);

      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(isConsoleError(error)).toBe(true);
      expect(error).toBeInstanceOf(Core.M3LError);
      expect(error).toBeInstanceOf(Error);
      // ERR_CONSOLE_* is deliberately absent from Core's own classification
      // catalog (see the module doc comment) — these two new run-registry
      // codes stay unclassified by Core.classifyErrorCode, same as every
      // existing ERR_CONSOLE_* code.
      expect(Core.classifyErrorCode(error.code)).toBeUndefined();
    },
  );

  test.each<[M3LConsoleErrorCode, string]>([
    [
      "ERR_CONSOLE_BODY_TOO_LARGE",
      "the request body exceeds the configured byte cap",
    ],
    [
      "ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE",
      "the request body's content-type is not application/json",
    ],
  ])(
    "constructs %s and is caught by isConsoleError and instanceof Core.M3LError (http/body.ts, X4 slice 7-pre)",
    (code, message) => {
      const error = new M3LConsoleError(code, message);

      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(isConsoleError(error)).toBe(true);
      expect(error).toBeInstanceOf(Core.M3LError);
      expect(error).toBeInstanceOf(Error);
      // ERR_CONSOLE_* is deliberately absent from Core's own classification
      // catalog (see the module doc comment) — these two request-body
      // reading codes stay unclassified by Core.classifyErrorCode, same as
      // every existing ERR_CONSOLE_* code.
      expect(Core.classifyErrorCode(error.code)).toBeUndefined();
    },
  );
});

describe("M3LConsoleError — ERR_CONSOLE_SESSION_REFERENCE_INVALID (X6 slice 2)", () => {
  test("constructs and is caught by isConsoleError and instanceof Core.M3LError", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
      "malformed step reference: unterminated bracket",
    );

    expect(error.code).toBe("ERR_CONSOLE_SESSION_REFERENCE_INVALID");
    expect(isConsoleError(error)).toBe(true);
    expect(error).toBeInstanceOf(Core.M3LError);
    expect(error).toBeInstanceOf(Error);
    // ERR_CONSOLE_* is deliberately absent from Core's own classification
    // catalog (see the module doc comment) — this new reference-grammar code
    // stays unclassified by Core.classifyErrorCode, same as every existing
    // ERR_CONSOLE_* code.
    expect(Core.classifyErrorCode(error.code)).toBeUndefined();
  });
});

describe("M3LConsoleError — ERR_CONSOLE_SESSION_ARTIFACT_* (X6 slice 3)", () => {
  test.each<[M3LConsoleErrorCode, string]>([
    [
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
      "the artifact payload exceeds the configured cap",
    ],
    [
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      "the persisted artifact reference could not be decoded",
    ],
  ])(
    "constructs %s and is caught by isConsoleError and instanceof Core.M3LError",
    (code, message) => {
      const error = new M3LConsoleError(code, message);

      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(isConsoleError(error)).toBe(true);
      expect(error).toBeInstanceOf(Core.M3LError);
      expect(error).toBeInstanceOf(Error);
      // ERR_CONSOLE_* is deliberately absent from Core's own classification
      // catalog (see the module doc comment) — these two new session-
      // artifact codes stay unclassified by Core.classifyErrorCode, same as
      // every existing ERR_CONSOLE_* code.
      expect(Core.classifyErrorCode(error.code)).toBeUndefined();
    },
  );
});

describe("isConsoleError", () => {
  test("returns true for an M3LConsoleError instance", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_METHOD_NOT_ALLOWED",
      "PATCH is not supported on this route",
    );

    expect(isConsoleError(error)).toBe(true);
  });

  test.each<[string, unknown]>([
    ["a plain Error", new Error("plain")],
    ["a string", "not an error"],
    ["null", null],
    ["undefined", undefined],
  ])("returns false for %s", (_label, value) => {
    expect(isConsoleError(value)).toBe(false);
  });

  test("narrows the checked value to M3LConsoleError inside the guarded branch", () => {
    const maybe: unknown = new M3LConsoleError(
      "ERR_CONSOLE_NOT_FOUND",
      "route not found",
    );

    if (isConsoleError(maybe)) {
      expectTypeOf(maybe).toEqualTypeOf<M3LConsoleError>();
      expect(maybe.code).toBe("ERR_CONSOLE_NOT_FOUND");
    } else {
      expect.unreachable("expected isConsoleError to narrow maybe");
    }
  });
});
