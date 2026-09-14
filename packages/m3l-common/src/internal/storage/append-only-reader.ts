/**
 * `internal/storage/append-only-reader` — the generic append-only segmented
 * JSONL reader (ADR-0061, X7 slice 4a).
 *
 * Library-internal; never re-exported through a public barrel. Mirrors
 * `./append-only-writer.js` in shape: it is deliberately blind to what an
 * entry *is* and to what public error class an owner raises. An owner
 * supplies a {@link "./append-only-lines.js".AppendOnlyReadFailure} port that
 * turns a message (and an optional `cause`/`context`) into the owner's own
 * typed error, so a second append-only reader (a future one over
 * `M3LAgentDecisionLog`'s segments, say) reuses this security-critical read
 * path instead of forking a second copy of it.
 *
 * **Which segments a read covers — and whether that set is the whole trail —
 * is not this module's question.** `./append-only-read-plan.js` owns it, and
 * owns the reasoning behind it: enumerating every date a segment exists
 * under, consulting the directory-wide `manifest.jsonl` sidecar (ADR-0102),
 * escalating a sealed segment that is no longer on disk, and walking
 * sequence continuity over the union of what is present and what the
 * manifest still accounts for. That planning runs to completion before
 * {@link readAppendOnlySegments} opens anything, so an incomplete or
 * unverifiable trail is refused on the consumer's first `next()` rather than
 * midway through a read; this module receives a settled list of segments and
 * does nothing but read them. The two error ports in the options mirror the
 * same split: a proof-layer refusal (`buildManifestError`) reads differently
 * from "this trail would not parse" (`buildError`).
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
 * A segment is opened under `./append-only-fs.js`'s guarded open flags
 * ({@link "./append-only-fs.js".SEGMENT_READ_FLAGS}) and proven through its
 * post-open `fstat` refusals
 * ({@link "./append-only-fs.js".assertSegmentIsReadable}), so a segment path
 * replaced by a symlink, a hardlink nominating an inode this reader would
 * otherwise republish, and a planted FIFO are all refused rather than read.
 * Those refusals and the reasons each of them exists — in particular why a
 * hardlinked segment is a confused-deputy read primitive rather than "a file
 * with two names" — are documented in that module's header. They were split
 * out of this module so the writer, the segment layer, and ADR-0102's
 * sealed-segment manifest sidecar open under the same refusals rather than a
 * copy each.
 *
 * Every segment is read through `handle.read(...)` in chunks bounded by the
 * caller's own `maxLineBytes`, never `readFile` or `createReadStream` — a
 * segment's trailing, unterminated fragment is checked against that ceiling
 * as it accumulates, so a tampered segment holding one arbitrarily large
 * "line" is abandoned after a small, bounded multiple of `maxLineBytes`
 * rather than read into memory whole. The chunking and newline-splitting
 * themselves live in `./append-only-lines.js`, split out of this module to
 * keep both files under `check:file-budget`'s ratchet.
 */

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

import { M3LError } from "../../core/errors/index.js";
import { isPromise } from "../../core/utils/guards.js";
import { chainSecondaryFailure } from "../errors/chain-secondary-failure.js";
import {
  assertSegmentIsReadable,
  SEGMENT_READ_FLAGS,
} from "./append-only-fs.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import {
  readChunks,
  splitLines,
  STRICT_UTF8_DECODER,
} from "./append-only-lines.js";
import type { AppendOnlyProjectionFailure } from "./append-only-projection.js";
import { projectAppendOnlyEntry } from "./append-only-projection.js";
import type { DiscoveredSegment } from "./append-only-read-plan.js";
import { planSegmentsToRead } from "./append-only-read-plan.js";
import type {
  AppendOnlyReaderOptions,
  AppendOnlyTruncatedSegment,
} from "./append-only-reader-types.js";

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
 * Hands one tolerated torn tail to the read's `onTruncatedTail`, and — when
 * that handler returns a thenable — waits for it to settle, so a rejection
 * fails the read instead of disappearing.
 *
 * **A rejection reaching the caller is the OPPOSITE of how the sealer treats
 * its own reporting handler, and the difference is deliberate.**
 * {@link "./append-only-seal-report.js".reportSealFailure} attaches to and
 * SWALLOWS a thenable `onSealFailed` returns, because the sealer owes its
 * caller a never-throws append path and has nothing left to report a
 * reporting failure to. The read path owes no such contract, and this handler
 * is the only notification saying a trailing record was dropped — so a
 * handler that failed to record that must fail the read rather than leave the
 * caller holding a clean-looking, short trail. A future reader should not
 * carry the sealer's rule across to here.
 *
 * The option is typed `(segment) => void`, and TypeScript's void-return
 * compatibility rule accepts an `async` handler, so a returned promise is
 * ordinary type-checked caller code rather than an abuse of the option.
 * ESLint's `no-misused-promises` sees only some of the shapes that reach
 * here — never one arriving through an options object whose type was
 * inferred rather than annotated — so this contract is held at runtime and
 * never delegated to the linter.
 *
 * Called from inside {@link readSegmentEntries}' single guard, so a rejection
 * surfaces as the owner's own read error carrying the handler's error as
 * `cause` — exactly what a SYNCHRONOUS throw from the same handler already
 * produces, rather than a second shape a caller would have to discriminate.
 *
 * **A handler that never settles stalls the read**, holding this segment's
 * descriptor open for as long as it takes. There is no timeout here on
 * purpose: any number picked would either abandon a slow-but-honest handler
 * or paper over a wedged one, and the caller who wrote the handler is the
 * only party able to judge which. The hazard is stated where that caller
 * reads it, on
 * {@link "../../core/storage/append-only-read-types.js".M3LAppendOnlyReadOptions.onTruncatedTail}.
 */
async function reportTornTail(
  tail: AppendOnlyTruncatedSegment,
  context: SegmentReadContext,
): Promise<void> {
  // Widened to `unknown` rather than awaited directly: the declared return
  // type is `void`, so an `await` on the call itself would read as a mistake
  // — and the value that arrives anyway is exactly what this settles.
  const reported = context.onTruncatedTail?.(tail) as unknown;
  if (isPromise(reported)) {
    await reported;
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

/** Raised when a segment's handle cannot be released. */
const CLOSE_FAILURE_MESSAGE =
  "append-only stream: failed to close a segment after reading it";

/**
 * Releases a segment handle on a NON-success path — a read failure, or the
 * consumer's early `break` (which resumes the generator at its `finally` via
 * `.return()`).
 *
 * Never throws. With a primary error already in flight the close failure is
 * CHAINED onto it ({@link chainSecondaryFailure}) rather than replacing it:
 * the read failure is what the caller must act on, but a descriptor the OS
 * refused to release is a real second fault. With no primary error this is
 * the early-`break` path — a normal, successful way to stop reading — so it
 * stays silent.
 */
async function releaseAfterFailure(
  handle: FileHandle,
  primaryError: unknown,
  context: SegmentReadContext,
): Promise<void> {
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      chainSecondaryFailure(
        primaryError,
        context.buildError(CLOSE_FAILURE_MESSAGE, { cause: closeError }),
      );
    }
  }
}

/**
 * Reads one segment's complete lines, in file order, and resolves its
 * trailing fragment (if any) against this read's torn-tail policy.
 *
 * The whole lifecycle — `open`, the `fstat` tampering check, the chunked
 * `read`s, `close` — sits under one guard: any failure among them that isn't
 * already the owner's own typed error (thrown by this function itself, by
 * {@link "./append-only-fs.js".assertSegmentIsReadable},
 * {@link assertMidStreamSegmentNotEmpty},
 * {@link "./append-only-lines.js".splitLines}, or {@link resolveTornTail}) is
 * wrapped in it, so nothing leaks a raw Node error out of `read()`.
 *
 * That guard is also what gives {@link reportTornTail} its shape: the
 * owner's `onTruncatedTail` is caller code, so whatever it throws — or
 * rejects with — is wrapped here as `cause`, and a synchronous throw and an
 * async rejection from the same handler therefore reach the caller
 * identically.
 *
 * `close` is split across two paths. On the SUCCESS path it closes inside
 * the `try` and a failure throws: the segment was read to completion, so
 * there is no other outcome for it to displace, and swallowing it reports a
 * clean read over a descriptor the OS never released. Every other path
 * defers to {@link releaseAfterFailure}. `closeAttempted` keeps the two
 * apart — without it the `finally` would double-close after success, and
 * folding the success close INTO the `finally` would make an early `break`
 * start throwing.
 */
async function* readSegmentEntries(
  segment: DiscoveredSegment,
  context: SegmentReadContext,
): AsyncGenerator<Readonly<Record<string, unknown>>> {
  let handle: FileHandle | undefined;
  let closeAttempted = false;
  let primaryError: unknown;
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
      await reportTornTail(tornTail, context);
    }

    // Claim the close before attempting it, so the `finally` stands down
    // whether it succeeds or throws.
    closeAttempted = true;
    try {
      await handle.close();
    } catch (cause) {
      throw context.buildError(CLOSE_FAILURE_MESSAGE, { cause });
    }
  } catch (cause) {
    // Already the owner's own typed error — built by `context.buildError`
    // above, or one it threw through `parseAndProjectLine`/the projection
    // failure port. Re-throw unchanged rather than double-wrapping. A raw
    // Node error (ENOENT/EACCES/ELOOP from `open`/`read`) falls through to
    // the wrap below instead.
    primaryError =
      cause instanceof M3LError
        ? cause
        : context.buildError("append-only stream: failed to read a segment", {
            cause,
          });
    throw primaryError;
  } finally {
    if (!closeAttempted && handle !== undefined) {
      await releaseAfterFailure(handle, primaryError, context);
    }
  }
}

/**
 * Reads back every entry across every segment under `options.directory`, in
 * `(date, sequence)` ascending order — the exact order `append()` produced
 * them in.
 *
 * `./append-only-read-plan.js` settles which segments that is, and whether
 * they account for the whole trail, before the first segment is opened — so a
 * directory whose accounting does not add up is refused on the consumer's
 * first `next()`. Everything below that line is reading.
 *
 * @param options - The directory, the two size ceilings, the torn-tail and
 *   archival policies, and the two error ports to read under.
 * @returns Every entry, as the library's own detached, null-prototype
 *   rebuild of what was parsed.
 */
export async function* readAppendOnlySegments(
  options: AppendOnlyReaderOptions,
): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const segments = await planSegmentsToRead(options);
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
