/**
 * `internal/storage/append-only-lines` — the append-only stream's byte-to-line
 * layer: strict UTF-8 decoding, bounded chunked reads, and newline splitting
 * under the caller's line-size ceiling (ADR-0061, ADR-0102, X8b slice 2).
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * the append-only reader (`./append-only-reader.js`) so that module keeps only
 * segment discovery, the per-segment lifecycle, and the torn-tail policy — the
 * two concerns had grown past what one file can hold under
 * `check:file-budget`'s ratchet, and the reader has to make room for the
 * sealed-segment manifest verification landing on it.
 *
 * The dependency runs one way only: `./append-only-reader.js` imports this
 * module, never the reverse. Nothing here knows what an entry *is* or what
 * public error class an owner raises — every failure is reported through the
 * reader's own {@link AppendOnlyReadFailure} port.
 */

import type { FileHandle } from "node:fs/promises";

import type { M3LError } from "../../core/errors/index.js";

/**
 * How a reader turns one failure's message (and optional detail) into the
 * owner's own typed error. Mirrors `./append-only-projection.js`'s
 * `AppendOnlyProjectionFailure` in spirit: `./append-only-reader.js` never has
 * to name a public class it does not own, and every message and `context`
 * built by the caller of this port must, in turn, never carry a value read out
 * of the stream's directory or an entry's own data — only operational facts
 * the reader computed itself.
 */
export type AppendOnlyReadFailure = (
  message: string,
  options?: {
    readonly cause?: unknown;
    readonly context?: Readonly<Record<string, unknown>>;
  },
) => M3LError;

/**
 * ASCII line feed (`\n`) — the append-only writer's line terminator.
 *
 * Deliberately NOT exported: {@link splitLines} is its only consumer, and
 * `knip` rejects an export nothing outside this module imports.
 */
const NEWLINE_BYTE = 0x0a;

/**
 * Decodes UTF-8 strictly (`fatal: true`) rather than `Buffer#toString`, which
 * silently repairs an invalid byte to U+FFFD — two distinct on-disk byte
 * sequences would otherwise collapse into one accepted entry, which is
 * exactly the "bytes this stream never wrote read back as genuine" defect
 * class `./append-only-reader.js` exists to reject.
 *
 * Annotated as `InstanceType<typeof TextDecoder>` because `TextDecoder` is a
 * global value with no ambient TYPE under this tsconfig (no DOM lib), and
 * `isolatedDeclarations` requires an explicit annotation on a `new`
 * initializer.
 */
export const STRICT_UTF8_DECODER: InstanceType<typeof TextDecoder> =
  new TextDecoder("utf-8", { fatal: true });

/**
 * Reads one open segment in chunks of exactly `chunkSize` bytes, yielding
 * each raw chunk as it arrives and stopping (without yielding) once `read()`
 * reports `bytesRead === 0`.
 *
 * Kept separate from line-splitting so the ceiling/torn-tail policy in
 * `./append-only-reader.js`'s per-segment read loop reads as three small
 * steps — read, split, resolve — instead of one function doing all three
 * inline.
 */
export async function* readChunks(
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
export interface SplitLinesResult {
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
export function splitLines(
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
    // The writer measures one write() as `content + "\n"` together; the
    // largest content it can emit is therefore `maxLineBytes - 1` bytes.
    // Comparing `line.length + 1` (content re-measured with its newline)
    // against `maxLineBytes` aligns the reader's ceiling with the writer's
    // exactly — a line of `maxLineBytes` content bytes would need
    // `maxLineBytes + 1` bytes on disk and is one byte over the limit.
    if (line.length + 1 > maxLineBytes) {
      throw buildError(
        "append-only stream: a segment line exceeds the maximum line size",
        { context: { maxLineBytes } },
      );
    }
    lines.push(line);
    searchStart = newlineIndex + 1;
  }

  const nextCarry = Buffer.from(combined.subarray(searchStart));
  // A trailing fragment is a prefix of a future line that will include a
  // newline, so the same "content + newline must fit in maxLineBytes" rule
  // applies: if the fragment alone already fills maxLineBytes, the complete
  // line (fragment + remaining content + newline) would exceed the ceiling.
  if (nextCarry.length + 1 > maxLineBytes) {
    throw buildError(
      "append-only stream: a segment line exceeds the maximum line size",
      { context: { maxLineBytes } },
    );
  }
  return { lines, carry: nextCarry };
}
