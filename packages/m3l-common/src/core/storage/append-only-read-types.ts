/**
 * `core/storage/append-only-read-types` — the public types
 * `M3LAppendOnlyStream.read` takes and reports through, plus the three
 * default-ceiling constants `M3LAppendOnlyStream`'s constructor falls back
 * to (ADR-0061, X7 slice 4a).
 *
 * Split out of `M3LAppendOnlyStream.ts` itself purely for
 * `check:file-budget`: that module sits within a few hundred bytes of the
 * 25,000-byte ceiling, and neither the two read-side types nor the three
 * constants (each carrying a full TSDoc block with an `@example`) fit in the
 * remaining headroom alongside the thin `read()` method they belong to.
 * Moving the constants here rather than into `read()`'s own file keeps every
 * item that had to move for budget reasons in one place, rather than
 * scattering the split across two justifications.
 *
 * @packageDocumentation
 */

/**
 * The default segment size ceiling: 8 MiB.
 *
 * The same number `core/agent`'s decision log uses
 * (`M3L_AGENT_LOG_MAX_SEGMENT_BYTES`), reused so the two append-only audit
 * artifacts this library writes rotate on identical terms. It is small enough
 * that one segment stays comfortably readable with a line-oriented tool and
 * large enough that rotation is rare under normal traffic.
 *
 * @example
 * ```ts
 * import { M3L_APPEND_ONLY_MAX_SEGMENT_BYTES } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_APPEND_ONLY_MAX_SEGMENT_BYTES); // 8388608
 * ```
 */
export const M3L_APPEND_ONLY_MAX_SEGMENT_BYTES = 8_388_608;

/**
 * The default segment age ceiling: 24 hours, in milliseconds.
 *
 * The same number `core/agent`'s decision log uses
 * (`M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS`). A stream that is written to rarely
 * would otherwise keep one segment open indefinitely; a daily ceiling keeps
 * a segment's contents bounded in time as well as in size, which is what
 * makes archiving and retention a per-file decision.
 *
 * @example
 * ```ts
 * import { M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS); // 86400000
 * ```
 */
export const M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS = 86_400_000;

/**
 * The default ceiling on one serialized line, newline included: 64 KiB.
 *
 * The same number `core/agent`'s decision log applies to one entry
 * (`M3L_AGENT_MAX_LOG_ENTRY_BYTES`). The ceiling governs the LINE rather than
 * the serialization alone, because the newline is part of what one `write()`
 * must carry atomically — an entry serializing to exactly the ceiling is one
 * byte too large. An entry above it is rejected **before any filesystem
 * call**, so an oversized record never half-lands.
 *
 * @example
 * ```ts
 * import { M3L_APPEND_ONLY_MAX_LINE_BYTES } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_APPEND_ONLY_MAX_LINE_BYTES); // 65536
 * ```
 */
export const M3L_APPEND_ONLY_MAX_LINE_BYTES = 65_536;

/**
 * Reported to {@link M3LAppendOnlyReadOptions.onTruncatedTail} for an
 * unterminated trailing fragment `read()` tolerates rather than throws on.
 *
 * Carries no path: the stream's directory is caller input, and the
 * error-context rule this module's siblings apply forbids naming it here
 * too.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyTruncatedSegment } from "@m3l-automation/m3l-common/core";
 *
 * function report(segment: M3LAppendOnlyTruncatedSegment): void {
 *   console.log(`dropped ${String(segment.byteLength)} trailing bytes`);
 * }
 * ```
 */
export interface M3LAppendOnlyTruncatedSegment {
  /** Bytes in the trailing fragment that had no terminating newline. */
  readonly byteLength: number;
  /** Zero-based index of the segment in read order. */
  readonly segmentIndex: number;
  /** Total number of segments in this read. */
  readonly segmentCount: number;
}

/**
 * One segment file resolved by {@link M3LAppendOnlyStream.listSegments}.
 *
 * Carries no path, for the same reason {@link M3LAppendOnlyTruncatedSegment}
 * does: the stream's directory is caller input, and the caller already has
 * {@link M3LAppendOnlyStream.directory} to rebuild the full path from `name`.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlySegment } from "@m3l-automation/m3l-common/core";
 *
 * function report(segment: M3LAppendOnlySegment): void {
 *   console.log(`${segment.name}: ${String(segment.byteLength)} bytes`);
 * }
 * ```
 */
export interface M3LAppendOnlySegment {
  /** The file name, `<YYYY-MM-DD>-<NNNN>.jsonl`. */
  readonly name: string;
  /** The UTC date prefix the segment is stamped with. */
  readonly datePrefix: string;
  /** Its sequence number within that date. */
  readonly sequence: number;
  /** The file's current size in bytes. */
  readonly byteLength: number;
  /** The file's mtime, epoch milliseconds. */
  readonly modifiedAtMs: number;
}

/**
 * The full result of {@link M3LAppendOnlyStream.listSegments}: every segment
 * actually inventoried, plus a count of directory entries that looked like a
 * segment name but could not be inventoried as one.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlySegmentListing } from "@m3l-automation/m3l-common/core";
 *
 * function report(listing: M3LAppendOnlySegmentListing): void {
 *   if (listing.skipped > 0) {
 *     console.warn(`${String(listing.skipped)} segment-named entries were not regular files`);
 *   }
 *   console.log(`${String(listing.segments.length)} segments inventoried`);
 * }
 * ```
 */
export interface M3LAppendOnlySegmentListing {
  /** Every segment inventoried, oldest `(datePrefix, sequence)` first. */
  readonly segments: readonly M3LAppendOnlySegment[];
  /**
   * How many directory entries carried a valid segment name but could not be
   * inventoried. Non-zero means the directory is not what this writer left.
   */
  readonly skipped: number;
}

/**
 * Options for {@link M3LAppendOnlyStream.read}.
 *
 * With no `onTruncatedTail`, an unterminated trailing fragment on the
 * stream's last segment throws {@link M3LAppendOnlyStreamReadError} — there
 * is no silent path. Supplying it is how a caller writes down, explicitly,
 * that it tolerates losing a torn last record (a process that died
 * mid-append) rather than failing the whole read over it.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyReadOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LAppendOnlyReadOptions = {
 *   onTruncatedTail: (segment) => {
 *     console.warn(`torn tail: ${String(segment.byteLength)} bytes dropped`);
 *   },
 * };
 * ```
 */
export interface M3LAppendOnlyReadOptions {
  /**
   * Invoked once, with the trailing fragment's detail, when the stream's
   * last segment ends in an unterminated line. Left unset, the same
   * situation throws instead.
   */
  readonly onTruncatedTail?: (segment: M3LAppendOnlyTruncatedSegment) => void;
}
