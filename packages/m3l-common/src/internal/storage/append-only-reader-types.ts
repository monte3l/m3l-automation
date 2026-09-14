/**
 * `internal/storage/append-only-reader-types` — the option bags the
 * append-only READ path runs on: the planning stage's base
 * ({@link AppendOnlyReadPlanOptions}), the streaming stage's extension of it
 * ({@link AppendOnlyReaderOptions}), and the torn-tail payload that stage
 * reports through (ADR-0061 for the segment layout, ADR-0102 for the manifest
 * sidecar; X8b slice 4c).
 *
 * Library-internal; never re-exported through a public barrel. Mirrors the
 * `./append-only-writer-types.js` / `./append-only-sealer-types.js` split the
 * write side already uses.
 *
 * **Why one module for both bags.** The planning stage
 * (`./append-only-read-plan.js`) runs on the very object the streaming stage
 * (`./append-only-reader.js`) was handed, so the two descriptions of it must
 * never drift apart. Expressing that as an `extends` makes a field renamed or
 * retyped on either side a compile error by construction — the guarantee a
 * duplicated copy in each module cannot give. Relying instead on the reader
 * handing its own options straight into `planSegmentsToRead` would NOT be
 * enough: that call site passes a variable, not a fresh object literal, so
 * excess-property checking never runs there, and renaming the OPTIONAL
 * `onArchivedSegment` on one side alone compiled clean while silently flipping
 * the archival policy between reporting and throwing.
 *
 * Holding both here also keeps the dependency edge one-way. This module
 * imports neither stage — only the sealed-segment payload
 * (`./append-only-sealed-payload.js`) and the error port its fields are typed
 * on — so planning can read the base without pointing an edge at the reader,
 * which is the cycle the read seam exists to avoid.
 *
 * @packageDocumentation
 */

import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import type { AppendOnlySealedSegmentPayload } from "./append-only-sealed-payload.js";

/**
 * Reported for a trailing, unterminated fragment
 * {@link "./append-only-reader.js".readAppendOnlySegments} tolerates rather
 * than throws on. Structurally identical to the public
 * `M3LAppendOnlyTruncatedSegment` an owner reports this through — neither this
 * module nor the reader imports that type, so a second owner is free to shape
 * its own public payload the same way without pulling in the first owner's
 * types.
 */
export interface AppendOnlyTruncatedSegment {
  /** Bytes in the trailing fragment that had no terminating newline. */
  readonly byteLength: number;
  /** Zero-based index of the segment in read order. */
  readonly segmentIndex: number;
  /** Total number of segments in this read. */
  readonly segmentCount: number;
}

/**
 * What `./append-only-read-plan.js`'s `planSegmentsToRead` needs in order to
 * plan one read: the directory, the manifest's byte ceiling, the archival
 * policy, and the two error vocabularies a refusal is raised in.
 *
 * The BASE {@link AppendOnlyReaderOptions} extends — see this module's header
 * for why that relationship is structural rather than merely documented.
 */
export interface AppendOnlyReadPlanOptions {
  /** The directory to enumerate segments and read the manifest from. */
  readonly directory: string;
  /**
   * The hard ceiling the directory's `manifest.jsonl` sidecar is read under.
   * REQUIRED, and not for want of a default: an archival check a call site can
   * forget to switch on is a check that silently does not run.
   */
  readonly maxManifestBytes: number;
  /**
   * Invoked once per sealed-but-absent segment, oldest first. Omitting it is
   * a policy, not a convenience — with no handler the archival layer throws
   * for the first such segment rather than reading short in silence.
   */
  readonly onArchivedSegment?: (
    segment: AppendOnlySealedSegmentPayload,
  ) => void;
  /**
   * The owner's vocabulary for every refusal that is not manifest-level: a
   * listing or continuity failure in the planning stage, and every failure the
   * streaming stage raises.
   */
  readonly buildError: AppendOnlyReadFailure;
  /**
   * The owner's vocabulary for a MANIFEST-level refusal — an unreadable
   * sidecar, or a sealed segment no longer on disk. Kept apart from
   * {@link AppendOnlyReadPlanOptions.buildError} so a proof-layer failure can
   * carry its own class, letting a caller tell "this trail is incomplete" from
   * "this trail would not parse".
   */
  readonly buildManifestError: AppendOnlyReadFailure;
}

/**
 * The settings one {@link "./append-only-reader.js".readAppendOnlySegments}
 * call runs under: every field the planning stage reads, plus the two that
 * belong to the streaming stage alone.
 */
export interface AppendOnlyReaderOptions extends AppendOnlyReadPlanOptions {
  /** The ceiling an unterminated trailing fragment is measured against. */
  readonly maxLineBytes: number;
  /** Invoked once for a tolerated torn tail on the last segment only. */
  readonly onTruncatedTail?: (segment: AppendOnlyTruncatedSegment) => void;
}
