/**
 * Tests for `core/storage`'s append-only stream READ path (X7 slice 4a):
 * `M3LAppendOnlyStream.read`, `M3LAppendOnlyStreamReadError`
 * (`ERR_APPEND_ONLY_STREAM_READ`), and the `M3LAppendOnlyReadOptions` /
 * `M3LAppendOnlyTruncatedSegment` types it takes and reports through.
 *
 * `M3LAppendOnlyStream` has been write-only since X7 slice 2 (see the
 * sibling `storage-append-only-stream.test.ts`); this suite is the read half
 * that lets a rebuild (a JSONL -> SQLite index, an operator inspecting an
 * audit trail) walk a segment directory back into entries.
 *
 * Every guarantee here is a filesystem invariant — `O_NOFOLLOW` refusal,
 * cold-start segment discovery, a bounded-memory read of an oversized line —
 * so these tests use a REAL temporary directory rather than a mocked
 * `node:fs`. Torn-tail and corruption fixtures are written directly with
 * `fs`, not produced by driving the writer, because the writer can never
 * itself produce a torn or malformed segment — the fixture needs bytes the
 * writer would never emit. The one exception is the line-length ceiling
 * test, which wraps the `FileHandle` `open` returns to prove the ceiling is
 * enforced against bytes actually read, not a fully buffered segment — see
 * `fsProbe` below; it is inert for every other test in this file.
 *
 * @packageDocumentation
 */

import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type * as NodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";
import type {
  M3LAppendOnlyEntry,
  M3LAppendOnlyReadOptions,
  M3LAppendOnlyTruncatedSegment,
} from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// The one seam where a real filesystem read cannot make a guarantee
// observable on its own
// ---------------------------------------------------------------------------

/**
 * A single, opt-in override for the `FileHandle` `open` returns, used by
 * exactly one test below (the line-length ceiling) and inert for every
 * other test in this file.
 *
 * The contract requires the reader to pull bytes through
 * `handle.read(...)` in bounded chunks rather than `readFile` or
 * `createReadStream` — specifically so the line-length ceiling guard is
 * PROVABLE: wrap the handle `open` returns, sum every byte actually read
 * off it, and assert that sum stays bounded no matter how large the
 * segment logically is. A timing- or `MAX_STRING_LENGTH`-based assertion
 * only catches a `readFile(path, "utf8")` implementation; it does not catch
 * one that buffers the whole segment into a `Buffer` and then scans it for
 * `"\n"`, which is the same memory bomb. Every other test in this file
 * opens and reads real segment files completely unmocked, on purpose — see
 * this module's header.
 */
const fsProbe = vi.hoisted(() => ({
  /** Set to observe every `FileHandle.read` call; cleared in `afterEach`. */
  trackHandleReads: undefined as ((bytesRead: number) => void) | undefined,
  /** Set to observe every `FileHandle.close` call; cleared in `afterEach`. */
  trackHandleClose: undefined as (() => void) | undefined,
  /**
   * Set to a segment's absolute path to delete it (with the REAL, unmocked
   * `unlink`) immediately after `readdir` resolves but before the caller
   * sees the listing — this is what makes the T3 "segment vanishes between
   * `readdir` and `open`" test a genuine reproduction of the race rather
   * than a synthesized error: the file is actually gone by the time
   * `open()` runs. Cleared in `afterEach`.
   */
  deleteAfterReaddir: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const result = await actual.readdir(...args);
      const target = fsProbe.deleteAfterReaddir;
      if (target !== undefined) {
        await actual.unlink(target);
      }
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const readTracker = fsProbe.trackHandleReads;
      if (readTracker !== undefined) {
        wrapHandleRead(handle, readTracker);
      }
      const closeTracker = fsProbe.trackHandleClose;
      if (closeTracker !== undefined) {
        wrapHandleClose(handle, closeTracker);
      }
      return handle;
    },
  };
});

/**
 * Shadows one handle's OWN `read` method so every call to it also reports
 * its `bytesRead` to `onBytesRead`. The real `read` is bound to the real
 * handle before being wrapped, so it keeps executing with its own `this` —
 * any internal private-field state Node's `FileHandle` relies on stays
 * intact — and its resolved value is returned unmodified.
 */
function wrapHandleRead(
  handle: FileHandle,
  onBytesRead: (bytesRead: number) => void,
): void {
  const originalRead = handle.read.bind(handle) as (
    ...args: unknown[]
  ) => Promise<{ bytesRead: number }>;
  const tracked = (async (...args: unknown[]) => {
    const result = await originalRead(...args);
    onBytesRead(result.bytesRead);
    return result;
  }) as FileHandle["read"];
  Object.defineProperty(handle, "read", { value: tracked, configurable: true });
}

/**
 * Same idiom as {@link wrapHandleRead}, over `close` instead of `read`: used
 * by the T3 "handle is closed on an early `break`" test so that test spies on
 * the exact same seam the byte-counting ceiling test already relies on,
 * rather than a second interception mechanism.
 */
function wrapHandleClose(handle: FileHandle, onClose: () => void): void {
  const originalClose = handle.close.bind(handle);
  const tracked = (async () => {
    await originalClose();
    onClose();
  }) as FileHandle["close"];
  Object.defineProperty(handle, "close", {
    value: tracked,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Builds the segment file name the stream reads, matching its own writer. */
function segmentName(datePrefix: string, sequence: number): string {
  return `${datePrefix}-${String(sequence).padStart(4, "0")}.jsonl`;
}

/**
 * Writes a segment file with EXACT bytes — no newline is added on top of
 * `content` unless it is already in `content`. This is what lets a fixture
 * control the presence or absence of a trailing newline precisely, which a
 * fixture built by driving the writer never could (the writer always emits
 * `line + "\n"`).
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

/**
 * Drains an async iterable, capturing whatever it eventually threw (or
 * `undefined` if it completed normally) alongside every entry yielded
 * BEFORE the throw. This is what lets a torn-tail/corruption test assert
 * both halves at once: the good entries that already flowed, and the exact
 * failure that stopped the run.
 */
async function collectUntilThrow(
  iterable: AsyncIterable<M3LAppendOnlyEntry>,
): Promise<{ entries: M3LAppendOnlyEntry[]; thrown: unknown }> {
  const entries: M3LAppendOnlyEntry[] = [];
  let thrown: unknown;
  try {
    for await (const entry of iterable) {
      entries.push(entry);
    }
  } catch (error) {
    thrown = error;
  }
  return { entries, thrown };
}

/** Builds one JSONL line, `depth` object levels deep, past any documented cap. */
function deeplyNestedLine(depth: number): string {
  let node: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < depth; level += 1) {
    node = { child: node };
  }
  return JSON.stringify(node);
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-read-"));
});

afterEach(async () => {
  fsProbe.trackHandleReads = undefined;
  fsProbe.trackHandleClose = undefined;
  fsProbe.deleteAfterReaddir = undefined;
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Whether this host has a working `mkfifo` on `PATH` — computed once at
 * module load so the FIFO-refusal test can skip cleanly (rather than fail)
 * on a platform without one, per its own ground rules.
 */
const HAS_MKFIFO: boolean = (() => {
  if (process.platform === "win32") {
    return false;
  }
  try {
    return spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0;
  } catch {
    return false;
  }
})();

/** Whether the current process is root — permission checks (EACCES) never apply to it. */
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Writes a segment file with EXACT raw bytes, for a fixture that must embed
 * bytes no valid UTF-8 string literal can represent (an invalid UTF-8
 * sequence) — `writeSegmentFile`'s `string` content is always encoded as
 * valid UTF-8 on the way out, which cannot produce this fixture.
 */
async function writeSegmentFileBytes(
  dir: string,
  fileName: string,
  content: Buffer,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content);
  return filePath;
}

/**
 * Builds one JSONL line, `{"pad":"aaa...a"}`, whose total byte length is
 * EXACTLY `byteLength` — every character is single-byte ASCII, so
 * `Buffer.byteLength` on the result equals `byteLength` precisely. Used to
 * hit the S2 boundary values exactly rather than approximately.
 */
function jsonLineOfExactByteLength(byteLength: number): string {
  const prefix = '{"pad":"';
  const suffix = '"}';
  const overhead = Buffer.byteLength(prefix + suffix, "utf8");
  const fillLength = byteLength - overhead;
  if (fillLength < 0) {
    throw new Error(
      `byteLength ${String(byteLength)} is too small for the ${String(overhead)}-byte JSON envelope`,
    );
  }
  return prefix + "a".repeat(fillLength) + suffix;
}

// ---------------------------------------------------------------------------
// 1 — Round trip
// ---------------------------------------------------------------------------

describe("round trip", () => {
  // INVARIANT: every entry whose `append()` has resolved is read back, in
  // the exact order it was appended. This is the baseline the rest of the
  // suite's ordering/corruption guarantees build on.
  test("reads back every appended entry in append order", async () => {
    const dir = path.join(workDir, "audit");
    const writer = new M3LAppendOnlyStream({ directory: dir });
    const entries: M3LAppendOnlyEntry[] = [
      { event: "first", index: 1 },
      { event: "second", index: 2, nested: { ok: true } },
      { event: "third", index: 3, list: [1, "two", null] },
    ];
    for (const entry of entries) {
      await writer.append(entry);
    }

    // A fresh instance, not the one that wrote: read must not depend on any
    // in-memory state the writer happened to be carrying.
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(reader.read());

    expect(recovered).toEqual(entries);
  });
});

// ---------------------------------------------------------------------------
// 2 — Multi-segment ordering
// ---------------------------------------------------------------------------

describe("multi-segment ordering", () => {
  // INVARIANT: read order spans a rotation exactly the way append order
  // produced it. `maxSegmentBytes: 1` is the documented degenerate case
  // ("a value below maxLineBytes yields one entry per segment") — the
  // simplest way to force N segments from N appends deterministically,
  // without measuring exact line byte widths.
  test("reads across a forced rotation in append order", async () => {
    const dir = path.join(workDir, "audit");
    const writer = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: 1,
    });
    const entries: M3LAppendOnlyEntry[] = Array.from(
      { length: 5 },
      (_unused, index) => ({
        event: "rotated",
        index,
      }),
    );
    for (const entry of entries) {
      await writer.append(entry);
    }

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(reader.read());

    expect(recovered).toEqual(entries);
  });
});

// ---------------------------------------------------------------------------
// 3 — Multi-date ordering
// ---------------------------------------------------------------------------

describe("multi-date ordering", () => {
  // INVARIANT: the reader enumerates EVERY date, not just today's — the
  // writer's cold-start scan only ever looks at today's prefix
  // (`append-only-segments.ts`), so this is the one ordering guarantee the
  // writer's own tests cannot exercise. The later date is written to disk
  // FIRST, so a naive "insertion/mtime order" bug and a correct
  // "(date, sequence) ascending" implementation would disagree here.
  test("reads segments from every date, oldest first, regardless of write order", async () => {
    const dir = path.join(workDir, "audit");
    const earlyEntry = { event: "from-the-past" };
    const lateEntry = { event: "from-the-future" };

    await writeSegmentFile(
      dir,
      segmentName("2026-06-15", 1),
      `${JSON.stringify(lateEntry)}\n`,
    );
    await writeSegmentFile(
      dir,
      segmentName("2020-01-01", 1),
      `${JSON.stringify(earlyEntry)}\n`,
    );

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(reader.read());

    expect(recovered).toEqual([earlyEntry, lateEntry]);
  });
});

// ---------------------------------------------------------------------------
// 4 — Null prototype
// ---------------------------------------------------------------------------

describe("null prototype", () => {
  // INVARIANT: every yielded entry (and every nested object within it) is
  // rebuilt with a null prototype by the same `projectAppendOnlyEntry` the
  // writer uses, so a consumer that spreads it can never reach an inherited
  // `Object.prototype` gadget.
  test("yields entries whose own and nested objects have a null prototype", async () => {
    const dir = path.join(workDir, "audit");
    const entry = { event: "audit", nested: { deeper: { value: 1 } } };
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify(entry)}\n`,
    );

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const [recovered] = await collectEntries(reader.read());
    expect(recovered).toEqual(entry);

    const asRecord = recovered as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(asRecord)).toBe(null);
    const nested = asRecord["nested"] as Record<string, unknown>;
    expect(Object.getPrototypeOf(nested)).toBe(null);
  });

  // INVARIANT: a hand-edited own `"__proto__"` key on disk is a line the
  // writer could never have produced (it rejects the same key at append
  // time — see `entry projection rejects values it cannot faithfully
  // persist` in the sibling write-path suite) and reading it back through
  // the SAME `projectAppendOnlyEntry` must refuse it exactly the same way,
  // never quietly accept it as data. `Object.prototype` itself must come
  // out unpolluted either way.
  test("rejects a segment line carrying an own __proto__ key without polluting Object.prototype", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      '{"__proto__":{"polluted":true}}\n',
    );

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(entries).toEqual([]);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

// ---------------------------------------------------------------------------
// 5 — Malformed complete line
// ---------------------------------------------------------------------------

describe("malformed complete line", () => {
  // INVARIANT: a line terminated by "\n" that fails to parse, or that
  // projects to something JSON cannot carry back out unchanged (the same
  // closed value set the writer enforces), is corruption — ALWAYS a throw,
  // never skipped, with no callback escape. A good line before it still
  // flows: the throw stops the run from that point on, it does not
  // retroactively hide what was already valid.
  test.each([
    { label: "invalid JSON syntax", line: "{not valid json" },
    { label: "a bare JSON array", line: "[1,2,3]" },
    { label: "a bare JSON scalar", line: "42" },
    { label: "a negative-zero value", line: '{"count":-0}' },
    { label: "a structure past the depth cap", line: deeplyNestedLine(600) },
  ])(
    "$label throws M3LAppendOnlyStreamReadError after yielding the prior good line",
    async ({ line }) => {
      const dir = path.join(workDir, "audit");
      const goodEntry = { event: "before-the-bad-line" };
      const content = `${JSON.stringify(goodEntry)}\n${line}\n`;
      await writeSegmentFile(dir, segmentName("2026-01-01", 1), content);

      const reader = new M3LAppendOnlyStream({ directory: dir });
      const { entries, thrown } = await collectUntilThrow(reader.read());

      expect(entries).toEqual([goodEntry]);
      expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    },
  );
});

// ---------------------------------------------------------------------------
// 6 & 7 — Torn tail on the LAST segment
// ---------------------------------------------------------------------------

describe("torn tail on the last segment", () => {
  const goodLines = [{ event: "one" }, { event: "two" }] as const;
  const fragment = '{"partial":"unterminated';

  function tornContent(): string {
    return `${goodLines.map((entry) => JSON.stringify(entry)).join("\n")}\n${fragment}`;
  }

  // INVARIANT: no silent path. A torn tail with NO `onTruncatedTail`
  // callback throws — the default is what makes a caller who wants to
  // tolerate a torn tail write that decision down explicitly, rather than
  // an audit trail quietly losing its last, incomplete record.
  test("throws when no onTruncatedTail callback is supplied", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, segmentName("2026-01-01", 1), tornContent());

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(entries).toEqual(goodLines);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
  });

  // INVARIANT: supplying `onTruncatedTail` on the LAST segment tolerates the
  // torn fragment — the callback fires exactly once with the fragment's
  // real byte length and this read's segment position, iteration completes
  // normally, and the fragment itself is never yielded as an entry.
  test("with a callback, invokes it once and completes without yielding the fragment", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, segmentName("2026-01-01", 1), tornContent());

    const onTruncatedTail =
      vi.fn<(segment: M3LAppendOnlyTruncatedSegment) => void>();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const entries = await collectEntries(reader.read({ onTruncatedTail }));

    expect(entries).toEqual(goodLines);
    expect(onTruncatedTail).toHaveBeenCalledTimes(1);
    expect(onTruncatedTail).toHaveBeenCalledWith({
      byteLength: Buffer.byteLength(fragment, "utf8"),
      segmentIndex: 0,
      segmentCount: 1,
    });
  });

  // REGRESSION (fix: `...(isFunction(options?.onTruncatedTail) && { … })`):
  // A falsy non-function `onTruncatedTail` (e.g. `null`, `0`) passes the
  // synchronous guard (see the "option validation" describe block below) but
  // MUST degrade to the absent-callback path at the torn-tail decision point
  // inside the async generator.
  //
  // BEFORE THE FIX: the conditional spread tested `!== undefined`, so `null`
  // (and `0`) was threaded into the read context; `resolveTornTail`'s own
  // `=== undefined` check was therefore false; `context.onTruncatedTail?.(…)`
  // no-opped on the falsy value via optional chaining — torn tail swallowed
  // silently, good records yielded as if the file were complete.
  //
  // AFTER THE FIX: the spread gates on `isFunction(…)`, so any falsy value
  // leaves `onTruncatedTail` absent in the context — the generator takes the
  // same throw path it takes when no callback is supplied at all.
  test.each([
    ["null", null],
    ["zero", 0],
  ] as [string, unknown][])(
    "throws M3LAppendOnlyStreamReadError when iteration encounters a torn tail with falsy onTruncatedTail: %s",
    async (_label, value) => {
      const dir = path.join(workDir, "audit");
      await writeSegmentFile(dir, segmentName("2026-01-01", 1), tornContent());

      const reader = new M3LAppendOnlyStream({ directory: dir });
      const { entries, thrown } = await collectUntilThrow(
        reader.read({
          onTruncatedTail: value,
        } as unknown as M3LAppendOnlyReadOptions),
      );

      expect(entries).toEqual(goodLines);
      expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    },
  );
});

// ---------------------------------------------------------------------------
// 8 — Torn fragment in a MID-stream segment
// ---------------------------------------------------------------------------

describe("torn fragment mid-stream", () => {
  // INVARIANT: the writer only ever rotates after a complete line, so a
  // fragment in a segment that is NOT the last one in read order is data
  // loss, not a torn tail — it always throws, callback or not. This is the
  // distinction the whole feature exists to draw; collapsing it (tolerating
  // ANY trailing fragment once a callback is supplied) would silently widen
  // "the process died mid-append" into "a chunk of the middle of the audit
  // trail vanished, and nobody was told."
  test("throws even when onTruncatedTail is supplied, and never invokes it", async () => {
    const dir = path.join(workDir, "audit");
    const midEntry = { event: "in-the-torn-segment" };
    const midFragment = '{"never-completed"';
    await writeSegmentFile(
      dir,
      segmentName("2026-02-02", 1),
      `${JSON.stringify(midEntry)}\n${midFragment}`,
    );
    const trailingEntry = { event: "in-the-final-segment" };
    await writeSegmentFile(
      dir,
      segmentName("2026-02-02", 2),
      `${JSON.stringify(trailingEntry)}\n`,
    );

    const onTruncatedTail =
      vi.fn<(segment: M3LAppendOnlyTruncatedSegment) => void>();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(
      reader.read({ onTruncatedTail }),
    );

    // The throw fires while still inside the torn (first) segment, so the
    // well-formed entry in the segment AFTER it must never be reached.
    expect(entries).toEqual([midEntry]);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(onTruncatedTail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8b — Option validation: onTruncatedTail callable guard
// ---------------------------------------------------------------------------

describe("option validation: onTruncatedTail callable guard", () => {
  // INVARIANT: a truthy non-function `onTruncatedTail` must be rejected
  // synchronously — before `read()` returns — with a clear, machine-readable
  // diagnostic. The guard exists because the torn-tail signal fires via
  // `context.onTruncatedTail?.(tornTail)` inside the generator: a string, a
  // number, or a plain object silently short-circuits that call (optional
  // chaining tests callability before invoking), which would suppress the
  // only mechanism that makes a torn tail fail loudly. The entire
  // "torn tail must never fail silently" invariant collapses if this guard
  // is absent — which is precisely why the TSDoc for
  // `assertOnTruncatedTailIsCallable` says the failure must be "loud and
  // immediate."
  test.each([
    ["string", "not-a-function"],
    ["number", 42],
    ["plain object", { notACallback: true }],
  ] as [string, unknown][])(
    "throws M3LError(ERR_INVALID_ARGUMENT) for a truthy non-function onTruncatedTail: %s",
    (_label, value) => {
      const reader = new M3LAppendOnlyStream({ directory: workDir });
      let thrown: unknown;
      try {
        reader.read({
          onTruncatedTail: value,
        } as unknown as M3LAppendOnlyReadOptions);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
      expect((thrown as M3LError).context).toEqual({
        field: "onTruncatedTail",
        violation: "not-a-function",
      });
    },
  );

  // INVARIANT: the throw fires EAGERLY — synchronously at the `read()` call,
  // not on the first `next()` of the returned iterable. `read()` is a plain
  // method (not an async generator): `assertOnTruncatedTailIsCallable` runs
  // synchronously before `readAppendOnlySegments` is ever invoked, so the
  // error must surface as a synchronous `throw`, not as an async rejection
  // inside a `for await`. Proven here: `read()` is called without beginning
  // iteration; no `await` involved; `expect(() => reader.read(...)).toThrow()`
  // would not catch a lazy rejection, only a synchronous one.
  test("throws synchronously — before any iteration — for a non-function onTruncatedTail", () => {
    const reader = new M3LAppendOnlyStream({ directory: workDir });
    expect(() => {
      reader.read({
        onTruncatedTail: "eager-throw-probe",
      } as unknown as M3LAppendOnlyReadOptions);
    }).toThrow(M3LError);
  });

  // INVARIANT: a FALSY non-function `onTruncatedTail` (e.g. `null`, `0`) is
  // ACCEPTED at call time — the guard condition
  // `if (onTruncatedTail && !isFunction(onTruncatedTail))` short-circuits on
  // any falsy value and does NOT throw synchronously. This confirms the guard
  // is not over-eager. Note that "accepted at call time" is not the same as
  // "treated as a real callback": the implementation degrades a falsy value to
  // the ABSENT callback path, so a torn tail encountered during iteration will
  // still throw — exactly as it does when no callback is supplied at all. See
  // the "throws M3LAppendOnlyStreamReadError when iteration encounters a torn
  // tail with falsy onTruncatedTail" test in the "torn tail" describe block.
  test.each([
    ["null", null],
    ["zero", 0],
  ] as [string, unknown][])(
    "does not throw for a falsy onTruncatedTail: %s",
    (_label, value) => {
      const reader = new M3LAppendOnlyStream({ directory: workDir });
      expect(() => {
        reader.read({
          onTruncatedTail: value,
        } as unknown as M3LAppendOnlyReadOptions);
      }).not.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// 9 — Line-length ceiling
// ---------------------------------------------------------------------------

describe("line-length ceiling", () => {
  // INVARIANT: the ceiling is enforced against the ACCUMULATING fragment as
  // it is read in bounded chunks — never by buffering the whole segment
  // first. Proven here by wrapping the `FileHandle` `open` returns (see
  // `fsProbe` above) and summing every byte the implementation actually
  // pulls off it: a correct implementation abandons an oversized,
  // unterminated line within a small, BOUNDED multiple of `maxLineBytes`,
  // no matter how large the file logically is.
  //
  // This is what a timing- or string-length-based assertion could not
  // prove: it would catch a `readFile(path, "utf8")` implementation, but
  // not one that reads the whole segment into a `Buffer` (no comparable
  // size ceiling) and then scans it for "\n" — the exact same memory bomb.
  // What the byte-count bound does NOT prove: that the implementation uses
  // any particular chunk size, or that its read count is minimal — only
  // that it is bounded independent of the file's real size, which is the
  // guarantee the contract actually makes.
  test("throws the ceiling error after reading only a bounded multiple of maxLineBytes", async () => {
    const dir = path.join(workDir, "audit");
    const maxLineBytes = 1024;
    // Large enough that "read the whole segment" and "read a small bounded
    // prefix" are trivially distinguishable by byte count alone — with no
    // reliance on wall-clock timing or a platform string-length ceiling.
    const totalBytes = 5 * 1024 * 1024;
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      "x".repeat(totalBytes), // one gigantic unterminated "line": no "\n" anywhere
    );

    let bytesReadTotal = 0;
    fsProbe.trackHandleReads = (bytesRead) => {
      bytesReadTotal += bytesRead;
    };

    const reader = new M3LAppendOnlyStream({ directory: dir, maxLineBytes });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(entries).toEqual([]);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(bytesReadTotal).toBeGreaterThan(0);
    // A bounded multiple, not the file's ~5 MiB size: this is what rules
    // out a "buffer the whole segment first" implementation, `Buffer`-based
    // or `string`-based alike.
    expect(bytesReadTotal).toBeLessThanOrEqual(maxLineBytes * 4);
  });
});

// ---------------------------------------------------------------------------
// 10 — Symlinked segment
// ---------------------------------------------------------------------------

describe("symlink refusal", () => {
  // INVARIANT: `O_NOFOLLOW` on open refuses a segment path that has been
  // replaced by a symlink — the read-side half of the same guard the writer
  // already applies (see the sibling write-path suite's "symlink refusal"
  // describe block). The reader ALSO applies the `nlink` hardlink check —
  // see the "hardlink refusal (S1)" describe block below for that guard's
  // rationale and regression tests.
  test("refuses to read a segment path that is a symlink", async () => {
    const dir = path.join(workDir, "audit");
    const outsideDir = path.join(workDir, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const target = path.join(outsideDir, "victim.jsonl");
    const targetContent = '{"event":"must-not-be-read"}\n';
    await writeFile(target, targetContent, "utf8");
    await symlink(target, path.join(dir, segmentName("2026-01-01", 1)));

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(entries).toEqual([]);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(await readFile(target, "utf8")).toBe(targetContent);
  });
});

// ---------------------------------------------------------------------------
// 11 & 12 — Missing directory, empty directory, zero-byte segment
// ---------------------------------------------------------------------------

describe("missing or empty sources", () => {
  // INVARIANT: a rebuild against a directory that was never created (a
  // fresh install, nothing ever appended) is a normal, empty case, not a
  // failure.
  test("a missing directory yields nothing and does not throw", async () => {
    const dir = path.join(workDir, "never-created");
    const reader = new M3LAppendOnlyStream({ directory: dir });

    const entries = await collectEntries(reader.read());

    expect(entries).toEqual([]);
  });

  test("an existing but empty directory yields nothing and does not throw", async () => {
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    const reader = new M3LAppendOnlyStream({ directory: dir });

    const entries = await collectEntries(reader.read());

    expect(entries).toEqual([]);
  });

  // INVARIANT: a zero-byte segment (a process that opened its next segment
  // and died before writing a single byte) has no complete lines AND no
  // trailing fragment — there is nothing to tear. It must be treated as
  // trivially empty rather than a torn tail, so it must not throw even with
  // no `onTruncatedTail` callback supplied.
  test("a zero-byte segment yields nothing and does not throw, even with no callback", async () => {
    const dir = path.join(workDir, "audit");
    await writeSegmentFile(dir, segmentName("2026-01-01", 1), "");
    const reader = new M3LAppendOnlyStream({ directory: dir });

    const entries = await collectEntries(reader.read());

    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 13 — Type contracts
// ---------------------------------------------------------------------------

describe("type contracts", () => {
  test("read returns an async iterable of entries", () => {
    expectTypeOf<M3LAppendOnlyStream["read"]>().returns.toEqualTypeOf<
      AsyncIterable<M3LAppendOnlyEntry>
    >();
  });

  test("read takes exactly one optional read-options bag", () => {
    expectTypeOf<M3LAppendOnlyStream["read"]>().parameters.toEqualTypeOf<
      [options?: M3LAppendOnlyReadOptions | undefined]
    >();
  });

  test("the read error narrows its code to its own literal", () => {
    expectTypeOf<
      M3LAppendOnlyStreamReadError["code"]
    >().toEqualTypeOf<"ERR_APPEND_ONLY_STREAM_READ">();
  });

  test("read options carry only an optional torn-tail callback", () => {
    expectTypeOf<M3LAppendOnlyReadOptions>().toEqualTypeOf<{
      readonly onTruncatedTail?: (
        segment: M3LAppendOnlyTruncatedSegment,
      ) => void;
    }>();
  });

  test("the truncated-tail payload carries byte length and segment position, and no path", () => {
    // Exact equality (rather than `toMatchObjectType`) is what proves the
    // ABSENCE of a `path` field: a shape carrying one in addition to these
    // three would fail this line, without a separate `.not.toHaveProperty`
    // assertion needed.
    expectTypeOf<M3LAppendOnlyTruncatedSegment>().toEqualTypeOf<{
      readonly byteLength: number;
      readonly segmentIndex: number;
      readonly segmentCount: number;
    }>();
  });
});

// ---------------------------------------------------------------------------
// 14 — T1: regression suite for two Must-fix exploits found in the slice 4a
// security review (M1: planted FIFO hang, M2: sequence-gap swallowed). Both
// fixes have been applied; these tests are the regression locks.
// ---------------------------------------------------------------------------

describe("planted FIFO refusal (M1 — must never hang)", () => {
  // EXPLOIT (M1, now fixed): `mkfifo <streamDir>/2026-01-01-0001.jsonl` then
  // read(). The original `open()` carried no `fstat`, no `O_NONBLOCK`, and no
  // `AbortSignal`, so `O_RDONLY` on a FIFO with no writer would block in the
  // kernel forever.
  //
  // THE FIX: `SEGMENT_READ_FLAGS` (`append-only-reader.ts:94`) sets
  // `O_NONBLOCK` so the kernel returns `ENXIO` immediately for a FIFO with
  // no writer, and the `fstat` check (`append-only-reader.ts:~419-434`) gates
  // on `stats.isFile()` before any read — both guards reject a non-regular
  // file before the reader ever blocks.
  //
  // This test's own pass/fail signal IS a hard timeout: the exploit's failure
  // mode was "hangs", not "throws", so a missing guard manifests as an
  // unexplained hang rather than a clean assertion failure. The internal race
  // is bounded well under the outer Vitest timeout so a regression fails
  // loudly and quickly rather than hanging CI. If it DOES hang, the leaked
  // `open()` call is unstuck with a writer end before this test reports
  // failure, so the process can still exit.
  test("refuses a FIFO planted at a segment path instead of hanging", async (ctx) => {
    if (!HAS_MKFIFO) {
      ctx.skip();
      return;
    }

    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    const fifoPath = path.join(dir, segmentName("2026-01-01", 1));
    const created = spawnSync("mkfifo", [fifoPath]);
    if (created.status !== 0) {
      // A host that claims `mkfifo` on PATH but refuses to run it (a
      // restrictive container, an unusual filesystem) — skip rather than
      // fail on an environment problem this test isn't about.
      ctx.skip();
      return;
    }

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const HANG_TIMEOUT_MS = 2000;

    const readOutcome = collectEntries(reader.read()).then(
      (entries) => ({ kind: "resolved" as const, entries }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const timeoutOutcome = new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => {
        resolve({ kind: "timeout" });
      }, HANG_TIMEOUT_MS);
    });

    const outcome = await Promise.race([readOutcome, timeoutOutcome]);

    if (outcome.kind === "timeout") {
      // The regression itself. Unstick the leaked `open()` by supplying
      // the writer end it has been blocked waiting for, so this process
      // can still exit cleanly after reporting the failure below instead
      // of hanging past it.
      const unstick = await open(fifoPath, "w");
      await unstick.close();
      await readOutcome.catch(() => undefined);
      expect.fail(
        "read() hung on a planted FIFO instead of refusing it — this is the M1 exploit this test guards against",
      );
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    }
  }, 10_000);
});

describe("gap detection mid-stream (M2 — a hole must never read back as complete)", () => {
  // EXPLOIT (M2, now fixed, table row "unlink segment 0003" — reproduced here
  // as the symmetric "middle segment deleted" case): segments 0001 and 0003
  // existed; 0002 was deleted. The original `discoverSegmentsInOrder` sorted
  // by `(datePrefix, sequence)` but never checked CONTINUITY, so the hole was
  // never noticed and both remaining segments were handed back as if they were
  // the whole trail.
  //
  // THE FIX: `assertNoSequenceGap` (`append-only-reader.ts:232-256`) walks
  // the sorted segment list and throws `M3LAppendOnlyStreamReadError` if any
  // consecutive pair has a non-unit sequence delta or a date boundary that
  // breaks the expected monotone sequence.
  //
  // The exact point at which the throw fires (before opening segment 0001 at
  // all, or only once the gap is reached) is an implementation choice this
  // test does not pin — only that it throws, and that it never silently hands
  // back the two segments' entries as if nothing were missing, which was the
  // exploit's own observed shape.
  test("throws rather than silently omitting a missing sequence number", async () => {
    const dir = path.join(workDir, "audit");
    const entryA = { event: "segment-one" };
    const entryC = { event: "segment-three" };
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify(entryA)}\n`,
    );
    // Segment 0002 is never created at all — the gap.
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 3),
      `${JSON.stringify(entryC)}\n`,
    );

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(entries).not.toEqual([entryA, entryC]);
  });

  // EXPLOIT (M2, table row "truncate(segment 0002, 0)" — same gap class per
  // the fix spec): all three sequence numbers exist on disk, but the middle
  // one is zero bytes — a process that opened its next segment and died
  // before writing anything. That is legitimate ONLY on the last segment in
  // read order (see the "missing or empty sources" describe block above); a
  // MID-stream zero-byte segment is exactly as much of a silent hole as a
  // deleted one, because today's `resolveTornTail` treats "zero-length carry"
  // as "trivially empty" regardless of position.
  test("throws rather than silently omitting a zero-length segment mid-stream", async () => {
    const dir = path.join(workDir, "audit");
    const entryA = { event: "segment-one" };
    const entryC = { event: "segment-three" };
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify(entryA)}\n`,
    );
    await writeSegmentFile(dir, segmentName("2026-01-01", 2), "");
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 3),
      `${JSON.stringify(entryC)}\n`,
    );

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(entries).not.toEqual([entryA, entryC]);
  });
});

describe("hardlink refusal (S1 — a confused-deputy read primitive)", () => {
  // EXPLOIT (S1): `link(<victim>, <streamDir>/2026-01-01-0001.jsonl)` made
  // `read()` return the victim's content — here a secret — as a legitimate
  // audit entry. The contract's own comment claims this is "harmless"
  // because "reading never redirects a write into a file somebody else
  // owns"; that reasoning misses that a hardlink lets a LOWER-privilege
  // actor NOMINATE a file they cannot read for a HIGHER-privilege reader to
  // read and republish into the audit index, where they then can. This test
  // creates the link itself (same-user, so `fs.protected_hardlinks` does not
  // apply) and skips cleanly if the host still refuses it.
  test("refuses to read a segment path that is a hardlink to a file outside the stream directory", async (ctx) => {
    const dir = path.join(workDir, "audit");
    const outsideDir = path.join(workDir, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const victim = path.join(outsideDir, "victim.jsonl");
    const secretContent = '{"aws_secret_access_key":"SUPERSECRET"}\n';
    await writeFile(victim, secretContent, "utf8");

    const planted = path.join(dir, segmentName("2026-01-01", 1));
    try {
      await link(victim, planted);
    } catch {
      ctx.skip();
      return;
    }

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(entries).toEqual([]);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(await readFile(victim, "utf8")).toBe(secretContent);
  });
});

// ---------------------------------------------------------------------------
// 15 — T2: regression suite for two fidelity exploits found in the slice 4a
// security review (S2: line-length ceiling bypass on complete lines, S4:
// invalid UTF-8 silently normalised). Both fixes have been applied; these
// tests are the regression locks.
// ---------------------------------------------------------------------------

describe("line-length ceiling on a COMPLETE line (S2)", () => {
  // EXPLOIT (S2, now fixed): the original ceiling in `splitLines` was checked
  // only against the accumulating trailing fragment (`nextCarry`), never
  // against a line already extracted as complete. At `maxLineBytes: 1024`, the
  // measured accepting values were 2045, 2046 and 2047 bytes — up to just
  // under 2x the documented ceiling — with 2048 correctly throwing. A line the
  // writer could never have produced (its own content ceiling is 1023 bytes at
  // this `maxLineBytes`) was handed back as genuine.
  //
  // THE FIX: `append-only-reader.ts:359-364` now checks the byte length of
  // every complete, newline-terminated line against `maxLineBytes` before
  // yielding it, so the ceiling is enforced against both the in-flight
  // fragment and any fully extracted line.
  test.each([{ byteLength: 2045 }, { byteLength: 2046 }, { byteLength: 2047 }])(
    "throws for a complete, newline-terminated line of $byteLength bytes (> maxLineBytes, < 2x maxLineBytes)",
    async ({ byteLength }) => {
      const dir = path.join(workDir, "audit");
      const maxLineBytes = 1024;
      const line = jsonLineOfExactByteLength(byteLength);
      // Sanity on the fixture itself: a wrong byte count here would make the
      // rest of the assertion meaningless.
      expect(Buffer.byteLength(line, "utf8")).toBe(byteLength);
      await writeSegmentFile(dir, segmentName("2026-01-01", 1), `${line}\n`);

      const reader = new M3LAppendOnlyStream({ directory: dir, maxLineBytes });
      const { entries, thrown } = await collectUntilThrow(reader.read());

      expect(entries).toEqual([]);
      expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    },
  );
});

describe("invalid UTF-8 refusal (S4)", () => {
  // EXPLOIT (S4): `lineBytes.toString("utf8")` is lossy — Node silently
  // repairs an invalid byte to U+FFFD rather than failing. The review's own
  // pair: `{"v":"\xFF"}` and `{"v":"\xFF"}` (raw bytes, not string escapes —
  // a JS string literal `"\xFF"` is the VALID Unicode code point U+00FF, not
  // this invalid byte) read back IDENTICALLY as `{"v":"�"}` today. Two
  // distinct on-disk byte sequences must not collapse into one accepted
  // entry; both must be refused outright.
  test.each([
    { label: "0xFF", marker: 0xff },
    { label: "0xFE", marker: 0xfe },
  ])(
    "throws for a line containing the invalid UTF-8 byte $label rather than yielding U+FFFD",
    async ({ marker }) => {
      const dir = path.join(workDir, "audit");
      const lineBytes = Buffer.concat([
        Buffer.from('{"v":"', "ascii"),
        Buffer.from([marker]),
        Buffer.from('"}\n', "ascii"),
      ]);
      await writeSegmentFileBytes(dir, segmentName("2026-01-01", 1), lineBytes);

      const reader = new M3LAppendOnlyStream({ directory: dir });
      const { entries, thrown } = await collectUntilThrow(reader.read());

      expect(entries).toEqual([]);
      expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    },
  );
});

// ---------------------------------------------------------------------------
// 16 — T3: three paths that are correct today but ungated (silent-failure
// hunter's finding — these are expected to PASS already, unlike T1/T2 above)
// ---------------------------------------------------------------------------

describe("EACCES on an existing directory (T3 — the important one)", () => {
  // The worst possible failure mode for this module: a catch here that is
  // even slightly too broad would turn a permission problem into a silently
  // empty audit trail — indistinguishable from "nothing was ever written".
  // Only "missing" (ENOENT) and "empty" directories were covered before this
  // test; a directory that EXISTS but cannot be listed is a different,
  // untested branch of `discoverSegmentsInOrder`'s own catch.
  test("throws rather than yielding an empty trail when the directory cannot be listed", async (ctx) => {
    if (process.platform === "win32" || isRoot()) {
      // POSIX permission bits aren't the access control in force on
      // Windows, and root bypasses them entirely on POSIX.
      ctx.skip();
      return;
    }

    const dir = path.join(workDir, "audit");
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      '{"event":"unreachable"}\n',
    );
    await chmod(dir, 0o000);

    try {
      const reader = new M3LAppendOnlyStream({ directory: dir });
      const { entries, thrown } = await collectUntilThrow(reader.read());

      expect(entries).toEqual([]);
      expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    } finally {
      // Restore before `afterEach`'s recursive `rm` needs to descend into
      // this directory again.
      await chmod(dir, 0o700);
    }
  });
});

describe("ENOENT on a segment that vanishes between readdir and open (T3)", () => {
  // Reproduces the real race, not a synthesized error: `readdir` is wrapped
  // (see `fsProbe.deleteAfterReaddir` above) to genuinely `unlink` the
  // target segment, with the REAL filesystem, in the gap between the
  // listing being produced and the reader's own `open()` call on it.
  test("throws rather than silently skipping a segment deleted after it was listed", async () => {
    const dir = path.join(workDir, "audit");
    const entryA = { event: "still-present" };
    const entryB = { event: "deleted-before-open" };
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify(entryA)}\n`,
    );
    const vanishingPath = await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 2),
      `${JSON.stringify(entryB)}\n`,
    );

    fsProbe.deleteAfterReaddir = vanishingPath;
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { entries, thrown } = await collectUntilThrow(reader.read());

    expect(entries).toEqual([entryA]);
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
  });
});

describe("handle lifecycle on early exit (T3)", () => {
  // Extends the SAME handle-wrapping probe the line-length ceiling test uses
  // (`fsProbe`/`wrapHandleRead` above), spying on `close` instead of `read`,
  // per this module's own instruction not to invent a second mechanism.
  test("closes the segment handle when the consumer stops iterating early via break", async () => {
    const dir = path.join(workDir, "audit");
    const firstEntry = { event: "one" };
    const secondEntry = { event: "two" };
    await writeSegmentFile(
      dir,
      segmentName("2026-01-01", 1),
      `${JSON.stringify(firstEntry)}\n${JSON.stringify(secondEntry)}\n`,
    );

    let closeCalls = 0;
    fsProbe.trackHandleClose = () => {
      closeCalls += 1;
    };

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const seen: M3LAppendOnlyEntry[] = [];
    for await (const entry of reader.read()) {
      seen.push(entry);
      break;
    }

    expect(seen).toEqual([firstEntry]);
    expect(closeCalls).toBe(1);
  });
});
