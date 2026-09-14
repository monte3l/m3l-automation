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

import type { M3LAppendOnlySealedSegment } from "./append-only-verify-types.js";

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
 * import { M3L_APPEND_ONLY_MAX_SEGMENT_BYTES } from "@monte3l/m3l-common/core";
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
 * import { M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS } from "@monte3l/m3l-common/core";
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
 * import { M3L_APPEND_ONLY_MAX_LINE_BYTES } from "@monte3l/m3l-common/core";
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
 * import type { M3LAppendOnlyTruncatedSegment } from "@monte3l/m3l-common/core";
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
 * import type { M3LAppendOnlySegment } from "@monte3l/m3l-common/core";
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
 * import type { M3LAppendOnlySegmentListing } from "@monte3l/m3l-common/core";
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
 * `onArchivedSegment` reads the same way for a segment the directory's
 * `manifest.jsonl` sidecar sealed and which is no longer on disk: left unset
 * the read throws, and supplying it is how a caller writes down that an
 * archived segment is expected rather than alarming.
 *
 * **Either handler may be `async`, and a rejected promise fails the read** —
 * the read never continues past a notification the caller could not record.
 * The two differ in what the caller then catches, because they fire at
 * different points in the read; each field documents its own shape below.
 *
 * @example
 * ```ts
 * import { appendFile } from "node:fs/promises";
 * import type { M3LAppendOnlyReadOptions } from "@monte3l/m3l-common/core";
 *
 * const options: M3LAppendOnlyReadOptions = {
 *   onTruncatedTail: (segment) => {
 *     console.warn(`torn tail: ${String(segment.byteLength)} bytes dropped`);
 *   },
 *   // `async` is supported: the read waits for this promise, and a rejection
 *   // fails the read rather than letting the finding go unrecorded.
 *   onArchivedSegment: async (segment) => {
 *     await appendFile("audit.log", `archived ${segment.segment}\n`);
 *   },
 * };
 * ```
 */
export interface M3LAppendOnlyReadOptions {
  /**
   * Invoked once, with the trailing fragment's detail, when the stream's
   * last segment ends in an unterminated line. Left unset, the same
   * situation throws instead.
   *
   * **An `async` handler is supported, and its failure fails the read.** The
   * signature says `void`, which TypeScript's void-return compatibility rule
   * lets an `async` handler satisfy — so an `async` handler that awaits a log
   * write is ordinary caller code here, not an abuse of the option. `read()`
   * waits for the returned promise: it resolves and the read continues, or it
   * rejects and the read fails with
   * {@link "./M3LAppendOnlyStreamReadError.js".M3LAppendOnlyStreamReadError}
   * carrying the rejection reason as `cause` — the same shape a synchronous
   * throw from this handler produces. Nothing is silently swallowed, because
   * this handler is the only notification saying a trailing record was
   * dropped.
   *
   * **The corollary: a handler that never settles stalls the read.** `read()`
   * applies no timeout — picking one would either abandon a slow-but-honest
   * handler or hide a wedged one — so a handler awaiting something that may
   * hang needs its own deadline before the promise it returns.
   */
  readonly onTruncatedTail?: (segment: M3LAppendOnlyTruncatedSegment) => void;
  /**
   * Invoked once per segment the directory's `manifest.jsonl` sidecar states
   * a seal for and which is no longer on disk. Left unset, the same situation
   * throws
   * {@link "./M3LAppendOnlyStreamManifestError.js".M3LAppendOnlyStreamManifestError}
   * instead — supplying this handler is what **tolerates** a sealed-but-absent
   * segment, and it is the only thing that does.
   *
   * The payload is the manifest's full claim, `sha256` included, and that is
   * what makes the tolerance provable rather than merely polite: an operator
   * holding the archived copy can reproduce that digest against it with
   * `sha256sum` and settle whether the segment that left this directory is
   * the segment they still have. A bare name would only let them agree that
   * something is gone.
   *
   * **The check is eager.** Every archival finding is resolved before the
   * first entry is yielded, so a caller who supplied no handler gets the
   * throw before it has consumed anything at all. This deliberately differs
   * from `onTruncatedTail`, which fires in read order at the point the torn
   * fragment is reached: detecting a torn tail requires reading a segment's
   * bytes, whereas the archival scan needs only the manifest and the
   * directory listing. Nothing is gained by making a caller consume a partial
   * trail before learning it is incomplete — a consumer streaming this trail
   * into a rebuild wants that answer before it has committed the first entry,
   * not after.
   *
   * **An `async` handler is supported, and its failure fails the read** — on
   * the same terms as `onTruncatedTail` above, with one difference in shape.
   * `read()` waits for the returned promise before yielding anything, and a
   * rejection surfaces the rejection reason ITSELF, unwrapped, rather than
   * inside a library error: this handler runs ahead of the first entry, where
   * no segment read is in flight to attribute a failure to. Nothing is
   * swallowed — supplying this handler is what tolerates a sealed-but-absent
   * segment, so a handler that could not record the finding must not leave
   * the read looking complete. The same corollary applies: there is no
   * timeout, so a handler that never settles stalls the read before the first
   * entry.
   *
   * **A missing manifest is not a finding**, and that is a limitation rather
   * than a proof about the directory. From inside the directory, a sidecar
   * that was deleted and a trail that never sealed anything are the same
   * observation, so with no `manifest.jsonl` present the read behaves exactly
   * as it did before this option existed: nothing is reported, and a whole
   * deleted date reads back short and silent. Anyone able to delete the
   * segments can delete the sidecar alongside them, so the defence against
   * that lives outside this library — filesystem permissions, or a copy of
   * the manifest kept elsewhere — and never in `read()`.
   */
  readonly onArchivedSegment?: (segment: M3LAppendOnlySealedSegment) => void;
}
