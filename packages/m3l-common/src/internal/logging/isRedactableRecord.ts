/**
 * `internal/logging/isRedactableRecord` — the shared "plain record" predicate
 * used by `core/logging`'s redaction pass and `core/diagnostics`'s error
 * serialization to decide whether a value's own-enumerable-properties view
 * (via `Object.entries`) can stand in for the value itself.
 *
 * Not exported from any barrel — `internal/` is private API, freely
 * changeable without a semver bump.
 *
 * @packageDocumentation
 */

/**
 * Narrows `value` to a plain, non-null, non-array object whose
 * `Object.entries` view is a faithful representation of its state.
 *
 * `Date`, `Map`, and `Set` instances are deliberately excluded even though
 * `typeof value === "object"` and none of them are arrays: their real state
 * lives in internal slots (`[[DateValue]]`, the internal map/set data) that
 * `Object.entries` cannot see — `Object.entries(new Date())` and
 * `Object.entries(new Map([["a", 1]]))` both yield `[]`. Treating one of
 * these as a plain record and rebuilding it key-by-key silently collapses it
 * to `{}`, which is a data-loss bug, not a redaction. An ordinary class
 * instance (anything other than these three built-ins) still narrows `true`
 * here — only `Date`/`Map`/`Set` are carved out.
 *
 * @param value - The candidate value.
 * @returns Whether `value` is a plain record safe to iterate via
 *   `Object.entries`.
 * @example
 * ```ts
 * import { isRedactableRecord } from "../../internal/logging/isRedactableRecord.js";
 *
 * isRedactableRecord({ a: 1 }); // true
 * isRedactableRecord(new Date()); // false
 * isRedactableRecord(new Map()); // false
 * isRedactableRecord([1, 2]); // false
 * ```
 */
export function isRedactableRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Map) &&
    !(value instanceof Set)
  );
}
