/**
 * `internal/storage/append-only-sweep-policy` — the sweep's ORDERING and
 * LEGACY-BOUNDARY policy, factored out of `./append-only-sealer.js` so that
 * sealer's file stays within the per-file size ratchet (ADR-0072) without
 * trimming the reasoning either module carries.
 *
 * Library-internal; never re-exported through a public barrel. Every export
 * here is a PURE function over already-parsed values (a segment's
 * `(datePrefix, sequence)`, a manifest's baseline record) — no I/O, no
 * `this`, no dependency on `./append-only-sealer.js`'s state. That is
 * deliberate: the sealer decides WHEN and WHETHER to seal; this module only
 * answers WHERE a segment sits relative to the rest of the trail, a question
 * `./append-only-sealer.js`'s cold-start sweep and (later) `verify()` both
 * need answered the same way.
 *
 * @packageDocumentation
 */

import type { M3LAppendOnlySegment } from "../../core/storage/append-only-read-types.js";
import type { ManifestContents } from "./append-only-manifest.js";
import { parseSegmentName } from "./append-only-segments.js";

/**
 * The zero-padded width a sequence number is rendered at when two segment
 * names are ORDERED as strings. Wide enough that the padding, not the digit
 * count, decides the comparison — `padStart(4)` would order `9999` after
 * `10000`, which is the ordering `./append-only-segments.js`'s numeric sort
 * already rejects.
 */
const SEQUENCE_KEY_WIDTH = 12;

/**
 * Renders one segment's `(datePrefix, sequence)` as a string that sorts the
 * way `./append-only-segments.js` sorts the inventory.
 *
 * A single comparable key rather than a two-field tuple comparison on
 * purpose: one `<=` states "at or before" in one place, where the tuple form
 * spreads the same rule across three conditions that must agree.
 */
export function segmentOrderKey(datePrefix: string, sequence: number): string {
  return `${datePrefix}-${String(sequence).padStart(SEQUENCE_KEY_WIDTH, "0")}`;
}

/**
 * The sweep's legacy boundary as an order key, or `undefined` when the
 * manifest states none.
 *
 * `?? ""` folds three states into that one answer, and each is the same
 * answer for the same reason: no baseline record at all, a baseline stating
 * `upTo: null` (sealing has been in force since the stream's first segment),
 * and a baseline naming something {@link parseSegmentName} declines — a name
 * no writer here renders is not a boundary this trail can state anything
 * about, exactly as `./append-only-manifest.js`'s `highestSegmentName`
 * refuses to derive one from a foreign file. The empty string is not a
 * segment name, so it parses as `undefined` like any other foreign name.
 */
export function baselineBoundaryKey(
  contents: ManifestContents,
): string | undefined {
  const parsed = parseSegmentName(contents.baseline?.upTo ?? "");
  return parsed === undefined
    ? undefined
    : segmentOrderKey(parsed.datePrefix, parsed.sequence);
}

/**
 * `true` when `segment` falls at or before the baseline, and so is `legacy`:
 * bytes written before sealing was in force, which a digest taken NOW cannot
 * vouch for. Retro-digesting one would state a proof nobody can honour.
 */
export function isAtOrBeforeBaseline(
  segment: M3LAppendOnlySegment,
  boundaryKey: string | undefined,
): boolean {
  return (
    boundaryKey !== undefined &&
    segmentOrderKey(segment.datePrefix, segment.sequence) <= boundaryKey
  );
}
