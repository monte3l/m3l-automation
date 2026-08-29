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
  M3LOperationAbortedError,
  ok,
  toError,
  tryCatch,
  unwrap,
  unwrapOr,
  wrapError,
} from "../src/core/errors/index.js";
import {
  classifyErrorCode,
  isM3LErrorCode,
  M3L_ERROR_CATALOG,
} from "../src/core/errors/catalog.js";
import type {
  M3LErrorOrigin,
  M3LErrorRetryable,
} from "../src/core/errors/catalog.js";
import type { M3LThresholdRuleValidationError } from "../src/core/analysis/M3LThresholdRuleValidationError.js";
import type { M3LCheckpointError } from "../src/core/checkpoint/index.js";
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
  M3LErrorCauseJSON,
  M3LErrorCode,
  M3LErrorJSON,
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
    // F31: a foreign (non-M3LError) cause is allowlisted down to its `name`
    // only — never returned by reference, which would leak every
    // own-enumerable property of the original Error (see the SDK-shape
    // regression test below).
    expect(json.cause).toEqual({ name: "Error" });
    // stack must be present (may be undefined in some environments, but the key must exist)
    expect(Object.prototype.hasOwnProperty.call(json, "stack")).toBe(true);
  });

  test("toJSON allowlists a foreign Error cause to its name only", () => {
    // F31: a plain (non-M3LError) Error cause is normalized to
    // `{ name: cause.name }` — no `message`, no other own-enumerable
    // properties survive. This retires the old "verbatim passthrough is
    // intentional" documentation: a caught SDK exception can carry
    // sensitive own-enumerable fields (headers, response bodies) that must
    // never reach a log or run report by reference.
    const cause = new Error("underlying io failure");
    const e = new M3LError("operation failed", {
      code: "ERR_IO",
      cause,
    });
    const json = e.toJSON();
    expect(json.cause).toEqual({ name: cause.name });
    expect(() => JSON.stringify(json)).not.toThrow();
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
// F31 (GitHub #727) — toJSON().cause allowlist
//
// `toJSON()`'s `cause` field must never expose an arbitrary foreign value's
// own-enumerable properties by reference. It is normalized to:
//   - undefined                    -> undefined
//   - instanceof M3LError          -> recursed M3LErrorJSON (capped depth)
//   - instanceof Error (not M3LError) -> { name: cause.name } only
//   - anything else                -> { name: <safe type identifier> } only
// `name`/`message`/`code`/`context`/`stack`/`origin`/`retryable` on M3LError
// itself are unchanged by this fix.
// ---------------------------------------------------------------------------
describe("M3LError toJSON cause allowlist (F31)", () => {
  // gitleaks scans source literals, not runtime-built strings — assembling
  // planted secret markers at runtime keeps these fixtures from reading as
  // real credentials while still proving the leak-shaped path.
  const SECRET_PART_A = "SECRET_";
  const SECRET_PART_B = "abc123XYZ";
  const PLANTED_SECRET = SECRET_PART_A + SECRET_PART_B;
  const AUTH_PREFIX = "Bear" + "er ";

  test("[security] a smithy-ServiceException-shaped cause never leaks its own-enumerable fields", () => {
    // Faithfully reproduces the shape of a caught AWS SDK ServiceException:
    // own-enumerable $fault/$response/$metadata, plus `message` assigned as a
    // plain property post-construction (not via the Error constructor) —
    // exactly the shape that leaked verbatim under the pre-fix `cause: this.cause`.
    class FakeServiceException extends Error {
      readonly $fault: "client" | "server" = "client";
      readonly $response: {
        statusCode: number;
        headers: Record<string, string>;
        body: string;
      };
      readonly $metadata: { requestId: string } = { requestId: "req-123" };

      constructor() {
        super(undefined);
        this.name = "ValidationException";
        this.$response = {
          statusCode: 400,
          headers: { authorization: AUTH_PREFIX + PLANTED_SECRET },
          body: PLANTED_SECRET,
        };
      }
    }
    const sdkException = new FakeServiceException();
    // message set as a plain enumerable property, as SDK response unmarshalling does.
    Object.defineProperty(sdkException, "message", {
      value: `validation failed: ${PLANTED_SECRET}`,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const wrapper = new M3LError("sdk call failed", {
      code: "ERR_AWS_CLIENT",
      cause: sdkException,
    });

    const serialized = JSON.stringify(wrapper.toJSON());
    expect(serialized).not.toContain(PLANTED_SECRET);
    expect(serialized).not.toContain(AUTH_PREFIX + PLANTED_SECRET);
    expect(serialized).not.toContain("$response");
    expect(serialized).not.toContain("$fault");
    expect(serialized).not.toContain("$metadata");
    // The safe discriminator (name) does survive.
    expect(serialized).toContain("ValidationException");
  });

  test("a chained M3LError cause recurses to the nested error's full JSON shape", () => {
    const inner = new M3LError("inner failure", {
      code: "ERR_INNER",
      context: { x: 1 },
      origin: "external",
      retryable: true,
    });
    const outer = new M3LError("outer failure", {
      code: "ERR_OUTER",
      cause: inner,
    });

    expect(outer.toJSON().cause).toEqual(inner.toJSON());
    expect(outer.toJSON().cause).toMatchObject({
      name: "M3LError",
      message: "inner failure",
      code: "ERR_INNER",
      context: { x: 1 },
      origin: "external",
      retryable: true,
    });
  });

  test("[cycle guard] a genuine cause cycle does not infinite-loop and JSON.stringify succeeds", () => {
    const a = new M3LError("a", { code: "ERR_A" });
    const b = new M3LError("b", { code: "ERR_B", cause: a });
    // `cause` is `readonly` at the TYPE level only — M3LError never freezes
    // its instances, so this direct mutation creates a genuine runtime
    // reference cycle (a.cause -> b -> a) to prove the cycle guard, not just
    // the depth cap below.
    (a as unknown as { cause: unknown }).cause = b;

    expect(() => JSON.stringify(a.toJSON())).not.toThrow();
  });

  test("a chain of M3LErrors deeper than the recursion cap terminates without throwing", () => {
    const DEPTH = 20;
    let current = new M3LError("level-0", { code: "ERR_LEVEL" });
    for (let level = 1; level <= DEPTH; level += 1) {
      current = new M3LError(`level-${String(level)}`, {
        code: "ERR_LEVEL",
        context: { level },
        cause: current,
      });
    }

    let serialized = "";
    expect(() => {
      serialized = JSON.stringify(current.toJSON());
    }).not.toThrow();
    expect(serialized.length).toBeGreaterThan(0);

    // The load-bearing assertion for "there is a depth cap": walk the cause
    // chain in the JSON output and require that *some* level before the
    // bottom collapses to the terminal { name }-only shape rather than
    // carrying `code`/`context` all the way down. A numeric byte-size bound
    // is deliberately not asserted here — the implementer's chosen cap value
    // isn't part of this contract, only that one exists.
    let node: M3LErrorJSON | M3LErrorCauseJSON | undefined = current.toJSON();
    let sawTerminalCollapse = false;
    for (let i = 0; i < DEPTH + 1 && node !== undefined; i += 1) {
      if (!("code" in node)) {
        sawTerminalCollapse = true;
        expect(Object.keys(node)).toEqual(["name"]);
        break;
      }
      node = node.cause;
    }
    expect(sawTerminalCollapse).toBe(true);
  });

  test("a plain object cause is allowlisted to a safe constructor-derived name only", () => {
    const secretField = SECRET_PART_A + "planted-in-object";
    const objectCause = { token: secretField, nested: { apiKey: secretField } };
    const e = new M3LError("op failed", { code: "ERR_X", cause: objectCause });

    const json = e.toJSON();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(secretField);
    expect(json.cause).toEqual({ name: "Object" });
  });

  test("a string cause is allowlisted, never returned verbatim", () => {
    const secretString = SECRET_PART_A + "planted-in-string";
    const e = new M3LError("op failed", { code: "ERR_X", cause: secretString });

    const serialized = JSON.stringify(e.toJSON());
    expect(serialized).not.toContain(secretString);
  });

  test("a null cause is allowlisted to a safe fixed shape, not passed through", () => {
    const e = new M3LError("op failed", { code: "ERR_X", cause: null });
    const json = e.toJSON();
    expect(json.cause).not.toBeNull();
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("an undefined cause resolves to an undefined cause field", () => {
    const e = new M3LError("op failed", { code: "ERR_X" });
    expect(e.toJSON().cause).toBeUndefined();
  });

  test("a null-prototype object cause does not throw and falls back to a safe fixed name", () => {
    const nullProtoCause = Object.create(null) as Record<string, unknown>;
    nullProtoCause["token"] = SECRET_PART_A + "planted-null-proto";
    const e = new M3LError("op failed", {
      code: "ERR_X",
      cause: nullProtoCause,
    });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = e.toJSON();
    }).not.toThrow();
    expect(() => JSON.stringify(json)).not.toThrow();
    expect(JSON.stringify(json)).not.toContain("planted-null-proto");
  });

  test("a Symbol cause does not throw and is allowlisted to a safe fixed shape", () => {
    const e = new M3LError("op failed", {
      code: "ERR_X",
      cause: Symbol("planted"),
    });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = e.toJSON();
    }).not.toThrow();
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("[hostile] a cause whose `name` getter throws does not propagate and falls back to a safe string", () => {
    class HostileName extends Error {
      override get name(): string {
        throw new Error("hostile name getter");
      }
    }
    const hostileCause = new HostileName("boom");
    const e = new M3LError("op failed", { code: "ERR_X", cause: hostileCause });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = e.toJSON();
    }).not.toThrow();
    // readNameSafely's catch swallows the throw and returns undefined;
    // deriveErrorCauseName falls through to the safe constructor-derived
    // name instead of some unsafe raw value.
    expect(json?.cause).toEqual({ name: "HostileName" });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("[hostile] a cause whose `constructor` getter throws does not propagate and falls back to a safe string", () => {
    const hostileCause: Record<string, unknown> = {};
    Object.defineProperty(hostileCause, "constructor", {
      get() {
        throw new Error("hostile constructor getter");
      },
      enumerable: false,
      configurable: true,
    });
    const e = new M3LError("op failed", { code: "ERR_X", cause: hostileCause });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = e.toJSON();
    }).not.toThrow();
    // The throwing `constructor` getter is an OWN property of `hostileCause`,
    // not of its prototype -- readConstructorNameSafely reads
    // Object.getPrototypeOf(value).constructor, which resolves the untouched
    // Object.prototype.constructor and never trips the throwing getter at
    // all. This confirms the safe reader is immune to a poisoned own
    // `constructor` property, landing on the plain "Object" name.
    expect(json?.cause).toEqual({ name: "Object" });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("a cause whose prototype's own `constructor` is not a function falls back to a safe fixed name", () => {
    // Covers readConstructorNameSafely's `typeof constructor !== "function"`
    // branch: the prototype chain resolves cleanly, but the resolved
    // `constructor` property itself is a non-function value.
    const weirdProto: Record<string, unknown> = { constructor: 123 };
    const weirdCause: object = Object.create(weirdProto) as object;
    const e = new M3LError("op failed", { code: "ERR_X", cause: weirdCause });

    const json = e.toJSON();
    expect(json.cause).toEqual({ name: "[unknown]" });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("[hostile] a Proxy whose `getPrototypeOf` trap throws is safely rejected by both instanceof guards and the constructor-name reader", () => {
    // A single fixture exercises three independent catch blocks: `instanceof
    // M3LError` and `instanceof Error` both walk the prototype chain via
    // [[GetPrototypeOf]], so a throwing trap trips isM3LErrorInstance's and
    // isErrorInstance's catch clauses; falling through to the foreign-cause
    // path then trips readConstructorNameSafely's own catch via
    // Object.getPrototypeOf.
    const hostileProxyCause: object = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          throw new Error("hostile getPrototypeOf trap");
        },
      },
    );
    const e = new M3LError("op failed", {
      code: "ERR_X",
      cause: hostileProxyCause,
    });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = e.toJSON();
    }).not.toThrow();
    expect(json?.cause).toEqual({ name: "[unknown]" });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("[security] a foreign Error cause with an unsafe `.name` (smuggled text) falls back to its constructor name, not the raw name", () => {
    // Covers readNameSafely's ternary false-path: `.name` is present as a
    // string but fails the identifier-shaped safety check (here: a colon,
    // spaces, and `=` — exactly the "smuggled text in .name" shape the F31
    // security contract calls out). The derived constructor name is used
    // instead, and the planted secret must never survive into the JSON.
    class NamedButUnsafe extends Error {}
    const hostileNamedCause = new NamedButUnsafe("boom");
    hostileNamedCause.name = "Error: token=" + PLANTED_SECRET;

    const e = new M3LError("op failed", {
      code: "ERR_X",
      cause: hostileNamedCause,
    });

    const json = e.toJSON();
    expect(json.cause).toEqual({ name: "NamedButUnsafe" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(PLANTED_SECRET);
  });

  test("[security] a foreign cause whose derived constructor name is unsafe falls back to the safe fixed name", () => {
    // Covers readConstructorNameSafely's own ternary false-path: the
    // constructor is a real function, but its `.name` was reassigned to
    // smuggled, non-identifier-shaped text. This is exercised on the
    // foreign-object path (not deriveErrorCauseName's fallback) so it is
    // distinct from the "both readers fail" case below.
    function EvilCtor(): void {
      /* no-op */
    }
    Object.defineProperty(EvilCtor, "name", {
      value: "Evil Ctor=" + PLANTED_SECRET,
      configurable: true,
    });
    const evilProto: Record<string, unknown> = { constructor: EvilCtor };
    const evilCause: object = Object.create(evilProto) as object;

    const e = new M3LError("op failed", { code: "ERR_X", cause: evilCause });

    const json = e.toJSON();
    expect(json.cause).toEqual({ name: "[unknown]" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(PLANTED_SECRET);
  });

  test("a foreign Error cause where both the own name and the derived constructor name are unsafe falls back to the fixed literal 'Error'", () => {
    // Covers deriveErrorCauseName's final `?? "Error"` fallback: both
    // readNameSafely(cause) and readConstructorNameSafely(cause) must return
    // undefined for this to fire. The instance's own `.name` is overwritten
    // with unsafe text, and the class's own `.name` (which the constructor
    // reader falls back to) is also reassigned to unsafe text.
    class HostileBoth extends Error {}
    Object.defineProperty(HostileBoth, "name", {
      value: "Hostile Ctor=" + PLANTED_SECRET,
      configurable: true,
    });
    const hostileBothCause = new HostileBoth("boom");
    hostileBothCause.name = SECRET_PART_A + "=" + SECRET_PART_B;

    const e = new M3LError("op failed", {
      code: "ERR_X",
      cause: hostileBothCause,
    });

    const json = e.toJSON();
    expect(json.cause).toEqual({ name: "Error" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(PLANTED_SECRET);
  });

  test("[hostile] a Proxy wrapping a genuine M3LError whose `get` trap throws is rejected by the WeakSet identity check and degrades via the foreign-Error branch", () => {
    // `real` is genuinely constructed (added to GENUINE_M3L_ERROR_INSTANCES
    // by reference at construction time), but `hostile` — the Proxy — is a
    // *different* object identity than `real`. WeakSet membership is a
    // strict identity check, so isGenuineM3LErrorInstance(hostile) is false
    // regardless of the Proxy's traps: it falls through to the ordinary
    // isErrorInstance/deriveErrorCauseName branch (M3LError.prototype chains
    // through Error.prototype), where the throwing `name` trap is caught by
    // readNameSafely and the safe constructor-derived name ("M3LError",
    // forwarded through the Proxy's default getPrototypeOf trap) is used
    // instead — never a full recursive serialise of `real`'s own fields.
    const real = new M3LError("inner", { code: "ERR_INNER" });
    const hostile = new Proxy(real, {
      get(target, property, receiver): unknown {
        if (property === "name") {
          throw new Error("trap");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const outer = new M3LError("outer", {
      code: "ERR_OUTER",
      cause: hostile,
    });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = outer.toJSON();
    }).not.toThrow();
    // deriveM3LErrorCauseFallbackName's own readNameSafely(cause) read also
    // goes through the same throwing trap, so it too falls through to
    // readConstructorNameSafely -> the fixed "M3LError" literal.
    expect(json?.cause).toEqual({ name: "M3LError" });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("[hostile] a genuine M3LError whose own name AND derived constructor name are both unsafe, with a poisoned field, falls back to the fixed literal 'M3LError'", () => {
    // Covers deriveM3LErrorCauseFallbackName's final `?? "M3LError"`
    // fallback (only reachable when both readNameSafely and
    // readConstructorNameSafely return undefined): the subclass's own
    // `.name` is reassigned to unsafe text *before* construction, so
    // `new.target.name` bakes the unsafe value straight into the instance's
    // own `name` field, and the same reassignment also poisons the
    // constructor-derived name (both readers consult the same unsafe
    // string). `context` is poisoned separately to force
    // serializeM3LErrorCauseSafely's `try` to throw and reach its `catch`.
    class HostileGenuineBoth extends M3LError {}
    Object.defineProperty(HostileGenuineBoth, "name", {
      value: "Hostile Ctor=" + PLANTED_SECRET,
      configurable: true,
    });
    const real = new HostileGenuineBoth("inner", { code: "ERR_INNER" });
    Object.defineProperty(real, "context", {
      get(): never {
        throw new Error("poisoned");
      },
      configurable: true,
    });
    const outer = new M3LError("outer", { code: "ERR_OUTER", cause: real });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = outer.toJSON();
    }).not.toThrow();
    expect(json?.cause).toEqual({ name: "M3LError" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(PLANTED_SECRET);
  });

  test("[security] a forged object wearing M3LError.prototype (not a genuine instance) collapses to the foreign-Error-branch name-only shape, not a full recursive serialise", () => {
    // `forged` passes `instanceof M3LError` (the prototype chain includes
    // M3LError.prototype) but was never run through `new M3LError(...)`, so
    // it is absent from GENUINE_M3L_ERROR_INSTANCES. Every property is a
    // plain, non-throwing data descriptor -- a forgery that a bare
    // `instanceof` check (or a try/catch around ordinary reads) cannot
    // distinguish from the real thing.
    const secretField = SECRET_PART_A + "planted-forged";
    const forged: object = Object.create(M3LError.prototype) as object;
    Object.defineProperty(forged, "name", {
      value: "M3LError",
      enumerable: true,
    });
    Object.defineProperty(forged, "message", {
      value: "forged",
      enumerable: true,
    });
    Object.defineProperty(forged, "code", {
      value: "FORGED",
      enumerable: true,
    });
    Object.defineProperty(forged, "context", {
      value: { authorization: AUTH_PREFIX + secretField },
      enumerable: true,
    });

    const e = new M3LError("op failed", { code: "ERR_X", cause: forged });

    const json = e.toJSON();
    // Rejected by isGenuineM3LErrorInstance's WeakSet check, so it falls
    // through to the isErrorInstance branch (M3LError.prototype chains
    // through Error.prototype) and collapses to { name: cause.name } only --
    // never the full recursive M3LErrorJSON shape with its own context/code.
    expect(json.cause).toEqual({ name: "M3LError" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(secretField);
    expect(serialized).not.toContain("FORGED");
    expect(serialized).not.toContain("authorization");
  });

  test("[hostile] a genuine M3LError instance whose field is poisoned post-construction via a throwing getter degrades to the safe fallback shape", () => {
    // `real` is genuinely constructed (in the WeakSet), so
    // isGenuineM3LErrorInstance accepts it and serializeM3LErrorCauseSafely
    // attempts the full recursive read -- which then throws when `context`
    // is read, exercising the try/catch's `catch` branch directly (as
    // opposed to the Proxy test above, which throws via a trap).
    const real = new M3LError("inner", { code: "ERR_INNER" });
    Object.defineProperty(real, "context", {
      get(): never {
        throw new Error("poisoned");
      },
      configurable: true,
    });
    const outer = new M3LError("outer", { code: "ERR_OUTER", cause: real });

    let json: M3LErrorJSON | undefined;
    expect(() => {
      json = outer.toJSON();
    }).not.toThrow();
    expect(json?.cause).toEqual({ name: "M3LError" });
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  test("[security] a foreign object's spoofed Symbol.toStringTag is never consulted for the derived name", () => {
    // The safe name-derivation path reads the constructor off the prototype
    // (readConstructorNameSafely), never Object.prototype.toString.call --
    // planting a Symbol.toStringTag proves that a would-be attacker cannot
    // smuggle an arbitrary "type name" string through this channel.
    const plantedTag = "SECRET_TAG_" + SECRET_PART_B;
    const spoofed: Record<PropertyKey, unknown> = {
      [Symbol.toStringTag]: plantedTag,
    };
    const e = new M3LError("op failed", { code: "ERR_X", cause: spoofed });

    const json = e.toJSON();
    expect(json.cause).toEqual({ name: "Object" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(plantedTag);
    expect(serialized).not.toContain("SECRET_TAG_");
  });

  test("[security] a foreign Error whose `.name` is forged to a literal cycle/depth marker is rejected and falls back to the constructor-derived name", () => {
    // "[circular]" is one of this module's own fixed terminal markers for a
    // genuine cause cycle. If a foreign Error's own `.name` were trusted
    // verbatim, an attacker could forge that exact string to make a
    // non-cyclic cause masquerade as "this was a real cycle" in downstream
    // log analysis. isSafeCauseName's identifier-shaped pattern excludes `[`
    // and `]`, so this must fall through to the constructor-derived name
    // instead of being accepted as-is.
    class ForgedMarker extends Error {}
    const forgedMarkerCause = new ForgedMarker("boom");
    forgedMarkerCause.name = "[circular]";

    const e = new M3LError("op failed", {
      code: "ERR_X",
      cause: forgedMarkerCause,
    });

    const json = e.toJSON();
    expect(json.cause).not.toEqual({ name: "[circular]" });
    expect(json.cause).toEqual({ name: "ForgedMarker" });
  });
});

// ---------------------------------------------------------------------------
// M3LErrorJSON / M3LErrorCauseJSON — type-level contract (F31)
// ---------------------------------------------------------------------------
describe("M3LErrorJSON / M3LErrorCauseJSON types", () => {
  test("M3LErrorCauseJSON is the terminal { readonly name: string } shape", () => {
    expectTypeOf<M3LErrorCauseJSON>().toEqualTypeOf<{
      readonly name: string;
    }>();
  });

  test("M3LErrorJSON has the full readonly field set matching toJSON()'s return type", () => {
    expectTypeOf<M3LErrorJSON>().toEqualTypeOf<{
      readonly name: string;
      readonly message: string;
      readonly code: string;
      readonly context: Readonly<Record<string, unknown>>;
      readonly cause: M3LErrorJSON | M3LErrorCauseJSON | undefined;
      readonly stack: string | undefined;
      readonly origin: M3LErrorOrigin | undefined;
      readonly retryable: M3LErrorRetryable | undefined;
    }>();
  });

  test("toJSON()'s return type is exactly M3LErrorJSON", () => {
    expectTypeOf<M3LError["toJSON"]>().returns.toEqualTypeOf<M3LErrorJSON>();
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
    expectTypeOf<"ERR_TYPO">().not.toExtend<M3LErrorCode>();
  });

  test("is a finite union, not the general string type", () => {
    expectTypeOf<string>().not.toExtend<M3LErrorCode>();
  });

  // -------------------------------------------------------------------------
  // Drift/completeness guard — every exported M3LError subclass that pins a
  // literal `code` must be assignable to M3LErrorCode. This fails the moment
  // a subclass's code is added without adding it to the union.
  // -------------------------------------------------------------------------
  test("every exported M3LError subclass's code is a member of M3LErrorCode", () => {
    expectTypeOf<
      M3LThresholdRuleValidationError["code"]
    >().toExtend<M3LErrorCode>();
    expectTypeOf<M3LConfigCoercionError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LConfigParseError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LUnsafeConfigKeyError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<
      M3LEnvironmentDetectionError["code"]
    >().toExtend<M3LErrorCode>();
    expectTypeOf<M3LFileCopyError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<
      M3LJSONFormatDetectionError["code"]
    >().toExtend<M3LErrorCode>();
    expectTypeOf<M3LHttpClientError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LPollExhaustedError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LPromptValidationError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LPresetUnknownKeysError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LAWSProvisioningError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LFtsIndexError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LTextExtractionError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LAWSClientError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LAWSCredentialsError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LAWSIdentityError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LCheckpointError["code"]>().toExtend<M3LErrorCode>();
    expectTypeOf<M3LOperationAbortedError["code"]>().toExtend<M3LErrorCode>();
  });

  test("does not narrow M3LError.code itself, which stays string", () => {
    expectTypeOf<M3LError["code"]>().toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// M3LOperationAbortedError (ADR-0049 — cooperative cancellation seam)
//
// This error class represents a caller-initiated abort of a cooperative wait
// (poll, retry, or AWS waiter). Unlike most library errors it deliberately does
// NOT chain a cause, because @smithy/core embeds the last observed response body
// in its AbortError message — chaining it would carry that content into every log
// and run report.
// ---------------------------------------------------------------------------
describe("M3LOperationAbortedError", () => {
  test("is an instance of Error and M3LError", () => {
    const e = new M3LOperationAbortedError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(M3LError);
  });

  test("code is ERR_OPERATION_ABORTED", () => {
    const e = new M3LOperationAbortedError();
    expect(e.code).toBe("ERR_OPERATION_ABORTED");
  });

  test("name equals 'M3LOperationAbortedError'", () => {
    const e = new M3LOperationAbortedError();
    expect(e.name).toBe("M3LOperationAbortedError");
  });

  test("ERR_OPERATION_ABORTED is a member of M3L_ERROR_CODES", () => {
    // isM3LErrorCode is the runtime vocabulary guard — if the code is absent from
    // M3L_ERROR_CODES, the function returns false regardless of the catalog.
    expect(isM3LErrorCode("ERR_OPERATION_ABORTED")).toBe(true);
  });

  test("catalog entry for ERR_OPERATION_ABORTED is { origin: 'caller', retryable: false }", () => {
    // classifyErrorCode takes string, so no TypeScript error in RED.
    // Returns undefined when the code is absent from the catalog — fails the toEqual.
    expect(classifyErrorCode("ERR_OPERATION_ABORTED")).toEqual({
      origin: "caller",
      retryable: false,
    });
  });

  test("origin resolves to 'caller' from the catalog without any explicit option", () => {
    // Following the established pattern from the fault-origin classification suite
    // (compare M3LConfigMissingError's and M3LFileCopyError's tests above).
    const e = new M3LOperationAbortedError();
    expect(e.origin).toBe("caller");
  });

  test("retryable resolves to false from the catalog — load-bearing: a retriable abort would re-run the cancelled operation", () => {
    const e = new M3LOperationAbortedError();
    expect(e.retryable).toBe(false);
  });

  // Security contract: M3LOperationAbortedError deliberately omits cause.
  // @smithy/core builds its AbortError message by serializing the waiter result,
  // which can embed the last observed response body. Chaining it would carry that
  // content into every log line and run report — a data-leak risk.
  test("[security] cause is undefined and the error message contains no text from the underlying SDK abort error", () => {
    const plantedSecret = "SENSITIVE_SDK_WAITER_RESPONSE_PAYLOAD_abc123XYZ";
    // Build a realistic SDK-style abort error that embeds the secret.
    const sdkAbortError = new Error(
      `AbortError: WaiterResult{${plantedSecret}: 'FAILURE', statusCode: 400}`,
    );
    sdkAbortError.name = "AbortError";

    // M3LOperationAbortedError takes no cause: the fixed message is
    // library-controlled, not derived from any external payload.
    const abortedError = new M3LOperationAbortedError();

    // Sanity: the SDK error does contain the secret (proves leak would be visible).
    expect(sdkAbortError.message).toContain(plantedSecret);

    // Contract: the library error must NOT expose the secret.
    expect(abortedError.cause).toBeUndefined();
    expect(abortedError.message).not.toContain(plantedSecret);
    const serialized = JSON.stringify(abortedError.toJSON());
    expect(serialized).not.toContain(plantedSecret);
  });

  test("toJSON carries origin:caller and retryable:false", () => {
    const e = new M3LOperationAbortedError();
    const json = e.toJSON();
    expect(json.origin).toBe("caller");
    expect(json.retryable).toBe(false);
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
