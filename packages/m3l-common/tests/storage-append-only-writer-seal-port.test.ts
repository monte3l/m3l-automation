/**
 * Tests for `internal/storage/append-only-writer`'s wiring to the REQUIRED
 * `sealer: AppendOnlySealPort` option (X8b writer/seal-port wiring): after
 * each append, `write()` calls `sealer.sealAfterAppend({ rotatedFrom, active
 * })` — `rotatedFrom` is the on-disk name of the segment the append rotated
 * away from (`undefined` when it did not rotate), `active` is the segment the
 * writer is now on.
 *
 * Contract source: `AppendOnlyWriter`'s own TSDoc (`write()`, the private
 * `sealAfterAppend`), `AppendOnlySealPort` / `AppendOnlyWriterOptions`
 * (`./append-only-writer-types.ts`), and `AppendOnlySealRequest`
 * (`./append-only-sealer-types.ts`).
 *
 * The whole reason the sealer is a PORT rather than a concrete
 * `AppendOnlySealer` is that a port is structurally fakeable — the real
 * sealer holds `#private` fields. Every test here drives that seam directly
 * with a recording/throwing/slow stub; no real sealer or manifest is
 * constructed in this file.
 *
 * Each test moves a DIFFERENT guard so that mutating one fails exactly one
 * test:
 * 1. no rotation → `rotatedFrom` undefined, `active` names the segment
 *    actually on disk (name derived from a directory listing, never a
 *    hard-coded date).
 * 2. rotation → `rotatedFrom` names the segment just left, `active` names
 *    the new one, and the two differ.
 * 3. `write()` resolves WITHOUT waiting for the seal to settle — the
 *    slice's ordering decision.
 * 4. a throwing/rejecting port does not fail the append that triggered it,
 *    and does not poison `this.tail` for a later append on the same
 *    instance.
 * 5. a seal failure is never routed through the owner's `errors.appendFailed`.
 * 6. the seal for one append completes before the NEXT append starts —
 *    what makes `active` trustworthy at seal time.
 *
 * A second describe block below pins `AppendOnlyWriter.flush()` (X8b writer
 * seal wiring, flush): it drains `this.tail` as it stood at the moment of the
 * call — a point-in-time wait, never a barrier, never an error channel — over
 * the SAME gated-sealer stub used by item 3 above, because that gate is what
 * makes these assertions deterministic instead of timing-dependent.
 *
 * @packageDocumentation
 */

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import type * as NodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import type { AppendOnlySealRequest } from "../src/internal/storage/append-only-sealer-types.js";
import { AppendOnlyWriter } from "../src/internal/storage/append-only-writer.js";
import type {
  AppendOnlyRenderEntry,
  AppendOnlySealPort,
  AppendOnlyWriterErrors,
  AppendOnlyWriterOptions,
} from "../src/internal/storage/append-only-writer-types.js";

// ---------------------------------------------------------------------------
// Item 6's observation seam: an inert counter wrapped around the REAL
// `appendFile`, so the recorded order reflects when the disk write for one
// append actually happens — never a manufactured event-loop-turn count.
// `importOriginal` keeps every other export (and `appendFile`'s own
// behaviour) untouched; this affects every test in the file identically, so
// only the one test that reads `orderProbe.order` cares that it exists.
// ---------------------------------------------------------------------------

const orderProbe = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      orderProbe.order.push("append");
      return actual.appendFile(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Fixture constants and helpers
// ---------------------------------------------------------------------------

const SEGMENT_SUFFIX = ".jsonl";
const LARGE_MAX_SEGMENT_BYTES = 1_000_000;
const LARGE_MAX_SEGMENT_AGE_MS = 1_000_000;
const LARGE_MAX_LINE_BYTES = 10_000;
/** Small enough that a single rendered line already crosses it. */
const ROTATING_MAX_SEGMENT_BYTES = 5;

interface TestEntry {
  readonly id: string;
}

const renderTestEntry: AppendOnlyRenderEntry<TestEntry> = (entry) =>
  JSON.stringify(entry);

/** A minimal `AppendOnlyWriterErrors` that records every `appendFailed` call. */
function createRecordingErrors(): {
  readonly errors: AppendOnlyWriterErrors;
  readonly appendFailedCalls: unknown[];
} {
  const appendFailedCalls: unknown[] = [];
  return {
    appendFailedCalls,
    errors: {
      oversize: (lineBytes, maxLineBytes) =>
        new M3LError("line too large", {
          code: "ERR_TEST_OVERSIZE",
          context: { lineBytes, maxLineBytes },
        }),
      appendFailed: (cause) => {
        appendFailedCalls.push(cause);
        return new M3LError("append failed", {
          code: "ERR_TEST_APPEND_FAILED",
          cause,
        });
      },
    },
  };
}

/** A minimal `AppendOnlySealPort` that records every request it receives. */
function createRecordingSealer(): {
  readonly sealer: AppendOnlySealPort;
  readonly calls: AppendOnlySealRequest[];
} {
  const calls: AppendOnlySealRequest[] = [];
  return {
    calls,
    sealer: {
      sealAfterAppend: (request): Promise<void> => {
        calls.push(request);
        return Promise.resolve();
      },
    },
  };
}

interface WriterOverrides {
  readonly maxSegmentBytes?: number;
  readonly maxSegmentAgeMs?: number;
  readonly maxLineBytes?: number;
  readonly errors?: AppendOnlyWriterErrors;
}

function buildWriter(
  directory: string,
  sealer: AppendOnlySealPort,
  overrides: WriterOverrides = {},
): AppendOnlyWriter<TestEntry> {
  const options: AppendOnlyWriterOptions<TestEntry> = {
    directory,
    maxSegmentBytes: overrides.maxSegmentBytes ?? LARGE_MAX_SEGMENT_BYTES,
    maxSegmentAgeMs: overrides.maxSegmentAgeMs ?? LARGE_MAX_SEGMENT_AGE_MS,
    maxLineBytes: overrides.maxLineBytes ?? LARGE_MAX_LINE_BYTES,
    renderEntry: renderTestEntry,
    errors: overrides.errors ?? createRecordingErrors().errors,
    sealer,
  };
  return new AppendOnlyWriter<TestEntry>(options);
}

/** Lists the segment files on disk — never a hard-coded date-derived name. */
async function listSegmentFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((name) => name.endsWith(SEGMENT_SUFFIX)).sort();
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AppendOnlyWriter — seal port wiring", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "aow-seal-port-"));
    orderProbe.order.length = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("no rotation: rotatedFrom is undefined, active names the segment on disk", async () => {
    const { sealer, calls } = createRecordingSealer();
    const writer = buildWriter(directory, sealer);

    await writer.write({ id: "first" });

    const [segmentFile] = await listSegmentFiles(directory);
    expect(segmentFile).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ rotatedFrom: undefined, active: segmentFile });
  });

  test("rotation: rotatedFrom names the segment just left, active names the new one", async () => {
    // Mutation this catches: append() returning `undefined` unconditionally
    // — rotatedFrom would stay undefined even after a genuine rotation.
    const { sealer, calls } = createRecordingSealer();
    const writer = buildWriter(directory, sealer, {
      maxSegmentBytes: ROTATING_MAX_SEGMENT_BYTES,
    });

    await writer.write({ id: "first" });
    await writer.write({ id: "second" });

    expect(calls).toHaveLength(2);
    const [firstCall, secondCall] = calls;
    expect(firstCall?.rotatedFrom).toBeUndefined();

    // `rotatedFrom` is now an object (name + byteLength), not a bare name —
    // pin both fields. `byteLength` is asserted against the segment's real
    // on-disk size, read independently via `stat`, never against whatever
    // the writer itself reported: rotation never mutates the segment it
    // left, so its size at this point already equals its final size.
    expect(secondCall?.rotatedFrom?.name).toBe(firstCall?.active);
    const rotatedFromPath = path.join(directory, firstCall?.active ?? "");
    const { size: rotatedFromRealBytes } = await stat(rotatedFromPath);
    expect(rotatedFromRealBytes).toBeGreaterThan(0);
    expect(secondCall?.rotatedFrom?.byteLength).toBe(rotatedFromRealBytes);
    expect(secondCall?.active).not.toBe(secondCall?.rotatedFrom?.name);

    const segmentFiles = await listSegmentFiles(directory);
    expect(segmentFiles).toContain(firstCall?.active);
    expect(segmentFiles).toContain(secondCall?.active);
  });

  test("write() resolves without waiting for the seal to settle", async () => {
    const gate = createDeferred<void>();
    let sealSettled = false;
    const sealer: AppendOnlySealPort = {
      sealAfterAppend: async () => {
        await gate.promise;
        sealSettled = true;
      },
    };
    const writer = buildWriter(directory, sealer);

    await writer.write({ id: "first" });
    // Mutation this catches: awaiting the seal inside the promise write()
    // itself awaits. If it did, the line above would still be pending,
    // because `gate` has not been released yet.
    expect(sealSettled).toBe(false);

    gate.resolve();
    // A second write only completes once the pending tail — which now
    // carries the still-running seal — settles, so its resolution is
    // itself proof the first seal actually finished (not a manufactured
    // wait).
    await writer.write({ id: "second" });
    expect(sealSettled).toBe(true);
  });

  test.each<[string, () => AppendOnlySealPort]>([
    [
      "throws synchronously",
      () => ({
        sealAfterAppend: () => {
          throw new Error("sync seal boom");
        },
      }),
    ],
    [
      "returns a rejected promise",
      () => ({
        sealAfterAppend: () => Promise.reject(new Error("async seal boom")),
      }),
    ],
  ])(
    "a sealer that %s does not fail the append, and does not poison later writes",
    async (_label, makeSealer) => {
      const writer = buildWriter(directory, makeSealer());

      await expect(writer.write({ id: "first" })).resolves.toBeUndefined();
      // The real point: a SECOND write on the same instance must also
      // resolve — this.tail must always settle fulfilled, or a poisoned
      // tail wedges every later append on the instance. This is
      // defence-in-depth on the writer's OWN side, deliberately not
      // redundant with the sealer's documented never-rejects contract.
      await expect(writer.write({ id: "second" })).resolves.toBeUndefined();

      const [segmentFile] = await listSegmentFiles(directory);
      const contents = await readFile(
        path.join(directory, segmentFile ?? ""),
        "utf8",
      );
      expect(contents).toContain('"first"');
      expect(contents).toContain('"second"');
    },
  );

  test("a seal failure is never reported through the owner's appendFailed", async () => {
    // Mutation this catches: moving the seal call inside append()'s own
    // try/finally, which would route a thrown seal error through
    // errors.appendFailed and reject write() with it instead of swallowing
    // it as a seal-only failure.
    const { errors, appendFailedCalls } = createRecordingErrors();
    const throwingSealer: AppendOnlySealPort = {
      sealAfterAppend: () => {
        throw new Error("seal boom");
      },
    };
    const writer = buildWriter(directory, throwingSealer, { errors });

    await expect(writer.write({ id: "first" })).resolves.toBeUndefined();

    expect(appendFailedCalls).toHaveLength(0);
  });

  test("the seal for one append completes before the next append starts", async () => {
    const sealer: AppendOnlySealPort = {
      sealAfterAppend: (): Promise<void> => {
        orderProbe.order.push("seal");
        return Promise.resolve();
      },
    };
    const writer = buildWriter(directory, sealer);

    // Fired concurrently, not awaited individually — the ordering under
    // test is enforced by the writer's own tail chaining, not by this test
    // choosing to await between calls.
    await Promise.all([
      writer.write({ id: "first" }),
      writer.write({ id: "second" }),
    ]);

    expect(orderProbe.order).toEqual(["append", "seal", "append", "seal"]);
  });
});

describe("AppendOnlyWriter.flush()", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "aow-flush-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("flush() waits for a seal that write() did not wait for", async () => {
    // Mutation this catches: flush() returning without awaiting `this.tail`
    // (e.g. a no-op body, or awaiting something already-settled instead).
    const gate = createDeferred<void>();
    let sealSettled = false;
    const sealer: AppendOnlySealPort = {
      sealAfterAppend: async () => {
        await gate.promise;
        sealSettled = true;
      },
    };
    const writer = buildWriter(directory, sealer);

    // The existing fact this builds on: write() resolves without waiting
    // for the seal — so the seal is still pending, gated closed, right
    // after this line.
    await writer.write({ id: "first" });
    expect(sealSettled).toBe(false);

    let flushed = false;
    const flushPromise = writer.flush().then(() => {
      flushed = true;
    });

    // Several microtask turns — fair to any correct implementation, never a
    // wall-clock race — with the gate still closed: flush() must still be
    // pending.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(sealSettled).toBe(false);

    gate.resolve();
    await flushPromise;
    expect(flushed).toBe(true);
    expect(sealSettled).toBe(true);
  });

  test("flush() does not reject when the sealer throws, and the writer stays usable", async () => {
    // Mutation this catches: flush() rethrowing whatever this.tail's
    // fulfillment handler produced instead of swallowing it — flush() is
    // documented as never rejecting and not an error channel.
    const throwingSealer: AppendOnlySealPort = {
      sealAfterAppend: () => {
        throw new Error("seal boom");
      },
    };
    const writer = buildWriter(directory, throwingSealer);

    await writer.write({ id: "first" });
    await expect(writer.flush()).resolves.toBeUndefined();

    // The writer stays usable: a later write still resolves and its line
    // still lands, proving flush() calling into a throwing sealer did not
    // wedge the instance.
    await expect(writer.write({ id: "second" })).resolves.toBeUndefined();
    const [segmentFile] = await listSegmentFiles(directory);
    const contents = await readFile(
      path.join(directory, segmentFile ?? ""),
      "utf8",
    );
    expect(contents).toContain('"first"');
    expect(contents).toContain('"second"');
  });

  test("flush() on a writer that has never written resolves immediately and creates nothing on disk", async () => {
    // A directory this writer has never touched — never passed to mkdtemp,
    // so it does not exist yet: the writer creates it lazily on first
    // append (AppendOnlyWriter.resolveActiveSegment's cold-start branch),
    // and flush() alone must not trigger that.
    const untouchedDirectory = path.join(directory, "untouched");
    const { sealer, calls } = createRecordingSealer();
    const writer = buildWriter(untouchedDirectory, sealer);

    await expect(writer.flush()).resolves.toBeUndefined();

    await expect(readdir(untouchedDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(calls).toHaveLength(0);
  });

  test("flush() is a point-in-time drain: a write() started after flush() was called is not folded into it", async () => {
    // Mutation this catches: flush() re-reading `this.tail` after an await
    // (chasing whatever it becomes next) instead of capturing the value at
    // the moment of the call. gate2 is deliberately NEVER released — if
    // flush() waited for write2's still-pending seal too, this test would
    // hang until the runner's own timeout rather than resolving.
    const gate1 = createDeferred<void>();
    const gate2 = createDeferred<void>();
    let sealCall = 0;
    const sealer: AppendOnlySealPort = {
      sealAfterAppend: async () => {
        sealCall += 1;
        if (sealCall === 1) {
          await gate1.promise;
        } else {
          await gate2.promise;
        }
      },
    };
    const writer = buildWriter(directory, sealer);

    // write1's append settles immediately; its seal is gated on gate1, so
    // `this.tail` is now the pending chain flush() below will capture.
    await writer.write({ id: "first" });

    const flushPromise = writer.flush();

    // Started AFTER flush() already captured `this.tail` — it chains onto
    // that same pending value, and its OWN seal is gated on gate2.
    const write2 = writer.write({ id: "second" });

    // Release only write1's seal.
    gate1.resolve();
    await expect(flushPromise).resolves.toBeUndefined();

    // write2's append is unaffected by its own seal never settling — it
    // still lands, proving flush() above did not need to wait for it.
    await expect(write2).resolves.toBeUndefined();
    const [segmentFile] = await listSegmentFiles(directory);
    const contents = await readFile(
      path.join(directory, segmentFile ?? ""),
      "utf8",
    );
    expect(contents).toContain('"second"');
  });
});
