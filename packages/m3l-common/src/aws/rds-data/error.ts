/**
 * `aws/rds-data/error` — typed errors for RDS Data API operation failures
 * (as distinct from client construction/teardown failures, which are
 * {@link M3LAWSClientError}).
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LRDSDataOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so the
 * options shape is an implementation detail of the constructor.
 */
interface M3LRDSDataOperationErrorOptions {
  /**
   * The underlying cause: the raw SDK `.send()` rejection. Explicitly
   * widened to include `undefined` (rather than only being optional) so
   * callers that carry a `unknown | undefined`-typed cause can forward it
   * directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LRDSDataOperations} when an RDS Data API operation
 * fails: an `ExecuteStatement`/`BatchExecuteStatement`/`BeginTransaction`/
 * `CommitTransaction`/`RollbackTransaction` request rejects after retries.
 *
 * @example
 * ```ts
 * import { M3LRDSDataOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await rdsDataOperations.executeStatement(input);
 * } catch (error) {
 *   if (error instanceof M3LRDSDataOperationError) {
 *     // error.cause carries the underlying SDK rejection
 *   }
 * }
 * ```
 */
export class M3LRDSDataOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_RDS_DATA_OPERATION"`. */
  override readonly code = "ERR_RDS_DATA_OPERATION" as const;

  /**
   * Creates a new `M3LRDSDataOperationError`.
   *
   * @param message - Human-readable description of the failure. Must never
   *   contain a parameter or row value, only identifiers such as the
   *   cluster/secret ARN or the transaction id.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always
   *   `"ERR_RDS_DATA_OPERATION"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LRDSDataOperationErrorOptions) {
    super(message, {
      code: "ERR_RDS_DATA_OPERATION",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}

/**
 * Thrown by {@link M3LRDSDataOperations.executeStatement} when an unpaged
 * statement's result set exceeds the RDS Data API's 1 MiB response cap.
 * `ExecuteStatement` has no `NextToken`/pagination of its own — a caller
 * hitting this must page the statement itself (e.g. `LIMIT`/`OFFSET`).
 *
 * @example
 * ```ts
 * import { M3LRDSDataResultTooLargeError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await rdsDataOperations.executeStatement(input);
 * } catch (error) {
 *   if (error instanceof M3LRDSDataResultTooLargeError) {
 *     // re-issue `input.sql` with a LIMIT/OFFSET window
 *   }
 * }
 * ```
 */
export class M3LRDSDataResultTooLargeError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_RDS_DATA_RESULT_TOO_LARGE"`. */
  override readonly code = "ERR_RDS_DATA_RESULT_TOO_LARGE" as const;

  /**
   * Creates a new `M3LRDSDataResultTooLargeError`.
   *
   * @param message - Human-readable description of the failure. Must never
   *   contain a parameter or row value.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always
   *   `"ERR_RDS_DATA_RESULT_TOO_LARGE"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LRDSDataOperationErrorOptions) {
    super(message, {
      code: "ERR_RDS_DATA_RESULT_TOO_LARGE",
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
