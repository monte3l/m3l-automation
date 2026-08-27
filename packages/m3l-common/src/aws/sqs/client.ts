/**
 * `aws/sqs/client` — {@link M3LSQSOperations}, a typed wrapper over a raw
 * `SQSClient` so callers never import `@aws-sdk/client-sqs` command classes
 * directly. See ADR-0026 for why this module exists and why it is
 * permitted to import `core/polling` (Zone A, ADR-0009).
 *
 * @packageDocumentation
 */

import type {
  DeleteMessageBatchRequestEntry,
  SendMessageBatchRequestEntry,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";

import {
  GET_QUEUE_ATTRIBUTE_NAMES,
  parseRedriveAllowPolicy,
  parseRedrivePolicy,
  readOptionalAttribute,
  readRequiredAttribute,
  readRequiredCounter,
} from "./attributes.js";
import { M3LSQSOperationError } from "./error.js";
import {
  assertValidBatch,
  buildReceiveCommandInput,
  DEFAULT_MAX_MESSAGES,
  joinBatchResult,
  mapReceivedMessage,
  toSdkMessageAttributes,
} from "./messages.js";
import {
  buildDropDeleteEntries,
  buildMoveDeleteEntries,
  clampPageMaxMessages,
  partitionRedrivePage,
} from "./redrive.js";
import type {
  M3LSQSBatchFailure,
  M3LSQSBatchResult,
  M3LSQSDeleteEntry,
  M3LSQSListQueuesOptions,
  M3LSQSListQueuesResult,
  M3LSQSQueueAttributes,
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
  M3LSQSRedriveOptions,
  M3LSQSRedriveProcessor,
  M3LSQSRedriveResult,
  M3LSQSSendEntry,
} from "./types.js";
import {
  M3LPollingPolicies,
  M3LRetryRunner,
} from "../../core/polling/index.js";

/**
 * Typed operations over a raw SQS `SQSClient`: receive, batch-send,
 * batch-delete, purge, queue listing, and queue-attribute retrieval —
 * translating SDK request/response shapes into the plain types in
 * `aws/sqs/types`. `sendBatch`, `deleteBatch`, and `getQueueAttributes`
 * retry throttling/network failures internally (see
 * {@link M3LSQSOperationError} for how a request-level failure is
 * surfaced); `receive`, `purgeQueue`, and `listQueues` are not retried —
 * see each method's own TSDoc for why.
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
   * Lists queue URLs, one page at a time, via a single `ListQueues` call.
   * Not retried: a single-page read, left to the caller to wrap in their own
   * retry logic if desired — unlike `getQueueAttributes`, this method has no
   * `M3LRetryRunner`, so a throttled call throws immediately rather than
   * retrying internally.
   *
   * `maxResults`, `queueNamePrefix`, and `nextToken` are forwarded to the SDK
   * without a pre-flight validity check; an invalid value (e.g. `maxResults`
   * outside SQS's accepted range) surfaces as an SDK-rejected
   * {@link M3LSQSOperationError} after the round trip, not a pre-flight throw.
   *
   * @param options - `queueNamePrefix` filters by name prefix; `nextToken`
   *   continues a previous page; `maxResults` caps the page size.
   * @throws {@link M3LSQSOperationError} if the underlying `ListQueues` call fails.
   */
  async listQueues(
    options?: M3LSQSListQueuesOptions,
  ): Promise<M3LSQSListQueuesResult> {
    let response;
    try {
      response = await this.client.send(
        new ListQueuesCommand({
          ...(options?.queueNamePrefix !== undefined && {
            QueueNamePrefix: options.queueNamePrefix,
          }),
          ...(options?.nextToken !== undefined && {
            NextToken: options.nextToken,
          }),
          ...(options?.maxResults !== undefined && {
            MaxResults: options.maxResults,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LSQSOperationError("listQueues: ListQueues failed", {
        cause,
      });
    }

    return {
      queueUrls: response.QueueUrls ?? [],
      ...(response.NextToken !== undefined && {
        nextToken: response.NextToken,
      }),
    };
  }

  /**
   * Retrieves the current {@link M3LSQSQueueAttributes} for a queue. Only
   * the seven attributes needed to populate the returned type are requested —
   * never `"All"`. The underlying `GetQueueAttributes` call is retried on
   * throttling/network failures via the same runner as `sendBatch`/`deleteBatch`.
   *
   * @param queueUrl - The queue to inspect.
   * @throws {@link M3LSQSOperationError} if the request fails after retries; if
   *   the successful response carries no `Attributes` map at all; if a required
   *   attribute (`ApproximateNumberOfMessages`, `ApproximateNumberOfMessagesNotVisible`,
   *   `ApproximateNumberOfMessagesDelayed`, or `QueueArn`) is absent; if a counter
   *   is empty, whitespace-only, not an unpadded non-negative decimal integer
   *   string, or does not resolve to a finite number; or if
   *   `RedrivePolicy`/`RedriveAllowPolicy` is
   *   present but its JSON is malformed or does not match the expected shape.
   * @example
   * ```ts
   * import { M3LSQSOperations } from "@m3l-automation/m3l-common/aws";
   *
   * const sqsOperations = new M3LSQSOperations(script.aws.clients.sqs);
   * const attrs = await sqsOperations.getQueueAttributes(queueUrl);
   * console.log(attrs.approximateNumberOfMessages);
   * ```
   */
  async getQueueAttributes(queueUrl: string): Promise<M3LSQSQueueAttributes> {
    let response;
    try {
      response = await this.#runner.run(() =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: [...GET_QUEUE_ATTRIBUTE_NAMES],
          }),
        ),
      );
    } catch (cause) {
      throw new M3LSQSOperationError(
        `getQueueAttributes: GetQueueAttributes failed for queueUrl=${queueUrl}`,
        { cause },
      );
    }

    const attrs = response.Attributes;
    if (attrs === undefined) {
      throw new M3LSQSOperationError(
        `getQueueAttributes: GetQueueAttributes returned no Attributes map for queueUrl=${queueUrl}`,
      );
    }

    const approximateNumberOfMessages = readRequiredCounter(
      attrs,
      "ApproximateNumberOfMessages",
      queueUrl,
    );
    const approximateNumberOfMessagesNotVisible = readRequiredCounter(
      attrs,
      "ApproximateNumberOfMessagesNotVisible",
      queueUrl,
    );
    const approximateNumberOfMessagesDelayed = readRequiredCounter(
      attrs,
      "ApproximateNumberOfMessagesDelayed",
      queueUrl,
    );
    const rawRedrivePolicy = readOptionalAttribute(attrs, "RedrivePolicy");
    const rawRedriveAllowPolicy = readOptionalAttribute(
      attrs,
      "RedriveAllowPolicy",
    );

    return {
      approximateNumberOfMessages,
      approximateNumberOfMessagesNotVisible,
      approximateNumberOfMessagesDelayed,
      queueArn: readRequiredAttribute(attrs, "QueueArn", queueUrl),
      // Strict === "true" is intentional: only an explicit "true" value opts a
      // queue into FIFO mode. SQS omits FifoQueue entirely for standard queues,
      // so any value other than "true" — including an absent attribute — must
      // map to false. Loosening to a truthiness check would risk treating an
      // unexpected non-"true" string as a FIFO queue.
      fifoQueue: readOptionalAttribute(attrs, "FifoQueue") === "true",
      ...(rawRedrivePolicy !== undefined && {
        redrivePolicy: parseRedrivePolicy(rawRedrivePolicy, queueUrl),
      }),
      ...(rawRedriveAllowPolicy !== undefined && {
        redriveAllowPolicy: parseRedriveAllowPolicy(
          rawRedriveAllowPolicy,
          queueUrl,
        ),
      }),
    };
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
   * @throws {@link M3LSQSOperationError} — either propagated unchanged from
   *   `receive`/`sendBatch`/`deleteBatch`, or constructed by `redrive` itself
   *   (with no `cause` chained) for a condition those methods can't detect:
   *   an invalid `messageLimit` (`<= 0` or `NaN`), or — unreachable under the
   *   typed {@link M3LSQSRedriveDecision} contract, but possible if a caller
   *   bypasses types — an unrecognized `processMessage` decision. `redrive`
   *   performs no raw SDK call of its own. A throw from `processMessage` (of
   *   any value, not just an `Error`) is also not caught here; it propagates
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
