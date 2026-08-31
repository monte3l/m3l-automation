/**
 * Tests for the segment-handle LIFECYCLE on `M3LAppendOnlyStream.read`
 * (X7b): which `close` failures are raised, which are chained onto a
 * primary error, and which stay silent.
 *
 * Separate from the sibling `storage-append-only-read.test.ts` for one
 * mechanical reason: every case here needs a `close` that REJECTS, and that
 * suite's probe (`wrapHandleClose`) only counts successful closes. Building
 * a rejecting close into it would change the seam every one of its tests
 * shares. The probe below therefore always performs the REAL close first —
 * so no descriptor leaks out of a test — and only then throws the injected
 * error in its place.
 *
 * @packageDocumentation
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type * as NodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";
import type {
  M3LAppendOnlyEntry,
  M3LAppendOnlyReadOptions,
} from "../src/core/storage/index.js";

/**
 * The one seam these tests need: an opt-in failure injected into
 * `FileHandle.close`, plus a count of every close attempted.
 */
const closeProbe = vi.hoisted(() => ({
  /** Set to make every subsequent `close` throw this after really closing. */
  failWith: undefined as Error | undefined,
  /** Every close attempted on a handle this suite's `open` handed out. */
  calls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const realClose = handle.close.bind(handle);
      const tracked = (async () => {
        closeProbe.calls += 1;
        // Always release the real descriptor before simulating the
        // failure, so an injected error never leaks an fd across tests.
        await realClose();
        if (closeProbe.failWith !== undefined) {
          throw closeProbe.failWith;
        }
      }) as FileHandle["close"];
      Object.defineProperty(handle, "close", {
        value: tracked,
        configurable: true,
      });
      return handle;
    },
  };
});

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-lifecycle-"));
});

afterEach(async () => {
  closeProbe.failWith = undefined;
  closeProbe.calls = 0;
  await rm(workDir, { recursive: true, force: true });
});

/** Builds the segment file name the stream reads, matching its own writer. */
function segmentName(datePrefix: string, sequence: number): string {
  return `${datePrefix}-${String(sequence).padStart(4, "0")}.jsonl`;
}

/** Writes a segment file with EXACT bytes — no newline is appended. */
async function writeSegmentFile(
  dir: string,
  name: string,
  contents: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), contents, "utf8");
}

/**
 * Drains a read to completion, returning whatever it threw (or undefined).
 *
 * `options` is `unknown` on purpose: one case below passes an own
 * `onTruncatedTail` key holding `undefined`, which `exactOptionalPropertyTypes`
 * forbids assigning to `M3LAppendOnlyReadOptions` — and that bag existing at
 * all is exactly what the case exercises, since a JS caller can build one.
 */
async function drain(
  stream: M3LAppendOnlyStream,
  options?: unknown,
): Promise<{ entries: M3LAppendOnlyEntry[]; thrown: unknown }> {
  const entries: M3LAppendOnlyEntry[] = [];
  try {
    for await (const entry of stream.read(
      options as M3LAppendOnlyReadOptions | undefined,
    )) {
      entries.push(entry);
    }
  } catch (error) {
    return { entries, thrown: error };
  }
  return { entries, thrown: undefined };
}

/** Walks a `.cause` chain, bounded, collecting every link. */
function causeChain(error: unknown): unknown[] {
  const links: unknown[] = [];
  let link: unknown = error;
  for (let depth = 0; depth < 10 && link instanceof Error; depth += 1) {
    links.push(link.cause);
    link = link.cause;
  }
  return links;
}

describe("close failure on the success path", () => {
  test("surfaces as a read error carrying the close failure as its cause", async () => {
    const dir = path.join(workDir, "audit");
    const entry = { event: "one" };
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify(entry)}\n`,
    );

    const closeFailure = new Error("EIO: close failed");
    closeProbe.failWith = closeFailure;

    const { entries, thrown } = await drain(
      new M3LAppendOnlyStream({ directory: dir }),
    );

    // Every entry was still handed over — the segment WAS read faithfully;
    // the descriptor is what could not be released.
    expect(entries).toEqual([entry]);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect((thrown as M3LAppendOnlyStreamReadError).message).toBe(
      "append-only stream: failed to close a segment after reading it",
    );
    // Identity, not shape: the caller's only diagnostic is the real errno.
    expect((thrown as M3LAppendOnlyStreamReadError).cause).toBe(closeFailure);
  });

  test("closes exactly once per segment", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify({ event: "one" })}\n`,
    );
    await writeSegmentFile(
      dir,
      segmentName("2026-01-02", 1),
      `${JSON.stringify({ event: "two" })}\n`,
    );

    const { entries, thrown } = await drain(
      new M3LAppendOnlyStream({ directory: dir }),
    );

    expect(thrown).toBeUndefined();
    expect(entries).toHaveLength(2);
    // Two segments, two closes: the success-path close must not be joined
    // by a second one from the `finally`.
    expect(closeProbe.calls).toBe(2);
  });
});

describe("close failure alongside a read failure", () => {
  test("surfaces the read failure and chains the close failure onto it", async () => {
    const dir = path.join(workDir, "audit");
    // A malformed line makes the READ arm fire; the injected close error
    // makes the CLEANUP arm fire on the same segment. Both are genuinely
    // reached — this is not a synthesized double failure.
    await writeSegmentFile(dir, segmentName("2026-01-01", 1), "{not json}\n");

    const closeFailure = new Error("EIO: close failed");
    closeProbe.failWith = closeFailure;

    const { thrown } = await drain(new M3LAppendOnlyStream({ directory: dir }));

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    // The READ failure is what the caller sees — the close failure must not
    // have replaced it.
    expect((thrown as M3LAppendOnlyStreamReadError).message).toBe(
      "append-only stream: a segment line is not valid JSON",
    );
    // …and the close failure is still reachable, deeper in the chain,
    // wrapped in the owner's own vocabulary.
    const chained = causeChain(thrown).find(
      (link) =>
        link instanceof M3LAppendOnlyStreamReadError &&
        link.message ===
          "append-only stream: failed to close a segment after reading it",
    );
    expect(chained).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect((chained as M3LAppendOnlyStreamReadError).cause).toBe(closeFailure);
    // The parse failure's own diagnostic was not overwritten to make room.
    expect((thrown as M3LAppendOnlyStreamReadError).cause).toBeInstanceOf(
      SyntaxError,
    );
  });
});

describe("close failure on the early-break path", () => {
  test("stays silent — a break is a successful way to stop reading", async () => {
    const dir = path.join(workDir, "audit");
    const first = { event: "one" };
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify(first)}\n${JSON.stringify({ event: "two" })}\n`,
    );

    closeProbe.failWith = new Error("EIO: close failed");

    const seen: M3LAppendOnlyEntry[] = [];
    let thrown: unknown;
    try {
      for await (const entry of new M3LAppendOnlyStream({
        directory: dir,
      }).read()) {
        seen.push(entry);
        break;
      }
    } catch (error) {
      thrown = error;
    }

    expect(seen).toEqual([first]);
    expect(thrown).toBeUndefined();
    // The handle was still released, silently.
    expect(closeProbe.calls).toBe(1);
  });
});

describe("an own onTruncatedTail key holding undefined", () => {
  test("degrades to the absent-callback path, which still throws", async () => {
    const dir = path.join(workDir, "audit");
    // No trailing newline on the last segment: a torn tail.
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify({ event: "one" })}\n{"event":"tor`,
    );

    // The key is PRESENT and allowed, but falsy — it must not be passed
    // through as a present-but-uncallable callback, which would silently
    // swallow the torn tail this call never opted out of.
    const { thrown } = await drain(
      new M3LAppendOnlyStream({ directory: dir }),
      {
        onTruncatedTail: undefined,
      },
    );

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
  });
});
