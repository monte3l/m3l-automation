/**
 * `core/logging/M3LTableFormatter` — per-column-aligned, ANSI-aware table
 * rendering.
 *
 * @packageDocumentation
 */

import stringWidth from "string-width";

import { M3LError } from "../errors/index.js";

/**
 * A single column definition for {@link M3LTableFormatter.format}.
 *
 * @example
 * ```ts
 * import type { M3LTableColumn } from "@m3l-automation/m3l-common/core";
 *
 * const column: M3LTableColumn = { key: "rows", header: "Row Count", align: "right" };
 * ```
 */
export interface M3LTableColumn {
  /** The row property key rendered by this column. */
  readonly key: string;
  /** Display header text; defaults to `key` when omitted. */
  readonly header?: string;
  /** Column text alignment; defaults to `"left"`. */
  readonly align?: "left" | "right" | "center";
}

/**
 * Options accepted by {@link M3LTableFormatter.format}.
 *
 * @example
 * ```ts
 * import type { M3LTableOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LTableOptions = { border: "compact" };
 * ```
 */
export interface M3LTableOptions {
  /** Border style; defaults to `"full"`. */
  readonly border?: "full" | "border-less" | "compact";
  /** Explicit column definitions; defaults to the keys of the first row, in insertion order. */
  readonly columns?: readonly M3LTableColumn[];
}

/** Resolved, non-optional per-column layout used internally while rendering. */
interface ResolvedColumn {
  readonly key: string;
  readonly header: string;
  readonly align: "left" | "right" | "center";
  readonly width: number;
}

/**
 * The number of single-space padding columns surrounding a cell's text
 * inside a `"full"`-border box (one space on each side of `│ text │`).
 */
const FULL_BORDER_CELL_PADDING = 2;

/** The number of sides (left/right) split when centering padding around text. */
const CENTER_PADDING_SIDES = 2;

/** Box-drawing characters for the `"full"` border style. */
const FULL_BORDER = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  headerLeft: "├",
  headerRight: "┤",
} as const;

/** Pads `text` to `width` visible columns according to `align`. */
function pad(
  text: string,
  width: number,
  align: "left" | "right" | "center",
): string {
  const deficit = Math.max(0, width - stringWidth(text));
  switch (align) {
    case "left":
      return text + " ".repeat(deficit);
    case "right":
      return " ".repeat(deficit) + text;
    case "center": {
      const leftPad = Math.floor(deficit / CENTER_PADDING_SIDES);
      const rightPad = deficit - leftPad;
      return " ".repeat(leftPad) + text + " ".repeat(rightPad);
    }
    default: {
      const exhaustive: never = align;
      throw new M3LError(`unhandled alignment: ${String(exhaustive)}`, {
        code: "ERR_LOG_TABLE_ALIGN",
      });
    }
  }
}

/**
 * Renders a value cell to display text: empty for `undefined`/`null`,
 * `String(...)` for scalars, and `JSON.stringify(...)` for objects/arrays —
 * `String()` on a plain object/array collapses to the useless
 * `"[object Object]"` (or a comma-joined mess for arrays of objects), so
 * non-scalars are serialized instead of naively stringified.
 */
function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Objects/arrays/functions/symbols: `String()` on these collapses to the
  // useless "[object Object]" (or drops information for arrays of objects),
  // so serialize structured values instead of naively stringifying them.
  // `JSON.stringify` returns `undefined` only for values it cannot encode
  // (functions, symbols) — fall back to a fixed placeholder for those.
  return JSON.stringify(value) ?? "[unserializable]";
}

/**
 * Renders tabular data as an aligned, optionally-bordered string. Column
 * widths are measured with `string-width` so ANSI-colored or wide-glyph
 * cells line up by *visible* width, not raw character count.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const formatter = new Core.M3LTableFormatter();
 * const output = formatter.format(
 *   [{ profile: "prod", rows: 1200 }],
 *   { border: "full" },
 * );
 * ```
 */
export class M3LTableFormatter {
  /**
   * Renders `rows` to a multi-line table string.
   *
   * @param rows - The rows to render; each row's keys become columns unless
   *   `options.columns` is supplied.
   * @param options - Rendering options.
   * @returns The rendered, multi-line table string.
   */
  format(
    rows: readonly Record<string, unknown>[],
    options?: M3LTableOptions,
  ): string {
    const border = options?.border ?? "full";
    const columns = this.resolveColumns(rows, options?.columns);

    switch (border) {
      case "full":
        return this.renderFull(columns, rows);
      case "border-less":
        return this.renderBorderLess(columns, rows);
      case "compact":
        return this.renderCompact(columns, rows);
      default: {
        const exhaustive: never = border;
        throw new M3LError(`unhandled border style: ${String(exhaustive)}`, {
          code: "ERR_LOG_TABLE_BORDER",
        });
      }
    }
  }

  /** Computes header text, alignment, and visible width for every column. */
  private resolveColumns(
    rows: readonly Record<string, unknown>[],
    declared: readonly M3LTableColumn[] | undefined,
  ): readonly ResolvedColumn[] {
    const definitions: readonly M3LTableColumn[] =
      declared ?? Object.keys(rows[0] ?? {}).map((key) => ({ key }));

    return definitions.map((column) => {
      const header = column.header ?? column.key;
      const align = column.align ?? "left";
      const width = rows.reduce(
        (max, row) => Math.max(max, stringWidth(cellText(row[column.key]))),
        stringWidth(header),
      );
      return { key: column.key, header, align, width };
    });
  }

  /** Renders one data (or header) row's cells, joined by `separator`. */
  private renderRowCells(
    columns: readonly ResolvedColumn[],
    values: readonly string[],
    separator: string,
  ): string {
    return columns
      .map((column, index) =>
        pad(values[index] ?? "", column.width, column.align),
      )
      .join(separator);
  }

  /** Renders the `"full"` border style, with a top/header/bottom box. */
  private renderFull(
    columns: readonly ResolvedColumn[],
    rows: readonly Record<string, unknown>[],
  ): string {
    const b = FULL_BORDER;
    const horizontalSegments = columns.map((column) =>
      b.horizontal.repeat(column.width + FULL_BORDER_CELL_PADDING),
    );
    const top = `${b.topLeft}${horizontalSegments.join(b.horizontal)}${b.topRight}`;
    const headerDivider = `${b.headerLeft}${horizontalSegments.join(b.horizontal)}${b.headerRight}`;
    const bottom = `${b.bottomLeft}${horizontalSegments.join(b.horizontal)}${b.bottomRight}`;

    const renderLine = (values: readonly string[]): string =>
      `${b.vertical} ${this.renderRowCells(columns, values, ` ${b.vertical} `)} ${b.vertical}`;

    const headerLine = renderLine(columns.map((column) => column.header));
    const dataLines = rows.map((row) =>
      renderLine(columns.map((column) => cellText(row[column.key]))),
    );

    return [top, headerLine, headerDivider, ...dataLines, bottom].join("\n");
  }

  /** Renders the `"border-less"` style: no box characters, a header underline. */
  private renderBorderLess(
    columns: readonly ResolvedColumn[],
    rows: readonly Record<string, unknown>[],
  ): string {
    const separator = "  ";
    const headerLine = this.renderRowCells(
      columns,
      columns.map((column) => column.header),
      separator,
    );
    const underline = columns
      .map((column) => "-".repeat(column.width))
      .join(separator);
    const dataLines = rows.map((row) =>
      this.renderRowCells(
        columns,
        columns.map((column) => cellText(row[column.key])),
        separator,
      ),
    );

    return [headerLine, underline, ...dataLines].join("\n");
  }

  /** Renders the `"compact"` style: no border characters, single-space columns. */
  private renderCompact(
    columns: readonly ResolvedColumn[],
    rows: readonly Record<string, unknown>[],
  ): string {
    const separator = " ";
    const headerLine = this.renderRowCells(
      columns,
      columns.map((column) => column.header),
      separator,
    );
    const dataLines = rows.map((row) =>
      this.renderRowCells(
        columns,
        columns.map((column) => cellText(row[column.key])),
        separator,
      ),
    );

    return [headerLine, ...dataLines].join("\n");
  }
}
