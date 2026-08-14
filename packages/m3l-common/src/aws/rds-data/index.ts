/**
 * `aws/rds-data` — typed RDS Data API operations wrapper over the raw
 * `@aws-sdk/client-rds-data` `RDSDataClient`, so callers never import SDK
 * command classes directly. Data-API-enabled Aurora clusters only. See
 * `docs/reference/aws/rds-data.md`.
 *
 * @packageDocumentation
 */

export { M3LRDSDataOperations } from "./client.js";
export {
  M3LRDSDataOperationError,
  M3LRDSDataResultTooLargeError,
} from "./error.js";
export type {
  M3LRDSDataBatchInput,
  M3LRDSDataBatchResult,
  M3LRDSDataBeginTransactionInput,
  M3LRDSDataColumn,
  M3LRDSDataParameter,
  M3LRDSDataRow,
  M3LRDSDataStatementInput,
  M3LRDSDataStatementResult,
  M3LRDSDataTransaction,
  M3LRDSDataTypeHint,
  M3LRDSDataUpdateResult,
  M3LRDSDataValue,
} from "./types.js";
