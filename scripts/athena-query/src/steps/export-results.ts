/**
 * `steps/export-results` — writes the full `athena-query` result row set to
 * the output file, once.
 *
 * Business logic lives here — never in `main.ts`. Dispatches on `format` to
 * the whole-array `Core.M3LJSONListExporter` / `Core.M3LCSVListExporter`,
 * calling `export(items)` exactly once with every row `awaitResults`
 * returned — never the streaming `exportStream()`/`append()` API.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

/**
 * Writes `rows` to the `output` file under `M3L_OUTPUT_DIR`, in the
 * `format`-selected encoding.
 *
 * @param deps - `rows` (the full result set), `format` (selects the
 *   exporter), `output` (the destination file name, resolved via `paths`),
 *   and `paths` (for path resolution).
 * @returns Resolves once the export completes.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { exportResults } from "./export-results.js";
 *
 * async function finish(paths: Core.M3LPaths): Promise<void> {
 *   await exportResults({
 *     rows: [{ id: "1", name: "alice" }],
 *     format: "json",
 *     output: "results.json",
 *     paths,
 *   });
 * }
 * ```
 */
export async function exportResults(deps: {
  readonly rows: readonly AWS.AthenaRow[];
  readonly format: "json" | "csv";
  readonly output: string;
  readonly paths: Core.M3LPaths;
}): Promise<void> {
  const filePath = deps.paths.resolveOutput(deps.output);

  switch (deps.format) {
    case "json": {
      const exporter = new Core.M3LJSONListExporter<AWS.AthenaRow>({
        filePath,
      });
      await exporter.export(deps.rows);
      return;
    }
    case "csv": {
      const exporter = new Core.M3LCSVListExporter<AWS.AthenaRow>({
        filePath,
      });
      await exporter.export(deps.rows);
      return;
    }
    default: {
      const exhaustive: never = deps.format;
      throw new Core.M3LError(
        `unhandled export format: ${String(exhaustive)}`,
        {
          code: "ERR_ATHENA_EXPORT_FORMAT",
        },
      );
    }
  }
}
