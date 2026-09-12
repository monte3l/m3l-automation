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
 * about, exactly as `./append-only-manifest-baseline.js`'s `highestSegmentName`
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

/**
 * The inputs {@link selectSweepCandidates} filters the on-disk inventory
 * against. Every field is an already-known value, not the sealer's own
 * state, which is what keeps the function a pure computation a test can
 * call directly instead of one only reachable through filesystem fixtures.
 */
export interface SweepAdmission {
  /**
   * `./append-only-segments.js`'s `currentDatePrefix()` at sweep time — a
   * candidate must be STRICTLY older than this to admit.
   */
  readonly today: string;
  /**
   * The writer's own in-progress segment name, excluded by NAME — see
   * {@link selectSweepCandidates} for exactly what that closes and does
   * not.
   */
  readonly active: string;
  /**
   * Segment names the manifest already records a seal for. A segment
   * sealed already — by this call's own rotation seal or by a prior one —
   * must not be swept a second time.
   */
  readonly sealed: ReadonlySet<string>;
  /**
   * {@link baselineBoundaryKey}'s result: `undefined` when the trail states
   * no legacy boundary, else the order key a segment must sort strictly
   * after to admit.
   */
  readonly boundaryKey: string | undefined;
  /**
   * The sweep's per-call ceiling — see {@link selectSweepCandidates} for why
   * it is applied to the candidate list before any candidate is opened.
   */
  readonly limit: number;
}

/**
 * Selects the segments one cold-start sweep may seal: the on-disk inventory
 * minus manifest-named, minus at-or-before-baseline, minus today's date,
 * oldest first and capped at {@link SweepAdmission.limit}.
 *
 * **Admits only a STRICTLY OLDER date prefix than
 * {@link SweepAdmission.today}.** The looser-looking rule "today's segments
 * below the highest sequence" is rejected outright: writer A can sit at
 * sequence 3 while writer B creates sequence 4, so B's sweep would digest a
 * prefix of a file A is still appending to — a false positive on a tamper
 * guard, the worst failure this design can have. The strict rule is airtight
 * instead, because `shouldRotate`'s date check forces any conforming writer
 * off a non-today segment on its next write and `discoverActiveSegment` only
 * ever adopts today's prefix.
 *
 * **Naming the writer's own `active` segment excludes it from that same
 * sweep, closing part of a narrower gap: a clock that steps FORWARD past
 * midnight.** `currentDatePrefix()` would then advance while this writer is
 * still appending to the segment it holds, and the strict-older rule alone
 * would admit it. Excluding it by NAME — the one thing this process can
 * swear to, rather than infer from a clock — closes that window for THIS
 * writer only. It does NOT close it for a second writer process whose clock
 * runs behind this one's: that writer's own active segment can still be
 * swept here, because this process has no way to know its name. That is a
 * residual clock-trust limitation of the design, not a defect this filter
 * removes.
 *
 * **`limit` caps the CANDIDATE list, before any candidate is opened.** That
 * bounds the READS and not merely the manifest lines a sweep would go on to
 * write, which is what actually stops a pathological directory from turning
 * one cold start into an unbounded read. On a healthy trail the whole
 * computation costs one manifest read and ZERO segment bytes re-read — a
 * performance contract the writer depends on, since the sweep runs on the
 * append path.
 *
 * @param segments - The directory's segment inventory, in the order the
 *   caller's listing already sorts it.
 * @param admission - See {@link SweepAdmission} for each field's role.
 * @returns The admitted segments, oldest first, `admission.limit` at most.
 * @example
 * ```ts
 * const candidates = selectSweepCandidates(segments, {
 *   today: currentDatePrefix(),
 *   active: activeSegmentName,
 *   sealed: new Set(contents.seals.keys()),
 *   boundaryKey: baselineBoundaryKey(contents),
 *   limit: 64,
 * });
 * ```
 */
export function selectSweepCandidates(
  segments: readonly M3LAppendOnlySegment[],
  admission: SweepAdmission,
): readonly M3LAppendOnlySegment[] {
  return segments
    .filter(
      (segment) =>
        segment.datePrefix < admission.today &&
        segment.name !== admission.active &&
        !admission.sealed.has(segment.name) &&
        !isAtOrBeforeBaseline(segment, admission.boundaryKey),
    )
    .slice(0, admission.limit);
}
