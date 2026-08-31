/**
 * `core/storage/M3LAppendOnlyStreamReadError` — typed failure for an
 * append-only stream read that could not be completed (ADR-0061, X7 slice
 * 4a).
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LAppendOnlyStreamReadError}.
 *
 * `cause` is optional; the error code is always
 * `"ERR_APPEND_ONLY_STREAM_READ"` and is set automatically — callers must
 * not supply it.
 */
interface M3LAppendOnlyStreamReadErrorOptions {
  /**
   * Structured detail about the failure — byte counts and similar
   * operational facts the library computed itself. **Never** caller data,
   * and that includes a path: the stream's directory is caller input, so it
   * names neither the directory nor a segment within it. No entry keys and
   * no entry values either.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, when this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by `M3LAppendOnlyStream.read` when a segment cannot be read back
 * faithfully: a line that fails to parse or projects to a value the stream
 * could never itself have written, an unterminated trailing fragment this
 * call does not tolerate, or a filesystem failure opening or reading a
 * segment.
 *
 * A read failure is always loud — this error is thrown, the underlying cause
 * is always chained as `cause` where one exists, and it is never swallowed
 * or downgraded to a warning. Its message and `context` never carry caller
 * data: no entry keys, no entry values, and no path — only operational facts
 * the library computed itself, such as a byte count.
 *
 * The chained `cause` is the deliberate exception, in the same register as
 * {@link M3LAppendOnlyStreamError}, and it is **not limited to a path**. A
 * filesystem failure arrives as Node's own `ENOENT` / `EACCES` / `ELOOP`
 * error, which quotes the path it failed on; a malformed-JSON failure
 * arrives as V8's own `SyntaxError`, which embeds a short (roughly 10-30
 * byte) snippet of the offending input directly in its message — so `cause`
 * can carry a fragment of **record content**, not only a directory or
 * segment path. Either way it is passed through unmodified because it is the
 * only diagnostic an operator has for a broken stream or a corrupt segment.
 * Code that forwards one of these errors to a log sink should therefore
 * report `message` and `context`, and walk `cause` only where a
 * caller-supplied path OR a fragment of the underlying record is acceptable
 * to record.
 *
 * This is a distinct class from {@link M3LAppendOnlyStreamError} rather than
 * a shared one, because `instanceof` is how a caller tells "my audit trail
 * is unwritable" (a 503) from "my audit trail is corrupt" (an operator
 * page) — those are not the same incident, and collapsing them into one
 * `code` would force every caller to inspect a message string to tell them
 * apart.
 *
 * @example
 * ```ts
 * import {
 *   M3LAppendOnlyStream,
 *   M3LAppendOnlyStreamReadError,
 *   M3LError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * async function rebuild(stream: M3LAppendOnlyStream): Promise<void> {
 *   try {
 *     for await (const entry of stream.read()) {
 *       console.log(entry);
 *     }
 *   } catch (e) {
 *     if (e instanceof M3LAppendOnlyStreamReadError) {
 *       throw new M3LError("audit trail is corrupt", { cause: e });
 *     }
 *     throw e;
 *   }
 * }
 * ```
 */
export class M3LAppendOnlyStreamReadError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_APPEND_ONLY_STREAM_READ"`. */
  override readonly code: "ERR_APPEND_ONLY_STREAM_READ";

  /**
   * Creates a new `M3LAppendOnlyStreamReadError`.
   *
   * @param message - Human-readable description of the read failure.
   * @param options - Optional options bag; `context` carries operational
   *   detail only (never caller data), and `cause` carries the underlying
   *   error if applicable. The error code is always
   *   `"ERR_APPEND_ONLY_STREAM_READ"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LAppendOnlyStreamReadErrorOptions) {
    super(message, {
      code: "ERR_APPEND_ONLY_STREAM_READ",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_APPEND_ONLY_STREAM_READ";
  }
}
