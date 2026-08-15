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
 * The `Core.M3LError` code {@link runQuery} throws with when the output
 * writer's `close()` fails after the try body otherwise succeeded — see
 * that catch site's TSDoc for why this case cannot be a best-effort log.
 */
const OUTPUT_WRITER_CODE = "ERR_RDS_DATA_SQL_OUTPUT_WRITER";

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
  /**
   * The byte length already flushed to the output file by a prior
   * interrupted run — `writer.bytesWritten` as of the last checkpoint write.
   * On resume, {@link runQuery} passes this to `createWriter` as
   * `resumeFromByte`, so the reopened writer appends from exactly this
   * offset instead of truncating and replaying.
   */
  readonly outputBytes?: number;
  /**
   * The output column list, derived from the first page's
   * `result.columns` on a fresh run and persisted unchanged thereafter.
   * CSV-only in practice (a CSV resume requires a matching header), but
   * always populated regardless of `output.format` — this step has no
   * format concept of its own; `createWriter`'s caller decides whether to
   * use it.
   */
  readonly columns?: readonly string[];
}

/** The narrow checkpoint port {@link runQuery} depends on. */
interface RunQueryCheckpointPort {
  /** Reads the current checkpoint, or an empty object on a fresh run. */
  read(): Promise<RunQueryCheckpoint>;
  /** Persists the checkpoint after a full page completes. */
  write(checkpoint: {
    readonly offset: number;
    readonly outputBytes: number;
    readonly columns?: readonly string[];
  }): Promise<void>;
  /** Deletes the checkpoint once the run completes successfully. */
  delete(): Promise<void>;
}

/** The narrow streaming-writer port {@link runQuery} appends each row's coerced record to. */
interface RunQueryWriterPort {
  /** Appends one coerced output record to the underlying exporter stream. */
  append(record: Record<string, unknown>): Promise<void>;
  /** Closes the underlying exporter stream. */
  close(): Promise<void>;
  /** The total byte length flushed to the output file so far. */
  readonly bytesWritten: number;
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
  /**
   * Builds the streaming output-writer, deferred until columns are known:
   * a fresh CSV run cannot open its writer until the first
   * `executeStatement` response reveals `result.columns` (the CSV header),
   * so `runQuery` calls this itself instead of receiving an
   * already-opened writer. `args.resumeFromByte`/`args.columns` come
   * straight from the checkpoint on a resumed run, or `0`/the
   * first-page-derived column list on a fresh one.
   */
  readonly createWriter: (args: {
    readonly resumeFromByte: number;
    readonly columns: readonly string[] | undefined;
  }) => RunQueryWriterPort;
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

/** Streams one `executeStatement` result's rows through `toRecord` + `writer.append`, returning the coerced records in emission order. */
async function streamResultRows(
  writer: RunQueryWriterPort,
  toRecord: RunQueryDeps["toRecord"],
  result: AWS.M3LRDSDataStatementResult,
): Promise<readonly Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    const record = toRecord(result.columns, row);
    await writer.append(record);
    records.push(record);
  }
  return records;
}

/** Wraps `sql` in `run-query`'s `LIMIT`/`OFFSET` paging subquery. */
function buildPagedSql(sql: string): string {
  return `SELECT * FROM (${stripTrailingStatementNoise(sql)}) AS m3l_page LIMIT :limit OFFSET :offset`;
}

/** Builds one paged-path `executeStatement` input for `offset`, injecting the reserved `limit`/`offset` binds. */
function buildPagedStatementInput(
  deps: RunQueryDeps,
  wrappedSql: string,
  offset: number,
): AWS.M3LRDSDataStatementInput {
  return buildStatementInput(deps, wrappedSql, [
    ...deps.parameters,
    { name: "limit", value: { kind: "long", value: deps.pageSize } },
    { name: "offset", value: { kind: "long", value: offset } },
  ]);
}

/**
 * Runs the `page.size > 0` paged path against an already-constructed
 * `writer`, starting from `startOffset` — split out of {@link runQuery} to
 * keep its cyclomatic complexity low.
 *
 * When `firstResult` is supplied (the fresh-run bootstrap page, already
 * fetched by the caller to derive `columns` before `writer` existed), the
 * loop's first iteration streams it directly instead of issuing another
 * `executeStatement` call; every subsequent iteration (and every iteration
 * on a resumed run, where `firstResult` is never supplied) fetches its own
 * page normally. The checkpoint written after each *continued* (full) page
 * carries `writer.bytesWritten` and `columns` — the writer's own resume
 * seam means no record replay is ever needed on the next resume.
 */
async function runPagedQuery(
  deps: RunQueryDeps,
  writer: RunQueryWriterPort,
  startOffset: number,
  columns: readonly string[] | undefined,
  firstResult?: AWS.M3LRDSDataStatementResult,
): Promise<number> {
  const wrappedSql = buildPagedSql(deps.sql);
  let offset = startOffset;
  let rowsRead = 0;
  let pendingResult = firstResult;

  for (;;) {
    const result =
      pendingResult ??
      (await deps.rdsData.executeStatement(
        buildPagedStatementInput(deps, wrappedSql, offset),
      ));
    pendingResult = undefined;

    const pageRecords = await streamResultRows(writer, deps.toRecord, result);
    rowsRead += pageRecords.length;

    if (pageRecords.length < deps.pageSize) break;
    offset += deps.pageSize;
    await deps.checkpoint.write({
      offset,
      outputBytes: writer.bytesWritten,
      ...(columns !== undefined && { columns }),
    });
  }

  return rowsRead;
}

/** Runs the `page.size = 0` unpaged path — a single `executeStatement` call streamed through an already-constructed `writer`. */
async function runUnpagedQuery(
  deps: RunQueryDeps,
  writer: RunQueryWriterPort,
): Promise<number> {
  const result = await deps.rdsData.executeStatement(
    buildStatementInput(deps, deps.sql, deps.parameters),
  );
  const records = await streamResultRows(writer, deps.toRecord, result);
  return records.length;
}

/** One run's outcome: the writer it built, plus the row count it streamed through that writer. */
interface QueryRunOutcome {
  readonly writer: RunQueryWriterPort;
  readonly rowsRead: number;
}

/**
 * Closes `writer` after the run's try body has finished, attributing a
 * `close()` failure correctly depending on whether that try body already
 * threw:
 *
 * - `primaryFailed: true` — the try body already threw, and that error is
 *   what's propagating past this `finally`. A `close()` failure here is
 *   secondary, so it's only logged; re-throwing it would replace the
 *   original error mid-flight instead of letting it continue propagating.
 * - `primaryFailed: false` — the try body succeeded, so a `close()` failure
 *   here is the ONLY signal of a real problem: e.g. a resumed run whose
 *   checkpoint claims a `resumeFromByte` beyond the file's actual size, a
 *   failure the writer defers until its first `write()`/`end()` call
 *   (which happens inside `close()` when zero rows were appended this run).
 *   Swallowing it would let {@link runQuery} delete the checkpoint and
 *   report success over a truncated/invalid resume, so it propagates as a
 *   typed `M3LError` instead.
 *
 * Split out of {@link runQuery}'s own `finally` block (rather than inlined)
 * so the propagating `throw` sits inside an ordinary function body, not
 * textually inside a `finally` block, keeping ESLint's `no-unsafe-finally`
 * and `max-depth` both satisfied.
 *
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_OUTPUT_WRITER"` when
 *   `writer.close()` fails and `primaryFailed` is `false`.
 */
async function closeWriterAfterRun(
  writer: RunQueryWriterPort,
  primaryFailed: boolean,
  logger: Core.M3LLogger,
): Promise<void> {
  try {
    await writer.close();
  } catch (closeError) {
    if (primaryFailed) {
      logger.error("run-query: failed to close the output writer", {
        error:
          closeError instanceof Error ? closeError.message : String(closeError),
      });
      return;
    }
    throw new Core.M3LError(
      "run-query: failed to close the output writer after a successful run",
      { code: OUTPUT_WRITER_CODE, cause: closeError },
    );
  }
}

/**
 * Runs the resumed path: `writer` opens immediately from the checkpoint's
 * saved byte offset/columns, before any `executeStatement` call — no
 * record replay is needed, since the writer itself resumes appending from
 * its own byte offset instead of truncating and being repopulated.
 *
 * Calls `onWriterReady` the instant `createWriter` returns, before the
 * subsequent `runPagedQuery`/`runUnpagedQuery` call that could itself throw
 * (e.g. a rejected `executeStatement`). Without this, a throw there would
 * propagate past this function's own `return` — leaving `runQuery`'s outer
 * `writer` variable `undefined` and its `finally` block's
 * `closeWriterAfterRun` call skipped, silently leaking the already-open
 * writer (a real `fs.WriteStream`) on every resumed run that fails after
 * its writer was constructed.
 */
async function runResumedQuery(
  deps: RunQueryDeps,
  savedCheckpoint: RunQueryCheckpoint,
  onWriterReady: (writer: RunQueryWriterPort) => void,
): Promise<QueryRunOutcome> {
  const writer = deps.createWriter({
    resumeFromByte: savedCheckpoint.outputBytes ?? 0,
    columns: savedCheckpoint.columns,
  });
  onWriterReady(writer);
  const rowsRead =
    deps.pageSize > 0
      ? await runPagedQuery(
          deps,
          writer,
          savedCheckpoint.offset ?? 0,
          savedCheckpoint.columns,
        )
      : await runUnpagedQuery(deps, writer);
  return { writer, rowsRead };
}

/**
 * Runs the fresh path: the writer cannot be constructed until output
 * columns are known — for CSV output that means the header — so the first
 * `executeStatement` call happens before `writer` exists, and `columns` is
 * derived from that response's `result.columns` before `createWriter` runs.
 * This step has no `output.format` concept of its own: `columns` is always
 * derived and forwarded, and `createWriter`'s caller (`build-operation-deps.ts`)
 * decides whether a non-CSV writer actually uses it.
 *
 * Calls `onWriterReady` immediately after each branch's `createWriter` call,
 * before the subsequent `runPagedQuery`/`streamResultRows` call that could
 * itself throw — see {@link runResumedQuery}'s TSDoc for why this ordering
 * matters (it closes the same writer-leak).
 */
async function runFreshQuery(
  deps: RunQueryDeps,
  onWriterReady: (writer: RunQueryWriterPort) => void,
): Promise<QueryRunOutcome> {
  if (deps.pageSize > 0) {
    const wrappedSql = buildPagedSql(deps.sql);
    const firstResult = await deps.rdsData.executeStatement(
      buildPagedStatementInput(deps, wrappedSql, 0),
    );
    const columns = firstResult.columns.map((column) => column.name);
    const writer = deps.createWriter({ resumeFromByte: 0, columns });
    onWriterReady(writer);
    const rowsRead = await runPagedQuery(deps, writer, 0, columns, firstResult);
    return { writer, rowsRead };
  }

  const result = await deps.rdsData.executeStatement(
    buildStatementInput(deps, deps.sql, deps.parameters),
  );
  const columns = result.columns.map((column) => column.name);
  const writer = deps.createWriter({ resumeFromByte: 0, columns });
  onWriterReady(writer);
  const records = await streamResultRows(writer, deps.toRecord, result);
  return { writer, rowsRead: records.length };
}

/**
 * Runs `query`, streaming every page's rows to a writer built via
 * `deps.createWriter` and resolving once the whole statement (paged or
 * unpaged) has been read.
 *
 * @param deps - See {@link RunQueryDeps}.
 * @returns The total row count streamed.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_RESERVED_PARAMETER"`
 *   when `page.size > 0` and `deps.parameters` declares `limit` or `offset`
 *   — checked before any statement runs.
 * @throws Whatever `deps.rdsData.executeStatement` throws, unchanged —
 *   including `AWS.M3LRDSDataResultTooLargeError`, which this step never
 *   catches or wraps (nor does it ever construct the writer in that case).
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_OUTPUT_WRITER"` when
 *   the run otherwise succeeded but the output writer's `close()` fails —
 *   see {@link closeWriterAfterRun} for why this case cannot be a
 *   best-effort log (it may carry the only signal of an invalid resume).
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
  const isResuming =
    savedCheckpoint.offset !== undefined ||
    savedCheckpoint.outputBytes !== undefined ||
    savedCheckpoint.columns !== undefined;

  let writer: RunQueryWriterPort | undefined;
  let rowsRead: number;
  // Tracks whether the try body below already threw, so the writer-close
  // finally (next) knows whether a close() failure is secondary (log-only)
  // or is itself the only signal of a real failure (must propagate). See
  // that finally block's own comments for why the distinction matters.
  let primaryFailed = false;

  try {
    const outcome = isResuming
      ? await runResumedQuery(deps, savedCheckpoint, (w) => {
          writer = w;
        })
      : await runFreshQuery(deps, (w) => {
          writer = w;
        });
    writer = outcome.writer;
    rowsRead = outcome.rowsRead;
  } catch (cause) {
    primaryFailed = true;
    throw cause;
  } finally {
    // No writer to close when construction never happened (e.g. the very
    // first executeStatement call rejected before createWriter ran).
    if (writer !== undefined) {
      await closeWriterAfterRun(writer, primaryFailed, deps.logger);
    }
  }

  await deps.checkpoint.delete();
  deps.logger.step(
    `run-query complete: rowsRead=${String(rowsRead)}, pageSize=${String(deps.pageSize)}`,
  );
  return { rowsRead };
}
