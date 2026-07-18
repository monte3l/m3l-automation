/**
 * `aws/athena` — a typed Amazon Athena query wrapper, so consumer scripts
 * never need to import `@aws-sdk/client-athena` directly (ADR-0029).
 *
 * **NOT YET IMPLEMENTED** — see `docs/reference/aws/athena.md`.
 *
 * @packageDocumentation
 */

export { M3LAthenaClient } from "./client.js";
export type { AthenaAwaitOptions } from "./client.js";

export {
  M3LAthenaQueryFailedError,
  M3LAthenaStartQueryError,
} from "./errors.js";

export type {
  AthenaColumnInfo,
  AthenaQueryResult,
  AthenaQueryStatistics,
  AthenaQueryStatus,
  AthenaRow,
  StartAthenaQueryInput,
} from "./types.js";
