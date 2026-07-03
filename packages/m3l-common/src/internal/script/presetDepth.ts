/**
 * `internal/script/presetDepth` — bounded nesting-depth walker for parsed
 * preset structures.
 *
 * Not re-exported publicly; consumed only by
 * `core/script/M3LScriptPresetLoader`.
 *
 * @packageDocumentation
 */

import { isPlainObject } from "../../core/utils/index.js";

/** Sentinel returned by {@link measureDepth} for a scalar (non-container) leaf. */
const SCALAR_DEPTH = -1;

/**
 * Returns `true` when `value`'s nesting depth is less than or equal to
 * `maxDepth`.
 *
 * Depth counts nested containers (objects/arrays), **not** the container
 * that directly holds only scalar values — e.g. `{ a: 1 }` has depth `0`,
 * `{ a: { b: 1 } }` has depth `1`. This matches the intuitive "how many
 * `level`-style wrapper objects are stacked before you reach a plain value"
 * reading of nesting depth.
 *
 * Walks depth-first and short-circuits as soon as any branch exceeds
 * `maxDepth`, so a pathologically deep structure never fully traverses.
 *
 * @param value - The parsed structure to measure.
 * @param maxDepth - The maximum allowed nesting depth.
 * @returns `true` when every branch of `value` stays within `maxDepth`.
 */
export function isWithinMaxDepth(value: unknown, maxDepth: number): boolean {
  return measureDepth(value, maxDepth) <= maxDepth;
}

/**
 * Computes the nesting depth of `value` per the {@link isWithinMaxDepth}
 * convention. Once a branch's depth exceeds `maxDepth` the function returns
 * immediately with a value greater than `maxDepth` (not necessarily the
 * exact depth) — sufficient for the boundary check, and avoids continuing to
 * walk a pathologically deep structure.
 */
function measureDepth(value: unknown, maxDepth: number): number {
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) {
    return SCALAR_DEPTH;
  }

  const items: readonly unknown[] = isArray ? value : Object.values(value);
  let deepestChild = SCALAR_DEPTH;
  for (const item of items) {
    const childDepth = measureDepth(item, maxDepth);
    if (childDepth > deepestChild) {
      deepestChild = childDepth;
    }
    if (deepestChild + 1 > maxDepth) {
      // Short-circuit: already over the limit, no need to keep scanning
      // sibling items.
      return deepestChild + 1;
    }
  }
  return deepestChild + 1;
}
