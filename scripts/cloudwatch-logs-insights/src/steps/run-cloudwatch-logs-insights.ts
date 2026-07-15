import { Core, type AWS } from "@m3l-automation/m3l-common";

import {
  EMPTY_CHECKPOINT,
  readCheckpoint,
  writeCheckpoint,
} from "./checkpoint.js";
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
 * `inFlightQueryId`) + `awaitResults()` -\> accumulate rows -\> checkpoint
 * update -\> `export-results` once at the end. Deliberately calls
 * `startQuery` + `awaitResults` rather than the convenience `runQuery()`, so
 * `inFlightQueryId` can be checkpointed the moment a query starts, before
 * waiting on it. A terminal query failure aborts the whole run with the
 * checkpoint (and its accumulated rows) left intact — the output file is
 * only ever written on full completion.
 */

/** The run summary `runCloudwatchLogsInsights` reports back to its caller. */
export interface LogsInsightsRunSummary {
  /** The number of time windows fully completed (query started and awaited). */
  readonly windowsCompleted: number;
  /** The total number of rows in the exported output. */
  readonly rowsExported: number;
}

/**
 * Starts a fresh query for `window` and checkpoints its in-flight query id,
 * or reuses `reattachQueryId` when resuming a run whose query was already
 * started (and checkpointed) before the previous process exited. Logs and
 * re-throws on failure — symmetric with {@link awaitAndAccumulate} — so the
 * caller's abort message reports the failing window regardless of which half
 * of the window's lifecycle (`startQuery` vs `awaitResults`) failed.
 */
async function startOrReattachQuery(args: {
  readonly deps: {
    readonly logger: Core.M3LLogger;
    readonly client: AWS.M3LLogsInsightsClient;
    readonly paths: Core.M3LPaths;
  };
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

  await writeCheckpoint({
    paths: deps.paths,
    output: settings.output,
    checkpoint: {
      completedWindows: index,
      rows: accumulatedRows,
      inFlightQueryId: queryId,
    },
  });
  return queryId;
}

/**
 * Awaits `queryId`'s results, appends its rows to `accumulatedRows` (mutated
 * in place), and checkpoints the window as complete. Logs and re-throws on
 * failure so the caller's abort message reports the failing window.
 */
async function awaitAndAccumulate(args: {
  readonly deps: {
    readonly logger: Core.M3LLogger;
    readonly client: AWS.M3LLogsInsightsClient;
    readonly paths: Core.M3LPaths;
  };
  readonly settings: LogsInsightsRunSettings;
  readonly index: number;
  readonly totalWindows: number;
  readonly queryId: string;
  readonly accumulatedRows: LogsInsightsRow[];
}): Promise<void> {
  const { deps, settings, index, totalWindows, queryId, accumulatedRows } =
    args;

  let result: AWS.LogsInsightsQueryResult;
  try {
    result = await deps.client.awaitResults(queryId);
  } catch (cause) {
    deps.logger.error(
      `cloudwatch-logs-insights aborted at window ${String(index)} of ${String(totalWindows)}`,
    );
    throw cause;
  }

  accumulatedRows.push(...result.rows);
  await writeCheckpoint({
    paths: deps.paths,
    output: settings.output,
    checkpoint: {
      completedWindows: index + 1,
      rows: accumulatedRows,
    },
  });
}

/**
 * Runs a single time window: starts (or reattaches to) its query, then
 * awaits and accumulates its results. See {@link startOrReattachQuery} and
 * {@link awaitAndAccumulate} for the two halves of the lifecycle.
 */
async function runWindow(args: {
  readonly deps: {
    readonly logger: Core.M3LLogger;
    readonly client: AWS.M3LLogsInsightsClient;
    readonly paths: Core.M3LPaths;
  };
  readonly settings: LogsInsightsRunSettings;
  readonly index: number;
  readonly totalWindows: number;
  readonly window: LogsInsightsTimeWindow;
  readonly reattachQueryId: string | undefined;
  readonly accumulatedRows: LogsInsightsRow[];
}): Promise<void> {
  const queryId = await startOrReattachQuery(args);
  await awaitAndAccumulate({ ...args, queryId });
}

/**
 * Runs the `cloudwatch-logs-insights` orchestration: resolves settings, plans time
 * windows, executes each remaining window's query (checkpointing before and
 * after every poll), and exports the full accumulated row set once at the
 * end.
 *
 * @param deps - The resolved `config`, a `logger`, the injected
 *   `AWS.M3LLogsInsightsClient`, and `M3LPaths` for checkpoint/output
 *   resolution.
 * @returns The run summary (windows completed, rows exported).
 * @throws {@link Core.M3LError} (via {@link resolveSettings}) when `start`/
 *   `end` fail to parse or `start >= end`.
 * @throws {@link AWS.M3LLogsInsightsQueryFailedError} When a query reaches a
 *   terminal non-`Complete` status; a plain `M3LError` coded
 *   `"ERR_POLL_EXHAUSTED"` when the poll attempt bound is reached. Either
 *   aborts the run — the checkpoint reflects only fully-completed windows,
 *   and `export-results` is never called.
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

  const initial: LogsInsightsCheckpoint = settings.resume
    ? await readCheckpoint({ paths: deps.paths, output: settings.output })
    : EMPTY_CHECKPOINT;

  const accumulatedRows: LogsInsightsRow[] = [...initial.rows];

  deps.logger.step(
    `cloudwatch-logs-insights: running ${String(windows.length - initial.completedWindows)} of ${String(windows.length)} windows`,
  );

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

    await runWindow({
      deps,
      settings,
      index,
      totalWindows: windows.length,
      window,
      reattachQueryId,
      accumulatedRows,
    });
  }

  await exportResults({
    rows: accumulatedRows,
    format: settings.format,
    output: settings.output,
    paths: deps.paths,
  });

  const summary: LogsInsightsRunSummary = {
    windowsCompleted: windows.length,
    rowsExported: accumulatedRows.length,
  };
  deps.logger.success(
    `cloudwatch-logs-insights complete: ${String(summary.windowsCompleted)} windows, ${String(summary.rowsExported)} rows exported to '${settings.output}'`,
  );
  return summary;
}
