/**
 * `core/utils/guards`'s errno pair (`isNodeError`/`isEnoentError`) under
 * prototype pollution and under a non-idempotent getter — the adversarial
 * cases `utils.test.ts` cannot host.
 *
 * Split out rather than appended: `utils.test.ts` sits within ~400 bytes of
 * `check:file-budget`'s un-baselined test ceiling, and this suite mutates
 * `Error.prototype`, which nothing in that file does. Mirrors
 * `packages/m3l-console-server/tests/errno.test.ts`'s "hardening branch"
 * describe, against the library's own guards (X8d, issue #1059).
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, test } from "vitest";

import { isEnoentError, isNodeError } from "../src/core/utils/guards.js";

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

    // Today isEnoentError(v) = isNodeError(v) && v.code === "ENOENT" reads
    // `.code` twice: isNodeError's typeof check consumes the first read
    // ("ENOENT"), then the `=== "ENOENT"` comparison re-reads and gets
    // "EACCES" — so this returns false, having read twice, against a value
    // that unambiguously carries ENOENT on its first (and only legitimate)
    // read. A single-read implementation must read once and return true.
    expect(isEnoentError(cause)).toBe(true);
    expect(reads).toBe(1);
  });
});
