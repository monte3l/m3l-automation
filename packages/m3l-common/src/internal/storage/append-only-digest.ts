/**
 * `internal/storage/append-only-digest` — the append-only stream's
 * sealed-segment measurement primitive: how many newline-terminated entries a
 * segment holds, how many raw bytes it occupies, and the `sha256` that proves
 * those bytes are the ones that were sealed (ADR-0102, X8b slice 3).
 *
 * Library-internal; never re-exported through a public barrel. Sits beside
 * `./append-only-lines.js` in the same one-way dependency graph: this module
 * knows nothing about what an entry *is*, how a segment is named, or what
 * public error class an owner raises — every failure is reported through the
 * caller's own {@link "./append-only-lines.js".AppendOnlyReadFailure} port,
 * so the writer's sealer and the reader's inline verification can each
 * surface it in their own vocabulary.
 *
 * **The digest is a public contract, not an implementation detail.** It is a
 * plain `sha256` over the file's raw bytes, with no framing, no salt and no
 * canonicalization, so that `sha256sum <archived-segment>` reproduces it with
 * no library involved. That reproducibility is the entire reason an archived
 * date is provable off-host (ADR-0102, "The digest is plain sha256 of the
 * file's raw bytes — a contract"), so it may never be "improved" into a
 * framed or salted construction: doing so would silently invalidate every
 * seal already written and every archive already taken.
 *
 * Two entry points share ONE measurement implementation, because a seal
 * written by one and verified by the other has to agree byte for byte:
 * {@link SegmentDigest} is the incremental half the reader feeds from the
 * chunks it already reads, and {@link digestSegmentFile} is the one-shot half
 * the writer's sealer uses on a segment it has rotated away from — the latter
 * being nothing but a guarded, bounded read loop around the former.
 *
 * A segment is opened here under exactly the refusals a segment READ gets
 * ({@link "./append-only-fs.js".SEGMENT_READ_FLAGS} and
 * {@link "./append-only-fs.js".assertSegmentIsReadable}), never a plain
 * `open`. A planted symlink would otherwise nominate foreign bytes for a seal
 * that is later read as this segment's proof, and a hardlink is the same
 * confused-deputy primitive documented in that module's header. A proof path
 * with weaker guarantees than the read path it vouches for would prove
 * nothing.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

import { M3LError } from "../../core/errors/index.js";
import { chainSecondaryFailure } from "../errors/chain-secondary-failure.js";
import {
  assertSegmentIsReadable,
  SEGMENT_READ_FLAGS,
} from "./append-only-fs.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import { readChunks } from "./append-only-lines.js";

/**
 * ASCII line feed (`\n`) — the append-only writer's line terminator, and so
 * the only byte that can end an entry.
 *
 * Deliberately NOT exported: {@link countNewlineBytes} is its only consumer,
 * and `knip` rejects an export nothing outside this module imports.
 */
const NEWLINE_BYTE = 0x0a;

/**
 * The largest read this module ever issues, in bytes. A segment is measured
 * in a bounded sequential pass, so the buffer is a fixed working-set cost
 * rather than a function of the file's size — a multi-megabyte segment is
 * digested without ever holding a multi-megabyte buffer.
 */
const DIGEST_CHUNK_BYTES = 65_536; // 64 KiB

/** Reported when a caller reuses a {@link SegmentDigest} past its `finish()`. */
const FINISHED_MESSAGE =
  "append-only stream: this segment digest has already been finished";

/** Reported when a segment's raw bytes exceed the caller's ceiling. */
const OVER_CEILING_MESSAGE =
  "append-only stream: a segment exceeds the maximum digestible size";

/** Reported when a segment's handle cannot be released after measuring it. */
const CLOSE_FAILURE_MESSAGE =
  "append-only stream: failed to close a segment after digesting it";

/** Reported for any other failure raised while measuring a segment. */
const DIGEST_FAILURE_MESSAGE = "append-only stream: failed to digest a segment";

/**
 * Counts the newline bytes in one chunk.
 *
 * Counting BYTES rather than splitting lines is what makes the measurement
 * independent of how the bytes were chunked: a split inside a multi-byte
 * UTF-8 character, or immediately before a terminator, changes nothing,
 * because no chunk is ever decoded or reassembled here. A trailing fragment
 * with no terminator therefore contributes to `byteLength` and not to
 * `entryCount` — which is the intended policy, not a side effect: an
 * unterminated tail is a partial write the writer never completed, never an
 * entry.
 */
function countNewlineBytes(chunk: Uint8Array): number {
  let count = 0;
  let searchStart = 0;
  for (;;) {
    const newlineIndex = chunk.indexOf(NEWLINE_BYTE, searchStart);
    if (newlineIndex === -1) {
      return count;
    }
    count += 1;
    searchStart = newlineIndex + 1;
  }
}

/** One segment's measurement: what a seal records and a verification checks. */
export interface SegmentDigestResult {
  /**
   * Newline-TERMINATED lines. A trailing fragment with no terminator is not
   * counted — see {@link countNewlineBytes}.
   */
  readonly entryCount: number;
  /** Raw bytes measured, not characters and not decoded entries. */
  readonly byteLength: number;
  /**
   * 64 lowercase hex characters: plain `sha256` of the raw bytes, with no
   * framing, salt or canonicalization, so `sha256sum <file>` reproduces it
   * off-host with no library involved. See this module's header — this is a
   * contract, not an implementation detail.
   */
  readonly sha256: string;
}

/**
 * The incremental half of the measurement: fed whatever chunks a caller
 * already has, in file order, then finished exactly once.
 *
 * The reader owns a chunk loop of its own, so verification costs it CPU and
 * no second read of the segment; the sealer reaches the same numbers through
 * {@link digestSegmentFile}, which is this class plus a guarded read loop.
 * One implementation, so a seal and its later verification cannot disagree.
 *
 * `finish()` is TERMINAL by explicit contract rather than by whatever
 * `node:crypto`'s hash object happens to do once digested: a seal is a claim
 * about one exact byte range, so an instance that could be re-read or
 * extended afterwards is a measurement two callers could legitimately
 * disagree about. Both `update()` after `finish()` and a second `finish()`
 * throw.
 *
 * @example
 * ```ts
 * const digest = new SegmentDigest();
 * for await (const chunk of readChunks(handle, 65_536)) {
 *   digest.update(chunk);
 * }
 * const { entryCount, byteLength, sha256 } = digest.finish();
 * ```
 */
export class SegmentDigest {
  /** The running `sha256` over every byte fed so far, in order. */
  readonly #hash = createHash("sha256");

  /** Newline bytes seen so far. */
  #entryCount = 0;

  /** Raw bytes fed so far. */
  #byteLength = 0;

  /** Set by {@link SegmentDigest.finish}; makes every later call throw. */
  #finished = false;

  /**
   * Rejects any use of this instance after it has been finished.
   *
   * Throws a plain `Error` on purpose: this module reports every SEGMENT
   * failure through the caller's own error port precisely so it never names a
   * public error class it does not own, and it has no port to hand here —
   * reusing an instance past `finish()` is a defect in this library's own
   * calling code, not a condition a caller of the stream can reach or handle.
   */
  #assertNotFinished(): void {
    if (this.#finished) {
      throw new Error(FINISHED_MESSAGE);
    }
  }

  /**
   * Feeds one chunk of a segment's raw bytes, in file order.
   *
   * Accepts any `Uint8Array`, not only a `Buffer`, so the reader's `Buffer`
   * chunks and a caller's plain byte array measure identically.
   *
   * @param chunk - The next raw bytes of the segment, in file order.
   */
  update(chunk: Uint8Array): void {
    this.#assertNotFinished();
    this.#hash.update(chunk);
    this.#byteLength += chunk.byteLength;
    this.#entryCount += countNewlineBytes(chunk);
  }

  /**
   * Closes the measurement and returns it. Callable exactly once.
   *
   * @returns The entry count, byte length and `sha256` of everything fed.
   */
  finish(): SegmentDigestResult {
    this.#assertNotFinished();
    this.#finished = true;
    return {
      entryCount: this.#entryCount,
      byteLength: this.#byteLength,
      sha256: this.#hash.digest("hex"),
    };
  }
}

/**
 * The read size for one measurement: the module's working-set bound, but
 * never more than one byte past the caller's ceiling.
 *
 * The extra byte is load-bearing at the boundary. The ceiling is enforced
 * against bytes actually read, so a file of exactly `maxBytes` must be
 * readable in full before the following read reports end-of-file, while a
 * file of `maxBytes + 1` must be able to deliver that one extra byte for the
 * refusal to fire. `Math.max` keeps a degenerate ceiling from asking for a
 * zero-length buffer, which would read nothing forever.
 */
function digestChunkSize(maxBytes: number): number {
  return Math.min(DIGEST_CHUNK_BYTES, Math.max(1, maxBytes + 1));
}

/**
 * Measures an already-opened, already-proven segment under `maxBytes`.
 *
 * The ceiling is enforced by a MID-READ byte counter and never by an `fstat`
 * pre-check. A pre-check is a time-of-check/time-of-use hole: a segment can
 * grow between the `stat` and the last read, so the ceiling would bound a
 * number nobody re-checked — and for a file whose reported size is not its
 * readable length at all, it bounds nothing whatsoever. Counting as the bytes
 * arrive refuses on the chunk that crosses the line, before those bytes are
 * fed to the digest and before another chunk is requested.
 */
async function digestOpenSegment(
  handle: FileHandle,
  maxBytes: number,
  buildError: AppendOnlyReadFailure,
): Promise<SegmentDigestResult> {
  const digest = new SegmentDigest();
  let byteLength = 0;
  for await (const chunk of readChunks(handle, digestChunkSize(maxBytes))) {
    byteLength += chunk.byteLength;
    if (byteLength > maxBytes) {
      throw buildError(OVER_CEILING_MESSAGE, {
        // Library-computed facts only: a ceiling the caller passed in and a
        // count this module produced. Never the path, and never any byte of
        // the segment's own contents.
        context: { maxBytes, byteLength },
      });
    }
    digest.update(chunk);
  }
  return digest.finish();
}

/**
 * Measures the segment at `segmentPath` in one bounded sequential pass:
 * opened under `./append-only-fs.js`'s guarded flags, proven by its post-open
 * `fstat` refusals, read in chunks against `maxBytes`, and closed on every
 * path.
 *
 * This is {@link SegmentDigest} plus that lifecycle — deliberately not a
 * second counting implementation, so the sealer's numbers and the reader's
 * inline verification of them can never drift apart.
 *
 * The whole fallible lifecycle sits under one guard — `open`, the `fstat`
 * tampering check, every `read`, and `close` alike. A failure that is already
 * the caller's own typed error (raised by
 * {@link "./append-only-fs.js".assertSegmentIsReadable} or by
 * {@link digestOpenSegment}'s ceiling) is re-thrown unchanged rather than
 * double-wrapped; anything else — a raw `node:fs` error out of `open`
 * (`ENOENT`, `EACCES`, `ELOOP` from a planted symlink), `read`, or `fstat` —
 * is wrapped, so no raw Node error leaks out of this function. Only the
 * chained `cause` carries path information, the deliberate exception to the
 * no-caller-data rule, since a `node:fs` error names the path by
 * construction.
 *
 * `close` is split across two paths, mirroring `./append-only-reader.js`'s
 * read loop. On the SUCCESS path it closes inside the `try` and a failure
 * throws: the segment was measured to completion, so there is no other
 * outcome for it to displace, and a seal reported over a descriptor the OS
 * never released is not a clean measurement. On a FAILURE path the close is
 * best-effort and its failure is CHAINED onto the error already in flight
 * rather than replacing it. `closeAttempted` keeps the two apart.
 *
 * @param segmentPath - The segment file to measure.
 * @param maxBytes - The ceiling, enforced against bytes actually read.
 * @param buildError - The caller's error vocabulary for every failure here.
 * @returns The segment's entry count, byte length and `sha256`.
 * @example
 * ```ts
 * const seal = await digestSegmentFile(
 *   segmentPath,
 *   maxSegmentBytes + maxLineBytes,
 *   buildError,
 * );
 * // `seal.sha256` is reproducible off-host with `sha256sum <segmentPath>`.
 * ```
 */
export async function digestSegmentFile(
  segmentPath: string,
  maxBytes: number,
  buildError: AppendOnlyReadFailure,
): Promise<SegmentDigestResult> {
  let handle: FileHandle | undefined;
  let closeAttempted = false;
  let primaryError: unknown;
  try {
    handle = await open(segmentPath, SEGMENT_READ_FLAGS);
    await assertSegmentIsReadable(handle, buildError);
    const result = await digestOpenSegment(handle, maxBytes, buildError);
    // Claim the close before attempting it, so the `finally` stands down
    // whether it succeeds or throws.
    closeAttempted = true;
    try {
      await handle.close();
    } catch (cause) {
      throw buildError(CLOSE_FAILURE_MESSAGE, { cause });
    }
    return result;
  } catch (cause) {
    primaryError =
      cause instanceof M3LError
        ? cause
        : buildError(DIGEST_FAILURE_MESSAGE, { cause });
    throw primaryError;
  } finally {
    if (!closeAttempted && handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        // Best-effort: an error is already in flight and it is the one the
        // caller must act on, but a descriptor the OS refused to release is
        // a real second fault, so it is chained rather than dropped.
        chainSecondaryFailure(
          primaryError,
          buildError(CLOSE_FAILURE_MESSAGE, { cause: closeError }),
        );
      }
    }
  }
}
