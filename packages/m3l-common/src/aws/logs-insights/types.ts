/**
 * `aws/logs-insights/types` — request/response shapes for
 * {@link M3LLogsInsightsClient}.
 *
 * @packageDocumentation
 */

/**
 * Input for {@link M3LLogsInsightsClient.startQuery} (and
 * {@link M3LLogsInsightsClient.runQuery}). Field names mirror the AWS
 * `StartQuery` request shape 1:1 so no translation layer is needed at the
 * call site.
 *
 * @example
 * ```ts
 * const input: StartLogsInsightsQueryInput = {
 *   logGroupNames: ["/aws/lambda/my-function"],
 *   queryString: "fields @timestamp, @message | sort @timestamp desc",
 *   startTime: 1_700_000_000,
 *   endTime: 1_700_003_600,
 *   limit: 1000,
 * };
 * ```
 */
export interface StartLogsInsightsQueryInput {
  /**
   * Log group names to query (AWS `StartQuery.logGroupNames` — the
   * ≤50-name array form, not `logGroupName`/`logGroupIdentifiers`).
   */
  readonly logGroupNames: readonly string[];
  /** The Logs Insights query string, passed verbatim as `queryString`. */
  readonly queryString: string;
  /** Inclusive range start, epoch **seconds** (what `StartQuery` expects). */
  readonly startTime: number;
  /** Inclusive range end, epoch **seconds**. */
  readonly endTime: number;
  /** Maximum rows AWS returns for this query (hard-capped at 10,000 by AWS). */
  readonly limit?: number;
}

/** The AWS Logs Insights query lifecycle status, as returned by `GetQueryResults`. */
export type LogsInsightsQueryStatus =
  | "Scheduled"
  | "Running"
  | "Complete"
  | "Failed"
  | "Cancelled"
  | "Timeout"
  | "Unknown";

/** A single normalized result row: AWS `ResultField[]` collapsed to a plain record. */
export type LogsInsightsRow = Record<string, string>;

/** Query execution statistics, surfaced from AWS `GetQueryResults.statistics`. */
export interface LogsInsightsQueryStatistics {
  /** Number of log events that matched the query. */
  readonly recordsMatched?: number;
  /** Number of log events scanned to produce the result. */
  readonly recordsScanned?: number;
  /** Number of bytes scanned to produce the result. */
  readonly bytesScanned?: number;
}

/**
 * The successful result of a completed Logs Insights query, returned by
 * {@link M3LLogsInsightsClient.awaitResults} / `.runQuery`.
 */
export interface LogsInsightsQueryResult {
  /** The AWS-side query identifier this result was polled from. */
  readonly queryId: string;
  /** Always `"Complete"` — only a `Complete` status reaches the success path. */
  readonly status: "Complete";
  /** Normalized result rows (AWS `ResultField[]` collapsed per row). */
  readonly rows: readonly LogsInsightsRow[];
  /** Query execution statistics, when AWS returns them. */
  readonly statistics?: LogsInsightsQueryStatistics;
}
