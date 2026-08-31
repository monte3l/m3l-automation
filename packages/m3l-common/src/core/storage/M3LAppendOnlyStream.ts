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

import { M3LError } from "../errors/index.js";
import {
  isFunction,
  isNumber,
  isPlainObject,
  isString,
} from "../utils/guards.js";
import { projectAppendOnlyEntry } from "../../internal/storage/append-only-projection.js";
import {
  assertOnTruncatedTailIsCallable,
  readAppendOnlySegments,
} from "../../internal/storage/append-only-reader.js";
import type { AppendOnlyWriterErrors } from "../../internal/storage/append-only-writer.js";
import { AppendOnlyWriter } from "../../internal/storage/append-only-writer.js";
import {
  M3L_APPEND_ONLY_MAX_LINE_BYTES,
  M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS,
  M3L_APPEND_ONLY_MAX_SEGMENT_BYTES,
} from "./append-only-read-types.js";
import type { M3LAppendOnlyReadOptions } from "./append-only-read-types.js";
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
 * import type { M3LAppendOnlyValue } from "@m3l-automation/m3l-common/core";
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
 * import type { M3LAppendOnlyEntry } from "@m3l-automation/m3l-common/core";
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
 * Constructor options for {@link M3LAppendOnlyStream}.
 *
 * `directory` is required — the stream owns no default location, because the
 * artifact it records (and therefore where that artifact belongs) is the
 * caller's decision. Every ceiling is optional and falls back to the
 * documented default.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyStreamOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LAppendOnlyStreamOptions = {
 *   directory: "data/output/human-actions",
 *   maxSegmentAgeMs: 3_600_000,
 * };
 * ```
 */
export interface M3LAppendOnlyStreamOptions {
  /** The directory the segments live in; created on the first append. */
  readonly directory: string;
  /**
   * Rotate once the active segment has reached this many bytes. Defaults to
   * {@link M3L_APPEND_ONLY_MAX_SEGMENT_BYTES}.
   *
   * A value below `maxLineBytes` is legal but degenerate: every append finds
   * the ceiling already crossed and rotates first, so the stream writes one
   * entry per segment. Nothing is lost or truncated — it is simply wasteful,
   * and it is left legal so rotation stays testable at sizes a test can
   * reach in a handful of writes.
   */
  readonly maxSegmentBytes?: number;
  /**
   * Rotate once the active segment has been open this many milliseconds.
   * Defaults to {@link M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS}.
   */
  readonly maxSegmentAgeMs?: number;
  /**
   * The largest line, newline included, one append may carry. Defaults to
   * — and may not exceed — {@link M3L_APPEND_ONLY_MAX_LINE_BYTES}.
   *
   * Lowering it is a caller's business; raising it is refused. The ceiling
   * exists *because* `O_APPEND`'s whole-line atomicity does not cover a write
   * larger than the operating system's write buffer, so raising it to, say,
   * 8 MiB would silently void the "two writers interleave whole lines rather
   * than corrupting one another" guarantee this same class advertises.
   */
  readonly maxLineBytes?: number;
}

/** The only own keys {@link M3LAppendOnlyStreamOptions} may carry. */
const STREAM_OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "directory",
  "maxSegmentBytes",
  "maxSegmentAgeMs",
  "maxLineBytes",
]);

/**
 * Builds the caller-side boundary error: a bare {@link M3LError} carrying
 * `code: "ERR_INVALID_ARGUMENT"` (already classified `origin: "caller"` in
 * the error catalog). `context` names the field and the violation kind only —
 * never a value read out of the caller's input, and never an entry's own key
 * name, which is caller input too.
 */
function invalidArgument(field: string, violation: string): M3LError {
  return new M3LError(
    `append-only stream: "${field}" is invalid (${violation})`,
    { code: "ERR_INVALID_ARGUMENT", context: { field, violation } },
  );
}

/**
 * Reads the required `directory`. Presence is `Object.hasOwn`, so a non-own
 * `"__proto__"` resolves as absent; an absent, blank or non-string value is
 * malformed input and throws.
 *
 * "Non-blank" is deliberate: `"   "` names a directory only by accident, and
 * resolving it would silently write the audit trail into the process's
 * working directory.
 */
function readDirectory(bag: Readonly<Record<string, unknown>>): string {
  const value = Object.hasOwn(bag, "directory") ? bag["directory"] : undefined;
  if (!isString(value) || value.trim().length === 0) {
    throw invalidArgument("directory", "not-a-non-blank-string");
  }
  return value;
}

/**
 * Reads one optional ceiling. A ceiling is a count — of bytes or of
 * milliseconds — so only a finite positive integer is meaningful: `0` and a
 * negative would rotate on (or before) every write, and `NaN`/`Infinity`/a
 * fractional value would make the comparison that enforces it silently never
 * fire.
 */
function readOptionalCeiling(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  if (!Object.hasOwn(bag, key)) {
    return fallback;
  }
  const value = bag[key];
  if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw invalidArgument(key, "not-a-positive-integer");
  }
  return value;
}

/** The fully resolved settings one {@link M3LAppendOnlyStream} runs under. */
interface ResolvedStreamOptions {
  readonly directory: string;
  readonly maxSegmentBytes: number;
  readonly maxSegmentAgeMs: number;
  readonly maxLineBytes: number;
}

/**
 * Reads the optional line ceiling, which is bounded **above** as well as
 * below — see {@link M3LAppendOnlyStreamOptions.maxLineBytes}. Every other
 * ceiling is a caller's own business at any positive size; this one is the
 * reason the stream may claim whole-line atomicity at all, so raising it is
 * refused where it is made rather than discovered as a torn line later.
 */
function readLineCeiling(bag: Readonly<Record<string, unknown>>): number {
  const value = readOptionalCeiling(
    bag,
    "maxLineBytes",
    M3L_APPEND_ONLY_MAX_LINE_BYTES,
  );
  if (value > M3L_APPEND_ONLY_MAX_LINE_BYTES) {
    throw invalidArgument("maxLineBytes", "above-the-maximum-line-size");
  }
  return value;
}

/**
 * Validates the options bag at the public boundary and resolves every
 * omitted ceiling to its documented default.
 *
 * Unknown keys are rejected rather than ignored, following this library's
 * allowlist precedent (`validateAgentDecisionLogOptions`, `validateAgentPolicy`)
 * — an unrecognised key in a bag like this one is overwhelmingly a typo'd
 * known one, and silently ignoring it would leave a caller who wrote
 * `maxSegmentByte` believing they had raised a ceiling.
 */
function validateStreamOptions(options: unknown): ResolvedStreamOptions {
  if (!isPlainObject(options)) {
    throw invalidArgument("options", "not-an-object");
  }
  for (const key of Object.keys(options)) {
    if (!STREAM_OPTIONS_KEYS.has(key)) {
      throw invalidArgument("options", "unknown-key");
    }
  }
  return {
    directory: readDirectory(options),
    maxSegmentBytes: readOptionalCeiling(
      options,
      "maxSegmentBytes",
      M3L_APPEND_ONLY_MAX_SEGMENT_BYTES,
    ),
    maxSegmentAgeMs: readOptionalCeiling(
      options,
      "maxSegmentAgeMs",
      M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS,
    ),
    maxLineBytes: readLineCeiling(options),
  };
}

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
 * Proves `entry` structurally, rebuilds it as this library's own detached
 * copy, and renders the JSON text of the line the filesystem will receive.
 * The trailing newline is **not** added here: `AppendOnlyWriter` appends it,
 * so the line ceiling is measured over exactly the bytes one atomic write
 * must carry.
 *
 * What is serialized is **never the caller's object**. `JSON.stringify`
 * dispatches an inherited `toJSON`, and returns `undefined` — without
 * throwing — for one that yields `undefined`, so serializing the argument
 * directly would let a gadget on `Object.prototype` either forge the
 * persisted record or launder the text `undefined` into the stream as a line
 * no reader can parse. `projectAppendOnlyEntry` closes both by rebuilding
 * every node with a null prototype; see that module's header. The `typeof`
 * check below is the belt to that projection's braces — the projection is
 * provably serializable, so nothing should be able to make `stringify` yield
 * a non-string here, and if something does the line is never written.
 *
 * The validation and serialization run here, ahead of (and outside) the
 * writer's own append guard, because an entry that cannot be serialized is a
 * caller error, not a write failure: wrapping it in
 * {@link M3LAppendOnlyStreamError} would tell an operator the filesystem is
 * unhealthy when the argument was.
 *
 * The parameter is `unknown` rather than {@link M3LAppendOnlyEntry} because
 * that is what it honestly is: `append` is a public method reached by callers
 * with no types at all, and this function's whole job is to prove the shape
 * at runtime rather than assume it. It is also what lets `append` accept an
 * `interface`-typed record, which carries no index signature.
 */
function renderEntryLine(entry: unknown): string {
  const projection = projectAppendOnlyEntry(entry, invalidArgument);
  // Typed `unknown` on purpose: the declared return type is `string`, and the
  // whole point of this check is that a return type is not a runtime proof.
  const json: unknown = JSON.stringify(projection);
  if (typeof json !== "string") {
    throw invalidArgument("entry", "not-json-serializable");
  }
  return json;
}

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
 * No index file is kept and no state is carried across processes — a fresh
 * instance always re-derives the active segment from a directory listing plus
 * one `stat`, so a long-lived process and a freshly spawned one agree, and
 * two instances over one directory interleave whole lines rather than
 * corrupting one another (`O_APPEND`; this does not hold across NFS).
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
 * import { M3LAppendOnlyStream } from "@m3l-automation/m3l-common/core";
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
   * @param options - The stream's directory and its optional ceilings.
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when the bag
   *   is not a plain object, carries an unknown key, has a blank/non-string
   *   `directory`, a ceiling that is not a finite positive integer, or a
   *   `maxLineBytes` above {@link M3L_APPEND_ONLY_MAX_LINE_BYTES}.
   */
  constructor(options: M3LAppendOnlyStreamOptions) {
    const resolved = validateStreamOptions(options);
    this.streamDirectory = resolved.directory;
    this.streamMaxLineBytes = resolved.maxLineBytes;
    this.writer = new AppendOnlyWriter<unknown>({
      directory: resolved.directory,
      maxSegmentBytes: resolved.maxSegmentBytes,
      maxSegmentAgeMs: resolved.maxSegmentAgeMs,
      maxLineBytes: resolved.maxLineBytes,
      renderEntry: renderEntryLine,
      errors: APPEND_ONLY_STREAM_ERRORS,
    });
  }

  /**
   * The directory the segments live in, exactly as configured.
   *
   * @example
   * ```ts
   * import { M3LAppendOnlyStream } from "@m3l-automation/m3l-common/core";
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
   * object (see {@link projectAppendOnlyEntry}).
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
   * } from "@m3l-automation/m3l-common/core";
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
   * same {@link projectAppendOnlyEntry} the writer serializes through, so a
   * value `append()` could never itself have written (a bare array, `-0`, a
   * too-deep structure) throws rather than being handed back as genuine. A
   * missing directory yields nothing. See
   * `internal/storage/append-only-reader.ts` for the full read contract.
   *
   * @param options - `onTruncatedTail` tolerates an unterminated trailing
   *   fragment on the LAST segment only; the same fragment mid-stream — data
   *   loss, not a torn tail — always throws regardless.
   * @throws {@link M3LError} `ERR_INVALID_ARGUMENT` for a non-callable
   *   `onTruncatedTail`.
   * @throws {@link M3LAppendOnlyStreamReadError} for a malformed/oversized
   *   line, a missing sequence, an intolerable fragment, or a read failure.
   *
   * @example
   * ```ts
   * import { M3LAppendOnlyStream } from "@m3l-automation/m3l-common/core";
   *
   * const stream = new M3LAppendOnlyStream({ directory: "data/output/audit" });
   * for await (const entry of stream.read()) console.log(entry);
   * ```
   */
  read(options?: M3LAppendOnlyReadOptions): AsyncIterable<M3LAppendOnlyEntry> {
    assertOnTruncatedTailIsCallable(options);
    return readAppendOnlySegments({
      directory: this.streamDirectory,
      maxLineBytes: this.streamMaxLineBytes,
      // Conditional spread, not a direct assignment: `exactOptionalPropertyTypes`
      // forbids setting an optional property to a value typed `T | undefined`.
      // We spread only when the value is actually callable: `assertOnTruncatedTailIsCallable`
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
}
