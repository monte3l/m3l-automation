/**
 * `core/messaging/types` — the abstract message shapes and transport
 * interfaces that `M3LMessenger` sends and receives through.
 *
 * This module ships only shapes: no concrete transport. Consumers implement
 * {@link M3LMessageWriter} (and optionally {@link M3LMessageReader}) for
 * their chosen channel (email, chat, queue, etc.).
 *
 * @packageDocumentation
 */

/**
 * Identifies where an outbound message is addressed (a channel, room, user,
 * or any other destination concept a transport defines).
 *
 * @example
 * ```typescript
 * import type { M3LMessageTarget } from "@m3l-automation/m3l-common/core";
 *
 * const target: M3LMessageTarget = { id: "ops-channel", label: "Ops" };
 * ```
 */
export interface M3LMessageTarget {
  /** Transport-specific identifier for the destination. */
  readonly id: string;
  /** Optional human-readable label for the destination. */
  readonly label?: string;
}

/**
 * Identifies who authored an inbound {@link M3LReceivedMessage}.
 *
 * @example
 * ```typescript
 * import type { M3LMessageAuthor } from "@m3l-automation/m3l-common/core";
 *
 * const author: M3LMessageAuthor = { id: "user-1", displayName: "Alex" };
 * ```
 */
export interface M3LMessageAuthor {
  /** Transport-specific identifier for the author. */
  readonly id: string;
  /** Optional human-readable display name for the author. */
  readonly displayName?: string;
}

/**
 * Acknowledgement a {@link M3LMessageWriter} returns after accepting an
 * outbound message. Deliberately open/minimal — transports attach whatever
 * metadata they have (a message id, the resolved target, a timestamp); the
 * {@link M3LMessenger} facade passes it through to its caller unchanged.
 *
 * @example
 * ```typescript
 * import type { M3LMessageReceipt } from "@m3l-automation/m3l-common/core";
 *
 * const receipt: M3LMessageReceipt = { id: "msg-123", timestamp: new Date() };
 * ```
 */
export interface M3LMessageReceipt {
  /** Transport-specific identifier for the sent message, if available. */
  readonly id?: string;
  /** The target the message was ultimately delivered to, if known. */
  readonly target?: M3LMessageTarget;
  /** When the transport accepted/delivered the message, if known. */
  readonly timestamp?: Date;
}

/**
 * A file (or file-like) attachment to include on an outbound message.
 *
 * @example
 * ```typescript
 * import type { M3LOutboundAttachment } from "@m3l-automation/m3l-common/core";
 *
 * const attachment: M3LOutboundAttachment = {
 *   filename: "report.csv",
 *   content: "a,b,c\n1,2,3\n",
 *   contentType: "text/csv",
 * };
 * ```
 */
export interface M3LOutboundAttachment {
  /** The filename to present to the recipient. */
  readonly filename: string;
  /** The attachment payload, either raw bytes or text. */
  readonly content: Buffer | string;
  /** Optional MIME type of {@link content}. */
  readonly contentType?: string;
}

/**
 * Metadata describing a file attachment on an inbound message. Unlike
 * {@link M3LOutboundAttachment}, this does not carry the payload itself —
 * transports typically expose inbound content through a separate fetch step.
 *
 * @example
 * ```typescript
 * import type { M3LInboundAttachment } from "@m3l-automation/m3l-common/core";
 *
 * const attachment: M3LInboundAttachment = {
 *   filename: "screenshot.png",
 *   contentType: "image/png",
 *   size: 48213,
 * };
 * ```
 */
export interface M3LInboundAttachment {
  /** The filename as presented by the sender. */
  readonly filename: string;
  /** Optional MIME type of the attachment. */
  readonly contentType?: string;
  /** Optional size in bytes, if the transport reports it. */
  readonly size?: number;
}

/**
 * A message ready to hand to a {@link M3LMessageWriter}. Produced internally
 * by {@link M3LMessenger}'s `send*` methods — consumers do not usually build
 * this directly, but a custom {@link M3LMessageWriter} receives it.
 *
 * @example
 * ```typescript
 * import type { M3LOutboundMessage } from "@m3l-automation/m3l-common/core";
 *
 * const message: M3LOutboundMessage = {
 *   text: "Job finished",
 *   target: { id: "ops-channel" },
 * };
 * ```
 */
export interface M3LOutboundMessage {
  /** The rendered text of the message. */
  readonly text: string;
  /** The resolved destination, if one was available. */
  readonly target?: M3LMessageTarget;
  /** Optional file attachments to include. */
  readonly attachments?: readonly M3LOutboundAttachment[];
  /**
   * The underlying error this message reports on, when sent via
   * {@link M3LMessenger.sendError}. Typed `unknown` because any thrown value
   * may be passed through.
   */
  readonly error?: unknown;
}

/**
 * A message yielded by a {@link M3LMessageReader}.
 *
 * @example
 * ```typescript
 * import type { M3LReceivedMessage } from "@m3l-automation/m3l-common/core";
 *
 * const message: M3LReceivedMessage = {
 *   text: "status?",
 *   author: { id: "user-1" },
 * };
 * ```
 */
export interface M3LReceivedMessage {
  /** The text content of the received message. */
  readonly text: string;
  /** Who sent the message. */
  readonly author: M3LMessageAuthor;
  /** Optional file attachments carried by the message. */
  readonly attachments?: readonly M3LInboundAttachment[];
}

/**
 * Abstract outbound transport. Implement this for each channel (email,
 * chat, queue, etc.) and hand it to {@link M3LMessenger} to send through it.
 *
 * @example
 * ```typescript
 * import type {
 *   M3LMessageWriter,
 *   M3LOutboundMessage,
 *   M3LMessageReceipt,
 * } from "@m3l-automation/m3l-common/core";
 *
 * class ConsoleWriter implements M3LMessageWriter {
 *   write(message: M3LOutboundMessage): M3LMessageReceipt {
 *     console.log(message.text);
 *     return { timestamp: new Date() };
 *   }
 * }
 * ```
 */
export interface M3LMessageWriter {
  /**
   * Sends `message` through this transport.
   *
   * @param message - The outbound message to send.
   * @returns The receipt acknowledging the send, synchronously or
   *   asynchronously.
   */
  write(
    message: M3LOutboundMessage,
  ): M3LMessageReceipt | Promise<M3LMessageReceipt>;
}

/**
 * Abstract inbound transport. Implement this to let {@link M3LMessenger}
 * read messages from a channel. Optional — a messenger configured with only
 * a {@link M3LMessageWriter} is send-only.
 *
 * @example
 * ```typescript
 * import type {
 *   M3LMessageReader,
 *   M3LReceivedMessage,
 * } from "@m3l-automation/m3l-common/core";
 *
 * class FixedReader implements M3LMessageReader {
 *   async *readAll(): AsyncGenerator<M3LReceivedMessage> {
 *     yield { text: "hi", author: { id: "user-1" } };
 *   }
 *
 *   read(): AsyncIterable<M3LReceivedMessage> {
 *     return this.readAll();
 *   }
 * }
 * ```
 */
export interface M3LMessageReader {
  /**
   * Returns an async iterable of inbound messages.
   *
   * @returns An `AsyncIterable` a caller can consume with `for await`.
   */
  read(): AsyncIterable<M3LReceivedMessage>;
}
