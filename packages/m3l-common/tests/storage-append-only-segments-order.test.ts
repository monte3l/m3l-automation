/**
 * Kills a surviving mutation on `M3LAppendOnlyStream.listSegments()`: the
 * ascending `(datePrefix, sequence)` sort was removed entirely and the
 * existing `storage-append-only-segments-listing.test.ts` ordering case
 * still passed. On ext4 with `dir_index`, `readdir` happens to return the
 * fixture's four segment names in an order that is already sorted (a
 * name-hash artifact, not something creation order controls), so that test's
 * input to the sort is already sorted and can never observe whether the sort
 * ran at all.
 *
 * The only deterministic way to prove the sort is to control what `readdir`
 * hands back, so THIS FILE — and only this file — mocks `readdir` (and
 * `readdir` alone) from `node:fs/promises`, returning names in deliberately
 * reversed/scrambled order while every other export, including `lstat`,
 * passes through to the real module. The segment files are still real files
 * on real disk, so `lstat`-derived fields (`byteLength`, `modifiedAtMs`)
 * remain genuine.
 *
 * DO NOT merge this into `storage-append-only-segments-listing.test.ts`:
 * `vi.mock` is hoisted and file-wide, so doing so would route that suite's
 * dangling-symlink and symlink-loop cases — whose entire point is exercising
 * real filesystem primitives — through a mocked module instead.
 *
 * @packageDocumentation
 */

import type * as NodeFsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LAppendOnlyStream } from "../src/core/storage/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

const mockedReaddir = vi.mocked(readdir);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-stream-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  mockedReaddir.mockReset();
});

/** Writes a segment file with exact bytes, via the REAL `writeFile`. */
async function writeRealSegmentFile(
  dir: string,
  fileName: string,
  content: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, "utf8");
}

describe("listSegments sorts a scrambled readdir result", () => {
  test("a maximally-reversed readdir order still resolves ascending by (datePrefix, sequence)", async () => {
    const dir = path.join(workDir, "audit");
    const ascending = [
      "2026-01-01-0001.jsonl",
      "2026-01-01-0002.jsonl",
      "2026-01-01-0010.jsonl",
      "2026-01-02-0001.jsonl",
    ];
    for (const name of ascending) {
      await writeRealSegmentFile(dir, name, '{"scrambled":true}\n');
    }

    // The exact reverse of the expected order: a missing sort produces the
    // maximally wrong answer rather than a subtly wrong one.
    mockedReaddir.mockResolvedValueOnce([...ascending].reverse() as never);

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.skipped).toBe(0);
    expect(listed.segments.map((segment) => segment.name)).toEqual(ascending);
  });

  test("interleaved dates prove the comparator orders by date first, then sequence within a date", async () => {
    const dir = path.join(workDir, "audit");
    const ascending = [
      "2026-01-01-0002.jsonl",
      "2026-01-01-0010.jsonl",
      "2026-01-02-0001.jsonl",
      "2026-01-02-0002.jsonl",
    ];
    for (const name of ascending) {
      await writeRealSegmentFile(dir, name, '{"interleaved":true}\n');
    }

    // Neither "sequence only" nor "date only" produces this order: a
    // sequence-only sort would put -0001 segments before -0002/-0010, and a
    // date-only sort would leave the two 2026-01-01 entries in the order
    // below (0010 before 0002).
    mockedReaddir.mockResolvedValueOnce([
      "2026-01-02-0002.jsonl",
      "2026-01-01-0010.jsonl",
      "2026-01-02-0001.jsonl",
      "2026-01-01-0002.jsonl",
    ] as never);

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    expect(listed.skipped).toBe(0);
    expect(listed.segments.map((segment) => segment.name)).toEqual(ascending);
  });
});
