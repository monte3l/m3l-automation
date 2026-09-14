/**
 * `core/utils/guards`'s errno pair (`isNodeError`/`isEnoentError`) and the
 * shared `errnoCodeOf` helper they delegate to, under prototype pollution and
 * under a non-idempotent getter — the adversarial cases `utils.test.ts`
 * cannot host.
 *
 * Split out rather than appended: `utils.test.ts` sits within ~400 bytes of
 * `check:file-budget`'s un-baselined test ceiling, and this suite mutates
 * `Error.prototype`, which nothing in that file does. Mirrors
 * `packages/m3l-console-server/tests/errno.test.ts`'s "hardening branch"
 * describe, against the library's own guards (X8d, issue #1059; `errnoCodeOf`
 * promotion, X8e).
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  errnoCodeOf,
  isEnoentError,
  isNodeError,
} from "../src/core/utils/guards.js";

describe("the errno guards honour only an own code", () => {
  // Unconditional and outside any test body: a polluted `Error.prototype`
  // outlives a test that throws before its own cleanup and corrupts every
  // later suite sharing this worker.
  afterEach(() => {
    Reflect.deleteProperty(Error.prototype, "code");
    expect(Object.hasOwn(Error.prototype, "code")).toBe(false);
  });

  test("an inherited Error.prototype.code is not a node error", () => {
    Object.defineProperty(Error.prototype, "code", {
      value: "ENOENT",
      configurable: true,
      writable: true,
    });

    const cause = new Error("no own code here");
    // `expect(cause).not.toHaveProperty("code")` would FAIL here — chai
    // falls back to `"key" in Object(obj)` and walks the prototype chain.
    // Only `Object.hasOwn` proves the fixture is the shape this test needs.
    expect(Object.hasOwn(cause, "code")).toBe(false);
    expect("code" in cause).toBe(true);

    expect(isNodeError(cause)).toBe(false);
    expect(isEnoentError(cause)).toBe(false);
  });

  test("a subclass prototype getter is not honoured either", () => {
    class PlantedError extends Error {}
    Object.defineProperty(PlantedError.prototype, "code", {
      get: () => "ENOENT",
      configurable: true,
    });
    try {
      const cause = new PlantedError("planted");
      expect(Object.hasOwn(cause, "code")).toBe(false);
      expect(isNodeError(cause)).toBe(false);
      expect(isEnoentError(cause)).toBe(false);
    } finally {
      Reflect.deleteProperty(PlantedError.prototype, "code");
    }
  });

  test("an own code still passes, with the prototype polluted to a different one", () => {
    Object.defineProperty(Error.prototype, "code", {
      value: "EACCES",
      configurable: true,
      writable: true,
    });
    const cause = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(Object.hasOwn(cause, "code")).toBe(true);
    expect(isNodeError(cause)).toBe(true);
    expect(isEnoentError(cause)).toBe(true);
  });

  test.each<[string, unknown]>([
    ["a number", 42],
    ["null", null],
    ["a symbol", Symbol("ENOENT")],
    ["an object", { toString: () => "ENOENT" }],
  ])("an own code that is %s is not a node error", (_label, code) => {
    const cause = Object.assign(new Error("x"), { code });
    expect(isNodeError(cause)).toBe(false);
    expect(isEnoentError(cause)).toBe(false);
  });
});

describe("the errno guards read `code` exactly once", () => {
  test("a flip-flopping own getter cannot desynchronise validate from compare", () => {
    let reads = 0;
    const cause = new Error("flip-flop");
    Object.defineProperty(cause, "code", {
      configurable: true,
      get: () => (++reads === 1 ? "ENOENT" : "EACCES"),
    });

    // isEnoentError reads `.code` exactly once via the shared readErrnoCode
    // helper: a getter that answers differently across reads (ENOENT first,
    // EACCES thereafter) must still be classified from its one legitimate
    // read. Two reads would desynchronise validate-from-compare and return
    // false for a value that unambiguously carries ENOENT — this pins the
    // single-read guarantee as a regression test, not a TDD scratch note.
    expect(isEnoentError(cause)).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("errnoCodeOf", () => {
  // Unconditional and outside any test body: same rationale as the first
  // describe above — a polluted `Error.prototype` outliving a throwing test
  // would corrupt every later suite sharing this worker.
  afterEach(() => {
    Reflect.deleteProperty(Error.prototype, "code");
    expect(Object.hasOwn(Error.prototype, "code")).toBe(false);
  });

  test("returns the own code string for a real Error carrying code as an own property", () => {
    const cause = Object.assign(new Error("x"), { code: "ENOENT" });
    expect(Object.hasOwn(cause, "code")).toBe(true);
    expect(errnoCodeOf(cause)).toBe("ENOENT");
  });

  test.each<[string, unknown]>([
    ["a plain object", { code: "ENOENT" }],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["the string itself", "ENOENT"],
  ])("returns undefined for %s", (_label, value) => {
    expect(errnoCodeOf(value)).toBeUndefined();
  });

  test("returns undefined when code is reachable only via the prototype chain", () => {
    Object.defineProperty(Error.prototype, "code", {
      value: "ENOENT",
      configurable: true,
      writable: true,
    });

    const cause = new Error("no own code here");
    // Same `Object.hasOwn` caveat as the sibling describe above: chai's
    // `toHaveProperty` walks the prototype chain and would pass either way.
    expect(Object.hasOwn(cause, "code")).toBe(false);
    expect(errnoCodeOf(cause)).toBeUndefined();
  });

  test("a subclass prototype getter is not honoured either", () => {
    class PlantedError extends Error {}
    Object.defineProperty(PlantedError.prototype, "code", {
      get: () => "ENOENT",
      configurable: true,
    });
    try {
      const cause = new PlantedError("planted");
      expect(Object.hasOwn(cause, "code")).toBe(false);
      expect(errnoCodeOf(cause)).toBeUndefined();
    } finally {
      Reflect.deleteProperty(PlantedError.prototype, "code");
    }
  });

  test.each<[string, unknown]>([
    ["a number", 42],
    ["a symbol", Symbol("ENOENT")],
    ["an object with a toString", { toString: () => "ENOENT" }],
  ])(
    "returns undefined for a non-string own code that is %s",
    (_label, code) => {
      const cause = Object.assign(new Error("x"), { code });
      expect(Object.hasOwn(cause, "code")).toBe(true);
      expect(errnoCodeOf(cause)).toBeUndefined();
    },
  );

  test("reads `code` exactly once: a flip-flopping own getter is classified from its first read", () => {
    let reads = 0;
    const cause = new Error("flip-flop");
    Object.defineProperty(cause, "code", {
      configurable: true,
      get: () => (++reads === 1 ? "ENOENT" : "EACCES"),
    });

    // Same single-read guarantee as the sibling describe's flip-flop case,
    // pinned directly against `errnoCodeOf` rather than through
    // `isEnoentError`'s composition of it.
    expect(errnoCodeOf(cause)).toBe("ENOENT");
    expect(reads).toBe(1);
  });

  test.each<[string, unknown]>([
    [
      "a real Error with an own ENOENT code",
      Object.assign(new Error("x"), { code: "ENOENT" }),
    ],
    [
      "a real Error with an own EACCES code",
      Object.assign(new Error("x"), { code: "EACCES" }),
    ],
    ["a plain object shaped like an errno", { code: "ENOENT" }],
  ])("composes with isNodeError/isEnoentError for %s", (_label, value) => {
    expect(isNodeError(value)).toBe(errnoCodeOf(value) !== undefined);
    expect(isEnoentError(value)).toBe(errnoCodeOf(value) === "ENOENT");
  });
});
