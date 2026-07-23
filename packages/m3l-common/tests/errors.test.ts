import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  M3L_ERROR_CODES,
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
import {
  classifyErrorCode,
  M3L_ERROR_CATALOG,
} from "../src/core/errors/catalog.js";
import type {
  M3LErrorOrigin,
  M3LErrorRetryable,
} from "../src/core/errors/catalog.js";
import type { M3LThresholdRuleValidationError } from "../src/core/analysis/M3LThresholdRuleValidationError.js";
import {
  M3LConfigMissingError,
  type M3LConfigCoercionError,
  type M3LConfigParseError,
  type M3LUnsafeConfigKeyError,
} from "../src/core/config/index.js";
import type { M3LEnvironmentDetectionError } from "../src/core/environment/index.js";
import { M3LFileCopyError } from "../src/core/files/index.js";
import type { M3LJSONFormatDetectionError } from "../src/core/json/index.js";
import type { M3LHttpClientError } from "../src/core/network/index.js";
import type { M3LPollExhaustedError } from "../src/internal/polling/errors.js";
import type { M3LPromptValidationError } from "../src/core/prompt/index.js";
import type { M3LPresetUnknownKeysError } from "../src/core/script/index.js";
import type { M3LAWSProvisioningError } from "../src/internal/script/M3LAWSProvisioningError.js";
import type { M3LFtsIndexError } from "../src/core/storage/index.js";
import type { M3LTextExtractionError } from "../src/core/text/index.js";

import type {
  M3LErrorCode,
  M3LErrorOptions,
  M3LResult,
  M3LResultErr,
  M3LResultOk,
} from "../src/core/errors/index.js";
import type { M3LAWSClientError } from "../src/aws/clients/error.js";
import type { M3LAWSCredentialsError } from "../src/aws/credentials/error.js";
import type { M3LAWSIdentityError } from "../src/aws/models/index.js";

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
// M3LError fault-origin classification (ADR-0035 phase 2)
//
// `origin`/`retryable` are resolved as: an explicit constructor option wins;
// otherwise derived from `classifyErrorCode(options.code)`; otherwise
// `undefined`. Both fields are definite (not optional) on the instance, but
// their TYPE includes `undefined` — required under `exactOptionalPropertyTypes`.
// ---------------------------------------------------------------------------
describe("M3LError fault-origin classification", () => {
  test("a built-in subclass reports its catalog classification with nothing passed by the caller", () => {
    const e = new M3LConfigMissingError("x");
    expect(e.origin).toBe("caller");
    expect(e.retryable).toBe(false);
  });

  test("a different built-in subclass reports a different catalog classification (not hardcoded)", () => {
    // ERR_FILE_COPY classifies as { origin: "external", retryable: false } —
    // a different origin than M3LConfigMissingError's "caller" above, proving
    // the resolution actually reads the catalog per-code rather than
    // returning a fixed value.
    expect(M3L_ERROR_CATALOG.ERR_FILE_COPY).toEqual({
      origin: "external",
      retryable: false,
    });
    const e = new M3LFileCopyError("copy failed");
    expect(e.origin).toBe("external");
    expect(e.retryable).toBe(false);
  });

  test("a bare M3LError with an unknown/unclassified code leaves both fields undefined", () => {
    const e = new M3LError("mystery failure", { code: "NOT_A_REAL_CODE" });
    expect(e.origin).toBeUndefined();
    expect(e.retryable).toBeUndefined();
  });

  test("an explicit origin/retryable option overrides the catalog classification", () => {
    // The catalog says ERR_HTTP_REQUEST is { origin: "external", retryable: true }.
    expect(M3L_ERROR_CATALOG.ERR_HTTP_REQUEST).toEqual({
      origin: "external",
      retryable: true,
    });
    const e = new M3LError("overridden classification", {
      code: "ERR_HTTP_REQUEST",
      origin: "caller",
      retryable: false,
    });
    // Assert both fields independently — an implementation could plumb one
    // and not the other.
    expect(e.origin).toBe("caller");
    expect(e.retryable).toBe(false);
  });

  test("toJSON carries origin and retryable", () => {
    const e = new M3LError("classified", { code: "ERR_HTTP_REQUEST" });
    const json = e.toJSON();
    expect(json.origin).toBe("external");
    expect(json.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3LErrorOptions / M3LError fault-origin fields — type-level contract
// ---------------------------------------------------------------------------
describe("M3LErrorOptions / M3LError fault-origin fields — type-level", () => {
  test("origin and retryable are optional on M3LErrorOptions", () => {
    expectTypeOf<M3LErrorOptions>().toExtend<{
      code: string;
      context?: Record<string, unknown>;
      cause?: unknown;
      origin?: M3LErrorOrigin;
      retryable?: M3LErrorRetryable;
    }>();
    // Omitting both must still satisfy the interface (required-ness check).
    expectTypeOf<{ code: string }>().toExtend<M3LErrorOptions>();
  });

  test("M3LError instance fields include undefined in their type (definite, not optional)", () => {
    expectTypeOf<M3LError["origin"]>().toEqualTypeOf<
      M3LErrorOrigin | undefined
    >();
    expectTypeOf<M3LError["retryable"]>().toEqualTypeOf<
      M3LErrorRetryable | undefined
    >();
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

  test("a wrap with a known catalog code picks up the catalog's fault-origin classification", () => {
    // wrapError constructs `new M3LError(message, { code, ... })` under the
    // hood — a known code must flow through the same catalog-resolution rule
    // M3LError itself applies.
    const wrapped = wrapError(new Error("upstream"), "s3 op failed", {
      code: "ERR_S3_OPERATION",
    });
    expect(M3L_ERROR_CATALOG.ERR_S3_OPERATION).toEqual({
      origin: "external",
      retryable: true,
    });
    expect(wrapped.origin).toBe("external");
    expect(wrapped.retryable).toBe(true);
  });

  test("an explicit origin and retryable override the catalog's classification, alongside context", () => {
    // ERR_HTTP_REQUEST's catalog entry disagrees with the values passed below
    // (origin "external", retryable true) so this cannot pass by the catalog
    // default alone — the explicit caller overrides must survive.
    expect(M3L_ERROR_CATALOG.ERR_HTTP_REQUEST).toEqual({
      origin: "external",
      retryable: true,
    });
    const wrapped = wrapError(new Error("upstream"), "request failed", {
      code: "ERR_HTTP_REQUEST",
      origin: "caller",
      retryable: false,
      context: { attempt: 2 },
    });
    expect(wrapped.origin).toBe("caller");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.context).toEqual({ attempt: 2 });
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
// M3LErrorCode — the built-in error-code union (SF-9 / WS-9)
// ---------------------------------------------------------------------------
describe("M3LErrorCode type", () => {
  test("is exactly the union of every built-in code the library emits", () => {
    // Tracks the M3L_ERROR_CODES const automatically — no hand-duplicated
    // literal union to fall out of sync when a code is added or removed.
    expectTypeOf<M3LErrorCode>().toEqualTypeOf<
      (typeof M3L_ERROR_CODES)[number]
    >();
  });

  test("does not accept an unrelated typo as a member", () => {
    expectTypeOf<"ERR_TYPO">().not.toMatchTypeOf<M3LErrorCode>();
  });

  test("is a finite union, not the general string type", () => {
    expectTypeOf<string>().not.toMatchTypeOf<M3LErrorCode>();
  });

  // -------------------------------------------------------------------------
  // Drift/completeness guard — every exported M3LError subclass that pins a
  // literal `code` must be assignable to M3LErrorCode. This fails the moment
  // a subclass's code is added without adding it to the union.
  // -------------------------------------------------------------------------
  test("every exported M3LError subclass's code is a member of M3LErrorCode", () => {
    expectTypeOf<
      M3LThresholdRuleValidationError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LConfigCoercionError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<M3LConfigParseError["code"]>().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LUnsafeConfigKeyError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LEnvironmentDetectionError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<M3LFileCopyError["code"]>().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LJSONFormatDetectionError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<M3LHttpClientError["code"]>().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<M3LPollExhaustedError["code"]>().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LPromptValidationError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LPresetUnknownKeysError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LAWSProvisioningError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<M3LFtsIndexError["code"]>().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LTextExtractionError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<M3LAWSClientError["code"]>().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<
      M3LAWSCredentialsError["code"]
    >().toMatchTypeOf<M3LErrorCode>();
    expectTypeOf<M3LAWSIdentityError["code"]>().toMatchTypeOf<M3LErrorCode>();
  });

  test("does not narrow M3LError.code itself, which stays string", () => {
    expectTypeOf<M3LError["code"]>().toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// Source-scan completeness guard — enumerates every literal error code
// actually emitted under `src/**/*.ts` and asserts it is EXACTLY the set in
// `M3L_ERROR_CODES`. Unlike the per-subclass drift guard above (which only
// checks the subclasses this file happens to import), this test walks the
// whole source tree, so a new code emitted anywhere — by any of the
// emission styles the codebase uses (`code: "X"`, `code = "X"`, or a
// `const FOO_CODE = "X"` referenced via `code: FOO_CODE`) — fails here the
// moment it is added without also updating `M3L_ERROR_CODES`, and a stale
// tuple member with no matching emission fails too.
// ---------------------------------------------------------------------------
describe("M3L_ERROR_CODES source-scan completeness", () => {
  function findSrcDir(): string {
    const testDir = dirname(fileURLToPath(import.meta.url));
    return join(testDir, "..", "src");
  }

  function listTsFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...listTsFiles(full));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(full);
      }
    }
    return files;
  }

  function isCommentLine(line: string): boolean {
    const trimmed = line.trimStart();
    return trimmed.startsWith("*") || trimmed.startsWith("//");
  }

  const CODE_COLON_RE = /\bcode\s*:\s*"([A-Z0-9_]+)"/g;
  // Assignment only (`code = "X"` / `this.code = "X"`) — the negative
  // lookbehind/lookahead excludes `==`/`===` comparisons like
  // `cause.code === "ENOENT"`, which check an *external* Node errno rather
  // than emitting one of this library's own codes.
  const CODE_ASSIGN_RE = /\bcode\s*(?<!=)=(?!=)\s*"([A-Z0-9_]+)"/g;
  const CONST_RE = /\bconst\s+(\w+)\s*=\s*"([A-Z0-9_]+)"/g;

  /**
   * A `code:`-shaped literal is a *type-position* value guard rather than a
   * value this library emits, e.g. `v is NodeJS.ErrnoException & { code:
   * "ENOENT" }` — the `NodeJS.ErrnoException` intersection is Node's own
   * errno shape, checked by a type predicate, never constructed by this
   * library. This is the only such shape in the source tree today; a new
   * one would need the same exclusion.
   */
  function isExternalErrnoTypeGuardLine(line: string): boolean {
    return line.includes("NodeJS.ErrnoException");
  }

  function scanEmittedCodes(srcDir: string): Set<string> {
    const colonCandidates = new Set<string>();
    const assigned = new Set<string>();
    const constCandidates = new Set<string>();

    for (const file of listTsFiles(srcDir)) {
      const content = readFileSync(file, "utf8");
      for (const rawLine of content.split("\n")) {
        if (isCommentLine(rawLine)) continue;

        if (!isExternalErrnoTypeGuardLine(rawLine)) {
          for (const match of rawLine.matchAll(CODE_COLON_RE)) {
            const code = match[1];
            if (code !== undefined) colonCandidates.add(code);
          }
        }
        for (const match of rawLine.matchAll(CODE_ASSIGN_RE)) {
          const code = match[1];
          if (code !== undefined) assigned.add(code);
        }
        for (const match of rawLine.matchAll(CONST_RE)) {
          const constName = match[1];
          const value = match[2];
          if (constName === undefined || value === undefined) continue;
          const nameLooksLikeCode = /code/i.test(constName);
          const valueLooksLikeCode =
            value.startsWith("ERR_") || value.startsWith("M3L_");
          if (nameLooksLikeCode || valueLooksLikeCode) {
            constCandidates.add(value);
          }
        }
      }
    }

    const codes = new Set<string>();
    for (const code of colonCandidates) codes.add(code);
    for (const code of assigned) codes.add(code);
    for (const code of constCandidates) codes.add(code);
    return codes;
  }

  test("every emitted code in src/**/*.ts is exactly M3L_ERROR_CODES (no drift either direction)", () => {
    const srcDir = findSrcDir();
    const scanned = scanEmittedCodes(srcDir);
    const declared = new Set<string>(M3L_ERROR_CODES);

    const missingFromTuple = [...scanned].filter((code) => !declared.has(code));
    const staleInTuple = [...declared].filter((code) => !scanned.has(code));

    expect(
      { missingFromTuple, staleInTuple },
      `Symmetric difference between src-emitted codes and M3L_ERROR_CODES.\n` +
        `In src but not in M3L_ERROR_CODES: ${JSON.stringify(missingFromTuple)}\n` +
        `In M3L_ERROR_CODES but not emitted in src: ${JSON.stringify(staleInTuple)}`,
    ).toEqual({ missingFromTuple: [], staleInTuple: [] });
  });

  // ADR-0035 §2.1: every built-in code must resolve to a defined
  // classification — a code present in M3L_ERROR_CODES but absent from
  // M3L_ERROR_CATALOG would otherwise silently resolve `origin`/`retryable`
  // to `undefined` for every instance of that code.
  test("every member of M3L_ERROR_CODES resolves to a defined classification via classifyErrorCode", () => {
    const unclassified = M3L_ERROR_CODES.filter(
      (code) => classifyErrorCode(code) === undefined,
    );
    expect(unclassified).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Teardown — ensure no lingering fake timers from test runs
// (none are used here, but added defensively for future extensions)
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks();
});
