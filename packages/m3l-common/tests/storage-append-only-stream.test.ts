/**
 * Tests for `core/storage`'s public append-only segmented JSONL stream
 * (X7 slice 2, RED phase — `M3LAppendOnlyStream` does not exist yet; the
 * equivalent machinery currently lives private to `core/agent`).
 *
 * Contract source: the X7 slice 2 contract § "Part B — the public Core
 * surface", step 6, plus the behaviours the sibling
 * `agent-decision-log-writer.test.ts` already pins for the private writer
 * this primitive is extracted from.
 *
 * Exports under test (all reached through the `core/storage` barrel):
 * `M3LAppendOnlyStream` (class), `M3LAppendOnlyStreamError`
 * (`ERR_APPEND_ONLY_STREAM_WRITE`), `M3LAppendOnlyEntry` /
 * `M3LAppendOnlyValue` / `M3LAppendOnlyStreamOptions` (types), and the
 * documented ceilings `M3L_APPEND_ONLY_MAX_SEGMENT_BYTES`,
 * `M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS`, `M3L_APPEND_ONLY_MAX_LINE_BYTES`.
 *
 * These tests deliberately use a REAL temporary directory rather than a
 * mocked `node:fs`. Every guarantee here is a filesystem invariant —
 * `O_APPEND` atomicity, `O_NOFOLLOW` symlink refusal, cold-start discovery
 * of an existing segment's real byte size, exact byte accounting under
 * concurrency. A mocked filesystem would assert the mock, not the guarantee.
 * Each test gets its own `mkdtemp` directory, removed in `afterEach`.
 *
 * ASSUMPTIONS FLAGGED FOR THE IMPLEMENTER (derived from the extraction
 * source, not invented here):
 *   - segment file names are `<YYYY-MM-DD>-<NNNN>.jsonl`, the date being the
 *     UTC date, the sequence zero-padded to four digits;
 *   - rotation is evaluated against the ACTIVE segment's CURRENT size, not
 *     against `size + the incoming line` (a segment may therefore end one
 *     line beyond the ceiling) — this is the behaviour
 *     `agent-decision-log-writer.test.ts` § "rotation by bytes" already pins;
 *   - the ceilings reuse the agent decision log's own default numbers.
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
import type * as NodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  M3L_APPEND_ONLY_MAX_LINE_BYTES,
  M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS,
  M3L_APPEND_ONLY_MAX_SEGMENT_BYTES,
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamError,
} from "../src/core/storage/index.js";
import type {
  M3LAppendOnlyEntry,
  M3LAppendOnlyStreamOptions,
  M3LAppendOnlyValue,
} from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// The one seam where a real filesystem cannot reach
// ---------------------------------------------------------------------------

/**
 * A single, opt-in override for `stat`, used by exactly one test below (the
 * non-`ENOENT` stat failure) and inert for every other test in this file.
 *
 * Everything else here runs against a REAL temporary directory on purpose —
 * see the header. This one behaviour cannot be reached that way. The
 * guarantee under test is that a `stat` failure which is not `ENOENT` is
 * re-thrown rather than read as "the file is absent, size 0", and it is only
 * observable when the `stat` fails and the append that follows would
 * otherwise SUCCEED. Every real non-`ENOENT` stat failure reachable on a
 * segment path also breaks the `appendFile` on that same path — a symlink
 * loop fails `ELOOP` for `open` too (the writer opens `O_NOFOLLOW`), a
 * log directory left `r--` fails `EACCES` for `open` too (both `stat` and
 * `open` need the directory's search bit), a non-directory component fails
 * `ENOTDIR` for both — so a correct implementation and one that swallowed
 * the error would both raise, and the assertion would prove nothing.
 * Overriding `stat` alone is what separates the two.
 */
const fsProbe = vi.hoisted(() => ({
  /** Set to make the next `stat` reject; cleared in `afterEach`. */
  statFailure: undefined as Error | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (fsProbe.statFailure !== undefined) {
        return Promise.reject(fsProbe.statFailure);
      }
      return actual.stat(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A fixed, mid-day UTC instant used whenever a test pins the wall clock. */
const FIXED_CLOCK = Date.UTC(2026, 5, 15, 12, 0, 0);

/**
 * Pins the wall clock and returns the UTC date prefix (`YYYY-MM-DD`) the
 * stream derives its segment names from.
 *
 * A test that predicts a segment file NAME must sample the date from the same
 * instant the stream does: sampling `new Date()` independently makes the
 * expected and produced names disagree on a run that straddles UTC midnight.
 */
function pinClock(atMs: number = FIXED_CLOCK): string {
  vi.useFakeTimers();
  vi.setSystemTime(atMs);
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Builds the segment file name the stream uses for a date and sequence. */
function segmentName(datePrefix: string, sequence: number): string {
  return `${datePrefix}-${String(sequence).padStart(4, "0")}.jsonl`;
}

/** Lists directory entries, sorted so "highest-numbered" ordering holds. */
async function listSegments(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return [...names].sort();
}

/** Reads a file and splits it into its non-empty JSONL lines. */
async function readLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content.split("\n").filter((line) => line.length > 0);
}

/**
 * Parses JSON into `unknown` — both to read a persisted line back without an
 * `any` escaping into the assertions, and to build an entry carrying a REAL
 * own `__proto__` / `constructor` key (an object literal cannot).
 */
function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/** Runs `run` and returns whatever it threw, or `undefined` if it did not. */
function catchThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
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
 * Constructs through an `unknown` seam so a structurally invalid options bag
 * can reach the constructor without weakening the public type.
 */
function construct(options: unknown): M3LAppendOnlyStream {
  return new M3LAppendOnlyStream(options as M3LAppendOnlyStreamOptions);
}

/**
 * Hands an arbitrary value to `append()` through an `unknown` seam, so a
 * structurally invalid entry can be passed without weakening the public type.
 */
async function appendUnchecked(
  stream: M3LAppendOnlyStream,
  entry: unknown,
): Promise<void> {
  await stream.append(entry as M3LAppendOnlyEntry);
}

/**
 * Asserts a caller-side boundary violation: a BARE {@link M3LError} carrying
 * `code: "ERR_INVALID_ARGUMENT"`, matching the house pattern.
 *
 * The vocabulary split is asserted in both directions: bad caller input is
 * `ERR_INVALID_ARGUMENT`, while {@link M3LAppendOnlyStreamError} stays
 * reserved for a failure of the append itself.
 */
function expectInvalidArgument(thrown: unknown): M3LError {
  expect(thrown).toBeInstanceOf(M3LError);
  expect(thrown).not.toBeInstanceOf(M3LAppendOnlyStreamError);
  const error = thrown as M3LError;
  expect(error.code).toBe("ERR_INVALID_ARGUMENT");
  return error;
}

/** Asserts the append-failure vocabulary and returns the typed error. */
function expectStreamWriteError(thrown: unknown): M3LAppendOnlyStreamError {
  expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamError);
  expect(thrown).toBeInstanceOf(M3LError);
  const error = thrown as M3LAppendOnlyStreamError;
  expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_WRITE");
  return error;
}

/** Asserts the directory is absent, or holds nothing but empty files. */
async function expectNothingWritten(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // ENOENT is the strongest possible outcome: nothing was ever created.
    return;
  }
  for (const name of names) {
    expect(await readFile(path.join(dir, name), "utf8")).toBe("");
  }
}

let workDir: string;
let probeCounter = 0;

/** A padded entry whose serialized line has a stable, predictable width. */
function paddedEntry(sequence: number, padding = 100): M3LAppendOnlyEntry {
  return {
    seq: String(sequence).padStart(4, "0"),
    pad: "p".repeat(padding),
  };
}

/**
 * Measures the exact on-disk byte cost of one entry (JSON line + newline) by
 * appending it to a throwaway directory and reading the resulting file size.
 *
 * Measuring instead of predicting keeps the rotation tests independent of the
 * serializer's exact key ordering and escaping.
 */
async function measureLineBytes(entry: M3LAppendOnlyEntry): Promise<number> {
  probeCounter += 1;
  const probeDir = path.join(workDir, `probe-${String(probeCounter)}`);
  const probe = new M3LAppendOnlyStream({ directory: probeDir });
  await probe.append(entry);
  const names = await readdir(probeDir);
  const only = definedOrThrow(names[0], "the probe segment");
  const info = await stat(path.join(probeDir, only));
  return info.size;
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-stream-"));
});

afterEach(async () => {
  vi.useRealTimers();
  fsProbe.statFailure = undefined;
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Type contracts
// ---------------------------------------------------------------------------

describe("type contracts", () => {
  test("an entry is a read-only map of append-only values", () => {
    expectTypeOf<M3LAppendOnlyEntry>().toEqualTypeOf<{
      readonly [key: string]: M3LAppendOnlyValue;
    }>();
  });

  test("an append-only value admits JSON scalars, arrays and nested objects", () => {
    expectTypeOf<string>().toExtend<M3LAppendOnlyValue>();
    expectTypeOf<number>().toExtend<M3LAppendOnlyValue>();
    expectTypeOf<boolean>().toExtend<M3LAppendOnlyValue>();
    expectTypeOf<null>().toExtend<M3LAppendOnlyValue>();
    expectTypeOf<readonly string[]>().toExtend<M3LAppendOnlyValue>();
    expectTypeOf<{
      readonly nested: { readonly deeper: readonly number[] };
    }>().toExtend<M3LAppendOnlyValue>();
  });

  test("an append-only value excludes undefined, bigint, functions, symbols and class instances", () => {
    expectTypeOf<undefined>().not.toExtend<M3LAppendOnlyValue>();
    expectTypeOf<bigint>().not.toExtend<M3LAppendOnlyValue>();
    expectTypeOf<() => string>().not.toExtend<M3LAppendOnlyValue>();
    expectTypeOf<symbol>().not.toExtend<M3LAppendOnlyValue>();
    expectTypeOf<Date>().not.toExtend<M3LAppendOnlyValue>();
  });

  test("the options bag requires a directory and makes every ceiling optional", () => {
    expectTypeOf<M3LAppendOnlyStreamOptions>().toMatchObjectType<{
      readonly directory: string;
      readonly maxSegmentBytes?: number;
      readonly maxSegmentAgeMs?: number;
      readonly maxLineBytes?: number;
    }>();
    expectTypeOf<
      M3LAppendOnlyStreamOptions["directory"]
    >().toEqualTypeOf<string>();
    // `directory` is REQUIRED: a bag carrying only a ceiling is not one.
    expectTypeOf<{
      readonly maxSegmentBytes: number;
    }>().not.toExtend<M3LAppendOnlyStreamOptions>();
  });

  test("the stream constructor takes exactly one options bag", () => {
    expectTypeOf<
      typeof M3LAppendOnlyStream
    >().constructorParameters.toEqualTypeOf<
      [options: M3LAppendOnlyStreamOptions]
    >();
  });

  test("directory is a string and append takes one entry and resolves void", () => {
    expectTypeOf<M3LAppendOnlyStream["directory"]>().toEqualTypeOf<string>();
    expectTypeOf<M3LAppendOnlyStream["append"]>().parameters.toEqualTypeOf<
      [M3LAppendOnlyEntry]
    >();
    expectTypeOf<M3LAppendOnlyStream["append"]>().returns.toEqualTypeOf<
      Promise<void>
    >();
  });

  test("the write error narrows its code to its own literal", () => {
    expectTypeOf<
      M3LAppendOnlyStreamError["code"]
    >().toEqualTypeOf<"ERR_APPEND_ONLY_STREAM_WRITE">();
  });

  test("the documented ceilings are numbers", () => {
    expectTypeOf(M3L_APPEND_ONLY_MAX_SEGMENT_BYTES).toBeNumber();
    expectTypeOf(M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS).toBeNumber();
    expectTypeOf(M3L_APPEND_ONLY_MAX_LINE_BYTES).toBeNumber();
  });
});

// ---------------------------------------------------------------------------
// Documented ceilings — the agent decision log's own defaults, reused
// ---------------------------------------------------------------------------

describe("documented ceilings", () => {
  test("the segment byte ceiling is 8 MiB, matching the agent decision log", () => {
    expect(M3L_APPEND_ONLY_MAX_SEGMENT_BYTES).toBe(8_388_608);
  });

  test("the segment age ceiling is 24 hours, matching the agent decision log", () => {
    expect(M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS).toBe(86_400_000);
  });

  test("the line ceiling is 64 KiB, matching the agent decision log's entry ceiling", () => {
    expect(M3L_APPEND_ONLY_MAX_LINE_BYTES).toBe(65_536);
  });
});

// ---------------------------------------------------------------------------
// Round trip — the happy path
// ---------------------------------------------------------------------------

describe("round trip", () => {
  test("appends each entry as exactly one JSON line, in call order", async () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    await stream.append({ event: "first", index: 1 });
    await stream.append({ event: "second", index: 2, nested: { ok: true } });
    await stream.append({ event: "third", index: 3, list: [1, "two", null] });

    const segments = await listSegments(dir);
    expect(segments).toHaveLength(1);
    const segmentPath = path.join(
      dir,
      definedOrThrow(segments[0], "the only segment"),
    );

    const lines = await readLines(segmentPath);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => parseJson(line))).toEqual([
      { event: "first", index: 1 },
      { event: "second", index: 2, nested: { ok: true } },
      { event: "third", index: 3, list: [1, "two", null] },
    ]);

    // Exactly one trailing newline per line, no blank padding lines.
    const raw = await readFile(segmentPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("\n\n");
  });

  test("exposes the configured directory unchanged", () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({ directory: dir });
    expect(stream.directory).toBe(dir);
  });
});

// ---------------------------------------------------------------------------
// O_APPEND — whole-line atomicity across independent writers
// ---------------------------------------------------------------------------

describe("atomic line appends", () => {
  test("two streams over one directory interleave whole lines, never a torn one", async () => {
    const dir = path.join(workDir, "audit");
    // Lines wide enough that a non-atomic write would be observably torn,
    // and a ceiling high enough that neither stream rotates mid-run.
    const padding = 4096;
    const perStream = 25;
    const optionsBag = { directory: dir, maxSegmentBytes: 8_388_608 };
    const streamA = new M3LAppendOnlyStream(optionsBag);
    const streamB = new M3LAppendOnlyStream(optionsBag);

    const appends: Promise<void>[] = [];
    for (let index = 0; index < perStream; index += 1) {
      for (const [writer, stream] of [
        ["A", streamA],
        ["B", streamB],
      ] as const) {
        appends.push(
          stream.append({
            writer,
            index,
            pad: writer.repeat(padding),
          }),
        );
      }
    }
    await Promise.all(appends);

    const segments = await listSegments(dir);
    expect(segments).toHaveLength(1);
    const segmentPath = path.join(
      dir,
      definedOrThrow(segments[0], "the only segment"),
    );

    const lines = await readLines(segmentPath);
    expect(lines).toHaveLength(perStream * 2);

    // Every line is a whole, parseable JSON object whose payload survived at
    // full width — a torn write would either fail to parse or arrive short.
    const seen = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        writer: string;
        index: number;
        pad: string;
      };
      expect(parsed.pad).toHaveLength(padding);
      expect(parsed.pad).toBe(parsed.writer.repeat(padding));
      seen.add(`${parsed.writer}:${String(parsed.index)}`);
    }
    expect(seen.size).toBe(perStream * 2);

    // No interleaving artefact: the file is exactly the lines plus newlines.
    const info = await stat(segmentPath);
    expect(info.size).toBe(
      lines.reduce(
        (total, line) => total + Buffer.byteLength(line, "utf8") + 1,
        0,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// O_NOFOLLOW — a planted symlink is refused, not followed
// ---------------------------------------------------------------------------

describe("symlink refusal", () => {
  test("refuses to append through a symlink planted at the next segment path and leaves its target untouched", async () => {
    const today = pinClock();
    const dir = path.join(workDir, "audit");
    const outsideDir = path.join(workDir, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const target = path.join(outsideDir, "victim.jsonl");
    await writeFile(target, "", "utf8");

    // The stream's very next segment on a cold start of an empty directory.
    // A stream that quietly routed around the planted link instead of
    // refusing it would leave the O_NOFOLLOW guard unexercised, so the
    // refusal — not merely "the target is intact" — is the assertion.
    await symlink(target, path.join(dir, segmentName(today, 1)));

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const thrown = await catchRejected(() =>
      stream.append({ event: "must-not-follow" }),
    );

    expectStreamWriteError(thrown);
    expect(await readFile(target, "utf8")).toBe("");
    const info = await stat(target);
    expect(info.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cold-start segment discovery
// ---------------------------------------------------------------------------

describe("cold-start segment discovery", () => {
  test("a fresh instance adopts today's highest-sequence segment with its real byte size", async () => {
    const today = pinClock();
    const yesterday = new Date(FIXED_CLOCK - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });

    // Seeded out of ascending order, with a lower-sequence today segment, a
    // higher-sequence YESTERDAY segment, and a foreign name in the mix.
    const seedBytes = 500;
    const seeded = `${"s".repeat(seedBytes - 1)}\n`;
    await writeFile(path.join(dir, segmentName(today, 3)), seeded, "utf8");
    await writeFile(path.join(dir, segmentName(today, 1)), "old\n", "utf8");
    await writeFile(
      path.join(dir, segmentName(yesterday, 9)),
      "yesterday\n",
      "utf8",
    );
    await writeFile(path.join(dir, "README.txt"), "not a segment", "utf8");

    const entry = paddedEntry(1);
    const lineBytes = await measureLineBytes(entry);
    expect(lineBytes).toBeGreaterThan(100);

    // A ceiling ABOVE the seeded size but BELOW seeded + one line: if the
    // instance adopted the segment at a size of 0 (rather than reading its
    // real 500 bytes) the second append would NOT rotate. That is what makes
    // this test discriminate real-size discovery from a zero-size assumption.
    const maxSegmentBytes = seedBytes + Math.floor(lineBytes / 2);
    const stream = new M3LAppendOnlyStream({ directory: dir, maxSegmentBytes });

    await stream.append(entry);

    const adopted = path.join(dir, segmentName(today, 3));
    expect(await listSegments(dir)).toEqual(
      [
        "README.txt",
        segmentName(today, 1),
        segmentName(today, 3),
        segmentName(yesterday, 9),
      ].sort(),
    );
    const afterFirst = await stat(adopted);
    expect(afterFirst.size).toBe(seedBytes + lineBytes);

    await stream.append(paddedEntry(2));

    // The ceiling was crossed by the real size, so the next sequence opened.
    const rotated = path.join(dir, segmentName(today, 4));
    const rotatedLines = await readLines(rotated);
    expect(rotatedLines).toHaveLength(1);
    expect(
      JSON.parse(definedOrThrow(rotatedLines[0], "the rotated line")),
    ).toEqual(paddedEntry(2));
    const afterSecond = await stat(adopted);
    expect(afterSecond.size).toBe(seedBytes + lineBytes);
  });

  test("leaves a foreign-named file and a yesterday-dated segment untouched", async () => {
    const today = pinClock();
    const yesterday = new Date(FIXED_CLOCK - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });

    const foreignPath = path.join(dir, "README.txt");
    const yesterdayPath = path.join(dir, segmentName(yesterday, 9999));
    await writeFile(foreignPath, "not a segment", "utf8");
    await writeFile(yesterdayPath, '{"from":"yesterday"}\n', "utf8");

    const stream = new M3LAppendOnlyStream({ directory: dir });
    await stream.append({ event: "today" });

    // A brand-new segment for today was opened rather than yesterday's file
    // (higher sequence, wrong date) or the foreign name being mis-parsed.
    expect(await listSegments(dir)).toEqual(
      [
        "README.txt",
        segmentName(today, 1),
        segmentName(yesterday, 9999),
      ].sort(),
    );
    expect(await readFile(foreignPath, "utf8")).toBe("not a segment");
    expect(await readFile(yesterdayPath, "utf8")).toBe(
      '{"from":"yesterday"}\n',
    );

    const lines = await readLines(path.join(dir, segmentName(today, 1)));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(definedOrThrow(lines[0], "today's only line"))).toEqual({
      event: "today",
    });
  });
});

// ---------------------------------------------------------------------------
// A stat failure that is not ENOENT is never read as absence
// ---------------------------------------------------------------------------

describe("non-ENOENT stat failures", () => {
  test("a stat failure that is not ENOENT fails the append loudly instead of adopting the segment at size zero", async () => {
    const today = pinClock();
    const dir = path.join(workDir, "audit");
    await mkdir(dir, { recursive: true });

    // A segment that genuinely exists and genuinely holds bytes. Only the
    // `stat` of it fails; the file, the directory and the append itself are
    // all real and all writable.
    const seededPath = path.join(dir, segmentName(today, 1));
    const seeded = '{"event":"already-here"}\n';
    await writeFile(seededPath, seeded, "utf8");

    const failure: NodeJS.ErrnoException = Object.assign(
      new Error("EACCES: permission denied, stat"),
      { code: "EACCES", syscall: "stat" },
    );
    fsProbe.statFailure = failure;

    const stream = new M3LAppendOnlyStream({ directory: dir });
    const thrown = await catchRejected(() =>
      stream.append({ event: "must-not-land" }),
    );
    fsProbe.statFailure = undefined;

    // Loud: the raw filesystem error surfaces as the documented append
    // failure, with the original chained as its cause.
    const error = expectStreamWriteError(thrown);
    expect(error.cause).toBe(failure);

    // ... and nothing was written. An implementation that read ANY stat
    // failure as "absent" would instead adopt this 24-byte segment at size 0
    // and append to it happily — the audited defect class, a byte count
    // silently restarting at zero on a file that is already full.
    expect(await readFile(seededPath, "utf8")).toBe(seeded);
    expect(await listSegments(dir)).toEqual([segmentName(today, 1)]);
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe("rotation by bytes", () => {
  test("crossing the byte ceiling seals the active segment and opens a new one", async () => {
    const dir = path.join(workDir, "audit");
    const lineBytes = await measureLineBytes(paddedEntry(0));

    // A ceiling just above one line: line 1 fits; the segment is over the
    // ceiling only AFTER line 2, so line 3 is the one that rotates.
    const maxSegmentBytes = lineBytes + 10;
    const stream = new M3LAppendOnlyStream({ directory: dir, maxSegmentBytes });

    await stream.append(paddedEntry(1));
    await stream.append(paddedEntry(2));

    const afterSecond = await listSegments(dir);
    expect(afterSecond).toHaveLength(1);
    const firstSegment = path.join(
      dir,
      definedOrThrow(afterSecond[0], "the only segment"),
    );
    const sealedContent = await readFile(firstSegment, "utf8");

    await stream.append(paddedEntry(3));

    const afterThird = await listSegments(dir);
    expect(afterThird).toHaveLength(2);

    // The sealed segment is byte-for-byte unchanged; nothing was truncated.
    expect(await readFile(firstSegment, "utf8")).toBe(sealedContent);
    expect(await readLines(firstSegment)).toHaveLength(2);

    const newSegment = afterThird
      .map((name) => path.join(dir, name))
      .find((candidate) => candidate !== firstSegment);
    const newLines = await readLines(
      definedOrThrow(newSegment, "the new segment path"),
    );
    expect(newLines).toHaveLength(1);
    expect(
      JSON.parse(definedOrThrow(newLines[0], "the only new line")),
    ).toEqual(paddedEntry(3));
  });
});

describe("rotation by age", () => {
  test("crossing the age ceiling seals the active segment and opens a new one", async () => {
    const dir = path.join(workDir, "audit");
    const maxSegmentAgeMs = 1000;
    const stream = new M3LAppendOnlyStream({ directory: dir, maxSegmentAgeMs });

    const start = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(start);

    await stream.append({ event: "young" });

    const afterFirst = await listSegments(dir);
    expect(afterFirst).toHaveLength(1);
    const firstSegment = path.join(
      dir,
      definedOrThrow(afterFirst[0], "the only segment"),
    );
    const sealedContent = await readFile(firstSegment, "utf8");

    // Advance well past the ceiling but stay inside the same UTC day, so age
    // — not the date prefix — is the only reason a rotation could fire.
    vi.setSystemTime(start + maxSegmentAgeMs + 60_000);
    await stream.append({ event: "old" });
    vi.useRealTimers();

    const afterSecond = await listSegments(dir);
    expect(afterSecond).toHaveLength(2);
    expect(await readFile(firstSegment, "utf8")).toBe(sealedContent);

    const newSegment = afterSecond
      .map((name) => path.join(dir, name))
      .find((candidate) => candidate !== firstSegment);
    const newLines = await readLines(
      definedOrThrow(newSegment, "the new segment path"),
    );
    expect(newLines).toHaveLength(1);
    expect(
      JSON.parse(definedOrThrow(newLines[0], "the only new line")),
    ).toEqual({ event: "old" });
  });
});

describe("rotation by UTC date rollover", () => {
  test("a long-lived stream crossing UTC midnight opens today's segment instead of appending to yesterday's", async () => {
    const dir = path.join(workDir, "audit");
    const dayOneAt = Date.UTC(2026, 5, 15, 23, 59, 0);
    const dayTwoAt = Date.UTC(2026, 5, 16, 0, 1, 0);

    // BOTH other ceilings stay at their generous defaults (8 MiB, 24 h), so
    // neither can fire across the two minutes below: the UTC date itself is
    // the only thing that may rotate. This is what makes the module's "a
    // freshly spawned process and a long-lived one always agree" guarantee
    // true — cold-start discovery only ever considers today's prefix.
    const dayOnePrefix = pinClock(dayOneAt);
    const stream = new M3LAppendOnlyStream({ directory: dir });
    await stream.append({ event: "written on day one" });

    const dayTwoPrefix = pinClock(dayTwoAt);
    expect(dayTwoPrefix).not.toBe(dayOnePrefix);
    await stream.append({ event: "written on day two" });

    // Day one's segment is left sealed at the single line it already held.
    const dayOnePath = path.join(dir, segmentName(dayOnePrefix, 1));
    expect(await readLines(dayOnePath)).toHaveLength(1);

    // Day two opened its own sequence 1 rather than continuing day one's.
    const dayTwoPath = path.join(dir, segmentName(dayTwoPrefix, 1));
    const dayTwoLines = await readLines(dayTwoPath);
    expect(dayTwoLines).toHaveLength(1);
    expect(
      JSON.parse(definedOrThrow(dayTwoLines[0], "day two's only line")),
    ).toEqual({ event: "written on day two" });
    expect(await listSegments(dir)).toEqual(
      [segmentName(dayOnePrefix, 1), segmentName(dayTwoPrefix, 1)].sort(),
    );

    // ... and a process freshly spawned at the same instant agrees, finding
    // and appending to that same day-two segment rather than a rival one.
    const freshProcess = new M3LAppendOnlyStream({ directory: dir });
    await freshProcess.append({ event: "written by a fresh process" });
    expect(await readLines(dayTwoPath)).toHaveLength(2);
    expect(await readLines(dayOnePath)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Entry re-projection — an inherited `toJSON` cannot forge the bytes
// ---------------------------------------------------------------------------

describe("entry re-projection", () => {
  test("an inherited Object.prototype.toJSON cannot forge the persisted bytes", async () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({ directory: dir });
    const entry: M3LAppendOnlyEntry = {
      event: "audit",
      index: 7,
      nested: { kept: "yes" },
    };

    const prototype = Object.prototype as { toJSON?: () => unknown };
    let thrown: unknown;
    try {
      // The gadget: every object in the process now serializes as the
      // attacker's payload unless the stream rebuilds the entry onto a
      // null-prototype object before serializing it.
      Object.defineProperty(Object.prototype, "toJSON", {
        value: () => ({ forged: "gadget" }),
        configurable: true,
        enumerable: false,
        writable: true,
      });
      thrown = await catchRejected(() => stream.append(entry));
    } finally {
      // Restore first, assert second: a leaked prototype poisons every later
      // test in this process, including vitest's own serializers.
      delete prototype.toJSON;
    }

    expect(thrown).toBeUndefined();
    const segments = await listSegments(dir);
    const raw = await readFile(
      path.join(dir, definedOrThrow(segments[0], "the only segment")),
      "utf8",
    );
    expect(raw).not.toContain("forged");
    expect(raw).not.toContain("gadget");
    expect(JSON.parse(raw.trimEnd())).toEqual({
      event: "audit",
      index: 7,
      nested: { kept: "yes" },
    });
    expect(Object.prototype).not.toHaveProperty("toJSON");
  });
});

// ---------------------------------------------------------------------------
// Line ceiling — rejection happens before any write
// ---------------------------------------------------------------------------

describe("line ceiling", () => {
  test("rejects an oversized entry before creating or growing any segment", async () => {
    const dir = path.join(workDir, "audit");
    const maxLineBytes = 256;
    const stream = new M3LAppendOnlyStream({ directory: dir, maxLineBytes });
    const oversized: M3LAppendOnlyEntry = { pad: "x".repeat(5000) };

    const thrown = await catchRejected(() => stream.append(oversized));
    expectStreamWriteError(thrown);

    // Nothing was created at all: the guard runs before any filesystem call.
    await expectNothingWritten(dir);

    // And on a live segment, the rejected entry does not grow the file.
    await stream.append({ ok: true });
    const segments = await listSegments(dir);
    const segmentPath = path.join(
      dir,
      definedOrThrow(segments[0], "the only segment"),
    );
    const sizeBefore = (await stat(segmentPath)).size;

    const thrownAgain = await catchRejected(() => stream.append(oversized));
    expectStreamWriteError(thrownAgain);
    expect((await stat(segmentPath)).size).toBe(sizeBefore);
    expect(await listSegments(dir)).toEqual(segments);
  });
});

// ---------------------------------------------------------------------------
// Typed errors carry no caller data (but do chain their cause)
// ---------------------------------------------------------------------------

/**
 * Provokes a REAL append failure: the directory is removed underneath a
 * stream that has already cached its active segment, so the next append hits
 * a genuine `ENOENT` from the filesystem rather than an injected mock.
 */
async function provokeAppendFailure(
  dir: string,
  entry: M3LAppendOnlyEntry,
): Promise<{ stream: M3LAppendOnlyStream; thrown: unknown }> {
  const stream = new M3LAppendOnlyStream({ directory: dir });
  await stream.append({ event: "warm-up" });
  await rm(dir, { recursive: true, force: true });
  const thrown = await catchRejected(() => stream.append(entry));
  return { stream, thrown };
}

describe("typed errors carry no caller data", () => {
  test("a failed append names neither the directory nor any entry value", async () => {
    const secret = "tenant-4711-secret-value";
    const secretKey = "cardholder-name";
    const dir = path.join(workDir, "tenant-4711-audit");
    const { thrown } = await provokeAppendFailure(dir, {
      [secretKey]: secret,
      nested: { deeper: [secret] },
    });

    const error = expectStreamWriteError(thrown);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(secretKey);
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toContain(workDir);

    const serializedContext = JSON.stringify(error.context ?? {});
    expect(serializedContext).not.toContain(secret);
    expect(serializedContext).not.toContain(secretKey);
    expect(serializedContext).not.toContain(dir);
    expect(serializedContext).not.toContain(workDir);
  });

  test("a failed append keeps the underlying filesystem error as its cause", async () => {
    const dir = path.join(workDir, "audit");
    const { thrown } = await provokeAppendFailure(dir, { event: "doomed" });

    const error = expectStreamWriteError(thrown);
    // The `cause` is the deliberate exemption from the no-caller-data rule:
    // it is the only diagnostic an operator has, and it may legitimately
    // carry the path the filesystem reported. Pinned so a later "scrub the
    // error" change cannot quietly drop it.
    expect(error.cause).toBeInstanceOf(Error);
    const cause = error.cause as NodeJS.ErrnoException;
    expect(cause.code).toBe("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// Serialized concurrent appends
// ---------------------------------------------------------------------------

describe("serialized concurrent appends", () => {
  test("concurrent appends all land as whole lines with exact byte accounting and rotate on time", async () => {
    const dir = path.join(workDir, "audit");
    const total = 12;
    const linesPerSegment = 3;
    const lineBytes = await measureLineBytes(paddedEntry(0));

    // Just below three lines: the segment is over the ceiling exactly once
    // three lines have landed, so a correct stream produces four segments of
    // three. A stream that resolved rotation once for the whole batch (or
    // reused a stale size) would leave every line in one segment.
    const maxSegmentBytes = linesPerSegment * lineBytes - 1;
    const stream = new M3LAppendOnlyStream({ directory: dir, maxSegmentBytes });

    await Promise.all(
      Array.from({ length: total }, (_unused, index) =>
        stream.append(paddedEntry(index + 1)),
      ),
    );

    const segments = await listSegments(dir);
    expect(segments).toHaveLength(total / linesPerSegment);

    const recovered: unknown[] = [];
    for (const name of segments) {
      const segmentPath = path.join(dir, name);
      const lines = await readLines(segmentPath);
      expect(lines).toHaveLength(linesPerSegment);
      // Exact byte accounting: no partial line, no double-counted newline.
      expect((await stat(segmentPath)).size).toBe(linesPerSegment * lineBytes);
      for (const line of lines) {
        recovered.push(JSON.parse(line));
      }
    }

    expect(recovered).toHaveLength(total);
    expect(
      [...recovered].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    ).toEqual(
      Array.from({ length: total }, (_unused, index) =>
        paddedEntry(index + 1),
      ).sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Cache drop on failure
// ---------------------------------------------------------------------------

describe("cache drop on failure", () => {
  test("an append that fails drops the cached segment so the next append cold-starts and succeeds", async () => {
    const dir = path.join(workDir, "audit");
    const { stream, thrown } = await provokeAppendFailure(dir, {
      event: "lost",
    });
    expectStreamWriteError(thrown);

    // The directory is gone. A stream still holding its cached segment would
    // fail again forever; one that dropped the cache re-creates the
    // directory and re-discovers a segment from cold.
    await stream.append({ event: "recovered" });

    const segments = await listSegments(dir);
    expect(segments).toHaveLength(1);
    const lines = await readLines(
      path.join(dir, definedOrThrow(segments[0], "the only segment")),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(definedOrThrow(lines[0], "the recovered line"))).toEqual({
      event: "recovered",
    });
  });
});

// ---------------------------------------------------------------------------
// Constructor validation — bad caller input is ERR_INVALID_ARGUMENT
// ---------------------------------------------------------------------------

describe("constructor validation", () => {
  test.each([
    { label: "null", bag: null },
    { label: "undefined", bag: undefined },
    { label: "a string", bag: "audit" },
    { label: "a number", bag: 42 },
    { label: "an array", bag: ["audit"] },
    { label: "a class instance", bag: new Date() },
    { label: "a function", bag: () => "audit" },
  ])("rejects $label in place of an options bag", ({ bag }) => {
    expectInvalidArgument(catchThrown(() => construct(bag)));
  });

  test.each([
    { label: "an unrecognized key", bag: { directory: "/tmp/x", nope: 1 } },
    {
      label: "a misspelled ceiling",
      bag: { directory: "/tmp/x", maxSegmentSize: 10 },
    },
  ])("rejects $label in the options bag", ({ bag }) => {
    expectInvalidArgument(catchThrown(() => construct(bag)));
  });

  test.each([
    { label: "an empty string", directory: "" },
    { label: "a whitespace-only string", directory: "   " },
    { label: "a number", directory: 42 },
    { label: "null", directory: null },
    { label: "an array", directory: ["/tmp/x"] },
  ])("rejects $label as the directory", ({ directory }) => {
    expectInvalidArgument(catchThrown(() => construct({ directory })));
  });

  test.each(
    (["maxSegmentBytes", "maxSegmentAgeMs", "maxLineBytes"] as const).flatMap(
      (key) =>
        [
          { label: "zero", value: 0 },
          { label: "a negative number", value: -1 },
          { label: "a fraction", value: 1.5 },
          { label: "NaN", value: Number.NaN },
          { label: "Infinity", value: Number.POSITIVE_INFINITY },
          { label: "a numeric string", value: "10" },
          { label: "null", value: null },
          { label: "a boolean", value: true },
        ].map((row) => ({ key, label: row.label, value: row.value })),
    ),
  )("rejects $label as $key", ({ key, value }) => {
    expectInvalidArgument(
      catchThrown(() =>
        construct({ directory: path.join(workDir, "audit"), [key]: value }),
      ),
    );
  });

  test("accepts a directory plus every ceiling and exposes the directory", () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: 1024,
      maxSegmentAgeMs: 1000,
      maxLineBytes: 512,
    });
    expect(stream.directory).toBe(dir);
  });
});

// ---------------------------------------------------------------------------
// Entry projection — rejected value shapes, nothing written
// ---------------------------------------------------------------------------

/** Builds an object nested `depth` levels deep, past any documented cap. */
function deeplyNested(depth: number): unknown {
  let node: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < depth; level += 1) {
    node = { child: node };
  }
  return node;
}

/** Builds an entry that refers to itself — unbounded without a depth cap. */
function circular(): unknown {
  const node: Record<string, unknown> = { event: "loop" };
  node["self"] = node;
  return node;
}

describe("entry projection rejects values it cannot faithfully persist", () => {
  test.each([
    {
      label: "an own __proto__ key",
      build: () => parseJson('{"__proto__":{"polluted":true}}'),
    },
    {
      label: "an own constructor key",
      build: () => parseJson('{"constructor":"payload"}'),
    },
    { label: "an own prototype key", build: () => ({ prototype: "payload" }) },
    { label: "NaN", build: () => ({ count: Number.NaN }) },
    { label: "Infinity", build: () => ({ count: Number.POSITIVE_INFINITY }) },
    {
      label: "-Infinity",
      build: () => ({ count: Number.NEGATIVE_INFINITY }),
    },
    { label: "a bigint", build: () => ({ count: 10n }) },
    { label: "a function", build: () => ({ render: () => "x" }) },
    { label: "a symbol", build: () => ({ marker: Symbol("marker") }) },
    { label: "undefined", build: () => ({ missing: undefined }) },
    {
      label: "a violation nested inside an array",
      build: () => ({ list: [1, { nested: () => "x" }] }),
    },
    // The in-repo precedent (`M3LCheckpointStore`) caps definition depth at
    // 512; 600 is past any cap a reasonable implementation would document.
    { label: "a structure past the depth cap", build: () => deeplyNested(600) },
    { label: "a circular reference", build: circular },
  ])(
    "rejects $label as ERR_INVALID_ARGUMENT and writes nothing",
    async ({ build }) => {
      const dir = path.join(workDir, "audit");
      const stream = new M3LAppendOnlyStream({ directory: dir });

      const thrown = await catchRejected(() =>
        appendUnchecked(stream, build()),
      );

      expectInvalidArgument(thrown);
      await expectNothingWritten(dir);
    },
  );

  test.each([
    { label: "null", entry: null },
    { label: "an array", entry: [{ event: "x" }] },
    { label: "a string", entry: '{"event":"x"}' },
    { label: "a number", entry: 42 },
    { label: "undefined", entry: undefined },
  ])("rejects $label in place of an entry object", async ({ entry }) => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    const thrown = await catchRejected(() => appendUnchecked(stream, entry));

    expectInvalidArgument(thrown);
    await expectNothingWritten(dir);
  });

  test("projects nested arrays and objects onto the persisted line unchanged", async () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({ directory: dir });
    const entry: M3LAppendOnlyEntry = {
      event: "audit",
      actor: { id: "u-1", roles: ["reader", "writer"] },
      counts: [0, -1, 1.5],
      flags: { dryRun: false, forced: true },
      empty: {},
      none: null,
    };

    await stream.append(entry);

    const segments = await listSegments(dir);
    const lines = await readLines(
      path.join(dir, definedOrThrow(segments[0], "the only segment")),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(definedOrThrow(lines[0], "the only line"))).toEqual(
      entry,
    );
  });
});
