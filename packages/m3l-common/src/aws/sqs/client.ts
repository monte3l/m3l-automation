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
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
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
 * @param entries - The caller's original input entries, in order.
 * @param failed - The SDK response's `Failed[]` (or `undefined`).
 * @returns The joined `{ successful, failed }` batch result.
 */
function joinBatchResult<T extends { readonly id: string }>(
  entries: readonly T[],
  failed: readonly BatchResultErrorEntry[] | undefined,
): M3LSQSBatchResult<T> {
  const failedById = new Map((failed ?? []).map((f) => [f.Id, f]));
  const successful: T[] = [];
  const failures: M3LSQSBatchFailure<T>[] = [];
  for (const entry of entries) {
    const failure = failedById.get(entry.id);
    if (failure !== undefined) {
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
  return { successful, failed: failures };
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
      return joinBatchResult(entries, response.Failed);
    } catch (cause) {
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
      return joinBatchResult(entries, response.Failed);
    } catch (cause) {
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
}
