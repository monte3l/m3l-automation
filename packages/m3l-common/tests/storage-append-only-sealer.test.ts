/**
 * Tests for `internal/storage/append-only-sealer` — the writer-side half of
 * ADR-0102's sealed-segment manifest (X8b slice 5): WHEN a segment is sealed.
 * The writer calls this module after an append that rotated, to seal the
 * segment it rotated away from, and it sweeps once per instance for segments
 * a crashed process left unsealed.
 *
 * Two suites, split by topic from the start so neither file grows into a
 * reorganisation:
 *
 * - **This file owns the TRIGGERS**: what a rotation seals, what the cold-start
 *   sweep admits and refuses, the per-instance ceiling, and the work a healthy
 *   trail must NOT do.
 * - `storage-append-only-sealer-failures.test.ts` owns the central claim —
 *   the sealer NEVER throws — driven as a property over every failure that can
 *   be constructed, plus the reporting handler and the bounded retry.
 *
 * Three properties carry this file:
 *
 * 1. **The sweep admits only a STRICTLY OLDER date prefix than today's.** The
 *    looser-looking rule ("today's segments below the highest sequence") is
 *    rejected by the ADR as unsafe: writer A can sit at sequence 3 while
 *    writer B creates sequence 4, and B's sweep would then digest a prefix of
 *    a file A is still appending to — a false positive on a tamper guard. The
 *    DISCRIMINATING assertion is therefore the negative one: a today-dated
 *    segment below the highest sequence must not be swept. A sealer using the
 *    loose rule still passes the yesterday-dated positive case, so that case
 *    alone proves nothing about which rule shipped.
 * 2. **A healthy trail does no work.** One manifest read and ZERO segment
 *    bytes re-read. That is a performance contract the writer depends on —
 *    the sealer runs on the append path — so it is asserted observably, by
 *    counting the `open` calls the sweep issues, not inferred from the seals
 *    it did not write.
 * 3. **The seal reproduces off-host.** ADR-0102 makes plain `sha256` over the
 *    raw bytes a public contract precisely so `sha256sum <archived-segment>`
 *    re-verifies an archive with no library involved. The rotation test
 *    therefore pins the manifest's `sha256` against BOTH an independently
 *    computed hash of the file's bytes and a hard-coded constant for a fixed
 *    fixture — not merely against "a seal exists".
 *
 * Every fixture is real bytes in a real per-test `mkdtemp` sandbox (ADR-0100),
 * read and written through the genuine `node:fs`. Date control is real too:
 * segment names are built from a date prefix derived in the test rather than
 * from a faked clock, because the only thing under test is which NAMES the
 * sweep admits. (A frozen clock shared by the test and the module would make
 * the today/yesterday comparison agree with itself by construction — a
 * vacuous cross-check.) The one sub-millisecond hazard is a run that crosses
 * UTC midnight between this module's import and the sealer's own
 * `currentDatePrefix()`; that is accepted rather than engineered away, since
 * every alternative reintroduces the shared clock.
 *
 * ONE call is wrapped: `open`, as an inert COUNTER. It never changes a
 * result — `importOriginal` keeps every other export and the real `open`
 * underneath — and it exists only so property 2 above can be asserted on
 * observed I/O. Injected faults live in the sibling failures file.
 *
 * A new sibling file on purpose: `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings as unmatched by
 * design.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";
import type { ManifestSealRecord } from "../src/internal/storage/append-only-manifest-records.js";
import {
  M3L_APPEND_ONLY_MANIFEST_NAME,
  MANIFEST_FORMAT_VERSION,
  readManifest,
} from "../src/internal/storage/append-only-manifest.js";
import { AppendOnlySealer } from "../src/internal/storage/append-only-sealer.js";
import type { AppendOnlySealerOptions } from "../src/internal/storage/append-only-sealer.js";

// ---------------------------------------------------------------------------
// The inert `open` counter
// ---------------------------------------------------------------------------

/** Every path the module family has opened during the current test. */
const opened = vi.hoisted(() => ({ paths: [] as string[] }));

/**
 * `open` and nothing else, as a pass-through that records its path.
 * `importOriginal` keeps `mkdtemp`/`writeFile`/`readFile`/`rm` and every read
 * the modules under test issue the genuine article, so no test here is
 * asserting a mock's idea of the bytes.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const realOpen: (
    file: string,
    flags: number,
    mode?: number,
  ) => Promise<FsPromises.FileHandle> = actual.open;
  const open = async (
    file: string,
    flags: number,
    mode?: number,
  ): Promise<FsPromises.FileHandle> => {
    opened.paths.push(file);
    return await realOpen(file, flags, mode);
  };
  return { ...actual, open };
});

afterEach(() => {
  opened.paths = [];
});

/** Segment-named files opened so far — the "bytes re-read" measurement. */
function segmentOpens(): string[] {
  return opened.paths.filter((file) =>
    /\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/.test(path.basename(file)),
  );
}

/** Manifest opens so far — reads and appends alike. */
function manifestOpens(): string[] {
  return opened.paths.filter(
    (file) => path.basename(file) === M3L_APPEND_ONLY_MANIFEST_NAME,
  );
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "m3l-append-only-sealer-"));
  opened.paths = [];
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Date fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The UTC date prefix `offsetDays` before now, `YYYY-MM-DD`. */
function datePrefix(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

const TODAY = datePrefix(0);
const YESTERDAY = datePrefix(-1);
const LAST_WEEK = datePrefix(-7);

/** A segment file name this writer would itself have produced. */
function segmentName(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}.jsonl`;
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** A generous manifest ceiling, so no test is accidentally about the ceiling. */
const AMPLE_MAX_BYTES = 1_048_576;

/**
 * Three newline-terminated entries, byte-for-byte fixed, so its measurement
 * can be pinned as CONSTANTS rather than recomputed by the same primitives the
 * module uses. `FIXTURE_SHA256` is what `sha256sum` prints for these bytes.
 */
const FIXTURE_LINES = [
  '{"entry":"alpha"}',
  '{"entry":"beta"}',
  '{"entry":"gamma"}',
];
const FIXTURE_CONTENT = `${FIXTURE_LINES.join("\n")}\n`;
const FIXTURE_BYTES = 53;
const FIXTURE_SHA256 =
  "44532e9bc336aabb938d0630e6a4da5e06aa895cd91c26bb3668d0134e47bb09";

/** Writes a segment file holding `content`, and returns its name. */
async function writeSegment(
  name: string,
  content = FIXTURE_CONTENT,
): Promise<string> {
  await writeFile(path.join(sandbox, name), content);
  return name;
}

/** Appends one raw record line to the sandbox's manifest. */
async function appendManifestLine(record: unknown): Promise<void> {
  await writeFile(
    path.join(sandbox, M3L_APPEND_ONLY_MANIFEST_NAME),
    `${JSON.stringify(record)}\n`,
    { flag: "a" },
  );
}

/** Seeds the manifest with one `baseline` record stating `upTo`. */
async function seedBaseline(upTo: string | null): Promise<void> {
  await appendManifestLine({
    kind: "baseline",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at: new Date().toISOString(),
    upTo,
  });
}

/** Appends one already-agreeing `seal` record for `segment`. */
async function seedSeal(segment: string): Promise<void> {
  await appendManifestLine({
    kind: "seal",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at: new Date().toISOString(),
    segment,
    entryCount: FIXTURE_LINES.length,
    byteLength: FIXTURE_BYTES,
    sha256: FIXTURE_SHA256,
  });
}

/**
 * A real failure port, not a mock of the behaviour under test: it builds a
 * genuine `M3LError` the way an owner would. The `code` is a test-local
 * sentinel precisely because this module has no say in the real one.
 */
function failurePort(): AppendOnlyReadFailure {
  return (message, options) =>
    new M3LError(message, {
      code: "ERR_TEST_APPEND_ONLY_SEALER",
      cause: options?.cause,
      context: { ...options?.context },
    });
}

/** Reads the manifest back through the real reader. */
async function sealsOnDisk(): Promise<ReadonlyMap<string, ManifestSealRecord>> {
  const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, failurePort());
  return contents.seals;
}

/** The sealed segment names on disk, in manifest order. */
async function sealedNames(): Promise<string[]> {
  return [...(await sealsOnDisk()).keys()];
}

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * A sealer over the sandbox with generous bounds, so nothing here is
 * accidentally about a ceiling. `maxSegmentBytes + maxLineBytes` is the
 * digest bound ADR-0102 fixes, and both halves are stated so a test can pin
 * that sum.
 */
function createSealer(
  overrides: Partial<AppendOnlySealerOptions> = {},
): AppendOnlySealer {
  return new AppendOnlySealer({
    directory: sandbox,
    maxSegmentBytes: 8_388_608,
    maxLineBytes: 65_536,
    maxManifestBytes: AMPLE_MAX_BYTES,
    buildError: failurePort(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Rotation sealing
// ---------------------------------------------------------------------------

describe("rotation sealing", () => {
  test("seals the segment the writer rotated away from", async () => {
    await seedBaseline(null);
    const rotated = await writeSegment(segmentName(TODAY, 1));
    await writeSegment(segmentName(TODAY, 2));

    await createSealer().sealAfterAppend(rotated);

    expect(await sealedNames()).toEqual([rotated]);
  });

  test("records the entry count and byte length the segment actually holds", async () => {
    await seedBaseline(null);
    const rotated = await writeSegment(segmentName(TODAY, 1));

    await createSealer().sealAfterAppend(rotated);

    const seal = definedOrThrow((await sealsOnDisk()).get(rotated), "the seal");
    expect(seal.entryCount).toBe(FIXTURE_LINES.length);
    expect(seal.byteLength).toBe(FIXTURE_BYTES);
  });

  test("records a sha256 an off-host sha256sum of the same bytes reproduces", async () => {
    await seedBaseline(null);
    const rotated = await writeSegment(segmentName(TODAY, 1));
    // Independent of the module's chunking and framing: the whole file's raw
    // bytes hashed in one shot, plus a constant nothing in this run computed.
    const bytes = await readFile(path.join(sandbox, rotated));
    const independent = createHash("sha256").update(bytes).digest("hex");

    await createSealer().sealAfterAppend(rotated);

    const seal = definedOrThrow((await sealsOnDisk()).get(rotated), "the seal");
    expect(seal.sha256).toBe(independent);
    expect(seal.sha256).toBe(FIXTURE_SHA256);
  });

  test("seals a segment above maxSegmentBytes but within it plus maxLineBytes", async () => {
    // `shouldRotate` tests size BEFORE the append, so the line crossing the
    // ceiling lands in the OUTGOING segment: a sealer sizing its read at
    // `maxSegmentBytes` would truncate exactly the segments that rotated on
    // size, which is the common case (ADR-0102).
    await seedBaseline(null);
    const oversized = `${"x".repeat(99)}\n`;
    const rotated = await writeSegment(segmentName(TODAY, 1), oversized);

    await createSealer({
      maxSegmentBytes: 64,
      maxLineBytes: 64,
    }).sealAfterAppend(rotated);

    const seal = definedOrThrow((await sealsOnDisk()).get(rotated), "the seal");
    expect(seal.byteLength).toBe(100);
  });

  test("seals nothing when the append did not rotate", async () => {
    await seedBaseline(null);
    await writeSegment(segmentName(TODAY, 1));

    await createSealer().sealAfterAppend(undefined);

    expect(await sealedNames()).toEqual([]);
  });

  test("writes the baseline on its first act when the manifest is absent", async () => {
    const rotated = await writeSegment(segmentName(TODAY, 1));
    const highest = await writeSegment(segmentName(TODAY, 2));

    await createSealer().sealAfterAppend(rotated);

    const contents = await readManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      failurePort(),
    );
    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      highest,
    );
  });

  test("a re-sealed segment leaves the manifest readable, never a disagreeing duplicate", async () => {
    // Two agreeing seals are tolerated silently; two that disagree on
    // `(entryCount, byteLength, sha256)` make the manifest fatal to read. A
    // sealer that sealed one segment twice must still leave a manifest the
    // reader accepts.
    await seedBaseline(null);
    const rotated = await writeSegment(segmentName(TODAY, 1));
    const sealer = createSealer();

    await sealer.sealAfterAppend(rotated);
    await sealer.sealAfterAppend(rotated);

    const seal = definedOrThrow((await sealsOnDisk()).get(rotated), "the seal");
    expect(seal.sha256).toBe(FIXTURE_SHA256);
  });
});

// ---------------------------------------------------------------------------
// An upgraded trail's first rotation
// ---------------------------------------------------------------------------

/**
 * A pre-upgrade trail: segments already on disk and no manifest at all, so the
 * sealer's first act stamps a baseline whose `upTo` is the HIGHEST of them —
 * which is today's adopted segment, the very one the next rotation will seal.
 *
 * Two older-dated segments sit below it so that one fixture exercises both
 * rules at once. Their exclusion from the sweep is the BASELINE rule doing the
 * work, not the date rule: they would be swept on their date alone, and are
 * kept out only because they fall at or before the baseline.
 */
async function seedPreUpgradeTrail(): Promise<string> {
  await writeSegment(segmentName(YESTERDAY, 1));
  await writeSegment(segmentName(YESTERDAY, 2));
  return await writeSegment(segmentName(TODAY, 1));
}

describe("an upgraded trail's first rotation", () => {
  test("seals the rotated segment even though the baseline names it", async () => {
    // A rotation seal ignores the at-or-before-baseline filter, which governs
    // the SWEEP alone. The baseline says "no claim is made that anything at or
    // before here was correct WHEN WRITTEN"; a seal says "these were the bytes
    // AT SEAL TIME". Both are true together, and the pair is strictly more
    // precise than either alone — after sealing, later tampering with that
    // segment is detectable even though its original contents never were.
    // Under the rejected reading the first rotation after an upgrade produces
    // no seal at all, and the feature reads as broken to the operator who
    // upgraded to get it.
    const rotated = await seedPreUpgradeTrail();
    const bytes = await readFile(path.join(sandbox, rotated));
    const independent = createHash("sha256").update(bytes).digest("hex");

    await createSealer().sealAfterAppend(rotated);

    const contents = await readManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      failurePort(),
    );
    // Pinned, not assumed: the rotated segment really is AT the baseline, so
    // the assertion below cannot pass by the filter simply not applying.
    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      rotated,
    );
    const seal = definedOrThrow(contents.seals.get(rotated), "the seal");
    expect(seal.sha256).toBe(independent);
  });

  test("the same baseline still keeps older segments out of the sweep", async () => {
    // The contrast, in the SAME fixture: the filter the rotation ignores is
    // the filter the sweep obeys. A digest taken now cannot vouch for bytes a
    // pre-upgrade process wrote, so these stay unproven.
    const rotated = await seedPreUpgradeTrail();

    await createSealer().sealAfterAppend(rotated);

    expect(await sealedNames()).toEqual([rotated]);
    expect(segmentOpens().map((file) => path.basename(file))).toEqual([
      rotated,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The cold-start sweep
// ---------------------------------------------------------------------------

describe("the cold-start sweep", () => {
  test("seals a segment an older date left unsealed", async () => {
    await seedBaseline(null);
    const stale = await writeSegment(segmentName(YESTERDAY, 1));
    await writeSegment(segmentName(TODAY, 1));

    await createSealer().sealAfterAppend(undefined);

    expect(await sealedNames()).toEqual([stale]);
  });

  test("never sweeps a today-dated segment below the highest sequence", async () => {
    // THE discriminating assertion of this file. The rejected loose rule
    // ("today's segments below the highest sequence") sweeps this fixture;
    // the strictly-older-date rule ADR-0102 mandates does not. Writer A can
    // sit at sequence 1 while writer B creates sequence 2, so digesting
    // sequence 1 here would digest a prefix of a file A is still appending
    // to — a false positive on a tamper guard.
    await seedBaseline(null);
    await writeSegment(segmentName(TODAY, 1));
    await writeSegment(segmentName(TODAY, 2));
    await writeSegment(segmentName(TODAY, 3));

    await createSealer().sealAfterAppend(undefined);

    expect(await sealedNames()).toEqual([]);
  });

  test("re-reads no segment bytes when today's segments are the only unsealed ones", async () => {
    // The negative of the same rule, stated on observed I/O rather than on
    // the manifest: refusing to seal is not enough if the sealer still
    // digested the file to decide.
    await seedBaseline(null);
    await writeSegment(segmentName(TODAY, 1));
    await writeSegment(segmentName(TODAY, 2));

    await createSealer().sealAfterAppend(undefined);

    expect(segmentOpens()).toEqual([]);
  });

  test("never sweeps a segment the manifest already names", async () => {
    await seedBaseline(null);
    const sealed = await writeSegment(segmentName(YESTERDAY, 1));
    await seedSeal(sealed);
    const unsealed = await writeSegment(segmentName(YESTERDAY, 2));
    await writeSegment(segmentName(TODAY, 1));

    await createSealer().sealAfterAppend(undefined);

    expect(await sealedNames()).toEqual([sealed, unsealed]);
    expect(segmentOpens().map((file) => path.basename(file))).toEqual([
      unsealed,
    ]);
  });

  test("never retro-digests a segment at or before the baseline", async () => {
    // A digest taken now cannot vouch for bytes a pre-upgrade process wrote,
    // so `legacy` segments stay unproven rather than falsely proven.
    const legacyOld = await writeSegment(segmentName(LAST_WEEK, 1));
    const legacyBoundary = await writeSegment(segmentName(YESTERDAY, 1));
    const afterBaseline = await writeSegment(segmentName(YESTERDAY, 2));
    await seedBaseline(legacyBoundary);

    await createSealer().sealAfterAppend(undefined);

    expect(await sealedNames()).toEqual([afterBaseline]);
    expect(segmentOpens().map((file) => path.basename(file))).not.toContain(
      legacyOld,
    );
  });

  test("does one manifest read and no segment read at all on a healthy trail", async () => {
    // The performance contract the writer depends on: the sealer runs on the
    // append path, so a trail with nothing to seal must cost one manifest
    // read and zero segment bytes.
    const sealed = await writeSegment(segmentName(YESTERDAY, 1));
    await seedBaseline(null);
    await seedSeal(sealed);
    await writeSegment(segmentName(TODAY, 1));

    await createSealer().sealAfterAppend(undefined);

    expect(segmentOpens()).toEqual([]);
    expect(manifestOpens()).toHaveLength(1);
  });

  test("sweeps once per instance, not once per append", async () => {
    await seedBaseline(null);
    await writeSegment(segmentName(YESTERDAY, 1));
    await writeSegment(segmentName(TODAY, 1));
    const sealer = createSealer();

    await sealer.sealAfterAppend(undefined);
    const afterFirst = segmentOpens().length;
    // A second unsealed old segment appears between the two appends: a
    // per-append sweep would find and seal it; a per-instance one never
    // looks again.
    await writeSegment(segmentName(YESTERDAY, 2));
    await sealer.sealAfterAppend(undefined);

    expect(afterFirst).toBeGreaterThan(0);
    expect(segmentOpens()).toHaveLength(afterFirst);
    expect(await sealedNames()).toEqual([segmentName(YESTERDAY, 1)]);
  });

  test("a fresh instance over the same directory sweeps again", async () => {
    // The counterpart of the test above: "once" is a property of the
    // INSTANCE, not a latch written into the directory. A crashed process's
    // successor must still sweep.
    await seedBaseline(null);
    const stale = await writeSegment(segmentName(YESTERDAY, 1));
    await writeSegment(segmentName(TODAY, 1));

    await createSealer().sealAfterAppend(undefined);
    await writeSegment(segmentName(YESTERDAY, 2));
    await createSealer().sealAfterAppend(undefined);

    expect(await sealedNames()).toEqual([stale, segmentName(YESTERDAY, 2)]);
  });
});

// ---------------------------------------------------------------------------
// The per-instance sweep ceiling
// ---------------------------------------------------------------------------

describe("the per-instance sweep ceiling", () => {
  test("seals no more than the ceiling in one cold start", async () => {
    await seedBaseline(null);
    for (const sequence of [1, 2, 3]) {
      await writeSegment(segmentName(LAST_WEEK, sequence));
      await writeSegment(segmentName(YESTERDAY, sequence));
    }
    await writeSegment(segmentName(TODAY, 1));

    await createSealer({ maxSweepSeals: 2 }).sealAfterAppend(undefined);

    expect(await sealedNames()).toHaveLength(2);
  });

  test("seals the oldest unsealed segments first", async () => {
    // Oldest-first is what makes a bounded sweep converge: each cold start
    // clears the front of the backlog rather than re-picking the same
    // arbitrary subset.
    await seedBaseline(null);
    for (const sequence of [1, 2, 3]) {
      await writeSegment(segmentName(LAST_WEEK, sequence));
      await writeSegment(segmentName(YESTERDAY, sequence));
    }
    await writeSegment(segmentName(TODAY, 1));

    await createSealer({ maxSweepSeals: 4 }).sealAfterAppend(undefined);

    expect((await sealedNames()).toSorted()).toEqual([
      segmentName(LAST_WEEK, 1),
      segmentName(LAST_WEEK, 2),
      segmentName(LAST_WEEK, 3),
      segmentName(YESTERDAY, 1),
    ]);
  });

  test("re-reads only the segments it is allowed to seal", async () => {
    // The ceiling is what stops a pathological directory turning one cold
    // start into an unbounded read, so it has to bound the READS and not
    // merely the manifest lines written.
    await seedBaseline(null);
    for (const sequence of [1, 2, 3, 4]) {
      await writeSegment(segmentName(YESTERDAY, sequence));
    }
    await writeSegment(segmentName(TODAY, 1));

    await createSealer({ maxSweepSeals: 1 }).sealAfterAppend(undefined);

    expect(segmentOpens().map((file) => path.basename(file))).toEqual([
      segmentName(YESTERDAY, 1),
    ]);
  });

  test("the rotated segment is sealed even when the sweep is at its ceiling", async () => {
    // A rotation seal is about bytes this process just wrote; the sweep's
    // budget for a crashed predecessor's backlog must not consume it.
    await seedBaseline(null);
    for (const sequence of [1, 2]) {
      await writeSegment(segmentName(YESTERDAY, sequence));
    }
    const rotated = await writeSegment(segmentName(TODAY, 1));
    await writeSegment(segmentName(TODAY, 2));

    await createSealer({ maxSweepSeals: 1 }).sealAfterAppend(rotated);

    expect((await sealedNames()).toSorted()).toEqual([
      segmentName(YESTERDAY, 1),
      rotated,
    ]);
  });

  test("falls back to the default ceiling, and still sweeps, when maxSweepSeals is NaN", async () => {
    // `Math.max(0, NaN)` is `NaN`, and `Array.prototype.slice(0, NaN)` is
    // EMPTY — a malformed override must not silently turn the sweep off.
    await seedBaseline(null);
    const stale = await writeSegment(segmentName(YESTERDAY, 1));
    await writeSegment(segmentName(TODAY, 1));

    await createSealer({ maxSweepSeals: NaN }).sealAfterAppend(undefined);

    expect(await sealedNames()).toEqual([stale]);
  });
});
