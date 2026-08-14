/**
 * `steps/run-query` — runs `query`'s caller-supplied `SELECT`, paged by
 * `page.size`, streaming coerced rows through an injected exporter writer.
 *
 * Business logic lives here — never in `main.ts`. `page.size > 0` wraps the
 * caller's statement in a `LIMIT`/`OFFSET` subquery, resuming from a
 * `Core.M3LCheckpointStore`-backed offset and stopping the first time a page
 * returns fewer than `page.size` rows.
 * `page.size = 0` issues the caller's statement unpaged, once. See
 * `docs/reference/scripts/rds-data-sql.md`'s `run-query` row and "Notes and
 * behavior" section for the full contract.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

/** The `Core.M3LError` code {@link runQuery} throws with for a reserved `parameters.file` name. */
const RESERVED_PARAMETER_CODE = "ERR_RDS_DATA_SQL_RESERVED_PARAMETER";

/**
 * Parameter names reserved by `run-query`'s paging wrapper — a
 * `parameters.file`-sourced parameter set must not declare either, since
 * they would collide with the `:limit`/`:offset` binds the wrapper itself
 * injects. Only checked when `page.size > 0` (the unpaged path never adds
 * these binds, so the collision cannot occur there).
 */
const RESERVED_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "limit",
  "offset",
]);

/**
 * The resume-state shape {@link runQuery} persists via its injected
 * `checkpoint` port, mirroring `Core.M3LCheckpointStore<RunQueryCheckpoint>`'s
 * payload — declared here (rather than imported from `core/checkpoint`)
 * since this step depends only on the narrow read/write/delete port its
 * caller injects, never the concrete store class.
 */
export interface RunQueryCheckpoint {
  /** The `OFFSET` to resume paging from, when a prior run was interrupted. */
  readonly offset?: number;
}

/** The narrow checkpoint port {@link runQuery} depends on. */
interface RunQueryCheckpointPort {
  /** Reads the current checkpoint, or an empty object on a fresh run. */
  read(): Promise<RunQueryCheckpoint>;
  /** Persists the checkpoint after a full page completes. */
  write(checkpoint: { readonly offset: number }): Promise<void>;
  /** Deletes the checkpoint once the run completes successfully. */
  delete(): Promise<void>;
}

/** The narrow streaming-writer port {@link runQuery} appends each row's coerced record to. */
interface RunQueryWriterPort {
  /** Appends one coerced output record to the underlying exporter stream. */
  append(record: Record<string, unknown>): Promise<void>;
  /** Closes the underlying exporter stream. */
  close(): Promise<void>;
}

/** Injected dependencies for {@link runQuery}. */
export interface RunQueryDeps {
  /** The provisioned RDS Data API operations wrapper, narrowed to `executeStatement`. */
  readonly rdsData: Pick<AWS.M3LRDSDataOperations, "executeStatement">;
  /** The Aurora cluster/instance ARN. */
  readonly resourceArn: string;
  /** The Secrets Manager ARN holding the database credentials. */
  readonly secretArn: string;
  /** The target database name, when set. */
  readonly database?: string;
  /** The target schema qualifier, when set. */
  readonly schema?: string;
  /** The caller's `SELECT` statement (its trailing `;`/whitespace is stripped before wrapping). */
  readonly sql: string;
  /** Named parameters bound to `sql`, sourced from `parameters.file`. */
  readonly parameters: readonly AWS.M3LRDSDataParameter[];
  /** Row page size; `0` issues `sql` unpaged, once. */
  readonly pageSize: number;
  /** The resume-state port; see {@link RunQueryCheckpointPort}. */
  readonly checkpoint: RunQueryCheckpointPort;
  /** The streaming output-writer port; see {@link RunQueryWriterPort}. */
  readonly writer: RunQueryWriterPort;
  /** Coerces one raw result row into the plain output record `writer.append` consumes. */
  readonly toRecord: (
    columns: readonly AWS.M3LRDSDataColumn[],
    row: readonly AWS.M3LRDSDataValue[],
  ) => Record<string, unknown>;
  /** The run's correlated logger. */
  readonly logger: Core.M3LLogger;
}

/** The summary {@link runQuery} resolves with. */
export interface RunQueryResult {
  /** The total number of rows streamed to `writer`. */
  readonly rowsRead: number;
}

/** Whether `char` (a single code unit) is whitespace or `;` — the set {@link stripTrailingStatementNoise} strips from the end of `sql`. */
function isTrailingNoiseChar(char: string): boolean {
  return char === ";" || /\s/u.test(char);
}

/**
 * Strips a trailing `;` and surrounding whitespace from `sql`, so the
 * paging wrapper never produces `SELECT * FROM (SELECT 1;) AS m3l_page …` —
 * a syntax error every Data-API-enabled Postgres cluster would reject.
 *
 * Implemented as a manual backward scan (not a trailing-anchored regex):
 * a regex alternation of `\s`/`;` repeated with a `$` anchor backtracks
 * quadratically on adversarial input (long alternating whitespace/`;` runs),
 * and `sql.file` is operator-supplied text this step must stay robust
 * against regardless of size.
 *
 * @param sql - The caller's raw statement.
 * @returns `sql` with any trailing whitespace/`;` run removed.
 */
function stripTrailingStatementNoise(sql: string): string {
  const trimmed = sql.trim();
  let end = trimmed.length;
  while (end > 0 && isTrailingNoiseChar(trimmed.charAt(end - 1))) {
    end -= 1;
  }
  return trimmed.slice(0, end);
}

/**
 * Throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_RESERVED_PARAMETER"`
 * when `parameters` declares a name `run-query`'s paging wrapper reserves.
 * A no-op when `pageSize` is `0` — the unpaged path never injects `:limit`/
 * `:offset`, so no collision is possible.
 */
function assertNoReservedParameterNames(
  parameters: readonly AWS.M3LRDSDataParameter[],
  pageSize: number,
): void {
  if (pageSize <= 0) return;
  const reserved = parameters.find((parameter) =>
    RESERVED_PARAMETER_NAMES.has(parameter.name),
  );
  if (reserved !== undefined) {
    throw new Core.M3LError(
      `parameters.file declares '${reserved.name}', reserved by query's page.size > 0 paging wrapper (LIMIT :limit OFFSET :offset)`,
      { code: RESERVED_PARAMETER_CODE },
    );
  }
}

/** Builds one `executeStatement` input, sharing the optional-field wiring across both the paged and unpaged paths. */
function buildStatementInput(
  deps: Pick<RunQueryDeps, "resourceArn" | "secretArn" | "database" | "schema">,
  sql: string,
  parameters: readonly AWS.M3LRDSDataParameter[],
): AWS.M3LRDSDataStatementInput {
  return {
    resourceArn: deps.resourceArn,
    secretArn: deps.secretArn,
    sql,
    ...(deps.database !== undefined && { database: deps.database }),
    ...(deps.schema !== undefined && { schema: deps.schema }),
    parameters,
  };
}

/** Streams one `executeStatement` result's rows through `toRecord` + `writer.append`, returning the row count. */
async function streamResultRows(
  deps: Pick<RunQueryDeps, "writer" | "toRecord">,
  result: AWS.M3LRDSDataStatementResult,
): Promise<number> {
  for (const row of result.rows) {
    await deps.writer.append(deps.toRecord(result.columns, row));
  }
  return result.rows.length;
}

/** Runs the `page.size > 0` paged path — split out of {@link runQuery} to keep its cyclomatic complexity low. */
async function runPagedQuery(
  deps: RunQueryDeps,
  startOffset: number,
): Promise<number> {
  const wrappedSql = `SELECT * FROM (${stripTrailingStatementNoise(deps.sql)}) AS m3l_page LIMIT :limit OFFSET :offset`;
  let offset = startOffset;
  let rowsRead = 0;

  for (;;) {
    const result = await deps.rdsData.executeStatement(
      buildStatementInput(deps, wrappedSql, [
        ...deps.parameters,
        { name: "limit", value: { kind: "long", value: deps.pageSize } },
        { name: "offset", value: { kind: "long", value: offset } },
      ]),
    );
    const pageRowCount = await streamResultRows(deps, result);
    rowsRead += pageRowCount;

    if (pageRowCount < deps.pageSize) break;
    offset += deps.pageSize;
    await deps.checkpoint.write({ offset });
  }

  return rowsRead;
}

/** Runs the `page.size = 0` unpaged path — a single `executeStatement` call. */
async function runUnpagedQuery(deps: RunQueryDeps): Promise<number> {
  const result = await deps.rdsData.executeStatement(
    buildStatementInput(deps, deps.sql, deps.parameters),
  );
  return streamResultRows(deps, result);
}

/**
 * Runs `query`, streaming every page's rows to `deps.writer` and resolving
 * once the whole statement (paged or unpaged) has been read.
 *
 * @param deps - See {@link RunQueryDeps}.
 * @returns The total row count streamed.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_RESERVED_PARAMETER"`
 *   when `page.size > 0` and `deps.parameters` declares `limit` or `offset`
 *   — checked before any statement runs.
 * @throws Whatever `deps.rdsData.executeStatement` throws, unchanged —
 *   including `AWS.M3LRDSDataResultTooLargeError`, which this step never
 *   catches or wraps.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { runQuery } from "./run-query.js";
 *
 * async function run(deps: Parameters<typeof runQuery>[0]): Promise<void> {
 *   const { rowsRead } = await runQuery(deps);
 *   console.log(`query streamed ${String(rowsRead)} rows`);
 * }
 * ```
 */
export async function runQuery(deps: RunQueryDeps): Promise<RunQueryResult> {
  assertNoReservedParameterNames(deps.parameters, deps.pageSize);

  const savedCheckpoint = await deps.checkpoint.read();
  let rowsRead: number;

  try {
    rowsRead =
      deps.pageSize > 0
        ? await runPagedQuery(deps, savedCheckpoint.offset ?? 0)
        : await runUnpagedQuery(deps);
  } finally {
    // Best-effort: a failing close() must never mask the real outcome above.
    try {
      await deps.writer.close();
    } catch (closeError) {
      deps.logger.error("run-query: failed to close the output writer", {
        error:
          closeError instanceof Error ? closeError.message : String(closeError),
      });
    }
  }

  await deps.checkpoint.delete();
  deps.logger.step(
    `run-query complete: rowsRead=${String(rowsRead)}, pageSize=${String(deps.pageSize)}`,
  );
  return { rowsRead };
}
