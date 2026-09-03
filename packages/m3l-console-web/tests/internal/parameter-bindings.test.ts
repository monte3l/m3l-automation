import { describe, expect, test } from "vitest";

import type { M3LParameterBinding } from "../../src/internal/parameter-bindings.js";
import { resolveBindingValues } from "../../src/internal/parameter-bindings.js";

function buildBinding(
  overrides: Partial<M3LParameterBinding> & { readonly parameterName: string },
): M3LParameterBinding {
  return {
    value: "default-value",
    multiSelect: false,
    ...overrides,
  };
}

describe("resolveBindingValues — single-value (multiSelect: false)", () => {
  test("an empty bindings array resolves to an empty map", () => {
    expect(resolveBindingValues([])).toEqual({});
  });

  test("a string value is passed through unchanged", () => {
    const bindings = [
      buildBinding({ parameterName: "region", value: "us-east-1" }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({ region: "us-east-1" });
  });

  test("a number value is coerced via String()", () => {
    const bindings = [buildBinding({ parameterName: "retries", value: 42 })];

    expect(resolveBindingValues(bindings)).toEqual({ retries: "42" });
  });

  test.each([
    [true, "true"],
    [false, "false"],
  ])("a boolean value %s is coerced to %s", (value, expected) => {
    const bindings = [buildBinding({ parameterName: "enabled", value })];

    expect(resolveBindingValues(bindings)).toEqual({ enabled: expected });
  });

  test("a plain object value is coerced via JSON.stringify", () => {
    const bindings = [
      buildBinding({ parameterName: "payload", value: { a: 1 } }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({
      payload: JSON.stringify({ a: 1 }),
    });
  });

  test("a null value omits the parameterName key entirely", () => {
    const bindings = [buildBinding({ parameterName: "region", value: null })];

    const result = resolveBindingValues(bindings);
    expect(result).not.toHaveProperty("region");
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("an undefined value omits the parameterName key entirely", () => {
    const bindings = [
      buildBinding({ parameterName: "region", value: undefined }),
    ];

    const result = resolveBindingValues(bindings);
    expect(result).not.toHaveProperty("region");
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("resolveBindingValues — multi-select (multiSelect: true)", () => {
  test("an array of strings is comma-joined", () => {
    const bindings = [
      buildBinding({
        parameterName: "queueUrls",
        value: ["a", "b"],
        multiSelect: true,
      }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({ queueUrls: "a,b" });
  });

  test("an array of numbers has each element coerced then comma-joined", () => {
    const bindings = [
      buildBinding({
        parameterName: "counts",
        value: [1, 2],
        multiSelect: true,
      }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({ counts: "1,2" });
  });

  test("an array of booleans has each element coerced then comma-joined", () => {
    const bindings = [
      buildBinding({
        parameterName: "flags",
        value: [true, false],
        multiSelect: true,
      }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({ flags: "true,false" });
  });

  test("null and undefined elements in a multi-select array are each treated as an empty segment (matching Array.prototype.join's own null/undefined handling), not JSON.stringify's undefined/null quirk", () => {
    const bindings = [
      buildBinding({
        parameterName: "mixed",
        value: [1, undefined, "b", null],
        multiSelect: true,
      }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({ mixed: "1,,b," });
  });

  test("an empty array resolves to an empty string, key present", () => {
    const bindings = [
      buildBinding({ parameterName: "tags", value: [], multiSelect: true }),
    ];

    const result = resolveBindingValues(bindings);
    expect(result).toHaveProperty("tags", "");
  });

  test.each([
    ["a string", "not-an-array"],
    ["a plain object", { a: 1 }],
  ])(
    "a non-array value (%s) omits the parameterName key entirely, without throwing",
    (_label, value) => {
      const bindings = [
        buildBinding({ parameterName: "tags", value, multiSelect: true }),
      ];

      let result: Readonly<Record<string, string>> | undefined;
      expect(() => {
        result = resolveBindingValues(bindings);
      }).not.toThrow();
      expect(result).not.toHaveProperty("tags");
    },
  );
});

describe("resolveBindingValues — multiple bindings", () => {
  test("a later binding with the same parameterName wins over an earlier one", () => {
    const bindings = [
      buildBinding({ parameterName: "region", value: "us-east-1" }),
      buildBinding({ parameterName: "region", value: "eu-west-1" }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({ region: "eu-west-1" });
  });

  test("distinct bindings all appear in the same result map", () => {
    const bindings = [
      buildBinding({ parameterName: "region", value: "us-east-1" }),
      buildBinding({ parameterName: "retries", value: 3 }),
      buildBinding({
        parameterName: "queueUrls",
        value: ["a", "b"],
        multiSelect: true,
      }),
    ];

    expect(resolveBindingValues(bindings)).toEqual({
      region: "us-east-1",
      retries: "3",
      queueUrls: "a,b",
    });
  });
});

describe("resolveBindingValues — __proto__-named parameter", () => {
  // Mirrors ParameterForm.test.tsx's own "__proto__-named parameter"
  // describe block: a parameterName literally "__proto__" must round-trip as
  // an own, readable property of the returned map, and Object.prototype
  // itself must never be polluted by building the result via plain
  // bracket-assignment.
  test("does not pollute Object.prototype and exposes __proto__ as an own property", () => {
    const bindings = [
      buildBinding({ parameterName: "__proto__", value: "polluted-value" }),
    ];

    const result = resolveBindingValues(bindings);

    expect(Object.getPrototypeOf(Object)).not.toHaveProperty("polluted-value");
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe(
      "polluted-value",
    );
  });
});
