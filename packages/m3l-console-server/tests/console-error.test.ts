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
  test("is the exact ten-member union the contract declares", () => {
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
