/**
 * `aws/sqs/client` — {@link M3LSQSOperations}, a typed wrapper over a raw
 * `SQSClient` so callers never import `@aws-sdk/client-sqs` command classes
 * directly. See ADR-0026 for why this module exists and why it is
 * permitted to import `core/polling` (Zone A, ADR-0009).
 *
 * @packageDocumentation
 */

import type {
  BatchResultErrorEntry,
  DeleteMessageBatchRequestEntry,
  Message,
  MessageAttributeValue,
  MessageSystemAttributeName,
  SendMessageBatchRequestEntry,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DeleteMessageBatchCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";

import { M3LSQSOperationError } from "./error.js";
import type {
  M3LSQSBatchFailure,
  M3LSQSBatchResult,
  M3LSQSDeleteEntry,
  M3LSQSReceiveDeduplicationMode,
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
  M3LSQSRedriveDecision,
  M3LSQSRedriveOptions,
  M3LSQSRedriveProcessor,
  M3LSQSRedriveResult,
  M3LSQSSendEntry,
} from "./types.js";
import {
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../../core/polling/index.js";

/** The SQS API cap on entries per `SendMessageBatch`/`DeleteMessageBatch` call. */
const MAX_BATCH_ENTRIES = 10;

/** Default `MaxNumberOfMessages` for {@link M3LSQSOperations.receive} when omitted. */
const DEFAULT_MAX_MESSAGES = 10;

/** Default `WaitTimeSeconds` for {@link M3LSQSOperations.receive} when omitted. */
const DEFAULT_WAIT_TIME_SECONDS = 20;

/**
 * Extracts `StringValue`-only message attributes from an SDK response's
 * `MessageAttributes` map, skipping any entry whose `StringValue` is absent
 * (a binary or list-valued attribute) rather than coercing it to `""`.
 *
 * @param attributes - The SDK's raw `MessageAttributes` map, if present.
 * @returns A plain string-to-string record, or `undefined` if the input was `undefined`.
 */
function mapMessageAttributes(
  attributes: Record<string, MessageAttributeValue> | undefined,
): Record<string, string> | undefined {
  if (attributes === undefined) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (value.StringValue !== undefined) {
      result[name] = value.StringValue;
    }
  }
  return result;
}

/**
 * Translates one SDK `Message` into a plain {@link M3LSQSReceivedMessage},
 * defaulting missing `MessageId`/`ReceiptHandle`/`Body` to `""` rather than
 * throwing.
 *
 * @param message - One SDK `Message` from a `ReceiveMessage` response.
 * @returns The plain, library-owned message shape.
 */
function mapReceivedMessage(message: Message): M3LSQSReceivedMessage {
  const messageAttributes = mapMessageAttributes(message.MessageAttributes);
  const attributes = message.Attributes;
  return {
    messageId: message.MessageId ?? "",
    receiptHandle: message.ReceiptHandle ?? "",
    body: message.Body ?? "",
    ...(message.MD5OfBody !== undefined && { md5OfBody: message.MD5OfBody }),
    ...(attributes !== undefined && { attributes }),
    ...(messageAttributes !== undefined && { messageAttributes }),
  };
}

/**
 * Builds the SDK `MessageAttributes` map for a send-batch entry from the
 * plain string-valued record. The caller (`sendBatch`'s `Entries` mapping)
 * only invokes this once `entry.messageAttributes` is already narrowed
 * non-`undefined`, so this always returns a populated map.
 *
 * @param attributes - The caller's plain message attributes.
 * @returns The SDK's `MessageAttributeValue` map.
 */
function toSdkMessageAttributes(
  attributes: Readonly<Record<string, string>>,
): Record<string, MessageAttributeValue> {
  const result: Record<string, MessageAttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    result[name] = { DataType: "String", StringValue: value };
  }
  return result;
}

/**
 * Validates a batch request before any AWS call: at most 10 entries, and
 * every `id` unique within the batch.
 *
 * @param entries - The caller's batch entries.
 * @param operation - The operation name, for the error message (`"sendBatch"` or `"deleteBatch"`).
 * @throws {@link M3LSQSOperationError} if the batch is too large or has duplicate ids.
 */
function assertValidBatch(
  entries: readonly { readonly id: string }[],
  operation: string,
): void {
  if (entries.length > MAX_BATCH_ENTRIES) {
    throw new M3LSQSOperationError(
      `${operation}: at most ${String(MAX_BATCH_ENTRIES)} entries are allowed per batch, got ${String(entries.length)}`,
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new M3LSQSOperationError(
        `${operation}: duplicate entry id "${entry.id}" within batch`,
      );
    }
    seen.add(entry.id);
  }
}

/** Optional fields of a `ReceiveMessageCommand` input, present only when supplied. */
interface ReceiveCommandOptionalFields {
  readonly VisibilityTimeout?: number;
  readonly MessageAttributeNames?: string[];
  readonly MessageSystemAttributeNames?: MessageSystemAttributeName[];
}

/**
 * Builds the optional fields of a `ReceiveMessageCommand` input, each
 * conditionally present only when the caller supplied the corresponding
 * option (`exactOptionalPropertyTypes`).
 *
 * @param options - Receive tuning; see {@link M3LSQSReceiveOptions}.
 * @returns The optional-field subset of the SDK command input.
 */
function buildReceiveOptionalFields(
  options: M3LSQSReceiveOptions | undefined,
): ReceiveCommandOptionalFields {
  const messageAttributeNames = options?.messageAttributeNames;
  const systemAttributeNames = options?.systemAttributeNames;
  return {
    ...(options?.visibilityTimeout !== undefined && {
      VisibilityTimeout: options.visibilityTimeout,
    }),
    ...(messageAttributeNames !== undefined && {
      MessageAttributeNames: [...messageAttributeNames],
    }),
    ...(systemAttributeNames !== undefined && {
      MessageSystemAttributeNames: [
        ...systemAttributeNames,
      ] as MessageSystemAttributeName[],
    }),
  };
}

/**
 * Builds the `ReceiveMessageCommand` input from a queue URL and the caller's
 * {@link M3LSQSReceiveOptions}.
 *
 * @param queueUrl - The queue to receive from.
 * @param options - Receive tuning; see {@link M3LSQSReceiveOptions}.
 * @returns The SDK `ReceiveMessageCommandInput`-shaped object.
 */
function buildReceiveCommandInput(
  queueUrl: string,
  options: M3LSQSReceiveOptions | undefined,
): {
  QueueUrl: string;
  MaxNumberOfMessages: number;
  WaitTimeSeconds: number;
} & ReceiveCommandOptionalFields {
  return {
    QueueUrl: queueUrl,
    MaxNumberOfMessages: options?.maxMessages ?? DEFAULT_MAX_MESSAGES,
    WaitTimeSeconds: options?.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS,
    ...buildReceiveOptionalFields(options),
  };
}

/**
 * Joins an SDK batch response's `Failed[]` back to the caller's original
 * input entries, so every input entry lands in exactly one of `successful`
 * or `failed`.
 *
 * @typeParam T - The caller's entry type (`M3LSQSSendEntry` or `M3LSQSDeleteEntry`).
 * @param operation - The operation name, for the error message (`"sendBatch"` or `"deleteBatch"`).
 * @param entries - The caller's original input entries, in order.
 * @param failed - The SDK response's `Failed[]` (or `undefined`).
 * @returns The joined `{ successful, failed }` batch result.
 * @throws {@link M3LSQSOperationError} if `Failed[]` contains an entry whose
 *   `Id` is `undefined` or does not match any input entry's `id` — an
 *   anomalous SDK response that would otherwise be silently dropped rather
 *   than surfaced.
 */
function joinBatchResult<T extends { readonly id: string }>(
  operation: string,
  entries: readonly T[],
  failed: readonly BatchResultErrorEntry[] | undefined,
): M3LSQSBatchResult<T> {
  const failedList = failed ?? [];
  const failedById = new Map(failedList.map((f) => [f.Id, f]));
  const successful: T[] = [];
  const failures: M3LSQSBatchFailure<T>[] = [];
  const matchedIds = new Set<string>();
  for (const entry of entries) {
    const failure = failedById.get(entry.id);
    if (failure !== undefined) {
      matchedIds.add(entry.id);
      failures.push({
        entry,
        code: failure.Code ?? "",
        senderFault: failure.SenderFault ?? false,
        ...(failure.Message !== undefined && { message: failure.Message }),
      });
    } else {
      successful.push(entry);
    }
  }

  // A Failed[] entry with no matching input entry id (including Id:
  // undefined, which can never match a real caller id) would otherwise be
  // silently dropped — it lands in neither `successful` nor `failed`. Treat
  // that as a request-level failure rather than swallowing a real report.
  const orphaned = failedList.filter(
    (f) => f.Id === undefined || !matchedIds.has(f.Id),
  );
  if (orphaned.length > 0) {
    throw new M3LSQSOperationError(
      `${operation}: response contained ${String(orphaned.length)} Failed[] entries with no matching input entry id`,
      { cause: orphaned },
    );
  }

  return { successful, failed: failures };
}

/** The outcome of partitioning one received page's per-message {@link M3LSQSRedriveDecision}s. */
interface RedrivePagePartition {
  /** Entries queued for `sendBatch` from `"move"` decisions, in receive order. */
  readonly moveEntries: M3LSQSSendEntry[];
  /** Maps each move entry's `id` back to its originating received message (for `receiptHandle` lookup). */
  readonly entryIdToMessage: ReadonlyMap<string, M3LSQSReceivedMessage>;
  /** Messages with a `"drop"` decision, in receive order. */
  readonly dropMessages: M3LSQSReceivedMessage[];
  /** Count of `"retry"` decisions on this page. */
  readonly retried: number;
  /** Count of messages skipped by deduplication on this page. */
  readonly deduplicated: number;
}

/**
 * Awaits `processMessage` once per message in `page`, in receive order, and
 * partitions the resulting decisions into move/drop/retry groups. Skips
 * `processMessage` entirely (counting `deduplicated` instead) for a message
 * whose non-empty `messageId` is already present in `seenMessageIds`
 * (deduplication `"messageId"` only) — an empty `messageId` is never treated
 * as a duplicate.
 *
 * @param page - One page of received messages, in order.
 * @param processMessage - The caller's per-message decision callback.
 * @param deduplication - The deduplication mode; see {@link M3LSQSReceiveDeduplicationMode}.
 * @param seenMessageIds - The `Set` of non-empty message ids already processed this `redrive` call (mutated in place).
 * @returns The partitioned decisions for this page.
 */
async function partitionRedrivePage(
  page: readonly M3LSQSReceivedMessage[],
  processMessage: M3LSQSRedriveProcessor,
  deduplication: M3LSQSReceiveDeduplicationMode | undefined,
  seenMessageIds: Set<string>,
): Promise<RedrivePagePartition> {
  const moveEntries: M3LSQSSendEntry[] = [];
  const entryIdToMessage = new Map<string, M3LSQSReceivedMessage>();
  const dropMessages: M3LSQSReceivedMessage[] = [];
  let retried = 0;
  let deduplicated = 0;

  for (const message of page) {
    if (deduplication === "messageId" && message.messageId !== "") {
      if (seenMessageIds.has(message.messageId)) {
        deduplicated += 1;
        continue;
      }
      seenMessageIds.add(message.messageId);
    }

    const decision: M3LSQSRedriveDecision = await processMessage(message);
    switch (decision.action) {
      case "move": {
        moveEntries.push(decision.entry);
        entryIdToMessage.set(decision.entry.id, message);
        break;
      }
      case "drop": {
        dropMessages.push(message);
        break;
      }
      case "retry": {
        retried += 1;
        break;
      }
      default: {
        // Read only `action` for the message — never the whole `decision`
        // object, which may carry caller-smuggled fields at runtime if a
        // caller bypasses the M3LSQSRedriveDecision type. This cast is a
        // separate read of the same value purely for message construction;
        // it does not affect the exhaustiveness check below.
        const action = (decision as { readonly action?: unknown }).action;
        // Exhaustiveness check only — never chain `decision` (or `cause`)
        // through this throw. The type system already guarantees this
        // branch is unreachable for a well-typed caller; it only fires when
        // a caller bypasses `M3LSQSRedriveDecision` at runtime, so there is
        // no genuine underlying exception to chain, and doing so would leak
        // whatever fields the malformed value carried (e.g. a smuggled
        // message body) through anything that serializes the error.
        const _exhaustive: never = decision;
        throw new M3LSQSOperationError(
          `redrive: unhandled decision action ${String(action)}`,
        );
      }
    }
  }

  return { moveEntries, entryIdToMessage, dropMessages, retried, deduplicated };
}

/**
 * Builds the drop-path `deleteBatch` entries for a page's `"drop"`
 * decisions, synthesizing each entry's `id` from its page-local array index
 * rather than the message's `messageId` (which may be empty) — kept in a
 * separate id space from the move-path delete entries so the two never
 * collide within one `redrive` page.
 *
 * @param dropMessages - Messages with a `"drop"` decision, in order.
 * @returns The `deleteBatch` entries for the drop path.
 */
function buildDropDeleteEntries(
  dropMessages: readonly M3LSQSReceivedMessage[],
): M3LSQSDeleteEntry[] {
  return dropMessages.map((message, index) => ({
    id: String(index),
    receiptHandle: message.receiptHandle,
  }));
}

/**
 * Builds the post-move `deleteBatch` entries for a `sendBatch` response's
 * successful entries, matching each back to its originating received
 * message's `receiptHandle` via `entryIdToMessage`.
 *
 * @param successful - The `sendBatch` response's successfully-sent entries.
 * @param entryIdToMessage - Maps each move entry's `id` to its originating message.
 * @returns The `deleteBatch` entries for the post-move delete.
 * @throws {@link M3LSQSOperationError} if a successful entry's `id` has no
 *   matching message — unreachable in practice, since every id in
 *   `successful` originates from the same page's `moveEntries`, which is
 *   what populated `entryIdToMessage` in the first place.
 */
function buildMoveDeleteEntries(
  successful: readonly M3LSQSSendEntry[],
  entryIdToMessage: ReadonlyMap<string, M3LSQSReceivedMessage>,
): M3LSQSDeleteEntry[] {
  return successful.map((entry) => {
    const message = entryIdToMessage.get(entry.id);
    if (message === undefined) {
      /* istanbul ignore next -- unreachable: entry.id always originates
         from this same page's moveEntries, whose ids were just used to
         populate entryIdToMessage. */
      throw new M3LSQSOperationError(
        `redrive: sendBatch successful entry id "${entry.id}" has no matching received message`,
      );
    }
    return { id: entry.id, receiptHandle: message.receiptHandle };
  });
}

/**
 * Clamps one page's `receive` request to at most the remaining
 * `messageLimit` budget, leaving the caller-supplied (or default) per-page
 * cap untouched when no `messageLimit` applies or the budget is not yet
 * exhausted.
 *
 * @param perPageMax - The per-page cap from `receiveOptions.maxMessages` (or the `receive` default).
 * @param messageLimit - The overall `redrive` budget, if set.
 * @param received - Messages already received this `redrive` call.
 * @returns The clamped `maxMessages` for this page's `receive` call.
 */
function clampPageMaxMessages(
  perPageMax: number,
  messageLimit: number | undefined,
  received: number,
): number {
  if (messageLimit === undefined) {
    return perPageMax;
  }
  return Math.min(perPageMax, messageLimit - received);
}

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
  readonly #runner: M3LRetryRunner;

  /**
   * Creates a new `M3LSQSOperations` wrapping the given raw SDK client.
   *
   * @param client - A constructed `SQSClient` (e.g. `script.aws.clients.sqs`).
   */
  constructor(private readonly client: SQSClient) {
    this.#runner = new M3LRetryRunner(M3LPollingPolicies.sqsBatchSend());
  }

  /**
   * Receives up to {@link M3LSQSReceiveOptions.maxMessages} messages from a
   * queue via a single long-poll `ReceiveMessage` call. Not retried — an
   * empty result is valid (the long poll absorbed transient emptiness).
   *
   * @param queueUrl - The queue to receive from.
   * @param options - Receive tuning; see {@link M3LSQSReceiveOptions}.
   * @throws {@link M3LSQSOperationError} if the underlying `ReceiveMessage` call fails.
   */
  async receive(
    queueUrl: string,
    options?: M3LSQSReceiveOptions,
  ): Promise<readonly M3LSQSReceivedMessage[]> {
    try {
      const response = await this.client.send(
        new ReceiveMessageCommand(buildReceiveCommandInput(queueUrl, options)),
      );
      return (response.Messages ?? []).map(mapReceivedMessage);
    } catch (cause) {
      throw new M3LSQSOperationError(
        `receive: ReceiveMessage failed for queueUrl=${queueUrl}`,
        { cause },
      );
    }
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
  async sendBatch(
    queueUrl: string,
    entries: readonly M3LSQSSendEntry[],
  ): Promise<M3LSQSBatchResult<M3LSQSSendEntry>> {
    assertValidBatch(entries, "sendBatch");

    const Entries: SendMessageBatchRequestEntry[] = entries.map((entry) => ({
      Id: entry.id,
      MessageBody: entry.body,
      ...(entry.delaySeconds !== undefined && {
        DelaySeconds: entry.delaySeconds,
      }),
      ...(entry.messageGroupId !== undefined && {
        MessageGroupId: entry.messageGroupId,
      }),
      ...(entry.messageDeduplicationId !== undefined && {
        MessageDeduplicationId: entry.messageDeduplicationId,
      }),
      ...(entry.messageAttributes !== undefined && {
        MessageAttributes: toSdkMessageAttributes(entry.messageAttributes),
      }),
    }));

    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries }),
        ),
      );
      return joinBatchResult("sendBatch", entries, response.Failed);
    } catch (cause) {
      // joinBatchResult can itself throw a specific M3LSQSOperationError
      // (an orphaned Failed[] entry) from inside this try block — forward it
      // unchanged rather than re-wrapping it under the generic "request
      // failed" message below, which would be misleading (the request
      // succeeded; the response shape was anomalous).
      if (cause instanceof M3LSQSOperationError) {
        throw cause;
      }
      throw new M3LSQSOperationError(
        `sendBatch: SendMessageBatch failed for queueUrl=${queueUrl}`,
        { cause },
      );
    }
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
  async deleteBatch(
    queueUrl: string,
    entries: readonly M3LSQSDeleteEntry[],
  ): Promise<M3LSQSBatchResult<M3LSQSDeleteEntry>> {
    assertValidBatch(entries, "deleteBatch");

    const Entries: DeleteMessageBatchRequestEntry[] = entries.map((entry) => ({
      Id: entry.id,
      ReceiptHandle: entry.receiptHandle,
    }));

    try {
      const response = await this.#runner.run(() =>
        this.client.send(
          new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries }),
        ),
      );
      return joinBatchResult("deleteBatch", entries, response.Failed);
    } catch (cause) {
      // See the equivalent guard in sendBatch: joinBatchResult's own
      // M3LSQSOperationError (orphaned Failed[] entry) must not be
      // re-wrapped under the generic "request failed" message below.
      if (cause instanceof M3LSQSOperationError) {
        throw cause;
      }
      throw new M3LSQSOperationError(
        `deleteBatch: DeleteMessageBatch failed for queueUrl=${queueUrl}`,
        { cause },
      );
    }
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
  async purgeQueue(queueUrl: string): Promise<void> {
    try {
      await this.client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    } catch (cause) {
      throw new M3LSQSOperationError(
        `purgeQueue: PurgeQueue failed for queueUrl=${queueUrl}`,
        { cause },
      );
    }
  }

  /**
   * Drains `sourceQueueUrl` page by page (via {@link receive}), invoking
   * `processMessage` once per received message to decide its
   * {@link M3LSQSRedriveDecision}, and applies that decision via
   * {@link sendBatch}/{@link deleteBatch} — see the `redrive` section of
   * `docs/reference/aws/sqs.md` for the full per-decision contract.
   *
   * Composed entirely from this class's own `receive`/`sendBatch`/
   * `deleteBatch` methods: it issues no raw SDK call of its own, so it
   * inherits their retry/mapping/error-wrapping behavior rather than
   * duplicating it.
   *
   * @param sourceQueueUrl - The queue to drain.
   * @param destinationQueueUrl - The queue `"move"`-decided entries are sent to.
   * @param processMessage - Decides each received message's outcome; see {@link M3LSQSRedriveProcessor}.
   * @param options - Paging/limit/deduplication tuning; see {@link M3LSQSRedriveOptions}.
   * @throws {@link M3LSQSOperationError} whatever `receive`/`sendBatch`/
   *   `deleteBatch` throw, propagated unchanged — `redrive` adds no new
   *   error handling of its own. A throw from `processMessage` (of any
   *   value, not just an `Error`) is also not caught here; it propagates
   *   out of `redrive` immediately, unwrapped.
   */
  async redrive(
    sourceQueueUrl: string,
    destinationQueueUrl: string,
    processMessage: M3LSQSRedriveProcessor,
    options?: M3LSQSRedriveOptions,
  ): Promise<M3LSQSRedriveResult> {
    const messageLimit = options?.messageLimit;
    if (
      messageLimit !== undefined &&
      (messageLimit <= 0 || Number.isNaN(messageLimit))
    ) {
      throw new M3LSQSOperationError(
        `redrive: messageLimit must be a positive number, got ${String(messageLimit)}`,
      );
    }

    let received = 0;
    let moved = 0;
    let dropped = 0;
    let retried = 0;
    let deduplicated = 0;
    const moveFailed: M3LSQSBatchFailure<M3LSQSSendEntry>[] = [];
    const deleteFailed: M3LSQSBatchFailure<M3LSQSDeleteEntry>[] = [];
    const seenMessageIds = new Set<string>();

    for (;;) {
      const outcome = await this.#redrivePage(
        sourceQueueUrl,
        destinationQueueUrl,
        processMessage,
        options,
        messageLimit,
        received,
        seenMessageIds,
      );
      if (outcome.page.length === 0) {
        break;
      }
      received += outcome.page.length;
      moved += outcome.moved;
      dropped += outcome.dropped;
      retried += outcome.retried;
      deduplicated += outcome.deduplicated;
      moveFailed.push(...outcome.moveFailed);
      deleteFailed.push(...outcome.deleteFailed);

      if (messageLimit !== undefined && received >= messageLimit) {
        break;
      }
    }

    return {
      received,
      moved,
      dropped,
      retried,
      deduplicated,
      moveFailed,
      deleteFailed,
    };
  }

  /**
   * Receives one `redrive` page from `sourceQueueUrl`, capping `maxMessages`
   * at the smaller of the caller's per-page cap and the remaining
   * `messageLimit` budget (via {@link clampPageMaxMessages}).
   *
   * @param sourceQueueUrl - The queue to drain.
   * @param options - The caller's {@link M3LSQSRedriveOptions}.
   * @param messageLimit - The overall `redrive` budget, if set (mirrors `options?.messageLimit`).
   * @param received - Messages already received this `redrive` call, for clamping this page's cap.
   */
  async #receiveRedrivePage(
    sourceQueueUrl: string,
    options: M3LSQSRedriveOptions | undefined,
    messageLimit: number | undefined,
    received: number,
  ): Promise<readonly M3LSQSReceivedMessage[]> {
    return this.receive(sourceQueueUrl, {
      ...options?.receiveOptions,
      maxMessages: clampPageMaxMessages(
        options?.receiveOptions?.maxMessages ?? DEFAULT_MAX_MESSAGES,
        messageLimit,
        received,
      ),
    });
  }

  /**
   * Receives and fully processes one `redrive` page: a `receive` call via
   * `#receiveRedrivePage`, partitioned via `partitionRedrivePage`, then
   * applied via `#applyMoveDecisions`/`#applyDropDecisions`. An empty page
   * (`page.length === 0`) short-circuits with an all-zero outcome, signaling
   * drain-complete to the caller's loop.
   *
   * @param sourceQueueUrl - The queue to drain.
   * @param destinationQueueUrl - The queue `"move"`-decided entries are sent to.
   * @param processMessage - Decides each received message's outcome.
   * @param options - The caller's {@link M3LSQSRedriveOptions}.
   * @param messageLimit - The overall `redrive` budget, if set (mirrors `options?.messageLimit`).
   * @param received - Messages already received this `redrive` call, for clamping this page's cap.
   * @param seenMessageIds - The deduplication `Set`, scoped to and mutated across the whole `redrive` call.
   */
  async #redrivePage(
    sourceQueueUrl: string,
    destinationQueueUrl: string,
    processMessage: M3LSQSRedriveProcessor,
    options: M3LSQSRedriveOptions | undefined,
    messageLimit: number | undefined,
    received: number,
    seenMessageIds: Set<string>,
  ): Promise<{
    readonly page: readonly M3LSQSReceivedMessage[];
    readonly moved: number;
    readonly dropped: number;
    readonly retried: number;
    readonly deduplicated: number;
    readonly moveFailed: readonly M3LSQSBatchFailure<M3LSQSSendEntry>[];
    readonly deleteFailed: readonly M3LSQSBatchFailure<M3LSQSDeleteEntry>[];
  }> {
    const page = await this.#receiveRedrivePage(
      sourceQueueUrl,
      options,
      messageLimit,
      received,
    );
    if (page.length === 0) {
      return {
        page,
        moved: 0,
        dropped: 0,
        retried: 0,
        deduplicated: 0,
        moveFailed: [],
        deleteFailed: [],
      };
    }

    const partition = await partitionRedrivePage(
      page,
      processMessage,
      options?.deduplication,
      seenMessageIds,
    );
    const moveOutcome = await this.#applyMoveDecisions(
      sourceQueueUrl,
      destinationQueueUrl,
      partition.moveEntries,
      partition.entryIdToMessage,
    );
    const dropOutcome = await this.#applyDropDecisions(
      sourceQueueUrl,
      partition.dropMessages,
    );

    return {
      page,
      moved: moveOutcome.moved,
      dropped: dropOutcome.dropped,
      retried: partition.retried,
      deduplicated: partition.deduplicated,
      moveFailed: moveOutcome.moveFailed,
      deleteFailed: [...moveOutcome.deleteFailed, ...dropOutcome.deleteFailed],
    };
  }

  /**
   * Sends a page's `"move"`-decided entries to `destinationQueueUrl`, then
   * deletes each successfully-sent entry's originating message from
   * `sourceQueueUrl` (matched back via {@link RedrivePagePartition.entryIdToMessage}).
   * A no-op (all-zero outcome) when `moveEntries` is empty.
   *
   * @param sourceQueueUrl - The queue to delete a successfully-moved message from.
   * @param destinationQueueUrl - The queue to send `moveEntries` to.
   * @param moveEntries - This page's `"move"`-decided send entries.
   * @param entryIdToMessage - Maps each move entry's `id` to its originating message.
   */
  async #applyMoveDecisions(
    sourceQueueUrl: string,
    destinationQueueUrl: string,
    moveEntries: readonly M3LSQSSendEntry[],
    entryIdToMessage: ReadonlyMap<string, M3LSQSReceivedMessage>,
  ): Promise<{
    readonly moved: number;
    readonly moveFailed: readonly M3LSQSBatchFailure<M3LSQSSendEntry>[];
    readonly deleteFailed: readonly M3LSQSBatchFailure<M3LSQSDeleteEntry>[];
  }> {
    if (moveEntries.length === 0) {
      return { moved: 0, moveFailed: [], deleteFailed: [] };
    }

    const sendResult = await this.sendBatch(destinationQueueUrl, moveEntries);
    const moveDeleteEntries = buildMoveDeleteEntries(
      sendResult.successful,
      entryIdToMessage,
    );
    if (moveDeleteEntries.length === 0) {
      return { moved: 0, moveFailed: sendResult.failed, deleteFailed: [] };
    }

    const deleteResult = await this.deleteBatch(
      sourceQueueUrl,
      moveDeleteEntries,
    );
    return {
      moved: deleteResult.successful.length,
      moveFailed: sendResult.failed,
      deleteFailed: deleteResult.failed,
    };
  }

  /**
   * Deletes a page's `"drop"`-decided messages directly from
   * `sourceQueueUrl`, no send. A no-op (all-zero outcome) when
   * `dropMessages` is empty.
   *
   * @param sourceQueueUrl - The queue to delete the dropped messages from.
   * @param dropMessages - This page's `"drop"`-decided messages, in order.
   */
  async #applyDropDecisions(
    sourceQueueUrl: string,
    dropMessages: readonly M3LSQSReceivedMessage[],
  ): Promise<{
    readonly dropped: number;
    readonly deleteFailed: readonly M3LSQSBatchFailure<M3LSQSDeleteEntry>[];
  }> {
    if (dropMessages.length === 0) {
      return { dropped: 0, deleteFailed: [] };
    }

    const deleteResult = await this.deleteBatch(
      sourceQueueUrl,
      buildDropDeleteEntries(dropMessages),
    );
    return {
      dropped: deleteResult.successful.length,
      deleteFailed: deleteResult.failed,
    };
  }
}
