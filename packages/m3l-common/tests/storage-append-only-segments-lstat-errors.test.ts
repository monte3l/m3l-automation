/**
 * Tests for `listSegmentFiles`'s per-entry `lstat` catch block
 * (`packages/m3l-common/src/internal/storage/append-only-segments.ts`), which
 * neither of the sibling suites can reach.
 *
 * `lstat` (unlike the `stat` it replaced) succeeds on a symlink, a dangling
 * symlink, a directory, and a FIFO alike — it never resolves the link, so
 * none of those real-filesystem fixtures ever make `lstat` itself fail; they
 * are excluded later by the regular-file check, not by this catch. Reaching
 * either arm of the catch — the `ENOENT` skip and the "anything else
 * propagates" rethrow — requires `lstat` to fail on a name `readdir` has
 * already returned, which is not reproducible with real filesystem objects.
 *
 * So THIS FILE — and only this file — mocks `lstat` (and `lstat` alone) from
 * `node:fs/promises`, with every other export, including `readdir`,
 * delegating to the real module, following the same pattern
 * `storage-append-only-segments-order.test.ts` uses for `readdir`. A
 * file-wide hoisted `lstat` mock would defeat the real-filesystem fixtures
 * `storage-append-only-segments-listing.test.ts` depends on (its dangling
 * symlink, symlink loop, directory, and FIFO cases all need the REAL
 * `lstat`), so this suite must never be merged into either sibling.
 *
 * @packageDocumentation
 */

import type * as NodeFsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    lstat: vi.fn(),
  };
});

const mockedLstat = vi.mocked(lstat);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-lstat-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  mockedLstat.mockReset();
});

/** Writes a segment file with real content, via the REAL `writeFile`. */
async function writeRealSegmentFile(
  dir: string,
  fileName: string,
  content: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, "utf8");
}

/**
 * Delegates to the REAL `lstat` for every path except one, for which it
 * rejects with a synthetic error carrying `code`.
 */
async function mockLstatFailingOnlyFor(
  targetPath: string,
  code: string,
): Promise<void> {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  mockedLstat.mockImplementation(async (target, ...rest) => {
    if (target === targetPath) {
      const error = new Error(`synthetic ${code} for lstat`);
      (error as NodeJS.ErrnoException).code = code;
      throw error;
    }
    return actual.lstat(target, ...(rest as []));
  });
}

describe("a per-entry lstat ENOENT is skipped, not fatal", () => {
  test("a segment that vanishes between readdir and its own lstat is skipped while its siblings still list", async () => {
    const dir = path.join(workDir, "audit");
    const survivorA = "2026-01-01-0001.jsonl";
    const vanished = "2026-01-01-0002.jsonl";
    const survivorB = "2026-01-01-0003.jsonl";
    await writeRealSegmentFile(dir, survivorA, '{"event":"a"}\n');
    await writeRealSegmentFile(dir, vanished, '{"event":"vanishing"}\n');
    await writeRealSegmentFile(dir, survivorB, '{"event":"b"}\n');

    // This race is real, not theoretical: nothing in this library ever
    // deletes a segment file itself, but the documented way to reclaim disk
    // space is an operator archiving whole dates out of band — a process
    // that can run concurrently with a `listSegments()` sweep and remove a
    // name between the `readdir` call and that entry's own `lstat`.
    await mockLstatFailingOnlyFor(path.join(dir, vanished), "ENOENT");

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const listed = await stream.listSegments();

    const names = listed.segments.map((segment) => segment.name);
    expect(names).not.toContain(vanished);
    expect(names.sort()).toEqual([survivorA, survivorB].sort());
    expect(listed.skipped).toBe(1);
  });
});

describe("a per-entry lstat failure other than ENOENT propagates", () => {
  test("EACCES on one segment's lstat rejects listSegments with M3LAppendOnlyStreamReadError, cause chained", async () => {
    const dir = path.join(workDir, "audit");
    const survivor = "2026-01-01-0001.jsonl";
    const forbidden = "2026-01-01-0002.jsonl";
    await writeRealSegmentFile(dir, survivor, '{"event":"a"}\n');
    await writeRealSegmentFile(dir, forbidden, '{"event":"forbidden"}\n');

    // `skipped` means "not something this writer left behind" — a genuinely
    // broken filesystem read must never be laundered into that count, so
    // this must reject rather than resolve with an inflated `skipped`.
    await mockLstatFailingOnlyFor(path.join(dir, forbidden), "EACCES");

    const stream = new M3LAppendOnlyStream({ directory: dir });

    let thrown: unknown;
    try {
      await stream.listSegments();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    const error = thrown as M3LAppendOnlyStreamReadError;
    expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_READ");
    expect(error.cause).toBeDefined();
  });
});
