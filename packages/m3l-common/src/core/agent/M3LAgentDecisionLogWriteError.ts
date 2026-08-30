/**
 * `core/agent/M3LAgentDecisionLogWriteError` — typed failure for a
 * decision-log append that could not be completed (ADR-0061, V7 slice 2).
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LAgentDecisionLogWriteError}.
 *
 * `cause` is optional; the error code is always
 * `"ERR_AGENT_DECISION_LOG_WRITE"` and is set automatically — callers must
 * not supply it.
 */
interface M3LAgentDecisionLogWriteErrorOptions {
  /**
   * Structured detail about the failure — byte counts, ceilings, and similar
   * operational facts the library computed itself. **Never** caller data,
   * and that includes a path: the log directory is caller input, so it names
   * neither the directory nor a segment within it. No parameter names, no
   * identity, no reason text either.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, when this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Thrown by `M3LAgentDecisionLog.write` when an entry cannot be appended:
 * its serialized line exceeds `M3L_AGENT_MAX_LOG_ENTRY_BYTES`, or the
 * underlying filesystem append itself failed.
 *
 * A write failure is always loud — this error is thrown, the underlying
 * cause is always chained as `cause`, and it is never swallowed or
 * downgraded to a warning. Its message and `context` never carry caller
 * data: no parameter names, no identity, no reason text, and no path —
 * only operational facts the library computed itself, such as a byte count
 * against its ceiling.
 *
 * The chained `cause` is the deliberate exception. A filesystem failure
 * arrives as Node's own `ENOENT` / `EACCES` / `ELOOP` error, which quotes
 * the path it failed on; that error is passed through unmodified because it
 * is the only diagnostic an operator has for a broken log directory. Code
 * that forwards one of these errors to a log sink should therefore report
 * `message` and `context`, and walk `cause` only where a caller-supplied
 * path is acceptable to record.
 *
 * @example
 * ```ts
 * import {
 *   M3LAgentDecisionLog,
 *   M3LAgentDecisionLogWriteError,
 *   M3LError,
 * } from "@m3l-automation/m3l-common/core";
 * import type { M3LAgentDecisionLogEntry } from "@m3l-automation/m3l-common/core";
 *
 * async function append(
 *   log: M3LAgentDecisionLog,
 *   entry: M3LAgentDecisionLogEntry,
 * ): Promise<void> {
 *   try {
 *     await log.write(entry);
 *   } catch (e) {
 *     if (e instanceof M3LAgentDecisionLogWriteError) {
 *       throw new M3LError("agent decision log unavailable", { cause: e });
 *     }
 *     throw e;
 *   }
 * }
 * ```
 */
export class M3LAgentDecisionLogWriteError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_AGENT_DECISION_LOG_WRITE"`. */
  override readonly code: "ERR_AGENT_DECISION_LOG_WRITE";

  /**
   * Creates a new `M3LAgentDecisionLogWriteError`.
   *
   * @param message - Human-readable description of the write failure.
   * @param options - Optional options bag; `context` carries operational
   *   detail only (never caller data), and `cause` carries the underlying
   *   error if applicable. The error code is always
   *   `"ERR_AGENT_DECISION_LOG_WRITE"` — it cannot be overridden.
   */
  constructor(message: string, options?: M3LAgentDecisionLogWriteErrorOptions) {
    super(message, {
      code: "ERR_AGENT_DECISION_LOG_WRITE",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_AGENT_DECISION_LOG_WRITE";
  }
}
