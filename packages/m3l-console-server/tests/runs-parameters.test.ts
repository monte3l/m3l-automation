/**
 * Tests for src/runs/parameters.ts — `parseRunRequest` (m3l-console-server X4
 * run-governor contract). Validates an untrusted request body into a closed
 * `M3LRunRequestBody` shape, defaulting `confirmed`/`dryRun`/`parameters`.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { parseRunRequest } from "../src/runs/parameters.js";
import type { M3LRunRequestBody } from "../src/runs/parameters.js";

/** Asserts that `fn` throws an `M3LConsoleError` with the given code. */
function expectBadRequest(fn: () => unknown): void {
  expect(fn).toThrow(M3LConsoleError);
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LConsoleError);
  expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
}

describe("parseRunRequest — happy path", () => {
  test("returns a fully populated body unchanged", () => {
    const body = {
      scriptName: "sqs-etl",
      confirmed: true,
      dryRun: false,
      parameters: { queue: "my-q" },
    };

    expect(parseRunRequest(body)).toEqual(body);
  });
});

describe("parseRunRequest — defaults", () => {
  test("defaults confirmed, dryRun, and parameters when absent", () => {
    const result = parseRunRequest({ scriptName: "json-etl" });

    expect(result).toEqual({
      scriptName: "json-etl",
      confirmed: false,
      dryRun: false,
      parameters: {},
    });
  });
});

describe("parseRunRequest — body shape validation", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST for a null body", () => {
    expectBadRequest(() => parseRunRequest(null));
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for an array body", () => {
    expectBadRequest(() => parseRunRequest(["sqs-etl"]));
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for a string body", () => {
    expectBadRequest(() => parseRunRequest("sqs-etl"));
  });
});

describe("parseRunRequest — scriptName validation", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST when scriptName is missing", () => {
    expectBadRequest(() => parseRunRequest({}));
  });

  test("throws ERR_CONSOLE_BAD_REQUEST when scriptName is not a string", () => {
    expectBadRequest(() => parseRunRequest({ scriptName: 42 }));
  });

  test("throws ERR_CONSOLE_BAD_REQUEST for an empty scriptName", () => {
    expectBadRequest(() => parseRunRequest({ scriptName: "" }));
  });

  test.each<[string]>([["MyScript"], ["my_script"], ["1-script"], ["-lead"]])(
    "throws ERR_CONSOLE_BAD_REQUEST for the invalid scriptName pattern %s",
    (scriptName) => {
      expectBadRequest(() => parseRunRequest({ scriptName }));
    },
  );

  test.each<[string]>([["sqs-etl"], ["a"], ["json-etl-2"]])(
    "accepts the valid kebab-case scriptName %s",
    (scriptName) => {
      const result = parseRunRequest({ scriptName });
      expect(result.scriptName).toBe(scriptName);
    },
  );
});

describe("parseRunRequest — confirmed validation", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST when confirmed is not a boolean", () => {
    expectBadRequest(() =>
      parseRunRequest({ scriptName: "sqs-etl", confirmed: "yes" }),
    );
  });

  test("accepts an explicit confirmed: true", () => {
    const result = parseRunRequest({
      scriptName: "sqs-etl",
      confirmed: true,
    });
    expect(result.confirmed).toBe(true);
  });
});

describe("parseRunRequest — dryRun validation", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST when dryRun is not a boolean", () => {
    expectBadRequest(() =>
      parseRunRequest({ scriptName: "sqs-etl", dryRun: "yes" }),
    );
  });

  test("accepts an explicit dryRun: true", () => {
    const result = parseRunRequest({ scriptName: "sqs-etl", dryRun: true });
    expect(result.dryRun).toBe(true);
  });
});

describe("parseRunRequest — parameters validation", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST when parameters is not a plain object", () => {
    expectBadRequest(() =>
      parseRunRequest({ scriptName: "sqs-etl", parameters: ["queue"] }),
    );
  });

  test("throws ERR_CONSOLE_BAD_REQUEST when a parameters value is not a string", () => {
    expectBadRequest(() =>
      parseRunRequest({
        scriptName: "sqs-etl",
        parameters: { queue: 42 },
      }),
    );
  });

  test("accepts a parameters object whose values are all strings", () => {
    const result = parseRunRequest({
      scriptName: "sqs-etl",
      parameters: { queue: "my-q", region: "us-east-1" },
    });
    expect(result.parameters).toEqual({ queue: "my-q", region: "us-east-1" });
  });
});

describe("M3LRunRequestBody", () => {
  test("has the exact readonly field shape the contract declares", () => {
    expectTypeOf<M3LRunRequestBody>().toEqualTypeOf<{
      readonly scriptName: string;
      readonly confirmed: boolean;
      readonly dryRun: boolean;
      readonly parameters: Readonly<Record<string, string>>;
    }>();
  });

  test("the value returned by parseRunRequest is typed as M3LRunRequestBody", () => {
    const result = parseRunRequest({ scriptName: "sqs-etl" });
    expectTypeOf(result).toEqualTypeOf<M3LRunRequestBody>();
  });
});
