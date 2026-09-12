/**
 * Tests for `internal/storage/append-only-lines` — the append-only stream's
 * byte-to-line layer: `readChunks`, `splitLines`, and the strict UTF-8 decoder
 * they share.
 *
 * Slice X8b2 extracted this module out of `internal/storage/append-only-reader`
 * so the reader could keep only segment discovery, the per-segment lifecycle,
 * and the torn-tail policy. Until now its behaviour was pinned only
 * INDIRECTLY, through whole-`read()` paths in `storage-append-only-read.test.ts`
 * — which left two arms of the ceiling arithmetic unexercised, because the
 * reader's own chunk size equals `maxLineBytes` and its fixtures never made a
 * single line span two chunks:
 *
 * 1. the `Buffer.concat` arm of the carry splice — `splitLines` had never been
 *    called with a NON-empty carry at all; and
 * 2. the COMPLETE-line ceiling throw. Only the trailing-FRAGMENT ceiling ever
 *    fired, so the guard the module's TSDoc names (a line spanning two chunks
 *    can reach nearly 2x the ceiling before its terminating newline is seen)
 *    was documented but never executed.
 *
 * Both are covered here directly, at the module boundary, together with the
 * exact `line.length + 1 > maxLineBytes` boundary on BOTH sides — a line whose
 * content plus its newline exactly fills the ceiling must be ACCEPTED, and one
 * byte more must be rejected. An off-by-one there would either reject entries
 * the writer legitimately produced or admit ones it never could, and only a
 * two-sided assertion catches it.
 *
 * This suite is a pure function test over buffers plus a hand-built
 * `FileHandle` double: no filesystem, no network, no module mocks, and
 * therefore no teardown.
 *
 * @packageDocumentation
 */

import type { FileHandle } from "node:fs/promises";

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import type { M3LError } from "../src/core/errors/index.js";
import { M3LAppendOnlyStreamReadError } from "../src/core/storage/index.js";
import {
  readChunks,
  splitLines,
  STRICT_UTF8_DECODER,
} from "../src/internal/storage/append-only-lines.js";
import type {
  AppendOnlyReadFailure,
  SplitLinesResult,
} from "../src/internal/storage/append-only-lines.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * The failure port `splitLines` reports through, wired to the same public
 * error class the real reader supplies. Used by every case that is not
 * asserting on the port's own arguments.
 */
const buildFailure: AppendOnlyReadFailure = (message, options) =>
  new M3LAppendOnlyStreamReadError(message, options);

/** The ceiling used throughout: small enough to write exact-length fixtures. */
const MAX_LINE_BYTES = 16;

/** `byteCount` ASCII bytes — one byte per character, so length is byte length. */
function filler(byteCount: number): string {
  return "a".repeat(byteCount);
}

/**
 * A minimal `FileHandle` whose `read()` serves `content` from a moving cursor,
 * mirroring the real contract `readChunks` depends on: it copies into the
 * CALLER's buffer, returns the byte count, and reports `0` at EOF.
 */
function fakeHandle(content: Buffer): FileHandle {
  let position = 0;
  const read = (
    target: Buffer,
    offset: number,
    length: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }> => {
    const end = Math.min(position + length, content.length);
    const bytesRead = content.copy(target, offset, position, end);
    position = end;
    return Promise.resolve({ bytesRead, buffer: target });
  };
  return { read } as unknown as FileHandle;
}

/**
 * A `FileHandle` whose `read()` always rejects with `cause` — a real `Error`,
 * matching what `node:fs/promises` itself rejects with (`readChunks` does no
 * normalization of its own; wrapping is the reader's job).
 */
function failingHandle(cause: Error): FileHandle {
  return {
    read: () => Promise.reject(cause),
  } as unknown as FileHandle;
}

/** Drains `readChunks`, COPYING each chunk (the generator reuses one buffer). */
async function drain(
  chunks: AsyncGenerator<Buffer>,
): Promise<readonly string[]> {
  const seen: string[] = [];
  for await (const chunk of chunks) {
    seen.push(Buffer.from(chunk).toString("utf8"));
  }
  return seen;
}

// ---------------------------------------------------------------------------
// splitLines — line extraction and the carry
// ---------------------------------------------------------------------------

describe("splitLines", () => {
  test("extracts a single complete line and leaves an empty carry", () => {
    const result = splitLines(
      Buffer.alloc(0),
      Buffer.from("one\n"),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.lines.map((line) => line.toString("utf8"))).toEqual(["one"]);
    expect(result.carry).toHaveLength(0);
  });

  test("extracts every complete line in one buffer, in order", () => {
    const result = splitLines(
      Buffer.alloc(0),
      Buffer.from("one\ntwo\nthree\n"),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.lines.map((line) => line.toString("utf8"))).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(result.carry).toHaveLength(0);
  });

  test("returns the trailing unterminated fragment as the carry", () => {
    const result = splitLines(
      Buffer.alloc(0),
      Buffer.from("one\ntw"),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.lines.map((line) => line.toString("utf8"))).toEqual(["one"]);
    expect(result.carry.toString("utf8")).toBe("tw");
  });

  test("returns no lines and an empty carry for an empty buffer", () => {
    const result = splitLines(
      Buffer.alloc(0),
      Buffer.alloc(0),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.lines).toEqual([]);
    expect(result.carry).toHaveLength(0);
  });

  test("treats a buffer that is only a newline as one empty line", () => {
    const result = splitLines(
      Buffer.alloc(0),
      Buffer.from("\n"),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toHaveLength(0);
    expect(result.carry).toHaveLength(0);
  });

  test("preserves an empty line between two consecutive newlines", () => {
    const result = splitLines(
      Buffer.alloc(0),
      Buffer.from("one\n\ntwo\n"),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.lines.map((line) => line.toString("utf8"))).toEqual([
      "one",
      "",
      "two",
    ]);
  });

  test("completes a line whose bytes arrived across two chunks", () => {
    // The `Buffer.concat` arm of the carry splice: the first chunk ends
    // mid-line, and only the second chunk carries the terminating newline.
    const first = splitLines(
      Buffer.alloc(0),
      Buffer.from("on"),
      MAX_LINE_BYTES,
      buildFailure,
    );
    expect(first.lines).toEqual([]);

    const second = splitLines(
      first.carry,
      Buffer.from("e\ntwo\n"),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(second.lines.map((line) => line.toString("utf8"))).toEqual([
      "one",
      "two",
    ]);
    expect(second.carry).toHaveLength(0);
  });

  test("returns a carry that does not alias the chunk buffer handed in", () => {
    // Load-bearing: `readChunks` yields subarrays of ONE reused buffer, so a
    // carry that aliased the chunk would be overwritten by the next read
    // before its line is ever completed.
    const chunk = Buffer.from("partial");

    const result = splitLines(
      Buffer.alloc(0),
      chunk,
      MAX_LINE_BYTES,
      buildFailure,
    );
    chunk.fill(0x58);

    expect(result.carry.toString("utf8")).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// splitLines — the maxLineBytes ceiling
// ---------------------------------------------------------------------------

describe("splitLines ceiling arithmetic", () => {
  test("accepts a complete line whose content plus newline exactly fills the ceiling", () => {
    // `maxLineBytes` counts the newline, so the largest legal content is
    // `maxLineBytes - 1` bytes. This is the ACCEPTING side of the boundary:
    // without it, an implementation rejecting one byte early would still pass
    // the rejection case below.
    const content = filler(MAX_LINE_BYTES - 1);

    const result = splitLines(
      Buffer.alloc(0),
      Buffer.from(`${content}\n`),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.lines.map((line) => line.toString("utf8"))).toEqual([
      content,
    ]);
  });

  test("rejects a complete line one byte over the ceiling", () => {
    // `maxLineBytes` content bytes need `maxLineBytes + 1` bytes on disk.
    const content = filler(MAX_LINE_BYTES);

    expect(() =>
      splitLines(
        Buffer.alloc(0),
        Buffer.from(`${content}\n`),
        MAX_LINE_BYTES,
        buildFailure,
      ),
    ).toThrow(M3LAppendOnlyStreamReadError);
  });

  test("rejects a complete line assembled across two chunks that exceeds the ceiling", () => {
    // The case the module's TSDoc names: the carry may already sit at the
    // ceiling when the next chunk arrives, so a line spanning both can reach
    // nearly 2x `maxLineBytes` before its newline is seen. Checking only the
    // trailing fragment would let this through.
    const carry = Buffer.from(filler(MAX_LINE_BYTES - 1));

    expect(() =>
      splitLines(carry, Buffer.from("bbb\n"), MAX_LINE_BYTES, buildFailure),
    ).toThrow(M3LAppendOnlyStreamReadError);
  });

  test("accepts a trailing fragment whose bytes plus a newline exactly fill the ceiling", () => {
    const fragment = filler(MAX_LINE_BYTES - 1);

    const result = splitLines(
      Buffer.alloc(0),
      Buffer.from(fragment),
      MAX_LINE_BYTES,
      buildFailure,
    );

    expect(result.carry.toString("utf8")).toBe(fragment);
    expect(result.lines).toEqual([]);
  });

  test("rejects a trailing fragment that leaves no room for its newline", () => {
    const fragment = filler(MAX_LINE_BYTES);

    expect(() =>
      splitLines(
        Buffer.alloc(0),
        Buffer.from(fragment),
        MAX_LINE_BYTES,
        buildFailure,
      ),
    ).toThrow(M3LAppendOnlyStreamReadError);
  });

  test("measures the ceiling in bytes, not characters", () => {
    // `é` is two UTF-8 bytes: two of them plus a newline is 5 bytes, over a
    // ceiling of 4, even though it is only two characters.
    const narrowCeiling = 4;

    expect(
      splitLines(
        Buffer.alloc(0),
        Buffer.from("é\n", "utf8"),
        narrowCeiling,
        buildFailure,
      ).lines.map((line) => line.toString("utf8")),
    ).toEqual(["é"]);

    expect(() =>
      splitLines(
        Buffer.alloc(0),
        Buffer.from("éé\n", "utf8"),
        narrowCeiling,
        buildFailure,
      ),
    ).toThrow(M3LAppendOnlyStreamReadError);
  });

  test.each([
    ["a complete line", Buffer.from(`${filler(MAX_LINE_BYTES)}\n`)],
    ["a trailing fragment", Buffer.from(filler(MAX_LINE_BYTES))],
  ])(
    "reports the ceiling breach through the failure port with only library-computed context (%s)",
    (_label, chunk) => {
      const buildError = vi.fn<AppendOnlyReadFailure>(
        (message, options) =>
          new M3LAppendOnlyStreamReadError(message, options),
      );

      let thrown: unknown;
      try {
        splitLines(Buffer.alloc(0), chunk, MAX_LINE_BYTES, buildError);
      } catch (error) {
        thrown = error;
      }

      expect(buildError).toHaveBeenCalledTimes(1);
      const call = buildError.mock.calls[0];
      expect(call?.[0]).toBe(
        "append-only stream: a segment line exceeds the maximum line size",
      );
      // The port's contract forbids caller data — no path, no entry key, no
      // entry value — so the context may carry ONLY facts the splitter itself
      // computed. `maxLineBytes` is the caller's own configured ceiling.
      expect(call?.[1]?.context).toEqual({ maxLineBytes: MAX_LINE_BYTES });
      expect(Object.keys(call?.[1]?.context ?? {})).toEqual(["maxLineBytes"]);
      // The value thrown is exactly what the port returned: the splitter never
      // substitutes an error class of its own.
      expect(thrown).toBe(buildError.mock.results[0]?.value);
    },
  );
});

// ---------------------------------------------------------------------------
// readChunks
// ---------------------------------------------------------------------------

describe("readChunks", () => {
  test("yields the handle's bytes in chunkSize-sized chunks, in order", async () => {
    await expect(
      drain(readChunks(fakeHandle(Buffer.from("abcdef")), 3)),
    ).resolves.toEqual(["abc", "def"]);
  });

  test("trims the final chunk to the bytes actually read", async () => {
    await expect(
      drain(readChunks(fakeHandle(Buffer.from("abcdefg")), 3)),
    ).resolves.toEqual(["abc", "def", "g"]);
  });

  test("yields nothing when the first read reports zero bytes", async () => {
    await expect(
      drain(readChunks(fakeHandle(Buffer.alloc(0)), 8)),
    ).resolves.toEqual([]);
  });

  test("surfaces a read failure to the caller unchanged", async () => {
    const cause = new Error("EIO: i/o error");

    await expect(drain(readChunks(failingHandle(cause), 8))).rejects.toBe(
      cause,
    );
  });
});

// ---------------------------------------------------------------------------
// STRICT_UTF8_DECODER
// ---------------------------------------------------------------------------

describe("STRICT_UTF8_DECODER", () => {
  test("decodes valid UTF-8", () => {
    expect(STRICT_UTF8_DECODER.decode(Buffer.from("café", "utf8"))).toBe(
      "café",
    );
  });

  test("throws on an invalid byte sequence instead of substituting U+FFFD", () => {
    // `Buffer#toString` would silently yield "�" here, collapsing two
    // distinct on-disk byte sequences into one accepted entry.
    expect(() => STRICT_UTF8_DECODER.decode(Buffer.from([0xff, 0xfe]))).toThrow(
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("append-only-lines types", () => {
  test("SplitLinesResult exposes a readonly line list and a carry buffer", () => {
    expectTypeOf<SplitLinesResult>().toEqualTypeOf<{
      readonly lines: readonly Buffer[];
      readonly carry: Buffer;
    }>();
  });

  test("AppendOnlyReadFailure returns an M3LError from a message and options", () => {
    expectTypeOf<AppendOnlyReadFailure>().returns.toEqualTypeOf<M3LError>();
    expectTypeOf<AppendOnlyReadFailure>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<AppendOnlyReadFailure>().parameter(1).toEqualTypeOf<
      | {
          readonly cause?: unknown;
          readonly context?: Readonly<Record<string, unknown>>;
        }
      | undefined
    >();
  });
});
