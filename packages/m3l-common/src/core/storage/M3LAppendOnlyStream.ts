/**
 * `core/storage/M3LAppendOnlyStream` — the public append-only segmented JSONL
 * stream: one append-only, tamper-evident line per entry, rotated by size,
 * age and UTC date (ADR-0061, X7 slice 2).
 *
 * This is the reusable Core primitive behind every append-only audit artifact
 * this library writes. The append itself — segment naming and cold-start
 * discovery, the byte/age/date rotation decision, the atomic
 * `O_APPEND`/`O_NOFOLLOW` write, and the serialized append chain — lives in
 * `internal/storage/append-only-writer.js`, which this class drives through a
 * rendering function and an error port. `core/agent`'s decision log drives the
 * same writer through its own pair, so the two audit artifacts share one copy
 * of that security-critical code rather than forking it.
 *
 * Two error vocabularies meet here and are kept apart deliberately:
 *
 * - a **caller-side** violation — a malformed options bag, or an entry
 *   holding a value that cannot be persisted faithfully — throws a bare
 *   `M3LError` with `code: "ERR_INVALID_ARGUMENT"`, matching the house
 *   pattern in `aws/s3/uri.ts` and `internal/logging/levels.ts`;
 * - a failure of the **append itself**, including a well-formed entry that is
 *   simply larger than one atomic write can carry and a segment path that
 *   turns out to be a symlink or a hardlink, throws
 *   {@link "./M3LAppendOnlyStreamError.js".M3LAppendOnlyStreamError}
 *   (`ERR_APPEND_ONLY_STREAM_WRITE`).
 *
 * No error message, and no `context` built here, ever carries a value read
 * out of the caller's input: they name the field and the violation kind only.
 * A directory path can carry tenant or customer identifiers, and an entry
 * carries payload — its own key names included. The one path by which a
 * caller-supplied string can still be reached from an error raised here is a
 * **chained filesystem `cause`** — Node's own `ENOENT`/`EACCES`/`ELOOP`
 * errors quote the path they failed on. That cause is deliberately kept: it
 * is the only diagnostic an operator has for a broken stream directory, it is
 * Node's error rather than one composed here, and it is reached only by code
 * that walks `error.cause` explicitly.
 *
 * Three limitations are part of the public contract and are stated here
 * rather than deferred to a private module that may change freely:
 *
 * - a `maxSegmentBytes` below `maxLineBytes` yields **one entry per
 *   segment** — every append finds the byte ceiling already crossed and
 *   rotates first. It is legal on purpose (rotation has to stay testable at
 *   sizes a test can reach in a handful of writes) and never loses or
 *   truncates a record; it is simply wasteful.
 * - a segment's age is measured from a wall-clock stamp, so a clock that
 *   steps **forward** and then back can leave a segment stamped in the
 *   future and make `maxSegmentAgeMs` unreachable for it. The size ceiling
 *   and the UTC-date rollover still bound that segment.
 * - `append()` resolves once the line has reached the operating system's
 *   page cache — **not** the platter. Nothing here calls `fsync`, so a
 *   machine that loses power immediately after a resolved append can come
 *   back up without that line. A consumer that needs crash durability has to
 *   flush at its own artifact boundary.
 *
 * @packageDocumentation
 */

import { readAppendOnlySegments } from "../../internal/storage/append-only-reader.js";
import { buildReaderOptions } from "../../internal/storage/append-only-read-wiring.js";
import { renderEntryLine } from "../../internal/storage/append-only-render.js";
import { listSegmentFiles } from "../../internal/storage/append-only-segments.js";
import { AppendOnlySealer } from "../../internal/storage/append-only-sealer.js";
import { AppendOnlyWriter } from "../../internal/storage/append-only-writer.js";
import { DEFAULT_MAX_MANIFEST_BYTES } from "../../internal/storage/append-only-manifest.js";
import {
  validateReadOptions,
  validateStreamOptions,
} from "../../internal/storage/append-only-options.js";
import { verifyAppendOnlySegments } from "../../internal/storage/append-only-verify.js";
import type {
  M3LAppendOnlyEntry,
  M3LAppendOnlyValue,
} from "./append-only-entry-types.js";
import type {
  M3LAppendOnlyReadOptions,
  M3LAppendOnlySegmentListing,
} from "./append-only-read-types.js";
import type { M3LAppendOnlyVerification } from "./append-only-verify-types.js";
import type { M3LAppendOnlyStreamOptions } from "./append-only-write-types.js";
import {
  APPEND_ONLY_STREAM_WRITE_ERRORS,
  buildAppendOnlyStreamManifestError,
  buildAppendOnlyStreamReadError,
} from "../../internal/storage/append-only-stream-errors.js";

/**
 * An append-only, segmented JSONL stream: one JSON object per line, appended
 * atomically, never rewritten in place.
 *
 * Segments are named `<YYYY-MM-DD>-<NNNN>.jsonl` (UTC date, sequence
 * zero-padded to four digits) and rotate once the active one has crossed any
 * ceiling — its size, its age, or the UTC date it is stamped with. Rotation
 * only ever seals the active segment (by simply no longer writing to it) and
 * opens a new one; it never prunes or truncates a segment in place.
 *
 * A directory-wide `manifest.jsonl` sidecar now exists alongside the
 * segments, sealed on rotation by
 * {@link "../../internal/storage/append-only-sealer.js".AppendOnlySealer}, so
 * "no index file is kept" no longer holds without qualification. What stays
 * true: the manifest is never consulted to decide where to append — a fresh
 * instance still re-derives the active segment from a directory listing plus
 * one `stat`, so a long-lived process and a freshly spawned one still agree;
 * the manifest carries no in-memory state across processes either; and the
 * manifest is not a segment, so it is invisible to segment discovery and
 * never appears in {@link M3LAppendOnlyStream.listSegments}. Two instances
 * over one directory still interleave whole lines rather than corrupting one
 * another (`O_APPEND`; this does not hold across NFS).
 *
 * A link **already planted** at the path of the segment an append is about to
 * open is refused in either form: a symlink, by `O_NOFOLLOW` where the
 * platform has it; a hardlink — a second directory entry for one inode, which
 * `O_NOFOLLOW` does not see at all — by checking on the opened descriptor
 * itself that the file has exactly one link. Either way the append fails
 * loudly rather than writing the record into a file somebody else owns. That
 * is the precise guarantee: a link planted *before* the segment is opened is
 * refused; hardlinking a segment the stream has already created is not
 * prevented. The directory is created owner-only (`0o700`) and each segment
 * owner-read/write (`0o600`), which keeps the planting precondition out of
 * reach to begin with; a process umask can only remove bits, never add one.
 *
 * An append resolves once the line has reached the operating system's page
 * cache, **not** the platter — see this module's header.
 *
 * @example
 * ```ts
 * import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";
 *
 * const stream = new M3LAppendOnlyStream({
 *   directory: "data/output/human-actions",
 * });
 *
 * await stream.append({
 *   at: new Date().toISOString(),
 *   event: "approval.granted",
 *   actor: { id: "u-1" },
 * });
 * ```
 */
export class M3LAppendOnlyStream {
  /** The directory the segments live in, as validated at construction. */
  private readonly streamDirectory: string;
  /** The resolved line ceiling `read()` enforces against a torn fragment. */
  private readonly streamMaxLineBytes: number;
  /** The resolved segment-size ceiling `verify()` folds into its digest bound. */
  private readonly streamMaxSegmentBytes: number;
  /** The generic writer this stream's rendering and errors are bound to. */
  private readonly writer: AppendOnlyWriter<unknown>;

  /**
   * Creates a stream over `options.directory`. Nothing touches the
   * filesystem until the first {@link M3LAppendOnlyStream.append} — the
   * directory is created then, not here.
   *
   * @param options - The stream's directory, its optional ceilings, and an
   *   optional `onSealFailed` handler.
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when the bag
   *   is not a plain object, carries an unknown key, has a blank/non-string
   *   `directory`, a ceiling that is not a finite positive integer, a
   *   `maxLineBytes` above {@link M3L_APPEND_ONLY_MAX_LINE_BYTES}, or a
   *   truthy non-function `onSealFailed`.
   */
  constructor(options: M3LAppendOnlyStreamOptions) {
    const resolved = validateStreamOptions(options);
    this.streamDirectory = resolved.directory;
    this.streamMaxLineBytes = resolved.maxLineBytes;
    this.streamMaxSegmentBytes = resolved.maxSegmentBytes;
    const sealer = new AppendOnlySealer({
      directory: resolved.directory,
      maxSegmentBytes: resolved.maxSegmentBytes,
      maxLineBytes: resolved.maxLineBytes,
      maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
      buildError: buildAppendOnlyStreamManifestError,
      // Conditional spread, not a direct assignment: `exactOptionalPropertyTypes`
      // forbids setting an optional property to a value typed `T | undefined`.
      ...(resolved.onSealFailed !== undefined && {
        onSealFailed: resolved.onSealFailed,
      }),
    });
    this.writer = new AppendOnlyWriter<unknown>({
      directory: resolved.directory,
      maxSegmentBytes: resolved.maxSegmentBytes,
      maxSegmentAgeMs: resolved.maxSegmentAgeMs,
      maxLineBytes: resolved.maxLineBytes,
      renderEntry: renderEntryLine,
      errors: APPEND_ONLY_STREAM_WRITE_ERRORS,
      sealer,
    });
  }

  /**
   * The directory the segments live in, exactly as configured.
   *
   * @example
   * ```ts
   * import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";
   *
   * const stream = new M3LAppendOnlyStream({ directory: "data/output/audit" });
   * console.log(stream.directory); // "data/output/audit"
   * ```
   */
  get directory(): string {
    return this.streamDirectory;
  }

  /**
   * Appends one entry as a single JSON line, rotating the active segment
   * first when any ceiling is already crossed. Validates the entry, rebuilds
   * it as this library's own detached copy, and renders the line before
   * touching the filesystem at all, so a rejected entry leaves nothing
   * behind — and what reaches disk is the projection, never the caller's
   * object (see
   * {@link "../../internal/storage/append-only-projection.js".projectAppendOnlyEntry}).
   *
   * Concurrent calls on one instance are serialized: each append awaits the
   * previous one's completion, so byte-ceiling rotation fires on the line
   * that crosses it rather than a whole batch late. A rejected append is
   * reported to its own caller only and never poisons the chain.
   *
   * The parameter is constrained rather than typed
   * {@link "./append-only-entry-types.js".M3LAppendOnlyEntry} so an
   * `interface`-declared record — the normal way a consumer models an audit
   * record, and one that carries no index signature — is accepted without a
   * cast. The closure is unchanged: every property still has to be an
   * {@link "./append-only-entry-types.js".M3LAppendOnlyValue}, so a `Date`- or
   * `bigint`-valued field is still a compile error.
   *
   * @remarks
   * Resolving means the entry is durable — it does not mean the directory is
   * quiescent: a `manifest.jsonl` seal for a previously rotated segment can
   * still land afterwards (see
   * `internal/storage/append-only-writer.js`'s `sealAfterAppend`). Removing
   * or archiving the stream directory immediately after the last
   * `append()` resolves can race that write — an `ENOTEMPTY` on a recursive
   * remove is the symptom, and retrying past it is correct. Deliberate: a
   * seal is metadata about bytes already durably appended, and a process
   * exiting before one runs is exactly what the sealer's cold-start sweep
   * recovers.
   *
   * @typeParam T - The caller's own record type; every property must be an
   *   {@link "./append-only-entry-types.js".M3LAppendOnlyValue}.
   * @param entry - The record to append; a plain object of
   *   {@link "./append-only-entry-types.js".M3LAppendOnlyValue}s.
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `entry`
   *   is not a plain object, carries an own `__proto__` / `constructor` /
   *   `prototype` key, or holds a value JSON cannot carry back out unchanged
   *   (a non-finite number, `-0`, a `bigint`, a function, a symbol,
   *   `undefined`, a class instance) at any depth — including a structure
   *   nested past the documented depth cap, which is what bounds a circular
   *   entry. A caller-side violation, not a write failure.
   * @throws {@link "./M3LAppendOnlyStreamError.js".M3LAppendOnlyStreamError}
   *   when the entry exceeds the
   *   stream's `maxLineBytes` — well-formed, but larger than one atomic write
   *   can carry — or when the append itself fails for any reason, including a
   *   segment path that has been replaced by a symlink or hardlinked into a
   *   second directory entry. The underlying cause is always chained; neither
   *   message nor `context` ever carries caller data.
   *
   * @example
   * ```ts
   * import {
   *   M3LAppendOnlyStream,
   *   M3LAppendOnlyStreamError,
   * } from "@monte3l/m3l-common/core";
   *
   * const stream = new M3LAppendOnlyStream({ directory: "data/output/audit" });
   * try {
   *   await stream.append({ event: "run.started", runId: "r-1" });
   * } catch (error) {
   *   if (error instanceof M3LAppendOnlyStreamError) {
   *     // the trail is unwritable — fail the run loudly rather than continue
   *     throw error;
   *   }
   *   throw error;
   * }
   * ```
   */
  async append<T extends { readonly [K in keyof T]: M3LAppendOnlyValue }>(
    entry: T,
  ): Promise<void> {
    await this.writer.write(entry);
  }

  /**
   * Reads back every entry, oldest `(date, sequence)` first — the order
   * `append()` produced them — proving and rebuilding each line through the
   * same
   * {@link "../../internal/storage/append-only-projection.js".projectAppendOnlyEntry}
   * the writer serializes through, so a
   * value `append()` could never itself have written (a bare array, `-0`, a
   * too-deep structure) throws rather than being handed back as genuine. A
   * missing directory yields nothing. See
   * `internal/storage/append-only-read-plan.ts` (which segments) and
   * `append-only-reader.ts` (their bytes).
   *
   * **Every SEALED segment's bytes are verified inline** against the claim
   * the directory's `manifest.jsonl` recorded for them, from the chunks this
   * read is already performing, and a disagreement throws rather than being
   * handed back as genuine. **The archival check is eager**, and fires at a
   * deliberately different point from `onTruncatedTail` — see
   * `core/storage/append-only-integrity-contract.ts`'s header for the
   * read/verify integrity contract in full, including the two points at which
   * an integrity disagreement can and cannot be detected.
   *
   * @param options - `onTruncatedTail` tolerates an unterminated trailing
   *   fragment on the LAST segment only; the same fragment mid-stream — data
   *   loss, not a torn tail — always throws regardless. `onArchivedSegment`
   *   tolerates a segment the directory's `manifest.jsonl` sealed and which
   *   is no longer on disk; see
   *   {@link M3LAppendOnlyReadOptions.onArchivedSegment} for that check's
   *   missing-manifest blind spot.
   * @throws {@link M3LError} `ERR_INVALID_ARGUMENT` for a non-object
   *   `options`, an unknown own key on it, or a TRUTHY non-callable
   *   `onTruncatedTail` or `onArchivedSegment`. A falsy one (`null`, `0`,
   *   `""`) is deliberately not rejected: it degrades to the absent-handler
   *   path, which for both of these handlers is the THROWING one.
   * @throws {@link "./M3LAppendOnlyStreamReadError.js".M3LAppendOnlyStreamReadError} for a malformed/oversized
   *   line, a missing sequence, an intolerable fragment, or a read failure.
   * @throws {@link "./M3LAppendOnlyStreamManifestError.js".M3LAppendOnlyStreamManifestError} when the manifest
   *   states a seal for a segment no longer on disk and no
   *   `onArchivedSegment` was supplied, or when a `manifest.jsonl` that is
   *   present cannot be read or parsed at all.
   * @throws {@link "./M3LAppendOnlyStreamIntegrityError.js".M3LAppendOnlyStreamIntegrityError} when a segment the
   *   manifest SEALED is still on disk and the bytes read back do not
   *   measure what the seal recorded — a distinct class from the manifest
   *   error above, since these bytes are present and simply are not the
   *   sealed ones. An unclaimed segment is never digested. See
   *   `core/storage/append-only-integrity-contract.ts` for when in the
   *   iteration this can and cannot fire.
   *
   * @example
   * ```ts
   * import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";
   *
   * const stream = new M3LAppendOnlyStream({ directory: "data/output/audit" });
   * for await (const entry of stream.read()) console.log(entry);
   * ```
   */
  read(options?: M3LAppendOnlyReadOptions): AsyncIterable<M3LAppendOnlyEntry> {
    validateReadOptions(options);
    return readAppendOnlySegments(
      buildReaderOptions({
        directory: this.streamDirectory,
        maxLineBytes: this.streamMaxLineBytes,
        maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
        readOptions: options,
      }),
    ) as AsyncIterable<M3LAppendOnlyEntry>;
  }

  /**
   * Inventories every segment file actually on disk, oldest
   * `(datePrefix, sequence)` first, plus a `skipped` count of segment-named
   * entries that could not be inventoried as one — see
   * {@link M3LAppendOnlySegmentListing}. Never opens, deletes, or truncates a
   * segment; each candidate is inspected with `lstat`, and only a regular
   * file with exactly one link is accepted, so neither a symlink nor a
   * hardlink planted at a segment name is ever followed (see
   * `internal/storage/append-only-segments.ts` for the full security
   * rationale and its remaining limits). A missing directory yields an empty
   * listing.
   *
   * Unlike {@link M3LAppendOnlyStream.read}, this does **not** check that a
   * date's sequences are contiguous: an inventory that refuses to run against
   * a damaged trail is useless exactly when the damage is why someone reaches
   * for it. Gap detection stays on `read()`, which hands entries back and
   * must vouch for the trail it hands them from.
   *
   * @throws {@link "./M3LAppendOnlyStreamReadError.js".M3LAppendOnlyStreamReadError} when listing the directory,
   *   or inspecting one of its entries, fails for a reason other than the
   *   entry not existing.
   *
   * @example
   * ```ts
   * import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";
   *
   * const stream = new M3LAppendOnlyStream({ directory: "data/output/audit" });
   * const listing = await stream.listSegments();
   * for (const segment of listing.segments) {
   *   console.log(segment.name, segment.byteLength);
   * }
   * ```
   */
  async listSegments(): Promise<M3LAppendOnlySegmentListing> {
    let listing: M3LAppendOnlySegmentListing;
    try {
      listing = await listSegmentFiles(this.streamDirectory);
    } catch (cause) {
      throw buildAppendOnlyStreamReadError(
        "append-only stream: failed to list segments",
        { cause },
      );
    }
    return { segments: Array.from(listing.segments), skipped: listing.skipped };
  }

  /**
   * Re-digests every segment the directory's `manifest.jsonl` sidecar makes
   * a claim about, and classifies every segment — claimed or not — into one
   * of five verdicts: `"sealed"`, `"mismatched"`, `"archived"`, `"legacy"`,
   * or `"unsealed"` (see
   * {@link "./append-only-verify-types.js".M3LAppendOnlyVerificationStatus}).
   *
   * **Never rejects**, **the returned report is not a simple pass/fail**, and
   * the digest bound handed to the engine is `maxSegmentBytes + maxLineBytes`
   * rather than `maxSegmentBytes` alone — see
   * `core/storage/append-only-integrity-contract.ts`'s header for each of
   * those three in full, and
   * {@link "./append-only-verify-types.js".M3LAppendOnlyVerification} for
   * what the report's own fields can and cannot prove.
   *
   * @returns The full report: one verdict per segment this stream could
   *   classify, one failure per thing it could not, totals, and the
   *   manifest's stated boundary.
   * @example
   * ```ts
   * import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";
   *
   * const stream = new M3LAppendOnlyStream({ directory: "data/output/audit" });
   * const report = await stream.verify();
   *
   * // A positive finding, but not sufficient alone — see M3LAppendOnlyVerification.
   * const disputed = report.verdicts.length === 0 && report.failures.length > 0;
   * if (report.totals.mismatched > 0 || disputed) {
   *   // escalate: at least one claim disagrees with its bytes, or the
   *   // sidecar itself could not be read
   * }
   *
   * // Absence of evidence is a finding too, judged against what this trail
   * // is expected to hold — a record kept OUTSIDE this directory.
   * if (report.unprovenBefore === undefined || report.skipped > 0) {
   *   // escalate: the manifest is gone, or the directory holds entries
   *   // this writer never left behind
   * }
   * ```
   */
  async verify(): Promise<M3LAppendOnlyVerification> {
    return await verifyAppendOnlySegments({
      directory: this.streamDirectory,
      maxDigestBytes: this.streamMaxSegmentBytes + this.streamMaxLineBytes,
      maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
      buildManifestError: buildAppendOnlyStreamManifestError,
      buildSegmentError: buildAppendOnlyStreamReadError,
    });
  }

  /**
   * Drains the append chain as it stands at the moment of the call: every
   * {@link M3LAppendOnlyStream.append} — and every manifest seal run by
   * {@link "../../internal/storage/append-only-sealer.js".AppendOnlySealer} —
   * that was already in flight when `flush()` was called has settled by the
   * time it resolves.
   *
   * **Does not guarantee:** anything about an `append()` call started
   * concurrently with, or after, this one — those are not covered. This is a
   * point-in-time drain, not a barrier, and this class has no `close()`; a
   * caller who reads `flush()` as "the stream is now idle" is wrong.
   *
   * **Never rejects, and is not an error channel.** An append failure still
   * reaches its own `append()` caller, and a seal failure still reaches the
   * `onSealFailed` handler supplied at construction — `flush()` surfaces
   * neither. Do not turn this into a rethrow of something it merely awaited.
   *
   * **What it is for:** making the directory safe to remove, archive, or
   * measure. Without it, a manifest seal still in flight for a previously
   * rotated segment can recreate `manifest.jsonl` partway through a
   * recursive remove of the directory, which surfaces as `ENOTEMPTY` — see
   * {@link M3LAppendOnlyStream.append}'s `@remarks`.
   *
   * **Never required for the trail's correctness.** A process that exits
   * without calling `flush()` loses at most one seal, and that is exactly
   * what {@link "../../internal/storage/append-only-sealer.js".AppendOnlySealer}'s
   * cold-start sweep recovers on the next writer instance.
   *
   * @example
   * ```ts
   * import { M3LAppendOnlyStream } from "@monte3l/m3l-common/core";
   * import { rm } from "node:fs/promises";
   *
   * const stream = new M3LAppendOnlyStream({ directory: "data/output/audit" });
   * await stream.append({ event: "run.completed", runId: "r-1" });
   * await stream.flush();
   * await rm("data/output/audit", { recursive: true });
   * ```
   */
  async flush(): Promise<void> {
    await this.writer.flush();
  }
}
