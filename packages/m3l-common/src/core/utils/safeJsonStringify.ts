/**
 * `core/utils/safeJsonStringify` — serialization helpers that never throw.
 *
 * `safeJsonStringify` handles BigInt, Symbol, Function, Map, Set, and
 * circular references. `valueToString` returns a human-readable string for
 * any value without throwing.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/** Default maximum serialization depth. */
const DEFAULT_DEPTH = 10;

/**
 * Converts a primitive-adjacent value to a JSON-safe scalar. Returns
 * `undefined` when the value is not one of the recognized simple types.
 */
function primitiveToJson(
  value: unknown,
): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return value.description ?? "";
  if (typeof value === "function") return "";
  return undefined;
}

/**
 * Handles object-type values (arrays, Map, Set, plain objects/class instances).
 * Mutates neither the input nor the visited set permanently — the caller is
 * responsible for removing `value` from `visited` after recursion.
 */
function objectToJson(
  value: object,
  depth: number,
  maxDepth: number,
  visited: WeakSet<object>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      prepareForJson(item, depth + 1, maxDepth, visited),
    );
  }
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([k, v]) => [
      prepareForJson(k, depth + 1, maxDepth, visited),
      prepareForJson(v, depth + 1, maxDepth, visited),
    ]);
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((item) =>
      prepareForJson(item, depth + 1, maxDepth, visited),
    );
  }
  // Plain object or class instance — enumerate own keys
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    obj[key] = prepareForJson(
      (value as Record<string, unknown>)[key],
      depth + 1,
      maxDepth,
      visited,
    );
  }
  return obj;
}

/**
 * Recursively prepares a value for JSON serialization by replacing
 * unsupported types with safe equivalents. Tracks visited objects via
 * `WeakSet` to detect circular references (path-based: an object visited in
 * the current traversal path is circular, but the same object appearing in a
 * separate branch is not).
 */
function prepareForJson(
  value: unknown,
  depth: number,
  maxDepth: number,
  visited: WeakSet<object>,
): unknown {
  // Depth check — exceeded limit means the parent requested this child
  if (depth > maxDepth) {
    return "[Max Depth]";
  }

  // Try primitives first (handles null, undefined, string, number, boolean,
  // bigint, symbol, function).
  const primitive = primitiveToJson(value);
  if (primitive !== undefined || value === null || value === undefined) {
    return primitive ?? null;
  }

  // value is a non-null, non-primitive at this point — narrow explicitly
  if (typeof value !== "object") {
    // Unreachable: all non-object types are handled by primitiveToJson.
    // Use a literal fallback to avoid no-base-to-string on unknown.
    return "[unknown]";
  }

  if (visited.has(value)) {
    return "[Circular]";
  }
  visited.add(value);
  const result = objectToJson(value, depth, maxDepth, visited);
  visited.delete(value);
  return result;
}

/**
 * Serializes any value to a JSON string. Handles circular references, BigInt,
 * Symbol, Function, Map, and Set gracefully. Throws only when `depth` is not
 * a positive integer.
 *
 * - Circular references are replaced with `"[Circular]"`
 * - Values nested deeper than `depth` (default `10`) are replaced with
 *   `"[Max Depth]"`
 * - `BigInt` values serialize as their string representation
 * - `Symbol` values serialize as their description (or `""` if none)
 * - `Function` values serialize as `""`
 * - `Map` values serialize as `[[key, value], ...]` pairs
 * - `Set` values serialize as `[value, ...]` arrays
 * - Passing `undefined` as `value` produces `"null"` (undefined is mapped to
 *   null during preparation)
 *
 * @param value - Any value to serialize.
 * @param depth - Maximum traversal depth (default `10`). Must be a positive
 *   integer when provided.
 * @returns A valid JSON string.
 * @throws `M3LError` When `depth` is provided but is not a positive integer.
 *
 * @example
 * ```typescript
 * import { safeJsonStringify } from "@m3l-automation/m3l-common/core";
 * const obj: Record<string, unknown> = { name: "test" };
 * obj["self"] = obj;
 * const json = safeJsonStringify(obj); // contains "[Circular]"
 * safeJsonStringify(undefined); // "null"
 * ```
 */
export function safeJsonStringify(value: unknown, depth?: number): string {
  const maxDepth = depth ?? DEFAULT_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new M3LError(
      `safeJsonStringify: depth must be a positive integer, got ${String(maxDepth)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
  const visited = new WeakSet<object>();
  const prepared = prepareForJson(value, 0, maxDepth, visited);
  return JSON.stringify(prepared) ?? "null";
}

/**
 * Returns the String() representation for non-object primitives, or
 * `undefined` when `v` is null, undefined, a string, or an object type.
 * Extracted to keep {@link valueToString} below the complexity limit.
 */
function primitiveValueToString(
  v: number | boolean | bigint | symbol | ((...a: unknown[]) => unknown),
): string {
  return String(v);
}

/**
 * Converts any value to a human-readable string. Never throws.
 *
 * - `null` → `"null"`
 * - `undefined` → `"undefined"`
 * - Strings → returned as-is
 * - Numbers, booleans, bigint → `String(v)`
 * - `Error` instances → `v.message`
 * - Symbols, functions → `String(v)`
 * - Objects and arrays → `JSON.stringify(v)` with an `[unserializable: reason]`
 *   fallback
 *
 * @param value - Any value.
 * @returns A human-readable string representation.
 *
 * @example
 * ```typescript
 * import { valueToString } from "@m3l-automation/m3l-common/core";
 * const msg = valueToString(new Error("oops")); // "oops"
 * ```
 */
export function valueToString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    // Object types — check for Error before falling through to JSON
    if (value instanceof Error) return value.message;
    try {
      return JSON.stringify(value);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return `[unserializable: ${reason}]`;
    }
  }
  // Non-object primitives: number | boolean | bigint | symbol | function
  return primitiveValueToString(
    value as
      number | boolean | bigint | symbol | ((...a: unknown[]) => unknown),
  );
}
