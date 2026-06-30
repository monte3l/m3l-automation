import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  andThen,
  err,
  errorMessageContains,
  fromPromise,
  getErrorMessage,
  getErrorStack,
  hasErrorName,
  isErr,
  isOk,
  map,
  mapErr,
  M3LError,
  ok,
  toError,
  tryCatch,
  unwrap,
  unwrapOr,
  wrapError,
} from "../src/core/errors/index.js";

import type {
  M3LErrorOptions,
  M3LResult,
  M3LResultErr,
  M3LResultOk,
} from "../src/core/errors/index.js";

// ---------------------------------------------------------------------------
// M3LErrorOptions — interface shape (type-level only)
// ---------------------------------------------------------------------------
describe("M3LErrorOptions type", () => {
  test("accepts required code and optional context and cause", () => {
    expectTypeOf<M3LErrorOptions>().toExtend<{
      code: string;
      context?: Record<string, unknown>;
      cause?: unknown;
    }>();
  });

  test("code is required in M3LErrorOptions", () => {
    // The `code` field is required: a type with no `code` must not satisfy the interface.
    expectTypeOf<{
      context?: Record<string, unknown>;
    }>().not.toExtend<M3LErrorOptions>();
  });
});

// ---------------------------------------------------------------------------
// M3LError class
// ---------------------------------------------------------------------------
describe("M3LError class", () => {
  test("is an instance of Error", () => {
    const e = new M3LError("something went wrong", { code: "ERR_TEST" });
    expect(e).toBeInstanceOf(Error);
  });

  test("is an instance of M3LError", () => {
    const e = new M3LError("something went wrong", { code: "ERR_TEST" });
    expect(e).toBeInstanceOf(M3LError);
  });

  test("exposes the message passed to the constructor", () => {
    const e = new M3LError("disk full", { code: "ERR_DISK" });
    expect(e.message).toBe("disk full");
  });

  test("exposes the code from options", () => {
    const e = new M3LError("not found", { code: "ERR_NOT_FOUND" });
    expect(e.code).toBe("ERR_NOT_FOUND");
  });

  test("defaults context to an empty object when not provided", () => {
    const e = new M3LError("msg", { code: "ERR_X" });
    expect(e.context).toEqual({});
  });

  test("exposes the context when provided", () => {
    const ctx = { userId: "u1", attempt: 3 };
    const e = new M3LError("msg", { code: "ERR_X", context: ctx });
    expect(e.context).toEqual(ctx);
  });

  test("exposes cause when provided", () => {
    const root = new Error("root");
    const e = new M3LError("wrapper", { code: "ERR_W", cause: root });
    expect(e.cause).toBe(root);
  });

  test("cause defaults to undefined when not provided", () => {
    const e = new M3LError("msg", { code: "ERR_X" });
    expect(e.cause).toBeUndefined();
  });

  test("cause may be any unknown value, not just Error", () => {
    const e = new M3LError("msg", { code: "ERR_X", cause: 42 });
    expect(e.cause).toBe(42);
  });

  test("name equals 'M3LError' for a direct instantiation", () => {
    const e = new M3LError("msg", { code: "ERR_X" });
    expect(e.name).toBe("M3LError");
  });

  test("subclass name equals the subclass class name, not M3LError", () => {
    class FooError extends M3LError {}
    const e = new FooError("foo", { code: "ERR_FOO" });
    expect(e.name).toBe("FooError");
    expect(e).toBeInstanceOf(M3LError);
  });

  test("toJSON returns an object safe for JSON.stringify", () => {
    const e = new M3LError("msg", { code: "ERR_X", context: { a: 1 } });
    const json = e.toJSON();
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("toJSON includes name, message, code, context, cause, and stack", () => {
    const root = new Error("root");
    const e = new M3LError("wrapper", {
      code: "ERR_W",
      context: { key: "val" },
      cause: root,
    });
    const json = e.toJSON();
    expect(json.name).toBe("M3LError");
    expect(json.message).toBe("wrapper");
    expect(json.code).toBe("ERR_W");
    expect(json.context).toEqual({ key: "val" });
    expect(json.cause).toBe(root);
    // stack must be present (may be undefined in some environments, but the key must exist)
    expect(Object.prototype.hasOwnProperty.call(json, "stack")).toBe(true);
  });

  test("toJSON with an Error cause is safe for JSON.stringify (serialisation boundary)", () => {
    // Documents the intentional passthrough: a normal Error cause does not
    // break JSON.stringify because toJSON returns it verbatim, and the default
    // JSON serialiser converts an Error to {}.
    const cause = new Error("underlying io failure");
    const e = new M3LError("operation failed", {
      code: "ERR_IO",
      cause,
    });
    expect(() => JSON.stringify(e.toJSON())).not.toThrow();
  });

  test("toJSON on a subclass includes the subclass name", () => {
    class BarError extends M3LError {}
    const e = new BarError("bar msg", { code: "ERR_BAR" });
    const json = e.toJSON();
    expect(json.name).toBe("BarError");
  });

  test("constructs without Error.captureStackTrace (non-V8 runtimes)", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- capturing for restore in finally; reassigned back via Error.captureStackTrace = original, not called standalone
    const original = Error.captureStackTrace;
    // @ts-expect-error — exercising the absent-API branch on non-V8 runtimes
    delete Error.captureStackTrace;
    try {
      const e = new M3LError("boom", { code: "X" });
      expect(e).toBeInstanceOf(M3LError);
      expect(e.message).toBe("boom");
    } finally {
      Error.captureStackTrace = original;
    }
  });
});

// ---------------------------------------------------------------------------
// M3LResult discriminated union — type-level tests
// ---------------------------------------------------------------------------
describe("M3LResult type-level contract", () => {
  test("M3LResult<T,E> equals M3LResultOk<T> | M3LResultErr<E>", () => {
    expectTypeOf<M3LResult<number, Error>>().toEqualTypeOf<
      M3LResultOk<number> | M3LResultErr<Error>
    >();
  });

  test("M3LResultOk has discriminant ok:true and a value field", () => {
    expectTypeOf<M3LResultOk<string>>().toExtend<{ ok: true; value: string }>();
  });

  test("M3LResultErr has discriminant ok:false and an error field", () => {
    expectTypeOf<M3LResultErr<Error>>().toExtend<{ ok: false; error: Error }>();
  });

  test("isOk narrows a M3LResult to M3LResultOk inside the branch", () => {
    const r: M3LResult<number, Error> = ok(1);
    if (isOk(r)) {
      expectTypeOf(r).toEqualTypeOf<M3LResultOk<number>>();
      expectTypeOf(r.value).toBeNumber();
    }
  });

  test("isErr narrows a M3LResult to M3LResultErr inside the branch", () => {
    const r: M3LResult<number, Error> = err(new Error("e"));
    if (isErr(r)) {
      expectTypeOf(r).toEqualTypeOf<M3LResultErr<Error>>();
      expectTypeOf(r.error).toEqualTypeOf<Error>();
    }
  });

  test("err carries the full error channel type", () => {
    expectTypeOf(err(new Error("x"))).toExtend<{ ok: false; error: Error }>();
  });

  test("ok carries the full value channel type", () => {
    expectTypeOf(ok(42)).toExtend<{ ok: true; value: number }>();
  });
});

// ---------------------------------------------------------------------------
// ok / err constructors
// ---------------------------------------------------------------------------
describe("ok()", () => {
  test("returns { ok: true, value } for a primitive", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  test("returns { ok: true, value } for an object", () => {
    const val = { x: 1 };
    expect(ok(val)).toEqual({ ok: true, value: val });
  });

  test("wraps null without coercing it", () => {
    expect(ok(null)).toEqual({ ok: true, value: null });
  });
});

describe("err()", () => {
  test("returns { ok: false, error } for an Error", () => {
    const e = new Error("boom");
    expect(err(e)).toEqual({ ok: false, error: e });
  });

  test("returns { ok: false, error } for a non-Error value", () => {
    expect(err("fail")).toEqual({ ok: false, error: "fail" });
  });
});

// ---------------------------------------------------------------------------
// isOk / isErr guards
// ---------------------------------------------------------------------------
describe("isOk()", () => {
  test("returns true for an ok result", () => {
    expect(isOk(ok(1))).toBe(true);
  });

  test("returns false for an err result", () => {
    expect(isOk(err(new Error()))).toBe(false);
  });
});

describe("isErr()", () => {
  test("returns true for an err result", () => {
    expect(isErr(err("nope"))).toBe(true);
  });

  test("returns false for an ok result", () => {
    expect(isErr(ok("yes"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unwrap
// ---------------------------------------------------------------------------
describe("unwrap()", () => {
  test("returns the value for an ok result", () => {
    expect(unwrap(ok(99))).toBe(99);
  });

  test("throws an M3LError for an err result", () => {
    expect(() => unwrap(err(new Error("boom")))).toThrow(M3LError);
  });

  test("the thrown M3LError carries the original err value", () => {
    const inner = new Error("inner cause");
    let thrown: unknown;
    try {
      unwrap(err(inner));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    // The err value must be reachable from the thrown error (via cause or message).
    // We check cause since the contract says "the err value must be carried".
    expect((thrown as M3LError).cause).toBe(inner);
  });

  test("works with any value type in the ok variant", () => {
    const obj = { nested: true };
    expect(unwrap(ok(obj))).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// unwrapOr
// ---------------------------------------------------------------------------
describe("unwrapOr()", () => {
  test("returns the value for an ok result", () => {
    expect(unwrapOr(ok(7), 0)).toBe(7);
  });

  test("returns the fallback for an err result", () => {
    expect(unwrapOr(err(new Error()), 42)).toBe(42);
  });

  test("does not call any function — fallback is a plain value", () => {
    // Ensure the signature accepts a plain value, not a thunk.
    const fallback = "default";
    const result = unwrapOr(err("fail"), fallback);
    expect(result).toBe(fallback);
  });
});

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------
describe("map()", () => {
  test("applies fn to the value and returns a new ok result", () => {
    expect(map(ok(3), (x) => x * 2)).toEqual(ok(6));
  });

  test("passes an err result through unchanged without calling fn", () => {
    const fn = vi.fn();
    const e = err(new Error("x"));
    const result = map(e, fn);
    expect(result).toEqual(e);
    expect(fn).not.toHaveBeenCalled();
  });

  test("the mapped type reflects the return type of fn", () => {
    const r = map(ok(1), (n: number) => String(n));
    expectTypeOf(r).toExtend<M3LResult<string, never>>();
  });

  test("ok-overload: map on M3LResultOk returns M3LResultOk (narrow preserved)", () => {
    expectTypeOf(map(ok(1), (n: number) => String(n))).toEqualTypeOf<
      M3LResultOk<string>
    >();
  });

  test("err-overload: map on M3LResultErr returns M3LResultErr unchanged (narrow preserved)", () => {
    const e = err(new Error("x"));
    expectTypeOf(map(e, (n: number) => n)).toEqualTypeOf<M3LResultErr<Error>>();
  });
});

// ---------------------------------------------------------------------------
// mapErr
// ---------------------------------------------------------------------------
describe("mapErr()", () => {
  test("applies fn to the error and returns a new err result", () => {
    const r = mapErr(err("raw"), (s) => new Error(s));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.message).toBe("raw");
    }
  });

  test("passes an ok result through unchanged without calling fn", () => {
    const fn = vi.fn();
    const o = ok(5);
    const result = mapErr(o, fn);
    expect(result).toEqual(o);
    expect(fn).not.toHaveBeenCalled();
  });

  test("the mapped type reflects the return type of fn", () => {
    const r = mapErr(err(42), (n: number) => String(n));
    expectTypeOf(r).toExtend<M3LResult<never, string>>();
  });

  test("ok-overload: mapErr on M3LResultOk returns M3LResultOk unchanged (narrow preserved)", () => {
    expectTypeOf(mapErr(ok(5), (e: Error) => e.message)).toEqualTypeOf<
      M3LResultOk<number>
    >();
  });

  test("err-overload: mapErr on M3LResultErr returns M3LResultErr with mapped error type", () => {
    expectTypeOf(
      mapErr(err(new Error("x")), (e: Error) => e.message),
    ).toEqualTypeOf<M3LResultErr<string>>();
  });
});

// ---------------------------------------------------------------------------
// andThen
// ---------------------------------------------------------------------------
describe("andThen()", () => {
  test("calls fn with the value and returns fn's result for ok", () => {
    const r = andThen(ok(4), (n) => ok(n + 1));
    expect(r).toEqual(ok(5));
  });

  test("flat-maps — does not double-wrap the result", () => {
    const r = andThen(ok(1), (n) => ok(n * 10));
    // Must be M3LResultOk<number>, not M3LResultOk<M3LResultOk<number>>
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(typeof r.value).toBe("number");
    }
  });

  test("passes an err result through unchanged without calling fn", () => {
    const fn = vi.fn();
    const e = err(new Error("upstream"));
    const result = andThen(e, fn);
    expect(result).toEqual(e);
    expect(fn).not.toHaveBeenCalled();
  });

  test("fn can return an err to signal failure in the chain", () => {
    const r = andThen(ok(0), () => err("blocked"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toBe("blocked");
    }
  });
});

// ---------------------------------------------------------------------------
// fromPromise
// ---------------------------------------------------------------------------
describe("fromPromise()", () => {
  test("resolves to ok(value) when the promise fulfils", async () => {
    const r = await fromPromise(Promise.resolve("hello"));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toBe("hello");
    }
  });

  test("resolves to err(M3LError) when the promise rejects with an Error", async () => {
    const r = await fromPromise(Promise.reject(new Error("nope")));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toBeInstanceOf(M3LError);
    }
  });

  test("resolves to err(M3LError) when the promise rejects with a non-Error value", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally rejecting with a non-Error to verify fromPromise normalizes it to M3LError
    const r = await fromPromise(Promise.reject("string rejection"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toBeInstanceOf(M3LError);
    }
  });

  test("the error result type is M3LResult<T, M3LError>", async () => {
    const r = await fromPromise(Promise.resolve(1));
    expectTypeOf(r).toExtend<M3LResult<number, M3LError>>();
  });

  test("itself never rejects — rejection becomes err, not an uncaught promise", async () => {
    await expect(
      fromPromise(Promise.reject(new Error("x"))),
    ).resolves.toBeDefined();
  });

  test("returns the original M3LError unwrapped when the promise rejects with one", async () => {
    const original = new M3LError("already typed", { code: "TYPED_ERR" });
    const r = await fromPromise(Promise.reject(original));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toBe(original);
      expect(r.error.code).toBe("TYPED_ERR");
    }
  });
});

// ---------------------------------------------------------------------------
// tryCatch
// ---------------------------------------------------------------------------
describe("tryCatch()", () => {
  test("returns ok(value) when fn completes normally", () => {
    const r = tryCatch(() => 123);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toBe(123);
    }
  });

  test("returns err(thrownValue) when fn throws", () => {
    const boom = new Error("boom");
    const r = tryCatch(() => {
      throw boom;
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toBe(boom);
    }
  });

  test("does NOT normalize the thrown value — err type is unknown", () => {
    const r = tryCatch(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentionally throwing a non-Error to verify tryCatch captures it un-normalized (unknown channel)
      throw "a string";
    });
    // The error channel is `unknown`, not `M3LError`
    expectTypeOf(r).toExtend<M3LResult<never, unknown>>();
    if (isErr(r)) {
      expect(r.error).toBe("a string");
    }
  });

  test("captures non-Error thrown values as-is", () => {
    const r = tryCatch(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentionally throwing a non-Error to verify tryCatch captures it un-normalized (unknown channel)
      throw 42;
    });
    if (isErr(r)) {
      expect(r.error).toBe(42);
    }
  });

  test("works with a fn that returns a complex type", () => {
    const r = tryCatch(() => ({ items: [1, 2, 3] }));
    if (isOk(r)) {
      expect(r.value.items).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// getErrorMessage
// ---------------------------------------------------------------------------
describe("getErrorMessage()", () => {
  test("returns .message for an Error instance", () => {
    expect(getErrorMessage(new Error("test message"))).toBe("test message");
  });

  test("returns the string itself for a string input", () => {
    expect(getErrorMessage("raw string error")).toBe("raw string error");
  });

  test("returns a safe string for a non-Error, non-string value", () => {
    const result = getErrorMessage(42);
    expect(typeof result).toBe("string");
  });

  test("returns a safe string for null", () => {
    expect(typeof getErrorMessage(null)).toBe("string");
  });

  test("returns a safe string for undefined", () => {
    expect(typeof getErrorMessage(undefined)).toBe("string");
  });

  test("never throws regardless of input", () => {
    expect(() => getErrorMessage(Symbol("s"))).not.toThrow();
    expect(() => getErrorMessage({})).not.toThrow();
    expect(() => getErrorMessage([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// toError
// ---------------------------------------------------------------------------
describe("toError()", () => {
  test("returns the same Error instance when given an Error", () => {
    const e = new Error("original");
    expect(toError(e)).toBe(e);
  });

  test("returns a new Error wrapping the value when given a non-Error", () => {
    const result = toError("plain string");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("plain string");
  });

  test("handles numeric input by wrapping it in a new Error", () => {
    const result = toError(999);
    expect(result).toBeInstanceOf(Error);
  });

  test("handles null by wrapping it in a new Error", () => {
    expect(toError(null)).toBeInstanceOf(Error);
  });

  test("handles undefined by wrapping it in a new Error", () => {
    expect(toError(undefined)).toBeInstanceOf(Error);
  });

  test("handles an object by wrapping it in a new Error", () => {
    expect(toError({ code: 1 })).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// wrapError
// ---------------------------------------------------------------------------
describe("wrapError()", () => {
  test("always returns an M3LError", () => {
    const wrapped = wrapError(new Error("root"), "wrapper message", {
      code: "ERR_WRAP",
    });
    expect(wrapped).toBeInstanceOf(M3LError);
  });

  test("chains the original failure as cause", () => {
    const root = new Error("disk full");
    const wrapped = wrapError(root, "failed to write", { code: "ERR_WRITE" });
    expect(wrapped.cause).toBe(root);
  });

  test("sets the message to the provided message", () => {
    const wrapped = wrapError(new Error(), "context message", {
      code: "ERR_CTX",
    });
    expect(wrapped.message).toBe("context message");
  });

  test("sets the code from options", () => {
    const wrapped = wrapError(new Error(), "msg", { code: "ERR_CODE_TEST" });
    expect(wrapped.code).toBe("ERR_CODE_TEST");
  });

  test("passes context through when provided", () => {
    const wrapped = wrapError(new Error(), "msg", {
      code: "ERR_CTX",
      context: { attempt: 2 },
    });
    expect(wrapped.context).toEqual({ attempt: 2 });
  });

  test("uses the default code when no options are supplied", () => {
    // The third argument (options) is entirely optional; when omitted, the
    // implementation must supply a sensible default code rather than throwing.
    const wrapped = wrapError(new Error("root"), "msg");
    expect(wrapped).toBeInstanceOf(M3LError);
  });

  test("can wrap a non-Error cause (unknown type)", () => {
    const wrapped = wrapError("string cause", "wrapping a string", {
      code: "ERR_STR",
    });
    expect(wrapped).toBeInstanceOf(M3LError);
    expect(wrapped.cause).toBe("string cause");
  });
});

// ---------------------------------------------------------------------------
// getErrorStack
// ---------------------------------------------------------------------------
describe("getErrorStack()", () => {
  test("returns the .stack string for an Error that has one", () => {
    const e = new Error("with stack");
    if (e.stack !== undefined) {
      expect(getErrorStack(e)).toBe(e.stack);
    } else {
      // In environments where stack is absent, we just verify it doesn't throw.
      expect(getErrorStack(e)).toBeUndefined();
    }
  });

  test("returns undefined for a non-Error value", () => {
    expect(getErrorStack("not an error")).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(getErrorStack(null)).toBeUndefined();
  });

  test("returns undefined for a plain object without .stack", () => {
    expect(getErrorStack({ message: "no stack" })).toBeUndefined();
  });

  test("never throws regardless of input", () => {
    expect(() => getErrorStack(42)).not.toThrow();
    expect(() => getErrorStack(undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hasErrorName
// ---------------------------------------------------------------------------
describe("hasErrorName()", () => {
  test("returns true when error.name matches the given name", () => {
    const e = new Error("test");
    expect(hasErrorName(e, "Error")).toBe(true);
  });

  test("returns true for a custom-named error", () => {
    const e = new M3LError("msg", { code: "ERR_X" });
    expect(hasErrorName(e, "M3LError")).toBe(true);
  });

  test("returns false when error.name does not match", () => {
    const e = new Error("test");
    expect(hasErrorName(e, "TypeError")).toBe(false);
  });

  test("returns false for a non-object value", () => {
    expect(hasErrorName(42, "Error")).toBe(false);
  });

  test("returns false for null", () => {
    expect(hasErrorName(null, "Error")).toBe(false);
  });

  test("returns false for a plain object without .name", () => {
    expect(hasErrorName({}, "Error")).toBe(false);
  });

  test("never throws regardless of input", () => {
    expect(() => hasErrorName(undefined, "Error")).not.toThrow();
    expect(() => hasErrorName(Symbol("s"), "Error")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// errorMessageContains
// ---------------------------------------------------------------------------
describe("errorMessageContains()", () => {
  test("returns true when the message contains the substring", () => {
    expect(errorMessageContains(new Error("disk full"), "disk")).toBe(true);
  });

  test("returns false when the message does not contain the substring", () => {
    expect(errorMessageContains(new Error("disk full"), "network")).toBe(false);
  });

  test("works with a string error value", () => {
    expect(errorMessageContains("quota exceeded", "quota")).toBe(true);
  });

  test("returns false when the string does not contain the substring", () => {
    expect(errorMessageContains("quota exceeded", "timeout")).toBe(false);
  });

  test("returns a safe boolean for a non-Error, non-string value", () => {
    const result = errorMessageContains(42, "42");
    expect(typeof result).toBe("boolean");
  });

  test("never throws regardless of input", () => {
    expect(() => errorMessageContains(null, "x")).not.toThrow();
    expect(() => errorMessageContains(undefined, "x")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Teardown — ensure no lingering fake timers from test runs
// (none are used here, but added defensively for future extensions)
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks();
});
