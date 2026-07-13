/**
 * `aws/logs-insights/errors` — typed errors for CloudWatch Logs Insights
 * query execution failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

import type { LogsInsightsQueryStatus } from "./types.js";

/**
 * Constructor options for {@link M3LLogsInsightsStartQueryError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so the
 * options shape is an implementation detail of the constructor.
 */
interface M3LLogsInsightsStartQueryErrorOptions {
  /** The log groups the failed `StartQuery` call targeted. */
  readonly logGroupNames: readonly string[];
  /** The underlying cause, when the failure originates from the SDK call itself. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LLogsInsightsClient.startQuery} when the AWS
 * `StartQuery` response carries no `queryId` (after any throttling retries
 * have been exhausted).
 *
 * @example
 * ```ts
 * import { M3LLogsInsightsStartQueryError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await client.startQuery(input);
 * } catch (error) {
 *   if (error instanceof M3LLogsInsightsStartQueryError) {
 *     console.error(error.context.logGroupNames);
 *   }
 * }
 * ```
 */
export class M3LLogsInsightsStartQueryError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_LOGS_INSIGHTS_START_QUERY"`. */
  override readonly code = "ERR_LOGS_INSIGHTS_START_QUERY" as const;

  /**
   * Creates a new `M3LLogsInsightsStartQueryError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - `logGroupNames` (carried in `context`) and an optional
   *   `cause` chaining the underlying SDK failure.
   */
  constructor(message: string, options: M3LLogsInsightsStartQueryErrorOptions) {
    super(message, {
      code: "ERR_LOGS_INSIGHTS_START_QUERY",
      context: { logGroupNames: options.logGroupNames },
      ...(options.cause !== undefined && { cause: options.cause }),
    });
  }
}

/**
 * Constructor options for {@link M3LLogsInsightsQueryFailedError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it.
 */
interface M3LLogsInsightsQueryFailedErrorOptions {
  /** The AWS-side query identifier, so a caller can log or checkpoint against it. */
  readonly queryId: string;
  /** The terminal AWS query status that caused the failure. */
  readonly status: LogsInsightsQueryStatus;
  /**
   * The underlying cause, when the failure originates from a `GetQueryResults`
   * SDK call that never returned a response (as opposed to a successful
   * response carrying a terminal non-`Complete` status).
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LLogsInsightsClient.awaitResults} when `GetQueryResults`
 * reaches a terminal, non-`Complete` status (`Failed`, `Cancelled`,
 * `Timeout`, or `Unknown`), or when the `GetQueryResults` SDK call itself
 * fails after any throttling retries have been exhausted (reported with
 * `status: "Unknown"` and a chained `cause`).
 *
 * Deliberately carries `queryId` in `context` — unlike the poller's own
 * exhaustion error, a terminal-failure status is a fact about a specific,
 * still-nameable query, and callers (e.g. a resumable script) need the id to
 * log or checkpoint against.
 *
 * @example
 * ```ts
 * import { M3LLogsInsightsQueryFailedError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await client.awaitResults(queryId);
 * } catch (error) {
 *   if (error instanceof M3LLogsInsightsQueryFailedError) {
 *     console.error(error.context.queryId, error.context.status);
 *   }
 * }
 * ```
 */
export class M3LLogsInsightsQueryFailedError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_LOGS_INSIGHTS_QUERY_FAILED"`. */
  override readonly code = "ERR_LOGS_INSIGHTS_QUERY_FAILED" as const;

  /**
   * Creates a new `M3LLogsInsightsQueryFailedError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - `queryId` and `status` (both carried in `context`), and
   *   an optional `cause` chaining the underlying SDK failure.
   */
  constructor(
    message: string,
    options: M3LLogsInsightsQueryFailedErrorOptions,
  ) {
    super(message, {
      code: "ERR_LOGS_INSIGHTS_QUERY_FAILED",
      context: { queryId: options.queryId, status: options.status },
      ...(options.cause !== undefined && { cause: options.cause }),
    });
  }
}
