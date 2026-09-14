// Tests for src/errors/mcp-error.ts (V10b, ADR-0062), defining the
// contract for M3LMcpError and isM3LMcpError.
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  isM3LMcpError,
  M3LMcpError,
  type M3LMcpErrorCode,
} from "../src/errors/mcp-error.js";

const ALL_CODES: readonly M3LMcpErrorCode[] = [
  "ERR_MCP_POLICY",
  "ERR_MCP_DECISION_LOG",
  "ERR_MCP_CONFIG",
  "ERR_MCP_IDENTITY",
];

describe("M3LMcpError", () => {
  test.each(ALL_CODES)("carries the exact code %s and message", (code) => {
    const error = new M3LMcpError("something failed", code);

    expect(error.message).toBe("something failed");
    expect(error.code).toBe(code);
  });

  test("name is M3LMcpError", () => {
    const error = new M3LMcpError("boom", "ERR_MCP_POLICY");

    expect(error.name).toBe("M3LMcpError");
  });

  test("is an instanceof both Error and M3LMcpError", () => {
    const error = new M3LMcpError("boom", "ERR_MCP_CONFIG");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(M3LMcpError);
  });

  test("chains cause when supplied", () => {
    const cause = new Error("root cause");
    const error = new M3LMcpError("wrapper", "ERR_MCP_DECISION_LOG", {
      cause,
    });

    expect(error.cause).toBe(cause);
  });

  test("cause is undefined when not supplied", () => {
    const error = new M3LMcpError("no cause here", "ERR_MCP_IDENTITY");

    expect(error.cause).toBeUndefined();
  });

  test("cause may be any unknown value, not just an Error", () => {
    const error = new M3LMcpError("wrapper", "ERR_MCP_POLICY", {
      cause: "a string cause",
    });

    expect(error.cause).toBe("a string cause");
  });

  test("message is never decorated with the code or a prefix", () => {
    const error = new M3LMcpError("plain text only", "ERR_MCP_CONFIG");

    // Exact equality, not a substring match — proves nothing was prepended
    // or appended (e.g. no "[ERR_MCP_CONFIG] " prefix).
    expect(error.message).toBe("plain text only");
  });

  test("type-level: M3LMcpErrorCode is exactly the documented closed set", () => {
    expectTypeOf<M3LMcpErrorCode>().toEqualTypeOf<
      | "ERR_MCP_POLICY"
      | "ERR_MCP_DECISION_LOG"
      | "ERR_MCP_CONFIG"
      | "ERR_MCP_IDENTITY"
    >();
  });
});

describe("isM3LMcpError", () => {
  test.each(ALL_CODES)(
    "returns true for a real M3LMcpError instance (code %s)",
    (code) => {
      const error = new M3LMcpError("boom", code);

      expect(isM3LMcpError(error)).toBe(true);
    },
  );

  test("returns false for a plain object with the right name/code shape (not a real instance)", () => {
    // A structural check would pass this — the guard must not be vacuous.
    const forgery = {
      name: "M3LMcpError",
      code: "ERR_MCP_POLICY",
      message: "boom",
    };

    expect(isM3LMcpError(forgery)).toBe(false);
  });

  test("returns false for a genuine Error that is not an M3LMcpError", () => {
    expect(isM3LMcpError(new Error("plain error"))).toBe(false);
  });

  test.each([null, undefined, 42, "a string", true, Symbol("s")])(
    "returns false for primitive/nullish value %s without throwing",
    (value) => {
      expect(() => isM3LMcpError(value)).not.toThrow();
      expect(isM3LMcpError(value)).toBe(false);
    },
  );

  test("does not throw on an object with a throwing code getter", () => {
    const hostile: unknown = {
      name: "M3LMcpError",
      get code(): never {
        throw new Error("gotcha");
      },
    };

    expect(() => isM3LMcpError(hostile)).not.toThrow();
    expect(isM3LMcpError(hostile)).toBe(false);
  });
});
