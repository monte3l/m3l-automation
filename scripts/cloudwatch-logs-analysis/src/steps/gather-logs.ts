import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import type {
  AnalysisGatherer,
  AnalysisQueryRequest,
  AnalysisRow,
} from "./preset.js";

/** The error code a failed evidence query surfaces under. */
const GATHER_CODE = "ERR_LOGS_ANALYSIS_GATHER";

/** AWS caps `StartQuery.logGroupNames` at 50 entries. */
export const MAX_LOG_GROUPS = 50;

/** What {@link createLogsInsightsGatherer} needs to run a stage's query. */
export interface LogsInsightsGathererOptions {
  /** The typed Logs Insights wrapper, built from `script.aws` in `main.ts`. */
  readonly client: AWS.M3LLogsInsightsClient;
  /** Receives one `info` line per query — metadata only, never row content. */
  readonly logger: Core.M3LLogger;
}

/**
 * Adapts {@link AWS.M3LLogsInsightsClient} to the narrow
 * {@link AnalysisGatherer} seam the procedure's `gather` steps run through.
 *
 * The seam exists so the whole step graph — the severity ladder, the
 * authorizer hop, the trace chain, the depth cap — is unit-testable against
 * a fake with no AWS client and no network. This is the only module in the
 * script that touches the SDK wrapper.
 *
 * @param options - The Logs Insights client and the run's logger.
 * @returns A gatherer that runs one query per call.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { createLogsInsightsGatherer } from "./gather-logs.js";
 *
 * declare const client: AWS.M3LLogsInsightsClient;
 * const gatherer = createLogsInsightsGatherer({
 *   client,
 *   logger: new Core.M3LLogger([]),
 * });
 * ```
 */
export function createLogsInsightsGatherer(
  options: LogsInsightsGathererOptions,
): AnalysisGatherer {
  return {
    async query(
      request: AnalysisQueryRequest,
    ): Promise<readonly AnalysisRow[]> {
      assertQueryable(request);
      options.logger.info("querying log groups for alarm evidence", {
        logGroups: request.logGroups.length,
        startTime: request.startTime,
        endTime: request.endTime,
      });
      const result = await options.client.runQuery(
        {
          logGroupNames: request.logGroups,
          queryString: request.query,
          startTime: request.startTime,
          endTime: request.endTime,
          ...(request.limit !== undefined && { limit: request.limit }),
        },
        // Forwarded so a long analysis stays cancellable at the pending
        // GetQueryResults backoff, not only between stages (ADR-0049).
        ...(request.signal !== undefined
          ? [{ signal: request.signal } as const]
          : []),
      );
      return result.rows;
    },
  };
}

/**
 * Rejects a request AWS would reject anyway, with a message naming the
 * preset stage's own constraint rather than an SDK validation error.
 */
function assertQueryable(request: AnalysisQueryRequest): void {
  if (request.logGroups.length === 0) {
    throw new Core.M3LError("a stage declared no log groups to query", {
      code: GATHER_CODE,
    });
  }
  if (request.logGroups.length > MAX_LOG_GROUPS) {
    throw new Core.M3LError(
      `a stage declared ${String(request.logGroups.length)} log groups; AWS accepts at most ${String(MAX_LOG_GROUPS)}`,
      { code: GATHER_CODE },
    );
  }
  if (request.endTime <= request.startTime) {
    throw new Core.M3LError(
      "the resolved analysis window is empty or inverted",
      { code: GATHER_CODE },
    );
  }
}
