/**
 * Tests for src/sessions/binding.ts — typed bindings (m3l-console-server X6
 * workbench-sessions module, slice 2, ADR-0068).
 *
 * `validateBindingValue` is a predicate (never throws): it checks a value
 * against a binding's `expectedType`/`multiSelect` shape and returns a
 * boolean, leaving the caller to decide what a `false` means.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { validateBindingValue } from "../src/sessions/binding.js";
import type {
  M3LBindingExpectedType,
  M3LSessionBinding,
} from "../src/sessions/binding.js";
import type { M3LStepReference } from "../src/sessions/reference.js";

/** A binding-shape pick, ignoring `reference` (not consumed by `validateBindingValue`). */
type BindingShape = Pick<M3LSessionBinding, "expectedType" | "multiSelect">;

describe("M3LBindingExpectedType — closed four-member vocabulary", () => {
  test("has exactly string | number | boolean | object, no array member", () => {
    expectTypeOf<M3LBindingExpectedType>().toEqualTypeOf<
      "string" | "number" | "boolean" | "object"
    >();
  });

  test("rejects an invalid literal at the type level", () => {
    // @ts-expect-error -- "array" is deliberately not a member; multiSelect expresses arrayness instead
    const invalid: M3LBindingExpectedType = "array";
    expect(invalid).toBeDefined();
  });
});

describe("M3LSessionBinding — domain shape", () => {
  test("reference is the parsed M3LStepReference, not a raw string", () => {
    expectTypeOf<M3LSessionBinding>().toMatchTypeOf<{
      readonly reference: M3LStepReference;
      readonly expectedType: M3LBindingExpectedType;
      readonly multiSelect: boolean;
    }>();
  });
});

describe("validateBindingValue — multiSelect: false, scalar/object shape checks", () => {
  test.each<[BindingShape, unknown, boolean]>([
    [{ expectedType: "string", multiSelect: false }, "hello", true],
    [{ expectedType: "string", multiSelect: false }, 42, false],
    [{ expectedType: "number", multiSelect: false }, 42, true],
    [{ expectedType: "number", multiSelect: false }, "42", false],
    [{ expectedType: "boolean", multiSelect: false }, true, true],
    [{ expectedType: "boolean", multiSelect: false }, "true", false],
    [{ expectedType: "object", multiSelect: false }, { a: 1 }, true],
    [{ expectedType: "object", multiSelect: false }, null, false],
    [{ expectedType: "object", multiSelect: false }, [1, 2, 3], false],
    [{ expectedType: "object", multiSelect: false }, "not-an-object", false],
  ])(
    "validateBindingValue(%o scalar, %j) returns %s",
    (binding, value, expected) => {
      expect(validateBindingValue(value, binding)).toBe(expected);
    },
  );
});

describe("validateBindingValue — multiSelect: true, array-of-shape checks", () => {
  test.each<[BindingShape, unknown, boolean]>([
    [{ expectedType: "string", multiSelect: true }, ["a", "b"], true],
    [{ expectedType: "string", multiSelect: true }, ["a", 1], false],
    [{ expectedType: "string", multiSelect: true }, "not-an-array", false],
    [{ expectedType: "number", multiSelect: true }, [1, 2, 3], true],
    [{ expectedType: "number", multiSelect: true }, [1, "2"], false],
    [{ expectedType: "boolean", multiSelect: true }, [true, false], true],
    [{ expectedType: "boolean", multiSelect: true }, [true, 1], false],
    [{ expectedType: "object", multiSelect: true }, [{ a: 1 }, { b: 2 }], true],
    [{ expectedType: "object", multiSelect: true }, [{ a: 1 }, null], false],
    [{ expectedType: "object", multiSelect: true }, [{ a: 1 }, [1]], false],
  ])(
    "validateBindingValue(%o array, %j) returns %s",
    (binding, value, expected) => {
      expect(validateBindingValue(value, binding)).toBe(expected);
    },
  );

  test("an empty array satisfies multiSelect for every expectedType (vacuously true)", () => {
    expect(
      validateBindingValue([], { expectedType: "string", multiSelect: true }),
    ).toBe(true);
    expect(
      validateBindingValue([], { expectedType: "object", multiSelect: true }),
    ).toBe(true);
  });
});

describe("validateBindingValue — expectedType outside the compile-time union", () => {
  test("exercises the exhaustiveness-check default branch, unreachable through the typed public API — coverage only", () => {
    const offUnionExpectedType =
      "unknown-type" as unknown as M3LBindingExpectedType;

    expect(() =>
      validateBindingValue("anything", {
        expectedType: offUnionExpectedType,
        multiSelect: false,
      }),
    ).not.toThrow();
  });
});

describe("validateBindingValue — never throws", () => {
  test.each<[unknown]>([
    [undefined],
    [null],
    [Symbol("weird")],
    [() => undefined],
  ])("returns a boolean, never throws, for the unusual value %o", (value) => {
    expect(() =>
      validateBindingValue(value, {
        expectedType: "string",
        multiSelect: false,
      }),
    ).not.toThrow();
    expect(
      typeof validateBindingValue(value, {
        expectedType: "string",
        multiSelect: false,
      }),
    ).toBe("boolean");
  });
});
