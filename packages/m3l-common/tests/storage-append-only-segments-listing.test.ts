/**
 * Tests for `core/storage`'s append-only stream SEGMENT-LISTING method:
 * `M3LAppendOnlyStream.listSegments()`, the `M3LAppendOnlySegment` descriptor
 * it resolves, and the `M3LAppendOnlySegmentListing` object that wraps them.
 *
 * This is a new public method, split into its own file (rather than added to
 * the already near-budget `storage-append-only-stream.test.ts` /
 * `storage-append-only-read.test.ts`) purely for the per-file byte budget —
 * it is not a separate contract, it shares the writer's segment-naming
 * convention (`<YYYY-MM-DD>-<NNNN>.jsonl`) and the reader's
 * `parseSegmentName` parser.
 *
 * The one deliberate divergence from `read()` this suite exists to pin: an
 * inventory of what is actually on disk must never refuse to run just
 * because the trail it is inventorying is damaged (a gap in the sequence).
 * `read()` throws on exactly that gap; `listSegments()` reports around it.
 * An inventory that only works on a healthy trail is useless exactly when a
 * damaged trail is the reason someone reaches for it.
 *
 * A second, security-motivated guarantee lives here too: the inventory must
 * never FOLLOW a symlink planted at a segment name — `read()` and the writer
 * both already refuse via `O_NOFOLLOW`, and a listing that dereferenced a
 * planted link could disclose the size (and, if ever read, the contents) of
 * a file outside the stream's own directory. `listSegments()` therefore
 * `lstat`s each candidate and reports only regular files; anything else
 * (a symlink, a directory, a FIFO) is skipped and counted, never followed.
 *
 * `M3LAppendOnlySegmentListing.skipped` counts ONLY entries whose name
 * `parseSegmentName` accepts but which could not be inventoried as a real
 * segment. A foreign name (a stray `notes.txt`, a `README`, a differently
 * shaped `.jsonl`) was never a segment in the first place and is never
 * counted — otherwise any directory holding an unrelated file would read as
 * damaged.
 *
 * Every guarantee here is a filesystem invariant — real `stat`/`lstat`
 * results, a real dangling symlink, a real symlink loop, a real directory, a
 * real FIFO, a real non-directory path component — so this suite uses a REAL
 * temporary directory throughout and never mocks `node:fs`/`node:fs/promises`.
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

import {
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";
import type {
  M3LAppendOnlyEntry,
  M3LAppendOnlySegment,
  M3LAppendOnlySegmentListing,
} from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * Writes a segment (or foreign) file with EXACT bytes, creating its parent
 * directory first. No newline is appended on top of `content` — a fixture
 * built this way can plant precisely the bytes a test needs, unlike one
 * produced by driving the writer (which always emits `line + "\n"` and can
 * never produce a foreign or damaged name).
 */
async function writeSegmentFile(
  dir: string,
  fileName: string,
  content: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/** Awaits `run` and returns whatever it rejected with, or `undefined`. */
async function catchRejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Drains an async iterable into an array. */
async function collectEntries(
  iterable: AsyncIterable<M3LAppendOnlyEntry>,
): Promise<M3LAppendOnlyEntry[]> {
  const collected: M3LAppendOnlyEntry[] = [];
  for await (const entry of iterable) {
    collected.push(entry);
  }
  return collected;
}

/** Splits a segment name into its date-prefix and sequence-number parts. */
function splitSegmentName(name: string): {
  datePrefix: string;
  sequence: number;
} {
  const withoutExtension = name.replace(/\.jsonl$/, "");
  const parts = withoutExtension.split("-");
  const sequencePart = definedOrThrow(
    parts[parts.length - 1],
    "the sequence segment of the name",
  );
  const datePrefix = parts.slice(0, 3).join("-");
  return { datePrefix, sequence: Number(sequencePart) };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-segments-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Type contracts
// ---------------------------------------------------------------------------

describe("type contracts", () => {
  test("a segment descriptor is a read-only five-field record", () => {
    expectTypeOf<M3LAppendOnlySegment>().toEqualTypeOf<{
      readonly name: string;
      readonly datePrefix: string;
      readonly sequence: number;
      readonly byteLength: number;
      readonly modifiedAtMs: number;
    }>();
  });

  test("a segment listing is a read-only two-field record: the segments array and a skipped count", () => {
    expectTypeOf<M3LAppendOnlySegmentListing>().toEqualTypeOf<{
      readonly segments: readonly M3LAppendOnlySegment[];
      readonly skipped: number;
    }>();
  });

  test("listSegments takes no parameters and resolves a segment listing", () => {
    expectTypeOf<
      M3LAppendOnlyStream["listSegments"]
    >().parameters.toEqualTypeOf<[]>();
    expectTypeOf<M3LAppendOnlyStream["listSegments"]>().returns.toEqualTypeOf<
      Promise<M3LAppendOnlySegmentListing>
    >();
  });

  test("calling listSegments resolves the documented listing type", async () => {
    const dir = path.join(workDir, "type-only");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    expectTypeOf(
      stream.listSegments(),
    ).resolves.toEqualTypeOf<M3LAppendOnlySegmentListing>();

    // Consume the promise so, once the symbol exists, a missing directory's
    // resolved (not rejected) empty listing never surfaces as an unhandled
    // rejection from this type-only assertion.
    await stream.listSegments().catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// Missing / empty sources
// ---------------------------------------------------------------------------

describe("missing or empty sources", () => {
  test("a directory that has never been created yields an empty listing", async () => {
    const dir = path.join(workDir, "never-created");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    await expect(stream.listSegments()).resolves.toEqual({
      segments: [],
      skipped: 0,
    });
  });

  test("an existing but empty directory yields an empty listing", async () => {
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    const stream = new M3LAppendOnlyStream({ directory: dir });

    await expect(stream.listSegments()).resolves.toEqual({
      segments: [],
      skipped: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Real appends — every segment on disk is reported, with real stat data
// ---------------------------------------------------------------------------

describe("after real appends", () => {
  test("lists one entry per segment file actually on disk, each with real stat data", async () => {
    const dir = path.join(workDir, "audit");
    const maxSegmentBytes = 40;
    const stream = new M3LAppendOnlyStream({ directory: dir, maxSegmentBytes });

    for (let index = 0; index < 5; index += 1) {
      await stream.append({ index, pad: "p".repeat(20) });
    }

    const onDisk = (await readdir(dir)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    // The fixture must actually force more than one segment, or the ordering
    // and per-file agreement assertions below are checking only one file.
    expect(onDisk.length).toBeGreaterThan(1);

    const listed = await stream.listSegments();
    expect(listed.skipped).toBe(0);
    expect(listed.segments).toHaveLength(onDisk.length);
    expect(listed.segments.map((segment) => segment.name).sort()).toEqual(
      [...onDisk].sort(),
    );

    for (const segment of listed.segments) {
      expect(segment.name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4,}\.jsonl$/);
      const { datePrefix, sequence } = splitSegmentName(segment.name);
      expect(segment.datePrefix).toBe(datePrefix);
      expect(segment.sequence).toBe(sequence);

      const info = await stat(path.join(dir, segment.name));
      expect(segment.byteLength).toBe(info.size);
      expect(Number.isFinite(segment.modifiedAtMs)).toBe(true);
      expect(segment.modifiedAtMs).toBeGreaterThan(0);
    }
  });
});

describe("exact byteLength", () => {
  test("byteLength equals the exact byte length of a hand-written segment", async () => {
    const dir = path.join(workDir, "audit");
    const content = '{"event":"exact-byte-length-check"}\n';
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", content);
    const stream = new M3LAppendOnlyStream({ directory: dir });

    const listed = await stream.listSegments();
    expect(listed.segments).toHaveLength(1);
    const only = definedOrThrow(listed.segments[0], "the only segment");
    expect(only.byteLength).toBe(Buffer.byteLength(content));
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("ordering", () => {
  test("orders oldest date prefix first, then ascending sequence within a date, from a scrambled directory", async () => {
    const dir = path.join(workDir, "audit");
    const line = '{"scrambled":true}\n';

    // Deliberately scrambled creation order.
    await writeSegmentFile(dir, "2026-01-02-0001.jsonl", line);
    await writeSegmentFile(dir, "2026-01-01-0010.jsonl", line);
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", line);
    await writeSegmentFile(dir, "2026-01-01-0002.jsonl", line);

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
      "2026-01-01-0002.jsonl",
      "2026-01-01-0010.jsonl",
      "2026-01-02-0001.jsonl",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Only this stream's own segment names are listed
// ---------------------------------------------------------------------------

describe("foreign names are skipped", () => {
  test("skips a plain foreign file, a foreign extension, and a lossily zero-padded sequence — none of it counts as `skipped`", async () => {
    const dir = path.join(workDir, "audit");
    const validLine = '{"valid":true}\n';
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", validLine);
    await writeSegmentFile(dir, "notes.txt", "not a segment");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl.bak", validLine);
    await writeSegmentFile(dir, "README", "not a segment either");
    // Parses to sequence 5 but re-renders as "-0005.jsonl" (four digits),
    // never round-tripping back to this five-digit, zero-padded name.
    await writeSegmentFile(dir, "2026-01-01-00005.jsonl", validLine);

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
    // None of the foreign names were ever segment-shaped: they were never
    // segments in the first place, so they must not inflate `skipped`.
    expect(listed.skipped).toBe(0);
  });

  test("accepts a genuinely wide sequence number that round-trips exactly", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-12345.jsonl", '{"wide":true}\n');

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments).toHaveLength(1);
    const only = definedOrThrow(listed.segments[0], "the only segment");
    expect(only.name).toBe("2026-01-01-12345.jsonl");
    expect(only.sequence).toBe(12_345);
    expect(listed.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No continuity assertion — the deliberate divergence from read()
// ---------------------------------------------------------------------------

describe("a damaged trail is still inventoried", () => {
  test("listSegments reports what remains on disk while read() rejects on the same gap", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    await writeSegmentFile(dir, "2026-01-01-0002.jsonl", '{"event":"b"}\n');
    await rm(path.join(dir, "2026-01-01-0001.jsonl"));

    const stream = new M3LAppendOnlyStream({ directory: dir });

    // (a) the inventory does not refuse to run against the gap, and a
    // segment simply missing from `readdir` (never a stat failure) is not
    // counted as `skipped`.
    const listed = await stream.listSegments();
    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0002.jsonl",
    ]);
    expect(listed.skipped).toBe(0);

    // (b) the SAME on-disk gap makes read() reject — proving the pair is the
    // point: listSegments() is not merely lenient because nothing detected
    // the gap, read() detects the identical gap and refuses.
    const readThrown = await catchRejected(() => collectEntries(stream.read()));
    expect(readThrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
  });
});

// ---------------------------------------------------------------------------
// A per-segment stat failure — a rotation race
// ---------------------------------------------------------------------------

describe("a rotation race — a dangling symlink's stat ENOENTs", () => {
  test("skips the dangling entry rather than throwing, and counts it in `skipped`", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    // A REAL dangling symlink: readdir sees the name, but a symlink is never
    // a regular file regardless of whether its target resolves —
    // reproducing a rotation that raced the listing.
    await symlink(
      path.join(dir, "does-not-exist"),
      path.join(dir, "2026-01-01-0002.jsonl"),
    );

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
    expect(listed.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Security: a non-regular file at a segment name is never followed
// ---------------------------------------------------------------------------

describe("[security] a non-regular file planted at a segment name", () => {
  test("[security] a symlink planted at a segment name is skipped and counted — its target's size never leaks into the listing", async () => {
    const dir = path.join(workDir, "audit");
    const realContent = '{"event":"real"}\n';
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", realContent);

    // A distinctive size that shares nothing with any real segment's byte
    // length, planted OUTSIDE the stream's own directory.
    const outsideContent = "s".repeat(37);
    const outsidePath = path.join(workDir, "secret.txt");
    await writeFile(outsidePath, outsideContent, "utf8");
    await symlink(outsidePath, path.join(dir, "2026-01-02-0001.jsonl"));

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
    expect(
      listed.segments.some(
        (segment) => segment.byteLength === outsideContent.length,
      ),
    ).toBe(false);
    expect(listed.skipped).toBe(1);
  });

  test("a directory planted at a segment name is skipped and counted, never reported as a segment", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"real"}\n');
    await mkdir(path.join(dir, "2026-01-02-0001.jsonl"));

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
    expect(listed.skipped).toBe(1);
  });

  test("a FIFO planted at a segment name is skipped and counted, and does not hang the listing", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"real"}\n');
    const fifoPath = path.join(dir, "2026-01-02-0001.jsonl");
    // node:fs has no FIFO API — a real FIFO can only be created via mkfifo(1).
    execFileSync("mkfifo", [fifoPath]);

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
    expect(listed.skipped).toBe(1);
  }, 2000);

  test("a mixed directory: real segments count, a symlink and a directory are skipped, a foreign file counts as neither", async () => {
    const dir = path.join(workDir, "audit");
    const contentA = '{"event":"a"}\n';
    const contentB = '{"event":"b","pad":"pp"}\n';
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", contentA);
    await writeSegmentFile(dir, "2026-01-01-0002.jsonl", contentB);
    await symlink(
      path.join(workDir, "does-not-matter"),
      path.join(dir, "2026-01-01-0003.jsonl"),
    );
    await mkdir(path.join(dir, "2026-01-01-0004.jsonl"));
    await writeSegmentFile(dir, "notes.txt", "not a segment");

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name).sort()).toEqual([
      "2026-01-01-0001.jsonl",
      "2026-01-01-0002.jsonl",
    ]);
    // The symlink and the directory are both segment-shaped names that
    // could not be inventoried; `notes.txt` was never segment-shaped and
    // must not inflate the count.
    expect(listed.skipped).toBe(2);

    const totalBytes = listed.segments.reduce(
      (sum, segment) => sum + segment.byteLength,
      0,
    );
    expect(totalBytes).toBe(
      Buffer.byteLength(contentA) + Buffer.byteLength(contentB),
    );
  });
});

describe("a clean directory", () => {
  test("reports `skipped: 0` alongside its real segments", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    await writeSegmentFile(dir, "2026-01-01-0002.jsonl", '{"event":"b"}\n');

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments).toHaveLength(2);
    expect(listed.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A symlink loop is a non-regular file, not a distinct stat failure
// ---------------------------------------------------------------------------

describe("a symlink loop is a non-regular file, not a stat failure", () => {
  // NOTE ON A DOCUMENTED-GUARANTEE CHANGE: under the OLD `stat`-based
  // implementation, a symlink loop's `stat()` call failed with an ELOOP-class
  // error that propagated as a rejection (see the prior version of this
  // suite). Under the NEW `lstat`-based implementation, `lstat` never
  // resolves the link at all, so it never touches the loop and succeeds
  // trivially on each loop member — which then fails the regular-file check
  // and is SKIPPED, exactly like the dangling-symlink and planted-symlink
  // cases above. Verified directly against Node's real `lstat`/`stat`
  // behavior on a two-symlink loop before writing this assertion, per the
  // hub's explicit request to determine (not guess) which way this goes.
  test("lstat never follows the loop, so both loop entries are skipped rather than rejecting the call", async () => {
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    // A REAL symlink loop: each entry's OWN lstat succeeds (it never
    // resolves the link), but stat() on either name would fail to resolve.
    await symlink(
      "2026-01-01-0003.jsonl",
      path.join(dir, "2026-01-01-0002.jsonl"),
    );
    await symlink(
      "2026-01-01-0002.jsonl",
      path.join(dir, "2026-01-01-0003.jsonl"),
    );

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments).toEqual([]);
    expect(listed.skipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A readdir failure other than ENOENT is wrapped
// ---------------------------------------------------------------------------

describe("a readdir failure is wrapped", () => {
  test("a non-directory path component surfaces as M3LAppendOnlyStreamReadError with cause chained", async () => {
    const blockerPath = path.join(workDir, "blocker");
    await writeFile(blockerPath, "not a directory", "utf8");
    const dir = path.join(blockerPath, "sub");

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const thrown = await catchRejected(() => stream.listSegments());

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    const error = thrown as M3LAppendOnlyStreamReadError;
    expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_READ");
    expect(error.cause).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Read-only inventory
// ---------------------------------------------------------------------------

describe("read-only inventory", () => {
  test("a listSegments call never changes the directory listing", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    await writeSegmentFile(dir, "2026-01-01-0002.jsonl", '{"event":"b"}\n');
    const stream = new M3LAppendOnlyStream({ directory: dir });

    const before = [...(await readdir(dir))].sort();
    const beforeContents = await Promise.all(
      before.map((name) => readFile(path.join(dir, name), "utf8")),
    );

    await stream.listSegments();

    const after = [...(await readdir(dir))].sort();
    const afterContents = await Promise.all(
      after.map((name) => readFile(path.join(dir, name), "utf8")),
    );
    expect(after).toEqual(before);
    expect(afterContents).toEqual(beforeContents);
  });
});

// ---------------------------------------------------------------------------
// Fresh array per call
// ---------------------------------------------------------------------------

describe("fresh array per call", () => {
  test("mutating a previously returned segments array does not affect a later call", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    const stream = new M3LAppendOnlyStream({ directory: dir });

    const first = await stream.listSegments();
    expect(Array.isArray(first.segments)).toBe(true);

    // Mutate the caller's own copy through an `unknown` seam — the return
    // type is `readonly`, so this only compiles as a deliberate cast to
    // prove the underlying array is not shared with the stream's next call.
    const mutableCopy = first.segments as M3LAppendOnlySegment[];
    mutableCopy.push({
      name: "2099-01-01-9999.jsonl",
      datePrefix: "2099-01-01",
      sequence: 9999,
      byteLength: 0,
      modifiedAtMs: 0,
    });

    const second = await stream.listSegments();
    expect(second.segments).toHaveLength(1);
    expect(second.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
  });
});
