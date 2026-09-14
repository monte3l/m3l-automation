/**
 * `internal/storage/append-only-read-plan` — the append-only read path's
 * PLANNING stage (ADR-0061 for the segment layout, ADR-0102 for the manifest
 * sidecar; X8b slice 4c). It answers one question about a stream directory,
 * before a single entry is yielded out of it: **which segments does this read
 * cover, and is that set the whole trail?**
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * **Why this is a module rather than a section of `./append-only-reader.js`.**
 * The two answer genuinely different questions, over different scopes, with
 * different failure vocabularies. The reader answers "what are the bytes of
 * this segment": a per-file, streaming, bounded-memory concern that holds one
 * handle at a time, splits newlines out of fixed-size chunks, tolerates a torn
 * tail on the last segment, and yields entries as it goes. This module answers
 * "what does this read cover, and is that set accounted for": a
 * whole-directory, eager, integrity concern that reconciles two independent
 * artifacts — the directory listing and the `manifest.jsonl` sidecar — and
 * whose only two outputs are a segment list and a refusal.
 *
 * Before ADR-0102 that reconciliation did not exist: planning was a `readdir`,
 * a sort, and a contiguity walk over the names that survived parsing, small
 * enough to read honestly as a preamble to the reader's own loop. The manifest
 * sidecar is what made it non-trivial. Planning now consults an artifact the
 * reader never opens, holds a precedence rule about what a seal means when the
 * file it names is gone, and can refuse a whole read on the strength of that
 * rule alone — reasoning that goes stale when it lives as a preamble to
 * something else, because the next person in the file came for the streaming
 * loop. Keeping both files comfortably under `check:file-budget`'s ceiling is a
 * real but secondary benefit; this seam would be worth drawing at half the
 * size.
 *
 * This module reuses the exact segment-name parser the writer's own cold-start
 * discovery uses ({@link "./append-only-segments.js".parseSegmentName}) rather
 * than a second regex that could drift from it. Unlike the writer, which only
 * ever scans **today's** date prefix, planning enumerates every date a segment
 * exists under — a fresh process reading back a stream that has lived across
 * midnight has to see all of it, not just today's slice.
 *
 * **Every read consults the directory-wide `manifest.jsonl` sidecar**
 * (ADR-0102, X8b): it is the only artifact in the directory that still
 * remembers a segment no longer in it. A sealed segment absent from disk is
 * escalated through `./append-only-archival.js` — reported to the owner's
 * `onArchivedSegment`, or thrown when no handler was supplied — and its
 * position then counts as accounted for by {@link assertNoSequenceGap} rather
 * than as an unexplained hole in the trail.
 *
 * **A manifest that exists and cannot be read stops the read.** That is a
 * decided tradeoff, not an oversight, and it has a cost worth stating plainly.
 * {@link "./append-only-manifest.js".readManifest} already treats an ABSENT
 * sidecar as contents-free, because a trail that has never sealed anything is
 * a legitimate state. Every other failure it reports — a malformed mid-file
 * record, a record of a known kind stamped above this reader's format version,
 * a symlink planted at the manifest name, a sidecar over the caller's byte
 * ceiling — propagates untouched through this module rather than being caught
 * and downgraded to "no seals known". Catching it would let one corrupt byte
 * switch archival detection off for the entire trail while every read still
 * reported success, which is the failure mode an audit trail can least afford:
 * silent, total, and indistinguishable from a clean directory.
 *
 * The cost is real and falls on a real caller. The only production reader of
 * this path today is the console's boot index rebuild, which never throws by
 * contract — so a corrupt sidecar costs it that rebuild entirely. That is the
 * intended trade: losing the index is recoverable and visible, whereas
 * rebuilding an index from a trail this layer could not vouch for produces an
 * artifact that looks authoritative and is not.
 *
 * The counterpart limitation is the other half of the same rule. An absent
 * manifest is contents-free, so a DELETED manifest is not detectable here at
 * all: an actor who removes the sidecar outright leaves a directory this module
 * reads exactly as it reads a trail that never sealed anything. That is a
 * recorded limitation of the read path, not a clean bill of health for the
 * directory — proving the sidecar itself was not removed needs state kept
 * outside the directory, which this layer does not have.
 * `./append-only-verify.js` is the surface that reports on the manifest as
 * evidence in its own right.
 *
 * Dependency direction is one-way: this module imports the archival, manifest,
 * segment-name and line-failure-port layers, and `./append-only-reader.js`
 * imports this module. Nothing here ever imports the reader.
 *
 * @packageDocumentation
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { isEnoentError } from "../../core/utils/guards.js";
import type { AppendOnlyArchivedSegment } from "./append-only-archival.js";
import { resolveArchivedSegments } from "./append-only-archival.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import { readManifest } from "./append-only-manifest.js";
import type { ParsedSegmentName } from "./append-only-segments.js";
import { parseSegmentName } from "./append-only-segments.js";

/**
 * What {@link planSegmentsToRead} needs in order to plan one read: the
 * directory, the manifest's byte ceiling, the archival policy, and the two
 * error vocabularies a refusal is raised in.
 *
 * **A structural subset of `./append-only-reader.js`'s
 * `AppendOnlyReaderOptions`, deliberately declared here and not imported from
 * it.** Importing that type would point an edge at the reader and close the
 * dependency cycle this seam exists to avoid; it would also hand this module
 * fields it has no business reading — the per-line ceiling and the torn-tail
 * handler belong to the streaming stage. The two still cannot drift apart
 * silently: the reader passes its own options object straight into
 * {@link planSegmentsToRead}, so a field renamed or retyped on either side
 * fails to compile at that one call site.
 */
export interface AppendOnlyReadPlanOptions {
  /** The directory to enumerate segments and read the manifest from. */
  readonly directory: string;
  /** The hard ceiling the directory's `manifest.jsonl` sidecar is read under. */
  readonly maxManifestBytes: number;
  /**
   * Invoked once per sealed-but-absent segment, oldest first. Omitting it is
   * a policy, not a convenience — with no handler the archival layer throws
   * for the first such segment rather than reading short in silence.
   */
  readonly onArchivedSegment?: (segment: AppendOnlyArchivedSegment) => void;
  /** The owner's vocabulary for a listing- or continuity-level refusal. */
  readonly buildError: AppendOnlyReadFailure;
  /**
   * The owner's vocabulary for a MANIFEST-level refusal — an unreadable
   * sidecar, or a sealed segment no longer on disk.
   */
  readonly buildManifestError: AppendOnlyReadFailure;
}

/** One segment discovered on disk, in the order lines will be read from it. */
export interface DiscoveredSegment extends ParsedSegmentName {
  /** The file name exactly as `readdir` reported it. */
  readonly name: string;
  /** The path the reader will open the segment at. */
  readonly path: string;
}

/**
 * A directory listing's outcome: the segments it held, plus whether the
 * directory was there at all — a distinction an empty list cannot carry,
 * since an existing segment-free directory and an absent one both list as
 * nothing.
 */
interface SegmentInventory {
  /** `false` only when the directory itself is absent (`ENOENT`). */
  readonly directoryExists: boolean;
  /** Every parsable segment, oldest `(datePrefix, sequence)` first. */
  readonly segments: readonly DiscoveredSegment[];
}

/**
 * Ascending `(datePrefix, sequence)` order — the order `append()` produced
 * entries in, and the order {@link assertNoSequenceGap} walks.
 *
 * Typed on {@link "./append-only-segments.js".ParsedSegmentName}, not
 * {@link DiscoveredSegment}, so the on-disk listing and the
 * listed-plus-archived union sort through one comparator rather than two. The
 * sequence is compared NUMERICALLY, never inside a file name:
 * `segmentFileName` pads to width four, so a five-digit sequence would sort
 * before `9999`.
 */
function bySegmentOrder(
  left: ParsedSegmentName,
  right: ParsedSegmentName,
): number {
  if (left.datePrefix === right.datePrefix) {
    return left.sequence - right.sequence;
  }
  return left.datePrefix < right.datePrefix ? -1 : 1;
}

/**
 * Lists every segment under `directory`, oldest `(date, sequence)` first.
 *
 * A missing directory yields an empty inventory rather than throwing — a
 * rebuild against a stream that has never been written to is a normal, empty
 * case. Any other failure (`EACCES`, …) is a real problem with a directory
 * that does exist and propagates as the owner's typed error.
 *
 * Proves nothing about completeness on its own. The sequence-gap walk runs in
 * {@link planSegmentsToRead}, which alone knows which absences the manifest
 * accounts for.
 */
async function discoverSegmentsInOrder(
  directory: string,
  buildError: AppendOnlyReadFailure,
): Promise<SegmentInventory> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause) {
    if (isEnoentError(cause)) {
      return { directoryExists: false, segments: [] };
    }
    throw buildError("append-only stream: failed to list segments", {
      cause,
    });
  }

  const segments: DiscoveredSegment[] = [];
  for (const name of names) {
    const parsed = parseSegmentName(name);
    if (parsed !== undefined) {
      segments.push({ ...parsed, name, path: path.join(directory, name) });
    }
  }
  segments.sort(bySegmentOrder);
  return { directoryExists: true, segments };
}

/**
 * Rejects a gap in `(datePrefix, sequence)` within one date: the writer always
 * starts a date's segments at sequence 1 and increments by exactly one on
 * every rotation (`./append-only-segments.js`), so a missing sequence number
 * that nothing accounts for is either an already-deleted segment or one
 * truncated all the way to zero bytes before this date's numbering could roll
 * forward past it — either way, entries this stream once held are unaccounted
 * for.
 *
 * Walks an ACCOUNTING UNION, not the directory listing: the segments found on
 * disk PLUS the sealed-but-absent ones
 * {@link "./append-only-archival.js".resolveArchivedSegments} has already
 * reported, ordered together by {@link bySegmentOrder}. A hole an archival
 * explains is therefore not a gap, while a hole nothing explains still throws.
 * Because the union is the only input that changes, tolerating one archival
 * tolerates exactly that one position — never the continuity check as a whole.
 *
 * **What the union does and does not detect.** The concession this check used
 * to make without qualification — that it cannot detect the deletion of a
 * date's own LAST segment — is now true of only half the cases, and both
 * halves need stating:
 *
 * - A gap BETWEEN two of a date's segments is detected either way. A sealed
 *   missing segment is restored into the union, and its absence is reported by
 *   the manifest consultation ahead of this walk; an unsealed one leaves a
 *   numbering hole this walk throws on.
 * - The deletion of a date's own LAST segment is now DETECTED when that
 *   segment was SEALED. Not by this walk — the union restores contiguity, so
 *   this walk sees nothing wrong — but by the manifest consultation ahead of
 *   it, which reports or refuses the sealed-but-absent name. Before the
 *   manifest sidecar existed this case was undetectable, and for it the old
 *   blanket concession is simply no longer true.
 * - The deletion of a date's own last segment stays INVISIBLE when that
 *   segment was UNSEALED. The survivors still run contiguously from 1, and
 *   nothing left in the directory claims the missing segment ever existed.
 *   That half of the old concession stands unchanged.
 *
 * An actor able to write the directory could still renumber the survivors to
 * close a gap before this check runs — though no longer without contradicting
 * whatever the manifest already sealed. This raises the bar against accidental
 * and casual tampering; it does not prove the directory's contents are
 * complete.
 */
function assertNoSequenceGap(
  segments: readonly ParsedSegmentName[],
  buildError: AppendOnlyReadFailure,
): void {
  let previous: ParsedSegmentName | undefined;
  for (const segment of segments) {
    const expectedSequence =
      previous !== undefined && previous.datePrefix === segment.datePrefix
        ? previous.sequence + 1
        : 1;
    if (segment.sequence !== expectedSequence) {
      throw buildError(
        "append-only stream: a segment sequence number is missing",
        {
          context: {
            datePrefix: segment.datePrefix,
            expectedSequence,
            foundSequence: segment.sequence,
          },
        },
      );
    }
    previous = segment;
  }
}

/**
 * Builds the presence set the archival layer decides absence against: the
 * segment file names `readdir` actually reported, and nothing else.
 *
 * **Name presence ONLY — deliberately no `lstat` — which inverts the trap
 * `./append-only-verify.js` has to avoid, and must stay inverted.** There,
 * absence has to be proven by a direct `lstat` on the claimed path: inferring
 * it from a filtered segment INVENTORY would let a symlink or a hardlink
 * planted at a sealed name read as an honest deletion, because the inventory
 * declines to publish such an entry and the seal would then look like a
 * segment that had merely been archived away.
 *
 * On this read path the danger runs the other way, and resolves itself. This
 * set is built from `readdir` names alone, with no stat of any kind, so a
 * planted symlink at a sealed segment's name IS a member of the set. It is
 * therefore never classified as archived, never silently excused as a
 * deletion, and is refused a few moments later at open time by
 * {@link "./append-only-fs.js".assertSegmentIsReadable}'s post-open `fstat`
 * checks, in the reader's own vocabulary.
 *
 * Switching this to an `lstat`-based presence check would be a regression, not
 * a hardening: it would drop the planted entry out of the set, reclassify the
 * seal as archived, and hand the read path exactly the misclassification the
 * verify path spends an `lstat` per claim to prevent. Leave it reading names.
 */
function presentSegmentNames(
  segments: readonly DiscoveredSegment[],
): ReadonlySet<string> {
  return new Set(segments.map((segment) => segment.name));
}

/**
 * Settles a whole directory's accounting BEFORE a single entry is yielded, and
 * hands back only the segments actually on disk.
 *
 * In order: list and parse the directory's segment names; read the manifest;
 * resolve which of its seals name a segment that is gone; prove continuity
 * over the union of the two. Eager on purpose — an incomplete trail must be
 * refused on the consumer's first `next()`, not midway through a read that has
 * already handed out entries the consumer acted on.
 *
 * A missing DIRECTORY short-circuits before the manifest read: there is no
 * sidecar inside a directory that does not exist, and an `ENOENT` from the
 * listing has already answered the only question planning could ask of it.
 *
 * The archived names feed the gap walk and never the returned list — they are
 * positions the trail accounts for, not files anybody can open.
 *
 * @param options - The directory, the manifest ceiling, the archival policy,
 *   and the two error ports a refusal is raised through.
 * @returns The segments to read, oldest `(date, sequence)` first.
 * @example
 * ```ts
 * import { M3LError } from "@monte3l/m3l-common/core";
 *
 * const buildError = (message: string, options?: { cause?: unknown }) =>
 *   new M3LError(message, { code: "ERR_STORAGE_READ", ...options });
 *
 * const segments = await planSegmentsToRead({
 *   directory,
 *   maxManifestBytes: 1_048_576,
 *   onArchivedSegment: (segment) => {
 *     console.warn("sealed segment no longer on disk", segment.segment);
 *   },
 *   buildError,
 *   buildManifestError: buildError,
 * });
 * ```
 */
export async function planSegmentsToRead(
  options: AppendOnlyReadPlanOptions,
): Promise<readonly DiscoveredSegment[]> {
  const { directoryExists, segments } = await discoverSegmentsInOrder(
    options.directory,
    options.buildError,
  );
  if (!directoryExists) {
    return segments;
  }
  const contents = await readManifest(
    options.directory,
    options.maxManifestBytes,
    options.buildManifestError,
  );
  const archived = resolveArchivedSegments(
    contents,
    presentSegmentNames(segments),
    {
      // Conditional spread rather than a direct assignment: under
      // `exactOptionalPropertyTypes` an optional target field rejects an
      // explicit `undefined`, and ABSENCE here is the policy itself — it is
      // what tells the archival layer to throw instead of report.
      ...(options.onArchivedSegment !== undefined && {
        onArchivedSegment: options.onArchivedSegment,
      }),
      buildManifestError: options.buildManifestError,
    },
  );
  assertNoSequenceGap(
    [...segments, ...archived].sort(bySegmentOrder),
    options.buildError,
  );
  return segments;
}
