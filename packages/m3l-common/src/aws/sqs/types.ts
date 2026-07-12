/**
 * `aws/sqs/types` — plain, library-owned types at the SQS operations
 * boundary. None of these carry an `@aws-sdk/client-sqs` type; every
 * {@link M3LSQSOperations} method translates SDK request/response shapes
 * into these before returning.
 *
 * @packageDocumentation
 */

/**
 * A single message returned by {@link M3LSQSOperations.receive}, with the
 * SDK's optional fields promoted to required where SQS guarantees them.
 */
export interface M3LSQSReceivedMessage {
  /** The message's unique SQS-assigned identifier. */
  readonly messageId: string;
  /** The receipt handle needed to delete or change visibility of this message. */
  readonly receiptHandle: string;
  /** The raw message body, as sent — never JSON-parsed by this module. */
  readonly body: string;
  /** MD5 digest of {@link body}, as reported by SQS. */
  readonly md5OfBody?: string;
  /** SQS system attributes (e.g. `SentTimestamp`), when requested. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** Custom message attributes, when requested (string values only). */
  readonly messageAttributes?: Readonly<Record<string, string>>;
}

/**
 * One entry to publish via {@link M3LSQSOperations.sendBatch}. `id` must be
 * unique within the batch — it is how a `Failed` entry is joined back to
 * this entry in {@link M3LSQSBatchFailure.entry}.
 */
export interface M3LSQSSendEntry {
  /** Caller-assigned identifier, unique within the batch. */
  readonly id: string;
  /** The message body to send. */
  readonly body: string;
  /** Delivery delay in seconds, if the queue allows per-message delay. */
  readonly delaySeconds?: number;
  /** FIFO queues only: the message group id. */
  readonly messageGroupId?: string;
  /** FIFO queues only: the deduplication id. */
  readonly messageDeduplicationId?: string;
  /** Custom message attributes (string values only). */
  readonly messageAttributes?: Readonly<Record<string, string>>;
}

/**
 * One entry to remove via {@link M3LSQSOperations.deleteBatch}. `id` must be
 * unique within the batch, mirroring {@link M3LSQSSendEntry}.
 */
export interface M3LSQSDeleteEntry {
  /** Caller-assigned identifier, unique within the batch. */
  readonly id: string;
  /** The receipt handle of the message to delete. */
  readonly receiptHandle: string;
}

/**
 * A single failed entry from a batch operation, joined back to the caller's
 * original input entry so it can be logged or re-driven without any
 * id bookkeeping on the caller's side.
 *
 * @typeParam T - The caller's entry type; bounded to `{ readonly id: string }`
 *   since joining a failure back to its input entry requires a string `id`
 *   (both {@link M3LSQSSendEntry} and {@link M3LSQSDeleteEntry} satisfy this).
 */
export interface M3LSQSBatchFailure<T extends { readonly id: string }> {
  /** The original input entry (an {@link M3LSQSSendEntry} or {@link M3LSQSDeleteEntry}) that failed. */
  readonly entry: T;
  /** The SQS error code for this entry (e.g. `"InvalidParameterValue"`). */
  readonly code: string;
  /** Whether the failure is attributed to the caller (`true`) or SQS (`false`). */
  readonly senderFault: boolean;
  /** Human-readable failure detail, when SQS provides one. */
  readonly message?: string;
}

/**
 * The result of a batch operation ({@link M3LSQSOperations.sendBatch} or
 * {@link M3LSQSOperations.deleteBatch}): every input entry lands in exactly
 * one of `successful` or `failed`.
 *
 * @typeParam T - The caller's entry type; bounded to `{ readonly id: string }`,
 *   matching {@link M3LSQSBatchFailure}'s bound.
 */
export interface M3LSQSBatchResult<T extends { readonly id: string }> {
  /** Entries SQS accepted. */
  readonly successful: readonly T[];
  /** Entries SQS rejected, each joined back to its original input entry. */
  readonly failed: readonly M3LSQSBatchFailure<T>[];
}

/** Options for {@link M3LSQSOperations.receive}. */
export interface M3LSQSReceiveOptions {
  /** Maximum messages to return in one call (1-10 per the SQS API cap). Default 10. */
  readonly maxMessages?: number;
  /** Long-poll wait time in seconds (0-20 per the SQS API cap). Default 20. */
  readonly waitTimeSeconds?: number;
  /** Visibility timeout (seconds) applied to messages returned by this call. */
  readonly visibilityTimeout?: number;
  /** Custom message attribute names to return; omit for none. */
  readonly messageAttributeNames?: readonly string[];
  /** SQS system attribute names to return; omit for none. */
  readonly systemAttributeNames?: readonly string[];
}
