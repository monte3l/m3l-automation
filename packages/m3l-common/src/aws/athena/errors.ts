/**
 * `aws/athena/errors` — typed errors for Amazon Athena query execution
 * failures.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

import type { AthenaQueryStatus } from "./types.js";

/**
 * Constructor options for {@link M3LAthenaStartQueryError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it, so the
 * options shape is an implementation detail of the constructor.
 */
interface M3LAthenaStartQueryErrorOptions {
  /** The query text of the failed `StartQueryExecution` call. */
  readonly queryString: string;
  /** The underlying cause, when the failure originates from the SDK call itself. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LAthenaClient.startQuery} when the AWS
 * `StartQueryExecution` response carries no `QueryExecutionId` (after any
 * throttling retries have been exhausted).
 *
 * @example
 * ```ts
 * import { M3LAthenaStartQueryError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await athena.startQuery(input);
 * } catch (error) {
 *   if (error instanceof M3LAthenaStartQueryError) {
 *     console.error(error.context.queryString);
 *   }
 * }
 * ```
 */
export class M3LAthenaStartQueryError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_ATHENA_START_QUERY"`. */
  override readonly code = "ERR_ATHENA_START_QUERY" as const;

  /**
   * Creates a new `M3LAthenaStartQueryError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - `queryString` (carried in `context`) and an optional
   *   `cause` chaining the underlying SDK failure.
   */
  constructor(message: string, options: M3LAthenaStartQueryErrorOptions) {
    super(message, {
      code: "ERR_ATHENA_START_QUERY",
      context: { queryString: options.queryString },
      ...(options.cause !== undefined && { cause: options.cause }),
    });
  }
}

/**
 * Constructor options for {@link M3LAthenaQueryFailedError}.
 *
 * Not exported — callers _catch_ this error, they don't construct it.
 */
interface M3LAthenaQueryFailedErrorOptions {
  /** The AWS-side query execution identifier, so a caller can log or checkpoint against it. */
  readonly queryExecutionId: string;
  /** The terminal Athena query status that caused the failure. */
  readonly status: AthenaQueryStatus;
  /**
   * The underlying cause, when the failure originates from a
   * `GetQueryExecution`/`GetQueryResults` SDK call that never returned a
   * response (as opposed to a successful response carrying a terminal
   * non-`SUCCEEDED` status).
   */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LAthenaClient.awaitResults} when `GetQueryExecution`
 * reaches a terminal, non-`SUCCEEDED` status (`FAILED` or `CANCELLED`), or
 * when the `GetQueryExecution`/`GetQueryResults` SDK call itself fails after
 * any throttling retries have been exhausted (reported with
 * `status: "UNKNOWN"` and a chained `cause`).
 *
 * Deliberately carries `queryExecutionId` in `context` — a terminal-failure
 * status is a fact about a specific, still-nameable query, and callers (e.g.
 * a resumable script) need the id to log or checkpoint against.
 *
 * @example
 * ```ts
 * import { M3LAthenaQueryFailedError } from "@m3l-automation/m3l-common/aws";
 *
 * try {
 *   await athena.awaitResults(queryExecutionId);
 * } catch (error) {
 *   if (error instanceof M3LAthenaQueryFailedError) {
 *     console.error(error.context.queryExecutionId, error.context.status);
 *   }
 * }
 * ```
 */
export class M3LAthenaQueryFailedError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_ATHENA_QUERY_FAILED"`. */
  override readonly code = "ERR_ATHENA_QUERY_FAILED" as const;

  /**
   * Creates a new `M3LAthenaQueryFailedError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - `queryExecutionId` and `status` (both carried in
   *   `context`), and an optional `cause` chaining the underlying SDK failure.
   */
  constructor(message: string, options: M3LAthenaQueryFailedErrorOptions) {
    super(message, {
      code: "ERR_ATHENA_QUERY_FAILED",
      context: {
        queryExecutionId: options.queryExecutionId,
        status: options.status,
      },
      ...(options.cause !== undefined && { cause: options.cause }),
    });
  }
}
