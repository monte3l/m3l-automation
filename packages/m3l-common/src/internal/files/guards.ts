/**
 * `internal/files/guards` — public-boundary validation for `M3LFileCopier`
 * constructor options and `registerFile` arguments.
 *
 * Kept separate from the class body so each validity rule is defined once
 * and reused everywhere it applies (both numeric-threshold options; both
 * path-shaped options).
 *
 * @packageDocumentation
 */

import * as path from "node:path";

/**
 * Returns `true` when `value` is a finite integer strictly greater than
 * zero — the shared validity rule for both size-threshold options.
 * `undefined` is not validated here; callers skip the check when a
 * threshold option was omitted (it disables the corresponding behavior).
 */
export function isPositiveIntegerThreshold(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Returns `true` when `segment` is safe to `path.join` beneath a fixed root
 * directory without risk of escaping it — i.e. it is not an absolute path
 * and contains no `..` path segment (checked after normalization, so both
 * `../x` and `a/../../x` are rejected).
 *
 * Used to validate `registerFile`'s `subdir` and
 * `M3LFileCopierOptions.manifestFileName`, both of which are joined onto the
 * resolved output directory — an unsanitized value would let a caller write
 * outside the intended output tree.
 */
export function isSafeRelativeSegment(segment: string): boolean {
  if (path.isAbsolute(segment)) return false;
  const normalized = path.normalize(segment);
  const parts = normalized.split(path.sep);
  return !parts.includes("..");
}
