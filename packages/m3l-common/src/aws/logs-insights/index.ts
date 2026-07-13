/**
 * `aws/logs-insights` — a typed CloudWatch Logs Insights query wrapper, so
 * consumer scripts never need to import `@aws-sdk/client-cloudwatch-logs`
 * directly (ADR-0027).
 *
 * @packageDocumentation
 */

export { M3LLogsInsightsClient } from "./client.js";
export type { LogsInsightsAwaitOptions } from "./client.js";

export {
  M3LLogsInsightsQueryFailedError,
  M3LLogsInsightsStartQueryError,
} from "./errors.js";

export type {
  LogsInsightsQueryResult,
  LogsInsightsQueryStatistics,
  LogsInsightsQueryStatus,
  LogsInsightsRow,
  StartLogsInsightsQueryInput,
} from "./types.js";
