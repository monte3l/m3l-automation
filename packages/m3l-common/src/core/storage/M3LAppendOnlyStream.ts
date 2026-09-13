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
 *   {@link M3LAppendOnlyStreamError} (`ERR_APPEND_ONLY_STREAM_WRITE`).
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

import type { M3LError } from "../errors/index.js";
import { isFunction } from "../utils/guards.js";
import { readAppendOnlySegments } from "../../internal/storage/append-only-reader.js";
import { renderEntryLine } from "../../internal/storage/append-only-render.js";
import { listSegmentFiles } from "../../internal/storage/append-only-segments.js";
import { AppendOnlySealer } from "../../internal/storage/append-only-sealer.js";
import type { AppendOnlyWriterErrors } from "../../internal/storage/append-only-writer.js";
import { AppendOnlyWriter } from "../../internal/storage/append-only-writer.js";
import { DEFAULT_MAX_MANIFEST_BYTES } from "../../internal/storage/append-only-manifest.js";
import {
  validateReadOptions,
  validateStreamOptions,
} from "../../internal/storage/append-only-options.js";
import type {
  M3LAppendOnlyReadOptions,
  M3LAppendOnlySegmentListing,
} from "./append-only-read-types.js";
import type { M3LAppendOnlyStreamOptions } from "./append-only-write-types.js";
import { M3LAppendOnlyStreamError } from "./M3LAppendOnlyStreamError.js";
import { M3LAppendOnlyStreamReadError } from "./M3LAppendOnlyStreamReadError.js";

/**
 * A value an append-only stream entry may carry. Closed on purpose: exactly
 * what JSON can carry back out unchanged, and nothing else.
 *
 * `undefined`, a `bigint`, a function, a symbol and a class instance (a
 * `Date`, a `Map`, an `Error`) are all excluded, because each would make the
 * persisted line disagree with the entry the caller handed over — silently
 * dropped, coerced to `null`, or serialized through whatever `toJSON` it
 * carries. Pass a `Date` as `date.toISOString()` and any richer collection as
 * the plain array or object you want recorded.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyValue } from "@monte3l/m3l-common/core";
 *
 * const actor: M3LAppendOnlyValue = { id: "u-1", roles: ["reader"] };
 * ```
 */
export type M3LAppendOnlyValue =
  | string
  | number
  | boolean
  | null
  | readonly M3LAppendOnlyValue[]
  | { readonly [key: string]: M3LAppendOnlyValue };

/**
 * One entry: a JSON object of {@link M3LAppendOnlyValue}s, persisted as
 * exactly one line.
 *
 * The stream never serializes the caller's object — it rebuilds a detached,
 * null-prototype copy first — so an entry may be handed over and then
 * mutated without changing what was written.
 *
 * This is the **shape** an entry has — the type to annotate a value with. It
 * is not the constraint {@link M3LAppendOnlyStream.append} imposes: an
 * `interface` carries no index signature, so a record declared as one (the
 * normal way a consumer models an audit record) does not satisfy this alias
 * and would need a cast that throws away the closure the alias provides.
 * `append` constrains its own type parameter instead, admitting any object
 * type whose properties are all {@link M3LAppendOnlyValue}s. Everything
 * assignable to this alias satisfies that constraint.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyEntry } from "@monte3l/m3l-common/core";
 *
 * const entry: M3LAppendOnlyEntry = {
 *   at: new Date().toISOString(),
 *   event: "approval.granted",
 *   actor: { id: "u-1" },
 * };
 * ```
 */
export type M3LAppendOnlyEntry = { readonly [key: string]: M3LAppendOnlyValue };

/**
 * This stream's half of the generic writer's error port: it turns the two
 * failures `AppendOnlyWriter` can report into {@link M3LAppendOnlyStreamError}.
 *
 * Only byte counts and a chained `cause` cross this boundary, so neither
 * error can carry a value read out of the caller's input — see this module's
 * header.
 */
const APPEND_ONLY_STREAM_ERRORS: AppendOnlyWriterErrors = {
  oversize(lineBytes: number, maxLineBytes: number): M3LError {
    return new M3LAppendOnlyStreamError(
      "append-only stream: serialized entry exceeds the maximum line size",
      { context: { lineBytes, maxLineBytes } },
    );
  },
  appendFailed(cause: unknown): M3LError {
    // No `context`: everything worth naming here is the directory path,
    // which is caller input. The chained `cause` is Node's own error and
    // carries the operational detail — see this module's header.
    return new M3LAppendOnlyStreamError(
      "append-only stream: failed to append an entry",
      { cause },
    );
  },
};

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
    const sealer = new AppendOnlySealer({
      directory: resolved.directory,
      maxSegmentBytes: resolved.maxSegmentBytes,
      maxLineBytes: resolved.maxLineBytes,
      maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
      // Known limitation: this single `AppendOnlyReadFailure` builder serves
      // BOTH the sealer's manifest reads and its manifest appends, so the
      // class name never discriminates direction. For this owner it is the
      // APPEND side that is misnamed — a failed manifest write (e.g.
      // `append-only-manifest.ts`'s `appendRecord`) still surfaces as a
      // "Read" error. The `cause` and `message` carry the accurate
      // operational detail regardless, so nothing but the class name is
      // wrong. X8b4 introduces a dedicated `M3LAppendOnlyStreamManifestError`
      // (code `ERR_APPEND_ONLY_STREAM_MANIFEST`) that actually resolves this.
      buildError: (message, errorOptions) =>
        new M3LAppendOnlyStreamReadError(message, errorOptions),
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
      errors: APPEND_ONLY_STREAM_ERRORS,
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
   * The parameter is constrained rather than typed {@link M3LAppendOnlyEntry}
   * so an `interface`-declared record — the normal way a consumer models an
   * audit record, and one that carries no index signature — is accepted
   * without a cast. The closure is unchanged: every property still has to be
   * an {@link M3LAppendOnlyValue}, so a `Date`- or `bigint`-valued field is
   * still a compile error.
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
   *   {@link M3LAppendOnlyValue}.
   * @param entry - The record to append; a plain object of
   *   {@link M3LAppendOnlyValue}s.
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `entry`
   *   is not a plain object, carries an own `__proto__` / `constructor` /
   *   `prototype` key, or holds a value JSON cannot carry back out unchanged
   *   (a non-finite number, `-0`, a `bigint`, a function, a symbol,
   *   `undefined`, a class instance) at any depth — including a structure
   *   nested past the documented depth cap, which is what bounds a circular
   *   entry. A caller-side violation, not a write failure.
   * @throws {@link M3LAppendOnlyStreamError} when the entry exceeds the
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
   * `internal/storage/append-only-reader.ts` for the full read contract.
   *
   * @param options - `onTruncatedTail` tolerates an unterminated trailing
   *   fragment on the LAST segment only; the same fragment mid-stream — data
   *   loss, not a torn tail — always throws regardless.
   * @throws {@link M3LError} `ERR_INVALID_ARGUMENT` for a non-object
   *   `options`, an unknown own key on it, or a non-callable
   *   `onTruncatedTail`.
   * @throws {@link M3LAppendOnlyStreamReadError} for a malformed/oversized
   *   line, a missing sequence, an intolerable fragment, or a read failure.
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
    return readAppendOnlySegments({
      directory: this.streamDirectory,
      maxLineBytes: this.streamMaxLineBytes,
      // Conditional spread, not a direct assignment: `exactOptionalPropertyTypes`
      // forbids setting an optional property to a value typed `T | undefined`.
      // We spread only when the value is actually callable: `validateReadOptions`
      // rejects truthy non-functions, so any falsy non-function (e.g. `null`, `0`) must
      // degrade to the absent-callback path rather than being passed through as a
      // present-but-uncallable callback — which would silently swallow a torn tail.
      ...(isFunction(options?.onTruncatedTail) && {
        onTruncatedTail: options.onTruncatedTail,
      }),
      buildError: (message, errorOptions) =>
        new M3LAppendOnlyStreamReadError(message, errorOptions),
    }) as AsyncIterable<M3LAppendOnlyEntry>;
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
   * @throws {@link M3LAppendOnlyStreamReadError} when listing the directory,
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
      throw new M3LAppendOnlyStreamReadError(
        "append-only stream: failed to list segments",
        { cause },
      );
    }
    return { segments: Array.from(listing.segments), skipped: listing.skipped };
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
