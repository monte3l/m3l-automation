/**
 * `internal/storage/append-only-manifest` — the append-only stream's
 * sealed-segment manifest: the directory-wide, append-only `manifest.jsonl`
 * that makes whole-date archival provable (ADR-0102, X8b slice 4).
 *
 * Library-internal; never re-exported through a public barrel. This module
 * owns the manifest's bounded guarded READ and the append of one record; the
 * FORMAT those bytes are in — the record shapes, the parse of one line, the
 * fold of many — lives one file over in
 * `./append-only-manifest-records.js`, which this module imports and never
 * the other way round. It deliberately does NOT own the decision of *when* to
 * seal — that is the sealer, a later slice — so nothing here drives a
 * rotation, digests a segment, or reads an entry.
 *
 * One file per stream directory. A single non-date-named file cannot be
 * matched by a date glob, so the proof survives ADR-0070's archival procedure
 * **by construction** rather than by an operator remembering to spare it;
 * that is the whole reason the manifest is directory-wide rather than
 * per-segment. The name is also invisible to the segment layer without a
 * special case: `./append-only-segments.js`'s `SEGMENT_NAME_PATTERN` does not
 * match `manifest.jsonl`, so it enters no inventory, no byte total, and never
 * raises `listSegments()`' `skipped` count.
 *
 * **The integrity rules are deliberately asymmetric, and the asymmetry is the
 * design.** The torn-tail half is enforced here, in
 * {@link readTerminatedLines}: a torn LAST line is ignored unconditionally (a
 * half-written seal claims nothing; its segment simply reads as unsealed).
 * The other half — a malformed MID-FILE line is fatal, an unknown `kind` is
 * ignored for forward compatibility, but a KNOWN kind at a `formatVersion`
 * above this reader's is **fatal** even so — is stated and enforced in
 * `./append-only-manifest-records.js`, whose header carries the full
 * rationale: forward compatibility lives on `kind` and only on `kind`,
 * because an audit reader must never report "verified" for a claim it
 * skipped.
 *
 * The manifest is read through the same bounded-chunk machinery
 * (`./append-only-lines.js`) and the same `O_NOFOLLOW` + single-link +
 * `isFile` refusals (`./append-only-fs.js`) as a segment, and is created
 * owner-only under `SEGMENT_FILE_MODE`. A proof path with weaker guarantees
 * than the read path it vouches for would prove nothing.
 *
 * Every failure is reported through the caller's own
 * {@link "./append-only-lines.js".AppendOnlyReadFailure} port, and no message
 * or `context` built here carries caller data — no directory path, no entry
 * key, no entry value, not one byte of a malformed line. A segment NAME is
 * the one sanctioned exception: it derives from the writer's clock and
 * counter, carries zero caller bytes, and is already public through
 * `listSegments()`. A chained `cause` is held to a different standard — see
 * {@link readManifestFile} for the filesystem errors chained here, and
 * `./append-only-manifest-records.js`'s `parseRecordObject` for the
 * `SyntaxError` chained there.
 *
 * @packageDocumentation
 */

import type { FileHandle } from "node:fs/promises";
import { appendFile, open } from "node:fs/promises";
import path from "node:path";

import { M3LError } from "../../core/errors/index.js";
import type { M3LAppendOnlySegmentListing } from "../../core/storage/append-only-read-types.js";
import {
  APPEND_FLAGS,
  assertSegmentIsReadable,
  SEGMENT_FILE_MODE,
  SEGMENT_READ_FLAGS,
} from "./append-only-fs.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import {
  readChunks,
  splitLines,
  STRICT_UTF8_DECODER,
} from "./append-only-lines.js";
import type {
  ManifestBaselineRecord,
  ManifestContents,
  ManifestRecord,
  ManifestSealRecord,
  SegmentSealClaim,
} from "./append-only-manifest-records.js";
import {
  collectRecords,
  MANIFEST_FORMAT_VERSION,
} from "./append-only-manifest-records.js";
import { listSegmentFiles } from "./append-only-segments.js";

/**
 * The manifest's record vocabulary, re-exported so a caller that reads or
 * appends through this module never has to name the format module as well.
 * Their definitions and rationale live in
 * `./append-only-manifest-records.js`.
 */
export { MANIFEST_FORMAT_VERSION };
export type {
  ManifestBaselineRecord,
  ManifestContents,
  ManifestSealRecord,
  SegmentSealClaim,
};

/**
 * The manifest's file name within a stream directory.
 *
 * Not date-shaped on purpose — see this module's header: a date glob cannot
 * match it, so ADR-0070's whole-date archival leaves the proof behind by
 * construction, and `SEGMENT_NAME_PATTERN` cannot match it either, so no
 * inventory, byte total or `skipped` count ever sees it.
 */
export const M3L_APPEND_ONLY_MANIFEST_NAME: string = "manifest.jsonl";

/**
 * The largest read this module ever issues, in bytes, mirroring
 * `./append-only-digest.js`'s bound: the manifest is consumed in a bounded
 * sequential pass, so the buffer is a fixed working-set cost rather than a
 * function of the file's size.
 */
const MANIFEST_CHUNK_BYTES = 65_536; // 64 KiB

/** Reported when the caller's ceiling is not a size a manifest could have. */
const INVALID_CEILING_MESSAGE =
  "append-only stream: the maximum manifest size must be a positive integer";

/** Reported when the manifest's raw bytes exceed the caller's ceiling. */
const OVER_CEILING_MESSAGE =
  "append-only stream: the manifest exceeds the maximum manifest size";

/**
 * Reported when a single manifest line alone would not fit under the caller's
 * ceiling. Distinct from {@link OVER_CEILING_MESSAGE}: the file itself can sit
 * exactly ON the ceiling while an unterminated tail of that size could not be
 * completed within it, so "the manifest exceeds ..." would overstate what was
 * observed.
 */
const OVER_LONG_LINE_MESSAGE =
  "append-only stream: a sealed-segment manifest line exceeds the maximum manifest size";

/** Reported when the manifest cannot be opened for reading. */
const OPEN_FAILURE_MESSAGE =
  "append-only stream: failed to open the sealed-segment manifest";

/** Reported for any other failure raised while reading the manifest. */
const READ_FAILURE_MESSAGE =
  "append-only stream: failed to read the sealed-segment manifest";

/** Reported when the stream directory cannot be listed for the baseline. */
const LISTING_FAILURE_MESSAGE =
  "append-only stream: failed to list segments while initializing the manifest";

/** Reported when a manifest record cannot be appended. */
const APPEND_FAILURE_MESSAGE =
  "append-only stream: failed to append a sealed-segment manifest record";

/**
 * {@link "./append-only-manifest-records.js".ManifestContents} plus whether
 * the file was there at all.
 *
 * Presence is NOT derivable from the contents: a manifest holding only seals,
 * and an empty one, both read as "no baseline" while being very much present.
 * {@link loadOrInitializeManifest} must not write a second baseline over
 * either, so it needs the distinction the public
 * {@link "./append-only-manifest-records.js".ManifestContents} deliberately
 * does not carry.
 */
interface ManifestReadResult extends ManifestContents {
  /** `true` unless the manifest file is absent (`ENOENT` on open). */
  readonly present: boolean;
}

/**
 * `true` for a filesystem error meaning "there is nothing at that path".
 *
 * Only `ENOENT` is treated as absent, exactly as `./append-only-segments.js`
 * does. Every other open failure (`EACCES`, `ELOOP` from a planted symlink,
 * `ENOTDIR`, …) is a failure to READ the proof and is reported as one — a
 * blanket "absent" would let a tampered manifest read as a fresh stream and
 * invite a second, contradictory baseline over it.
 */
function isFileNotFound(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/** The manifest's absolute path within `directory`. */
function manifestPathIn(directory: string): string {
  return path.join(directory, M3L_APPEND_ONLY_MANIFEST_NAME);
}

/**
 * The read size for one manifest pass: this module's working-set bound, but
 * never more than one byte past the caller's ceiling.
 *
 * The extra byte is load-bearing at the boundary, for the same reason as
 * `./append-only-digest.js`'s `digestChunkSize`: a manifest of exactly
 * `maxBytes` must be readable in full before the following read reports
 * end-of-file, while one of `maxBytes + 1` must be able to deliver that one
 * extra byte for the refusal to fire. `maxBytes` is already a validated
 * positive integer by the time this runs, so the buffer can never be
 * zero-length.
 */
function manifestChunkSize(maxBytes: number): number {
  return Math.min(MANIFEST_CHUNK_BYTES, maxBytes + 1);
}

/**
 * Reads an open manifest as its newline-TERMINATED lines, under `maxBytes`.
 *
 * The trailing fragment is discarded unconditionally, and that is the
 * torn-tail policy in one line of code: the writer's `O_APPEND` record becomes
 * durable only once its newline lands, so an unterminated tail is a write that
 * never completed and claims nothing — its segment simply reads as unsealed.
 * Tornness, not position, is what buys that tolerance: a TERMINATED last line
 * is a complete claim and is held to every rule a mid-file line is.
 *
 * The ceiling is enforced by a MID-READ byte counter and never by an `fstat`
 * pre-check, mirroring `./append-only-digest.js`: a file can grow between the
 * `stat` and the last read, so a pre-check bounds a number nobody re-checked.
 */
async function readTerminatedLines(
  handle: FileHandle,
  maxBytes: number,
  buildError: AppendOnlyReadFailure,
): Promise<readonly string[]> {
  const lines: string[] = [];
  // Annotated `Buffer` (i.e. `Buffer<ArrayBufferLike>`) rather than inferred
  // from `Buffer.alloc`, whose `Buffer<ArrayBuffer>` is too narrow to accept
  // the carry `splitLines` hands back.
  let carry: Buffer = Buffer.alloc(0);
  let byteLength = 0;
  // `splitLines` is shared with the segment reader and words its one refusal
  // for a segment ("a segment line exceeds the maximum line size"), against a
  // per-LINE ceiling. The manifest hands it the whole-file ceiling instead, so
  // that wording would name a limit this file does not have. Re-word it here,
  // at the boundary, rather than reaching into a helper the reader also
  // depends on: every error `splitLines` builds is that single line-size
  // refusal, so substituting the message cannot mask a different failure. The
  // context is rebuilt from this module's own ceiling for the same reason —
  // `maxLineBytes` would name a bound the manifest never stated.
  const reportOverLongLine: AppendOnlyReadFailure = () =>
    buildError(OVER_LONG_LINE_MESSAGE, { context: { maxBytes } });
  for await (const chunk of readChunks(handle, manifestChunkSize(maxBytes))) {
    byteLength += chunk.byteLength;
    if (byteLength > maxBytes) {
      throw buildError(OVER_CEILING_MESSAGE, {
        // Library-computed facts only: the caller's own ceiling and a count
        // this module produced — never a byte of the manifest's contents.
        context: { maxBytes, byteLength },
      });
    }
    const split = splitLines(carry, chunk, maxBytes, reportOverLongLine);
    carry = split.carry;
    for (const line of split.lines) {
      lines.push(STRICT_UTF8_DECODER.decode(line));
    }
  }
  return lines;
}

/**
 * Opens, proves, reads and closes the manifest, reporting whether it was
 * there at all.
 *
 * The whole fallible lifecycle sits under one guard — `open`, the `fstat`
 * tampering refusals, every `read`, the strict decode and the parse alike —
 * so no raw `node:fs` error leaks out. A failure that is already the caller's
 * own typed error is re-thrown unchanged rather than double-wrapped. A
 * chained `cause` is the deliberate exception every module in this family
 * makes: the `node:fs` error chained here names the path by construction,
 * and a parse failure re-thrown from
 * `./append-only-manifest-records.js` arrives with V8's own `SyntaxError`
 * still chained, carrying a short snippet of the offending line (see that
 * module's `parseRecordObject` for why that is safe for this file and
 * wanted).
 *
 * `close` is best-effort in a `finally` of its own: the contents (or the
 * failure) computed above are what the caller must act on, and a descriptor
 * the OS refused to release must not displace either.
 */
async function readManifestFile(
  directory: string,
  maxBytes: number,
  buildError: AppendOnlyReadFailure,
): Promise<ManifestReadResult> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    // Not a small ceiling every manifest fails — not a ceiling at all. Left
    // unchecked it would be normalised into a working buffer size by
    // `manifestChunkSize` and then quietly succeed for an empty manifest,
    // reporting contents under a bound nobody could state.
    throw buildError(INVALID_CEILING_MESSAGE, { context: { maxBytes } });
  }
  let handle: FileHandle;
  try {
    handle = await open(manifestPathIn(directory), SEGMENT_READ_FLAGS);
  } catch (cause) {
    if (isFileNotFound(cause)) {
      return { present: false, baseline: undefined, seals: new Map() };
    }
    throw buildError(OPEN_FAILURE_MESSAGE, { cause });
  }
  try {
    await assertSegmentIsReadable(handle, buildError);
    const lines = await readTerminatedLines(handle, maxBytes, buildError);
    return { present: true, ...collectRecords(lines, buildError) };
  } catch (cause) {
    throw cause instanceof M3LError
      ? cause
      : buildError(READ_FAILURE_MESSAGE, { cause });
  } finally {
    try {
      await handle.close();
    } catch {
      // Best-effort: the contents or the failure above are the outcome that
      // matters, and a close failure must not replace either.
    }
  }
}

/**
 * Appends one record as a single newline-terminated JSON line.
 *
 * Opened under {@link "./append-only-fs.js".APPEND_FLAGS} — `O_APPEND`
 * without `O_TRUNC`, so existing bytes can never be rewritten or lost — and
 * created under {@link "./append-only-fs.js".SEGMENT_FILE_MODE}, owner-only,
 * because an audit trail left group- or world-readable under a default umask
 * is a disclosure on its own. `O_NOFOLLOW` refuses a symlink planted at the
 * manifest name, and the post-open `fstat` refuses a hardlinked or
 * non-regular file on the very descriptor about to be written.
 *
 * The bytes go out through `appendFile`, exactly as
 * `./append-only-writer.js` appends a segment line: it loops until every byte
 * has landed, where a bare `handle.write` resolves on a SHORT write and
 * leaves a truncated, unterminated record behind. The reader would then read
 * that fragment as a torn tail and ignore it unconditionally — a seal that
 * vanished without any failure ever being raised, on the one path whose whole
 * job is to produce proof. It is handed the HANDLE, not the path, so the
 * bytes go through the very descriptor the `nlink`/`isFile` refusals were
 * proven on; re-opening by name would be a check-then-open race.
 */
async function appendRecord(
  directory: string,
  record: ManifestRecord,
  buildError: AppendOnlyReadFailure,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      manifestPathIn(directory),
      APPEND_FLAGS,
      SEGMENT_FILE_MODE,
    );
    await assertSegmentIsReadable(handle, buildError);
    await appendFile(handle, line, { encoding: "utf8" });
  } catch (cause) {
    throw cause instanceof M3LError
      ? cause
      : buildError(APPEND_FAILURE_MESSAGE, { cause });
  } finally {
    try {
      await handle?.close();
    } catch {
      // Best-effort: the append's own outcome is what the caller acts on.
    }
  }
}

/**
 * The highest segment name in `directory`, or `null` when it holds none.
 *
 * Reuses `./append-only-segments.js`'s inventory rather than walking the
 * directory a second time, so "a segment" means exactly what it means
 * everywhere else in this stream: a name this writer would itself have
 * produced. A foreign file — `notes.txt`, or an over-padded `-00005.jsonl` no
 * writer here renders — is not a boundary this trail can state anything
 * about.
 */
async function highestSegmentName(
  directory: string,
  buildError: AppendOnlyReadFailure,
): Promise<string | null> {
  let listing: M3LAppendOnlySegmentListing;
  try {
    listing = await listSegmentFiles(directory);
  } catch (cause) {
    throw buildError(LISTING_FAILURE_MESSAGE, { cause });
  }
  return listing.segments.at(-1)?.name ?? null;
}

/**
 * Reads the manifest in `directory` under a hard `maxBytes` ceiling.
 *
 * An ABSENT manifest is contents-free, not a failure: a stream that has never
 * sealed anything is a legitimate state, and the port is never called for it.
 * Anything else that stops the read from completing IS a failure — see this
 * module's header, and `./append-only-manifest-records.js`'s, for the
 * torn-tail / malformed / unknown-kind asymmetry, and that module's
 * `admitSeal` for why disagreeing duplicate seals throw while agreeing ones
 * do not.
 *
 * This module owns no default ceiling. `maxBytes` is the caller's to state
 * and is validated (a positive integer) before anything is opened.
 *
 * @param directory - The stream directory holding the manifest.
 * @param maxBytes - The ceiling, enforced against bytes actually read.
 * @param buildError - The caller's error vocabulary for every failure here.
 * @returns The baseline, if any, and every seal keyed by segment name.
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * const contents = await readManifest(
 *   directory,
 *   maxManifestBytes,
 *   (message, options) =>
 *     new M3LError(message, { code: "ERR_STORAGE_READ", ...options }),
 * );
 * const sealed = contents.seals.get("2026-09-11-0001.jsonl");
 * ```
 */
export async function readManifest(
  directory: string,
  maxBytes: number,
  buildError: AppendOnlyReadFailure,
): Promise<ManifestContents> {
  const { baseline, seals } = await readManifestFile(
    directory,
    maxBytes,
    buildError,
  );
  return { baseline, seals };
}

/**
 * Reads the manifest, writing the ONE `baseline` record if there is no
 * manifest at all yet.
 *
 * The sealer's first act. Absent with segments already present (a pre-upgrade
 * trail) writes a baseline whose `upTo` is the highest existing segment name,
 * **digesting nothing** — a digest taken now cannot vouch for bytes an
 * earlier process wrote. Absent with no segments writes `upTo: null`, the
 * positive assertion that sealing has been in force since this stream's first
 * segment. A manifest that already exists — even one holding only seals, even
 * an empty one — is left byte-identical: a second baseline would be a second,
 * contradictory statement about how far back the trail is unproven.
 *
 * A fatal read PROPAGATES and is never swallowed into "absent". Treating, say,
 * a too-new manifest as a fresh stream would append that second baseline over
 * a trail whose real boundary this reader could not read, turning an
 * upgrade-me error into silent evidence destruction.
 *
 * @param directory - The stream directory holding the manifest.
 * @param maxBytes - The ceiling, enforced against bytes actually read.
 * @param buildError - The caller's error vocabulary for every failure here.
 * @returns The manifest's contents, including a baseline just written.
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * const contents = await loadOrInitializeManifest(
 *   directory,
 *   maxManifestBytes,
 *   (message, options) =>
 *     new M3LError(message, { code: "ERR_STORAGE_READ", ...options }),
 * );
 * // Segments at or before `contents.baseline?.upTo` classify as `legacy`.
 * ```
 */
export async function loadOrInitializeManifest(
  directory: string,
  maxBytes: number,
  buildError: AppendOnlyReadFailure,
): Promise<ManifestContents> {
  const existing = await readManifestFile(directory, maxBytes, buildError);
  if (existing.present) {
    return { baseline: existing.baseline, seals: existing.seals };
  }
  const baseline: ManifestBaselineRecord = {
    kind: "baseline",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at: new Date().toISOString(),
    upTo: await highestSegmentName(directory, buildError),
  };
  await appendRecord(directory, baseline, buildError);
  return { baseline, seals: existing.seals };
}

/**
 * Appends one `seal` for the segment `claim` measures.
 *
 * Writes a single newline-terminated line and never truncates or rewrites
 * what is already there. `kind`, `formatVersion` and `at` are stamped here
 * rather than accepted from the caller: a record's format version is a
 * statement about the reader that must be able to read it, and its instant is
 * an observation — neither is a sealer's to supply.
 *
 * Whether a segment SHOULD be sealed is not decided here (the sealer decides
 * that), and neither is whether it is already sealed: a duplicate is
 * reconciled at READ time by `./append-only-manifest-records.js`'s
 * `admitSeal`, the only place both claims are ever in hand at once.
 * Appending unconditionally also keeps this function free of a read-then-write
 * window two writers could interleave in.
 *
 * @param directory - The stream directory holding the manifest.
 * @param claim - The segment name and the measurement taken over its bytes.
 * @param buildError - The caller's error vocabulary for every failure here.
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * await appendSeal(directory, { segment, ...digest }, (message, options) =>
 *   new M3LError(message, { code: "ERR_STORAGE_WRITE", ...options }),
 * );
 * ```
 */
export async function appendSeal(
  directory: string,
  claim: SegmentSealClaim,
  buildError: AppendOnlyReadFailure,
): Promise<void> {
  await appendRecord(
    directory,
    {
      kind: "seal",
      formatVersion: MANIFEST_FORMAT_VERSION,
      at: new Date().toISOString(),
      segment: claim.segment,
      entryCount: claim.entryCount,
      byteLength: claim.byteLength,
      sha256: claim.sha256,
    },
    buildError,
  );
}
