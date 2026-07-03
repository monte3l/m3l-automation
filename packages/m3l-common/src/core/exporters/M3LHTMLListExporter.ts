/**
 * `core/exporters/M3LHTMLListExporter` — HTML table report export.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

import { M3LBaseListExporter } from "./internal/baseListExporter.js";
import { onceErrorEmitter } from "./internal/onceErrorEmitter.js";
import type { M3LWriteStreamLifecycle } from "./internal/writeStreamLifecycle.js";

import type {
  M3LHTMLListExporterOptions,
  M3LListExporterStreamWriter,
} from "./types.js";

/** The HTML template rendered by {@link M3LHTMLListExporter}. */
const TEMPLATE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>Export report</title></head>
<body>
<p>Generated {{date}} — {{count}} item(s)</p>
<table>
{{items}}
</table>
</body>
</html>
`;

/**
 * Escapes HTML-significant characters in `value` so it is safe to embed as
 * element text content. Scoped to text-node content only — it does not
 * escape for use inside an HTML attribute value or a `<script>`/`<style>`
 * context.
 *
 * @param value - The raw text to escape.
 * @returns The escaped text.
 */
function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Resolves the effective column list for a row: `columns` when given,
 * otherwise every key present on `row`.
 *
 * @param row - The row to derive columns from when `columns` is absent.
 * @param columns - An explicit, ordered column selection.
 * @returns The resolved, ordered column list.
 */
function resolveColumns(
  row: Record<string, unknown>,
  columns: readonly string[] | undefined,
): readonly string[] {
  return columns ?? Object.keys(row);
}

/**
 * Renders a single cell value as display text: `undefined`/`null` become an
 * empty string, and non-primitive values are JSON-serialized rather than
 * relying on `Object`'s default (and uninformative) `"[object Object]"`
 * stringification.
 *
 * @param value - The raw cell value.
 * @returns The display text for `value`.
 */
function renderCellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Renders a single row as an HTML table row (`<tr>`) over `columns`.
 *
 * @param row - The row data.
 * @param columns - The ordered columns to render.
 * @returns The rendered `<tr>` markup.
 */
function renderRow(
  row: Record<string, unknown>,
  columns: readonly string[],
): string {
  const cells = columns
    .map((column) => `<td>${escapeHTML(renderCellText(row[column]))}</td>`)
    .join("");
  return `<tr>${cells}</tr>`;
}

/**
 * Wraps an unknown failure as an {@link M3LError} for HTML list export,
 * unless it is already one.
 *
 * @param cause - The caught value.
 * @param filePath - The destination file path, attached as error context.
 * @returns An {@link M3LError} chaining `cause`.
 */
function wrapHTMLError(cause: unknown, filePath: string): M3LError {
  if (cause instanceof M3LError) return cause;
  return new M3LError("HTML list export failed", {
    code: "ERR_HTML_LIST_EXPORT",
    context: { filePath },
    cause,
  });
}

/**
 * Renders `TEMPLATE`, substituting `{{count}}`, `{{items}}`, and `{{date}}`.
 *
 * @param rows - The rendered `<tr>` markup for every item.
 * @param count - The number of exported items.
 * @returns The fully rendered HTML document.
 */
function renderDocument(rows: readonly string[], count: number): string {
  return TEMPLATE.replace("{{count}}", String(count))
    .replace("{{items}}", rows.join("\n"))
    .replace("{{date}}", new Date().toISOString());
}

/**
 * Streaming HTML writer returned by {@link M3LHTMLListExporter.exportStream}.
 * Rows are buffered until {@link M3LHTMLStreamWriter.close}, since the
 * `{{count}}` placeholder cannot be resolved until the item count is known.
 *
 * @typeParam TItem - The shape of each appended item.
 */
class M3LHTMLStreamWriter<
  TItem extends object,
> implements M3LListExporterStreamWriter<TItem> {
  readonly #lifecycle: M3LWriteStreamLifecycle;
  readonly #columns: readonly string[] | undefined;
  readonly #filePath: string;
  readonly #onError: (error: M3LError) => void;
  readonly #rows: string[] = [];

  constructor(
    lifecycle: M3LWriteStreamLifecycle,
    columns: readonly string[] | undefined,
    filePath: string,
    onError: (error: M3LError) => void,
  ) {
    this.#lifecycle = lifecycle;
    this.#columns = columns;
    this.#filePath = filePath;
    this.#onError = onceErrorEmitter(onError);
  }

  // Buffering a row is synchronous; append() still returns a Promise to
  // satisfy the M3LListExporterStreamWriter contract, and any downstream
  // write failure surfaces on close() instead.
  append(item: TItem): Promise<void> {
    const row = item as Record<string, unknown>;
    const columns = resolveColumns(row, this.#columns);
    this.#rows.push(renderRow(row, columns));
    return Promise.resolve();
  }

  async close(): Promise<void> {
    try {
      const document = renderDocument(this.#rows, this.#rows.length);
      await this.#lifecycle.end(document);
    } catch (cause) {
      const error = wrapHTMLError(cause, this.#filePath);
      this.#onError(error);
      throw error;
    }
  }
}

/**
 * Renders a list of items as an HTML table report, substituting
 * `{{count}}`, `{{items}}`, and `{{date}}` into a template. Supports both a
 * batch `export()` and an incremental `exportStream()`.
 *
 * @typeParam TItem - The shape of each exported item.
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const exporter = new Core.M3LHTMLListExporter<{ id: string; name: string }>({
 *   filePath: "./data/outputs/report.html",
 *   columns: ["id", "name"],
 * });
 * await exporter.export([{ id: "1", name: "Ada" }]);
 * ```
 */
export class M3LHTMLListExporter<
  TItem extends object,
> extends M3LBaseListExporter<TItem> {
  readonly #columns: readonly string[] | undefined;

  /**
   * Creates an HTML list exporter.
   *
   * @param options - Construction options. `columns` restricts and orders
   *   which fields are rendered; defaults to every key on the first item.
   */
  constructor(options: M3LHTMLListExporterOptions) {
    super(options.filePath);
    this.#columns = options.columns;
  }

  /**
   * Renders `items` as a complete HTML report document.
   *
   * @param items - The items to serialize.
   * @returns The HTML file content.
   */
  protected renderBatch(items: readonly TItem[]): string {
    const rows = items.map((item) => {
      const row = item as Record<string, unknown>;
      return renderRow(row, resolveColumns(row, this.#columns));
    });
    return renderDocument(rows, items.length);
  }

  /**
   * Wraps an HTML-list-export failure as an {@link M3LError}.
   *
   * @param cause - The caught value.
   * @returns An {@link M3LError} chaining `cause`.
   */
  protected wrapError(cause: unknown): M3LError {
    return wrapHTMLError(cause, this.filePath);
  }

  /**
   * Builds the incremental HTML stream writer. Rows are buffered until
   * `close()`, since `{{count}}` cannot be resolved until every item has been
   * appended.
   *
   * @param lifecycle - The opened write-stream lifecycle.
   * @param onError - Emits `export:error` (guarded to fire at most once).
   * @returns The HTML stream writer.
   */
  protected createStreamWriter(
    lifecycle: M3LWriteStreamLifecycle,
    onError: (error: M3LError) => void,
  ): M3LListExporterStreamWriter<TItem> {
    return new M3LHTMLStreamWriter<TItem>(
      lifecycle,
      this.#columns,
      this.filePath,
      onError,
    );
  }
}
