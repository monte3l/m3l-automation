/**
 * `core/json/fieldPath` — dot-notation field-path parsing and traversal.
 *
 * These primitives parse a dot-notation string into path segments and walk a
 * nested object along those segments to retrieve a value. Every segment is
 * treated as an object-property lookup — never an array index — and the
 * traversal refuses to cross a prototype-pollution vector.
 *
 * @packageDocumentation
 */

import { isDangerousKey } from "../security/index.js";
import { isArray, isPlainObject } from "../utils/index.js";

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
 * Traverses `obj` along the segments of `path`, treating every segment as an
 * object-property lookup.
 *
 * Returns `undefined` — never throws — when: a segment is absent from the
 * current value; the current value is `null`, `undefined`, or a primitive
 * before the path is exhausted; a segment names a prototype-pollution vector
 * (`"__proto__"`, `"constructor"`, `"prototype"`); or the current value is an
 * array (field paths address object keys, not array indices).
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
 * navigateFieldPath({ items: ["x"] }, "items.0"); // undefined — arrays are not indexed
 * navigateFieldPath({ a: {} }, "a.__proto__"); // undefined — dangerous segment
 * ```
 */
export function navigateFieldPath(obj: unknown, path: string): unknown {
  const segments = parseFieldPath(path);
  let current: unknown = obj;

  for (const segment of segments) {
    if (
      isDangerousKey(segment) ||
      isArray(current) ||
      !isPlainObject(current)
    ) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}
