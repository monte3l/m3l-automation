/**
 * `internal/storage/append-only-manifest-records` — the sealed-segment
 * manifest's FORMAT: the record shapes, the parse of one terminated line, and
 * the fold of many lines into what one manifest states (ADR-0102, X8b slice
 * 4).
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * the manifest's I/O layer (`./append-only-manifest.js`) so that module keeps
 * only the bounded guarded read and the append of one record — the two
 * concerns had grown past what one file can hold under `check:file-budget`'s
 * ratchet. The dependency runs ONE way: the I/O module imports this one, and
 * nothing here opens, reads or writes a file, so the format can be reasoned
 * about (and exercised) without a filesystem in the picture at all.
 *
 * The record-agnostic untrusted-field readers (`ownProperty`, `ownString`,
 * `ownInteger`, `ownMeasurement`, `ownDigest`, `ownInstant`) live one file
 * over, in `./append-only-manifest-fields.js`, for the same file-budget
 * reason. What stays here is record-SPECIFIC: `ownSealSegment` and
 * `ownBaselineUpTo` reach for this format's own
 * `parseSegmentName`/`currentDatePrefix` rules and so belong with the shapes
 * they validate, not with the generic primitives.
 *
 * **The integrity rules are deliberately asymmetric, and the asymmetry is the
 * design.** A torn LAST line is ignored unconditionally (a half-written seal
 * claims nothing; its segment simply reads as unsealed) — the one rule
 * enforced not here but by the reader that frames the lines,
 * `./append-only-manifest.js`. Every other rule is enforced here. A malformed
 * MID-FILE line is fatal. An unknown `kind` is ignored, for forward
 * compatibility. But a KNOWN kind — `seal` or `baseline` alike — at a
 * `formatVersion` above {@link MANIFEST_FORMAT_VERSION} is **fatal**, even
 * though an unknown `kind` at that very same version is merely ignored.
 * Forward compatibility lives on `kind` and only on `kind`: an audit reader
 * must never report "verified" for a claim it skipped, which is what forces
 * readers to upgrade before writers. A record this reader cannot even name is
 * harmless; a recognised one it cannot fully understand is not.
 *
 * Every failure is reported through the caller's own
 * {@link "./append-only-lines.js".AppendOnlyReadFailure} port, and no message
 * or `context` built here carries caller data — no directory path, no entry
 * key, no entry value, not one byte of a malformed line. A segment NAME is
 * the one sanctioned exception, and only once it has been required to pass
 * `parseSegmentName` at the parse boundary (`ownSealSegment`, a sibling of
 * `ownBaselineUpTo`): that acceptance constrains the name's SHAPE — a date
 * prefix and a counter in a fixed format — not its provenance, so it carries
 * no bytes an attacker could have chosen freely, even though a name of that
 * shape is not on its own proof the writer's clock and counter produced it.
 * A chained `cause` is held to a different standard and is documented at
 * {@link parseRecordObject}, the single place one is chained here.
 *
 * @packageDocumentation
 */

import type { SegmentDigestResult } from "./append-only-digest.js";
import { measurementsMatch } from "./append-only-digest.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import {
  ownDigest,
  ownInstant,
  ownInteger,
  ownMeasurement,
  ownProperty,
  ownString,
} from "./append-only-manifest-fields.js";
import { currentDatePrefix, parseSegmentName } from "./append-only-segments.js";

/**
 * The manifest format this reader understands, and the one it stamps on every
 * record it writes.
 *
 * A record of a KNOWN kind above this version is fatal rather than skipped —
 * see this module's header for why forward compatibility lives on `kind`
 * alone.
 */
export const MANIFEST_FORMAT_VERSION: number = 1;

/** Reported when a terminated manifest line is not a JSON object. */
const MALFORMED_LINE_MESSAGE =
  "append-only stream: the sealed-segment manifest holds a malformed line";

/** Reported when a record of a known kind is missing a required field. */
const MALFORMED_RECORD_MESSAGE =
  "append-only stream: a sealed-segment manifest record is incomplete";

/** Reported for a `seal` or `baseline` this reader is too old to understand. */
const UNSUPPORTED_VERSION_MESSAGE =
  "append-only stream: the sealed-segment manifest is newer than this reader";

/** Reported when two seals for one segment disagree about its measurement. */
const CONFLICTING_SEAL_MESSAGE =
  "append-only stream: two seals disagree about a segment's measurement";

/**
 * The `baseline` record: the stated boundary before which this trail is
 * unproven.
 *
 * Written exactly once, on the sealer's first act, and never retro-filled.
 * Segments at or before {@link ManifestBaselineRecord.upTo} classify as
 * `legacy` and are never retro-digested — a digest taken now cannot vouch for
 * bytes some earlier process wrote, and a manifest implying otherwise would
 * be worse than one that says "unproven before here" (ADR-0102).
 */
export interface ManifestBaselineRecord {
  /** Discriminator; `"baseline"` for this record kind. */
  readonly kind: "baseline";
  /** The format written at. See {@link MANIFEST_FORMAT_VERSION}. */
  readonly formatVersion: number;
  /** ISO-8601 instant the baseline was stamped. */
  readonly at: string;
  /**
   * The highest segment name that existed when sealing began, or `null` — a
   * positive assertion that sealing has been in force since this stream's
   * first segment, as opposed to the silence of an absent record.
   */
  readonly upTo: string | null;
}

/**
 * The `seal` record: one segment's measurement, as `./append-only-digest.js`
 * produced it, plus when it was taken.
 *
 * Extends {@link "./append-only-digest.js".SegmentDigestResult} rather than
 * restating its three fields, so a seal written here and a verification
 * computed there can never drift apart in shape.
 */
export interface ManifestSealRecord extends SegmentDigestResult {
  /** Discriminator; `"seal"` for this record kind. */
  readonly kind: "seal";
  /** The format written at. See {@link MANIFEST_FORMAT_VERSION}. */
  readonly formatVersion: number;
  /** ISO-8601 instant the seal was stamped. */
  readonly at: string;
  /** The segment file name this seal measures, e.g. `2026-09-11-0001.jsonl`. */
  readonly segment: string;
}

/**
 * What a sealer hands {@link "./append-only-manifest.js".appendSeal}: a
 * measurement plus the segment it measures. The record's `kind`,
 * `formatVersion` and `at` are that writer's to stamp, never the caller's to
 * supply.
 */
export interface SegmentSealClaim extends SegmentDigestResult {
  /** The segment file name the measurement was taken over. */
  readonly segment: string;
}

/** Everything one manifest states, indexed for the sealer's questions. */
export interface ManifestContents {
  /** The baseline, or `undefined` when the manifest states no boundary. */
  readonly baseline: ManifestBaselineRecord | undefined;
  /** Every seal, keyed by segment name. */
  readonly seals: ReadonlyMap<string, ManifestSealRecord>;
}

/** Either record kind, as parsed from one terminated manifest line. */
export type ManifestRecord = ManifestBaselineRecord | ManifestSealRecord;

/**
 * Parses one terminated line into a plain JSON object, or fails.
 *
 * The `SyntaxError` **is** chained as `cause`, in the same register as
 * `core/storage/M3LAppendOnlyStreamReadError`'s documented stance on the very
 * same failure: V8 embeds a short (roughly 10-30 byte) snippet of the
 * offending input in that message, and it is the only diagnostic an operator
 * has for a corrupt manifest — a constant string alone leaves them no way to
 * see what broke. It was decided, not overlooked. What makes it safe here is
 * that this file can hold no caller data to leak: every field any writer of
 * this format ever puts in it is library-computed — a `kind`, a
 * `formatVersion`, an ISO instant, a writer-generated segment name, two
 * counts and a digest. No directory path, no entry key and no entry value
 * ever reaches it. The message and `context` stay free of the line's bytes
 * regardless, so a caller forwarding only those to a log sink records none of
 * it, and one walking `cause` gets the fragment on purpose.
 */
function parseRecordObject(
  line: string,
  buildError: AppendOnlyReadFailure,
): object {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw buildError(MALFORMED_LINE_MESSAGE, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // A number, a string, `null` or an array is well-formed JSON and still
    // not a record: it can state no `kind`, so admitting it as an unknown
    // kind would silently tolerate a line no writer of this format could
    // have produced.
    throw buildError(MALFORMED_LINE_MESSAGE);
  }
  return parsed;
}

/**
 * Reads and admits a KNOWN record's `formatVersion`.
 *
 * This is where the asymmetry documented in this module's header is enforced:
 * the caller has already recognised `kind`, so a version above this reader's
 * is fatal rather than skipped. For a `seal` the stake is a claim reported as
 * verified without having been checked; for a `baseline` it is the same in a
 * different shape — its `upTo` decides which segments classify `legacy`, so
 * skipping one mis-classifies every segment behind that boundary, reporting
 * either a false alarm or a false reassurance from a record never read.
 */
function requireFormatVersion(
  record: object,
  buildError: AppendOnlyReadFailure,
): number {
  const formatVersion = ownInteger(record, "formatVersion");
  if (formatVersion === undefined) {
    throw buildError(MALFORMED_RECORD_MESSAGE);
  }
  if (formatVersion > MANIFEST_FORMAT_VERSION) {
    throw buildError(UNSUPPORTED_VERSION_MESSAGE, {
      // Library-computed facts only: two format versions, neither of them a
      // byte of the manifest's contents or of its caller's surroundings.
      context: {
        formatVersion,
        supportedFormatVersion: MANIFEST_FORMAT_VERSION,
      },
    });
  }
  return formatVersion;
}

/**
 * The own `segment` of `record` when it is a name
 * {@link "./append-only-segments.js".parseSegmentName} accepts, else
 * `undefined`.
 *
 * Sibling of {@link ownBaselineUpTo}, solving the same problem for the
 * `seal` record's own field: a string is admitted only when it is a name
 * this writer's own segment layer could have produced, on exactly the
 * reasoning {@link "./append-only-manifest-fields.js".ownDigest} and
 * {@link "./append-only-manifest-fields.js".ownMeasurement} already apply to
 * a seal's other fields. A value `parseSegmentName` declines was not written
 * by this trail's writer, so it must be refused here rather than admitted
 * and later handed back through {@link admitSeal}'s `context` — the one
 * sanctioned exception to this module's "no caller data" rule, sanctioned
 * only because a name the parser accepted carries no bytes an attacker chose
 * freely.
 *
 * Deliberately narrower than {@link ownBaselineUpTo}: that sibling also
 * bounds the parsed date prefix to no later than today, a rule that exists
 * because an over-future `upTo` would reclassify segments and disable the
 * cold-start sweep. A seal's own `segment` decides no such classification,
 * so that bound is not ported here — only `parseSegmentName` acceptance is.
 *
 * Checked on the local
 * {@link "./append-only-manifest-fields.js".ownString} already read, never
 * by reading the `segment` property, or re-parsing it, a second time.
 */
function ownSealSegment(record: object): string | undefined {
  const value = ownString(record, "segment");
  return value !== undefined && parseSegmentName(value) !== undefined
    ? value
    : undefined;
}

/**
 * Parses one `seal` record, or fails if it is incomplete, out of shape, or too
 * new.
 *
 * The measurement is admitted on its SHAPE, never on its type alone: a
 * `sha256` must be `./append-only-manifest-fields.js`'s `SHA256_HEX_PATTERN`
 * — 64 lowercase hex characters — and both counts must be non-negative
 * ({@link "./append-only-manifest-fields.js".ownMeasurement}). `segment`
 * is admitted only when {@link "./append-only-segments.js".parseSegmentName}
 * accepts it (see {@link ownSealSegment}). `at` is admitted only in the
 * instant shape
 * {@link "./append-only-manifest-fields.js".ownInstant} accepts, and that one
 * is a sanitization boundary rather than a shape nicety: `at` is the only
 * field of this record handed to a caller verbatim, through an option
 * documented with a logging example, so bytes admitted here land in an
 * operator's log looking library-written. The full reasoning — and the
 * warning against relaxing it back to a type check — lives on that reader.
 * {@link parseBaselineRecord} applies the same reader to its own `at`;
 * validating one kind and not the other is the asymmetry that produced this
 * gap. A value outside those shapes is
 * reported through {@link MALFORMED_RECORD_MESSAGE}, the same fatal path a
 * missing field takes — exactly as {@link parseBaselineRecord} treats a
 * wrongly-shaped `upTo` (see {@link ownBaselineUpTo}), and on the same
 * grounds: a measurement `./append-only-digest.js` could not have produced,
 * or a name this writer's own segment layer could not have produced, is not
 * a measurement or a segment, so the record states nothing rather than
 * states it badly.
 */
function parseSealRecord(
  record: object,
  buildError: AppendOnlyReadFailure,
): ManifestSealRecord {
  const formatVersion = requireFormatVersion(record, buildError);
  const at = ownInstant(record, "at");
  const segment = ownSealSegment(record);
  const sha256 = ownDigest(record, "sha256");
  const entryCount = ownMeasurement(record, "entryCount");
  const byteLength = ownMeasurement(record, "byteLength");
  if (
    at === undefined ||
    segment === undefined ||
    sha256 === undefined ||
    entryCount === undefined ||
    byteLength === undefined
  ) {
    throw buildError(MALFORMED_RECORD_MESSAGE);
  }
  return {
    kind: "seal",
    formatVersion,
    at,
    segment,
    entryCount,
    byteLength,
    sha256,
  };
}

/**
 * The own `upTo` of `record` when it is `null` or a name
 * {@link "./append-only-segments.js".parseSegmentName} accepts AND whose date
 * prefix is no later than {@link "./append-only-segments.js".currentDatePrefix}
 * reports for right now, else `undefined`.
 *
 * `null` is admitted unchanged — the positive assertion "sealed since the
 * first segment". A string is admitted only when it is a name this writer's
 * own segment layer could have produced; the field readers in
 * `./append-only-manifest-fields.js` already refuse a `sha256` of the wrong
 * shape ({@link "./append-only-manifest-fields.js".ownDigest}) and a count
 * outside its possible range
 * ({@link "./append-only-manifest-fields.js".ownMeasurement}) on exactly
 * this reasoning, and `upTo` is no different: a string of some other shape
 * is not a segment name,
 * so a forged boundary such as `"archive-2026-09.tar"` is refused here rather
 * than accepted and left to reshape which segments classify `legacy`
 * downstream.
 *
 * A name whose date prefix is LATER than today is refused on the same
 * grounds, not a separate one: this trail cannot have written it yet, so it
 * is not evidence of anything this reader can act on. The sibling guard in
 * `./append-only-manifest-baseline.js`'s `highestSegmentName` applies this exact
 * exclusion when a baseline is *derived*, at initialization; this is the
 * other half — the same exclusion applied when a baseline already sitting in
 * a manifest is *read* back. Without it, a planted `upTo` dated arbitrarily
 * far in the future would be accepted as the trail's stated boundary,
 * reclassifying every segment up to that date as `legacy` and silently
 * disabling the cold-start sweep this reader exists to enable — the doc'd
 * guarantee this function's callers rely on.
 *
 * Refusing is a real cost, and worth stating rather than leaving for a future
 * reader to discover from a stack trace: a peer writer whose own clock runs
 * ahead of ours can legitimately stamp a baseline naming a segment that is
 * "today" for it and "future" for us, and every read of that manifest is a
 * fatal error until our clock catches up to that date. The window is bounded
 * and self-healing — it closes the moment our clock passes the stated date —
 * and every other option is worse: treating "the boundary is in the future"
 * as *no* boundary would make the sweep retro-digest genuinely legacy
 * segments and hand out proofs nobody can honour, and clamping it to today
 * would mark everything up to today `legacy`, which is the exact
 * sweep-killing outcome this check exists to prevent. Refusing the record is
 * the only fold that neither manufactures a false proof nor silently disables
 * the guard.
 *
 * Checked on the local
 * {@link "./append-only-manifest-fields.js".ownProperty} already read, and
 * on {@link parseSegmentName}'s own returned `datePrefix` — never by reading
 * the `upTo` property, or re-parsing it, a second time.
 */
function ownBaselineUpTo(record: object): string | null | undefined {
  const value = ownProperty(record, "upTo");
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = parseSegmentName(value);
  return parsed !== undefined && parsed.datePrefix <= currentDatePrefix()
    ? value
    : undefined;
}

/**
 * Parses one `baseline` record, or fails if it is incomplete, out of shape,
 * or too new.
 *
 * Its `at` goes through the same
 * {@link "./append-only-manifest-fields.js".ownInstant} boundary
 * {@link parseSealRecord} holds its own to, deliberately and not for
 * symmetry's sake: a baseline is read off the same untrusted file by the same
 * reader, so a shape check on one kind's instant and a bare type check on the
 * other's would leave the identical leak open under one record name.
 */
function parseBaselineRecord(
  record: object,
  buildError: AppendOnlyReadFailure,
): ManifestBaselineRecord {
  const formatVersion = requireFormatVersion(record, buildError);
  const at = ownInstant(record, "at");
  const upTo = ownBaselineUpTo(record);
  if (at === undefined || upTo === undefined) {
    // `upTo` is required and explicitly nullable: `null` is the positive
    // assertion "sealed since the first segment", an absent field is a
    // boundary nobody ever stated, and a string that is not a segment name
    // `parseSegmentName` accepts is not a segment this trail could have
    // written — see `ownBaselineUpTo`.
    throw buildError(MALFORMED_RECORD_MESSAGE);
  }
  return { kind: "baseline", formatVersion, at, upTo };
}

/**
 * Parses one terminated line, or returns `undefined` for a record this reader
 * is meant to ignore.
 *
 * `undefined` means exactly one thing: an unknown `kind`, the single
 * forward-compatibility allowance. A recognised-but-broken record never takes
 * this route — it throws — so a later writer can add a `checkpoint` kind this
 * reader skips safely, while nothing a tamperer writes can disguise a broken
 * `seal` as one of those.
 */
function parseManifestLine(
  line: string,
  buildError: AppendOnlyReadFailure,
): ManifestRecord | undefined {
  const record = parseRecordObject(line, buildError);
  const kind = ownProperty(record, "kind");
  if (kind === "seal") {
    return parseSealRecord(record, buildError);
  }
  if (kind === "baseline") {
    return parseBaselineRecord(record, buildError);
  }
  return undefined;
}

/**
 * Admits one seal into the index, tolerating an agreeing duplicate and
 * refusing a disagreeing one.
 *
 * The comparison is FIELD BY FIELD and never line by line. Two writers
 * sealing one segment stamp different `at` instants by construction, and JSON
 * key order is not fixed either, so a whole-line (or canonical-string)
 * comparison would manufacture a disagreement out of two identical claims.
 * Only the measurement — `entryCount`, `byteLength`, `sha256` — says anything
 * about the segment's bytes, and only disagreement there is a real conflict.
 * The three field tests are not written out here:
 * {@link "./append-only-digest.js".measurementsMatch} is the one definition
 * every path asking "do these numbers agree" shares, so this rule cannot
 * drift from the one the reader, the verifier and the sealer's own
 * corroboration apply.
 *
 * A real disagreement throws rather than picking a winner: there is no
 * version of "the manifest cannot say what the segment held" worth continuing
 * past, and tolerating it would let an attacker neutralize a genuine seal by
 * appending a false one (ADR-0102).
 */
function admitSeal(
  seals: Map<string, ManifestSealRecord>,
  record: ManifestSealRecord,
  buildError: AppendOnlyReadFailure,
): void {
  const existing = seals.get(record.segment);
  if (existing !== undefined && !measurementsMatch(existing, record)) {
    throw buildError(CONFLICTING_SEAL_MESSAGE, {
      // A segment NAME is the sanctioned exception to the no-caller-data
      // rule — but only because `ownSealSegment` (above) has already
      // required `parseSegmentName` to accept it before this record could
      // reach the index at all. That parse-boundary check constrains the
      // SHAPE, not the provenance: an attacker with directory write can
      // still plant a well-formed-looking name, so this does not prove the
      // writer's clock and counter produced it. What it does prove is that
      // the name carries no bytes the attacker chose freely — only a date
      // and a counter in the fixed shape this writer could have rendered. An
      // operator cannot act on this failure without knowing which segment is
      // disputed.
      context: { segment: record.segment },
    });
  }
  seals.set(record.segment, record);
}

/**
 * Folds every terminated line into the manifest's stated contents.
 *
 * A later `baseline` simply replaces an earlier one. Two baselines are
 * already outside the format —
 * {@link "./append-only-manifest.js".loadOrInitializeManifest} writes at most
 * one and never over an existing manifest — so this is a tie-break for a
 * state that should not exist, not a supported shape.
 *
 * @param lines - Every newline-TERMINATED line the manifest holds, in order.
 * @param buildError - The caller's error vocabulary for every failure here.
 * @returns The baseline, if any, and every seal keyed by segment name.
 * @example
 * ```ts
 * import { M3LError } from "@monte3l/m3l-common/core";
 *
 * const contents = collectRecords(lines, (message, options) =>
 *   new M3LError(message, { code: "ERR_STORAGE_READ", ...options }),
 * );
 * ```
 */
export function collectRecords(
  lines: readonly string[],
  buildError: AppendOnlyReadFailure,
): ManifestContents {
  let baseline: ManifestBaselineRecord | undefined;
  const seals = new Map<string, ManifestSealRecord>();
  for (const line of lines) {
    const record = parseManifestLine(line, buildError);
    if (record === undefined) {
      continue;
    }
    if (record.kind === "baseline") {
      baseline = record;
      continue;
    }
    admitSeal(seals, record, buildError);
  }
  return { baseline, seals };
}
