/**
 * `aws/rds-data/client` — {@link M3LRDSDataOperations}, a typed wrapper over
 * a raw `RDSDataClient` so callers never import
 * `@aws-sdk/client-rds-data` command classes directly. See
 * `docs/reference/aws/rds-data.md` for the full contract, and ADR-0031 for
 * why this module exists as an AWS-SDK-only route back into fleet scope for
 * Aurora PostgreSQL (via the RDS Data API), never the raw `pg` driver.
 *
 * **Scaffold status:** every method below is a placeholder that rejects with
 * {@link M3LRDSDataOperationError} — the real implementation lands under the
 * `implementing-submodules` TDD loop. Signatures and TSDoc are the contract;
 * bodies are not yet written. The constructor does not yet store its client
 * (nothing reads it until the real implementation lands).
 *
 * @packageDocumentation
 */

import type { RDSDataClient } from "@aws-sdk/client-rds-data";

import { M3LRDSDataOperationError } from "./error.js";
import type {
  M3LRDSDataBatchInput,
  M3LRDSDataBatchResult,
  M3LRDSDataStatementInput,
  M3LRDSDataStatementResult,
  M3LRDSDataTransaction,
} from "./types.js";

/** Input for {@link M3LRDSDataOperations.beginTransaction}. */
export interface M3LRDSDataBeginTransactionInput {
  /** The Aurora Data-API-enabled cluster's Amazon Resource Name (ARN). */
  readonly resourceArn: string;
  /** The Secrets Manager ARN of the secret granting DB access. */
  readonly secretArn: string;
  /** The target database name. */
  readonly database?: string;
  /** The target schema name. */
  readonly schema?: string;
}

/**
 * Typed operations over Amazon RDS Data API (`@aws-sdk/client-rds-data`),
 * for Data-API-enabled Aurora clusters only. Takes an already-provisioned
 * `RDSDataClient` via constructor injection — this class never
 * self-constructs a client from a profile/region.
 *
 * @example
 * ```ts
 * import { M3LRDSDataOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const rdsData = new M3LRDSDataOperations(script.aws.clients.rdsData);
 * const result = await rdsData.executeStatement({
 *   resourceArn: clusterArn,
 *   secretArn,
 *   sql: "SELECT id, name FROM users WHERE active = :active",
 *   parameters: [{ name: "active", value: { kind: "boolean", value: true } }],
 * });
 * ```
 */
export class M3LRDSDataOperations {
  /**
   * Creates a new `M3LRDSDataOperations`.
   *
   * @param _client - An already-provisioned `RDSDataClient`, typically
   *   `script.aws.clients.rdsData` or `script.aws.services.rdsDataOperations`.
   *   Unused for now: every method below is an unimplemented placeholder: the
   *   real implementation stores and calls this client.
   */
  constructor(_client: RDSDataClient) {}

  /**
   * Runs one SQL statement and returns its typed result set.
   *
   * @param input - The statement, its parameters, and the target cluster.
   * @returns The mapped rows, columns, and update count.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries.
   * @throws {@link M3LRDSDataResultTooLargeError} when an unpaged result set
   *   exceeds the RDS Data API's 1 MiB response cap.
   */
  executeStatement(
    input: M3LRDSDataStatementInput,
  ): Promise<M3LRDSDataStatementResult> {
    return Promise.reject(
      new M3LRDSDataOperationError(
        `executeStatement: not yet implemented (resourceArn=${input.resourceArn})`,
      ),
    );
  }

  /**
   * Runs one SQL statement once per entry in `input.parameterSets`.
   *
   * @param input - The statement, its parameter sets, and the target cluster.
   * @returns One update result per parameter set, in order.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries.
   */
  batchExecuteStatement(
    input: M3LRDSDataBatchInput,
  ): Promise<M3LRDSDataBatchResult> {
    return Promise.reject(
      new M3LRDSDataOperationError(
        `batchExecuteStatement: not yet implemented (resourceArn=${input.resourceArn})`,
      ),
    );
  }

  /**
   * Starts a SQL transaction.
   *
   * @param input - The target cluster/secret/database/schema.
   * @returns A {@link M3LRDSDataTransaction} to pass to `executeStatement`
   *   (via `transactionId`), `commitTransaction`, or `rollbackTransaction`.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries.
   */
  beginTransaction(
    input: M3LRDSDataBeginTransactionInput,
  ): Promise<M3LRDSDataTransaction> {
    return Promise.reject(
      new M3LRDSDataOperationError(
        `beginTransaction: not yet implemented (resourceArn=${input.resourceArn})`,
      ),
    );
  }

  /**
   * Commits an in-flight transaction.
   *
   * @param resourceArn - The cluster's Amazon Resource Name (ARN).
   * @param secretArn - The Secrets Manager ARN of the secret granting DB
   *   access.
   * @param transaction - The transaction to commit.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries.
   */
  commitTransaction(
    resourceArn: string,
    secretArn: string,
    transaction: M3LRDSDataTransaction,
  ): Promise<void> {
    return Promise.reject(
      new M3LRDSDataOperationError(
        `commitTransaction: not yet implemented (transactionId=${transaction.transactionId}, resourceArn=${resourceArn}, secretArn=${secretArn})`,
      ),
    );
  }

  /**
   * Rolls back an in-flight transaction.
   *
   * @param resourceArn - The cluster's Amazon Resource Name (ARN).
   * @param secretArn - The Secrets Manager ARN of the secret granting DB
   *   access.
   * @param transaction - The transaction to roll back.
   * @throws {@link M3LRDSDataOperationError} when the request fails after
   *   retries.
   */
  rollbackTransaction(
    resourceArn: string,
    secretArn: string,
    transaction: M3LRDSDataTransaction,
  ): Promise<void> {
    return Promise.reject(
      new M3LRDSDataOperationError(
        `rollbackTransaction: not yet implemented (transactionId=${transaction.transactionId}, resourceArn=${resourceArn}, secretArn=${secretArn})`,
      ),
    );
  }

  /**
   * Runs `fn` inside a begin/commit transaction, rolling back on any throw.
   * A rollback failure is never swallowed: it is chained as the `cause` of
   * the error `fn`'s own throw surfaces as.
   *
   * @param input - The target cluster/secret/database/schema.
   * @param fn - Receives the started transaction's id; its return value
   *   becomes `withTransaction`'s resolved value on commit.
   * @throws {@link M3LRDSDataOperationError} when begin/commit/rollback
   *   fails, or `fn`'s own thrown error (with a failed rollback chained onto
   *   it as `cause`) when `fn` fails.
   */
  withTransaction<T>(
    input: M3LRDSDataBeginTransactionInput,
    _fn: (transactionId: string) => Promise<T>,
  ): Promise<T> {
    return Promise.reject(
      new M3LRDSDataOperationError(
        `withTransaction: not yet implemented (resourceArn=${input.resourceArn})`,
      ),
    );
  }
}
