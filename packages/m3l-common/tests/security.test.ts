/**
 * Tests for core/security submodule.
 *
 * Contract source: docs/reference/core/security.md
 * Exports: isDangerousKey, formatUnsafeKeyLocation (2 symbols).
 *
 * Key behavioral contracts:
 *  - isDangerousKey: returns true for exactly '__proto__', 'constructor',
 *    'prototype'; false for everything else; case-sensitive exact match only;
 *    must not throw for any string input.
 *  - formatUnsafeKeyLocation: returns a non-empty string that contains the key
 *    value somewhere in the output; must not throw for any string input.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  formatUnsafeKeyLocation,
  isDangerousKey,
} from "../src/core/security/index.js";

// ---------------------------------------------------------------------------
// isDangerousKey — happy / true path
// ---------------------------------------------------------------------------
describe("isDangerousKey() — dangerous keys return true", () => {
  test.each([["__proto__"], ["constructor"], ["prototype"]])(
    "returns true for %s",
    (key) => {
      expect(isDangerousKey(key)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// isDangerousKey — false path (exact-match semantics; no normalization)
// ---------------------------------------------------------------------------
describe("isDangerousKey() — non-dangerous keys return false", () => {
  test.each([
    ["name"],
    [""],
    ["proto"],
    ["__proto"],
    ["__PROTO__"],
    ["Constructor"],
    ["PROTOTYPE"],
    ["__proto__ "], // trailing space — not an exact match
    [" __proto__"], // leading space — not an exact match
    [" constructor"], // leading space — not an exact match
    [" prototype"], // leading space — not an exact match
  ])("returns false for %s", (key) => {
    expect(isDangerousKey(key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDangerousKey — no-throw contract
// ---------------------------------------------------------------------------
describe("isDangerousKey() — no-throw guarantee", () => {
  test("does not throw for an ordinary string", () => {
    expect(() => isDangerousKey("someKey")).not.toThrow();
  });

  test("does not throw for an empty string", () => {
    expect(() => isDangerousKey("")).not.toThrow();
  });

  test("does not throw for a very long string", () => {
    expect(() => isDangerousKey("x".repeat(10_000))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isDangerousKey — type-level contract
// ---------------------------------------------------------------------------
describe("isDangerousKey() — type-level contract", () => {
  test("has the signature (key: string) => boolean", () => {
    expectTypeOf(isDangerousKey).toEqualTypeOf<(key: string) => boolean>();
  });
});

// ---------------------------------------------------------------------------
// formatUnsafeKeyLocation — happy path
// ---------------------------------------------------------------------------
describe("formatUnsafeKeyLocation() — returns a non-empty string containing the key", () => {
  test.each([["__proto__"], ["constructor"], ["prototype"], ["anyKey"], [""]])(
    "includes the key value %j in the output",
    (key) => {
      const result = formatUnsafeKeyLocation(key);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain(key);
    },
  );

  test("returns a non-empty string for a key containing special characters", () => {
    const key = 'ke"y<with>special&chars';
    const result = formatUnsafeKeyLocation(key);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain(key);
  });
});

// ---------------------------------------------------------------------------
// formatUnsafeKeyLocation — no-throw contract
// ---------------------------------------------------------------------------
describe("formatUnsafeKeyLocation() — no-throw guarantee", () => {
  test("does not throw for an arbitrary string", () => {
    expect(() => formatUnsafeKeyLocation("someKey")).not.toThrow();
  });

  test("does not throw for an empty string", () => {
    expect(() => formatUnsafeKeyLocation("")).not.toThrow();
  });

  test("does not throw for a very long string", () => {
    expect(() => formatUnsafeKeyLocation("x".repeat(10_000))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatUnsafeKeyLocation — type-level contract
// ---------------------------------------------------------------------------
describe("formatUnsafeKeyLocation() — type-level contract", () => {
  test("has the signature (key: string) => string", () => {
    expectTypeOf(formatUnsafeKeyLocation).toEqualTypeOf<
      (key: string) => string
    >();
  });
});
