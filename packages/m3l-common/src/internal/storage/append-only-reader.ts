/**
 * `internal/storage/append-only-reader` — the generic append-only segmented
 * JSONL reader (ADR-0061, X7 slice 4a).
 *
 * Library-internal; never re-exported through a public barrel. Mirrors
 * `./append-only-writer.js` in shape: it is deliberately blind to what an
 * entry *is* and to what public error class an owner raises. An owner
 * supplies a {@link AppendOnlyReadFailure} port that turns a message (and an
 * optional `cause`/`context`) into the owner's own typed error, so a second
 * append-only reader (a future one over `M3LAgentDecisionLog`'s segments,
 * say) reuses this security-critical read path instead of forking a second
 * copy of it.
 *
 * This module reuses the exact segment-name parser the writer's own
 * cold-start discovery uses (`./append-only-segments.js`'s
 * {@link parseSegmentName}), rather than a second regex that could drift
 * from it. Unlike the writer, which only ever scans **today's** date prefix,
 * this module enumerates every date a segment exists under — a fresh
 * process reading back a stream that has lived across midnight has to see
 * all of it, not just today's slice.
 *
 * Every line read back is proven and rebuilt through the exact same
 * `projectAppendOnlyEntry` the writer serializes through
 * (`./append-only-projection.js`), so read and write share one definition of
 * "a value this stream can hold" and can never drift into two. A value the
 * writer could never have produced — a bare array, a bare scalar, `-0`
 * (which the writer refuses because it does not round-trip through JSON), a
 * structure nested past the writer's depth cap, an own `__proto__` key —
 * fails loudly here too, because a segment holding one is not data this
 * stream ever wrote: it is tampering, or a hand-edited file, and an audit
 * trail that quietly reads back bytes it could not have written is not an
 * audit trail.
 *
 * A segment is opened with the same `O_NOFOLLOW` refusal the writer applies
 * (`./append-only-writer.js`'s `APPEND_FLAGS`), so a segment path replaced by
 * a symlink is refused rather than followed, and — unlike an earlier version
 * of this comment claimed — the writer's `nlink === 1` hardlink check IS
 * mirrored here, on the same opened descriptor, for a reason specific to the
 * read side: a hardlink lets a lower-privilege actor **nominate** a file
 * whose contents they cannot read themselves, for a higher-privilege reader
 * to read and then republish into the audit index — where the nominating
 * actor can read it. That is a confused-deputy read primitive, not "a file
 * with two names", and skipping the check here would leave it open even
 * though the writer already closes it on the write side.
 *
 * The same `fstat` also refuses anything that opened but is not a plain
 * regular file — a FIFO planted at a segment path, in particular, would
 * otherwise block `open()` in the kernel forever; see `SEGMENT_READ_FLAGS`'s
 * `O_NONBLOCK` below for the other half of that fix.
 *
 * Every segment is read through `handle.read(...)` in chunks bounded by the
 * caller's own `maxLineBytes`, never `readFile` or `createReadStream` — a
 * segment's trailing, unterminated fragment is checked against that ceiling
 * as it accumulates, so a tampered segment holding one arbitrarily large
 * "line" is abandoned after a small, bounded multiple of `maxLineBytes`
 * rather than read into memory whole.
 */

import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

import { M3LError } from "../../core/errors/index.js";
import {
  isEnoentError,
  isFunction,
  isPlainObject,
} from "../../core/utils/guards.js";
import type { AppendOnlyProjectionFailure } from "./append-only-projection.js";
import { projectAppendOnlyEntry } from "./append-only-projection.js";
import type { ParsedSegmentName } from "./append-only-segments.js";
import { parseSegmentName } from "./append-only-segments.js";

/**
 * `O_NOFOLLOW` where the platform has it — see `./append-only-writer.js`'s
 * identically-motivated constant. `undefined` (never a `NaN` flag) on a
 * platform without it, so the symlink refusal simply does not apply there.
 */
const O_NOFOLLOW: number | undefined = constants.O_NOFOLLOW;

/**
 * `O_NONBLOCK` where the platform has it. Load-bearing for the FIFO refusal
 * below: a plain post-open `fstat` cannot refuse a planted FIFO if `open()`
 * itself never returns. `O_RDONLY` on a FIFO with no writer blocks in the
 * kernel indefinitely; `O_NONBLOCK` makes that same `open()` return
 * immediately instead (Linux/POSIX: opening a FIFO for reading with
 * `O_NONBLOCK` never waits for a writer to appear). It has no effect on a
 * regular file's `open()` or subsequent `read()`s, so every other segment
 * this reader ever opens is unaffected — the `fstat` immediately after open
 * is what actually refuses the FIFO, this flag only makes that `fstat`
 * reachable at all.
 */
const O_NONBLOCK: number | undefined = constants.O_NONBLOCK;

/**
 * Read-only, refusing a symlinked segment path where the platform allows,
 * and never blocking on a planted FIFO/other non-regular file — see
 * {@link O_NOFOLLOW} and {@link O_NONBLOCK} above.
 */
const SEGMENT_READ_FLAGS: number =
  constants.O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0);

/** The only link count a segment this reader opens may legitimately have. */
const SEGMENT_EXPECTED_LINK_COUNT = 1;

/** ASCII line feed (`\n`) — the append-only writer's line terminator. */
const NEWLINE_BYTE = 0x0a;

/**
 * Reported for a trailing, unterminated fragment `read()` tolerates rather
 * than throws on. Structurally identical to the public
 * `M3LAppendOnlyTruncatedSegment` an owner reports this through — this
 * module never imports that type, so a second owner is free to shape its own
 * public payload the same way without pulling in the first owner's types.
 */
export interface AppendOnlyTruncatedSegment {
  /** Bytes in the trailing fragment that had no terminating newline. */
  readonly byteLength: number;
  /** Zero-based index of the segment in read order. */
  readonly segmentIndex: number;
  /** Total number of segments in this read. */
  readonly segmentCount: number;
}

/**
 * How a reader turns one failure's message (and optional detail) into the
 * owner's own typed error. Mirrors `./append-only-projection.js`'s
 * `AppendOnlyProjectionFailure` in spirit: this module never has to name a
 * public class it does not own, and every message and `context` built by the
 * caller of this port must, in turn, never carry a value read out of the
 * stream's directory or an entry's own data — only operational facts this
 * module computed itself.
 */
export type AppendOnlyReadFailure = (
  message: string,
  options?: {
    readonly cause?: unknown;
    readonly context?: Readonly<Record<string, unknown>>;
  },
) => M3LError;

/** The settings one {@link readAppendOnlySegments} call runs under. */
export interface AppendOnlyReaderOptions {
  /** The directory to enumerate segments from. */
  readonly directory: string;
  /** The ceiling an unterminated trailing fragment is measured against. */
  readonly maxLineBytes: number;
  /** Invoked once for a tolerated torn tail on the last segment only. */
  readonly onTruncatedTail?: (segment: AppendOnlyTruncatedSegment) => void;
  /** The owner's error vocabulary for every failure this reader raises. */
  readonly buildError: AppendOnlyReadFailure;
}

/** One segment discovered on disk, in the order lines will be read from it. */
interface DiscoveredSegment extends ParsedSegmentName {
  readonly path: string;
}

/**
 * Per-segment context threaded through {@link readSegmentEntries}: this
 * read's shared ceiling and callback, plus this segment's own position.
 */
interface SegmentReadContext {
  readonly isLastSegment: boolean;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly maxLineBytes: number;
  readonly onTruncatedTail?: (segment: AppendOnlyTruncatedSegment) => void;
  readonly buildError: AppendOnlyReadFailure;
}

/**
 * Lists every segment under `directory`, oldest `(date, sequence)` first.
 *
 * A missing directory yields an empty list rather than throwing — a rebuild
 * against a stream that has never been written to is a normal, empty case.
 * Any other failure (`EACCES`, …) is a real problem with a directory that
 * does exist and propagates as the owner's typed error.
 */
async function discoverSegmentsInOrder(
  directory: string,
  buildError: AppendOnlyReadFailure,
): Promise<readonly DiscoveredSegment[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause) {
    if (isEnoentError(cause)) {
      return [];
    }
    throw buildError("append-only stream: failed to list segments", {
      cause,
    });
  }

  const segments: DiscoveredSegment[] = [];
  for (const name of names) {
    const parsed = parseSegmentName(name);
    if (parsed !== undefined) {
      segments.push({ ...parsed, path: path.join(directory, name) });
    }
  }
  segments.sort((left, right) =>
    left.datePrefix === right.datePrefix
      ? left.sequence - right.sequence
      : left.datePrefix < right.datePrefix
        ? -1
        : 1,
  );
  assertNoSequenceGap(segments, buildError);
  return segments;
}

/**
 * Rejects a gap in `(datePrefix, sequence)` within one date: the writer
 * always starts a date's segments at sequence 1 and increments by exactly
 * one on every rotation (`./append-only-segments.js`), so a missing sequence
 * number between two segments this reader DID find is either an already-
 * deleted segment or one truncated all the way to zero bytes before this
 * date's numbering could roll forward past it — either way, entries this
 * stream once held are unaccounted for.
 *
 * Deliberately scoped: this proves continuity only among the segments
 * actually present on disk. It cannot detect the deletion of a date's own
 * LAST segment (the remaining ones are still perfectly contiguous starting
 * at 1), and an actor able to write the stream directory could rename the
 * remaining segments to close a gap before this check ever runs. It raises
 * the bar against accidental and casual tampering; it does not prove the
 * directory's contents are complete.
 */
function assertNoSequenceGap(
  segments: readonly DiscoveredSegment[],
  buildError: AppendOnlyReadFailure,
): void {
  let previous: DiscoveredSegment | undefined;
  for (const segment of segments) {
    const expectedSequence =
      previous !== undefined && previous.datePrefix === segment.datePrefix
        ? previous.sequence + 1
        : 1;
    if (segment.sequence !== expectedSequence) {
      throw buildError(
        "append-only stream: a segment sequence number is missing",
        {
          context: {
            datePrefix: segment.datePrefix,
            expectedSequence,
            foundSequence: segment.sequence,
          },
        },
      );
    }
    previous = segment;
  }
}

/**
 * Decodes UTF-8 strictly (`fatal: true`) rather than `Buffer#toString`, which
 * silently repairs an invalid byte to U+FFFD — two distinct on-disk byte
 * sequences would otherwise collapse into one accepted entry, which is
 * exactly the "bytes this stream never wrote read back as genuine" defect
 * class this module exists to reject.
 */
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Parses one complete line's bytes as JSON and proves/rebuilds it through
 * {@link projectAppendOnlyEntry} — the same projection the writer serializes
 * through. Every failure — invalid UTF-8, invalid JSON syntax, or a value the
 * projection refuses — is reported in the owner's vocabulary, never skipped.
 */
function parseAndProjectLine(
  lineBytes: Buffer,
  buildError: AppendOnlyReadFailure,
): Readonly<Record<string, unknown>> {
  let text: string;
  try {
    text = STRICT_UTF8_DECODER.decode(lineBytes);
  } catch (cause) {
    throw buildError("append-only stream: a segment line is not valid UTF-8", {
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw buildError("append-only stream: a segment line is not valid JSON", {
      cause,
    });
  }
  const failure: AppendOnlyProjectionFailure = (_field, violation) =>
    buildError(`append-only stream: a segment line is invalid (${violation})`);
  return projectAppendOnlyEntry(parsed, failure);
}

/**
 * Reads one open segment in chunks of exactly `chunkSize` bytes, yielding
 * each raw chunk as it arrives and stopping (without yielding) once `read()`
 * reports `bytesRead === 0`.
 *
 * Kept separate from line-splitting so the ceiling/torn-tail policy in
 * {@link readSegmentEntries} reads as three small steps — read, split,
 * resolve — instead of one function doing all three inline.
 */
async function* readChunks(
  handle: FileHandle,
  chunkSize: number,
): AsyncGenerator<Buffer> {
  const chunk = Buffer.alloc(chunkSize);
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunkSize, null);
    if (bytesRead === 0) {
      return;
    }
    yield chunk.subarray(0, bytesRead);
  }
}

/** One chunk's worth of complete lines, plus the fragment still pending. */
interface SplitLinesResult {
  readonly lines: readonly Buffer[];
  readonly carry: Buffer;
}

/**
 * Appends `rawChunk` to `carry`, extracts every complete (newline-terminated)
 * line, and returns the new trailing fragment.
 *
 * Throws immediately — before the caller reads any further chunk — the
 * moment either the trailing fragment OR an already-extracted COMPLETE line
 * exceeds `maxLineBytes`. Checking only the fragment leaves a gap: `carry`
 * may sit at exactly `maxLineBytes` when the next chunk arrives, so a
 * complete line spanning the two can reach nearly 2x the ceiling before its
 * own terminating newline is even seen — a line the writer, whose own content
 * ceiling is always below `maxLineBytes`, could never have produced. Checking
 * the fragment ALSO still bounds memory for a tampered segment holding one
 * enormous, unterminated line: it is abandoned after at most two chunks'
 * worth of bytes, never the whole file.
 */
function splitLines(
  carry: Buffer,
  rawChunk: Buffer,
  maxLineBytes: number,
  buildError: AppendOnlyReadFailure,
): SplitLinesResult {
  const combined =
    carry.length === 0 ? rawChunk : Buffer.concat([carry, rawChunk]);

  const lines: Buffer[] = [];
  let searchStart = 0;
  for (;;) {
    const newlineIndex = combined.indexOf(NEWLINE_BYTE, searchStart);
    if (newlineIndex === -1) {
      break;
    }
    const line = combined.subarray(searchStart, newlineIndex);
    if (line.length > maxLineBytes) {
      throw buildError(
        "append-only stream: a segment line exceeds the maximum line size",
        { context: { maxLineBytes } },
      );
    }
    lines.push(line);
    searchStart = newlineIndex + 1;
  }

  const nextCarry = Buffer.from(combined.subarray(searchStart));
  if (nextCarry.length > maxLineBytes) {
    throw buildError(
      "append-only stream: a segment line exceeds the maximum line size",
      { context: { maxLineBytes } },
    );
  }
  return { lines, carry: nextCarry };
}

/**
 * Resolves a segment's trailing, unterminated fragment (if any) against this
 * read's torn-tail policy: tolerable only on the last segment, and only when
 * the caller supplied `onTruncatedTail`. Returns the payload to report, or
 * `undefined` when there was no trailing fragment to resolve.
 */
function resolveTornTail(
  carryLength: number,
  context: SegmentReadContext,
): AppendOnlyTruncatedSegment | undefined {
  if (carryLength === 0) {
    return undefined;
  }
  if (!context.isLastSegment) {
    throw context.buildError(
      "append-only stream: a mid-stream segment ends in an unterminated line",
      { context: { byteLength: carryLength } },
    );
  }
  if (context.onTruncatedTail === undefined) {
    throw context.buildError(
      "append-only stream: the last segment ends in an unterminated line",
      { context: { byteLength: carryLength } },
    );
  }
  return {
    byteLength: carryLength,
    segmentIndex: context.segmentIndex,
    segmentCount: context.segmentCount,
  };
}

/**
 * Rejects a segment whose `fstat` reveals it is not a plain, single-link
 * regular file. See {@link readSegmentEntries}'s call site and this module's
 * header for why a FIFO or a hardlink is not safe to read past this point.
 *
 * Extracted from {@link readSegmentEntries} solely to keep that generator's
 * cyclomatic complexity bounded — the check itself is unchanged.
 */
async function assertSegmentIsReadable(
  handle: FileHandle,
  buildError: AppendOnlyReadFailure,
): Promise<void> {
  // See `SEGMENT_READ_FLAGS`/`O_NONBLOCK` above for why this `fstat` is
  // reachable at all for a planted FIFO. `isFile()` refuses any non-regular
  // node (FIFO, device, socket); `nlink` refuses an already-planted
  // hardlink — see this module's header for why a hardlinked segment is
  // NOT harmless to read.
  const stats = await handle.stat();
  if (!stats.isFile() || stats.nlink !== SEGMENT_EXPECTED_LINK_COUNT) {
    throw buildError(
      "append-only stream: a segment path is not a plain, single-link file",
      { context: { isFile: stats.isFile(), nlink: stats.nlink } },
    );
  }
}

/**
 * Rejects a mid-stream (never the last) segment holding NEITHER a complete
 * line NOR a trailing fragment — entirely empty. The writer only ever
 * creates a segment's file as part of the very append that fills it, so a
 * non-last segment with zero bytes on disk was truncated to nothing after
 * the fact. Only the LAST segment in read order may legitimately be empty (a
 * process that opened its next segment and died before writing anything);
 * {@link resolveTornTail} only ever sees a NONZERO carry, so this is a
 * distinct check for a distinct shape of hole.
 *
 * Extracted from {@link readSegmentEntries} solely to keep that generator's
 * cyclomatic complexity bounded — the check itself is unchanged.
 */
function assertMidStreamSegmentNotEmpty(
  carryLength: number,
  lineCount: number,
  context: SegmentReadContext,
): void {
  if (carryLength === 0 && lineCount === 0 && !context.isLastSegment) {
    throw context.buildError(
      "append-only stream: a mid-stream segment holds no entries",
    );
  }
}

/**
 * Reads one segment's complete lines, in file order, and resolves its
 * trailing fragment (if any) against this read's torn-tail policy.
 *
 * The whole lifecycle — `open`, the `fstat` tampering check, the chunked
 * `read`s, `close` — sits under one guard: any failure among them that isn't
 * already the owner's own typed error (thrown by this function itself, by
 * {@link assertSegmentIsReadable}, {@link assertMidStreamSegmentNotEmpty},
 * {@link splitLines}, or {@link resolveTornTail}) is wrapped in it, so
 * nothing leaks a raw Node error out of `read()`.
 */
async function* readSegmentEntries(
  segment: DiscoveredSegment,
  context: SegmentReadContext,
): AsyncGenerator<Readonly<Record<string, unknown>>> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(segment.path, SEGMENT_READ_FLAGS);
    await assertSegmentIsReadable(handle, context.buildError);

    let carry: Buffer = Buffer.alloc(0);
    let lineCount = 0;

    for await (const rawChunk of readChunks(handle, context.maxLineBytes)) {
      const split = splitLines(
        carry,
        rawChunk,
        context.maxLineBytes,
        context.buildError,
      );
      for (const lineBytes of split.lines) {
        lineCount += 1;
        yield parseAndProjectLine(lineBytes, context.buildError);
      }
      carry = split.carry;
    }

    assertMidStreamSegmentNotEmpty(carry.length, lineCount, context);

    const tornTail = resolveTornTail(carry.length, context);
    if (tornTail !== undefined) {
      context.onTruncatedTail?.(tornTail);
    }
  } catch (cause) {
    // Already the owner's own typed error — built by `context.buildError`
    // above, or one it threw through `parseAndProjectLine`/the projection
    // failure port. Re-throw unchanged rather than double-wrapping. A raw
    // Node error (ENOENT/EACCES/ELOOP from `open`/`read`) falls through to
    // the wrap below instead.
    if (cause instanceof M3LError) {
      throw cause;
    }
    throw context.buildError("append-only stream: failed to read a segment", {
      cause,
    });
  } finally {
    // Best-effort: a failing close must not replace the real outcome above.
    try {
      await handle?.close();
    } catch {
      /* ignore — the read outcome above is what matters */
    }
  }
}

/**
 * Reads back every entry across every segment under `options.directory`, in
 * `(date, sequence)` ascending order — the exact order `append()` produced
 * them in.
 *
 * @param options - The directory, line-length ceiling, torn-tail policy, and
 *   error port to read under.
 * @returns Every entry, as the library's own detached, null-prototype
 *   rebuild of what was parsed.
 */
export async function* readAppendOnlySegments(
  options: AppendOnlyReaderOptions,
): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const segments = await discoverSegmentsInOrder(
    options.directory,
    options.buildError,
  );
  const segmentCount = segments.length;
  for (const [segmentIndex, segment] of segments.entries()) {
    yield* readSegmentEntries(segment, {
      isLastSegment: segmentIndex === segmentCount - 1,
      segmentIndex,
      segmentCount,
      maxLineBytes: options.maxLineBytes,
      // Conditional spread rather than a direct assignment: `onTruncatedTail`
      // is optional-but-not-`undefined` under `exactOptionalPropertyTypes`,
      // so explicitly setting it to a value that may be `undefined` is a
      // type error even though the key itself may be omitted.
      ...(options.onTruncatedTail !== undefined && {
        onTruncatedTail: options.onTruncatedTail,
      }),
      buildError: options.buildError,
    });
  }
}

/**
 * Validates {@link M3LAppendOnlyReadOptions.onTruncatedTail} at the public
 * boundary: `options` is typed, but a JS caller (or one bypassing the type)
 * can still hand `read()` a truthy non-function there. Left unchecked, that
 * value silently disables the torn-tail throw at the exact call site meant
 * to invoke it (`context.onTruncatedTail?.(tornTail)`), which is too close to
 * the invariant the whole feature exists to enforce to fail any way but
 * loudly and immediately.
 *
 * @param options - The read options bag exactly as the caller supplied it,
 *   `unknown` because a public method's own static parameter type is never a
 *   runtime guarantee.
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when
 *   `onTruncatedTail` is present and truthy but not callable.
 */
export function assertOnTruncatedTailIsCallable(options: unknown): void {
  if (!isPlainObject(options)) {
    return;
  }
  const onTruncatedTail = options["onTruncatedTail"];
  if (onTruncatedTail && !isFunction(onTruncatedTail)) {
    throw new M3LError(
      'append-only stream: "onTruncatedTail" is invalid (not-a-function)',
      {
        code: "ERR_INVALID_ARGUMENT",
        context: { field: "onTruncatedTail", violation: "not-a-function" },
      },
    );
  }
}
