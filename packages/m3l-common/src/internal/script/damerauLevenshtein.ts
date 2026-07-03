/**
 * `internal/script/damerauLevenshtein` — edit-distance helper for "did you
 * mean" suggestions on unrecognized preset keys.
 *
 * Not re-exported publicly; consumed only by
 * `core/script/M3LScriptPresetLoader`.
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
 * Computes the Damerau-Levenshtein distance (edit distance including
 * adjacent-transposition as a single operation, alongside insertion,
 * deletion, and substitution) between `a` and `b`.
 *
 * Uses the classic dynamic-programming table; adequate for the short
 * identifier-length strings (config/preset key names) this helper is used
 * on.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns The minimum number of edits (insert/delete/substitute/transpose)
 *   required to turn `a` into `b`.
 */
function damerauLevenshteinDistance(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;

  // d.get(i, j) holds the edit distance between a[0..i) and b[0..j).
  const d = new DistanceTable(lenA + 1, lenB + 1);

  for (let i = 0; i <= lenA; i++) d.set(i, 0, i);
  for (let j = 0; j <= lenB; j++) d.set(0, j, j);

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = d.get(i - 1, j) + 1;
      const insertion = d.get(i, j - 1) + 1;
      const substitution = d.get(i - 1, j - 1) + cost;
      let best = Math.min(deletion, insertion, substitution);

      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - TRANSPOSITION_LOOKBACK] &&
        a[i - TRANSPOSITION_LOOKBACK] === b[j - 1]
      ) {
        best = Math.min(
          best,
          d.get(i - TRANSPOSITION_LOOKBACK, j - TRANSPOSITION_LOOKBACK) + 1,
        );
      }

      d.set(i, j, best);
    }
  }

  return d.get(lenA, lenB);
}

/**
 * Finds the declared name closest to `unknownKey` among `candidates`, by
 * Damerau-Levenshtein distance. Returns `undefined` when `candidates` is
 * empty.
 *
 * @param unknownKey - The unrecognized key to find a suggestion for.
 * @param candidates - The declared names to rank against.
 * @returns The closest candidate, or `undefined` when there are none.
 */
export function findClosestMatch(
  unknownKey: string,
  candidates: readonly string[],
): string | undefined {
  let closest: string | undefined;
  let closestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = damerauLevenshteinDistance(unknownKey, candidate);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = candidate;
    }
  }

  return closest;
}
