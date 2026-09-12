/**
 * `internal/storage/append-only-seal-attempt` — the BOUNDED RETRY around
 * measuring one segment and appending its claim, factored out of
 * `./append-only-sealer.js` so that sealer's file stays within the per-file
 * size ratchet (ADR-0072) without trimming the reasoning either module
 * carries.
 *
 * Library-internal; never re-exported through a public barrel. This module
 * issues no filesystem primitive of its own either — the measurement is
 * `./append-only-digest.js`'s and the append is `./append-only-manifest.js`'s;
 * this module only owns the retry loop and the ordering constraint around
 * the two calls.
 *
 * **The measurement is taken at most once; the claim it produces is what
 * every retried append carries.** {@link measureSegment} and
 * {@link appendClaim} are deliberately two separate bounded loops rather than
 * one loop retrying "digest-and-append" as a whole, because a retry against a
 * FRESH digest is the defect this split exists to prevent: if `appendSeal`
 * failed AFTER its line already reached the manifest — a write that lands but
 * whose confirmation is lost — and the segment changed between attempts (a
 * rotation, a concurrent writer), a re-digested retry's line would disagree
 * with the one already on disk. `./append-only-manifest.js` documents that a
 * segment named by two disagreeing seals throws at read time, so a
 * best-effort path that must never fail an append would have made the whole
 * trail unreadable. Holding the one claim {@link measureSegment} produced
 * fixed across every {@link appendClaim} attempt makes a retry-born duplicate
 * agree with the original by construction, never merely by chance.
 *
 * @packageDocumentation
 */

import path from "node:path";

import { digestSegmentFile } from "./append-only-digest.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import { appendSeal } from "./append-only-manifest.js";
import type { SegmentSealClaim } from "./append-only-manifest.js";
import type { ManifestSealRecord } from "./append-only-manifest-records.js";

/**
 * Reported when a rotated segment's fresh measurement disagrees with the
 * claim the manifest already records for it. Never written to the manifest —
 * see {@link corroborateClaim}.
 */
const SEAL_DISAGREEMENT_MESSAGE =
  "append-only stream: a rotated segment's measurement disagrees with its recorded seal";

/**
 * A bounded retry loop's outcome: success, or the last failure once every
 * attempt is spent. Shared by {@link measureSegment} and {@link appendClaim}
 * so both report failure the same way.
 */
export type SealAttemptOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: unknown };

/** Everything {@link measureSegment} needs to measure one segment. */
export interface MeasureSegmentOptions {
  /** The stream directory holding the segment. */
  readonly directory: string;
  /** The segment's file name, already accepted by the caller. */
  readonly segment: string;
  /** The digest ceiling: `maxSegmentBytes + maxLineBytes`. */
  readonly maxDigestBytes: number;
  /** How many times this segment's measurement is attempted. */
  readonly maxSealAttempts: number;
  /** The owner's error vocabulary for a digest that cannot be taken. */
  readonly buildError: AppendOnlyReadFailure;
}

/**
 * Measures `options.segment` up to `options.maxSealAttempts` times,
 * returning the first successful {@link SegmentSealClaim} or the last
 * failure once attempts are spent.
 *
 * This is where the transient failure worth surviving actually lives — a
 * read error on an otherwise healthy file. Isolated from {@link appendClaim}
 * on purpose: a re-digest belongs to THIS attempt only, and must never leak
 * into a retry of the append half — see `./append-only-sealer.js`'s
 * `#sealSegment` for why a fresh measurement on an append retry is the
 * defect this split prevents. This module issues no filesystem call of its
 * own; the measurement is deliberately a re-read of what is ON DISK rather
 * than an incremental hash maintained while appending: the latter could not
 * cover an adopted segment, a crashed process's segment, or two interleaved
 * writers, and would prove "what I wrote" rather than "what is there" —
 * inverting the point of a tamper proof (ADR-0102).
 */
export async function measureSegment(
  options: MeasureSegmentOptions,
): Promise<SealAttemptOutcome<SegmentSealClaim>> {
  const { directory, segment, maxDigestBytes, maxSealAttempts, buildError } =
    options;
  let lastFailure: unknown;
  for (let attempt = 0; attempt < maxSealAttempts; attempt += 1) {
    try {
      const digest = await digestSegmentFile(
        path.join(directory, segment),
        maxDigestBytes,
        buildError,
      );
      return { ok: true, value: { segment, ...digest } };
    } catch (cause) {
      lastFailure = cause;
    }
  }
  return { ok: false, failure: lastFailure };
}

/** Everything {@link corroborateClaim} needs to corroborate one segment. */
export interface CorroborateClaimOptions {
  /** The stream directory holding the segment. */
  readonly directory: string;
  /** The segment's file name, already accepted by the caller. */
  readonly segment: string;
  /** The claim the manifest already records for `segment`. */
  readonly existing: ManifestSealRecord;
  /** The digest ceiling: `maxSegmentBytes + maxLineBytes`. */
  readonly maxDigestBytes: number;
  /** How many times this segment's measurement is attempted. */
  readonly maxSealAttempts: number;
  /** The owner's error vocabulary for a digest that cannot be taken. */
  readonly buildError: AppendOnlyReadFailure;
}

/**
 * Re-measures `options.segment` and compares the result against
 * `options.existing`, the claim the manifest already records for it.
 *
 * Success means "agrees" (nothing further to write); failure carries either
 * the measurement's own failure or a freshly built disagreement error — the
 * caller reports either the same way and writes neither to the manifest, so
 * a rotated segment a forged claim was planted for gets contradicted instead
 * of silently trusted by membership.
 *
 * **Compares `(entryCount, byteLength, sha256)` only — never `at`, and never
 * the whole record.** `at` is a timestamp the writer stamps fresh each time
 * and differs by construction between any two measurements, so folding it
 * into the comparison (or comparing serialized whole records) would make
 * every corroboration report a disagreement, an automatic false positive —
 * exactly the trap `./append-only-manifest.js` already documents for the
 * duplicate-seal rule on the read side.
 */
export async function corroborateClaim(
  options: CorroborateClaimOptions,
): Promise<SealAttemptOutcome<void>> {
  const {
    directory,
    segment,
    existing,
    maxDigestBytes,
    maxSealAttempts,
    buildError,
  } = options;
  const measurement = await measureSegment({
    directory,
    segment,
    maxDigestBytes,
    maxSealAttempts,
    buildError,
  });
  if (!measurement.ok) {
    return { ok: false, failure: measurement.failure };
  }
  const agrees =
    existing.entryCount === measurement.value.entryCount &&
    existing.byteLength === measurement.value.byteLength &&
    existing.sha256 === measurement.value.sha256;
  return agrees
    ? { ok: true, value: undefined }
    : { ok: false, failure: buildError(SEAL_DISAGREEMENT_MESSAGE) };
}

/** Everything {@link appendClaim} needs to append one claim. */
export interface AppendClaimOptions {
  /** The stream directory holding the manifest. */
  readonly directory: string;
  /** The ONE claim {@link measureSegment} produced; never re-measured. */
  readonly claim: SegmentSealClaim;
  /** How many times this claim's append is attempted. */
  readonly maxSealAttempts: number;
  /** The owner's error vocabulary for an append that cannot be written. */
  readonly buildError: AppendOnlyReadFailure;
}

/**
 * Appends the ONE claim {@link measureSegment} produced, up to
 * `options.maxSealAttempts` times, never re-measuring.
 *
 * Holding `options.claim` fixed across every attempt is the guarantee this
 * function exists to provide: whichever attempt lands, the line it writes is
 * byte-for-byte the same claim, so a retry that succeeds after an earlier
 * attempt's write already reached the manifest can only ever produce an
 * AGREEING duplicate, never a disagreeing one.
 */
export async function appendClaim(
  options: AppendClaimOptions,
): Promise<SealAttemptOutcome<void>> {
  const { directory, claim, maxSealAttempts, buildError } = options;
  let lastFailure: unknown;
  for (let attempt = 0; attempt < maxSealAttempts; attempt += 1) {
    try {
      await appendSeal(directory, claim, buildError);
      return { ok: true, value: undefined };
    } catch (cause) {
      lastFailure = cause;
    }
  }
  return { ok: false, failure: lastFailure };
}
