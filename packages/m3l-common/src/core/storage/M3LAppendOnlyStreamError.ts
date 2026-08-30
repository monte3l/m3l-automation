/**
 * `core/storage/M3LAppendOnlyStreamError` — typed failure for an append-only
 * stream append that could not be completed (ADR-0061, X7 slice 2).
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LAppendOnlyStreamError}.
 *
 * `cause` is optional; the error code is always
 * `"ERR_APPEND_ONLY_STREAM_WRITE"` and is set automatically — callers must
 * not supply it.
 */
interface M3LAppendOnlyStreamErrorOptions {
  /**
   * Structured detail about the failure — byte counts, ceilings, and similar
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
 * Thrown by `M3LAppendOnlyStream.append` when an entry cannot be appended:
 * its serialized line exceeds the stream's `maxLineBytes` ceiling, or the
 * underlying filesystem append itself failed.
 *
 * An append failure is always loud — this error is thrown, the underlying
 * cause is always chained as `cause`, and it is never swallowed or
 * downgraded to a warning. Its message and `context` never carry caller
 * data: no entry keys, no entry values, and no path — only operational facts
 * the library computed itself, such as a byte count against its ceiling.
 *
 * The chained `cause` is the deliberate exception. A filesystem failure
 * arrives as Node's own `ENOENT` / `EACCES` / `ELOOP` error, which quotes
 * the path it failed on; that error is passed through unmodified because it
 * is the only diagnostic an operator has for a broken stream directory. Code
 * that forwards one of these errors to a log sink should therefore report
 * `message` and `context`, and walk `cause` only where a caller-supplied
 * path is acceptable to record.
 *
 * A caller-side violation — a malformed options bag, or an entry holding a
 * value the stream cannot faithfully persist — is **not** reported with this
 * error: it throws a bare `M3LError` with `code: "ERR_INVALID_ARGUMENT"`, so
 * "the argument was wrong" stays distinguishable from "the filesystem is
 * unhealthy".
 *
 * @example
 * ```ts
 * import {
 *   M3LAppendOnlyStream,
 *   M3LAppendOnlyStreamError,
 *   M3LError,
 * } from "@m3l-automation/m3l-common/core";
 * import type { M3LAppendOnlyEntry } from "@m3l-automation/m3l-common/core";
 *
 * async function record(
 *   stream: M3LAppendOnlyStream,
 *   entry: M3LAppendOnlyEntry,
 * ): Promise<void> {
 *   try {
 *     await stream.append(entry);
 *   } catch (e) {
 *     if (e instanceof M3LAppendOnlyStreamError) {
 *       throw new M3LError("audit stream unavailable", { cause: e });
 *     }
 *     throw e;
 *   }
 * }
 * ```
 */
export class M3LAppendOnlyStreamError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_APPEND_ONLY_STREAM_WRITE"`. */
  override readonly code: "ERR_APPEND_ONLY_STREAM_WRITE";

  /**
   * Creates a new `M3LAppendOnlyStreamError`.
   *
   * @param message - Human-readable description of the append failure.
   * @param options - Optional options bag; `context` carries operational
   *   detail only (never caller data), and `cause` carries the underlying
   *   error if applicable. The error code is always
   *   `"ERR_APPEND_ONLY_STREAM_WRITE"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LAppendOnlyStreamErrorOptions) {
    super(message, {
      code: "ERR_APPEND_ONLY_STREAM_WRITE",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_APPEND_ONLY_STREAM_WRITE";
  }
}
