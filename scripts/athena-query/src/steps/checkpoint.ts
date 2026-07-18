/**
 * `steps/checkpoint` — read/write/delete the `athena-query` resume
 * checkpoint file.
 *
 * Business logic lives here — never in `main.ts`. Simplified relative to
 * `cloudwatch-logs-insights`'s checkpoint: `athena-query` issues a single,
 * non-windowed query, so the checkpoint records only the in-flight
 * `queryExecutionId`, if any — no `completedWindows`/`rows` accounting.
 */

import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

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
 * Narrows a JSON-parsed value to {@link AthenaCheckpoint}. The checkpoint
 * file is external data this process itself previously wrote, but still
 * validated leniently on read per this library's filesystem-error
 * convention (external data, not caller input).
 */
function isAthenaCheckpoint(value: unknown): value is AthenaCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const queryExecutionId = candidate["queryExecutionId"];
  return queryExecutionId === undefined || typeof queryExecutionId === "string";
}

/** Resolves the checkpoint file's absolute path for `output` under `M3L_OUTPUT_DIR`. */
function checkpointPath(paths: Core.M3LPaths, output: string): string {
  return paths.resolveOutput(`${output}.checkpoint.json`);
}

/**
 * Reads the checkpoint file for `output`, or the empty checkpoint when none
 * exists yet.
 *
 * @param deps - `paths` (for path resolution) and `output` (the base output
 *   file name the checkpoint is derived from).
 * @returns The parsed checkpoint, or `{}` when the file does not exist
 *   (`ENOENT`).
 * @throws When the read fails for any reason other than `ENOENT` (e.g.
 *   `EACCES`/`EPERM`), or when the file's contents are not a valid
 *   checkpoint — re-thrown, never swallowed.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { readCheckpoint } from "./checkpoint.js";
 *
 * async function resume(paths: Core.M3LPaths): Promise<void> {
 *   const checkpoint = await readCheckpoint({ paths, output: "results.json" });
 *   console.log(checkpoint.queryExecutionId);
 * }
 * ```
 */
export async function readCheckpoint(deps: {
  readonly paths: Core.M3LPaths;
  readonly output: string;
}): Promise<AthenaCheckpoint> {
  const path = checkpointPath(deps.paths, deps.output);
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf-8");
  } catch (error) {
    if (Core.isEnoentError(error)) {
      return EMPTY_CHECKPOINT;
    }
    throw error;
  }

  // JSON.parse is wrapped rather than left to throw a raw SyntaxError: a
  // SyntaxError's message embeds a snippet of the surrounding invalid JSON,
  // so it must never propagate as-is (e.g. to an unhandled-rejection stderr
  // dump). The raw error is deliberately NOT chained as `cause` for the same
  // reason; only the file path is safe to include in `context`.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Core.M3LError(`checkpoint file at '${path}' is not valid JSON`, {
      code: "ERR_ATHENA_CHECKPOINT_PARSE",
      context: { path },
    });
  }
  if (!isAthenaCheckpoint(parsed)) {
    throw new Core.M3LError(
      `checkpoint file at '${path}' has an unrecognized shape`,
      { code: "ERR_ATHENA_CHECKPOINT_PARSE", context: { path } },
    );
  }
  return parsed;
}

/**
 * Overwrites the checkpoint file for `output` with `checkpoint`.
 *
 * @param deps - `paths`, `output`, and the `checkpoint` to persist.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { writeCheckpoint } from "./checkpoint.js";
 *
 * async function persist(paths: Core.M3LPaths): Promise<void> {
 *   await writeCheckpoint({
 *     paths,
 *     output: "results.json",
 *     checkpoint: { queryExecutionId: "query-123" },
 *   });
 * }
 * ```
 */
export async function writeCheckpoint(deps: {
  readonly paths: Core.M3LPaths;
  readonly output: string;
  readonly checkpoint: AthenaCheckpoint;
}): Promise<void> {
  const path = checkpointPath(deps.paths, deps.output);
  await fsp.writeFile(path, JSON.stringify(deps.checkpoint), "utf-8");
}

/**
 * Deletes the checkpoint file for `output`. Tolerant of the file already
 * being gone (`ENOENT` resolves rather than throwing); any other failure is
 * re-thrown.
 *
 * @param deps - `paths` and `output`.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { deleteCheckpoint } from "./checkpoint.js";
 *
 * async function cleanup(paths: Core.M3LPaths): Promise<void> {
 *   await deleteCheckpoint({ paths, output: "results.json" });
 * }
 * ```
 */
export async function deleteCheckpoint(deps: {
  readonly paths: Core.M3LPaths;
  readonly output: string;
}): Promise<void> {
  const path = checkpointPath(deps.paths, deps.output);
  try {
    await fsp.unlink(path);
  } catch (error) {
    if (Core.isEnoentError(error)) {
      return;
    }
    throw error;
  }
}
