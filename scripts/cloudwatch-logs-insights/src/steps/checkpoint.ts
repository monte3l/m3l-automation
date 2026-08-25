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
  /**
   * The rows fetched so far, across every completed window. For a `json`-format
   * run this is always `[]` — the JSON path streams each row straight to the
   * output file as it arrives instead of buffering it here (see
   * `outputBytes`); only the `csv` path (which needs a full in-memory row set
   * for its single batch `export()` call) ever populates this array.
   */
  readonly rows: readonly LogsInsightsRow[];
  /** The AWS query id for a window whose `StartQuery` has fired but whose `awaitResults` has not yet completed, if any. */
  readonly inFlightQueryId?: string;
  /**
   * The `json`-format streaming writer's `bytesWritten` at the time of this
   * checkpoint — the byte offset a resumed run's
   * `Core.M3LJSONListExporter` reopens from. Always `undefined` for `csv`
   * (whose fixed-column, whole-array export has no equivalent resume point).
   */
  readonly outputBytes?: number;
  /**
   * A running count of rows appended by a `json`-format run, tracked
   * alongside `outputBytes` (never as an accumulated row array — see `rows`).
   * Present only where a producer chooses to persist it; a resumed run without
   * it falls back to treating the prior row count as `0` for its own summary
   * computation. Always `undefined` for `csv`.
   */
  readonly rowsExported?: number;
}

/** The checkpoint state a fresh (non-resumed) run starts from. */
export const EMPTY_CHECKPOINT: LogsInsightsCheckpoint = {
  completedWindows: 0,
  rows: [],
};

/**
 * Narrows a value to {@link LogsInsightsRow}: a non-null, non-array plain
 * object whose every own value is a `string`.
 */
function isLogsInsightsRow(value: unknown): value is LogsInsightsRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Narrows a value to a non-negative safe integer, or accepts `undefined` (the
 * field is absent). Shared by the `outputBytes`/`rowsExported` checks in
 * {@link isLogsInsightsCheckpoint} — both are optional, `json`-only counters
 * with the identical "non-negative safe integer when present" constraint.
 * Uses `Number.isSafeInteger` (not the looser `Number.isInteger`) to match
 * the library's own `resumeFromByte` guard
 * (`M3LJSONListExporter`'s internal `isValidResumeFromByte`) — an
 * out-of-safe-integer-range value is rejected here, loudly and with
 * `ERR_CHECKPOINT_PARSE` attribution, rather than later and less precisely
 * from the exporter's own constructor.
 */
function isOptionalNonNegativeInteger(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Narrows `candidate["rows"]` to an array of {@link LogsInsightsRow}. */
function hasValidRows(candidate: Record<string, unknown>): boolean {
  return (
    Array.isArray(candidate["rows"]) &&
    candidate["rows"].every(isLogsInsightsRow)
  );
}

/** Narrows `candidate["inFlightQueryId"]` to a `string`, or accepts it absent. */
function hasValidInFlightQueryId(candidate: Record<string, unknown>): boolean {
  const inFlightQueryId = candidate["inFlightQueryId"];
  return inFlightQueryId === undefined || typeof inFlightQueryId === "string";
}

/**
 * Narrows a JSON-parsed value to {@link LogsInsightsCheckpoint}. Passed to
 * `Core.M3LCheckpointStore` as its required `validate` predicate (via
 * {@link buildCheckpointStore}). Requires `completedWindows` to be a
 * non-negative integer and `rows` to be an array of {@link LogsInsightsRow}
 * (plain objects with only `string` own values) — guarding against a
 * hand-edited or partially-written checkpoint file on disk. `outputBytes` and
 * `rowsExported` are each independently optional (a `csv`-format checkpoint
 * never sets either); when present, each must be its own non-negative safe
 * integer — they are not required to co-occur, since a checkpoint may record
 * `outputBytes` without ever having persisted `rowsExported`. This predicate
 * alone does NOT reject a checkpoint carrying both populated `rows` and an
 * absent `outputBytes` (a legacy or format-mismatched shape) — that check is
 * `format`-dependent and lives in `run-cloudwatch-logs-insights.ts`'s
 * `openJSONWriterIfNeeded`, which has the settings this module does not.
 */
export function isLogsInsightsCheckpoint(
  value: unknown,
): value is LogsInsightsCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const completedWindows = candidate["completedWindows"];
  if (
    typeof completedWindows !== "number" ||
    !Number.isInteger(completedWindows) ||
    completedWindows < 0
  ) {
    return false;
  }
  if (!hasValidRows(candidate)) return false;
  if (!hasValidInFlightQueryId(candidate)) return false;
  if (!isOptionalNonNegativeInteger(candidate["outputBytes"])) return false;
  return isOptionalNonNegativeInteger(candidate["rowsExported"]);
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
 * @param definition - Forwarded verbatim to
 *   `Core.M3LCheckpointStore`'s `definition` option, opting the store into
 *   fingerprinting. Deliberately left as a parameter rather than centralized,
 *   same as `missing`: it is inert for the delete-on-success hook's store
 *   (which only ever calls `.delete()`, never `.read()`/`.write()`, so a
 *   fingerprint mismatch could never surface there), so that call site omits
 *   it; only the orchestrator's read/write store has a caller with a
 *   meaningful definition to project.
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
  definition?: unknown,
): Core.M3LCheckpointStore<LogsInsightsCheckpoint> {
  return new Core.M3LCheckpointStore<LogsInsightsCheckpoint>({
    paths,
    name: output,
    validate: isLogsInsightsCheckpoint,
    missing,
    definition,
  });
}
