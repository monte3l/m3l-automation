/**
 * Tests for `core/storage`'s append-only stream SEGMENT-LISTING method:
 * `M3LAppendOnlyStream.listSegments()` and the `M3LAppendOnlySegment`
 * descriptor it resolves.
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
 * Every guarantee here is a filesystem invariant — real `stat` results, a
 * real dangling symlink, a real symlink loop, a real non-directory path
 * component — so this suite uses a REAL temporary directory throughout and
 * never mocks `node:fs`/`node:fs/promises`.
 *
 * @packageDocumentation
 */

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

  test("listSegments takes no parameters and resolves a read-only array of segments", () => {
    expectTypeOf<
      M3LAppendOnlyStream["listSegments"]
    >().parameters.toEqualTypeOf<[]>();
    expectTypeOf<M3LAppendOnlyStream["listSegments"]>().returns.toEqualTypeOf<
      Promise<readonly M3LAppendOnlySegment[]>
    >();
  });

  test("calling listSegments resolves the documented array type", async () => {
    const dir = path.join(workDir, "type-only");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    expectTypeOf(stream.listSegments()).resolves.toEqualTypeOf<
      readonly M3LAppendOnlySegment[]
    >();

    // Consume the promise so, once the symbol exists, a missing directory's
    // resolved (not rejected) empty array never surfaces as an unhandled
    // rejection from this type-only assertion.
    await stream.listSegments().catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// Missing / empty sources
// ---------------------------------------------------------------------------

describe("missing or empty sources", () => {
  test("a directory that has never been created yields an empty array", async () => {
    const dir = path.join(workDir, "never-created");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    await expect(stream.listSegments()).resolves.toEqual([]);
  });

  test("an existing but empty directory yields an empty array", async () => {
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    const stream = new M3LAppendOnlyStream({ directory: dir });

    await expect(stream.listSegments()).resolves.toEqual([]);
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
    expect(listed).toHaveLength(onDisk.length);
    expect(listed.map((segment) => segment.name).sort()).toEqual(
      [...onDisk].sort(),
    );

    for (const segment of listed) {
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
    expect(listed).toHaveLength(1);
    const only = definedOrThrow(listed[0], "the only segment");
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

    expect(listed.map((segment) => segment.name)).toEqual([
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
  test("skips a plain foreign file, a foreign extension, and a lossily zero-padded sequence", async () => {
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

    expect(listed.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
  });

  test("accepts a genuinely wide sequence number that round-trips exactly", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-12345.jsonl", '{"wide":true}\n');

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed).toHaveLength(1);
    const only = definedOrThrow(listed[0], "the only segment");
    expect(only.name).toBe("2026-01-01-12345.jsonl");
    expect(only.sequence).toBe(12_345);
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

    // (a) the inventory does not refuse to run against the gap.
    const listed = await stream.listSegments();
    expect(listed.map((segment) => segment.name)).toEqual([
      "2026-01-01-0002.jsonl",
    ]);

    // (b) the SAME on-disk gap makes read() reject — proving the pair is the
    // point: listSegments() is not merely lenient because nothing detected
    // the gap, read() detects the identical gap and refuses.
    const readThrown = await catchRejected(() => collectEntries(stream.read()));
    expect(readThrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
  });
});

// ---------------------------------------------------------------------------
// A per-segment stat failure
// ---------------------------------------------------------------------------

describe("a rotation race — a dangling symlink's stat ENOENTs", () => {
  test("skips the dangling entry rather than throwing", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    // A REAL dangling symlink: readdir sees the name, stat follows the link
    // and fails ENOENT — reproducing a rotation that raced the listing.
    await symlink(
      path.join(dir, "does-not-exist"),
      path.join(dir, "2026-01-01-0002.jsonl"),
    );

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
  });
});

describe("a non-ENOENT stat failure propagates", () => {
  test("a real symlink loop's ELOOP-class stat failure rejects listSegments", async () => {
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    // A REAL symlink loop: stat() on either name fails to resolve.
    await symlink(
      "2026-01-01-0003.jsonl",
      path.join(dir, "2026-01-01-0002.jsonl"),
    );
    await symlink(
      "2026-01-01-0002.jsonl",
      path.join(dir, "2026-01-01-0003.jsonl"),
    );

    const stream = new M3LAppendOnlyStream({ directory: dir });

    // The exact errno the platform surfaces for a symlink loop is not
    // pinned — only that the per-segment stat guard does NOT widen to
    // swallow it, i.e. the call must not resolve.
    await expect(stream.listSegments()).rejects.toBeDefined();
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
  test("mutating a previously returned array does not affect a later call", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, "2026-01-01-0001.jsonl", '{"event":"a"}\n');
    const stream = new M3LAppendOnlyStream({ directory: dir });

    const first = await stream.listSegments();
    expect(Array.isArray(first)).toBe(true);

    // Mutate the caller's own copy through an `unknown` seam — the return
    // type is `readonly`, so this only compiles as a deliberate cast to
    // prove the underlying array is not shared with the stream's next call.
    const mutableCopy = first as M3LAppendOnlySegment[];
    mutableCopy.push({
      name: "2099-01-01-9999.jsonl",
      datePrefix: "2099-01-01",
      sequence: 9999,
      byteLength: 0,
      modifiedAtMs: 0,
    });

    const second = await stream.listSegments();
    expect(second).toHaveLength(1);
    expect(second.map((segment) => segment.name)).toEqual([
      "2026-01-01-0001.jsonl",
    ]);
  });
});
