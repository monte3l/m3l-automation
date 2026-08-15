import { Core, type AWS } from "@m3l-automation/m3l-common";

import { buildCheckpointStore, EMPTY_CHECKPOINT } from "./checkpoint.js";
import type { LogsInsightsCheckpoint, LogsInsightsRow } from "./checkpoint.js";
import { exportResults } from "./export-results.js";
import { resolveSettings } from "./resolve-settings.js";
import type { LogsInsightsRunSettings } from "./resolve-settings.js";
import { planTimeWindows } from "./time-range.js";
import type { LogsInsightsTimeWindow } from "./time-range.js";

/**
 * `steps/run-cloudwatch-logs-insights` — the `cloudwatch-logs-insights` orchestrator.
 *
 * Business logic lives here — never in `main.ts`. Composes
 * `resolve-settings` -\> `time-range` -\> per-window
 * `AWS.M3LLogsInsightsClient.startQuery()` + checkpoint (record
 * `inFlightQueryId`) + `awaitResults()` -\> per-row export -\> checkpoint
 * update -\> a format-dependent final step. Deliberately calls `startQuery` +
 * `awaitResults` rather than the convenience `runQuery()`, so
 * `inFlightQueryId` can be checkpointed the moment a query starts, before
 * waiting on it. A terminal query failure aborts the whole run with the
 * checkpoint left intact — the output file is only ever finalized on full
 * completion.
 *
 * `format: "json"` streams: a single `Core.M3LJSONListExporter` writer is
 * opened once (resuming from the checkpoint's `outputBytes`, if any) before
 * any window runs, each fetched row is `append()`-ed to it individually as
 * it arrives (no in-memory row accumulation, no row-buffering in the
 * checkpoint — `rows: []` on every write), and the writer is `close()`-d once
 * every window completes, instead of the batch `export-results` step.
 * `format: "csv"` is unchanged and out of scope for this streaming rework:
 * CSV needs its full column set known before the first byte, and Logs
 * Insights rows carry no upfront schema to derive one from without unbounded
 * buffering — so CSV still accumulates every row in memory and in the
 * checkpoint, then writes it in a single batch `export-results` call at the
 * end, exactly as before.
 *
 * The checkpoint's payload shape (`LogsInsightsCheckpoint`, `LogsInsightsRow`),
 * its type guard (`isLogsInsightsCheckpoint`), its empty-run default
 * (`EMPTY_CHECKPOINT`), and the shared `buildCheckpointStore` factory live in
 * `./checkpoint.js` — a neutral module shared with `hooks.ts`, which also
 * needs the payload contract for its own delete-on-success store.
 */

/** The run summary `runCloudwatchLogsInsights` reports back to its caller. */
export interface LogsInsightsRunSummary {
  /** The number of time windows fully completed (query started and awaited). */
  readonly windowsCompleted: number;
  /** The total number of rows in the exported output. */
  readonly rowsExported: number;
}

/**
 * The dependencies the window-processing helpers ({@link startOrReattachQuery},
 * {@link awaitAndAccumulate}, {@link runWindow}, {@link runRemainingWindows})
 * actually read. Deliberately narrower than `runCloudwatchLogsInsights`'s own
 * top-level `deps` parameter — none of these four helpers reads `paths`
 * (only the orchestrator does, to build the checkpoint store via
 * `buildCheckpointStore`), so it is not threaded through here.
 */
interface WindowDeps {
  readonly logger: Core.M3LLogger;
  readonly client: AWS.M3LLogsInsightsClient;
  readonly checkpointStore: Core.M3LCheckpointStore<LogsInsightsCheckpoint>;
  /**
   * The `json`-format streaming writer, opened once by
   * {@link runCloudwatchLogsInsights} before any window runs. `undefined` for
   * `csv`, whose rows still flow through the in-memory `accumulatedRows`
   * array and the batch `export-results` step.
   */
  readonly writer?: Core.M3LListExporterStreamWriter<LogsInsightsRow>;
}

/**
 * Starts a fresh query for `window` and checkpoints its in-flight query id,
 * or reuses `reattachQueryId` when resuming a run whose query was already
 * started (and checkpointed) before the previous process exited. Logs and
 * re-throws on failure — symmetric with {@link awaitAndAccumulate} — so the
 * caller's abort message reports the failing window regardless of which half
 * of the window's lifecycle (`startQuery` vs `awaitResults`) failed.
 *
 * The checkpoint's `rows`/`outputBytes` reflect the JSON-vs-CSV split:
 * `deps.writer` present (JSON) checkpoints `rows: []` (rows are streamed, not
 * buffered) plus `outputBytes` from the writer's current `bytesWritten` — the
 * bytes flushed by prior windows only, since this write happens before the
 * current window appends anything. `deps.writer` absent (CSV) checkpoints the
 * full `accumulatedRows` array, unchanged from before this fix.
 */
async function startOrReattachQuery(args: {
  readonly deps: WindowDeps;
  readonly settings: LogsInsightsRunSettings;
  readonly index: number;
  readonly totalWindows: number;
  readonly window: LogsInsightsTimeWindow;
  readonly reattachQueryId: string | undefined;
  readonly accumulatedRows: readonly LogsInsightsRow[];
}): Promise<string> {
  const {
    deps,
    settings,
    index,
    totalWindows,
    window,
    reattachQueryId,
    accumulatedRows,
  } = args;
  if (reattachQueryId !== undefined) {
    return reattachQueryId;
  }

  let queryId: string;
  try {
    queryId = await deps.client.startQuery({
      logGroupNames: settings.logGroups,
      queryString: settings.query,
      startTime: window.startTime,
      endTime: window.endTime,
      ...(settings.limit !== undefined && { limit: settings.limit }),
    });
  } catch (cause) {
    deps.logger.error(
      `cloudwatch-logs-insights aborted at window ${String(index)} of ${String(totalWindows)}`,
    );
    throw cause;
  }

  await deps.checkpointStore.write({
    completedWindows: index,
    rows: deps.writer !== undefined ? [] : accumulatedRows,
    inFlightQueryId: queryId,
    ...(deps.writer !== undefined && { outputBytes: deps.writer.bytesWritten }),
  });
  return queryId;
}

/**
 * Awaits `queryId`'s results and checkpoints the window as complete. Logs and
 * re-throws on failure so the caller's abort message reports the failing
 * window.
 *
 * JSON (`deps.writer` present): appends each row individually to the
 * streaming writer — never accumulated in memory — then checkpoints
 * `rows: []` plus the writer's post-append `outputBytes`. CSV (`deps.writer`
 * absent): pushes the fetched rows onto `accumulatedRows` (mutated in place)
 * and checkpoints the full array, unchanged from before this fix.
 *
 * @returns The number of rows fetched by this window, for the caller's
 *   running `rowsExported` total.
 */
async function awaitAndAccumulate(args: {
  readonly deps: WindowDeps;
  readonly settings: LogsInsightsRunSettings;
  readonly index: number;
  readonly totalWindows: number;
  readonly queryId: string;
  readonly accumulatedRows: LogsInsightsRow[];
}): Promise<number> {
  const { deps, index, totalWindows, queryId, accumulatedRows } = args;

  let result: AWS.LogsInsightsQueryResult;
  try {
    result = await deps.client.awaitResults(queryId);
  } catch (cause) {
    deps.logger.error(
      `cloudwatch-logs-insights aborted at window ${String(index)} of ${String(totalWindows)}`,
    );
    throw cause;
  }

  if (deps.writer !== undefined) {
    try {
      for (const row of result.rows) {
        await deps.writer.append(row);
      }
    } catch (cause) {
      deps.logger.error(
        `cloudwatch-logs-insights aborted at window ${String(index)} of ${String(totalWindows)} (output write failed)`,
      );
      throw cause;
    }
    await deps.checkpointStore.write({
      completedWindows: index + 1,
      rows: [],
      outputBytes: deps.writer.bytesWritten,
    });
  } else {
    accumulatedRows.push(...result.rows);
    await deps.checkpointStore.write({
      completedWindows: index + 1,
      rows: accumulatedRows,
    });
  }

  return result.rows.length;
}

/**
 * Runs a single time window: starts (or reattaches to) its query, then
 * awaits and accumulates its results. See {@link startOrReattachQuery} and
 * {@link awaitAndAccumulate} for the two halves of the lifecycle.
 *
 * @returns The number of rows fetched by this window.
 */
async function runWindow(args: {
  readonly deps: WindowDeps;
  readonly settings: LogsInsightsRunSettings;
  readonly index: number;
  readonly totalWindows: number;
  readonly window: LogsInsightsTimeWindow;
  readonly reattachQueryId: string | undefined;
  readonly accumulatedRows: LogsInsightsRow[];
}): Promise<number> {
  const queryId = await startOrReattachQuery(args);
  return awaitAndAccumulate({ ...args, queryId });
}

/** The result of running every remaining window — see {@link runRemainingWindows}. */
interface RemainingWindowsResult {
  /**
   * The full accumulated row set (`initial.rows` plus every row fetched this
   * run). For JSON (`deps.writer` present) this stays `[]` throughout — rows
   * are streamed, not buffered — so only the CSV path relies on this value.
   */
  readonly rows: LogsInsightsRow[];
  /**
   * The count of rows fetched by windows run THIS invocation (excludes any
   * `initial.rowsExported` carried over from a prior, already-checkpointed
   * attempt) — used to compute a JSON run's final `rowsExported` summary.
   */
  readonly rowsAppended: number;
}

/**
 * Runs every window from `initial.completedWindows` through the end of
 * `windows`, accumulating rows (CSV) or streaming them (JSON, via
 * `deps.writer`) in place. Extracted from {@link runCloudwatchLogsInsights}
 * to keep that function within the module's line-count budget.
 */
async function runRemainingWindows(args: {
  readonly deps: WindowDeps;
  readonly settings: LogsInsightsRunSettings;
  readonly windows: readonly LogsInsightsTimeWindow[];
  readonly initial: LogsInsightsCheckpoint;
}): Promise<RemainingWindowsResult> {
  const { deps, settings, windows, initial } = args;
  const accumulatedRows: LogsInsightsRow[] = [...initial.rows];
  let rowsAppended = 0;

  for (
    let index = initial.completedWindows;
    index < windows.length;
    index += 1
  ) {
    const window = windows[index];
    if (window === undefined) {
      throw new Core.M3LError(
        `planned time window ${String(index)} is out of range`,
        { code: "ERR_LOGS_INSIGHTS_WINDOW_RANGE" },
      );
    }

    const reattachQueryId =
      index === initial.completedWindows ? initial.inFlightQueryId : undefined;

    rowsAppended += await runWindow({
      deps,
      settings,
      index,
      totalWindows: windows.length,
      window,
      reattachQueryId,
      accumulatedRows,
    });
  }

  return { rows: accumulatedRows, rowsAppended };
}

/**
 * The `Core.M3LError` code {@link openJSONWriterIfNeeded} throws with when a
 * `json`-format checkpoint still carries buffered `rows` — see that
 * function's TSDoc for the full scenario this guards against.
 */
const LEGACY_CHECKPOINT_CODE = "ERR_LOGS_INSIGHTS_LEGACY_CHECKPOINT";

/**
 * Opens the JSON streaming writer for a `json`-format run, resuming from the
 * checkpoint's `outputBytes` (`0` for a fresh run). Returns `undefined` for
 * `csv`, whose rows keep flowing through `export-results`'s batch `export()`
 * — see this module's doc comment for why CSV is excluded from streaming.
 *
 * Rejects — before opening the writer or doing any file I/O — a `json`-format
 * checkpoint whose `initial.rows` is non-empty. `isLogsInsightsCheckpoint`
 * accepts that shape (it validates `rows`/`outputBytes` independently), but
 * this streaming path never forwards `initial.rows` to the writer (only the
 * `csv` branch reads it) — those rows' windows are already counted in
 * `completedWindows`, so `runRemainingWindows` would skip re-fetching them,
 * and they would otherwise be silently and permanently lost. The only way
 * `initial.rows` can be non-empty here is a checkpoint written before this
 * streaming rework (when `json` also buffered rows the old way) or a
 * `csv`-format run's checkpoint reused under `format: json` by mistake —
 * either way there is no safe automatic recovery: the rows were never
 * captured as writer bytes, only as an in-memory array the checkpoint file
 * itself is now the only record of.
 *
 * @throws {@link Core.M3LError} coded `"ERR_LOGS_INSIGHTS_LEGACY_CHECKPOINT"`
 *   when `settings.format === "json"` and `initial.rows.length > 0`.
 */
function openJSONWriterIfNeeded(args: {
  readonly settings: LogsInsightsRunSettings;
  readonly paths: Core.M3LPaths;
  readonly initial: LogsInsightsCheckpoint;
}): Core.M3LListExporterStreamWriter<LogsInsightsRow> | undefined {
  const { settings, paths, initial } = args;
  if (settings.format !== "json") return undefined;
  if (initial.rows.length > 0) {
    throw new Core.M3LError(
      "cloudwatch-logs-insights: a json-format checkpoint from before this version (or written by a csv-format run) still carries buffered rows this version cannot safely resume from — delete the checkpoint and restart, or resume once more with the version that wrote it",
      { code: LEGACY_CHECKPOINT_CODE },
    );
  }
  const exporter = new Core.M3LJSONListExporter<LogsInsightsRow>({
    filePath: paths.resolveOutput(settings.output),
    resumeFromByte: initial.outputBytes ?? 0,
  });
  return exporter.exportStream();
}

/**
 * The `Core.M3LError` code {@link closeJSONWriterAfterRun} throws with when
 * `writer.close()` fails after the run otherwise succeeded — see that
 * function's TSDoc for why this case cannot be a best-effort log.
 */
const OUTPUT_WRITER_CODE = "ERR_LOGS_INSIGHTS_OUTPUT_WRITER";

/**
 * Closes the `json`-format streaming `writer` once the window loop has
 * settled (successfully or not), attributing a `close()` failure correctly
 * depending on whether the window loop already threw:
 *
 * - `primaryFailed: true` — a window's `startQuery`/`awaitResults`/
 *   `writer.append()` already threw, and that error is what's propagating.
 *   A `close()` failure here is secondary (the writer would otherwise leak
 *   its underlying `fs.WriteStream` unflushed/unclosed), so it's only
 *   logged — re-throwing it would replace the original abort error mid-flight
 *   instead of letting it continue propagating.
 * - `primaryFailed: false` — the window loop fully completed, so a
 *   `close()` failure here is the ONLY signal of a real problem (e.g. a
 *   resumed run whose checkpoint claims a `resumeFromByte` beyond the file's
 *   actual size). Swallowing it would let {@link runCloudwatchLogsInsights}
 *   report success over a truncated/invalid output, so it propagates as a
 *   typed `M3LError` instead — mirroring `rds-data-sql`'s `run-query.ts`
 *   `closeWriterAfterRun`, which established this same rationale.
 *
 * @throws {@link Core.M3LError} coded `"ERR_LOGS_INSIGHTS_OUTPUT_WRITER"`
 *   when `writer.close()` fails and `primaryFailed` is `false`.
 */
async function closeJSONWriterAfterRun(
  writer: Core.M3LListExporterStreamWriter<LogsInsightsRow>,
  primaryFailed: boolean,
  logger: Core.M3LLogger,
): Promise<void> {
  try {
    await writer.close();
  } catch (closeError) {
    if (primaryFailed) {
      logger.error(
        "cloudwatch-logs-insights: failed to close the output writer",
        {
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        },
      );
      return;
    }
    throw new Core.M3LError(
      "cloudwatch-logs-insights: failed to close the output writer after a successful run",
      { code: OUTPUT_WRITER_CODE, cause: closeError },
    );
  }
}

/**
 * Finalizes the run's output and returns the total row count for the
 * summary. JSON (`writer` present) assumes the writer has already been
 * closed by {@link closeJSONWriterAfterRun} (called by
 * {@link runCloudwatchLogsInsights}'s `finally` around the window loop) and
 * derives the total from `initial.rowsExported` (the prior,
 * already-checkpointed attempt's row count, `0` if absent) plus
 * `result.rowsAppended` (this run's newly streamed rows). CSV (`writer`
 * absent) calls the batch `export-results` step, unchanged from before this
 * fix, and the total is simply the full accumulated row count.
 */
async function finalizeExport(args: {
  readonly writer:
    Core.M3LListExporterStreamWriter<LogsInsightsRow> | undefined;
  readonly settings: LogsInsightsRunSettings;
  readonly paths: Core.M3LPaths;
  readonly result: RemainingWindowsResult;
  readonly initial: LogsInsightsCheckpoint;
}): Promise<number> {
  const { writer, settings, paths, result, initial } = args;
  if (writer !== undefined) {
    return (initial.rowsExported ?? 0) + result.rowsAppended;
  }
  await exportResults({
    rows: result.rows,
    format: settings.format,
    output: settings.output,
    paths,
  });
  return result.rows.length;
}

/**
 * Runs every remaining window (via {@link runRemainingWindows}), ensuring the
 * `json`-format streaming `writer` (when present) is closed exactly once
 * regardless of outcome — see {@link closeJSONWriterAfterRun} for the
 * close-failure attribution rules. `csv` never opens a writer, so there is
 * nothing to close mid-run; its one batch `export()` call happens later, in
 * `finalizeExport`. Extracted from {@link runCloudwatchLogsInsights} to keep
 * that function within the module's line-count budget.
 */
async function runWindowsWithWriterCleanup(args: {
  readonly deps: WindowDeps;
  readonly settings: LogsInsightsRunSettings;
  readonly windows: readonly LogsInsightsTimeWindow[];
  readonly initial: LogsInsightsCheckpoint;
  readonly writer:
    Core.M3LListExporterStreamWriter<LogsInsightsRow> | undefined;
  readonly logger: Core.M3LLogger;
}): Promise<RemainingWindowsResult> {
  const { deps, settings, windows, initial, writer, logger } = args;
  // Tracks whether the window loop below already threw, so the writer-close
  // finally (next) knows whether a close() failure is secondary (log-only)
  // or is itself the only signal of a real failure (must propagate). See
  // `closeJSONWriterAfterRun`'s own TSDoc for why the distinction matters.
  let primaryFailed = false;
  try {
    return await runRemainingWindows({ deps, settings, windows, initial });
  } catch (cause) {
    primaryFailed = true;
    throw cause;
  } finally {
    if (writer !== undefined) {
      await closeJSONWriterAfterRun(writer, primaryFailed, logger);
    }
  }
}

/**
 * Runs the `cloudwatch-logs-insights` orchestration: resolves settings, plans time
 * windows, executes each remaining window's query (checkpointing before and
 * after every poll), and finalizes the output — a streamed JSON writer close
 * or a batch CSV export, see this module's doc comment.
 *
 * @param deps - The resolved `config`, a `logger`, the injected
 *   `AWS.M3LLogsInsightsClient`, and `M3LPaths` for checkpoint/output
 *   resolution.
 * @returns The run summary (windows completed, rows exported).
 * @throws {@link Core.M3LError} (via {@link resolveSettings}) when `start`/
 *   `end` fail to parse (the `start < end` ordering constraint is enforced
 *   earlier, at config-load time, by `config.ts`'s `configValidators`).
 * @throws {@link AWS.M3LLogsInsightsQueryFailedError} When a query reaches a
 *   terminal non-`Complete` status; a plain `M3LError` coded
 *   `"ERR_POLL_EXHAUSTED"` when the poll attempt bound is reached. Either
 *   aborts the run — the checkpoint reflects only fully-completed windows,
 *   and neither the JSON writer nor `export-results` is ever finalized/called.
 *
 * @example
 * ```ts
 * import type { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runCloudwatchLogsInsights } from "./run-cloudwatch-logs-insights.js";
 *
 * async function run(
 *   config: Core.M3LConfig,
 *   logger: Core.M3LLogger,
 *   client: AWS.M3LLogsInsightsClient,
 *   paths: Core.M3LPaths,
 * ): Promise<void> {
 *   const summary = await runCloudwatchLogsInsights({
 *     config,
 *     logger,
 *     client,
 *     paths,
 *   });
 *   logger.success(`exported ${String(summary.rowsExported)} rows`);
 * }
 * ```
 */
export async function runCloudwatchLogsInsights(deps: {
  readonly config: Core.M3LConfig;
  readonly logger: Core.M3LLogger;
  readonly client: AWS.M3LLogsInsightsClient;
  readonly paths: Core.M3LPaths;
}): Promise<LogsInsightsRunSummary> {
  const settings = resolveSettings(deps.config);
  const windows = planTimeWindows(
    settings.startEpochSeconds,
    settings.endEpochSeconds,
    settings.windowMinutes,
  );

  // `--resume` with no checkpoint file is a typed config error, not a
  // silent fresh start (docs/reference/core/checkpoint.md's §1.2
  // conformance contract). The `{kind:"empty"}` arm is supplied only to
  // satisfy the store's required `missing` field — this script never calls
  // `read()` on a non-resume run (see the `settings.resume ?` branch below),
  // so that arm is not exercised in practice today.
  const checkpointStore = buildCheckpointStore(
    deps.paths,
    settings.output,
    settings.resume
      ? { kind: "error" }
      : { kind: "empty", value: EMPTY_CHECKPOINT },
  );

  const initial: LogsInsightsCheckpoint = settings.resume
    ? await checkpointStore.read()
    : EMPTY_CHECKPOINT;

  deps.logger.step(
    `cloudwatch-logs-insights: running ${String(windows.length - initial.completedWindows)} of ${String(windows.length)} windows`,
  );

  const writer = openJSONWriterIfNeeded({
    settings,
    paths: deps.paths,
    initial,
  });

  const windowDeps: WindowDeps = {
    logger: deps.logger,
    client: deps.client,
    checkpointStore,
    ...(writer !== undefined && { writer }),
  };
  const result = await runWindowsWithWriterCleanup({
    deps: windowDeps,
    settings,
    windows,
    initial,
    writer,
    logger: deps.logger,
  });

  const rowsExported = await finalizeExport({
    writer,
    settings,
    paths: deps.paths,
    result,
    initial,
  });

  const summary: LogsInsightsRunSummary = {
    windowsCompleted: windows.length,
    rowsExported,
  };
  deps.logger.success(
    `cloudwatch-logs-insights complete: ${String(summary.windowsCompleted)} windows, ${String(summary.rowsExported)} rows exported to '${settings.output}'`,
  );
  return summary;
}
