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
   * Structured detail about the mismatch. The payload `read()` builds is the
   * same pair `verify()`'s `"mismatched"` verdict already reports — `sealed`
   * (the claim, an
   * {@link "./append-only-verify-types.js".M3LAppendOnlySealedSegment}) and
   * `observed` (what re-digesting actually found, an
   * {@link "./append-only-integrity-contract.js".M3LAppendOnlySegmentMeasurement})
   * — so an operator can see which of the three numbers moved. On the
   * mid-read byte-overrun refusal `observed` holds `byteLength` alone; see
   * this class's own TSDoc for why nothing more can be stated honestly
   * there. Operational
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
 * **What raises it.**
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.read} verifies every
 * SEALED segment inline: the raw bytes it is already streaming are fed to the
 * same digest implementation the sealer measured with — no second read of the
 * file — and this error is thrown as soon as that measurement and the
 * manifest's claim disagree. A segment the manifest does not claim is never
 * digested, because an unclaimed segment has nothing to be compared against.
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} reports the
 * same disagreement as a `"mismatched"` verdict in its resolved report rather
 * than by throwing, since it never rejects; the two entry points answer one
 * contract in two registers.
 *
 * **Two limits on when `read()` raises it** — both tested, both deliberate
 * contract limits rather than defects. A `sha256` or entry-count disagreement
 * cannot be known until a segment's LAST byte has been read, and `read()`
 * streams entries as it goes, so the caller has already received that
 * segment's entries by the time this throws (the refusal still lands before
 * the NEXT segment's entries, which is what bounds the damage). And a caller
 * that abandons the iteration inside a segment never reaches the comparison
 * at all, so no verdict is reached for the segment it stopped inside.
 * `core/storage/append-only-integrity-contract.ts` states both in the
 * caller's own terms.
 *
 * **`context` carries less on one of the two refusal points, on purpose.** At
 * a segment's end it holds the full pair: the `sealed` claim and a complete
 * `observed` triple. When the refusal is instead the cumulative byte count
 * passing the claim MID-read — already proof the segment is not the sealed
 * one, and refused there so bytes appended after the seal never reach the
 * caller as entries — `observed` carries `byteLength` alone, and that figure
 * is a lower bound rather than the file's size. The digest was never
 * finished, so no `sha256` for the segment exists and the entry count so far
 * is only a prefix's: reporting either would place a value this library never
 * computed inside an audit error, which is worse than reporting less.
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
