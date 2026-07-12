/**
 * `aws/dynamodb/error` — typed error for DynamoDB item-operation failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/**
 * Constructor options for {@link M3LDynamoDBOperationError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so the
 * options shape is an implementation detail of the constructor.
 */
interface M3LDynamoDBOperationErrorOptions {
  /**
   * The underlying cause: the raw AWS SDK command rejection. Explicitly
   * widened to include `undefined` (rather than only being optional) so
   * callers that carry a `unknown | undefined`-typed cause can forward it
   * directly under `exactOptionalPropertyTypes`.
   */
  readonly cause?: unknown;
  /** Structured diagnostics — e.g. the table name and operation attempted. */
  readonly context?: Record<string, unknown>;
}

/**
 * Thrown by every `aws/dynamodb` operation (`getItem`, `putItem`,
 * `updateItem`, `deleteItem`, `queryItems`, `scanSegment`, `batchWriteItems`,
 * `batchDeleteItems`, `describeTable`) when the underlying AWS SDK command
 * rejects.
 *
 * The originating SDK error is chained via `cause`, so callers can narrow on
 * `code === "ERR_DYNAMODB_OPERATION"` and inspect `error.cause` for the root
 * failure — the same pattern as {@link M3LAWSClientError} one layer down.
 *
 * @example
 * ```ts
 * import { M3LDynamoDBOperationError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   // ... send a DynamoDB command ...
 * } catch (cause) {
 *   throw new M3LDynamoDBOperationError("getItem failed", {
 *     cause,
 *     context: { tableName: "orders" },
 *   });
 * }
 * ```
 */
export class M3LDynamoDBOperationError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_DYNAMODB_OPERATION"`. */
  override readonly code = "ERR_DYNAMODB_OPERATION" as const;

  /**
   * Creates a new `M3LDynamoDBOperationError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional options bag; `cause` carries the underlying
   *   SDK rejection. The error code is always `"ERR_DYNAMODB_OPERATION"` — it
   *   cannot be overridden.
   */
  constructor(message: string, options?: M3LDynamoDBOperationErrorOptions) {
    super(message, {
      code: "ERR_DYNAMODB_OPERATION",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}
