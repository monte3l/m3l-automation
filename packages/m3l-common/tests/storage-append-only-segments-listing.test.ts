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
  link,
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
import {
  currentDatePrefix,
  parseSegmentName,
  segmentFileName,
} from "../src/internal/storage/append-only-segments.js";
import { M3L_APPEND_ONLY_MANIFEST_NAME } from "../src/internal/storage/append-only-manifest.js";

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

/**
 * Lists the `.jsonl` names actually on disk, EXCLUDING the directory-wide
 * `manifest.jsonl` sidecar. The sidecar deliberately does not match the
 * segment-name pattern — it is invisible to the library's own
 * `discoverActiveSegment` / `discoverSegmentsInOrder` / `listSegmentFiles`,
 * so a raw `readdir`-based fixture in this suite must not treat it as a
 * segment either, or it double-counts a file `listSegments()` (correctly)
 * never reports.
 */
async function onDiskSegmentNames(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter(
    (name) => name.endsWith(".jsonl") && name !== M3L_APPEND_ONLY_MANIFEST_NAME,
  );
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

/**
 * Every stream instance constructed via {@link makeStream} in the running
 * test, so `afterEach` can flush each one's writer chain before the sandbox
 * directory is removed.
 */
let activeStreams: M3LAppendOnlyStream[] = [];

/**
 * Constructs an `M3LAppendOnlyStream` and registers it for teardown flushing.
 *
 * Most tests in this suite plant fixture segments directly via
 * `writeSegmentFile` and never call `append()`, so their tracked instance has
 * nothing to flush — harmless, since `flush()` never rejects. The tests that
 * DO call `append()` are exactly the ones exposed to the real race: the
 * manifest seal runs on the writer's own internal chain rather than inside
 * the promise `append()` awaits, so the directory is not guaranteed
 * quiescent the instant the last `append()` call resolves. Tracking every
 * instance uniformly (rather than only the ones that write) keeps this
 * helper simple and safe by construction.
 */
function makeStream(options: {
  directory: string;
  maxSegmentBytes?: number;
}): M3LAppendOnlyStream {
  const stream = new M3LAppendOnlyStream(options);
  activeStreams.push(stream);
  return stream;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-segments-"));
  activeStreams = [];
});

afterEach(async () => {
  // Drain every tracked stream's writer chain before removing the sandbox:
  // the manifest seal runs on the writer's own internal chain rather than
  // inside the promise `append()` awaits, so a still-in-flight seal can
  // otherwise recreate `manifest.jsonl` partway through this recursive
  // remove and surface as `ENOTEMPTY` (which `fs.rm`'s built-in retry list
  // never covers). `flush()` never rejects, so this cannot itself throw.
  await Promise.all(activeStreams.map(async (stream) => stream.flush()));
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
    const stream = makeStream({ directory: dir });

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
    const stream = makeStream({ directory: dir });

    await expect(stream.listSegments()).resolves.toEqual({
      segments: [],
      skipped: 0,
    });
  });

  test("an existing but empty directory yields an empty listing", async () => {
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    const stream = makeStream({ directory: dir });

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
    const stream = makeStream({ directory: dir, maxSegmentBytes });

    for (let index = 0; index < 5; index += 1) {
      await stream.append({ index, pad: "p".repeat(20) });
    }

    const onDisk = await onDiskSegmentNames(dir);
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
    const stream = makeStream({ directory: dir });

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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });

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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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

  // A hardlink is a second directory entry for an EXISTING inode elsewhere —
  // `lstat` cannot tell it apart from an ordinary regular file (unlike a
  // symlink, a directory, or a FIFO, all covered above): `isFile()` is true
  // and `stats.size` is the linked file's real size. `nlink` is on the same
  // `lstat` result already and is the one signal that survives without
  // opening the file — this is the security gap this test exists to close.
  test("[security] a hardlink planted at a segment name is skipped and counted — its target's size never leaks into the listing", async () => {
    const dir = path.join(workDir, "audit");
    const realContent = '{"event":"real"}\n';
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", realContent);

    // A distinctive size, shared with no real segment, planted OUTSIDE the
    // stream's own directory — then hard-linked FROM a segment-shaped name
    // inside the directory, exactly like the symlink case above but via a
    // second directory entry for the same inode rather than a redirect.
    // A distinctive size, chosen so it cannot coincidentally match the real
    // segment's byte length.
    const outsideContent = "h".repeat(654);
    const outsidePath = path.join(workDir, "outside-hardlinked.txt");
    await writeFile(outsidePath, outsideContent, "utf8");
    const hardlinkPath = path.join(dir, "2026-01-02-0001.jsonl");
    await link(outsidePath, hardlinkPath);

    // Confirm the fixture actually reproduces the probe: a second directory
    // entry for the same inode, `isFile()` true, and the outside content's
    // exact size — never derived from calling `listSegments()`.
    const hardlinkStats = await stat(hardlinkPath);
    expect(hardlinkStats.isFile()).toBe(true);
    expect(hardlinkStats.nlink).toBe(2);
    expect(hardlinkStats.size).toBe(Buffer.byteLength(outsideContent));

    const stream = makeStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
    expect(
      listed.segments.some(
        (segment) => segment.byteLength === Buffer.byteLength(outsideContent),
      ),
    ).toBe(false);
    const totalBytes = listed.segments.reduce(
      (sum, segment) => sum + segment.byteLength,
      0,
    );
    expect(totalBytes).toBe(Buffer.byteLength(realContent));
    expect(listed.skipped).toBe(1);
  });

  test("a mixed directory with every planted kind — symlink, directory, FIFO, and hardlink — reports only the one real segment, skipped: 4, and never counts the foreign file", async () => {
    const dir = path.join(workDir, "audit");
    const realContent = '{"event":"real"}\n';
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", realContent);

    await symlink(
      path.join(workDir, "does-not-matter"),
      path.join(dir, "2026-01-01-0002.jsonl"),
    );
    await mkdir(path.join(dir, "2026-01-01-0003.jsonl"));
    execFileSync("mkfifo", [path.join(dir, "2026-01-01-0004.jsonl")]);
    const outsidePath = path.join(workDir, "outside-for-mixed.txt");
    await writeFile(outsidePath, "z".repeat(321), "utf8");
    await link(outsidePath, path.join(dir, "2026-01-01-0005.jsonl"));
    await writeSegmentFile(dir, "notes.txt", "not a segment");

    const stream = makeStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.segments.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
    expect(listed.skipped).toBe(4);
  }, 2000);
});

// ---------------------------------------------------------------------------
// Security: a hardlinked SEGMENT — created by this writer, then hardlinked
// away from the stream directory afterward — is also skipped
// ---------------------------------------------------------------------------

describe("[security] a segment hardlinked away after this writer created it", () => {
  test("[security] a real segment this writer wrote, later hardlinked to a path outside the stream directory, is excluded from the listing (deliberate false positive)", async () => {
    const dir = path.join(workDir, "audit");
    const stream = makeStream({ directory: dir });
    await stream.append({ event: "written-by-this-writer" });

    const onDisk = (await readdir(dir)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    expect(onDisk).toHaveLength(1);
    const segmentName = definedOrThrow(onDisk[0], "the one real segment");
    const segmentPath = path.join(dir, segmentName);

    // Hardlink the segment OUT to a path outside the stream directory. The
    // directory still holds exactly one entry — this is not a planted file,
    // it is this writer's own segment, whose inode now also has a second
    // name elsewhere.
    const outsidePath = path.join(workDir, "linked-elsewhere.jsonl");
    await link(segmentPath, outsidePath);

    const statAfterLink = await stat(segmentPath);
    expect(statAfterLink.nlink).toBe(2);

    const listed = await stream.listSegments();

    // `nlink` cannot say WHICH of the two links is "ours" — only that more
    // than one exists. `read()` already refuses such a segment outright
    // (append-only-reader.ts:436), and `skipped` exists precisely to mean
    // "this directory is not what this writer left behind" rather than "an
    // I/O error occurred". Excluding a segment this writer itself created,
    // the moment ANY second link to its inode appears, is a deliberate false
    // positive: under-reporting a tampered-with segment is the safe
    // direction, since the alternative is silently trusting an inode that
    // may since have been altered through its other name.
    expect(listed.segments).toEqual([]);
    expect(listed.skipped).toBe(1);
  });
});

describe("a clean directory", () => {
  test("reports `skipped: 0` alongside its real segments", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    await writeSegmentFile(dir, "2026-01-01-0002.jsonl", '{"event":"b"}\n');

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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

    const stream = makeStream({ directory: dir });
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
    const stream = makeStream({ directory: dir });

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
    const stream = makeStream({ directory: dir });

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

// ---------------------------------------------------------------------------
// segmentFileName — the single renderer, exercised directly
// ---------------------------------------------------------------------------
//
// `segmentFileName` is exercised transitively below (the real-writer
// round-trip fixture), but that fixture only ever forces single-digit
// sequences. These tests pin its own documented contract directly: the
// sequence is padded to width four, a sequence already at or above four
// digits is NOT truncated (`padStart` is a no-op past its target width),
// and a rendered name round-trips through `parseSegmentName` in both
// regimes.

describe("segmentFileName", () => {
  test.each([
    { sequence: 0, expected: "2026-01-01-0000.jsonl" },
    { sequence: 1, expected: "2026-01-01-0001.jsonl" },
    { sequence: 42, expected: "2026-01-01-0042.jsonl" },
    { sequence: 999, expected: "2026-01-01-0999.jsonl" },
  ])("zero-pads sequence $sequence to width four", ({ sequence, expected }) => {
    expect(segmentFileName("2026-01-01", sequence)).toBe(expected);
  });

  test("does not truncate a sequence already at width four", () => {
    expect(segmentFileName("2026-01-01", 1000)).toBe("2026-01-01-1000.jsonl");
  });

  test("does not truncate a sequence above four digits", () => {
    expect(segmentFileName("2026-01-01", 12345)).toBe("2026-01-01-12345.jsonl");
  });

  test("round-trips through parseSegmentName for a padded (below-width-four) sequence", () => {
    const name = segmentFileName("2026-01-01", 7);
    expect(parseSegmentName(name)).toEqual({
      datePrefix: "2026-01-01",
      sequence: 7,
    });
  });

  test("round-trips through parseSegmentName for a sequence above four digits", () => {
    const name = segmentFileName("2026-01-01", 12345);
    expect(parseSegmentName(name)).toEqual({
      datePrefix: "2026-01-01",
      sequence: 12345,
    });
  });
});

// ---------------------------------------------------------------------------
// [security] parseSegmentName refuses a shape-valid but non-real date
// ---------------------------------------------------------------------------
//
// `SEGMENT_NAME_PATTERN` only checks `\d{4}-\d{2}-\d{2}`'s SHAPE, never
// whether it names a real Gregorian calendar date. Left unchecked,
// `9999-99-99-9999.jsonl` and sixty-four `0000-00-00-NNNN.jsonl` decoys both
// parsed as legitimate segments — a planted `9999-99-99` baseline
// permanently killed the cold-start sweep, and a wall of `0000-00-00`
// decoys consumed an entire sweep budget while a real backlog went sealed
// zero times. `parseSegmentName` is the one parser every consumer of this
// module shares (`discoverActiveSegment`, `nextSegment`, `listSegmentFiles`),
// so this suite exercises it directly rather than only through
// `M3LAppendOnlyStream`.

describe("[security] parseSegmentName refuses a non-real calendar date", () => {
  test.each([
    {
      label: "a shape-valid sentinel that is not a real date",
      datePrefix: "9999-99-99",
    },
    {
      label: "a shape-valid decoy that is not a real date",
      datePrefix: "0000-00-00",
    },
    { label: "a month past December", datePrefix: "2026-13-01" },
    { label: "a day February never reaches", datePrefix: "2026-02-30" },
    { label: "Feb 29 in an ordinary, non-leap year", datePrefix: "2025-02-29" },
    {
      label:
        "Feb 29 in a century year divisible by 100 but not 400 (the rule a naive year % 4 check gets wrong)",
      datePrefix: "1900-02-29",
    },
  ])("refuses $label ($datePrefix)", ({ datePrefix }) => {
    const name = `${datePrefix}-0001.jsonl`;

    expect(parseSegmentName(name)).toBeUndefined();
  });

  test.each([
    { label: "an ordinary date (today, UTC)", datePrefix: currentDatePrefix() },
    { label: "a real leap day (2024-02-29)", datePrefix: "2024-02-29" },
    {
      label: "a real leap day in a century leap year (2000-02-29)",
      datePrefix: "2000-02-29",
    },
  ])("accepts $label", ({ datePrefix }) => {
    const name = `${datePrefix}-0001.jsonl`;

    expect(parseSegmentName(name)).toEqual({ datePrefix, sequence: 1 });
  });

  // The round-trip guarantee: every name this writer's OWN renderer produces
  // must still parse. The names below are never hand-written literals — they
  // are read back from the real filesystem after driving the real writer, so
  // this assertion cannot drift from what `segmentFileName`/`currentDatePrefix`
  // (the module's private renderer, exercised here through its only public
  // surface — actually writing segments) actually render.
  test("every name the real writer produces round-trips through parseSegmentName", async () => {
    const dir = path.join(workDir, "audit");
    const maxSegmentBytes = 40;
    const stream = makeStream({ directory: dir, maxSegmentBytes });

    for (let index = 0; index < 5; index += 1) {
      await stream.append({ index, pad: "p".repeat(20) });
    }

    // Excludes the manifest sidecar: it is not a name the writer produces AS
    // A SEGMENT, so it is never part of the round-trip set below. Its own
    // parser refusal (`parseSegmentName` rejects `manifest.jsonl`'s shape) is
    // separately correct and load-bearing — that refusal is exactly what
    // keeps the sidecar invisible to segment discovery — so this exclusion
    // is a fixture-scoping fix, not a weakening of `parseSegmentName`.
    const onDisk = await onDiskSegmentNames(dir);
    // The fixture must actually force more than one segment, or this is only
    // proving the round trip for a single, first-ever name.
    expect(onDisk.length).toBeGreaterThan(1);

    for (const name of onDisk) {
      const { datePrefix, sequence } = splitSegmentName(name);
      expect(parseSegmentName(name)).toEqual({ datePrefix, sequence });
    }
  });
});
