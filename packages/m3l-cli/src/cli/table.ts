/**
 * `cli/table` — the shared per-column max-width `padEnd` alignment algorithm,
 * extracted from `commands/list.ts`'s original inline `formatRowLines` (8d
 * dedup refactor, 8b review CR#5). Both `commands/list.ts` and
 * `commands/inspect.ts` render their human-readable output through it.
 *
 * @packageDocumentation
 */

/**
 * Formats `header` plus `rows` into aligned lines: every column except the
 * last is `padEnd`'d to the widest value in that column (header included),
 * so no line's last column ever carries trailing whitespace.
 *
 * @param header - The column header cells.
 * @param rows - Zero or more data rows; each must have the same number of
 *   cells as `header`.
 * @returns One line per input row, prefixed by the header line — `rows.length + 1` lines total.
 * @throws {@link Error} when any `row` in `rows` doesn't have exactly
 *   `header.length` cells — a programmer-error guard against a caller
 *   contract violation, not a user-facing failure.
 *
 * @example
 * ```ts
 * const lines = formatAlignedTable(
 *   ["NAME", "AGE"],
 *   [
 *     ["alice", "30"],
 *     ["bob", "5"],
 *   ],
 * );
 * // ["NAME   AGE", "alice  30", "bob    5"]
 * ```
 */
export function formatAlignedTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const columnCount = header.length;

  for (const row of rows) {
    if (row.length !== columnCount) {
      throw new Error(
        `formatAlignedTable: row of length ${String(row.length)} does not match header of length ${String(columnCount)}`,
      );
    }
  }

  // Every `row` is now confirmed the same length as `header` (validated
  // above), so `row[columnIndex]`/`columnWidths[columnIndex]` for a
  // `columnIndex` bounded by `header`'s own iteration is always in range —
  // the `?? ""`/`?? 0` fallbacks below are honest defaults that
  // `noUncheckedIndexedAccess` requires but the guard above makes
  // unreachable in practice.
  const columnWidths = header.map((headerCell, columnIndex) =>
    Math.max(
      headerCell.length,
      ...rows.map((row) => {
        /* istanbul ignore next -- unreachable: the guard above already
           throws for any row whose length differs from header.length, so
           row[columnIndex] is always defined for a columnIndex bounded by
           header's own iteration. */
        return (row[columnIndex] ?? "").length;
      }),
    ),
  );

  const formatLine = (cells: readonly string[]): string =>
    cells
      .map((cell, columnIndex) => {
        if (columnIndex === columnCount - 1) {
          return cell;
        }
        /* istanbul ignore next -- unreachable: columnWidths has exactly
           header.length entries (built by header.map above), and
           columnIndex here is always < header.length. */
        return cell.padEnd(columnWidths[columnIndex] ?? 0);
      })
      .join("  ");

  return [formatLine(header), ...rows.map((row) => formatLine(row))];
}
