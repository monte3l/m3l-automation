/**
 * `internal/storage/append-only-sealed-payload` — the five-field payload a
 * caller is told about whenever this library reports one sealed segment, and
 * the narrowing projection that builds it from a manifest seal record
 * (ADR-0102, X8b slice 4c).
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * **A module of its own, because the projection has two unrelated
 * consumers.** `./append-only-archival.js` hands the payload to the read
 * path's archival handler; `./append-only-verify.js` puts it on the `sealed`
 * field of a `"sealed"`, `"mismatched"` or `"archived"` verdict. Neither use
 * is about the other, so keeping the projection inside either one makes that
 * consumer's concern a dependency of the other's — verify did exactly that
 * for one slice, importing the read path's ARCHIVAL accounting for a
 * projection that has nothing to do with archival.
 *
 * It is deliberately not folded into `./append-only-manifest-records.js`
 * beside {@link "./append-only-manifest-records.js".ManifestSealRecord}, the
 * record it projects, for two reasons. That file does not have the
 * `check:file-budget` headroom left for both the type and the function, and
 * compacting its reasoning to make room would have cost more than a file
 * costs. More importantly, the manifest's FORMAT layer is deliberately free
 * of the read/verify vocabulary this payload is named in: it parses records
 * and folds them into what one manifest states, and nothing there knows what
 * a caller is eventually shown.
 *
 * Pure and synchronous — no I/O, no clock, no state — so both consumers can
 * be exercised against it from an in-memory record.
 *
 * @packageDocumentation
 */

import type { ManifestSealRecord } from "./append-only-manifest-records.js";

/**
 * One sealed segment exactly as the manifest states it: which segment, when
 * the seal was stamped, and the three numbers it measured.
 *
 * **A structural mirror of the public
 * {@link "../../core/storage/append-only-verify-types.js".M3LAppendOnlySealedSegment},
 * and NOT an import of it — leave it that way.** The same deliberate
 * duplication `./append-only-reader.js`'s `AppendOnlyTruncatedSegment`
 * carries against `M3LAppendOnlyTruncatedSegment`, for the same reason: an
 * `internal/` module that never names a public type imposes nothing on a
 * second owner wanting the same payload shape.
 *
 * **What the mirror owes the public type is exact structural equality, in
 * both directions.** It is not a loose "at least these fields" copy the
 * public type stays free to grow past: `./append-only-verify.js` assigns a
 * value of THIS type straight into the public
 * `sealed: M3LAppendOnlySealedSegment` field of a verdict, so a field added
 * to the public type alone breaks those call sites, and a field added here
 * alone silently widens what a caller is handed. A type-level test
 * (`storage-append-only-archival.test.ts`, C10) imports this type from this
 * module directly and pins it exactly equal to the public
 * `M3LAppendOnlySealedSegment`, and that assertion is what makes the mirror
 * honest rather than merely convenient: either side gaining a field becomes
 * a compile failure instead of a drift nobody notices. A "simplification" into
 * an import of the public type is a regression, not a cleanup.
 */
export interface AppendOnlySealedSegmentPayload {
  /** The segment file name the seal measures, e.g. `2026-09-11-0001.jsonl`. */
  readonly segment: string;
  /** ISO-8601 instant the seal was stamped. */
  readonly at: string;
  /** Newline-terminated entries counted when the segment was sealed. */
  readonly entryCount: number;
  /** Raw bytes measured when the segment was sealed. */
  readonly byteLength: number;
  /** 64 lowercase hex characters: plain `sha256` of those raw bytes. */
  readonly sha256: string;
}

/**
 * Projects an internal
 * {@link "./append-only-manifest-records.js".ManifestSealRecord} down to the
 * five fields a caller is told about.
 *
 * **A fresh object literal naming all five fields, never the record itself.**
 * `ManifestSealRecord` is a structural superset — it also carries `kind` and
 * the manifest's own `formatVersion` — so assigning it straight into a
 * five-field slot type-checks and still hands every caller those extra
 * fields at runtime, including in `JSON.stringify` output. That exact
 * oversight shipped once in this wave; a literal is what makes the narrowing
 * true at runtime and not merely at the type level.
 *
 * One definition serves both consumers named in this file's header, so the
 * public shape and the internal record can only drift apart in one place.
 *
 * @param record - The seal record as the manifest states it.
 * @returns Exactly the five fields, in a new object.
 * @example
 * ```ts
 * const payload = toSealedSegmentPayload(record);
 * // => { segment, at, entryCount, byteLength, sha256 } — nothing else
 * ```
 */
export function toSealedSegmentPayload(
  record: ManifestSealRecord,
): AppendOnlySealedSegmentPayload {
  return {
    segment: record.segment,
    at: record.at,
    entryCount: record.entryCount,
    byteLength: record.byteLength,
    sha256: record.sha256,
  };
}
