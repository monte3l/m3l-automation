/**
 * `steps/checkpoint` — read/write/delete the `cloudwatch-logs-insights`
 * resume checkpoint file.
 *
 * Business logic lives here — never in `main.ts`. The checkpoint records
 * `{ completedWindows, rows, inFlightQueryId? }` — the rows already fetched,
 * not just a count — so a resumed run never re-issues a completed window's
 * query and `run-cloudwatch-logs-insights.ts` can write the output file
 * exactly once, from the full accumulated set (see the module doc on
 * `docs/reference/scripts/cloudwatch-logs-insights.md` for why the exporters
 * can't append).
 */

import * as fsp from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

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
 * Narrows a JSON-parsed value to {@link LogsInsightsCheckpoint}. The
 * checkpoint file is external data this process itself previously wrote, but
 * still validated leniently on read per this library's filesystem-error
 * convention (external data, not caller input).
 */
function isLogsInsightsCheckpoint(
  value: unknown,
): value is LogsInsightsCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["completedWindows"] !== "number") return false;
  if (!Array.isArray(candidate["rows"])) return false;
  const inFlightQueryId = candidate["inFlightQueryId"];
  return inFlightQueryId === undefined || typeof inFlightQueryId === "string";
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
 * @returns The parsed checkpoint, or `{ completedWindows: 0, rows: [] }` when
 *   the file does not exist (`ENOENT`).
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
 *   console.log(checkpoint.completedWindows);
 * }
 * ```
 */
export async function readCheckpoint(deps: {
  readonly paths: Core.M3LPaths;
  readonly output: string;
}): Promise<LogsInsightsCheckpoint> {
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
  // SyntaxError's message embeds a snippet of the surrounding invalid JSON —
  // here, potentially the checkpointed log rows themselves — so it must
  // never propagate as-is (e.g. to an unhandled-rejection stderr dump). The
  // raw error is deliberately NOT chained as `cause` for the same reason;
  // only the file path is safe to include in `context`.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Core.M3LError(`checkpoint file at '${path}' is not valid JSON`, {
      code: "ERR_LOGS_INSIGHTS_CHECKPOINT_PARSE",
      context: { path },
    });
  }
  if (!isLogsInsightsCheckpoint(parsed)) {
    throw new Core.M3LError(
      `checkpoint file at '${path}' has an unrecognized shape`,
      { code: "ERR_LOGS_INSIGHTS_CHECKPOINT_PARSE", context: { path } },
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
 *     checkpoint: { completedWindows: 1, rows: [] },
 *   });
 * }
 * ```
 */
export async function writeCheckpoint(deps: {
  readonly paths: Core.M3LPaths;
  readonly output: string;
  readonly checkpoint: LogsInsightsCheckpoint;
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
