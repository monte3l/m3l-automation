/**
 * `aws/sqs/redrive` — module-private helpers behind
 * {@link M3LSQSOperations.redrive}. Extracted from `aws/sqs/client` to keep
 * that file inside the per-file size budget (ADR-0072).
 *
 * This module is **not** part of the public surface: it is not re-exported
 * from `aws/sqs/index` and has no entry in the `exports` map.
 *
 * @packageDocumentation
 */

import { M3LSQSOperationError } from "./error.js";
import type {
  M3LSQSDeleteEntry,
  M3LSQSReceiveDeduplicationMode,
  M3LSQSReceivedMessage,
  M3LSQSRedriveDecision,
  M3LSQSRedriveProcessor,
  M3LSQSSendEntry,
} from "./types.js";

/** The outcome of partitioning one received page's per-message {@link M3LSQSRedriveDecision}s. */
export interface RedrivePagePartition {
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
export async function partitionRedrivePage(
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
export function buildDropDeleteEntries(
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
export function buildMoveDeleteEntries(
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
export function clampPageMaxMessages(
  perPageMax: number,
  messageLimit: number | undefined,
  received: number,
): number {
  if (messageLimit === undefined) {
    return perPageMax;
  }
  return Math.min(perPageMax, messageLimit - received);
}
