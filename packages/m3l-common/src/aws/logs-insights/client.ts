/**
 * `aws/logs-insights/client` — `M3LLogsInsightsClient`, a typed wrapper over
 * CloudWatch Logs Insights query execution.
 *
 * @packageDocumentation
 */

import {
  GetQueryResultsCommand,
  StartQueryCommand,
  type CloudWatchLogsClient,
  type GetQueryResultsCommandOutput,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";

import { M3LPoller } from "../../core/polling/M3LPoller.js";
import type { M3LPollerOptions } from "../../core/polling/M3LPoller.js";
import { M3LPollingPolicies } from "../../core/polling/M3LPollingPolicies.js";
import { M3LRetryRunner } from "../../core/polling/M3LRetryRunner.js";

import {
  M3LLogsInsightsQueryFailedError,
  M3LLogsInsightsStartQueryError,
} from "./errors.js";
import type {
  LogsInsightsQueryResult,
  LogsInsightsRow,
  StartLogsInsightsQueryInput,
} from "./types.js";

/**
 * Collapses one AWS `ResultField[]` row into a plain record, preserving every
 * field (including `@ptr`/`@timestamp`/`@message`). Entries with no `field`
 * are skipped; a missing `value` normalizes to `""`.
 */
function normalizeRow(fields: readonly ResultField[]): LogsInsightsRow {
  const row: Record<string, string> = {};
  for (const { field, value } of fields) {
    if (field === undefined) continue;
    row[field] = value ?? "";
  }
  return row;
}

/** Optional overrides for {@link M3LLogsInsightsClient.awaitResults} / `.runQuery`. */
export interface LogsInsightsAwaitOptions {
  /**
   * Overrides the default poller built from
   * `Core.M3LPollingPolicies.cloudWatchLogsQuery()`. Callers build this via
   * a `M3LPollingPolicies` factory and pass it opaquely — the option type
   * itself is not part of the public barrel.
   */
  readonly pollerOptions?: M3LPollerOptions;
}

/**
 * Typed wrapper over CloudWatch Logs Insights query execution
 * (`StartQuery`/`GetQueryResults`), so consumer scripts never need to import
 * `@aws-sdk/client-cloudwatch-logs` directly (ADR-0026).
 *
 * Wraps an already-provisioned `CloudWatchLogsClient` — obtain one from
 * `script.aws.cloudWatchLogs` (the library's credential/client-construction
 * seam) and inject it here; this class never constructs its own client from
 * a profile/region.
 *
 * @example
 * ```ts
 * import { M3LLogsInsightsClient } from "@m3l-automation/m3l-common/aws";
 *
 * const insights = new M3LLogsInsightsClient(script.aws.cloudWatchLogs);
 * const result = await insights.runQuery({
 *   logGroupNames: ["/aws/lambda/my-function"],
 *   queryString: "fields @timestamp, @message | sort @timestamp desc",
 *   startTime: 1_700_000_000,
 *   endTime: 1_700_003_600,
 *   limit: 1000,
 * });
 * console.log(result.rows);
 * ```
 */
export class M3LLogsInsightsClient {
  readonly #client: CloudWatchLogsClient;

  /**
   * Creates a new `M3LLogsInsightsClient`.
   *
   * @param client - An already-provisioned `CloudWatchLogsClient`, typically
   *   `script.aws.cloudWatchLogs`.
   */
  constructor(client: CloudWatchLogsClient) {
    this.#client = client;
  }

  /**
   * Submits a Logs Insights query and returns its `queryId`. Wraps
   * `StartQueryCommand`, retried under AWS throttling.
   *
   * @param input - The query definition (log groups, query string, time
   *   range, optional row limit).
   * @returns The AWS-assigned `queryId`.
   * @throws {@link M3LLogsInsightsStartQueryError} When the `StartQuery` SDK
   *   call itself fails (after any throttling retries are exhausted; the
   *   original error is chained via `cause`), or when the response carries no
   *   `queryId`.
   */
  async startQuery(input: StartLogsInsightsQueryInput): Promise<string> {
    const runner = new M3LRetryRunner(M3LPollingPolicies.awsThrottling());
    let response;
    try {
      response = await runner.run(() =>
        this.#client.send(
          new StartQueryCommand({
            logGroupNames: [...input.logGroupNames],
            queryString: input.queryString,
            startTime: input.startTime,
            endTime: input.endTime,
            ...(input.limit !== undefined && { limit: input.limit }),
          }),
        ),
      );
    } catch (cause) {
      throw new M3LLogsInsightsStartQueryError("StartQuery failed", {
        logGroupNames: input.logGroupNames,
        cause,
      });
    }

    if (!response.queryId) {
      throw new M3LLogsInsightsStartQueryError(
        "StartQuery response carried no queryId",
        { logGroupNames: input.logGroupNames },
      );
    }
    return response.queryId;
  }

  /**
   * Sends `GetQueryResultsCommand`, retried under AWS throttling. Isolated
   * from {@link awaitResults}'s poll check so that arrow function stays
   * within the project's cyclomatic-complexity budget.
   *
   * @param queryId - The AWS-assigned query identifier to poll.
   * @throws {@link M3LLogsInsightsQueryFailedError} (`status: "Unknown"`) when
   *   the send itself fails after any throttling retries are exhausted.
   */
  async #fetchQueryResults(
    queryId: string,
  ): Promise<GetQueryResultsCommandOutput> {
    try {
      return await new M3LRetryRunner(M3LPollingPolicies.awsThrottling()).run(
        () => this.#client.send(new GetQueryResultsCommand({ queryId })),
      );
    } catch (cause) {
      throw new M3LLogsInsightsQueryFailedError(
        `GetQueryResults failed for query ${queryId}`,
        { queryId, status: "Unknown", cause },
      );
    }
  }

  /**
   * Polls a Logs Insights query to completion and returns its normalized
   * results. Standalone-usable with a previously-obtained `queryId` (the
   * resume/re-attach case — no fresh `StartQuery` is issued).
   *
   * @param queryId - The AWS-assigned query identifier to poll.
   * @param options - Optional poller override.
   * @returns The normalized query result once the query reaches `Complete`.
   * @throws {@link M3LLogsInsightsQueryFailedError} When the query reaches a
   *   terminal non-`Complete` status, or when the `GetQueryResults` SDK call
   *   itself fails (after any throttling retries are exhausted; reported with
   *   `status: "Unknown"` and the original error chained via `cause`).
   * @throws A plain `M3LError` with `code === "ERR_POLL_EXHAUSTED"` when the
   *   poll attempt bound is reached while the query is still running.
   */
  async awaitResults(
    queryId: string,
    options?: LogsInsightsAwaitOptions,
  ): Promise<LogsInsightsQueryResult> {
    const poller = new M3LPoller(
      options?.pollerOptions ?? M3LPollingPolicies.cloudWatchLogsQuery(),
    );

    const response = await poller.poll<GetQueryResultsCommandOutput>(
      async () => {
        const result = await this.#fetchQueryResults(queryId);
        switch (result.status) {
          case "Complete":
            return { type: "success", value: result };
          case "Scheduled":
          case "Running":
            return { type: "continue" };
          case "Failed":
          case "Cancelled":
          case "Timeout":
          case "Unknown":
          case undefined: {
            const status = result.status ?? "Unknown";
            throw new M3LLogsInsightsQueryFailedError(
              `Logs Insights query reached terminal status ${status}`,
              { queryId, status },
            );
          }
        }
      },
    );

    return {
      queryId,
      status: "Complete",
      rows: (response.results ?? []).map((row) => normalizeRow(row)),
      ...(response.statistics !== undefined && {
        statistics: {
          ...(response.statistics.recordsMatched !== undefined && {
            recordsMatched: response.statistics.recordsMatched,
          }),
          ...(response.statistics.recordsScanned !== undefined && {
            recordsScanned: response.statistics.recordsScanned,
          }),
          ...(response.statistics.bytesScanned !== undefined && {
            bytesScanned: response.statistics.bytesScanned,
          }),
        },
      }),
    };
  }

  /**
   * Convenience combination of {@link startQuery} + {@link awaitResults} for
   * the common non-resumable case (submit and wait for one query).
   *
   * @param input - The query definition.
   * @param options - Optional poller override.
   * @returns The normalized query result once the query reaches `Complete`.
   */
  async runQuery(
    input: StartLogsInsightsQueryInput,
    options?: LogsInsightsAwaitOptions,
  ): Promise<LogsInsightsQueryResult> {
    const queryId = await this.startQuery(input);
    return this.awaitResults(queryId, options);
  }
}
