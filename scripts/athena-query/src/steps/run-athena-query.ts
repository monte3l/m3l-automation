/**
 * `steps/run-athena-query` — the `athena-query` orchestrator.
 *
 * Business logic lives here — never in `main.ts`. Builds a
 * `StartAthenaQueryInput` from the resolved config, checkpoints-or-reattaches
 * (`checkpoint` + `AWS.M3LAthenaClient.startQuery()`, recording
 * `queryExecutionId`, or reattaching to a checkpointed one), calls
 * `awaitResults()`, exports the full row set once, then deletes the
 * checkpoint on success. Deliberately calls `startQuery` + `awaitResults`
 * rather than the convenience `runQuery()`, so `queryExecutionId` can be
 * checkpointed the moment the query starts, before waiting on it. A terminal
 * query failure aborts the run with the checkpoint left intact — the output
 * file is only ever written once `awaitResults` succeeds.
 */

import { type Core, type AWS } from "@m3l-automation/m3l-common";

import {
  deleteCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from "./checkpoint.js";
import { exportResults } from "./export-results.js";
import { resolveAthenaSettings } from "./resolve-settings.js";

/** The run summary `runAthenaQuery` reports back to its caller. */
export interface AthenaRunSummary {
  /** The number of rows written to the output file. */
  readonly rowsExported: number;
  /** The Athena query execution id the run's results came from. */
  readonly queryExecutionId: string;
}

/**
 * Runs the `athena-query` orchestration: starts (or reattaches to) the
 * query, checkpointing `queryExecutionId` before the poll, awaits its
 * results, exports the full row set once, then deletes the checkpoint.
 *
 * @param deps - The resolved `config`, a `logger`, the injected
 *   `AWS.M3LAthenaClient`, and `M3LPaths` for checkpoint/output resolution.
 * @returns The run summary (rows exported, query execution id).
 * @throws `AthenaSettingsError` (see `./resolve-settings.js`) When a declared
 *   config value resolves to an unexpected type.
 * @throws {@link AWS.M3LAthenaStartQueryError} When `startQuery` fails —
 *   before any checkpoint write, so the checkpoint stays untouched.
 * @throws {@link AWS.M3LAthenaQueryFailedError} When the query reaches a
 *   terminal non-`SUCCEEDED` status, or a plain `M3LError` coded
 *   `"ERR_POLL_EXHAUSTED"` when the poll attempt bound is reached. Either
 *   aborts the run — the checkpoint is left intact (still carrying
 *   `queryExecutionId`) and `export-results` is never called.
 *
 * @example
 * ```ts
 * import type { AWS, Core } from "@m3l-automation/m3l-common";
 * import { runAthenaQuery } from "./run-athena-query.js";
 *
 * async function run(
 *   config: Core.M3LConfig,
 *   logger: Core.M3LLogger,
 *   client: AWS.M3LAthenaClient,
 *   paths: Core.M3LPaths,
 * ): Promise<void> {
 *   const summary = await runAthenaQuery({ config, logger, client, paths });
 *   logger.success(`exported ${String(summary.rowsExported)} rows`);
 * }
 * ```
 */
export async function runAthenaQuery(deps: {
  readonly config: Core.M3LConfig;
  readonly logger: Core.M3LLogger;
  readonly client: AWS.M3LAthenaClient;
  readonly paths: Core.M3LPaths;
}): Promise<AthenaRunSummary> {
  const settings = resolveAthenaSettings(deps.config);
  const { output, format, resume } = settings;

  const checkpoint = resume
    ? await readCheckpoint({ paths: deps.paths, output })
    : {};

  let queryExecutionId = checkpoint.queryExecutionId;
  if (queryExecutionId === undefined) {
    deps.logger.step("athena-query: starting a new query execution");
    queryExecutionId = await deps.client.startQuery(settings.startInput);
    await writeCheckpoint({
      paths: deps.paths,
      output,
      checkpoint: { queryExecutionId },
    });
  } else {
    deps.logger.step(
      `athena-query: reattaching to in-flight query '${queryExecutionId}'`,
    );
  }

  const result = await deps.client.awaitResults(queryExecutionId);

  await exportResults({
    rows: result.rows,
    format,
    output,
    paths: deps.paths,
  });

  await deleteCheckpoint({ paths: deps.paths, output });

  const summary: AthenaRunSummary = {
    rowsExported: result.rows.length,
    queryExecutionId,
  };
  deps.logger.success(
    `athena-query complete: ${String(summary.rowsExported)} rows exported to '${output}' (query '${summary.queryExecutionId}')`,
  );
  return summary;
}
