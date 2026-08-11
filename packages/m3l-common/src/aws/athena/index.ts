/**
 * `aws/athena` — a typed Amazon Athena query wrapper, so consumer scripts
 * never need to import `@aws-sdk/client-athena` directly (ADR-0029).
 *
 * @packageDocumentation
 */

export { M3LAthenaClient } from "./client.js";
export type { AthenaAwaitOptions } from "./client.js";

export {
  M3LAthenaQueryFailedError,
  M3LAthenaStartQueryError,
  M3LAthenaTemplateError,
} from "./errors.js";

export { compileAthenaQueryTemplate } from "./template.js";
export type { M3LAthenaCompiledQuery } from "./template.js";

export type {
  AthenaColumnInfo,
  AthenaQueryResult,
  AthenaQueryStatistics,
  AthenaQueryStatus,
  AthenaRow,
  StartAthenaQueryInput,
} from "./types.js";
