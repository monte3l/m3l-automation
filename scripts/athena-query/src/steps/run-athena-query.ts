/**
 * `steps/run-athena-query` — the `athena-query` orchestrator.
 *
 * Business logic lives here — never in `main.ts`. Builds a
 * `StartAthenaQueryInput` from the resolved config, checkpoints-or-reattaches
 * (`Core.M3LCheckpointStore` + `AWS.M3LAthenaClient.startQuery()`, recording
 * `queryExecutionId`, or reattaching to a checkpointed one), calls
 * `awaitResults()`, exports the full row set once, then deletes the
 * checkpoint on success. Deliberately calls `startQuery` + `awaitResults`
 * rather than the convenience `runQuery()`, so `queryExecutionId` can be
 * checkpointed the moment the query starts, before waiting on it. A terminal
 * query failure aborts the run with the checkpoint left intact — the output
 * file is only ever written once `awaitResults` succeeds.
 *
 * The checkpoint's payload shape (`AthenaCheckpoint`), its type guard
 * (`isAthenaCheckpoint`), and its empty-run default (`EMPTY_CHECKPOINT`) live
 * in this module rather than a separate `steps/checkpoint.js`: this script
 * has a single, non-windowed checkpoint concern, so a dedicated module would
 * be a near-empty wrapper around `Core.M3LCheckpointStore`.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

import { exportResults } from "./export-results.js";
import { resolveAthenaSettings } from "./resolve-settings.js";

/**
 * The persisted resume state for an `athena-query` run: the AWS
 * `QueryExecutionId` for a query whose `StartQueryExecution` has fired but
 * whose `awaitResults` has not yet completed, if any.
 */
export interface AthenaCheckpoint {
  /** The in-flight (or terminally-failed) Athena query execution id, if any. */
  readonly queryExecutionId?: string;
}

/** The checkpoint state a fresh (non-resumed) run starts from. */
const EMPTY_CHECKPOINT: AthenaCheckpoint = {};

/**
 * Narrows a JSON-parsed value to {@link AthenaCheckpoint}. Passed to
 * `Core.M3LCheckpointStore` as its required `validate` predicate.
 */
export function isAthenaCheckpoint(value: unknown): value is AthenaCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const queryExecutionId = candidate["queryExecutionId"];
  return queryExecutionId === undefined || typeof queryExecutionId === "string";
}

/** The run summary `runAthenaQuery` reports back to its caller. */
export interface AthenaRunSummary {
  /** The number of rows written to the output file. */
  readonly rowsExported: number;
  /** The Athena query execution id the run's results came from. */
  readonly queryExecutionId: string;
}

/**
 * Projects `startInput` down to the fields that give a checkpointed
 * `queryExecutionId` its meaning — `queryString`, `database`, `catalog`,
 * `workGroup`, `executionParameters`, `outputLocation` — plus `awsProfile`,
 * for `Core.M3LCheckpointStore`'s `definition` option. Mirrors
 * `buildStartInput`'s (`resolve-settings.js`) omit-rather-than-`undefined`
 * convention: a field absent from `startInput` stays absent as a key here.
 * Excludes `output` (already the checkpoint's `name`), `format`, and
 * `resume` — none of them change what a checkpointed `queryExecutionId`
 * means. `outputLocation` and `awsProfile` are included: `outputLocation`
 * becomes `ResultConfiguration.OutputLocation` on `StartQueryExecution`, and
 * `awsProfile` selects the AWS account/region the execution id was minted
 * under — a `--resume` after switching profiles must fail loud with
 * `ERR_CHECKPOINT_FINGERPRINT_MISMATCH` rather than silently reattaching to
 * an execution id from a different account (issue #497 review round 2).
 */
function buildCheckpointDefinition(
  startInput: AWS.StartAthenaQueryInput,
  awsProfile: string,
): unknown {
  return {
    queryString: startInput.queryString,
    ...(startInput.database !== undefined && {
      database: startInput.database,
    }),
    ...(startInput.catalog !== undefined && { catalog: startInput.catalog }),
    ...(startInput.workGroup !== undefined && {
      workGroup: startInput.workGroup,
    }),
    ...(startInput.executionParameters !== undefined && {
      executionParameters: startInput.executionParameters,
    }),
    ...(startInput.outputLocation !== undefined && {
      outputLocation: startInput.outputLocation,
    }),
    awsProfile,
  };
}

/**
 * Runs the `athena-query` orchestration: starts (or reattaches to) the
 * query, checkpointing `queryExecutionId` before the poll, awaits its
 * results, exports the full row set once, then deletes the checkpoint.
 *
 * @param deps - The resolved `config`, a `logger`, the injected
 *   `AWS.M3LAthenaClient`, `M3LPaths` for checkpoint/output resolution, and
 *   an optional cooperative-cancellation `signal`.
 * @returns The run summary (rows exported, query execution id).
 * @throws {@link Core.M3LError} coded `"ERR_ATHENA_SETTINGS"` (see
 *   `./resolve-settings.js`) When a declared config value resolves to an
 *   unexpected type.
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
  /**
   * Cooperative cancellation signal (ADR-0049), threaded through to
   * `client.awaitResults` so a shutdown signal aborts the poll rather than
   * running it to exhaustion.
   */
  readonly signal?: AbortSignal;
}): Promise<AthenaRunSummary> {
  const settings = resolveAthenaSettings(deps.config);
  const { output, format, resume, startInput, awsProfile } = settings;

  const checkpointStore = new Core.M3LCheckpointStore<AthenaCheckpoint>({
    paths: deps.paths,
    name: output,
    definition: buildCheckpointDefinition(startInput, awsProfile),
    validate: isAthenaCheckpoint,
    // `--resume` with no checkpoint file is a typed config error, not a
    // silent fresh start (docs/reference/core/checkpoint.md's §1.2
    // conformance contract). The `{kind:"empty"}` arm is supplied only to
    // satisfy the store's required `missing` field — this script never
    // calls `read()` on a non-resume run (see the `resume ?` branch below),
    // so that arm is not exercised in practice today.
    missing: resume
      ? { kind: "error" }
      : { kind: "empty", value: EMPTY_CHECKPOINT },
  });

  const checkpoint = resume ? await checkpointStore.read() : EMPTY_CHECKPOINT;

  let queryExecutionId = checkpoint.queryExecutionId;
  if (queryExecutionId === undefined) {
    deps.logger.step("athena-query: starting a new query execution");
    queryExecutionId = await deps.client.startQuery(settings.startInput);
    await checkpointStore.write({ queryExecutionId });
  } else {
    deps.logger.step(
      `athena-query: reattaching to in-flight query '${queryExecutionId}'`,
    );
  }

  const result =
    deps.signal === undefined
      ? await deps.client.awaitResults(queryExecutionId)
      : await deps.client.awaitResults(queryExecutionId, {
          signal: deps.signal,
        });

  await exportResults({
    rows: result.rows,
    format,
    output,
    paths: deps.paths,
  });

  await checkpointStore.delete();

  const summary: AthenaRunSummary = {
    rowsExported: result.rows.length,
    queryExecutionId,
  };
  deps.logger.success(
    `athena-query complete: ${String(summary.rowsExported)} rows exported to '${output}' (query '${summary.queryExecutionId}')`,
  );
  return summary;
}
