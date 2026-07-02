/**
 * `core/messaging/M3LMessenger` — the transport-agnostic facade for sending
 * plain messages, templated reports, and error notifications, and for
 * reading inbound messages when a reader is configured.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import { interpolate } from "./internal/interpolate.js";
import type {
  M3LMessageReader,
  M3LMessageReceipt,
  M3LMessageTarget,
  M3LMessageWriter,
  M3LOutboundAttachment,
  M3LOutboundMessage,
  M3LReceivedMessage,
} from "./types.js";

/**
 * Resolves the effective target for a send call: the explicit `target`
 * argument wins when provided, otherwise falls back to the messenger's
 * `defaultTarget`.
 *
 * @throws {@link M3LError} with code `"M3L_MESSAGING_NO_TARGET"` when neither
 *   an explicit target nor a default target is available.
 */
function resolveTarget(
  explicit: M3LMessageTarget | undefined,
  fallback: M3LMessageTarget | undefined,
): M3LMessageTarget {
  const resolved = explicit ?? fallback;
  if (resolved === undefined) {
    throw new M3LError(
      "no message target: pass an explicit target or configure a defaultTarget",
      { code: "M3L_MESSAGING_NO_TARGET" },
    );
  }
  return resolved;
}

/**
 * Transport-agnostic messaging facade. Wraps a required
 * {@link M3LMessageWriter} and an optional {@link M3LMessageReader}, applying
 * a `defaultTarget` fallback whenever a send call omits an explicit target.
 *
 * This module ships no concrete transport: `writer`/`reader` implementations
 * are supplied by the consumer for their chosen channel (email, chat, queue,
 * etc.).
 *
 * @example
 * ```typescript
 * import { M3LMessenger, M3LError } from "@m3l-automation/m3l-common/core";
 * import type { M3LMessageWriter } from "@m3l-automation/m3l-common/core";
 *
 * declare const writer: M3LMessageWriter;
 *
 * const messenger = new M3LMessenger({
 *   writer,
 *   defaultTarget: { id: "ops-channel" },
 * });
 *
 * await messenger.sendMessage("Job started");
 *
 * await messenger.sendReport("Processed {{ count }} rows in {{ seconds }}s", {
 *   count: 1280,
 *   seconds: 42,
 * });
 *
 * try {
 *   await runJob();
 * } catch (error) {
 *   await messenger.sendError("Job failed", error);
 * }
 *
 * try {
 *   await messenger.sendMessage("no target configured anywhere");
 * } catch (error) {
 *   if (error instanceof M3LError && error.code === "M3L_MESSAGING_NO_TARGET") {
 *     // pass an explicit target, or configure defaultTarget
 *   }
 * }
 * ```
 */
export class M3LMessenger {
  private readonly writer: M3LMessageWriter;
  private readonly reader: M3LMessageReader | undefined;
  private readonly defaultTarget: M3LMessageTarget | undefined;

  /**
   * Creates a new `M3LMessenger`.
   *
   * @param options - `writer` is required; `reader` and `defaultTarget` are
   *   optional. There is no exported options type — the shape is inline.
   */
  constructor(options: {
    readonly writer: M3LMessageWriter;
    readonly reader?: M3LMessageReader;
    readonly defaultTarget?: M3LMessageTarget;
  }) {
    this.writer = options.writer;
    this.reader = options.reader;
    this.defaultTarget = options.defaultTarget;
  }

  /**
   * Sends a plain text message.
   *
   * @param text - The message text to send verbatim.
   * @param target - Explicit destination; falls back to the configured
   *   `defaultTarget` when omitted.
   * @returns The receipt returned by the configured writer.
   * @throws {@link M3LError} with code `"M3L_MESSAGING_NO_TARGET"` when
   *   neither `target` nor a `defaultTarget` is available. The writer is
   *   never invoked in that case.
   * @example
   * ```typescript
   * // given a constructed `messenger`
   * await messenger.sendMessage("Job started");
   * ```
   */
  async sendMessage(
    text: string,
    target?: M3LMessageTarget,
  ): Promise<M3LMessageReceipt> {
    const resolvedTarget = resolveTarget(target, this.defaultTarget);
    const message: M3LOutboundMessage = { text, target: resolvedTarget };
    return await this.writer.write(message);
  }

  /**
   * Renders `template` against `data` (see {@link interpolate}) and sends
   * the result, optionally with attachments.
   *
   * `{{ key }}` tokens (whitespace around the key is tolerated) are replaced
   * with `String(data[key])`; a token whose key is absent from `data` is
   * left verbatim in the rendered text.
   *
   * @param template - The report template containing `{{ key }}` tokens.
   * @param data - The values to interpolate into the template.
   * @param attachments - Optional file attachments to include.
   * @param target - Explicit destination; falls back to the configured
   *   `defaultTarget` when omitted.
   * @returns The receipt returned by the configured writer.
   * @throws {@link M3LError} with code `"M3L_MESSAGING_NO_TARGET"` when
   *   neither `target` nor a `defaultTarget` is available. The writer is
   *   never invoked in that case.
   * @example
   * ```typescript
   * // given a constructed `messenger`
   * await messenger.sendReport("Processed {{ count }} rows", { count: 1280 });
   * ```
   */
  async sendReport(
    template: string,
    data: Record<string, unknown>,
    attachments?: readonly M3LOutboundAttachment[],
    target?: M3LMessageTarget,
  ): Promise<M3LMessageReceipt> {
    const resolvedTarget = resolveTarget(target, this.defaultTarget);
    const message: M3LOutboundMessage = {
      text: interpolate(template, data),
      target: resolvedTarget,
      ...(attachments !== undefined && { attachments }),
    };
    return await this.writer.write(message);
  }

  /**
   * Sends an error notification. Never re-throws `error` — it resolves to
   * the writer's receipt, carrying `error` on the outbound message so the
   * transport (or the writer's own logging) can inspect it.
   *
   * @param errorMessage - Human-readable summary sent as the message text.
   * @param error - The underlying cause, if any. Typed `unknown`: any thrown
   *   value can be passed through unchanged.
   * @param target - Explicit destination; falls back to the configured
   *   `defaultTarget` when omitted.
   * @returns The receipt returned by the configured writer.
   * @throws {@link M3LError} with code `"M3L_MESSAGING_NO_TARGET"` when
   *   neither `target` nor a `defaultTarget` is available. The writer is
   *   never invoked in that case.
   * @example
   * ```typescript
   * // given a constructed `messenger`
   * try {
   *   await runJob();
   * } catch (error) {
   *   await messenger.sendError("Job failed", error);
   * }
   * ```
   */
  async sendError(
    errorMessage: string,
    error?: unknown,
    target?: M3LMessageTarget,
  ): Promise<M3LMessageReceipt> {
    const resolvedTarget = resolveTarget(target, this.defaultTarget);
    const message: M3LOutboundMessage = {
      text: errorMessage,
      target: resolvedTarget,
      ...(error !== undefined && { error }),
    };
    return await this.writer.write(message);
  }

  /**
   * Reads inbound messages from the configured reader.
   *
   * @returns An `AsyncIterable` of {@link M3LReceivedMessage}, in the order
   *   the reader yields them.
   * @throws {@link M3LError} with code `"M3L_MESSAGING_NO_READER"` when this
   *   messenger has no configured reader. The error surfaces when iteration
   *   begins (e.g. `for await`), not at the time `read()` is called.
   * @example
   * ```typescript
   * // given a constructed `messenger` with a reader configured
   * for await (const message of messenger.read()) {
   *   console.log(message.author.id, message.text);
   * }
   *
   * // On a messenger with no reader configured, the `for await` above
   * // rejects on its first iteration with an M3LError whose
   * // `code` is "M3L_MESSAGING_NO_READER" — not at the `read()` call itself.
   * ```
   */
  read(): AsyncIterable<M3LReceivedMessage> {
    const reader = this.reader;
    return {
      [Symbol.asyncIterator](): AsyncIterator<M3LReceivedMessage> {
        if (reader === undefined) {
          return {
            next(): Promise<IteratorResult<M3LReceivedMessage>> {
              return Promise.reject(
                new M3LError("messenger has no configured reader", {
                  code: "M3L_MESSAGING_NO_READER",
                }),
              );
            },
          };
        }
        return reader.read()[Symbol.asyncIterator]();
      },
    };
  }
}
