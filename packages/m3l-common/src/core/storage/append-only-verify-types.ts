/**
 * `core/storage/append-only-verify-types` — the public type surface for what
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} returns: the
 * per-segment measurement and sealed-claim shapes it compares, the five
 * verdicts a segment can receive, the failure shape for what could not be
 * checked at all, and the whole report those roll up into.
 *
 * @packageDocumentation
 */

import type { M3LError } from "../errors/index.js";

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

/**
 * One segment's sealed claim, exactly as the manifest states it: a
 * {@link M3LAppendOnlySegmentMeasurement} plus which segment it measures and
 * when the seal was stamped.
 *
 * Extends the measurement rather than restating its three fields, for the
 * same reason the internal
 * {@link "../../internal/storage/append-only-manifest-records.js".ManifestSealRecord}
 * extends
 * {@link "../../internal/storage/append-only-digest.js".SegmentDigestResult}:
 * a claim and the later verification of that claim must not be able to drift
 * apart in shape. If a verification ever needed a fourth number the claim
 * didn't carry, that mismatch would show up as a type error here, not as a
 * silently-ignored field at runtime.
 *
 * A bare segment name is sanctioned on this public surface for the same
 * reason it is sanctioned on
 * {@link "./append-only-manifest-types.js".M3LAppendOnlySealFailure.segment}
 * — see that field's TSDoc for the argument in full, rather than repeating
 * it here. The one refinement that applies to this field and not that one:
 * the guarantee is a **parse-boundary** guarantee, not a provenance one. A
 * name can only ever reach this field by first having been accepted by the
 * writer's own `parseSegmentName` on the way into a `ManifestSealRecord` —
 * that acceptance constrains the name's **shape** (a date prefix and a
 * counter in the fixed pattern this writer's own segment layer produces),
 * not who actually wrote it. An operator with write access to the directory
 * could still plant a well-formed-looking name; what the parse boundary
 * rules out is a name carrying bytes an attacker chose freely, not a name an
 * attacker chose at all.
 */
export interface M3LAppendOnlySealedSegment extends M3LAppendOnlySegmentMeasurement {
  /** The segment file name this seal measures, e.g. `2026-09-11-0001.jsonl`. */
  readonly segment: string;
  /** ISO-8601 instant the seal was stamped. */
  readonly at: string;
}

/**
 * The finding {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} reaches for one segment,
 * after comparing what the manifest claims against what re-digesting the
 * segment actually finds.
 *
 * Each member is documented as the operator-facing conclusion it represents,
 * not as an implementation detail of how it was reached — a caller acts on
 * the status, so the status has to say what action it implies.
 *
 * **A seal outranks the baseline, and this precedence must not be
 * softened.** A segment the manifest makes a claim about is verified against
 * that claim regardless of where the baseline's stated boundary falls;
 * `"legacy"` requires **both** that the segment sits at or before the
 * boundary **and** that the manifest states no seal for it. The reason this
 * matters is a concrete attack, not a style preference: the manifest reader
 * already documents that a later `baseline` record simply replaces an
 * earlier one, and that it refuses only a non-segment-shaped `upTo` or one
 * dated later than today
 * ({@link "../../internal/storage/append-only-manifest-records.js".ManifestBaselineRecord}).
 * Anyone who can write to the stream's directory could therefore append one
 * well-formed `baseline` line naming the newest segment on disk. Under a
 * baseline-first classification — check the boundary before checking for a
 * seal — that single appended line would reclassify every genuine seal in
 * the same manifest as `"legacy"` and silently disable every mismatch check
 * behind it. A tamper detector that one appended line can switch off has
 * detected nothing. Checking for a seal first closes that: a real seal is
 * always compared against its claim, however the baseline reads.
 */
export type M3LAppendOnlyVerificationStatus =
  /**
   * On disk, the manifest claims it, and re-digesting reproduces all three
   * measured numbers exactly. The proof this whole mechanism exists to
   * deliver: this segment's bytes are the bytes that were sealed.
   */
  | "sealed"
  /**
   * On disk, sits after the baseline's stated boundary, and the manifest
   * makes no claim about it at all. This is the normal, expected state of
   * whichever segment a writer is currently appending to — sealing happens
   * on rotation, so the newest segment has nothing to seal yet. Seen on any
   * other segment, it means a seal was never written for it (a crash before
   * the cold-start sweep reached it, or a best-effort seal write that
   * failed) or that the manifest recording it was lost.
   */
  | "unsealed"
  /**
   * The manifest claims this segment and it is not on disk. `"archived"`
   * means exactly that and nothing more: **the library cannot tell a
   * deliberate archival from a deletion.** It does not, and cannot, vouch
   * for an archive copy it has never seen — the name is chosen for the
   * expected case (ADR-0070's sanctioned whole-date archival procedure), not
   * as a claim that the absence was benign. What makes the difference
   * provable is that the verdict carries the full claim, including
   * `sha256`, so an operator holding an archive copy can run `sha256sum`
   * against it and compare the two by hand; this status is that
   * comparison's prerequisite, not a substitute for it.
   */
  | "archived"
  /**
   * On disk, the manifest claims it, and re-digesting disagrees with the
   * claim on at least one of the three measured numbers. This is the
   * tamper-or-corruption finding: the verdict carries both the claim and
   * what was actually observed, so an operator can see which of
   * `entryCount`, `byteLength` or `sha256` moved and reason about what kind
   * of change that implies.
   */
  | "mismatched"
  /**
   * At or before the baseline's stated boundary, and unsealed. Deliberately
   * never digested: a digest taken now cannot vouch for bytes a pre-upgrade
   * process wrote before sealing existed, and a manifest implying otherwise
   * — by reporting a digest for bytes nothing ever claimed to protect —
   * would be worse than one that plainly says "unproven before here"
   * (ADR-0102).
   */
  | "legacy";

/**
 * One segment's finding: the status {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify}
 * reached, the manifest's claim when it made one, and what re-digesting
 * actually observed when the segment was digested.
 *
 * A discriminated union on `status` rather than a flat record with two
 * independently-optional fields: the legal pairings of `sealed` and
 * `observed` are fixed by which status was reached, and a flat shape can
 * only state that pairing as prose a caller might not read — the compiler
 * would just as happily accept `{ status: "unsealed", sealed: {...} }`.
 * Keying the union on `status` makes every illegal combination
 * unrepresentable, and lets a caller narrow on `status` and read `sealed`/
 * `observed` straight off, with no `!`, no cast and no "is this actually
 * defined" unwrap.
 *
 * `observed` absent never means "measured as nothing": an arm without
 * `observed` was never digested at all, and its `status` says why — a
 * `"legacy"` segment is deliberately never digested, an `"unsealed"`
 * segment has no claim to verify against, and an `"archived"` segment has
 * nothing left on disk to read. Only the `"sealed"` and `"mismatched"` arms
 * ever carry an `observed` value.
 */
export type M3LAppendOnlySegmentVerdict =
  | {
      readonly status: "sealed";
      readonly segment: string;
      readonly sealed: M3LAppendOnlySealedSegment;
      readonly observed: M3LAppendOnlySegmentMeasurement;
    }
  | {
      readonly status: "mismatched";
      readonly segment: string;
      readonly sealed: M3LAppendOnlySealedSegment;
      readonly observed: M3LAppendOnlySegmentMeasurement;
    }
  | {
      readonly status: "archived";
      readonly segment: string;
      readonly sealed: M3LAppendOnlySealedSegment;
    }
  | {
      readonly status: "unsealed";
      readonly segment: string;
    }
  | {
      readonly status: "legacy";
      readonly segment: string;
    };

/**
 * Reported by {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} when something could not be
 * checked at all — kept deliberately separate from the five verdicts a
 * segment can otherwise receive.
 *
 * None of {@link M3LAppendOnlyVerificationStatus}'s five members can express
 * "unknown": each one is a positive finding about a segment's bytes. Folding
 * an unrelated failure — an `EACCES` reading a sealed segment, say — into
 * `"mismatched"` would let a broken filesystem read exactly like tampering,
 * which is precisely the conflation
 * {@link "./append-only-read-types.js".M3LAppendOnlySegmentListing.skipped}
 * already refuses to make for its own count: that count means "not what
 * this writer left behind", never "something went wrong while listing the
 * directory". This failure channel draws the same line for verification.
 *
 * `segment` is `undefined` for a failure that is not about any one segment
 * — the manifest itself could not be read, or the directory could not be
 * listed at all — and `error.cause` carries the raw filesystem detail,
 * matching
 * {@link "./append-only-manifest-types.js".M3LAppendOnlySealFailure}'s
 * convention.
 */
export interface M3LAppendOnlyVerificationFailure {
  /** The segment this failure is about, or `undefined` for a broader one. */
  readonly segment: string | undefined;
  /** The failure, with the raw filesystem detail on `error.cause`. */
  readonly error: M3LError;
}

/**
 * The whole report {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} returns: a verdict per
 * segment it could check, a failure per thing it couldn't, totals as a
 * convenience over the `verdicts` array, and the boundary below which this
 * trail's own evidence proves nothing. **No single field here is a clean
 * bill of health on its own** — see `totals`' own doc below.
 *
 * **Invariant:** every segment `verify()` *considered* appears in `verdicts`
 * or in `failures` — never in both, and never in neither. That invariant has
 * a boundary: an entry `listSegmentFiles` refused during inventory (a
 * symlink or hardlink planted at a segment name) was never considered by
 * that pass, and is always counted in `skipped` — it is not a completeness
 * guarantee over the raw directory listing, only over the segments this
 * stream recognized as its own. **`skipped` can still overlap `failures`:**
 * a refused entry at a name the manifest separately CLAIMS is re-checked
 * directly and reported as a `failures` entry too (see `skipped`'s own doc
 * below for why `listSegmentFiles` cannot subtract that overlap out). A
 * caller reconciling the report against a directory listing taken at the
 * same time must add `verdicts`, `failures` and `skipped` with that overlap
 * in mind, not treat them as three disjoint partitions.
 *
 * **No single field on the returned report is an alarm.** `verify()`
 * reasons only from evidence inside this stream's own directory, and the
 * attacker ADR-0102 bounds against — anyone who can write that directory —
 * can delete evidence as cheaply as alter it. Tamper with a sealed segment
 * and it reports `"mismatched"`; delete that same segment next and the
 * trail reports `"archived"` instead, indistinguishable from an honest
 * archival. Delete `manifest.jsonl` and every segment reports `"unsealed"`,
 * indistinguishable from a trail that never sealed anything. Closing that
 * gap needs an expectation held outside this directory — weigh
 * `unprovenBefore` and `skipped` alongside `totals`, never `totals` alone.
 *
 * **A report naming no segment at all is itself a finding.** One malformed
 * or disputed line anywhere in `manifest.jsonl` — a torn append, two
 * disagreeing seals for one segment, an unrecognized `formatVersion` — is
 * fatal to reading the whole sidecar, so it yields an empty `verdicts` and
 * a single `failures` entry rather than a directory's worth of
 * `"unsealed"`. Treat `verdicts.length === 0` alongside a non-empty
 * `failures` as the trail being disputed, not clean.
 *
 * @example
 * ```ts
 * import { M3LError } from "@monte3l/m3l-common/core";
 * import type { M3LAppendOnlyVerification } from "@monte3l/m3l-common/core";
 *
 * // No single field below is sufficient alone — see `totals`' own doc.
 * function escalate(report: M3LAppendOnlyVerification): void {
 *   const disputed =
 *     report.verdicts.length === 0 && report.failures.length > 0;
 *   const missingEvidence =
 *     report.unprovenBefore === undefined || report.skipped > 0;
 *   if (report.totals.mismatched > 0 || disputed || missingEvidence) {
 *     throw new M3LError("append-only trail failed verification", {
 *       code: "ERR_APPEND_ONLY_STREAM_MANIFEST",
 *     });
 *   }
 * }
 * ```
 */
export interface M3LAppendOnlyVerification {
  /**
   * One verdict per segment `verify()` could check, oldest
   * `(datePrefix, sequence)` first — the same order
   * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.listSegments} reports segments in.
   */
  readonly verdicts: readonly M3LAppendOnlySegmentVerdict[];
  /** One failure per segment (or broader concern) that could not be checked. */
  readonly failures: readonly M3LAppendOnlyVerificationFailure[];
  /**
   * One count per {@link M3LAppendOnlyVerificationStatus}, spared from
   * folding over `verdicts` by hand.
   *
   * **Not an alarm by itself.** `totals.mismatched === 0` does not mean the
   * trail is clean: the attacker ADR-0102 bounds against — anyone who can
   * write the stream directory — can turn a `"mismatched"` segment into an
   * `"archived"` one by deleting the tampered file, and can turn every count
   * here into `"unsealed"` by deleting `manifest.jsonl`. See
   * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream.verify} for what
   * closes that gap and for the report-level fields this counts alone
   * cannot substitute for.
   *
   * Typed as a `Record` over the status union rather than a hand-listed
   * interface on purpose: adding a sixth status would then fail to compile
   * everywhere a `totals` value is produced, until every producer counts the
   * new status — the same completeness trick
   * {@link "../errors/catalog.js".M3L_ERROR_CATALOG} uses for its own
   * classification table, so a status this library adds later cannot
   * silently go uncounted.
   */
  readonly totals: Readonly<Record<M3LAppendOnlyVerificationStatus, number>>;
  /**
   * The manifest's stated boundary, in three distinct values that must never
   * be collapsed into one another — a caller that treats any two of these
   * the same loses the only signal this field carries:
   *
   * - **A segment name:** the baseline's stated boundary. Everything at or
   *   before it is unproven by this trail's own evidence — not tampered,
   *   just never digested.
   * - **`null`:** the manifest carries a baseline that positively asserts
   *   sealing has been in force since this stream's very first segment —
   *   the same value
   *   {@link "../../internal/storage/append-only-manifest-records.js".ManifestBaselineRecord.upTo}
   *   uses for exactly that assertion, mirrored here.
   * - **`undefined`:** the manifest states no baseline at all — or the
   *   manifest could not be read at all; this field alone cannot tell those
   *   two apart, so read it together with `failures`. **`undefined` with an
   *   empty `failures`** means either nothing has ever been sealed on this
   *   trail, **or the manifest itself was deleted.** ADR-0102 records that
   *   deleting the manifest silently downgrades a sealed trail back to this
   *   state on the next writer's cold start, bounded only by the stream
   *   directory's `0o700` mode — this field, reading `undefined` where it
   *   previously read a segment name or `null`, is what makes that downgrade
   *   visible after the fact. **`undefined` with a non-empty `failures`** is
   *   a different incident: the manifest exists but could not be read or
   *   parsed (a permissions error, a non-regular file at that path, two
   *   disagreeing seals for one segment, or an unrecognized `formatVersion`)
   *   — see {@link M3LAppendOnlyVerificationFailure}.
   */
  readonly unprovenBefore: string | null | undefined;
  /**
   * The mirror of
   * {@link "./append-only-read-types.js".M3LAppendOnlySegmentListing.skipped}
   * — see that field for exactly what it counts and why. This field reports
   * that same inventory count **verbatim**, unchanged by anything the
   * manifest states, which is exactly what makes it comparable with
   * `listSegments()`'s own `skipped`.
   *
   * **This is not disjoint from `failures`.** `listSegmentFiles` raises
   * `skipped` for any segment-shaped entry that is not a plain, single-link
   * regular file — a symlink or a hardlink planted at that name — before
   * this report ever learns whether the manifest claims that name. When it
   * does (see this module's header for why a CLAIMED name is re-checked
   * directly rather than trusted to the inventory's filter), the same entry
   * *also* becomes a `failures` entry naming it, because a refusal to read a
   * claimed name is a finding, not silence. `verify()` cannot subtract those
   * overlapping names out of `skipped` — `listSegmentFiles` returns a count,
   * not the names it refused — so `verdicts`, `failures` and `skipped` are
   * **not** a partition of the directory listing; treat `skipped` as an
   * upper bound on entries this writer never produced, not as a disjoint
   * third bucket.
   *
   * The genuinely-true invariant survives this: every segment `verify()`
   * *considered* — every name the manifest claims, or that
   * `listSegmentFiles`'s inventory accepted as segment-shaped — appears in
   * `verdicts` or in `failures`, never in both and never in neither. An
   * entry `listSegmentFiles` refused was never considered by that
   * definition, whether or not it separately surfaces in `failures` via the
   * claimed-name path above.
   */
  readonly skipped: number;
}
