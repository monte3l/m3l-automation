import { afterEach, describe, expect, test } from "vitest";
import { errnoCodeOf } from "../lib/errno.mjs";

describe("errnoCodeOf", () => {
  afterEach(() => {
    Reflect.deleteProperty(Error.prototype, "code");
  });

  test("returns the own code of a real Error", () => {
    const error = Object.assign(new Error("boom"), { code: "ENOENT" });
    expect(errnoCodeOf(error)).toBe("ENOENT");
  });

  test.each([
    ["a plain object with a code property", { code: "ENOENT" }],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a bare string", "ENOENT"],
  ])("returns undefined for %s", (_label, value) => {
    expect(errnoCodeOf(value)).toBeUndefined();
  });

  test("returns undefined for an inherited-only code (own-property check)", () => {
    // @ts-expect-error -- deliberately polluting Error.prototype for this test
    Error.prototype.code = "ENOENT";
    expect(errnoCodeOf(new Error("boom"))).toBeUndefined();
  });

  test("returns undefined for a non-string own code", () => {
    const error = Object.assign(new Error("boom"), { code: 1 });
    expect(errnoCodeOf(error)).toBeUndefined();
  });

  test("reads code exactly once, even when it flip-flops on repeated reads", () => {
    let reads = 0;
    const error = new Error("boom");
    Object.defineProperty(error, "code", {
      get() {
        reads += 1;
        return reads === 1 ? "ENOENT" : "EACCES";
      },
      enumerable: true,
      configurable: true,
    });
    expect(errnoCodeOf(error)).toBe("ENOENT");
    expect(reads).toBe(1);
  });
});
