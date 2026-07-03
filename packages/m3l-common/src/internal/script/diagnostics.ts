/**
 * `internal/script/diagnostics` — shared best-effort diagnostic writer for
 * process-fault guards, signal-shutdown failures, and pipeline cleanup
 * failures across `core/script`.
 *
 * Not re-exported publicly; consumed only by `core/script/M3LScript`,
 * `core/script/process-guards`, and `internal/script/signalHandlers`.
 *
 * @packageDocumentation
 */

import { redactSensitiveLogValue } from "../../core/logging/index.js";

/**
 * The minimal shape {@link logBestEffortDiagnostic} needs from an
 * already-serialized error — structurally compatible with
 * `core/script/process-guards`'s `serializeError` return type, without this
 * module importing that file back (which would form an import cycle, since
 * `process-guards.ts` is this helper's own caller).
 */
interface SerializedErrorLike {
  readonly context?: Record<string, unknown>;
}

/**
 * Writes a best-effort, redacted, JSON-serialized diagnostic line to
 * `process.stderr` describing a failure that occurred somewhere this
 * package cannot safely propagate further (a signal handler, a
 * process-global fault guard, or best-effort cleanup after the primary error
 * is already being thrown).
 *
 * `serialized.context` is passed through {@link redactSensitiveLogValue}
 * before being written, so a config value or secret carried in an
 * `M3LError`'s `context` bag is never leaked to stderr verbatim. Never
 * throws — a failure writing the diagnostic itself is silently discarded,
 * since there is nothing further this helper can safely do about it.
 *
 * @param label - A short label identifying the failure site (e.g.
 *   `"unhandledRejection"`, `"onCleanup"`).
 * @param serialized - The already-serialized error (typically the result of
 *   `core/script/process-guards`'s `serializeError`).
 */
export function logBestEffortDiagnostic(
  label: string,
  serialized: SerializedErrorLike,
): void {
  try {
    const redacted = {
      ...serialized,
      ...(serialized.context !== undefined && {
        context: redactSensitiveLogValue(serialized.context),
      }),
    };
    process.stderr.write(`m3l-script: ${label}: ${JSON.stringify(redacted)}\n`);
  } catch {
    // Last-resort: if even the diagnostic write fails, there is nothing
    // further this helper can safely do.
  }
}
