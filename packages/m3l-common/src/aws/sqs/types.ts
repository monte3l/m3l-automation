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

/** The result of {@link M3LSQSOperations.listQueues}: one page of queue URLs. */
export interface M3LSQSListQueuesResult {
  /** Queue URLs on this page. */
  readonly queueUrls: readonly string[];
  /** Present when another page is available; pass back as `nextToken` to continue. */
  readonly nextToken?: string;
}

/** Options for {@link M3LSQSOperations.listQueues}. */
export interface M3LSQSListQueuesOptions {
  /** Filters returned queue URLs to those whose name starts with this prefix. */
  readonly queueNamePrefix?: string;
  /** Continues a previous page; pass back the `nextToken` from a prior result. */
  readonly nextToken?: string;
  /** Caps the number of queue URLs returned on this page. */
  readonly maxResults?: number;
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

/**
 * The outcome {@link M3LSQSRedriveProcessor} returns for one message: send it
 * on to the destination queue (`"move"`), delete it from the source queue
 * with no send (`"drop"`), or leave it untouched (`"retry"`).
 */
export type M3LSQSRedriveDecision =
  | { readonly action: "move"; readonly entry: M3LSQSSendEntry }
  | { readonly action: "drop" }
  | { readonly action: "retry" };

/**
 * The per-message callback passed to {@link M3LSQSOperations.redrive},
 * deciding a {@link M3LSQSRedriveDecision} for one
 * {@link M3LSQSReceivedMessage}. May return synchronously or as a `Promise`;
 * `redrive` awaits it once per message, in receive order.
 */
export type M3LSQSRedriveProcessor = (
  message: M3LSQSReceivedMessage,
) => M3LSQSRedriveDecision | Promise<M3LSQSRedriveDecision>;

/**
 * The deduplication strategy for {@link M3LSQSOperations.redrive}, set via
 * {@link M3LSQSRedriveOptions.deduplication}. `"none"` (the default) applies
 * no deduplication; `"messageId"` skips a message whose non-empty
 * `messageId` has already been seen within the same `redrive` call.
 */
export type M3LSQSReceiveDeduplicationMode = "none" | "messageId";

/** Options for {@link M3LSQSOperations.redrive}. */
export interface M3LSQSRedriveOptions {
  /**
   * Caps the total number of messages `redrive` receives across every page
   * combined; omit to drain until a `receive` call returns an empty page. A
   * value `<= 0` (or `NaN`) is a caller/config error, not a legitimate
   * "do nothing" request — `redrive` throws {@link M3LSQSOperationError}
   * before issuing any call, rather than silently returning an all-zero-count
   * {@link M3LSQSRedriveResult}.
   */
  readonly messageLimit?: number;
  /**
   * Tunes each page's underlying {@link M3LSQSOperations.receive} call; its
   * own `maxMessages` bounds one page (further clamped to the remaining
   * {@link messageLimit} budget on the final page).
   */
  readonly receiveOptions?: M3LSQSReceiveOptions;
  /** Deduplication strategy; see {@link M3LSQSReceiveDeduplicationMode}. Defaults to `"none"`. */
  readonly deduplication?: M3LSQSReceiveDeduplicationMode;
}

/**
 * The parsed redrive policy attached to an SQS queue. SQS transmits this as
 * a JSON string over the wire; {@link M3LSQSOperations.getQueueAttributes}
 * parses and shape-validates it before returning, so callers never handle raw
 * JSON or a `SyntaxError`.
 */
export interface M3LSQSRedrivePolicy {
  /** The ARN of the dead-letter queue that receives messages exceeding `maxReceiveCount`. */
  readonly deadLetterTargetArn: string;
  /** The number of times a message must be received before it is moved to the dead-letter queue. */
  readonly maxReceiveCount: number;
}

/**
 * The three values SQS accepts for `redrivePermission` in a redrive allow
 * policy. Tracked as a closed union so adding a member forces a compile error
 * at the runtime `Record<M3LSQSRedrivePermission, true>` guard.
 */
export type M3LSQSRedrivePermission = "allowAll" | "denyAll" | "byQueue";

/**
 * The parsed redrive allow policy attached to an SQS queue, controlling which
 * source queues may use this queue as a dead-letter target. SQS transmits this
 * as a JSON string; {@link M3LSQSOperations.getQueueAttributes} parses and
 * shape-validates it before returning.
 */
export interface M3LSQSRedriveAllowPolicy {
  /** Controls which source queues may target this queue as their dead-letter queue. */
  readonly redrivePermission: M3LSQSRedrivePermission;
  /**
   * The ARNs of the source queues permitted to use this queue as a
   * dead-letter target, when `redrivePermission` is `"byQueue"`. Absent
   * (key omitted) when `redrivePermission` is `"allowAll"` or `"denyAll"`.
   */
  readonly sourceQueueArns?: readonly string[];
}

/**
 * The resolved queue-level attributes returned by
 * {@link M3LSQSOperations.getQueueAttributes}. SQS reports every attribute as
 * a string over the wire; this type is the converted form after parsing and
 * type-narrowing.
 */
export interface M3LSQSQueueAttributes {
  /**
   * Approximate number of messages available for retrieval from the queue.
   * SQS reports this as a numeric string; the wrapper parses it to a finite
   * `number` and throws {@link M3LSQSOperationError} if it cannot.
   */
  readonly approximateNumberOfMessages: number;
  /**
   * Approximate number of messages currently in flight — received by a
   * consumer but not yet deleted or returned to the queue. SQS reports this
   * as a numeric string; the wrapper parses it to a finite `number` and
   * throws {@link M3LSQSOperationError} if it cannot.
   */
  readonly approximateNumberOfMessagesNotVisible: number;
  /**
   * Approximate number of messages waiting to be delivered to consumers due
   * to a per-message or per-queue delivery delay. SQS reports this as a
   * numeric string; the wrapper parses it to a finite `number` and throws
   * {@link M3LSQSOperationError} if it cannot.
   */
  readonly approximateNumberOfMessagesDelayed: number;
  /** The ARN of the queue (e.g. `arn:aws:sqs:<region>:<account>:<name>`). */
  readonly queueArn: string;
  /**
   * Whether the queue is a FIFO queue. SQS omits `FifoQueue` entirely for
   * standard queues; an absent attribute maps to `false`.
   */
  readonly fifoQueue: boolean;
  /**
   * The redrive policy configured on this queue, parsed from the wire JSON.
   * Absent when no redrive policy is set; the key is omitted from the
   * returned object rather than set to `undefined`.
   */
  readonly redrivePolicy?: M3LSQSRedrivePolicy;
  /**
   * The redrive allow policy configured on this queue, parsed from the wire
   * JSON. Absent when no policy is set; the key is omitted from the returned
   * object rather than set to `undefined`.
   */
  readonly redriveAllowPolicy?: M3LSQSRedriveAllowPolicy;
}

/**
 * The outcome of one {@link M3LSQSOperations.redrive} call. Counters are not
 * guaranteed to be a partition of `received` — see the `redrive` TSDoc for
 * why a send-succeeded-but-delete-failed message counts in neither `moved`
 * nor `dropped`.
 */
export interface M3LSQSRedriveResult {
  /** Total messages pulled across every page. */
  readonly received: number;
  /** Messages whose `"move"` decision both sent and deleted successfully. */
  readonly moved: number;
  /** Messages whose `"drop"` decision deleted successfully. */
  readonly dropped: number;
  /** Messages whose decision was `"retry"` (left untouched). */
  readonly retried: number;
  /** Messages skipped because of a repeated `messageId` (see {@link M3LSQSReceiveDeduplicationMode}). */
  readonly deduplicated: number;
  /** Failed `sendBatch` entries from `"move"` decisions — messages left in the source queue. */
  readonly moveFailed: readonly M3LSQSBatchFailure<M3LSQSSendEntry>[];
  /** Failed `deleteBatch` entries, from either the post-move or the drop path. */
  readonly deleteFailed: readonly M3LSQSBatchFailure<M3LSQSDeleteEntry>[];
}
