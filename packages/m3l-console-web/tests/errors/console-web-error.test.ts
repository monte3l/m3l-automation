import { describe, expect, test } from "vitest";

import type { M3LConsoleWebErrorCode } from "../../src/errors/console-web-error.js";
import { M3LConsoleWebError } from "../../src/errors/console-web-error.js";

describe("M3LConsoleWebError", () => {
  test("sets code from the constructor's first argument", () => {
    const code: M3LConsoleWebErrorCode = "ERR_CONSOLE_WEB_ROOT_MISSING";

    const error = new M3LConsoleWebError(code, "#root element not found");

    expect(error.code).toBe("ERR_CONSOLE_WEB_ROOT_MISSING");
  });

  test("sets message from the constructor's second argument", () => {
    const error = new M3LConsoleWebError(
      "ERR_CONSOLE_WEB_ROOT_MISSING",
      "#root element not found",
    );

    expect(error.message).toBe("#root element not found");
  });

  test("sets name to M3LConsoleWebError, not the default Error", () => {
    const error = new M3LConsoleWebError(
      "ERR_CONSOLE_WEB_ROOT_MISSING",
      "#root element not found",
    );

    expect(error.name).toBe("M3LConsoleWebError");
  });

  test("is a real Error subclass", () => {
    const error = new M3LConsoleWebError(
      "ERR_CONSOLE_WEB_ROOT_MISSING",
      "#root element not found",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(M3LConsoleWebError);
  });

  test("preserves a cause passed via options", () => {
    const cause = new Error("original DOM failure");

    const error = new M3LConsoleWebError(
      "ERR_CONSOLE_WEB_ROOT_MISSING",
      "#root element not found",
      { cause },
    );

    expect(error.cause).toBe(cause);
  });

  test("leaves cause undefined when no options are passed", () => {
    const error = new M3LConsoleWebError(
      "ERR_CONSOLE_WEB_ROOT_MISSING",
      "#root element not found",
    );

    expect(error.cause).toBeUndefined();
  });
});
