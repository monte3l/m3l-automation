/**
 * Tests for `core/config/M3LConfigAccessor` — an options accessor layered
 * over `M3LConfig` that narrows `optional*` reads and enforces
 * caller-required values.
 *
 * Contract source: docs/reference/core/config.md § "Defensive typed reads
 * (M3LConfigAccessor)".
 *
 * Exports under test: M3LConfigAccessor, M3LConfigAccessorOptions.
 *
 * Key behavioral contracts:
 *  - Every throw is a bare `M3LError` (never a subclass) whose `.code` is the
 *    caller-supplied `code` string threaded through the constructor options.
 *  - `optional*` methods distinguish "unset" (undefined) from "set to the
 *    wrong type" (throws) — never coerce.
 *  - `*WithDefault` methods use `??` semantics: a falsy-but-defined value
 *    (`0`, `false`) must win over the default, never fall through to it.
 *  - `optionalStringArray` also accepts a raw comma-separated string,
 *    trimming each segment and dropping empty ones.
 *  - `oneOf` narrows its return type to the literal union of `allowed`.
 *  - `requiredFor` only throws on `undefined` — `false`/`0`/`""`/`null` must
 *    all pass through unchanged (the classic falsiness-vs-undefined bug).
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConfig } from "../src/core/config/index.js";
import { M3LError } from "../src/core/errors/index.js";
import { M3LConfigAccessor } from "../src/core/config/M3LConfigAccessor.js";
import type { M3LConfigAccessorOptions } from "../src/core/config/M3LConfigAccessor.js";

const CODE = "ERR_TEST_CONFIG";

function makeAccessor(config: M3LConfig = new M3LConfig()): M3LConfigAccessor {
  const options: M3LConfigAccessorOptions = { config, code: CODE };
  return new M3LConfigAccessor(options);
}

/** Invokes `fn`, asserting it throws a bare `M3LError` with the given message. */
function expectM3LError(fn: () => unknown, message: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LError);
  expect((thrown as M3LError).code).toBe(CODE);
  expect((thrown as M3LError).message).toBe(message);
}

// ---------------------------------------------------------------------------
// optionalString
// ---------------------------------------------------------------------------
describe("optionalString", () => {
  test("returns undefined when unset", () => {
    const accessor = makeAccessor();
    expect(accessor.optionalString("name")).toBeUndefined();
  });

  test("returns the string when set to a string", () => {
    const config = new M3LConfig();
    config.set("name", "Ada");
    const accessor = makeAccessor(config);
    expect(accessor.optionalString("name")).toBe("Ada");
  });

  test.each([42, true, null, [1, 2], { a: 1 }])(
    "throws when set to %j (wrong type)",
    (value) => {
      const config = new M3LConfig();
      config.set("name", value);
      const accessor = makeAccessor(config);
      expectM3LError(
        () => accessor.optionalString("name"),
        "'name' must be a string",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// optionalNumber
// ---------------------------------------------------------------------------
describe("optionalNumber", () => {
  test("returns undefined when unset", () => {
    const accessor = makeAccessor();
    expect(accessor.optionalNumber("port")).toBeUndefined();
  });

  test("returns the number when set to a number", () => {
    const config = new M3LConfig();
    config.set("port", 8080);
    const accessor = makeAccessor(config);
    expect(accessor.optionalNumber("port")).toBe(8080);
  });

  test("does NOT reject NaN — it is typeof number and passes through", () => {
    const config = new M3LConfig();
    config.set("port", Number.NaN);
    const accessor = makeAccessor(config);
    expect(Number.isNaN(accessor.optionalNumber("port"))).toBe(true);
  });

  test.each(["8080", true, null, [1, 2], { a: 1 }])(
    "throws when set to %j (wrong type)",
    (value) => {
      const config = new M3LConfig();
      config.set("port", value);
      const accessor = makeAccessor(config);
      expectM3LError(
        () => accessor.optionalNumber("port"),
        "'port' must be a number",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// optionalBoolean
// ---------------------------------------------------------------------------
describe("optionalBoolean", () => {
  test("returns undefined when unset", () => {
    const accessor = makeAccessor();
    expect(accessor.optionalBoolean("verbose")).toBeUndefined();
  });

  test("returns the boolean when set to a boolean", () => {
    const config = new M3LConfig();
    config.set("verbose", true);
    const accessor = makeAccessor(config);
    expect(accessor.optionalBoolean("verbose")).toBe(true);
  });

  test("a string 'true'/'false' is NOT coerced — it throws", () => {
    const config = new M3LConfig();
    config.set("verbose", "true");
    const accessor = makeAccessor(config);
    expectM3LError(
      () => accessor.optionalBoolean("verbose"),
      "'verbose' must be a boolean",
    );
  });

  test.each([1, null, [true], { a: true }])(
    "throws when set to %j (wrong type)",
    (value) => {
      const config = new M3LConfig();
      config.set("verbose", value);
      const accessor = makeAccessor(config);
      expectM3LError(
        () => accessor.optionalBoolean("verbose"),
        "'verbose' must be a boolean",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// optionalStringArray
// ---------------------------------------------------------------------------
describe("optionalStringArray", () => {
  test("returns undefined when unset", () => {
    const accessor = makeAccessor();
    expect(accessor.optionalStringArray("tags")).toBeUndefined();
  });

  test("returns the same contents when set to an array of strings", () => {
    const config = new M3LConfig();
    config.set("tags", ["a", "b", "c"]);
    const accessor = makeAccessor(config);
    expect(accessor.optionalStringArray("tags")).toEqual(["a", "b", "c"]);
  });

  test("throws when the array contains a non-string element", () => {
    const config = new M3LConfig();
    config.set("tags", [1, 2]);
    const accessor = makeAccessor(config);
    expectM3LError(
      () => accessor.optionalStringArray("tags"),
      "'tags' must be a string array",
    );
  });

  test("splits a comma-separated string, trimming each segment", () => {
    const config = new M3LConfig();
    config.set("tags", "a, b ,c");
    const accessor = makeAccessor(config);
    expect(accessor.optionalStringArray("tags")).toEqual(["a", "b", "c"]);
  });

  test("an empty string returns an empty array, NOT undefined", () => {
    const config = new M3LConfig();
    config.set("tags", "");
    const accessor = makeAccessor(config);
    expect(accessor.optionalStringArray("tags")).toEqual([]);
  });

  test("a lone comma returns an empty array (empty segments dropped)", () => {
    const config = new M3LConfig();
    config.set("tags", ",");
    const accessor = makeAccessor(config);
    expect(accessor.optionalStringArray("tags")).toEqual([]);
  });

  test.each([42, true, { a: 1 }])(
    "throws when set to %j (wrong type)",
    (value) => {
      const config = new M3LConfig();
      config.set("tags", value);
      const accessor = makeAccessor(config);
      expectM3LError(
        () => accessor.optionalStringArray("tags"),
        "'tags' must be a string array",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// numberWithDefault
// ---------------------------------------------------------------------------
describe("numberWithDefault", () => {
  test("returns the set value, including 0 (proves ?? not ||)", () => {
    const config = new M3LConfig();
    config.set("retries", 0);
    const accessor = makeAccessor(config);
    expect(accessor.numberWithDefault("retries", 5)).toBe(0);
  });

  test("returns a non-zero set value", () => {
    const config = new M3LConfig();
    config.set("retries", 3);
    const accessor = makeAccessor(config);
    expect(accessor.numberWithDefault("retries", 5)).toBe(3);
  });

  test("returns the default when unset", () => {
    const accessor = makeAccessor();
    expect(accessor.numberWithDefault("retries", 5)).toBe(5);
  });

  test("throws (same message as optionalNumber) when set to the wrong type", () => {
    const config = new M3LConfig();
    config.set("retries", "three");
    const accessor = makeAccessor(config);
    expectM3LError(
      () => accessor.numberWithDefault("retries", 5),
      "'retries' must be a number",
    );
  });
});

// ---------------------------------------------------------------------------
// booleanWithDefault
// ---------------------------------------------------------------------------
describe("booleanWithDefault", () => {
  test("returns false when explicitly set to false (proves ?? not ||)", () => {
    const config = new M3LConfig();
    config.set("dryRun", false);
    const accessor = makeAccessor(config);
    expect(accessor.booleanWithDefault("dryRun", true)).toBe(false);
  });

  test("returns the default when unset", () => {
    const accessor = makeAccessor();
    expect(accessor.booleanWithDefault("dryRun", true)).toBe(true);
  });

  test("throws (same message as optionalBoolean) when set to the wrong type", () => {
    const config = new M3LConfig();
    config.set("dryRun", "yes");
    const accessor = makeAccessor(config);
    expectM3LError(
      () => accessor.booleanWithDefault("dryRun", true),
      "'dryRun' must be a boolean",
    );
  });
});

// ---------------------------------------------------------------------------
// oneOf
// ---------------------------------------------------------------------------
describe("oneOf", () => {
  const ALLOWED = ["a", "b"] as const;

  test("returns the set value when present in allowed", () => {
    const config = new M3LConfig();
    config.set("mode", "a");
    const accessor = makeAccessor(config);
    expect(accessor.oneOf("mode", ALLOWED)).toBe("a");
  });

  test("throws when unset", () => {
    const accessor = makeAccessor();
    expectM3LError(
      () => accessor.oneOf("mode", ALLOWED),
      "'mode' must be one of: a, b",
    );
  });

  test("throws when set to a value not in allowed", () => {
    const config = new M3LConfig();
    config.set("mode", "z");
    const accessor = makeAccessor(config);
    expectM3LError(
      () => accessor.oneOf("mode", ALLOWED),
      "'mode' must be one of: a, b",
    );
  });

  test("throws when set to a non-string", () => {
    const config = new M3LConfig();
    config.set("mode", 42);
    const accessor = makeAccessor(config);
    expectM3LError(
      () => accessor.oneOf("mode", ALLOWED),
      "'mode' must be one of: a, b",
    );
  });

  describe("type-level contract", () => {
    test("narrows the return type to the literal union of allowed", () => {
      const config = new M3LConfig();
      config.set("mode", "a");
      const accessor = makeAccessor(config);
      expectTypeOf(accessor.oneOf("mode", ALLOWED)).toEqualTypeOf<"a" | "b">();
    });
  });
});

// ---------------------------------------------------------------------------
// requiredFor
// ---------------------------------------------------------------------------
describe("requiredFor", () => {
  test("returns the exact same reference when given a defined string", () => {
    const accessor = makeAccessor();
    const value = "some-value";
    expect(accessor.requiredFor(value, "apiKey", "publish")).toBe(value);
  });

  test("returns the exact same reference when given a defined object", () => {
    const accessor = makeAccessor();
    const value = { nested: true };
    expect(accessor.requiredFor(value, "payload", "publish")).toBe(value);
  });

  test("throws when given undefined", () => {
    const accessor = makeAccessor();
    expectM3LError(
      () => accessor.requiredFor(undefined, "apiKey", "publish"),
      "'apiKey' is required for operation 'publish'",
    );
  });

  test.each([false, 0, "", null])(
    "passes %j through unchanged — only undefined throws",
    (value) => {
      const accessor = makeAccessor();
      expect(accessor.requiredFor(value, "field", "op")).toBe(value);
    },
  );

  describe("type-level contract", () => {
    test("narrows T | undefined input to T on the return type", () => {
      const accessor = makeAccessor();
      const maybeString: string | undefined = "value";
      expectTypeOf(
        accessor.requiredFor(maybeString, "name", "op"),
      ).toEqualTypeOf<string>();
    });

    test("narrows to T even with an explicit T | undefined type argument (Exclude<T, undefined> fix)", () => {
      const accessor = makeAccessor();
      const maybe: string | undefined = "x";
      // Baseline: implicit inference already narrows correctly today.
      expectTypeOf(
        accessor.requiredFor(maybe, "n", "op"),
      ).toEqualTypeOf<string>();
      // Pinned regression: an explicit `T | undefined` type argument must
      // narrow the return type the same way — before the fix, this call's
      // return type is `T` instantiated as `string | undefined`, not `string`.
      expectTypeOf(
        accessor.requiredFor<string | undefined>(maybe, "n", "op"),
      ).toEqualTypeOf<string>();
    });
  });
});
