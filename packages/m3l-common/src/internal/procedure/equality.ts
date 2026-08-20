/**
 * `internal/procedure/equality` — deep structural equality over
 * {@link M3LProcedureValue}, used by `compare`'s `==`/`!=` operators and by
 * array `contains`.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isArray, isPlainObject } from "../../core/utils/guards.js";

import { M3L_PROCEDURE_CONDITION_MAX_DEPTH } from "../../core/procedure/types.js";

function isContainer(value: unknown): boolean {
  return isArray(value) || isPlainObject(value);
}

/** Two arrays are equal when same length and pairwise equal, in order. */
function arraysEqual(
  left: readonly unknown[],
  right: readonly unknown[],
  depth: number,
): boolean {
  return (
    left.length === right.length &&
    left.every((element, index) => deepEqual(element, right[index], depth + 1))
  );
}

/** Two objects are equal by own enumerable string keys; key order is irrelevant. */
function objectsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  depth: number,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        deepEqual(left[key], right[key], depth + 1),
    )
  );
}

/**
 * Deep structural equality per
 * `docs/reference/core/procedure.md` § Deep structural equality:
 *
 * - Scalars compare with `===`, which already gives both documented
 *   departures from `Object.is` for free — `NaN === NaN` is `false` and
 *   `+0 === -0` is `true`.
 * - Arrays compare pairwise, in order; a length mismatch is never equal.
 * - Objects compare by their own enumerable string keys — key order is
 *   irrelevant, but a key present with value `null` is not equal to an
 *   absent key, since the key sets themselves differ.
 * - A scalar never equals a container, and an array never equals an object.
 *
 * Recursion is bounded by {@link M3L_PROCEDURE_CONDITION_MAX_DEPTH} (depth
 * strictly greater than the bound yields `false`), so a caller-built
 * self-referential value returns `false` instead of overflowing the stack —
 * except when `left` and `right` are the very same reference (or the same
 * primitive), which the leading `===` fast path resolves as `true` before
 * the depth bound is even consulted; this is the one case "equal" is
 * unambiguously correct regardless of how deep the structure recurses. The
 * fast path does not disturb the documented `NaN`/`+0`/`-0` scalar semantics
 * below — `NaN === NaN` is `false`, so a self-referential value holding
 * `NaN` still falls through to the structural walk (and, per the scalar
 * rule, still compares unequal to itself there).
 */
export function deepEqual(
  left: unknown,
  right: unknown,
  depth: number,
): boolean {
  if (left === right) return true;
  if (depth > M3L_PROCEDURE_CONDITION_MAX_DEPTH) return false;
  if (isArray(left) && isArray(right)) return arraysEqual(left, right, depth);
  if (isPlainObject(left) && isPlainObject(right))
    return objectsEqual(left, right, depth);
  if (isContainer(left) || isContainer(right)) return false;
  return left === right;
}
