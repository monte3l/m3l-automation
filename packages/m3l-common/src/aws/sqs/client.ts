/**
 * `aws/sqs/client` — {@link M3LSQSOperations}, a typed wrapper over a raw
 * `SQSClient` so callers never import `@aws-sdk/client-sqs` command classes
 * directly. See ADR-0026 for why this module exists and why it is
 * permitted to import `core/polling` (Zone A, ADR-0009).
 *
 * @packageDocumentation
 */

import type { SQSClient } from "@aws-sdk/client-sqs";

import { M3LSQSOperationError } from "./error.js";
import type {
  M3LSQSBatchResult,
  M3LSQSDeleteEntry,
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
  M3LSQSSendEntry,
} from "./types.js";

/**
 * Typed operations over a raw SQS `SQSClient`: receive, batch-send,
 * batch-delete, and purge — translating SDK request/response shapes into
 * the plain types in `aws/sqs/types`. `sendBatch` and `deleteBatch` retry
 * throttling/network failures internally (see {@link M3LSQSOperationError}
 * for how a request-level failure is surfaced); `receive` and `purgeQueue`
 * are not retried (ADR-0026).
 *
 * @example
 * ```ts
 * import { M3LSQSOperations } from "@m3l-automation/m3l-common/aws";
 *
 * const sqsOperations = new M3LSQSOperations(script.aws.clients.sqs);
 * const messages = await sqsOperations.receive(queueUrl, { maxMessages: 10 });
 * ```
 */
export class M3LSQSOperations {
  /**
   * Creates a new `M3LSQSOperations` wrapping the given raw SDK client.
   *
   * @param client - A constructed `SQSClient` (e.g. `script.aws.clients.sqs`).
   */
  constructor(private readonly client: SQSClient) {}

  /**
   * Receives up to {@link M3LSQSReceiveOptions.maxMessages} messages from a
   * queue via a single long-poll `ReceiveMessage` call. Not retried — an
   * empty result is valid (the long poll absorbed transient emptiness).
   *
   * @param queueUrl - The queue to receive from.
   * @param options - Receive tuning; see {@link M3LSQSReceiveOptions}.
   * @throws {@link M3LSQSOperationError} if the underlying `ReceiveMessage` call fails.
   */
  receive(
    queueUrl: string,
    options?: M3LSQSReceiveOptions,
  ): Promise<readonly M3LSQSReceivedMessage[]> {
    throw new M3LSQSOperationError(
      `receive: not yet implemented (queueUrl=${queueUrl}, options=${JSON.stringify(options)}) — see docs/reference/aws/sqs.md`,
    );
  }

  /**
   * Publishes up to 10 entries in one `SendMessageBatch` request, retrying
   * throttling/network failures internally. Per-entry failures inside a
   * successful response are returned via
   * {@link M3LSQSBatchResult.failed}, never thrown.
   *
   * @param queueUrl - The destination queue.
   * @param entries - Up to 10 entries with unique `id`s; see {@link M3LSQSSendEntry}.
   * @throws {@link M3LSQSOperationError} if the batch is malformed (\>10
   *   entries, duplicate ids) or the whole request fails after retries.
   */
  sendBatch(
    queueUrl: string,
    entries: readonly M3LSQSSendEntry[],
  ): Promise<M3LSQSBatchResult<M3LSQSSendEntry>> {
    throw new M3LSQSOperationError(
      `sendBatch: not yet implemented (queueUrl=${queueUrl}, entries=${entries.length}) — see docs/reference/aws/sqs.md`,
    );
  }

  /**
   * Deletes up to 10 messages in one `DeleteMessageBatch` request, retrying
   * throttling/network failures internally. Per-entry failures inside a
   * successful response are returned via
   * {@link M3LSQSBatchResult.failed}, never thrown.
   *
   * @param queueUrl - The queue to delete from.
   * @param entries - Up to 10 entries with unique `id`s; see {@link M3LSQSDeleteEntry}.
   * @throws {@link M3LSQSOperationError} if the batch is malformed (\>10
   *   entries, duplicate ids) or the whole request fails after retries.
   */
  deleteBatch(
    queueUrl: string,
    entries: readonly M3LSQSDeleteEntry[],
  ): Promise<M3LSQSBatchResult<M3LSQSDeleteEntry>> {
    throw new M3LSQSOperationError(
      `deleteBatch: not yet implemented (queueUrl=${queueUrl}, entries=${entries.length}) — see docs/reference/aws/sqs.md`,
    );
  }

  /**
   * Clears a queue's contents via `PurgeQueue`. Not retried — SQS enforces a
   * 60-second cooldown between purges (`PurgeQueueInProgress`), which is a
   * business condition, not a transient fault.
   *
   * @param queueUrl - The queue to purge.
   * @throws {@link M3LSQSOperationError} if the underlying `PurgeQueue` call
   *   fails, including a cooldown rejection.
   */
  purgeQueue(queueUrl: string): Promise<void> {
    throw new M3LSQSOperationError(
      `purgeQueue: not yet implemented (queueUrl=${queueUrl}) — see docs/reference/aws/sqs.md`,
    );
  }
}
