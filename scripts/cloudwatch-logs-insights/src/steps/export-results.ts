/**
 * `steps/export-results` — writes the full accumulated
 * `cloudwatch-logs-insights` row set to the output file, once.
 *
 * Business logic lives here — never in `main.ts`. Dispatches on `format` to
 * the whole-array `Core.M3LJSONListExporter` / `Core.M3LCSVListExporter`,
 * calling `export(items)` exactly once with every row gathered across every
 * window — never the streaming `exportStream()`/`append()` API. The list
 * exporters only support a whole-array write; re-opening the output file
 * mid-run would truncate it, which is why `run-cloudwatch-logs-insights.ts`
 * accumulates rows (in memory and in the checkpoint) instead of writing
 * incrementally.
 */

import { Core } from "@m3l-automation/m3l-common";

import type { LogsInsightsRow } from "./checkpoint.js";

/**
 * Writes `rows` to the `output` file under `M3L_OUTPUT_DIR`, in the
 * `format`-selected encoding.
 *
 * @param deps - `rows` (the full accumulated set), `format` (selects the
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
 *     rows: [{ "@message": "hello" }],
 *     format: "json",
 *     output: "results.json",
 *     paths,
 *   });
 * }
 * ```
 */
export async function exportResults(deps: {
  readonly rows: readonly LogsInsightsRow[];
  readonly format: "json" | "csv";
  readonly output: string;
  readonly paths: Core.M3LPaths;
}): Promise<void> {
  const filePath = deps.paths.resolveOutput(deps.output);

  switch (deps.format) {
    case "json": {
      const exporter = new Core.M3LJSONListExporter<LogsInsightsRow>({
        filePath,
      });
      await exporter.export(deps.rows);
      return;
    }
    case "csv": {
      const exporter = new Core.M3LCSVListExporter<LogsInsightsRow>({
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
          code: "ERR_LOGS_INSIGHTS_EXPORT_FORMAT",
        },
      );
    }
  }
}
