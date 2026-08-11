/**
 * `core/json/canonicalJson` — deterministic ("canonical") JSON serialization
 * and hashing.
 *
 * Produces a compact JSON string with object keys sorted by Unicode code
 * point at every nesting level, so two values that are equivalent under
 * key-order permutation always serialize (and hash) identically. Array
 * element order is never touched — arrays are ordered data, not a set of
 * named fields.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";

import { M3LError } from "../errors/index.js";

/**
 * Splits a string into its Unicode code points (not UTF-16 code units) via
 * the string iterator protocol, which is surrogate-pair aware.
 */
function toCodePoints(value: string): readonly number[] {
  const points: number[] = [];
  for (const character of value) {
    // character.codePointAt(0) is safe: the string iterator protocol never
    // yields an empty substring, so codePointAt(0) is always defined here.
    points.push(character.codePointAt(0) as number);
  }
  return points;
}

/**
 * Compares two strings by Unicode code point, not by `Array.prototype.sort`'s
 * default UTF-16 code-unit comparator — which orders an astral-plane
 * character (a surrogate pair, leading unit `0xD800`-`0xDBFF`) before a
 * higher-valued BMP character, the opposite of true code-point order.
 */
function compareByCodePoint(a: string, b: string): number {
  const aPoints = toCodePoints(a);
  const bPoints = toCodePoints(b);
  const length = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < length; index++) {
    // aPoints[index] and bPoints[index] are safe: length is
    // Math.min(aPoints.length, bPoints.length), so index is always in-bounds
    // for both arrays here.
    const diff = (aPoints[index] as number) - (bPoints[index] as number);
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}

/** Throws when `value` is a non-finite number — canonical JSON has no representation for it. */
function assertFiniteNumber(value: number): void {
  if (Number.isFinite(value)) return;
  throw new M3LError(
    `canonicalJsonStringify: non-finite number ${String(value)} has no canonical JSON representation`,
    { code: "ERR_INVALID_ARGUMENT" },
  );
}

/** Throws unconditionally — a `BigInt` has no canonical JSON representation. */
function assertNotBigInt(value: bigint): void {
  throw new M3LError(
    `canonicalJsonStringify: BigInt ${String(value)}n has no canonical JSON representation`,
    { code: "ERR_INVALID_ARGUMENT" },
  );
}

/** Throws when `value` is already on the current recursion path — a circular reference. */
function assertNotCircular(value: object, path: WeakSet<object>): void {
  if (!path.has(value)) return;
  throw new M3LError(
    "canonicalJsonStringify: circular object reference has no canonical JSON representation",
    { code: "ERR_INVALID_ARGUMENT" },
  );
}

/**
 * Narrows `value` to an object exposing a callable `toJSON` method, mirroring
 * the check `JSON.stringify` itself performs before deciding how to serialize
 * a non-null object.
 */
function hasToJSON(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

/** Serializes an array, preserving element order — arrays are never sorted. */
function canonicalizeArray(
  value: readonly unknown[],
  path: WeakSet<object>,
): string {
  assertNotCircular(value, path);
  path.add(value);
  const items = value.map((item) => canonicalizeValue(item, path) ?? "null");
  path.delete(value);
  return `[${items.join(",")}]`;
}

/** Serializes a plain object, sorting its keys by Unicode code point. */
function canonicalizeObject(
  value: Record<string, unknown>,
  path: WeakSet<object>,
): string {
  assertNotCircular(value, path);
  path.add(value);
  const keys = Object.keys(value).sort(compareByCodePoint);
  const entries: string[] = [];
  for (const key of keys) {
    const serialized = canonicalizeValue(value[key], path);
    if (serialized !== undefined) {
      entries.push(`${JSON.stringify(key)}:${serialized}`);
    }
  }
  path.delete(value);
  return `{${entries.join(",")}}`;
}

/**
 * Recursively serializes `value` to its canonical JSON form. Returns
 * `undefined` for a value with no JSON representation (`undefined`, a
 * function, or a symbol) so the caller can decide whether to omit it (object
 * property) or fall back to `"null"` (array element, top level) — mirroring
 * `JSON.stringify`'s own behavior at each of those positions.
 *
 * `path` tracks the objects/arrays on the CURRENT recursion path (not every
 * object visited overall), so the same object reachable twice from
 * non-overlapping branches is not a false-positive cycle — only an object
 * that is its own ancestor is.
 */
function canonicalizeValue(
  value: unknown,
  path: WeakSet<object>,
): string | undefined {
  if (typeof value === "number") {
    assertFiniteNumber(value);
    return JSON.stringify(value);
  }

  if (typeof value === "bigint") {
    assertNotBigInt(value);
  }

  // Mirrors JSON.stringify's own precedence: a non-null object with a
  // callable toJSON is serialized from its toJSON() RESULT, checked before
  // any array/object shape decision — so a Date (toJSON, no own enumerable
  // keys) is never mistaken for a plain object walked via Object.keys. The
  // result is a freshly produced value, not the original object re-entering
  // its own recursion path, but `path` is still threaded through so a cycle
  // reachable from within that result is caught the same way.
  if (value !== null && typeof value === "object" && hasToJSON(value)) {
    return canonicalizeValue(value.toJSON(), path);
  }

  if (Array.isArray(value)) {
    return canonicalizeArray(value, path);
  }

  if (value !== null && typeof value === "object") {
    return canonicalizeObject(value as Record<string, unknown>, path);
  }

  // null, string, boolean, undefined, function, symbol — JSON.stringify
  // already returns the correct compact representation (or `undefined`) for
  // each of these.
  return JSON.stringify(value);
}

/**
 * Serializes `value` to a compact, deterministic JSON string: object keys at
 * every nesting level are sorted by Unicode code point, and array element
 * order is preserved exactly as given.
 *
 * A non-null object exposing a callable `toJSON` method (e.g. a `Date`) is
 * serialized from the RESULT of calling that method, matching
 * `JSON.stringify`'s own precedence — the `toJSON()` check runs before any
 * array/object shape decision, at every nesting level. The returned value is
 * itself recursively canonicalized (its own object keys, if any, are sorted
 * too), not passed through raw.
 *
 * @param value - Any value to serialize.
 * @returns The compact canonical JSON string. A top-level value with no JSON
 *   representation (`undefined`, a function, or a symbol) serializes to
 *   `"null"`.
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when the input
 *   contains, anywhere in the tree, a non-finite number (`NaN`, `Infinity`,
 *   or `-Infinity`), a `BigInt`, or a circular object/array reference —
 *   canonical JSON has no representation for any of the three.
 *
 * @example
 * ```ts
 * import { canonicalJsonStringify } from "@m3l-automation/m3l-common/core";
 *
 * canonicalJsonStringify({ zebra: 1, apple: 2 });
 * // '{"apple":2,"zebra":1}' — keys sorted, insertion order ignored
 *
 * canonicalJsonStringify({ list: [3, 1, 2] });
 * // '{"list":[3,1,2]}' — array order preserved, never sorted
 *
 * canonicalJsonStringify(new Date("2020-01-01T00:00:00.000Z"));
 * // '"2020-01-01T00:00:00.000Z"' — serialized via Date.prototype.toJSON()
 * ```
 */
export function canonicalJsonStringify(value: unknown): string {
  return canonicalizeValue(value, new WeakSet<object>()) ?? "null";
}

/**
 * Hashes the canonical JSON form of `value` with SHA-256, via `node:crypto`.
 *
 * Because the input is first canonicalized (sorted keys, preserved array
 * order, and a `toJSON`-bearing value such as a `Date` serialized via its
 * `toJSON()` result — see {@link canonicalJsonStringify}), two values that
 * are equivalent under key-order permutation always hash identically — a
 * stable content-addressable fingerprint independent of how the value was
 * constructed.
 *
 * @param value - Any value to hash.
 * @returns The lowercase hex-encoded SHA-256 digest of
 *   {@link canonicalJsonStringify}'s output for `value`.
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when the input
 *   contains, anywhere in the tree, a non-finite number, a `BigInt`, or a
 *   circular reference — see {@link canonicalJsonStringify}.
 *
 * @example
 * ```ts
 * import { canonicalJsonHash } from "@m3l-automation/m3l-common/core";
 *
 * canonicalJsonHash({ a: 1, b: 2 }) === canonicalJsonHash({ b: 2, a: 1 });
 * // true — key order does not affect the hash
 * ```
 */
export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
}
