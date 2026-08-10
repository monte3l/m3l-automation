/**
 * Tests for `core/json/canonicalJson` (RED phase — module not yet
 * implemented).
 *
 * Contract source: hub-locked spec for the "zero-dep-primitives" change set
 * (PR 3.1), no `docs/reference/core/json.md` entry exists yet for this
 * addition.
 *
 * Exports under test: `canonicalJsonStringify`, `canonicalJsonHash`.
 *
 * Key behavioral contracts:
 *  - `canonicalJsonStringify` recursively sorts object keys by Unicode CODE
 *    POINT (not UTF-16 code unit) and serializes to compact JSON (no
 *    whitespace). Array element order is preserved, never sorted.
 *  - Throws an `M3LError` (code `ERR_INVALID_ARGUMENT`, matching the
 *    convention already used by `safeJsonStringify`/`M3LConcurrencyPool` for
 *    a caller-supplied value that cannot be represented) when any number in
 *    the input is `NaN`, `Infinity`, or `-Infinity` — canonical JSON has no
 *    representation for non-finite numbers.
 *  - `canonicalJsonHash` hashes the canonical form of a value with
 *    `node:crypto` SHA-256, returning a lowercase hex digest. Two values
 *    that are equivalent under key-order permutation hash identically;
 *    different canonical forms hash differently.
 *
 * Judgment call (flagged for the implementer): the exact `M3LError` subclass
 * for the non-finite-number failure is NOT pinned by this test file beyond
 * "a plain `M3LError` with code `ERR_INVALID_ARGUMENT`" — this mirrors the
 * two sibling `core/utils` validators that already use this pattern rather
 * than minting a new subclass. If the implementer prefers a dedicated
 * subclass, this test's assertions on `.code`/`instanceof M3LError` still
 * hold; only a stricter subclass check would need revisiting.
 */

import { createHash } from "node:crypto";

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  canonicalJsonHash,
  canonicalJsonStringify,
} from "../src/core/json/canonicalJson.js";

// ---------------------------------------------------------------------------
// canonicalJsonStringify
// ---------------------------------------------------------------------------
describe("canonicalJsonStringify", () => {
  test("sorts nested object keys regardless of insertion order and stays compact", () => {
    const value = {
      zebra: 1,
      apple: { delta: 2, bravo: 3 },
      mango: [3, 1, 2],
    };

    const result = canonicalJsonStringify(value);

    expect(result).toBe(
      '{"apple":{"bravo":3,"delta":2},"mango":[3,1,2],"zebra":1}',
    );
  });

  test("preserves array element order — arrays are never sorted", () => {
    const value = { list: ["c", "a", "b"] };

    const result = canonicalJsonStringify(value);

    expect(result).toBe('{"list":["c","a","b"]}');
  });

  test("sorts object keys by Unicode code point, not UTF-16 code unit", () => {
    // U+E000 is a BMP private-use character (single UTF-16 code unit 0xE000).
    // U+10000 is an astral-plane character (surrogate pair 0xD800 0xDC00).
    //
    // Default UTF-16 code-unit comparison puts the astral key FIRST (its
    // leading surrogate 0xD800 < 0xE000), but the correct Unicode
    // code-point order puts the BMP key first (0xE000 < 0x10000). This pair
    // is exactly the divergence case a naive `Object.keys(o).sort()` gets
    // wrong.
    const bmpKey = "";
    const astralKey = "\u{10000}";
    expect(bmpKey.codePointAt(0)).toBeLessThan(astralKey.codePointAt(0) ?? 0);
    // Sanity check that this pair really does diverge under the naive sort.
    expect([astralKey, bmpKey].sort()).toEqual([astralKey, bmpKey]);

    const value: Record<string, string> = {
      [astralKey]: "astral",
      [bmpKey]: "bmp",
    };

    const result = canonicalJsonStringify(value);

    const expected = `{${JSON.stringify(bmpKey)}:${JSON.stringify("bmp")},${JSON.stringify(astralKey)}:${JSON.stringify("astral")}}`;
    expect(result).toBe(expected);
  });

  test("sorts a prefix key before the longer key it is a prefix of", () => {
    const result = canonicalJsonStringify({ ab: 1, a: 2 });

    expect(result).toBe('{"a":2,"ab":1}');
  });

  test("serializes an array element with no JSON representation as null, unlike an omitted object property", () => {
    const result = canonicalJsonStringify([1, undefined, 3]);

    expect(result).toBe("[1,null,3]");
  });

  test.each([
    ["a bare NaN", Number.NaN],
    ["a bare Infinity", Number.POSITIVE_INFINITY],
    ["a bare -Infinity", Number.NEGATIVE_INFINITY],
  ])("throws M3LError(ERR_INVALID_ARGUMENT) on %s", (_label, badNumber) => {
    expect(() => canonicalJsonStringify(badNumber)).toThrowError(M3LError);
    let thrown: unknown;
    try {
      canonicalJsonStringify(badNumber);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });

  test("throws M3LError(ERR_INVALID_ARGUMENT) when a non-finite number is nested", () => {
    const value = { ok: 1, nested: { bad: Number.NaN } };

    expect(() => canonicalJsonStringify(value)).toThrowError(M3LError);
  });

  test.each([
    ["a top-level BigInt", 42n],
    ["a BigInt nested in an object", { value: 42n }],
    ["a BigInt nested in an array", [1, 42n, 3]],
  ])(
    "throws M3LError(ERR_INVALID_ARGUMENT), not a raw TypeError, on %s",
    (_label, value) => {
      expect(() => canonicalJsonStringify(value)).toThrowError(M3LError);
      let thrown: unknown;
      try {
        canonicalJsonStringify(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
    },
  );

  test("throws M3LError(ERR_INVALID_ARGUMENT), not a raw RangeError, on a circular object reference", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() => canonicalJsonStringify(circular)).toThrowError(M3LError);
    let thrown: unknown;
    try {
      canonicalJsonStringify(circular);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });

  test("has a string-returning signature", () => {
    expectTypeOf(canonicalJsonStringify).returns.toBeString();
  });
});

// ---------------------------------------------------------------------------
// canonicalJsonHash
// ---------------------------------------------------------------------------
describe("canonicalJsonHash", () => {
  test("hashes the canonical form via node:crypto sha256, as a lowercase hex digest", () => {
    const value = { a: 1, b: 2 };
    const expectedHash = createHash("sha256")
      .update(canonicalJsonStringify(value))
      .digest("hex");

    const result = canonicalJsonHash(value);

    expect(result).toBe(expectedHash);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic across key-order permutations of an equivalent object", () => {
    const first = canonicalJsonHash({ a: 1, b: 2 });
    const second = canonicalJsonHash({ b: 2, a: 1 });

    expect(first).toBe(second);
  });

  test("produces a different hash for a different canonical value", () => {
    const first = canonicalJsonHash({ a: 1, b: 2 });
    const second = canonicalJsonHash({ a: 1, b: 3 });

    expect(first).not.toBe(second);
  });

  test("throws M3LError(ERR_INVALID_ARGUMENT) when the value contains a non-finite number", () => {
    expect(() => canonicalJsonHash({ bad: Number.NaN })).toThrowError(M3LError);
  });

  test("has a string-returning signature", () => {
    expectTypeOf(canonicalJsonHash).returns.toBeString();
  });
});
