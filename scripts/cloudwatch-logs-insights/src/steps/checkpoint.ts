import { Core } from "@m3l-automation/m3l-common";

/**
 * `steps/checkpoint` — the `cloudwatch-logs-insights` checkpoint payload
 * contract.
 *
 * This module exists because the checkpoint payload
 * (`LogsInsightsCheckpoint`), its type guard (`isLogsInsightsCheckpoint`),
 * and its empty-run default (`EMPTY_CHECKPOINT`) have two independent
 * consumers in different lifecycle phases: the orchestrator
 * (`run-cloudwatch-logs-insights.ts`, which reads/writes the checkpoint
 * mid-run) and the delete-on-success hook (`hooks.ts`, which only deletes it
 * once `onAfterRun` fires). Neither module owns the payload contract more
 * than the other, so it lives here — a neutral module both import from —
 * rather than one importing it from the other's transitive graph.
 */

/** A single normalized Logs Insights result row (`AWS.LogsInsightsRow`, restated to avoid a type-only cross-namespace import here). */
export type LogsInsightsRow = Record<string, string>;

/**
 * The persisted resume state for a `cloudwatch-logs-insights` run: how many windows
 * have fully completed, the rows fetched so far (across every completed
 * window plus any prior resumed run), and — while a query is mid-flight —
 * the AWS `queryId` to re-attach to instead of re-issuing `StartQuery`.
 */
export interface LogsInsightsCheckpoint {
  /** The number of windows whose rows are already reflected in `rows`. */
  readonly completedWindows: number;
  /** The rows fetched so far, across every completed window. */
  readonly rows: readonly LogsInsightsRow[];
  /** The AWS query id for a window whose `StartQuery` has fired but whose `awaitResults` has not yet completed, if any. */
  readonly inFlightQueryId?: string;
}

/** The checkpoint state a fresh (non-resumed) run starts from. */
export const EMPTY_CHECKPOINT: LogsInsightsCheckpoint = {
  completedWindows: 0,
  rows: [],
};

/**
 * Narrows a JSON-parsed value to {@link LogsInsightsCheckpoint}. Passed to
 * `Core.M3LCheckpointStore` as its required `validate` predicate (via
 * {@link buildCheckpointStore}).
 */
export function isLogsInsightsCheckpoint(
  value: unknown,
): value is LogsInsightsCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["completedWindows"] !== "number") return false;
  if (!Array.isArray(candidate["rows"])) return false;
  const inFlightQueryId = candidate["inFlightQueryId"];
  return inFlightQueryId === undefined || typeof inFlightQueryId === "string";
}

/**
 * Builds a `Core.M3LCheckpointStore<LogsInsightsCheckpoint>` for
 * `cloudwatch-logs-insights`, centralizing the three arguments
 * (`paths`, `name`, `validate`) that must stay identical across both of this
 * script's construction sites — the orchestrator's read/write store and the
 * delete-on-success hook's store. A divergence between those two
 * constructions (e.g. a different `name` derivation) would make
 * delete-on-success target, or a resumed read validate against, a different
 * file/shape than the run that wrote it. `missing` is deliberately left as a
 * parameter rather than centralized: the two call sites need genuinely
 * different policies (the orchestrator's is driven by its `resume` flag; the
 * hook's is inert since it only ever calls `.delete()`), so folding it in
 * here would just relocate the divergence risk instead of removing it.
 *
 * @param paths - The script's `Core.M3LPaths` instance, used to resolve the
 *   checkpoint file's directory.
 * @param output - The resolved `output` config value; the checkpoint file's
 *   stable identity key (`<output-dir>/<output>.checkpoint.json`).
 * @param missing - What `read()` does when no checkpoint file exists; see
 *   `docs/reference/core/checkpoint.md`.
 * @returns A configured `Core.M3LCheckpointStore<LogsInsightsCheckpoint>`.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import {
 *   buildCheckpointStore,
 *   EMPTY_CHECKPOINT,
 * } from "./steps/checkpoint.js";
 *
 * function makeStore(paths: Core.M3LPaths, output: string) {
 *   return buildCheckpointStore(paths, output, {
 *     kind: "empty",
 *     value: EMPTY_CHECKPOINT,
 *   });
 * }
 * ```
 */
export function buildCheckpointStore(
  paths: Core.M3LPaths,
  output: string,
  missing: Core.M3LCheckpointMissingPolicy<LogsInsightsCheckpoint>,
): Core.M3LCheckpointStore<LogsInsightsCheckpoint> {
  return new Core.M3LCheckpointStore<LogsInsightsCheckpoint>({
    paths,
    name: output,
    validate: isLogsInsightsCheckpoint,
    missing,
  });
}
