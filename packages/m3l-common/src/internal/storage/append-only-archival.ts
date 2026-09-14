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
import type { AppendOnlySealedSegmentPayload } from "./append-only-sealed-payload.js";
import { toSealedSegmentPayload } from "./append-only-sealed-payload.js";
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
 * How one {@link resolveArchivedSegments} call reports what it finds: an
 * optional handler, and the owner's error vocabulary for when there is none.
 */
export interface AppendOnlyArchivalPolicy {
  /**
   * Invoked once per archived segment, oldest first. **Omitting it is a
   * policy in its own right**, not a convenience default: a caller that
   * supplies no handler has said nothing may silently be missing from the
   * trail, and {@link resolveArchivedSegments} throws instead.
   *
   * **Called synchronously, and a thenable it returns is NOT observed here.**
   * {@link resolveArchivedSegments} performs no I/O and is not `async` — the
   * property that keeps every one of its branches reachable from an
   * in-memory fixture — so it has no point at which it could wait for a
   * handler's promise. A caller whose handler may return one must wrap it
   * before passing it in and settle the outcome itself;
   * `./append-only-read-plan.js`'s `createArchivalReporter` is the read
   * path's one implementation of that, and it exists because a rejection
   * nobody attends reaches the caller as neither a thrown error nor an
   * attached one: it is reported to `process` from outside every caller
   * frame, which under Node's default `--unhandled-rejections=throw` can end
   * the process.
   */
  readonly onArchivedSegment?: (
    segment: AppendOnlySealedSegmentPayload,
  ) => void;
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
      // A segment name is the one caller-adjacent value sanctioned to travel
      // in `context`: it is rendered entirely from the writer's own clock and
      // counter, so it carries no entry data and nothing a caller supplied.
      // (Library-computed facts travel too — see `resolveArchivedSegments`'s
      // `archivedCount` — but there is no count to report about one
      // unparsable name.)
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
 * `buildManifestError`. The message is a constant; `context` carries the
 * segment name — the one caller-adjacent value sanctioned here, because a
 * segment name is rendered from the writer's clock and counter alone — plus
 * `archivedCount`, how many segments this call found archived in all.
 *
 * The count travels beside the name because the name alone is not
 * actionable: one archived segment and a whole vanished date raise the
 * identical error, and an operator handed a single file name cannot tell
 * which of the two they are looking at. It is library-computed — the length
 * of this call's own archived list, never a tally of `contents.seals`, since
 * a seal still on disk is not a finding — so it carries no caller data and
 * joins the name under the same rule. It is unconditional: a lone archival
 * still reports `archivedCount: 1`.
 *
 * **A throwing handler propagates unchanged, aborting the walk**: not
 * swallowed, not wrapped, not re-routed through `buildManifestError`. This
 * deliberately differs from `./append-only-sealer.js`'s `onSealFailed`,
 * which swallows a throwing handler because the sealer owes its caller a
 * never-throws append path. The read path owes no such contract, and
 * silently continuing past a reporting handler that just failed would mean
 * losing the very notifications the handler exists to receive.
 *
 * That covers a SYNCHRONOUS throw only. A promise the handler returns is
 * neither awaited nor attached to here — see
 * {@link AppendOnlyArchivalPolicy.onArchivedSegment} for why this function
 * cannot, and which caller owns settling it instead.
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
      // See this function's TSDoc: constant message, segment name and
      // archived count in `context`, and only ever for the first finding in
      // read order. The count is `archived.length`, NOT `contents.seals.size`
      // — a seal still present on disk is not a finding, so a seal tally
      // would report a number this error is not about.
      throw policy.buildManifestError(ARCHIVED_SEGMENT_MESSAGE, {
        context: {
          segment: entry.record.segment,
          archivedCount: archived.length,
        },
      });
    }
    onArchivedSegment(toSealedSegmentPayload(entry.record));
  }
  return archived.map((entry) => entry.parsed);
}
