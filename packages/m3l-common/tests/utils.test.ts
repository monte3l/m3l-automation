/**
 * Tests for core/utils submodule — written tests-first (RED phase).
 * The implementation does NOT exist; all tests are expected to fail because
 * the module `../src/core/utils/index.js` cannot be resolved yet.
 *
 * Contract source: docs/reference/core/utils.md
 * Phases covered: A (type guards, 26 symbols), B (serialization & formatting,
 * 10 symbols), C (concurrency, 1 symbol). Phase D (M3LPaths) deferred.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";

import {
  formatBytes,
  formatConfigSourceDisplay,
  formatConfigValueDisplay,
  hasMessage,
  hasProperty,
  isArray,
  isBigInt,
  isBoolean,
  isBuffer,
  isDate,
  isEnoentError,
  isError,
  isFunction,
  isMap,
  isNodeError,
  isNonEmptyArray,
  isNonEmptyString,
  isNullish,
  isNumber,
  isObject,
  isPath,
  isPlainObject,
  isPrimitive,
  isPromise,
  isRegExp,
  isSet,
  isString,
  isSymbol,
  isValidDate,
  M3LConcurrencyPool,
  M3LDateTokens,
  safeJsonStringify,
  smartTruncate,
  truncatePath,
  truncateText,
  valueToString,
} from "../src/core/utils/index.js";

// =============================================================================
// Phase A — Type guards
// =============================================================================

// ---------------------------------------------------------------------------
// isNullish
// ---------------------------------------------------------------------------
describe("isNullish()", () => {
  test("returns true for null", () => {
    expect(isNullish(null)).toBe(true);
  });

  test("returns true for undefined", () => {
    expect(isNullish(undefined)).toBe(true);
  });

  test.each([
    [0, "0"],
    ["", "empty string"],
    [false, "false"],
    [NaN, "NaN"],
  ])("returns false for %s (%s)", (value, _label) => {
    expect(isNullish(value)).toBe(false);
  });

  test("narrows to null | undefined", () => {
    const v: unknown = null;
    if (isNullish(v)) {
      expectTypeOf(v).toMatchTypeOf<null | undefined>();
    }
  });
});

// ---------------------------------------------------------------------------
// isPrimitive
// ---------------------------------------------------------------------------
describe("isPrimitive()", () => {
  test.each([
    ["a string", "string"],
    [42, "number"],
    [true, "boolean"],
    [BigInt(1), "bigint"],
    [Symbol("s"), "symbol"],
    [null, "null"],
    [undefined, "undefined"],
  ])("returns true for %s (%s)", (value, _label) => {
    expect(isPrimitive(value)).toBe(true);
  });

  test.each([
    [{}, "plain object"],
    [[], "array"],
    [() => {}, "function"],
    [new Date(), "Date"],
  ])("returns false for %s (%s)", (value, _label) => {
    expect(isPrimitive(value)).toBe(false);
  });

  test("narrows the type to a primitive union", () => {
    const v: unknown = "hello";
    if (isPrimitive(v)) {
      expectTypeOf(v).toMatchTypeOf<
        string | number | boolean | bigint | symbol | null | undefined
      >();
    }
  });
});

// ---------------------------------------------------------------------------
// isError
// ---------------------------------------------------------------------------
describe("isError()", () => {
  test("returns true for an Error instance", () => {
    expect(isError(new Error("boom"))).toBe(true);
  });

  test("returns true for a TypeError (subclass)", () => {
    expect(isError(new TypeError("type"))).toBe(true);
  });

  test("returns false for a plain object with a message property", () => {
    expect(isError({ message: "looks like an error" })).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isError("error string")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isError(null)).toBe(false);
  });

  test("narrows to Error", () => {
    const v: unknown = new Error("x");
    if (isError(v)) {
      expectTypeOf(v).toMatchTypeOf<Error>();
    }
  });
});

// ---------------------------------------------------------------------------
// isNodeError
// ---------------------------------------------------------------------------
describe("isNodeError()", () => {
  test("returns true for a NodeJS ErrnoException with a code property", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(isNodeError(err)).toBe(true);
  });

  test("returns false for an Error without a code property", () => {
    expect(isNodeError(new Error("no code"))).toBe(false);
  });

  test("returns false for a plain object with code but no Error prototype", () => {
    expect(isNodeError({ message: "x", code: "ENOENT" })).toBe(false);
  });

  test("returns false for null", () => {
    expect(isNodeError(null)).toBe(false);
  });

  test("narrows to NodeJS.ErrnoException", () => {
    const err = Object.assign(new Error("x"), { code: "EIO" });
    if (isNodeError(err)) {
      expectTypeOf(err).toMatchTypeOf<NodeJS.ErrnoException>();
    }
  });
});

// ---------------------------------------------------------------------------
// isEnoentError
// ---------------------------------------------------------------------------
describe("isEnoentError()", () => {
  test("returns true for a NodeError with code ENOENT", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(isEnoentError(err)).toBe(true);
  });

  test("returns false for a NodeError with a different code", () => {
    const err = Object.assign(new Error("io"), { code: "EIO" });
    expect(isEnoentError(err)).toBe(false);
  });

  test("returns false for a plain Error without a code", () => {
    expect(isEnoentError(new Error("no code"))).toBe(false);
  });

  test("returns false for null", () => {
    expect(isEnoentError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPlainObject
// ---------------------------------------------------------------------------
describe("isPlainObject()", () => {
  test("returns true for an object literal", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  test("returns true for Object.create(null) — null prototype", () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  test("returns true for Object.create(Object.prototype)", () => {
    expect(isPlainObject(Object.create(Object.prototype))).toBe(true);
  });

  test("returns false for a class instance", () => {
    class Foo {}
    expect(isPlainObject(new Foo())).toBe(false);
  });

  test("returns false for an array", () => {
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  test("returns false for a Map", () => {
    expect(isPlainObject(new Map())).toBe(false);
  });

  test("returns false for a Set", () => {
    expect(isPlainObject(new Set())).toBe(false);
  });

  test("returns false for a Date", () => {
    expect(isPlainObject(new Date())).toBe(false);
  });

  test("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isPlainObject("hello")).toBe(false);
  });

  test("narrows to object", () => {
    const v: unknown = { x: 1 };
    if (isPlainObject(v)) {
      expectTypeOf(v).toMatchTypeOf<object>();
    }
  });
});

// ---------------------------------------------------------------------------
// isObject
// ---------------------------------------------------------------------------
describe("isObject()", () => {
  test.each([
    [{}, "plain object"],
    [[], "array"],
    [new Map(), "Map"],
    [new Date(), "Date"],
    [new Set(), "Set"],
  ])("returns true for %s (%s)", (value, _label) => {
    expect(isObject(value)).toBe(true);
  });

  test("returns false for null", () => {
    expect(isObject(null)).toBe(false);
  });

  test("returns false for a string primitive", () => {
    expect(isObject("hello")).toBe(false);
  });

  test("returns false for a number", () => {
    expect(isObject(42)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isObject(undefined)).toBe(false);
  });

  test("narrows to object", () => {
    const v: unknown = {};
    if (isObject(v)) {
      expectTypeOf(v).toMatchTypeOf<object>();
    }
  });
});

// ---------------------------------------------------------------------------
// isArray
// ---------------------------------------------------------------------------
describe("isArray()", () => {
  test("returns true for an array literal", () => {
    expect(isArray([1, 2, 3])).toBe(true);
  });

  test("returns true for an empty array", () => {
    expect(isArray([])).toBe(true);
  });

  test("returns false for an object", () => {
    expect(isArray({})).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isArray("not array")).toBe(false);
  });

  test("narrows to unknown[]", () => {
    const v: unknown = [1, 2];
    if (isArray(v)) {
      expectTypeOf(v).toMatchTypeOf<unknown[]>();
    }
  });
});

// ---------------------------------------------------------------------------
// isString
// ---------------------------------------------------------------------------
describe("isString()", () => {
  test("returns true for a string primitive", () => {
    expect(isString("hello")).toBe(true);
  });

  test("returns true for an empty string", () => {
    expect(isString("")).toBe(true);
  });

  test("returns false for a number", () => {
    expect(isString(42)).toBe(false);
  });

  test("returns false for a String object (boxed)", () => {
    // new String() creates a boxed object; typeof === 'object', not 'string'
    // eslint-disable-next-line @typescript-eslint/no-wrapper-object-types -- intentional: verifying typeof guard excludes boxed String objects
    const boxed: String = new String("hello");
    expect(isString(boxed)).toBe(false);
  });

  test("narrows to string", () => {
    const v: unknown = "x";
    if (isString(v)) {
      expectTypeOf(v).toBeString();
    }
  });
});

// ---------------------------------------------------------------------------
// isNumber
// ---------------------------------------------------------------------------
describe("isNumber()", () => {
  test("returns true for a finite number", () => {
    expect(isNumber(42)).toBe(true);
  });

  test("returns true for NaN (typeof NaN === 'number')", () => {
    expect(isNumber(NaN)).toBe(true);
  });

  test("returns true for Infinity", () => {
    expect(isNumber(Infinity)).toBe(true);
  });

  test("returns true for -Infinity", () => {
    expect(isNumber(-Infinity)).toBe(true);
  });

  test("returns false for a string", () => {
    expect(isNumber("42")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isNumber(null)).toBe(false);
  });

  test("narrows to number", () => {
    const v: unknown = 0;
    if (isNumber(v)) {
      expectTypeOf(v).toBeNumber();
    }
  });
});

// ---------------------------------------------------------------------------
// isBoolean
// ---------------------------------------------------------------------------
describe("isBoolean()", () => {
  test("returns true for true", () => {
    expect(isBoolean(true)).toBe(true);
  });

  test("returns true for false", () => {
    expect(isBoolean(false)).toBe(true);
  });

  test("returns false for 1", () => {
    expect(isBoolean(1)).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isBoolean("true")).toBe(false);
  });

  test("narrows to boolean", () => {
    const v: unknown = false;
    if (isBoolean(v)) {
      expectTypeOf(v).toBeBoolean();
    }
  });
});

// ---------------------------------------------------------------------------
// isFunction
// ---------------------------------------------------------------------------
describe("isFunction()", () => {
  test("returns true for a regular function", () => {
    expect(isFunction(() => {})).toBe(true);
  });

  test("returns true for an async function", () => {
    expect(isFunction(async () => {})).toBe(true);
  });

  test("returns true for a class constructor", () => {
    class Foo {}
    expect(isFunction(Foo)).toBe(true);
  });

  test("returns false for an object", () => {
    expect(isFunction({})).toBe(false);
  });

  test("returns false for null", () => {
    expect(isFunction(null)).toBe(false);
  });

  test("narrows to a function type", () => {
    const v: unknown = () => {};
    if (isFunction(v)) {
      expectTypeOf(v).toBeFunction();
    }
  });
});

// ---------------------------------------------------------------------------
// isDate
// ---------------------------------------------------------------------------
describe("isDate()", () => {
  test("returns true for a valid Date", () => {
    expect(isDate(new Date())).toBe(true);
  });

  test("returns true for an invalid Date (does NOT check validity)", () => {
    expect(isDate(new Date("invalid"))).toBe(true);
  });

  test("returns false for a date string", () => {
    expect(isDate("2024-01-01")).toBe(false);
  });

  test("returns false for a number (timestamp)", () => {
    expect(isDate(Date.now())).toBe(false);
  });

  test("returns false for null", () => {
    expect(isDate(null)).toBe(false);
  });

  test("narrows to Date", () => {
    const v: unknown = new Date();
    if (isDate(v)) {
      expectTypeOf(v).toMatchTypeOf<Date>();
    }
  });
});

// ---------------------------------------------------------------------------
// isValidDate
// ---------------------------------------------------------------------------
describe("isValidDate()", () => {
  test("returns true for a valid Date object", () => {
    expect(isValidDate(new Date())).toBe(true);
  });

  test("returns false for an invalid Date (new Date('invalid'))", () => {
    expect(isValidDate(new Date("invalid"))).toBe(false);
  });

  test("returns false for a date string", () => {
    expect(isValidDate("2024-01-01")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isValidDate(null)).toBe(false);
  });

  test("narrows to Date inside the truthy branch", () => {
    const v: unknown = new Date();
    if (isValidDate(v)) {
      expectTypeOf(v).toMatchTypeOf<Date>();
    }
  });
});

// ---------------------------------------------------------------------------
// isBuffer
// ---------------------------------------------------------------------------
describe("isBuffer()", () => {
  test("returns true for a Buffer", () => {
    expect(isBuffer(Buffer.from("hello"))).toBe(true);
  });

  test("returns true for an empty Buffer", () => {
    expect(isBuffer(Buffer.alloc(0))).toBe(true);
  });

  test("returns false for a Uint8Array (not a Buffer)", () => {
    expect(isBuffer(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isBuffer("binary")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isBuffer(null)).toBe(false);
  });

  test("narrows to Buffer", () => {
    const v: unknown = Buffer.from("x");
    if (isBuffer(v)) {
      expectTypeOf(v).toMatchTypeOf<Buffer>();
    }
  });
});

// ---------------------------------------------------------------------------
// isMap
// ---------------------------------------------------------------------------
describe("isMap()", () => {
  test("returns true for a Map", () => {
    expect(isMap(new Map())).toBe(true);
  });

  test("returns false for a plain object", () => {
    expect(isMap({})).toBe(false);
  });

  test("returns false for a WeakMap", () => {
    expect(isMap(new WeakMap())).toBe(false);
  });

  test("returns false for null", () => {
    expect(isMap(null)).toBe(false);
  });

  test("narrows to Map<unknown, unknown>", () => {
    const v: unknown = new Map();
    if (isMap(v)) {
      expectTypeOf(v).toMatchTypeOf<Map<unknown, unknown>>();
    }
  });
});

// ---------------------------------------------------------------------------
// isSet
// ---------------------------------------------------------------------------
describe("isSet()", () => {
  test("returns true for a Set", () => {
    expect(isSet(new Set())).toBe(true);
  });

  test("returns false for an array", () => {
    expect(isSet([1, 2, 3])).toBe(false);
  });

  test("returns false for a WeakSet", () => {
    expect(isSet(new WeakSet())).toBe(false);
  });

  test("returns false for null", () => {
    expect(isSet(null)).toBe(false);
  });

  test("narrows to Set<unknown>", () => {
    const v: unknown = new Set();
    if (isSet(v)) {
      expectTypeOf(v).toMatchTypeOf<Set<unknown>>();
    }
  });
});

// ---------------------------------------------------------------------------
// isRegExp
// ---------------------------------------------------------------------------
describe("isRegExp()", () => {
  test("returns true for a RegExp literal", () => {
    expect(isRegExp(/foo/)).toBe(true);
  });

  test("returns true for a constructed RegExp", () => {
    expect(isRegExp(new RegExp("bar"))).toBe(true);
  });

  test("returns false for a string", () => {
    expect(isRegExp("/foo/")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isRegExp(null)).toBe(false);
  });

  test("narrows to RegExp", () => {
    const v: unknown = /x/;
    if (isRegExp(v)) {
      expectTypeOf(v).toMatchTypeOf<RegExp>();
    }
  });
});

// ---------------------------------------------------------------------------
// isSymbol
// ---------------------------------------------------------------------------
describe("isSymbol()", () => {
  test("returns true for a Symbol", () => {
    expect(isSymbol(Symbol("test"))).toBe(true);
  });

  test("returns true for Symbol.iterator", () => {
    expect(isSymbol(Symbol.iterator)).toBe(true);
  });

  test("returns false for a string", () => {
    expect(isSymbol("symbol")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isSymbol(null)).toBe(false);
  });

  test("narrows to symbol", () => {
    const v: unknown = Symbol("x");
    if (isSymbol(v)) {
      expectTypeOf(v).toBeSymbol();
    }
  });
});

// ---------------------------------------------------------------------------
// isBigInt
// ---------------------------------------------------------------------------
describe("isBigInt()", () => {
  test("returns true for a BigInt literal", () => {
    expect(isBigInt(BigInt(42))).toBe(true);
  });

  test("returns true for BigInt(0)", () => {
    expect(isBigInt(BigInt(0))).toBe(true);
  });

  test("returns false for a number", () => {
    expect(isBigInt(42)).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isBigInt("42n")).toBe(false);
  });

  test("narrows to bigint", () => {
    const v: unknown = BigInt(1);
    if (isBigInt(v)) {
      expectTypeOf(v).toBeBigInt();
    }
  });
});

// ---------------------------------------------------------------------------
// isPromise
// ---------------------------------------------------------------------------
describe("isPromise()", () => {
  test("returns true for a native Promise", () => {
    expect(isPromise(Promise.resolve(1))).toBe(true);
  });

  test("returns true for a rejected Promise (without unhandled rejection here)", () => {
    const p = Promise.reject(new Error("x"));
    p.catch(() => {
      // swallow for test isolation
    });
    expect(isPromise(p)).toBe(true);
  });

  test("returns false for null", () => {
    expect(isPromise(null)).toBe(false);
  });

  test("returns false for a plain object without .then", () => {
    expect(isPromise({ value: 1 })).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isPromise("not a promise")).toBe(false);
  });

  test("narrows to a Promise-like type", () => {
    const v: unknown = Promise.resolve(1);
    if (isPromise(v)) {
      expectTypeOf(v).toMatchTypeOf<Promise<unknown>>();
    }
  });
});

// ---------------------------------------------------------------------------
// isNonEmptyString
// ---------------------------------------------------------------------------
describe("isNonEmptyString()", () => {
  test("returns true for a non-empty string", () => {
    expect(isNonEmptyString("hello")).toBe(true);
  });

  test("returns true for a string containing only spaces (spaces are non-empty)", () => {
    expect(isNonEmptyString("   ")).toBe(true);
  });

  test("returns false for an empty string", () => {
    expect(isNonEmptyString("")).toBe(false);
  });

  test("returns false for a number", () => {
    expect(isNonEmptyString(42)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isNonEmptyString(null)).toBe(false);
  });

  test("narrows to string", () => {
    const v: unknown = "abc";
    if (isNonEmptyString(v)) {
      expectTypeOf(v).toBeString();
    }
  });
});

// ---------------------------------------------------------------------------
// isNonEmptyArray
// ---------------------------------------------------------------------------
describe("isNonEmptyArray()", () => {
  test("returns true for a non-empty array", () => {
    expect(isNonEmptyArray([1, 2, 3])).toBe(true);
  });

  test("returns true for an array with one element", () => {
    expect(isNonEmptyArray([null])).toBe(true);
  });

  test("returns false for an empty array", () => {
    expect(isNonEmptyArray([])).toBe(false);
  });

  test("returns false for a string (not an array)", () => {
    expect(isNonEmptyArray("abc")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isNonEmptyArray(null)).toBe(false);
  });

  test("narrows to unknown[]", () => {
    const v: unknown = [1, 2];
    if (isNonEmptyArray(v)) {
      expectTypeOf(v).toMatchTypeOf<unknown[]>();
    }
  });
});

// ---------------------------------------------------------------------------
// hasProperty
// ---------------------------------------------------------------------------
describe("hasProperty()", () => {
  test("returns true when the own property exists on an object", () => {
    expect(hasProperty({ foo: 1 }, "foo")).toBe(true);
  });

  test("returns true for an inherited property (uses 'in' operator)", () => {
    class Base {
      get inherited(): string {
        return "yes";
      }
    }
    expect(hasProperty(new Base(), "inherited")).toBe(true);
  });

  test("returns false when the property does not exist", () => {
    expect(hasProperty({ a: 1 }, "b")).toBe(false);
  });

  test("returns false for null", () => {
    expect(hasProperty(null, "foo")).toBe(false);
  });

  test("returns false for a string primitive", () => {
    expect(hasProperty("hello", "length")).toBe(false);
  });

  test("narrows to object & Record<K, unknown> inside the truthy branch", () => {
    const v: unknown = { message: "oops" };
    if (hasProperty(v, "message")) {
      expectTypeOf(v).toMatchTypeOf<object & Record<"message", unknown>>();
    }
  });

  test("the key K is generic — compiles with any string key", () => {
    const v: unknown = { customKey: 42 };
    const key = "customKey" as const;
    if (hasProperty(v, key)) {
      expectTypeOf(v).toMatchTypeOf<object & Record<typeof key, unknown>>();
    }
  });
});

// ---------------------------------------------------------------------------
// hasMessage
// ---------------------------------------------------------------------------
describe("hasMessage()", () => {
  test("returns true for an object with a message property", () => {
    expect(hasMessage({ message: "oops" })).toBe(true);
  });

  test("returns true for an Error (has message)", () => {
    expect(hasMessage(new Error("err msg"))).toBe(true);
  });

  test("returns false for an object without a message property", () => {
    expect(hasMessage({ code: "X" })).toBe(false);
  });

  test("returns false for null", () => {
    expect(hasMessage(null)).toBe(false);
  });

  test("returns false for a string (primitives are not objects)", () => {
    expect(hasMessage("error string")).toBe(false);
  });

  test("narrows to { message: unknown }", () => {
    const v: unknown = { message: "hello" };
    if (hasMessage(v)) {
      expectTypeOf(v).toMatchTypeOf<{ message: unknown }>();
    }
  });
});

// =============================================================================
// Phase B — Serialization & formatting
// =============================================================================

// ---------------------------------------------------------------------------
// safeJsonStringify
// ---------------------------------------------------------------------------
describe("safeJsonStringify()", () => {
  test("returns a JSON string for a plain object", () => {
    const result = safeJsonStringify({ a: 1 });
    expect(typeof result).toBe("string");
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  test("returns a JSON string for an array", () => {
    const result = safeJsonStringify([1, 2, 3]);
    expect(JSON.parse(result)).toEqual([1, 2, 3]);
  });

  test("returns a JSON string for a primitive number", () => {
    expect(JSON.parse(safeJsonStringify(42))).toBe(42);
  });

  test("never throws for undefined", () => {
    expect(() => safeJsonStringify(undefined)).not.toThrow();
  });

  test("never throws for a function value", () => {
    expect(() => safeJsonStringify(() => {})).not.toThrow();
  });

  test("never throws for a circular reference", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    expect(() => safeJsonStringify(obj)).not.toThrow();
  });

  test("never throws for a BigInt value", () => {
    expect(() => safeJsonStringify(BigInt(42))).not.toThrow();
  });

  test("never throws for a Symbol value", () => {
    expect(() => safeJsonStringify(Symbol("foo"))).not.toThrow();
  });

  test("circular reference produces '[Circular]' in the output", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    const result = safeJsonStringify(obj);
    expect(result).toContain("[Circular]");
  });

  test("BigInt serializes as its string representation (not an error token)", () => {
    const result = safeJsonStringify(BigInt(42));
    expect(result).toContain("42");
  });

  test("Symbol description appears in the output", () => {
    const result = safeJsonStringify(Symbol("foo"));
    expect(result).toContain("foo");
  });

  test("Function serializes as empty string in the output", () => {
    const result = safeJsonStringify({ fn: () => {} });
    expect(result).toContain('""');
  });

  test("Map serializes to some JSON-compatible form (not '{}')", () => {
    const m = new Map([["key", "val"]]);
    const result = safeJsonStringify(m);
    // Must not serialize to the empty-object literal that JSON.stringify produces
    expect(result).not.toBe("{}");
  });

  test("Set serializes to some JSON-compatible array form", () => {
    const s = new Set([1, 2, 3]);
    const result = safeJsonStringify(s);
    // Should look like an array
    expect(result).toContain("[");
  });

  test("object nested beyond default depth of 10 produces [Max Depth] marker", () => {
    // Build an object nested 12 levels deep
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 12; i++) {
      deep = { child: deep };
    }
    const result = safeJsonStringify(deep);
    expect(result).toContain("[Max Depth]");
  });

  test("custom depth parameter is respected — depth 1 truncates nested objects", () => {
    const nested = { a: { b: { c: "deep" } } };
    const result = safeJsonStringify(nested, 1);
    expect(result).toContain("[Max Depth]");
  });

  test("returns a string (never throws) for null", () => {
    expect(() => safeJsonStringify(null)).not.toThrow();
    expect(safeJsonStringify(null)).toBe("null");
  });

  test("throws M3LError when depth is 0", () => {
    expect(() => safeJsonStringify({}, 0)).toThrow(M3LError);
  });

  test("throws M3LError when depth is negative", () => {
    expect(() => safeJsonStringify({}, -1)).toThrow(M3LError);
  });
});

// ---------------------------------------------------------------------------
// valueToString
// ---------------------------------------------------------------------------
describe("valueToString()", () => {
  test("returns a string for null", () => {
    expect(typeof valueToString(null)).toBe("string");
  });

  test("returns a string for undefined", () => {
    expect(typeof valueToString(undefined)).toBe("string");
  });

  test("returns a string for a number", () => {
    expect(typeof valueToString(42)).toBe("string");
  });

  test("returns a string for a plain object", () => {
    expect(typeof valueToString({ x: 1 })).toBe("string");
  });

  test("returns a string for an array", () => {
    expect(typeof valueToString([1, 2])).toBe("string");
  });

  test("returns a string for an Error", () => {
    expect(typeof valueToString(new Error("boom"))).toBe("string");
  });

  test("never throws for any input", () => {
    expect(() => valueToString(Symbol("s"))).not.toThrow();
    expect(() => valueToString(BigInt(1))).not.toThrow();
    expect(() => valueToString(() => {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M3LDateTokens
// ---------------------------------------------------------------------------
describe("M3LDateTokens.expand()", () => {
  test("expands a template with YYYY, MM, DD tokens to a valid date string", () => {
    const result = M3LDateTokens.expand("{YYYY}-{MM}-{DD}");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("{YYYY} expands to a 4-digit year", () => {
    const result = M3LDateTokens.expand("{YYYY}");
    expect(result).toMatch(/^\d{4}$/);
    const year = parseInt(result, 10);
    expect(year).toBeGreaterThanOrEqual(2000);
    expect(year).toBeLessThanOrEqual(9999);
  });

  test("{MM} expands to a zero-padded 2-digit month (01–12)", () => {
    const result = M3LDateTokens.expand("{MM}");
    expect(result).toMatch(/^\d{2}$/);
    const month = parseInt(result, 10);
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
  });

  test("{DD} expands to a zero-padded 2-digit day (01–31)", () => {
    const result = M3LDateTokens.expand("{DD}");
    expect(result).toMatch(/^\d{2}$/);
    const day = parseInt(result, 10);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
  });

  test("a template without tokens is returned unchanged", () => {
    const template = "no-tokens-here";
    expect(M3LDateTokens.expand(template)).toBe(template);
  });

  test("expand is a static method on M3LDateTokens", () => {
    type ExpandFn = (typeof M3LDateTokens)["expand"];
    expectTypeOf<ExpandFn>().toBeFunction();
  });
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------
describe("formatBytes()", () => {
  test("formats 0 bytes", () => {
    const result = formatBytes(0);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("formats 1024 bytes as a KB representation", () => {
    const result = formatBytes(1024);
    expect(result).toContain("KB");
  });

  test("formats 1048576 bytes as a MB representation", () => {
    const result = formatBytes(1048576);
    expect(result).toContain("MB");
  });

  test("formats a large value (GB range)", () => {
    const result = formatBytes(1073741824);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns a string for any byte count", () => {
    expect(typeof formatBytes(512)).toBe("string");
  });

  test("throws M3LError when bytes is negative", () => {
    expect(() => formatBytes(-1)).toThrow(M3LError);
  });

  test("throws M3LError when bytes is NaN", () => {
    expect(() => formatBytes(NaN)).toThrow(M3LError);
  });
});

// ---------------------------------------------------------------------------
// smartTruncate
// ---------------------------------------------------------------------------
describe("smartTruncate()", () => {
  test("returns the original string when shorter than maxLength", () => {
    const s = "short";
    expect(smartTruncate(s, 20)).toBe(s);
  });

  test("returns the original string when equal to maxLength", () => {
    const s = "exact";
    expect(smartTruncate(s, 5)).toBe(s);
  });

  test("returns a string not exceeding maxLength when input is longer", () => {
    const s = "a very long string that exceeds the limit";
    const result = smartTruncate(s, 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  test("returns a string (not the original) when truncation occurs", () => {
    const s = "a very long string that exceeds the limit";
    const result = smartTruncate(s, 10);
    expect(result).not.toBe(s);
  });

  test("throws M3LError when maxLength is 0", () => {
    expect(() => smartTruncate("hello", 0)).toThrow(M3LError);
  });
});

// ---------------------------------------------------------------------------
// truncatePath
// ---------------------------------------------------------------------------
describe("truncatePath()", () => {
  test("returns the original path when shorter than maxLength", () => {
    const p = "/short/path";
    expect(truncatePath(p, 50)).toBe(p);
  });

  test("returns a path-like string not exceeding maxLength for a long absolute path", () => {
    const p =
      "/very/long/absolute/path/that/exceeds/the/configured/max/length/limit";
    const result = truncatePath(p, 20);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test("returns a string (not the original) when truncation occurs", () => {
    const p =
      "/very/long/absolute/path/that/exceeds/the/configured/max/length/limit";
    const result = truncatePath(p, 20);
    expect(result).not.toBe(p);
  });

  test("throws M3LError when maxLength is 0", () => {
    expect(() => truncatePath("/some/path", 0)).toThrow(M3LError);
  });
});

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------
describe("truncateText()", () => {
  test("returns the original text when shorter than maxLength", () => {
    const t = "short text";
    expect(truncateText(t, 50)).toBe(t);
  });

  test("returns text not exceeding maxLength when input is longer", () => {
    const t = "a very long body of text that definitely exceeds the max length";
    const result = truncateText(t, 15);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  test("throws M3LError when maxLength is 0", () => {
    expect(() => truncateText("hello", 0)).toThrow(M3LError);
  });
});

// ---------------------------------------------------------------------------
// isPath
// ---------------------------------------------------------------------------
describe("isPath()", () => {
  test("returns true for an absolute path starting with /", () => {
    expect(isPath("/foo/bar")).toBe(true);
  });

  test("returns true for a relative path starting with ./", () => {
    expect(isPath("./foo")).toBe(true);
  });

  test("returns true for a parent-relative path starting with ../", () => {
    expect(isPath("../foo")).toBe(true);
  });

  test("returns false for a plain word string", () => {
    expect(isPath("hello")).toBe(false);
  });

  test("returns false for 'world'", () => {
    expect(isPath("world")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatConfigValueDisplay
// ---------------------------------------------------------------------------
describe("formatConfigValueDisplay()", () => {
  test("returns a string for a string value", () => {
    expect(typeof formatConfigValueDisplay("hello")).toBe("string");
  });

  test("returns a string for a number value", () => {
    expect(typeof formatConfigValueDisplay(42)).toBe("string");
  });

  test("returns a string for null", () => {
    expect(typeof formatConfigValueDisplay(null)).toBe("string");
  });

  test("returns a string for undefined", () => {
    expect(typeof formatConfigValueDisplay(undefined)).toBe("string");
  });

  test("returns a string for an object", () => {
    expect(typeof formatConfigValueDisplay({ key: "val" })).toBe("string");
  });

  test("returns a string for a boolean", () => {
    expect(typeof formatConfigValueDisplay(true)).toBe("string");
  });

  test("never throws for any input", () => {
    expect(() => formatConfigValueDisplay(Symbol("x"))).not.toThrow();
    expect(() => formatConfigValueDisplay(BigInt(1))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatConfigSourceDisplay
// ---------------------------------------------------------------------------
describe("formatConfigSourceDisplay()", () => {
  test("returns a string for a known source string", () => {
    expect(typeof formatConfigSourceDisplay("cli")).toBe("string");
  });

  test("returns a non-empty string for a known source string", () => {
    expect(formatConfigSourceDisplay("cli").length).toBeGreaterThan(0);
  });

  test("returns a string (not 'undefined') for undefined input", () => {
    const result = formatConfigSourceDisplay(undefined);
    expect(typeof result).toBe("string");
    expect(result).not.toBe("undefined");
  });

  test("returns a non-empty string for undefined input", () => {
    expect(formatConfigSourceDisplay(undefined).length).toBeGreaterThan(0);
  });

  test("returns a string for any source string", () => {
    expect(typeof formatConfigSourceDisplay("env")).toBe("string");
    expect(typeof formatConfigSourceDisplay("file")).toBe("string");
  });
});

// =============================================================================
// Phase C — Concurrency
// =============================================================================

// ---------------------------------------------------------------------------
// M3LConcurrencyPool
// ---------------------------------------------------------------------------
describe("M3LConcurrencyPool", () => {
  test("returns all results when concurrency equals item count", async () => {
    const pool = new M3LConcurrencyPool(3);
    const items = [1, 2, 3];
    const results = await pool.runEach(items, (x) => Promise.resolve(x * 2));
    expect(results).toEqual([2, 4, 6]);
  });

  test("preserves input order in results regardless of completion order", async () => {
    const pool = new M3LConcurrencyPool(2);
    // Item 3 resolves first (delay 0), item 1 resolves last (delay 30)
    const results = await pool.runEach([1, 2, 3], (x) => {
      const delay = x === 1 ? 30 : x === 2 ? 15 : 0;
      return new Promise<number>((resolve) =>
        setTimeout(() => {
          resolve(x);
        }, delay),
      );
    });
    // Must be [1, 2, 3] (input order), not [3, 2, 1] (completion order)
    expect(results).toEqual([1, 2, 3]);
  });

  test("returns an empty array for an empty items list", async () => {
    const pool = new M3LConcurrencyPool(4);
    const results = await pool.runEach([], () => Promise.resolve(0));
    expect(results).toEqual([]);
  });

  test("works with concurrency: 1 (fully serial execution)", async () => {
    const pool = new M3LConcurrencyPool(1);
    const order: number[] = [];

    await pool.runEach([1, 2, 3], (x) => {
      order.push(x);
      return Promise.resolve(x);
    });

    expect(order).toEqual([1, 2, 3]);
  });

  test("respects concurrency limit — at most N tasks run simultaneously", async () => {
    const concurrency = 2;
    const pool = new M3LConcurrencyPool(concurrency);
    let activeTasks = 0;
    let maxObservedConcurrency = 0;

    await pool.runEach([1, 2, 3, 4, 5], async (x) => {
      activeTasks++;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeTasks);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      activeTasks--;
      return x;
    });

    expect(maxObservedConcurrency).toBeLessThanOrEqual(concurrency);
  });

  test("first item's task starts before subsequent items' tasks (FIFO start order)", async () => {
    const pool = new M3LConcurrencyPool(1);
    const startOrder: number[] = [];

    await pool.runEach([10, 20, 30], (x) => {
      startOrder.push(x);
      return Promise.resolve(x);
    });

    expect(startOrder[0]).toBe(10);
    expect(startOrder).toEqual([10, 20, 30]);
  });

  test("worker rejection causes runEach to reject", async () => {
    const pool = new M3LConcurrencyPool(2);
    const items = [1, 2, 3];

    await expect(
      pool.runEach(items, (x) => {
        if (x === 2) return Promise.reject(new Error("worker failed on 2"));
        return Promise.resolve(x);
      }),
    ).rejects.toThrow("worker failed on 2");
  });

  test("runEach returns a Promise", () => {
    const pool = new M3LConcurrencyPool(2);
    const result = pool.runEach([1], (x) => Promise.resolve(x));
    expect(result).toBeInstanceOf(Promise);
  });

  test("throws M3LError when concurrency is 0", () => {
    expect(() => new M3LConcurrencyPool(0)).toThrow(M3LError);
  });

  test("throws M3LError when concurrency is negative", () => {
    expect(() => new M3LConcurrencyPool(-1)).toThrow(M3LError);
  });

  test("throws M3LError when concurrency is not an integer", () => {
    expect(() => new M3LConcurrencyPool(1.5)).toThrow(M3LError);
  });
});
