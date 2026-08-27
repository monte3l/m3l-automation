/**
 * `aws/sqs/messages` — module-private helpers behind
 * {@link M3LSQSOperations.receive}, {@link M3LSQSOperations.sendBatch}, and
 * {@link M3LSQSOperations.deleteBatch}. Extracted from `aws/sqs/client` to
 * keep that file inside the per-file size budget (ADR-0072).
 *
 * This module is **not** part of the public surface: it is not re-exported
 * from `aws/sqs/index` and has no entry in the `exports` map.
 *
 * @packageDocumentation
 */

import type {
  BatchResultErrorEntry,
  Message,
  MessageAttributeValue,
  MessageSystemAttributeName,
} from "@aws-sdk/client-sqs";

import { M3LSQSOperationError } from "./error.js";
import type {
  M3LSQSBatchFailure,
  M3LSQSBatchResult,
  M3LSQSReceiveOptions,
  M3LSQSReceivedMessage,
} from "./types.js";

/** The SQS API cap on entries per `SendMessageBatch`/`DeleteMessageBatch` call. */
const MAX_BATCH_ENTRIES = 10;

/** Default `MaxNumberOfMessages` for {@link M3LSQSOperations.receive} when omitted. */
export const DEFAULT_MAX_MESSAGES = 10;

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
export function mapReceivedMessage(message: Message): M3LSQSReceivedMessage {
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
export function toSdkMessageAttributes(
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
export function assertValidBatch(
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
export function buildReceiveCommandInput(
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
export function joinBatchResult<T extends { readonly id: string }>(
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
