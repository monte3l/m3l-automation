/**
 * `internal/json/compare-code-points` — the Unicode code-point string
 * comparator shared by `core/json`'s canonical key ordering and
 * `core/agent`'s dry-run shape key.
 *
 * Moved out of `core/json/canonicalJson.ts` (where it was module-private) so
 * a second module can reuse it without duplicating it: a duplicate would
 * silently drift, and `core/agent`'s dry-run shape key is a **stored value**
 * whose contract makes this exact comparator normative and breaking-to-change
 * (docs/reference/core/agent.md § Dry-run-first).
 *
 * Private to the library; never re-exported through a public barrel.
 */

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
export function compareByCodePoint(a: string, b: string): number {
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
