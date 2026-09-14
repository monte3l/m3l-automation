/**
 * `internal/storage/append-only-verify` — the append-only stream's bounded
 * audit-trail verification engine (ADR-0102, X8b slice 4b): re-digesting every
 * segment the directory's `manifest.jsonl` sidecar makes a claim about, and
 * classifying every segment — claimed or not — into one of five verdicts,
 * oldest first, never throwing on a damaged trail.
 *
 * Library-internal; never re-exported through a public barrel. Reached only
 * by `../../core/storage/M3LAppendOnlyStream.js`'s public `verify()`.
 *
 * **C1 — this engine never throws**, except for the two ceiling-misuse
 * rejections in {@link assertValidCeilings}, which run before either
 * `./append-only-segments.js`'s `listSegmentFiles` or
 * `./append-only-manifest.js`'s `readManifest` ever touches the filesystem. A
 * verification that itself throws on a damaged trail is useless exactly when
 * the damage is why an operator reached for it: every other failure this
 * module can observe becomes an entry in `failures` instead. The two ceiling
 * checks are misuse of the call, not a finding about a trail, so they are the
 * one thing this module still refuses loudly — and they are refused through
 * `buildManifestError`, the same vocabulary `./append-only-digest.js`'s
 * `digestSegmentFile` and `./append-only-manifest.js`'s `readManifest` use for
 * their own identical ceiling checks.
 *
 * **C2 — precedence.** A seal outranks the baseline: a segment the manifest
 * claims is verified against that claim regardless of where the baseline's
 * boundary falls, and `"legacy"` requires both at-or-before the boundary AND
 * the absence of a claim. See
 * {@link "../../core/storage/append-only-verify-types.js".M3LAppendOnlyVerificationStatus}'s
 * own TSDoc for the attack this closes; this module holds the precedence by
 * construction — the claimed-segment loop below and the unclaimed-segment
 * loop are two disjoint passes over two disjoint name sets (every claimed
 * name is excluded from the unclaimed pass), so there is no shared branch
 * order for a later edit to invert.
 *
 * **C3/C4 — ordering and the boundary** are `./append-only-sweep-policy.js`'s
 * to state: `segmentOrderKey` and `baselineBoundaryKey` are reused verbatim,
 * never hand-rolled, per that module's own header naming this engine as its
 * second intended consumer.
 *
 * **A claimed segment's on-disk presence is checked directly (`lstat`), never
 * inferred from `listSegmentFiles`'s filtered inventory.** That inventory
 * deliberately excludes a symlink or a hardlink planted at a segment name —
 * correct for the unclaimed case, where such an entry was never a segment
 * this writer produced and is rightly invisible. A CLAIMED name is different:
 * the manifest says something was sealed there, so "not a regular
 * single-link file" is itself the finding — a refusal to read, reported
 * through `failures`, not a silent `"archived"`. Folding the two together
 * would let a planted symlink at a claimed name read as an honest deletion.
 *
 * @packageDocumentation
 */

import { lstat } from "node:fs/promises";
import path from "node:path";

import type { M3LError } from "../../core/errors/index.js";
import type {
  M3LAppendOnlySegmentVerdict,
  M3LAppendOnlyVerification,
  M3LAppendOnlyVerificationFailure,
  M3LAppendOnlyVerificationStatus,
} from "../../core/storage/append-only-verify-types.js";
import type { M3LAppendOnlySegment } from "../../core/storage/append-only-read-types.js";
import { isEnoentError } from "../../core/utils/guards.js";
import { toArchivedSegment } from "./append-only-archival.js";
import type { SegmentDigestResult } from "./append-only-digest.js";
import { digestSegmentFile } from "./append-only-digest.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import type { ManifestContents } from "./append-only-manifest.js";
import { readManifest } from "./append-only-manifest.js";
import type { ManifestSealRecord } from "./append-only-manifest-records.js";
import { listSegmentFiles, parseSegmentName } from "./append-only-segments.js";
import {
  baselineBoundaryKey,
  isAtOrBeforeBaseline,
  segmentOrderKey,
} from "./append-only-sweep-policy.js";

/** Reported when a ceiling option is not a size anything could be bounded by. */
const INVALID_CEILING_MESSAGE =
  "append-only stream: a verify() ceiling must be a positive integer";

/** Reported when the directory's segment inventory cannot be taken at all. */
const LISTING_FAILURE_MESSAGE =
  "append-only stream: failed to list segments while verifying";

/** Reported when the manifest cannot be read while verifying. */
const MANIFEST_READ_FAILURE_MESSAGE =
  "append-only stream: failed to read the sealed-segment manifest while verifying";

/** Reported when a claimed segment cannot be re-digested. */
const SEGMENT_DIGEST_FAILURE_MESSAGE =
  "append-only stream: failed to verify a sealed segment";

/**
 * Reported when a claimed segment's on-disk presence cannot even be
 * determined (an `lstat` failure other than "nothing is there").
 */
const PRESENCE_CHECK_FAILURE_MESSAGE =
  "append-only stream: failed to check whether a sealed segment still exists";

/**
 * The options {@link verifyAppendOnlySegments} runs under: the directory, the
 * two read ceilings, and the two error vocabularies a caller keeps apart so a
 * broader (manifest- or directory-level) failure and a per-segment one can be
 * told apart without parsing a message string.
 */
export interface AppendOnlyVerifyOptions {
  /** The stream directory holding the segments and the manifest. */
  readonly directory: string;
  /**
   * The per-segment digest ceiling. The owner passes
   * `maxSegmentBytes + maxLineBytes`, for the reason `./append-only-sealer.js`
   * already documents: `shouldRotate` fires at `>= maxSegmentBytes`, so the
   * line that crosses the ceiling is written before rotation, and a bound of
   * `maxSegmentBytes` alone would refuse to re-digest the very segment that
   * was just sealed.
   */
  readonly maxDigestBytes: number;
  /** The manifest read ceiling, as `./append-only-manifest.js` enforces it. */
  readonly maxManifestBytes: number;
  /** The owner's vocabulary for a manifest-level or directory-level failure. */
  readonly buildManifestError: AppendOnlyReadFailure;
  /** The owner's vocabulary for a per-segment failure. */
  readonly buildSegmentError: AppendOnlyReadFailure;
}

/** One classified segment, paired with the key it sorts by. */
interface OrderedVerdict {
  readonly orderKey: string;
  readonly verdict: M3LAppendOnlySegmentVerdict;
}

/**
 * What classifying one claimed segment produces: a verdict, or a failure —
 * never both, never neither, mirroring the report's own invariant.
 */
type ClaimOutcome =
  | { readonly kind: "verdict"; readonly verdict: M3LAppendOnlySegmentVerdict }
  | {
      readonly kind: "failure";
      readonly failure: M3LAppendOnlyVerificationFailure;
    };

/**
 * Refuses a ceiling that is not a positive integer, through the caller's own
 * manifest-level vocabulary — a non-ceiling is misuse of the whole call, not
 * a small ceiling every segment happens to fail, so it is rejected before
 * either `listSegmentFiles` or `readManifest` ever runs.
 */
function assertPositiveInteger(
  value: number,
  ceiling: string,
  buildManifestError: AppendOnlyReadFailure,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw buildManifestError(INVALID_CEILING_MESSAGE, {
      context: { ceiling, value },
    });
  }
}

/** C1's one loud check: both ceilings, validated before anything opens. */
function assertValidCeilings(options: AppendOnlyVerifyOptions): void {
  assertPositiveInteger(
    options.maxDigestBytes,
    "maxDigestBytes",
    options.buildManifestError,
  );
  assertPositiveInteger(
    options.maxManifestBytes,
    "maxManifestBytes",
    options.buildManifestError,
  );
}

/** One count per status, all five keys initialised so a new status must be counted here to compile. */
function tallyTotals(
  verdicts: readonly M3LAppendOnlySegmentVerdict[],
): Readonly<Record<M3LAppendOnlyVerificationStatus, number>> {
  const totals: Record<M3LAppendOnlyVerificationStatus, number> = {
    sealed: 0,
    unsealed: 0,
    archived: 0,
    mismatched: 0,
    legacy: 0,
  };
  for (const verdict of verdicts) {
    totals[verdict.status] += 1;
  }
  return totals;
}

/**
 * The report shape for a manifest- or directory-level failure: nothing could
 * be classified at all. `skipped` is the caller's honest count for the
 * failure at hand — `0` when the directory listing itself is what failed (no
 * inventory was ever taken, so nothing could have been skipped), or the
 * listing's own `skipped` count when the listing succeeded and it was the
 * manifest read that failed afterward (the count is already known and must
 * not be discarded).
 */
function emptyReport(
  error: M3LError,
  skipped: number,
): M3LAppendOnlyVerification {
  return {
    verdicts: [],
    failures: [{ segment: undefined, error }],
    totals: tallyTotals([]),
    unprovenBefore: undefined,
    skipped,
  };
}

/** `true` when `claim` and `observed` agree on all three measured fields. */
function measurementsMatch(
  claim: SegmentDigestResult,
  observed: SegmentDigestResult,
): boolean {
  return (
    claim.entryCount === observed.entryCount &&
    claim.byteLength === observed.byteLength &&
    claim.sha256 === observed.sha256
  );
}

/** `"sealed"` when the re-digest agrees with the claim, else `"mismatched"`. */
function sealedOrMismatchedVerdict(
  segment: string,
  claim: ManifestSealRecord,
  observed: SegmentDigestResult,
): M3LAppendOnlySegmentVerdict {
  return {
    segment,
    status: measurementsMatch(claim, observed) ? "sealed" : "mismatched",
    sealed: toArchivedSegment(claim),
    observed,
  };
}

/** The manifest claims `segment` and it is not on disk: the full claim, never digested. */
function archivedVerdict(
  segment: string,
  claim: ManifestSealRecord,
): M3LAppendOnlySegmentVerdict {
  return { segment, status: "archived", sealed: toArchivedSegment(claim) };
}

/** At or before the baseline, unclaimed: deliberately never digested. */
function legacyVerdict(segment: string): M3LAppendOnlySegmentVerdict {
  return { segment, status: "legacy" };
}

/** After the boundary (or no boundary at all), unclaimed: nothing to check yet. */
function unsealedVerdict(segment: string): M3LAppendOnlySegmentVerdict {
  return { segment, status: "unsealed" };
}

/**
 * Re-digests an on-disk claimed segment and compares the result to its
 * claim, or reports why it could not be measured.
 *
 * `digestSegmentFile` already validates `maxDigestBytes` and applies every
 * read refusal a segment read gets (`O_NOFOLLOW`, the post-open `nlink`/
 * `isFile` check, the bounded chunked read) — this function adds nothing to
 * that lifecycle beyond routing its one outcome into this engine's own
 * verdict/failure split.
 */
async function digestClaimedSegment(
  segmentPath: string,
  segment: string,
  claim: ManifestSealRecord,
  options: AppendOnlyVerifyOptions,
): Promise<ClaimOutcome> {
  try {
    const observed = await digestSegmentFile(
      segmentPath,
      options.maxDigestBytes,
      options.buildSegmentError,
    );
    return {
      kind: "verdict",
      verdict: sealedOrMismatchedVerdict(segment, claim, observed),
    };
  } catch (cause) {
    return {
      kind: "failure",
      failure: {
        segment,
        error: options.buildSegmentError(SEGMENT_DIGEST_FAILURE_MESSAGE, {
          cause,
          context: { segment },
        }),
      },
    };
  }
}

/**
 * Classifies one claimed segment: `"archived"` when nothing is at its path,
 * a digest-and-compare when something is, and a `failures` entry when even
 * checking presence fails.
 *
 * Presence is checked with `lstat`, never inferred from
 * `listSegmentFiles`'s filtered inventory — see this module's header for why
 * a symlink or a hardlink planted at a CLAIMED name must surface as a
 * failure rather than read as an honest `"archived"` deletion.
 */
async function classifyClaimedSegment(
  segment: string,
  claim: ManifestSealRecord,
  options: AppendOnlyVerifyOptions,
): Promise<ClaimOutcome> {
  const segmentPath = path.join(options.directory, segment);
  try {
    await lstat(segmentPath);
  } catch (cause) {
    // Only a genuine, OWN ENOENT (core/utils/guards.js's isEnoentError) is
    // treated as "archived". A false positive here would turn an
    // undetermined lstat failure — a permissions error, in particular —
    // into the silent "archived" verdict, which is exactly the "archived
    // absorbs undetermined" conflation this module's verify contract is
    // built to prevent; anything else falls through to the failures entry
    // below instead.
    if (isEnoentError(cause)) {
      return { kind: "verdict", verdict: archivedVerdict(segment, claim) };
    }
    return {
      kind: "failure",
      failure: {
        segment,
        error: options.buildSegmentError(PRESENCE_CHECK_FAILURE_MESSAGE, {
          cause,
          context: { segment },
        }),
      },
    };
  }
  return await digestClaimedSegment(segmentPath, segment, claim, options);
}

/**
 * Classifies one unclaimed on-disk segment: `"legacy"` at or before the
 * baseline boundary, `"unsealed"` otherwise. Never digested either way — see
 * {@link "../../core/storage/append-only-verify-types.js".M3LAppendOnlyVerificationStatus}
 * for why.
 */
function classifyUnclaimedSegment(
  segment: M3LAppendOnlySegment,
  boundaryKey: string | undefined,
): M3LAppendOnlySegmentVerdict {
  return isAtOrBeforeBaseline(segment, boundaryKey)
    ? legacyVerdict(segment.name)
    : unsealedVerdict(segment.name);
}

/**
 * Classifies every on-disk segment the manifest makes no claim about, in
 * order. A pure computation over already-known values — no I/O, so no
 * `failures` entry can come from this half.
 */
function classifyUnclaimedSegments(
  segments: readonly M3LAppendOnlySegment[],
  contents: ManifestContents,
  boundaryKey: string | undefined,
): readonly OrderedVerdict[] {
  const ordered: OrderedVerdict[] = [];
  for (const segment of segments) {
    if (contents.seals.has(segment.name)) {
      continue;
    }
    ordered.push({
      orderKey: segmentOrderKey(segment.datePrefix, segment.sequence),
      verdict: classifyUnclaimedSegment(segment, boundaryKey),
    });
  }
  return ordered;
}

/**
 * Classifies every segment the manifest claims, in order, splitting the
 * outcomes into `verdicts` (ordered) and `failures` (unordered — nothing in
 * the contract requires a failure order, only a verdict order).
 *
 * A seal's `segment` is required to pass `parseSegmentName` before the
 * record is admitted at all (`ownSealSegment`,
 * `./append-only-manifest-records.js`) — a seal that reaches this loop
 * therefore always parses; there is no runtime path that reaches this engine
 * with a claim `readManifest` did not already accept.
 */
async function classifyClaimedSegments(
  contents: ManifestContents,
  options: AppendOnlyVerifyOptions,
): Promise<{
  readonly ordered: readonly OrderedVerdict[];
  readonly failures: readonly M3LAppendOnlyVerificationFailure[];
}> {
  const ordered: OrderedVerdict[] = [];
  const failures: M3LAppendOnlyVerificationFailure[] = [];
  for (const [name, claim] of contents.seals) {
    const parsed = parseSegmentName(name);
    /* v8 ignore next 3 -- unreachable: ownSealSegment already requires
       parseSegmentName to accept a seal's `segment` before the record is
       admitted, so a claim reaching this loop always parses. */
    if (parsed === undefined) {
      continue;
    }
    const outcome = await classifyClaimedSegment(name, claim, options);
    if (outcome.kind === "verdict") {
      ordered.push({
        orderKey: segmentOrderKey(parsed.datePrefix, parsed.sequence),
        verdict: outcome.verdict,
      });
    } else {
      failures.push(outcome.failure);
    }
  }
  return { ordered, failures };
}

/** Ascending string comparison — `orderKey` is already a fixed-width, directly comparable key. */
function byOrderKey(a: OrderedVerdict, b: OrderedVerdict): number {
  if (a.orderKey < b.orderKey) {
    return -1;
  }
  /* v8 ignore next -- unreachable: orderKey is derived one-to-one from a
     segment's (datePrefix, sequence) via segmentFileName's round-trip
     uniqueness (./append-only-segments.js), so two DIFFERENT segment names
     appearing in one report can never tie. Kept for Array.prototype.sort's
     general total-order contract, not because a tie occurs in practice. */
  return a.orderKey > b.orderKey ? 1 : 0;
}

/**
 * Assembles the whole report once the inventory and the manifest are both in
 * hand: the two classification passes (C2), sorted into one ordering (C3),
 * plus totals (C6) and the boundary signal (C4).
 */
async function buildVerificationReport(
  segments: readonly M3LAppendOnlySegment[],
  contents: ManifestContents,
  options: AppendOnlyVerifyOptions,
  skipped: number,
): Promise<M3LAppendOnlyVerification> {
  const boundaryKey = baselineBoundaryKey(contents);
  const unclaimed = classifyUnclaimedSegments(segments, contents, boundaryKey);
  const claimed = await classifyClaimedSegments(contents, options);

  const ordered = [...unclaimed, ...claimed.ordered].sort(byOrderKey);
  const verdicts = ordered.map((entry) => entry.verdict);
  return {
    verdicts,
    failures: claimed.failures,
    totals: tallyTotals(verdicts),
    unprovenBefore: contents.baseline?.upTo,
    skipped,
  };
}

/**
 * Re-digests every segment a directory's `manifest.jsonl` sidecar claims
 * about, and classifies every segment — claimed or not — into one of five
 * verdicts: `"sealed"`, `"mismatched"`, `"archived"`, `"legacy"`, or
 * `"unsealed"` (see
 * {@link "../../core/storage/append-only-verify-types.js".M3LAppendOnlyVerificationStatus}).
 *
 * **Never rejects** except for a `maxDigestBytes` or `maxManifestBytes` that
 * is not a positive integer, refused before either the directory listing or
 * the manifest is read — see this module's header for the full C1
 * rationale. Every other failure — the directory cannot be listed, the
 * manifest cannot be read, a claimed segment cannot be measured — becomes an
 * entry in the resolved report's `failures` array instead.
 *
 * A missing stream directory and an absent manifest are both **not**
 * failures: `listSegmentFiles` reports an empty inventory for a missing
 * directory, and `readManifest` reports empty contents for an absent
 * manifest — the manifest-deletion signal
 * {@link "../../core/storage/append-only-verify-types.js".M3LAppendOnlyVerification.unprovenBefore}
 * documents relies on exactly this: a deleted manifest reads as "nothing
 * ever claimed", not as an error.
 *
 * @param options - The directory, the two read ceilings, and the two error
 *   vocabularies — see {@link AppendOnlyVerifyOptions}.
 * @returns The full report: one verdict per segment this engine could
 *   classify, one failure per thing it could not, totals, and the manifest's
 *   stated boundary.
 * @example
 * ```ts
 * import { M3LError } from "@monte3l/m3l-common/core";
 *
 * const report = await verifyAppendOnlySegments({
 *   directory,
 *   maxDigestBytes: maxSegmentBytes + maxLineBytes,
 *   maxManifestBytes,
 *   buildManifestError: (message, options) =>
 *     new M3LError(message, { code: "ERR_STORAGE_READ", ...options }),
 *   buildSegmentError: (message, options) =>
 *     new M3LError(message, { code: "ERR_STORAGE_READ", ...options }),
 * });
 * if (report.totals.mismatched > 0 || report.failures.length > 0) {
 *   console.warn("audit trail failed verification", report);
 * }
 * ```
 */
export async function verifyAppendOnlySegments(
  options: AppendOnlyVerifyOptions,
): Promise<M3LAppendOnlyVerification> {
  assertValidCeilings(options);

  let segments: readonly M3LAppendOnlySegment[];
  let skipped: number;
  try {
    ({ segments, skipped } = await listSegmentFiles(options.directory));
  } catch (cause) {
    // No inventory was ever taken, so nothing could have been skipped.
    return emptyReport(
      options.buildManifestError(LISTING_FAILURE_MESSAGE, { cause }),
      0,
    );
  }

  let contents: ManifestContents;
  try {
    contents = await readManifest(
      options.directory,
      options.maxManifestBytes,
      options.buildManifestError,
    );
  } catch (cause) {
    // The listing succeeded, so its skipped count is already known and must
    // survive even though the manifest read failed afterward.
    return emptyReport(
      options.buildManifestError(MANIFEST_READ_FAILURE_MESSAGE, {
        cause,
        context: { maxManifestBytes: options.maxManifestBytes },
      }),
      skipped,
    );
  }

  return await buildVerificationReport(segments, contents, options, skipped);
}
