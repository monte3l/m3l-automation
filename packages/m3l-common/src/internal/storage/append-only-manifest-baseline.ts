/**
 * `internal/storage/append-only-manifest-baseline` — the sealed-segment
 * manifest's BASELINE policy: how far back an already-written trail is
 * classified unproven, and the one record that states it (ADR-0102, X8b
 * slice 4).
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * the manifest's record I/O (`./append-only-manifest.js`) under ADR-0072's
 * per-file ratchet: that module's bounded guarded read, the append of one
 * record, and the rationale the `activeSegment` parameter earned had grown
 * past what one file can hold. The dependency runs ONE way —
 * `./append-only-manifest.js` imports {@link buildBaselineRecord} for the
 * one baseline `loadOrInitializeManifest` writes on a stream's first call —
 * and nothing here opens, reads or appends a file; that stays with the I/O
 * module, which both appends the record this module builds and reads it
 * back through `./append-only-manifest-records.js`.
 *
 * @packageDocumentation
 */

import type { M3LAppendOnlySegmentListing } from "../../core/storage/append-only-read-types.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import type { ManifestBaselineRecord } from "./append-only-manifest-records.js";
import { MANIFEST_FORMAT_VERSION } from "./append-only-manifest-records.js";
import { currentDatePrefix, listSegmentFiles } from "./append-only-segments.js";

/** Reported when the stream directory cannot be listed for the baseline. */
const LISTING_FAILURE_MESSAGE =
  "append-only stream: failed to list segments while initializing the manifest";

/**
 * The highest segment name in `directory` dated no later than today, or
 * `null` when it holds none.
 *
 * Reuses `./append-only-segments.js`'s inventory rather than walking the
 * directory a second time, so "a segment" means exactly what it means
 * everywhere else in this stream: a name this writer would itself have
 * produced. A foreign file — `notes.txt`, or an over-padded `-00005.jsonl` no
 * writer here renders — is not a boundary this trail can state anything
 * about.
 *
 * A segment dated AFTER {@link currentDatePrefix}'s today is excluded before
 * the highest is taken, even though it is otherwise a well-formed name. This
 * trail cannot have written it yet, so it is not evidence of how far back an
 * already-written trail is unproven — a future-dated name planted ahead of
 * the first sealer run would otherwise become the baseline forever, writing
 * off every real segment, past and future, as `legacy`. The same exclusion
 * is also the right call for an honestly clock-skewed peer: excluding its
 * segment costs it nothing but a delay, since it is swept and sealed once its
 * date arrives rather than being written off as unproven now. `segments` is
 * already sorted oldest-first, so filtering preserves order and the highest
 * eligible entry is still the last one.
 *
 * `activeSegment` is excluded too: those bytes are THIS sealing writer's own
 * — `legacy` would misstate its own work — sealed once it rotates off, like
 * any segment. Fresh trail: hence `upTo: null`, not the writer's own
 * just-created name. Pre-upgrade trail (`0001..0050` on disk, `0050`
 * adopted as active): baseline moves to `0049`, so `0050` becomes sweepable
 * — not a new exposure, since `0050` was always going to be digested by the
 * rotation seal once rotated off (rotation ignores the baseline); this only
 * makes sweep and rotation agree. `0001..0049` stay at-or-before the
 * baseline: a digest now still cannot vouch for pre-upgrade bytes. The `<=`
 * in `isAtOrBeforeBaseline` (`./append-only-sweep-policy.js`) excludes the
 * boundary segment itself from the sweep — load-bearing, since it lets
 * `activeSegment` sit one below the true highest name harmlessly.
 */
async function highestSegmentName(
  directory: string,
  buildError: AppendOnlyReadFailure,
  activeSegment: string,
): Promise<string | null> {
  let listing: M3LAppendOnlySegmentListing;
  try {
    listing = await listSegmentFiles(directory);
  } catch (cause) {
    throw buildError(LISTING_FAILURE_MESSAGE, { cause });
  }
  const today = currentDatePrefix();
  const eligible = listing.segments.filter(
    (segment) => segment.datePrefix <= today && segment.name !== activeSegment,
  );
  return eligible.at(-1)?.name ?? null;
}

/**
 * Builds the ONE `baseline` record a fresh manifest should hold, without
 * appending it.
 *
 * `kind`, `formatVersion` and `at` are stamped here rather than accepted from
 * a caller, for the same reason as `./append-only-manifest.js`'s
 * `appendSeal`: a record's format version is a statement about the reader
 * that must be able to read it, and its instant is an observation — neither
 * is the sealer's to supply. `upTo` is {@link highestSegmentName}'s result —
 * see that function for what a fresh trail (`upTo: null`) versus a
 * pre-upgrade trail each yield, why the writer's own active segment is
 * excluded from the search, and why the `<=` in `isAtOrBeforeBaseline`
 * (`./append-only-sweep-policy.js`) then excludes the boundary segment
 * itself from the sweep.
 *
 * Returns the record rather than appending it: appending goes through
 * `./append-only-manifest.js`'s own `appendRecord`, the same write path
 * `appendSeal` uses, so both record kinds share one write path and one
 * `O_APPEND`/`O_NOFOLLOW`/owner-only guarantee.
 *
 * @param directory - The stream directory whose segments determine `upTo`.
 * @param buildError - The caller's error vocabulary for every failure here.
 * @param activeSegment - The caller's active segment; see
 *   {@link highestSegmentName}.
 * @returns The baseline record to append, unwritten.
 */
export async function buildBaselineRecord(
  directory: string,
  buildError: AppendOnlyReadFailure,
  activeSegment: string,
): Promise<ManifestBaselineRecord> {
  return {
    kind: "baseline",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at: new Date().toISOString(),
    upTo: await highestSegmentName(directory, buildError, activeSegment),
  };
}
