/**
 * `internal/storage/append-only-read-digest` — the read path's INLINE
 * verification of ONE sealed segment (ADR-0102, X8b slice 4d): the bytes
 * `./append-only-reader.js` is already streaming are fed to
 * `./append-only-digest.js`'s `SegmentDigest` as they arrive, and the
 * measurement is compared against what the directory's `manifest.jsonl`
 * sealed for that segment.
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * **Why a module rather than a few lines inside the reader's loop.** The
 * reader's job is bytes to entries; this one holds a proof rule with two
 * distinct refusal points and its own reasoning about what each of them can
 * honestly claim (see {@link SegmentSealVerification}). Keeping it here also
 * leaves the rule readable next to the two modules it has to agree with —
 * `./append-only-digest.js`, whose measurement the sealer wrote the claim
 * from, and `./append-only-verify.js`, which reaches the same verdict on the
 * verify path — rather than buried in a streaming loop the next reader of
 * that file came for.
 *
 * **The comparison itself is NOT re-implemented here.**
 * {@link "./append-only-digest.js".measurementsMatch} is the single
 * definition of "these three numbers agree", shared with
 * `./append-only-verify.js`, `./append-only-manifest-records.js` and
 * `./append-only-seal-attempt.js`, for exactly the reason that module's
 * header already gives for sharing one measurement implementation: a seal
 * written by one path and checked by another has to agree field for field,
 * and a second copy of the comparison is a second place for that agreement
 * to rot.
 *
 * No I/O, no clock and no state beyond the running digest — every branch is
 * reachable by feeding chunks to an instance.
 *
 * @packageDocumentation
 */

import type { SegmentDigestResult } from "./append-only-digest.js";
import { measurementsMatch, SegmentDigest } from "./append-only-digest.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import type { ManifestSealRecord } from "./append-only-manifest-records.js";
import { toSealedSegmentPayload } from "./append-only-sealed-payload.js";

/**
 * Reported when a sealed segment's bytes have already outgrown the byte
 * length its seal claims, with more still to read.
 */
const OVERRUN_MESSAGE =
  "append-only stream: a sealed segment holds more bytes than its seal claims";

/**
 * Reported when a sealed segment's completed measurement disagrees with its
 * seal on the entry count, the byte length or the `sha256`.
 */
const MISMATCH_MESSAGE =
  "append-only stream: a sealed segment's bytes no longer match its seal";

/**
 * One sealed segment's inline verification: fed the same raw chunks the
 * reader splits lines out of, in file order, then finished once the segment's
 * last byte has been read.
 *
 * Constructed only for a segment the manifest actually CLAIMS. An unclaimed
 * segment has nothing to compare against, so the read path's whole rule is
 * "has a seal? verify : skip" — see
 * {@link "./append-only-reader.js".readAppendOnlySegments}' own helper for why
 * the baseline is deliberately not consulted in reaching it.
 *
 * **Two refusal points, and they are not interchangeable.**
 *
 * - {@link SegmentSealVerification.observe} refuses MID-read, on the chunk
 *   that pushes the cumulative byte count past the claim. At that moment the
 *   segment is already provably not the sealed one, and refusing there is what
 *   keeps bytes appended after the seal from reaching the consumer as entries.
 *   Waiting for the segment's end would hand them over first.
 * - {@link SegmentSealVerification.finish} refuses at the segment's END, where
 *   a `sha256` disagreement, a changed entry count, or a segment that SHRANK
 *   first becomes knowable. A shrink can never trip the mid-read check —
 *   cumulative bytes never exceed the claim — which is why both points exist.
 *
 * That end-of-segment refusal is a documented LIMIT of the read path, not an
 * oversight: the reader streams entries as it goes, so the consumer has
 * already seen this segment's entries by the time a `sha256` disagreement can
 * be known. The refusal still lands before the NEXT segment's entries, which
 * is what keeps the damage bounded — stated for a caller on
 * `../../core/storage/append-only-integrity-contract.ts`.
 *
 * @example
 * ```ts
 * const verification = new SegmentSealVerification(seal, buildIntegrityError);
 * for await (const chunk of readChunks(handle, maxLineBytes)) {
 *   verification.observe(chunk);
 *   // …split lines out of `chunk` and yield entries…
 * }
 * verification.finish();
 * ```
 */
export class SegmentSealVerification {
  /** The manifest's claim every refusal below is measured against. */
  readonly #seal: ManifestSealRecord;

  /** The owner's vocabulary for an integrity refusal. */
  readonly #buildIntegrityError: AppendOnlyReadFailure;

  /** The running measurement over every chunk accepted so far. */
  readonly #digest = new SegmentDigest();

  /**
   * Raw bytes seen so far, counted BEFORE they are fed to the digest so the
   * overrun refusal can fire on the crossing chunk. Tracked here rather than
   * read back off {@link SegmentSealVerification.#digest}, which publishes its
   * counts only through its terminal `finish()`.
   */
  #byteLength = 0;

  /**
   * @param seal - The manifest's seal for this segment.
   * @param buildIntegrityError - The owner's integrity-error vocabulary. A
   *   PORT rather than a direct construction, matching every other refusal on
   *   this path: `internal/` never names the public class an owner raises.
   */
  constructor(
    seal: ManifestSealRecord,
    buildIntegrityError: AppendOnlyReadFailure,
  ) {
    this.#seal = seal;
    this.#buildIntegrityError = buildIntegrityError;
  }

  /**
   * Feeds one chunk of this segment's raw bytes, in file order, refusing
   * before the digest is advanced if the cumulative count has passed the
   * claim.
   *
   * The refusal's `observed` deliberately carries `byteLength` ALONE. The read
   * was abandoned mid-segment, so neither the entry count nor the `sha256` of
   * the whole segment is known — and the byte figure itself is a LOWER BOUND
   * (the bytes read so far), not the file's size, which nothing here has
   * measured. Reporting a `sha256` of a prefix under the name of the segment's
   * digest, or a partial entry count as though it were the segment's, would be
   * a number an operator could not act on.
   *
   * @param chunk - The next raw bytes of the segment, in file order.
   */
  observe(chunk: Uint8Array): void {
    this.#byteLength += chunk.byteLength;
    if (this.#byteLength > this.#seal.byteLength) {
      throw this.#buildIntegrityError(OVERRUN_MESSAGE, {
        context: {
          sealed: toSealedSegmentPayload(this.#seal),
          observed: { byteLength: this.#byteLength },
        },
      });
    }
    this.#digest.update(chunk);
  }

  /**
   * Closes the measurement and compares it with the seal, throwing the
   * owner's integrity error when the two disagree on any of the three
   * numbers. Callable exactly once, since
   * {@link "./append-only-digest.js".SegmentDigest.finish} is terminal by
   * contract.
   *
   * The `context` here carries the FULL pair — the claim as the manifest
   * states it and the completed measurement — so an operator can see which of
   * the three numbers moved.
   */
  finish(): void {
    const observed: SegmentDigestResult = this.#digest.finish();
    if (measurementsMatch(this.#seal, observed)) {
      return;
    }
    throw this.#buildIntegrityError(MISMATCH_MESSAGE, {
      context: { sealed: toSealedSegmentPayload(this.#seal), observed },
    });
  }
}
