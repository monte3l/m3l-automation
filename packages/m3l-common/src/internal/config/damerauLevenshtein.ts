/**
 * `internal/config/damerauLevenshtein` — restricted (OSA-variant)
 * Damerau-Levenshtein edit distance, used by
 * {@link M3LUnknownParameterDetector.detectWithSuggestions} to rank "did you
 * mean" candidates for an unrecognized configuration key.
 *
 * Private to `core/config`; never re-exported through a public barrel.
 *
 * @packageDocumentation
 */

/**
 * A flat, in-bounds accessor over the dynamic-programming table used by
 * {@link damerauLevenshteinDistance}. Every index this module ever reads or
 * writes is within `[0, lenA] x [0, lenB]` by loop construction, so the
 * accessor never needs a bounds check — it exists only to centralize the
 * row-major index math and to satisfy `noUncheckedIndexedAccess` without
 * scattering non-null assertions through the algorithm.
 */
class DistanceTable {
  private readonly cols: number;
  private readonly cells: number[];

  constructor(rowCount: number, colCount: number) {
    this.cols = colCount;
    this.cells = new Array<number>(rowCount * colCount).fill(0);
  }

  /** Reads the value at `(i, j)`. */
  get(i: number, j: number): number {
    // The index is always in-bounds by loop construction; the `?? 0` fallback
    // is unreachable and present only to satisfy `noUncheckedIndexedAccess`
    // without a non-null assertion (and without introducing a throw).
    return this.cells[i * this.cols + j] ?? 0;
  }

  /** Writes `value` at `(i, j)`. */
  set(i: number, j: number, value: number): void {
    this.cells[i * this.cols + j] = value;
  }
}

/**
 * The lookback distance for the adjacent-transposition check — the "D" in
 * Damerau-Levenshtein: swapping two adjacent characters counts as a single
 * edit, so the check compares against the table cell two rows and two
 * columns back.
 */
const TRANSPOSITION_LOOKBACK = 2;

/**
 * Computes the base insertion/deletion/substitution cell value for `(i, j)`,
 * given the already-computed `deletion`, `insertion`, and `substitution`
 * costs — split out of {@link damerauLevenshteinDistance} to keep that
 * function's cyclomatic complexity under the project's ESLint limit.
 */
function baseCost(
  deletion: number,
  insertion: number,
  substitution: number,
): number {
  return Math.min(deletion, insertion, substitution);
}

/**
 * Returns `true` when `a[i - 1]` and `a[i - 2]` are an adjacent transposition
 * of `b[j - 1]` and `b[j - 2]` — i.e. swapping them turns one into the other.
 */
function isAdjacentTransposition(
  a: string,
  b: string,
  i: number,
  j: number,
): boolean {
  return (
    i > 1 &&
    j > 1 &&
    a[i - 1] === b[j - TRANSPOSITION_LOOKBACK] &&
    a[i - TRANSPOSITION_LOOKBACK] === b[j - 1]
  );
}

/**
 * Computes the restricted (OSA-variant) Damerau-Levenshtein distance between
 * `a` and `b`: the minimum number of insertions, deletions, substitutions,
 * and adjacent-character transpositions required to turn `a` into `b`, each
 * costing 1. Case-sensitive — no implicit normalization.
 *
 * Uses the classic dynamic-programming table; adequate for the short
 * identifier-length strings (config parameter names) this helper is used on.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns The edit distance between `a` and `b`.
 *
 * @example
 * ```ts
 * // Internal-only helper — not re-exported through a public barrel; called
 * // from within core/config via a relative import, e.g.:
 * // import { damerauLevenshteinDistance } from "./damerauLevenshtein.js";
 * damerauLevenshteinDistance("region", "regoin"); // 1 (adjacent transposition)
 * ```
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;

  // table.get(i, j) holds the edit distance between a[0..i) and b[0..j).
  const table = new DistanceTable(lenA + 1, lenB + 1);

  for (let i = 0; i <= lenA; i++) table.set(i, 0, i);
  for (let j = 0; j <= lenB; j++) table.set(0, j, j);

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = table.get(i - 1, j) + 1;
      const insertion = table.get(i, j - 1) + 1;
      const substitution = table.get(i - 1, j - 1) + cost;
      let best = baseCost(deletion, insertion, substitution);

      if (isAdjacentTransposition(a, b, i, j)) {
        best = Math.min(
          best,
          table.get(i - TRANSPOSITION_LOOKBACK, j - TRANSPOSITION_LOOKBACK) + 1,
        );
      }

      table.set(i, j, best);
    }
  }

  return table.get(lenA, lenB);
}
