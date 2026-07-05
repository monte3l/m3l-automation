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
 * The shape {@link logBestEffortDiagnostic} needs from an already-serialized
 * error — structurally compatible with `core/script/process-guards`'s
 * `serializeError` return type, without this module importing that file back
 * (which would form an import cycle, since `process-guards.ts` is this
 * helper's own caller). Every field is redacted generically by
 * {@link logBestEffortDiagnostic} (see below), so this interface exists only
 * to describe the shape it accepts, not to single out which fields get
 * redacted.
 */
interface SerializedErrorLike {
  readonly message: string;
  readonly code?: string;
  readonly name?: string;
  readonly stack?: string;
  readonly context?: Record<string, unknown>;
  /** The request/correlation id attached to guard-caught diagnostics under Lambda. */
  readonly requestId?: string;
}

/**
 * Writes a best-effort, redacted, JSON-serialized diagnostic line to
 * `process.stderr` describing a failure that occurred somewhere this
 * package cannot safely propagate further (a signal handler, a
 * process-global fault guard, or best-effort cleanup after the primary error
 * is already being thrown).
 *
 * The **entire** serialized record — `message`, `stack`, `name`, `code`, and
 * `context` — is passed through {@link redactSensitiveLogValue} before being
 * written, not just the `context` bag: a secret can just as easily ride an
 * interpolated `message` string or a `stack` frame as it can a structured
 * context value, and all of them are masked in one recursive pass. As with
 * any use of {@link redactSensitiveLogValue}, this is a best-effort,
 * heuristic redaction over string leaves (see that function's own remarks),
 * not a guarantee that every possible secret shape is caught. Never throws —
 * a failure writing the diagnostic itself is silently discarded, since there
 * is nothing further this helper can safely do about it.
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
    const redacted = redactSensitiveLogValue(serialized);
    process.stderr.write(`m3l-script: ${label}: ${JSON.stringify(redacted)}\n`);
  } catch {
    // Last-resort: if even the diagnostic write fails, there is nothing
    // further this helper can safely do.
  }
}
