/**
 * `core/storage/append-only-integrity-contract` — the vocabulary in which a
 * sealed claim and the bytes actually observed are both expressed, plus the
 * long-form integrity contract that
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.read} and
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} both answer
 * to.
 *
 * {@link M3LAppendOnlySegmentMeasurement} was declared in
 * `core/storage/append-only-verify-types.ts` for as long as `verify()` was
 * the only caller that ever compared a claim against re-measured bytes — and
 * for as long as that held, nothing outside those verify types referenced it.
 * Once `read()` verifies a sealed segment's digest inline, the same three
 * numbers are the currency of both entry points, so the type is homed here
 * rather than inside one method's return types: a shape two entry points
 * share should not have to be imported out of the return types of one of
 * them.
 *
 * The contract prose below is here for the same reason, and was moved
 * verbatim out of those two methods' own TSDoc — references to "this method"
 * and "this stream" resolved to the method and the stream they named, and
 * nothing else altered, because parts of it assert security properties a
 * rewording would silently restate as a new claim. It is one contract with
 * two entry points, so `M3LAppendOnlyStream`'s methods each keep a summary
 * and a pointer here rather than half of it.
 *
 * **What `read()` vouches for in a trail it hands entries back from**
 *
 * **The archival check is eager.** Every `onArchivedSegment` call is
 * resolved before the first entry is yielded, so a caller that supplied no
 * handler learns the trail is incomplete — by the throw — before it has
 * consumed anything at all. This deliberately differs from
 * `onTruncatedTail`, which fires in read order at the point the torn
 * fragment is reached: detecting a torn tail requires reading a segment's
 * bytes, whereas the archival scan needs only the manifest and the
 * directory listing, so nothing is gained by deferring it.
 *
 * **What `verify()` vouches for in a trail it reports on**
 *
 * **Never rejects.** That is the entire reason an operator reaches for
 * `verify()`: `read()` has typically already started throwing by the
 * time `verify()` is called, and a verification that itself threw on a
 * damaged trail would be useless exactly when the damage is why it was
 * called. Every failure the stream can hit while verifying — the
 * directory cannot be listed, the manifest cannot be read, a claimed
 * segment cannot be re-digested — becomes an entry in the resolved
 * report's `failures` array instead of a rejection. The classification
 * rules themselves (the precedence between a seal and a baseline, the
 * ordering, the boundary) are
 * {@link "../../internal/storage/append-only-verify.js".verifyAppendOnlySegments}'s
 * to state; `verify()` only wires the stream's own directory and
 * ceilings to that engine.
 *
 * **The returned report is not a simple pass/fail.** Read it through
 * {@link "./append-only-verify-types.js".M3LAppendOnlyVerification}, which
 * documents what each field can — and cannot — prove about the stream's
 * directory; no single field on it is a clean bill of health by itself.
 *
 * The digest bound handed to the engine is `maxSegmentBytes + maxLineBytes`,
 * never `maxSegmentBytes` alone: `shouldRotate` fires at
 * `>= maxSegmentBytes`, so the line that crosses the ceiling is written
 * before rotation, and a segment legitimately larger than
 * `maxSegmentBytes` on its very first write would otherwise be refused as
 * unreadable rather than reported `"sealed"`.
 *
 * @packageDocumentation
 */

/**
 * The three numbers a seal records, and the same three numbers a
 * verification re-derives by digesting the segment again: how many
 * newline-terminated entries it holds, how many raw bytes it occupies, and
 * the `sha256` of those bytes.
 *
 * This is the public mirror of
 * {@link "../../internal/storage/append-only-digest.js".SegmentDigestResult}
 * — the internal shape a seal is written from and a verification is computed
 * against — kept as a single field-for-field copy rather than re-exported
 * directly, because this module never imports from `internal/`.
 *
 * `entryCount` counts newline-TERMINATED lines only: a trailing fragment
 * with no terminator was never a completed entry and is not counted, on
 * exactly the same rule the reader itself applies while parsing.
 * `byteLength` is raw bytes measured off disk, never characters and never a
 * count of decoded entries — a multi-byte character inflates the two
 * differently, so only the byte figure can ever agree with a filesystem
 * `stat`. `sha256` is 64 lowercase hex characters: a **plain** `sha256` of
 * those raw bytes, with no framing, no salt and no canonicalization added by
 * this library. That plainness is a contract, not an incidental
 * implementation choice: it is what lets `sha256sum <archived-segment>`
 * reproduce the exact same value off-host, with no library involved, which
 * is the entire reason an archived date can be checked at all once it has
 * left this trail's directory.
 */
export interface M3LAppendOnlySegmentMeasurement {
  /** Newline-terminated entries counted while digesting. */
  readonly entryCount: number;
  /** Raw bytes measured, not characters and not decoded entries. */
  readonly byteLength: number;
  /**
   * 64 lowercase hex characters: plain `sha256` of the raw bytes, with no
   * framing, salt or canonicalization — reproducible with `sha256sum` alone.
   */
  readonly sha256: string;
}
