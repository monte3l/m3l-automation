/**
 * XLSX text extractor backed by the optional `read-excel-file` peer dependency.
 *
 * @packageDocumentation
 */

import type * as ReadExcelFileNode from "read-excel-file/node";

import { M3LTextExtractionError } from "./errors.js";
import type { M3LTextExtractionResult, M3LTextExtractor } from "./contract.js";

/**
 * Extracts spreadsheet cell text from XLSX files using `read-excel-file`.
 *
 * Each sheet's rows are rendered as tab-separated cells, one row per line, so
 * headers and values survive into the flat text output.
 *
 * `read-excel-file` is an **optional peer dependency** loaded via a lazy
 * dynamic `import()` on the first {@link extract} call — never at module load
 * or construction. If it is absent, `extract()` throws an
 * {@link M3LTextExtractionError} naming the missing dependency.
 *
 * @example
 * ```ts
 * import { M3LXlsxTextExtractor } from "@m3l-automation/m3l-common/core";
 *
 * const extractor = new M3LXlsxTextExtractor();
 * const { text } = await extractor.extract("./data.xlsx");
 * ```
 */
export class M3LXlsxTextExtractor implements M3LTextExtractor {
  /** MIME types handled by this extractor. */
  readonly mimeTypes: readonly string[] = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];

  /** File extensions handled by this extractor. */
  readonly extensions: readonly string[] = [".xlsx"];

  /**
   * Extracts the spreadsheet cell text.
   *
   * @param filePath - Path to the `.xlsx` file.
   * @returns The flattened, tab-separated cell text.
   * @throws {@link M3LTextExtractionError} if `read-excel-file` is absent or
   *   extraction fails.
   */
  async extract(filePath: string): Promise<M3LTextExtractionResult> {
    const { default: readXlsxFile } = await loadReadExcelFile();
    try {
      // `read-excel-file` types its cell union loosely (e.g. `typeof Date`
      // rather than `Date`); narrow the boundary to the concrete `Cell` values
      // it actually yields so `formatCell` stays exhaustive without dead arms.
      const sheets = (await readXlsxFile(
        filePath,
      )) as unknown as readonly ReadExcelSheet[];
      const text = renderSheets(sheets);
      return { text, truncated: false };
    } catch (cause) {
      throw new M3LTextExtractionError(
        `failed to extract XLSX text from '${filePath}'`,
        { code: "ERR_TEXT_EXTRACTION", context: { filePath }, cause },
      );
    }
  }
}

/**
 * A single spreadsheet cell value as yielded by `read-excel-file`: only these
 * primitives (plus `Date` and `null`) ever appear in a parsed sheet.
 */
type Cell = string | number | boolean | Date | null;

/** A single sheet as returned by `read-excel-file`. */
type ReadExcelSheet = { sheet: string; data: readonly (readonly Cell[])[] };

/**
 * Renders every sheet as tab-separated rows, sheets separated by a blank line.
 */
function renderSheets(sheets: readonly ReadExcelSheet[]): string {
  return sheets
    .map((sheet) =>
      sheet.data.map((row) => row.map(formatCell).join("\t")).join("\n"),
    )
    .join("\n\n");
}

/**
 * Formats a single spreadsheet cell as text. `read-excel-file` yields
 * heterogeneous cell values (string, number, boolean, `Date`, or `null`); we
 * render `null` as empty, `Date` as its ISO string, and the remaining
 * primitives via `String()`.
 */
function formatCell(cell: Cell): string {
  if (cell === null) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell); // string | number | boolean
}

/**
 * Lazily loads `read-excel-file`, wrapping an absent peer dependency as a typed
 * error.
 *
 * Uses the package's `/node` subpath: `read-excel-file` ships no bare/main
 * export (its `exports` map exposes only `/node`, `/browser`, etc.), so the
 * bare specifier is unresolvable.
 */
async function loadReadExcelFile(): Promise<typeof ReadExcelFileNode> {
  try {
    return await import("read-excel-file/node");
  } catch (cause) {
    throw new M3LTextExtractionError(
      "could not load the optional peer dependency 'read-excel-file' for XLSX extraction; ensure it is installed",
      {
        code: "ERR_TEXT_EXTRACTION_MISSING_DEP",
        context: { dependency: "read-excel-file" },
        cause,
      },
    );
  }
}
