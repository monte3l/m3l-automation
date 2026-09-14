/**
 * `core/storage/M3LAppendOnlyStreamIntegrityError` — typed failure for a
 * sealed segment that is still on disk but whose bytes no longer agree with
 * what the seal recorded about them: the `sha256`, the `entryCount` or the
 * `byteLength` in
 * {@link "./append-only-integrity-contract.js".M3LAppendOnlySegmentMeasurement}
 * disagrees with the claim in
 * {@link "./append-only-verify-types.js".M3LAppendOnlySealedSegment}
 * (ADR-0102, X8b slice 4d).
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LAppendOnlyStreamIntegrityError}.
 *
 * `cause` is optional; the error code is always
 * `"ERR_APPEND_ONLY_STREAM_INTEGRITY"` and is set automatically — callers
 * must not supply it.
 */
interface M3LAppendOnlyStreamIntegrityErrorOptions {
  /**
   * Structured detail about the mismatch. The intended payload is the same
   * pair `verify()`'s `"mismatched"` verdict already reports — `sealed` (the
   * claim, an
   * {@link "./append-only-verify-types.js".M3LAppendOnlySealedSegment}) and
   * `observed` (what re-digesting actually found, an
   * {@link "./append-only-integrity-contract.js".M3LAppendOnlySegmentMeasurement})
   * — so an operator can see which of the three numbers moved. Operational
   * facts the library computed itself only: **never** caller data, no
   * directory path, no entry key, no entry value. The segment file name a
   * seal carries is this library's own, derived from the rotation clock
   * rather than from anything a caller supplied.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, when this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Raised when a sealed segment is present in the stream directory and
 * re-digesting its bytes disagrees with the seal the manifest recorded for
 * it — a mismatch on `sha256`, `entryCount` or `byteLength`.
 *
 * This is the tamper-or-corruption finding, and it is a **distinct class**
 * from
 * {@link "./M3LAppendOnlyStreamManifestError.js".M3LAppendOnlyStreamManifestError}
 * on purpose. That class covers a segment the manifest claims and that is no
 * longer on disk — a date archived by ADR-0070's sanctioned procedure, which
 * is expected housekeeping. This class covers bytes that are still there and
 * are not the bytes that were sealed, which is evidence of a change nobody
 * sanctioned. The two demand opposite operator responses, so `instanceof`
 * has to separate them; collapsing them into one `code` would leave a caller
 * discriminating on message text, which this codebase forbids.
 *
 * It is never retryable, and its catalog classification says so: the same
 * bytes digest to the same value, so a second attempt reproduces the
 * identical mismatch. The remedy is an operator comparing the seal's
 * `sha256` — a plain digest, reproducible with `sha256sum` alone — against
 * an archive copy, not a retry.
 *
 * **No code in this package raises it.** The reader-side digest check it
 * belongs to is
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.read}'s, and that
 * check is not part of `M3LAppendOnlyStream`: `read()` verifies a sealed
 * segment's *presence*, not its digest, and
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} reports a
 * digest disagreement as a `"mismatched"` verdict in its resolved report
 * rather than by throwing, since it never rejects. So this class and its
 * code exist ahead of any thrower — registering the code, its catalog
 * classification and the `context` payload before a call site depends on all
 * three keeps that vocabulary settled rather than invented inside the reader
 * change.
 *
 * Its message and `context` carry only operational facts the library
 * computed itself. The chained `cause` is the documented exception, in the
 * same register as
 * {@link "./M3LAppendOnlyStreamError.js".M3LAppendOnlyStreamError}: a
 * filesystem failure met while re-reading a segment arrives as Node's own
 * `EIO` / `EACCES` error, which quotes the path it failed on. Code
 * forwarding this error to a log sink should report `message` and `context`,
 * and walk `cause` only where a caller-supplied path is acceptable to
 * record.
 *
 * @example
 * ```ts
 * import {
 *   M3LError,
 *   M3LAppendOnlyStreamIntegrityError,
 *   M3LAppendOnlyStreamManifestError,
 * } from "@monte3l/m3l-common/core";
 *
 * function describeAuditFailure(error: unknown): string {
 *   if (error instanceof M3LAppendOnlyStreamIntegrityError) {
 *     // Bytes that are still on disk are not the bytes that were sealed:
 *     // tamper evidence, and retrying re-digests those very same bytes.
 *     return `audit trail integrity failure: ${error.message}`;
 *   }
 *   if (error instanceof M3LAppendOnlyStreamManifestError) {
 *     // A proof is missing, most often because a whole date was archived by
 *     // the sanctioned procedure: a compliance escalation, not tampering.
 *     return `audit trail no longer provable: ${error.message}`;
 *   }
 *   throw new M3LError("unrecognized audit trail failure", { cause: error });
 * }
 * ```
 */
export class M3LAppendOnlyStreamIntegrityError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_APPEND_ONLY_STREAM_INTEGRITY"`. */
  override readonly code: "ERR_APPEND_ONLY_STREAM_INTEGRITY";

  /**
   * Creates a new `M3LAppendOnlyStreamIntegrityError`.
   *
   * @param message - Human-readable description of the integrity failure.
   * @param options - Optional options bag; `context` carries operational
   *   detail only (never caller data), and `cause` carries the underlying
   *   error if applicable. The error code is always
   *   `"ERR_APPEND_ONLY_STREAM_INTEGRITY"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LAppendOnlyStreamIntegrityErrorOptions,
  ) {
    super(message, {
      code: "ERR_APPEND_ONLY_STREAM_INTEGRITY",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_APPEND_ONLY_STREAM_INTEGRITY";
  }
}
