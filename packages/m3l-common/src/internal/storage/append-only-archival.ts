/**
 * `internal/storage/append-only-archival` — the read path's ARCHIVAL
 * accounting (ADR-0102, X8b slice 4c): given a directory's already-parsed
 * `manifest.jsonl` contents and the set of segment names actually present on
 * disk, which sealed segments are gone, how each one is reported, and the
 * parsed names the reader's sequence-gap walk may then treat as accounted
 * for rather than as a hole in the trail.
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * **Synchronous, and performs no I/O of its own — deliberately.** The
 * manifest read and the directory listing both stay with the reader that
 * already does them, so this module is a pure computation over values its
 * caller already holds. That is what makes every branch below reachable from
 * an in-memory fixture, including the malformed-name refusal in
 * {@link resolveArchivedSegments} that the real manifest parser
 * (`ownSealSegment`, `./append-only-manifest-records.js`) already rules out
 * long before a record could reach here. A branch only a corrupted
 * filesystem could reach is a branch nobody can test; keeping the I/O out
 * moves that line.
 *
 * **Ordering is `./append-only-sweep-policy.js`'s to state**, not this
 * module's: `segmentOrderKey` is reused verbatim, exactly as
 * `./append-only-verify.js` reuses it for its verdict order. A second
 * comparator here would be a second chance to sort by file name, and a file
 * name sorts `2026-09-11-10000.jsonl` BEFORE `2026-09-11-9999.jsonl` —
 * `segmentFileName` pads to width four, so a sequence above four digits is
 * rendered unpadded and lexicographic order stops agreeing with the writer's
 * own counter.
 *
 * @packageDocumentation
 */

import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import type {
  ManifestContents,
  ManifestSealRecord,
} from "./append-only-manifest-records.js";
import type { ParsedSegmentName } from "./append-only-segments.js";
import { parseSegmentName } from "./append-only-segments.js";
import { segmentOrderKey } from "./append-only-sweep-policy.js";

/**
 * Reported when the manifest claims a segment that is no longer on disk and
 * the caller supplied no {@link AppendOnlyArchivalPolicy.onArchivedSegment}
 * to hear about it.
 *
 * A constant: the message text itself never carries a value read out of the
 * stream's directory, in the register
 * {@link "./append-only-lines.js".AppendOnlyReadFailure} requires of every
 * caller of the port.
 */
const ARCHIVED_SEGMENT_MESSAGE =
  "append-only stream: a sealed segment is no longer present in the stream directory";

/** Reported when a seal names something this writer's segment layer never rendered. */
const UNPARSABLE_SEAL_SEGMENT_MESSAGE =
  "append-only stream: the manifest claims a name that is not a segment file name";

/**
 * One sealed segment the trail no longer holds, exactly as the manifest
 * stated it: which segment, when the seal was stamped, and the three numbers
 * it measured.
 *
 * **A structural mirror of the public
 * {@link "../../core/storage/append-only-verify-types.js".M3LAppendOnlySealedSegment},
 * and NOT an import of it — leave it that way.** The same deliberate
 * duplication `./append-only-reader.js`'s `AppendOnlyTruncatedSegment`
 * carries against `M3LAppendOnlyTruncatedSegment`, for the same reason: an
 * `internal/` module that never names a public type imposes nothing on a
 * second owner wanting the same payload shape, and the public type stays
 * free to gain documentation, deprecations or a semver-gated field without
 * that being a change to this read-path helper. The two are kept in step by
 * a type-level test (`storage-append-only-archival.test.ts`, C10) asserting
 * the two are exactly equal, which is what makes the mirror safe rather than
 * merely convenient — so a "simplification" into an import is a regression,
 * not a cleanup.
 */
export interface AppendOnlyArchivedSegment {
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
 * Projects an internal `ManifestSealRecord` down to the five fields a caller
 * is told about.
 *
 * **A fresh object literal naming all five fields, never the record itself.**
 * `ManifestSealRecord` is a structural superset — it also carries `kind` and
 * the manifest's own `formatVersion` — so assigning it straight into a
 * five-field slot type-checks and still hands every caller those extra
 * fields at runtime, including in `JSON.stringify` output. That exact
 * oversight shipped once in this wave; a literal is what makes the narrowing
 * true at runtime and not merely at the type level.
 *
 * Shared with `./append-only-verify.js`, which needs the same projection for
 * its `sealed` verdict payload: one definition, so the public shape and the
 * internal record can only drift apart in one place.
 *
 * @param record - The seal record as the manifest states it.
 * @returns Exactly the five fields, in a new object.
 * @example
 * ```ts
 * const payload = toArchivedSegment(record);
 * // => { segment, at, entryCount, byteLength, sha256 } — nothing else
 * ```
 */
export function toArchivedSegment(
  record: ManifestSealRecord,
): AppendOnlyArchivedSegment {
  return {
    segment: record.segment,
    at: record.at,
    entryCount: record.entryCount,
    byteLength: record.byteLength,
    sha256: record.sha256,
  };
}

/**
 * How one {@link resolveArchivedSegments} call reports what it finds: an
 * optional handler, and the owner's error vocabulary for when there is none.
 */
export interface AppendOnlyArchivalPolicy {
  /**
   * Invoked once per archived segment, oldest first. **Omitting it is a
   * policy in its own right**, not a convenience default: a caller that
   * supplies no handler has said nothing may silently be missing from the
   * trail, and {@link resolveArchivedSegments} throws instead.
   */
  readonly onArchivedSegment?: (segment: AppendOnlyArchivedSegment) => void;
  /** The owner's vocabulary for a manifest-level refusal. */
  readonly buildManifestError: AppendOnlyReadFailure;
}

/** One archived segment, paired with the key it sorts by and its parsed name. */
interface OrderedArchival {
  readonly orderKey: string;
  readonly parsed: ParsedSegmentName;
  readonly record: ManifestSealRecord;
}

/**
 * Ascending comparison on the already-comparable, fixed-width order key.
 *
 * No tie arm, because a tie cannot occur: `contents.seals` is keyed by
 * segment name, so every record here has a distinct name, and
 * `segmentOrderKey` is one-to-one with a name's `(datePrefix, sequence)`.
 */
function byOrderKey(a: OrderedArchival, b: OrderedArchival): number {
  return a.orderKey < b.orderKey ? -1 : 1;
}

/**
 * Every seal whose segment is absent from `presentSegments`, in the writer's
 * own order.
 *
 * **The baseline is not consulted, and that is the point.** A seal outranks
 * the baseline: a manifest stating a boundary at some LATER segment must not
 * suppress a finding about an earlier sealed segment that has since
 * vanished. This is the precedence
 * {@link "../../core/storage/append-only-verify-types.js".M3LAppendOnlyVerificationStatus}
 * pins for `verify()`, held here by construction — there is no baseline
 * branch for a later edit to reorder. The attack it closes is recorded
 * there: anyone who can append one well-formed `baseline` line to the
 * manifest could otherwise switch the whole detector off.
 *
 * A seal whose name does not parse is refused rather than skipped. It is
 * defence in depth — `ownSealSegment` already declines such a record when
 * the manifest is parsed — but skipping one would drop a claimed segment out
 * of the caller's gap walk without anybody being told.
 */
function collectArchived(
  contents: ManifestContents,
  presentSegments: ReadonlySet<string>,
  buildManifestError: AppendOnlyReadFailure,
): OrderedArchival[] {
  const archived: OrderedArchival[] = [];
  for (const [name, record] of contents.seals) {
    if (presentSegments.has(name)) {
      continue;
    }
    const parsed = parseSegmentName(name);
    if (parsed === undefined) {
      // A segment name is the one value sanctioned to travel in `context`:
      // it is rendered entirely from the writer's own clock and counter, so
      // it carries no entry data and nothing a caller supplied.
      throw buildManifestError(UNPARSABLE_SEAL_SEGMENT_MESSAGE, {
        context: { segment: name },
      });
    }
    archived.push({
      orderKey: segmentOrderKey(parsed.datePrefix, parsed.sequence),
      parsed,
      record,
    });
  }
  return archived.sort(byOrderKey);
}

/**
 * Decides which of a manifest's sealed segments are no longer on disk,
 * reports each one, and returns their parsed names oldest first so the
 * caller's sequence-gap walk can treat those positions as accounted for
 * rather than as unexplained holes.
 *
 * Results and handler calls both ascend by `(datePrefix, sequence)`,
 * numerically — see this module's header for why a file-name sort is the
 * wrong answer above four sequence digits.
 *
 * **With no {@link AppendOnlyArchivalPolicy.onArchivedSegment}, throws** for
 * the FIRST archived segment in that order, through the owner's own
 * `buildManifestError`. The message is a constant and the segment name
 * travels in `context` instead — the one caller-adjacent value sanctioned
 * here, because a segment name is rendered from the writer's clock and
 * counter alone.
 *
 * **A throwing handler propagates unchanged, aborting the walk**: not
 * swallowed, not wrapped, not re-routed through `buildManifestError`. This
 * deliberately differs from `./append-only-sealer.js`'s `onSealFailed`,
 * which swallows a throwing handler because the sealer owes its caller a
 * never-throws append path. The read path owes no such contract, and
 * silently continuing past a reporting handler that just failed would mean
 * losing the very notifications the handler exists to receive.
 *
 * @param contents - The manifest's already-parsed contents; its `baseline`
 *   is deliberately ignored (see {@link collectArchived}).
 * @param presentSegments - Segment names actually on disk. A seal named here
 *   is not archived; a seal absent from it is.
 * @param policy - How to report findings — see
 *   {@link AppendOnlyArchivalPolicy}.
 * @returns The archived segments' parsed names, oldest first.
 * @example
 * ```ts
 * import { M3LError } from "@monte3l/m3l-common/core";
 *
 * const accountedFor = resolveArchivedSegments(
 *   contents,
 *   new Set(segments.map((segment) => segment.name)),
 *   {
 *     onArchivedSegment: (segment) => {
 *       console.warn("sealed segment no longer on disk", segment);
 *     },
 *     buildManifestError: (message, options) =>
 *       new M3LError(message, { code: "ERR_STORAGE_READ", ...options }),
 *   },
 * );
 * ```
 */
export function resolveArchivedSegments(
  contents: ManifestContents,
  presentSegments: ReadonlySet<string>,
  policy: AppendOnlyArchivalPolicy,
): readonly ParsedSegmentName[] {
  const archived = collectArchived(
    contents,
    presentSegments,
    policy.buildManifestError,
  );
  const { onArchivedSegment } = policy;
  for (const entry of archived) {
    if (onArchivedSegment === undefined) {
      // See this function's TSDoc: constant message, segment name in
      // `context`, and only ever for the first finding in read order.
      throw policy.buildManifestError(ARCHIVED_SEGMENT_MESSAGE, {
        context: { segment: entry.record.segment },
      });
    }
    onArchivedSegment(toArchivedSegment(entry.record));
  }
  return archived.map((entry) => entry.parsed);
}
