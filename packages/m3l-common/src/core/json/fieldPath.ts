/**
 * `core/json/fieldPath` — dot-notation field-path parsing and traversal.
 *
 * These primitives parse a dot-notation string into path segments and walk a
 * nested object along those segments to retrieve a value. A segment indexes
 * into an array when the current value is an array (a digit-only segment) and
 * looks up an object key otherwise; a `*` segment fans out over every array
 * element / own object value for the multi-valued {@link extractAll}. The
 * traversal refuses to cross a prototype-pollution vector.
 *
 * @packageDocumentation
 */

import { isDangerousKey } from "../security/index.js";
import { isArray, isPlainObject } from "../utils/index.js";

/** Matches a segment that is entirely decimal digits (a valid array index). */
const DIGIT_ONLY_PATTERN = /^\d+$/;

/**
 * Parses a dot-notation field path into its constituent segments, dropping
 * empty segments produced by leading/trailing/repeated dots.
 *
 * Pure and total: every string input, including the empty string and strings
 * of arbitrary length, produces a result without throwing.
 *
 * @param path - A dot-notation field path, e.g. `"metadata.author"`.
 * @returns The non-empty segments of `path`, in order. An input with no
 *   non-empty segments (e.g. `""` or `"."`) returns an empty array.
 *
 * @example
 * ```typescript
 * import { parseFieldPath } from "@m3l-automation/m3l-common/core";
 * parseFieldPath("metadata.author"); // ["metadata", "author"]
 * parseFieldPath("items.0.name"); // ["items", "0", "name"]
 * parseFieldPath(""); // []
 * ```
 */
export function parseFieldPath(path: string): readonly string[] {
  return path.split(".").filter((segment) => segment.length > 0);
}

/**
 * Resolves a single non-wildcard segment against `current`, in the shared
 * single-value semantics used by both {@link navigateFieldPath} and the
 * multi-value traversal behind {@link extractAll}: a digit-only segment
 * indexes into an array, any other segment looks up an object key, and a
 * dangerous segment or a shape mismatch always misses.
 *
 * Kept private: it applies exactly one non-wildcard segment and does not
 * itself understand `*`, so {@link navigateFieldPath} (which never expands
 * `*`) and the multi-value wildcard fan-out in {@link extractAll} each layer
 * their own segment-kind decision on top of it.
 *
 * @param current - The value to resolve the segment against.
 * @param segment - A single non-wildcard path segment.
 * @returns `{ hit: true, value }` when the segment resolves, `{ hit: false }`
 *   otherwise. The wrapper distinguishes "resolved to `undefined`" from "did
 *   not resolve", since both are legitimate outcomes.
 */
function resolveLiteralSegment(
  current: unknown,
  segment: string,
): { readonly hit: true; readonly value: unknown } | { readonly hit: false } {
  if (isDangerousKey(segment)) {
    return { hit: false };
  }
  if (isArray(current)) {
    if (!DIGIT_ONLY_PATTERN.test(segment)) {
      return { hit: false };
    }
    const index = Number(segment);
    if (index >= current.length) {
      return { hit: false };
    }
    return { hit: true, value: current[index] };
  }
  if (isPlainObject(current)) {
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { hit: false };
    }
    return { hit: true, value: current[segment] };
  }
  return { hit: false };
}

/**
 * Traverses `obj` along the segments of `path`, returning a single value.
 *
 * A digit-only segment (e.g. `"1"`) indexes into an array when the current
 * value is an array; the same segment remains an object-key lookup on a
 * plain object (so `{ "0": "x" }` still resolves at `items.0`). A `*`
 * segment is not treated specially — it is looked up as a literal key/index,
 * which almost always misses; use {@link extractAll} to expand wildcards.
 *
 * Returns `undefined` — never throws — when: a segment is absent from the
 * current value; the current value is `null`, `undefined`, or a primitive
 * before the path is exhausted; a segment names a prototype-pollution vector
 * (`"__proto__"`, `"constructor"`, `"prototype"`); or an array segment is
 * non-digit or out of range.
 *
 * @param obj - The value to traverse. Typed `unknown` because callers pass
 *   arbitrary parsed data (e.g. JSON records).
 * @param path - A dot-notation field path.
 * @returns The value at `path`, or `undefined` when the path cannot be
 *   resolved.
 *
 * @example
 * ```typescript
 * import { navigateFieldPath } from "@m3l-automation/m3l-common/core";
 * navigateFieldPath({ metadata: { author: "Ada" } }, "metadata.author");
 * // "Ada"
 * navigateFieldPath({ items: ["x", "y"] }, "items.1"); // "y"
 * navigateFieldPath({ a: {} }, "a.__proto__"); // undefined — dangerous segment
 * ```
 */
export function navigateFieldPath(obj: unknown, path: string): unknown {
  const segments = parseFieldPath(path);
  let current: unknown = obj;

  for (const segment of segments) {
    const resolved = resolveLiteralSegment(current, segment);
    if (!resolved.hit) {
      return undefined;
    }
    current = resolved.value;
  }

  return current;
}

/**
 * Expands a single path segment against one frontier value into the values
 * it contributes to the next frontier, in document order.
 *
 * Kept private and multi-valued (unlike {@link resolveLiteralSegment}): a
 * `*` segment fans out to every array element or every own enumerable,
 * non-dangerous object value; any other segment defers to
 * {@link resolveLiteralSegment} and contributes zero or one value.
 *
 * @param current - The frontier value the segment is applied to.
 * @param segment - A single path segment, possibly `"*"`.
 * @returns The values this segment contributes from `current`, in order.
 */
function expandSegment(current: unknown, segment: string): readonly unknown[] {
  if (segment === "*") {
    if (isArray(current)) {
      return [...current];
    }
    if (isPlainObject(current)) {
      return Object.keys(current)
        .filter((key) => !isDangerousKey(key))
        .map((key) => current[key]);
    }
    return [];
  }

  const resolved = resolveLiteralSegment(current, segment);
  return resolved.hit ? [resolved.value] : [];
}

/**
 * Extracts every value in `record` matching the dot-notation `path`,
 * expanding `*` wildcards, in document order.
 *
 * Depth-first, left-to-right: each segment is applied to every value in the
 * current frontier (starting from `[record]`), and the surviving values
 * become the next frontier. A `*` segment fans out over every array element
 * or every own enumerable object value (dangerous keys never surface); any
 * other segment resolves like {@link navigateFieldPath} and either keeps or
 * drops each frontier value.
 *
 * A wildcard-free path therefore yields 0 or 1 elements (a present nullish
 * value, e.g. `null`, still counts as a match); a wildcard path yields all
 * matches. An empty `path` returns `record` itself as the sole element.
 * Never throws — a shape mismatch drops that branch rather than raising.
 *
 * @param record - The value to extract from. Typed `unknown` because callers
 *   pass arbitrary parsed data (e.g. JSON records).
 * @param path - A dot-notation field path, optionally containing `*`
 *   wildcard segments.
 * @returns Every matching value, in document order. Empty when nothing
 *   matches.
 *
 * @example
 * ```typescript
 * import { extractAll } from "@m3l-automation/m3l-common/core";
 * extractAll({ items: [{ id: 1 }, { id: 2 }] }, "items.*.id"); // [1, 2]
 * extractAll({ a: { v: 1 }, b: { v: 2 } }, "*.v"); // [1, 2]
 * extractAll({ metadata: {} }, "metadata.author"); // []
 * ```
 */
export function extractAll(record: unknown, path: string): readonly unknown[] {
  const segments = parseFieldPath(path);
  let frontier: readonly unknown[] = [record];

  for (const segment of segments) {
    const next: unknown[] = [];
    for (const current of frontier) {
      next.push(...expandSegment(current, segment));
    }
    frontier = next;
  }

  return frontier;
}
