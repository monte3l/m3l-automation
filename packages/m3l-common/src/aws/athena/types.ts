/**
 * `aws/athena/types` — request/response shapes for {@link M3LAthenaClient}.
 *
 * @packageDocumentation
 */

/**
 * Input for {@link M3LAthenaClient.startQuery} (and
 * {@link M3LAthenaClient.runQuery}). Field names mirror the AWS
 * `StartQueryExecution` request shape closely so no translation layer is
 * needed at the call site.
 *
 * @example
 * ```ts
 * const input: StartAthenaQueryInput = {
 *   queryString: "SELECT * FROM my_table LIMIT 10",
 *   database: "my_database",
 *   outputLocation: "s3://my-athena-results-bucket/",
 * };
 * ```
 */
export interface StartAthenaQueryInput {
  /** The SQL query text, passed verbatim as `QueryString`. */
  readonly queryString: string;
  /**
   * The Glue/Athena database the query executes against
   * (`QueryExecutionContext.Database`).
   */
  readonly database?: string;
  /**
   * The data catalog the query executes against
   * (`QueryExecutionContext.Catalog`).
   */
  readonly catalog?: string;
  /**
   * S3 URI query results are written to (`ResultConfiguration.OutputLocation`).
   * Required by AWS unless the target workgroup has a default result
   * configuration.
   */
  readonly outputLocation?: string;
  /** The Athena workgroup to run the query in (`WorkGroup`). */
  readonly workGroup?: string;
  /** Positional parameters for a parameterized query (`ExecutionParameters`). */
  readonly executionParameters?: readonly string[];
}

/**
 * The AWS Athena query execution lifecycle status, as returned by
 * `GetQueryExecution.QueryExecution.Status.State`. `"UNKNOWN"` is synthesized
 * by this wrapper — it is not part of AWS's own `State` enum — to report a
 * `GetQueryExecution`/`GetQueryResults` SDK send failure, mirroring
 * `M3LLogsInsightsClient`'s synthetic `"Unknown"` status.
 */
export type AthenaQueryStatus =
  "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";

/**
 * A single normalized result row: AWS `Row.Data[]` collapsed to a plain
 * record keyed by column name.
 */
export type AthenaRow = Record<string, string>;

/**
 * Schema of one result column, surfaced from
 * `GetQueryResults.ResultSet.ResultSetMetadata.ColumnInfo`.
 */
export interface AthenaColumnInfo {
  /** The column name. */
  readonly name: string;
  /** The Athena/Presto column type (e.g. `"varchar"`, `"bigint"`). */
  readonly type: string;
}

/**
 * Query execution statistics, surfaced from AWS
 * `GetQueryExecution.QueryExecution.Statistics`.
 */
export interface AthenaQueryStatistics {
  /** Bytes scanned to produce the result (drives Athena's per-query cost). */
  readonly dataScannedInBytes?: number;
  /** Total wall-clock execution time in milliseconds. */
  readonly totalExecutionTimeInMillis?: number;
  /** Query engine execution time in milliseconds. */
  readonly engineExecutionTimeInMillis?: number;
}

/**
 * The successful result of a completed Athena query, returned by
 * {@link M3LAthenaClient.awaitResults} / `.runQuery`.
 */
export interface AthenaQueryResult {
  /** The AWS-side query execution identifier this result was polled from. */
  readonly queryExecutionId: string;
  /** Always `"SUCCEEDED"` — only a `SUCCEEDED` status reaches the success path. */
  readonly status: "SUCCEEDED";
  /** Column schema for `rows`, in column order. */
  readonly columns: readonly AthenaColumnInfo[];
  /**
   * Normalized result rows across every `GetQueryResults` page. For a
   * `SELECT`/DML query, AWS returns the column header as the first row of
   * the first page only — this wrapper strips it and keys every row by
   * `columns[].name` rather than trusting the header text, so pagination
   * (`NextToken`) never re-includes it.
   */
  readonly rows: readonly AthenaRow[];
  /** Query execution statistics, when AWS returns them. */
  readonly statistics?: AthenaQueryStatistics;
}
