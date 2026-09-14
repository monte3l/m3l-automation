/**
 * `M3LAppendOnlyStream.read()`'s INLINE DIGEST VERIFICATION (ADR-0102, X8b
 * slice 4d): as `read()` streams a segment's bytes it feeds them to
 * `internal/storage/append-only-digest.ts`'s `SegmentDigest` and compares the
 * measurement against what the directory's `manifest.jsonl` sealed for that
 * segment — throwing `M3LAppendOnlyStreamIntegrityError`
 * (`ERR_APPEND_ONLY_STREAM_INTEGRITY`) when the two disagree.
 *
 * A NEW sibling file rather than a section of `storage-append-only-read.test.ts`:
 * that file sits at 58,885 bytes against `check:file-budget`'s 60,000-byte
 * ceiling, and `check:test-counts` pins a count for `storage.test.ts` alone
 * while treating these append-only siblings as unmatched by design — so a new
 * sibling is the only option either gate leaves open.
 *
 * **Every fixture here is produced by driving a real `M3LAppendOnlyStream`**
 * (a small `maxSegmentBytes`, real rotations, real seals written by the real
 * sealer), the technique `storage-append-only-stream-verify.test.ts` and
 * `storage-append-only-seal-wiring.test.ts` already use. No seal record and
 * no baseline record in this file is hand-written: pinning a hand-written
 * `manifest.jsonl` would pin this suite's own idea of a seal rather than the
 * library's. Only the SEGMENT bytes are written by hand, and only ever
 * *after* the real sealer has already sealed them — which is the tampering
 * these tests are about, and bytes the writer could never itself produce.
 *
 * These are filesystem invariants (a digest over bytes actually on disk), so
 * the suite uses a real `mkdtemp` sandbox under `os.tmpdir()` removed in
 * teardown (ADR-0100), never a mocked `node:fs`.
 *
 * **Why the clean-trail cases here are not filler.** Most cases below expect
 * a throw, and an implementation that threw for *every* sealed segment would
 * satisfy all of them. The P4 section is the guard against exactly that, and
 * the P3 section is the guard against the opposite over-reach (digesting
 * segments that carry no claim).
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

import { M3LError } from "../src/core/errors/index.js";
import {
  M3L_APPEND_ONLY_MANIFEST_NAME,
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamIntegrityError,
  M3LAppendOnlyStreamManifestError,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";
import type {
  M3LAppendOnlyEntry,
  M3LAppendOnlyReadOptions,
  M3LAppendOnlySealedSegment,
  M3LAppendOnlySegmentMeasurement,
} from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-read-digest-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers — real writer, real sealer, real manifest
// ---------------------------------------------------------------------------

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * The entry width this suite's fixtures are built around: the writer
 * serializes `{ seq: <0..9> }` as the 9 bytes `{"seq":0}` plus its
 * terminator, so a `maxSegmentBytes` of 15 rotates on every SECOND append —
 * giving 20-byte, two-entry segments, which is the smallest shape that can
 * carry an entry-count tamper at an unchanged byte length.
 */
const SEGMENT_CEILING_BYTES = 15;

/** One segment of the fixtures below, as the writer wrote it. */
const CLEAN_SEGMENT_BYTES = 20;

/** Entries per fixture segment, as the real sealer sealed it. */
const CLEAN_SEGMENT_ENTRIES = 2;

/**
 * FIXTURE A — a fresh trail of three 20-byte, two-entry segments: the first
 * two rotated away and SEALED by the real sealer, the third still active and
 * therefore unclaimed. The baseline the writer stamps on its first act
 * asserts `upTo: null`, so nothing here is `legacy`.
 *
 * `flush()` before returning: appends and seals settle asynchronously, so
 * measuring or tampering before it would race the sealer.
 */
async function buildSealedTrail(dir: string): Promise<readonly string[]> {
  const stream = new M3LAppendOnlyStream({
    directory: dir,
    maxSegmentBytes: SEGMENT_CEILING_BYTES,
  });
  for (let index = 0; index < 6; index += 1) {
    await stream.append({ seq: index });
  }
  await stream.flush();
  const listing = await stream.listSegments();
  return listing.segments.map((segment) => segment.name);
}

/**
 * FIXTURE B — the same trail, re-entered by a SECOND stream after its
 * `manifest.jsonl` has been removed, which is what makes every one of rule
 * C2's three classes present at once without a single hand-written manifest
 * line:
 *
 * - `0001`, `0002` — at or before the new baseline AND unclaimed: `legacy`.
 * - `0003` — at or before the new baseline AND claimed by a real seal: the
 *   seal-outranks-baseline case, which must still be verified.
 * - `0004` — claimed, after the baseline: an ordinary sealed segment.
 * - `0005` — still active, unclaimed: `unsealed`.
 *
 * The second stream stamps its own baseline at the highest segment that
 * already existed (`internal/storage/append-only-manifest-baseline.ts`), and
 * then seals `0003` as it rotates off it — so the overlap between "sealed"
 * and "at or before the baseline" is the writer's own doing, not this
 * fixture's. Each test asserts the parts of this layout it depends on, so a
 * writer change that shifts the baseline fails loudly instead of quietly
 * turning a precedence test into a duplicate of a different case.
 */
async function buildBaselinedTrail(dir: string): Promise<readonly string[]> {
  await buildSealedTrail(dir);
  await unlink(path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME));
  const stream = new M3LAppendOnlyStream({
    directory: dir,
    maxSegmentBytes: SEGMENT_CEILING_BYTES,
  });
  for (let index = 0; index < 3; index += 1) {
    await stream.append({ seq: 100 + index });
  }
  await stream.flush();
  const listing = await stream.listSegments();
  return listing.segments.map((segment) => segment.name);
}

/** A `seal` line of the real manifest, as the real sealer wrote it. */
interface SealLine extends M3LAppendOnlySegmentMeasurement {
  readonly kind: "seal";
  readonly formatVersion: number;
  readonly at: string;
  readonly segment: string;
}

/** A `baseline` line of the real manifest, as the real writer stamped it. */
interface BaselineLine {
  readonly kind: "baseline";
  readonly formatVersion: number;
  readonly at: string;
  readonly upTo: string | null;
}

/** Every record the directory's real `manifest.jsonl` states, in file order. */
async function readManifestRecords(
  dir: string,
): Promise<readonly (SealLine | BaselineLine)[]> {
  const content = await readFile(
    path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME),
    "utf8",
  );
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SealLine | BaselineLine);
}

/**
 * The real seal for `segment`, as the public
 * {@link M3LAppendOnlySealedSegment} claim shape — the independent source of
 * truth every `context.sealed` assertion below compares against. Read out of
 * the manifest the sealer wrote, never out of the error under test.
 */
async function sealedClaim(
  dir: string,
  segment: string,
): Promise<M3LAppendOnlySealedSegment> {
  const records = await readManifestRecords(dir);
  const seal = definedOrThrow(
    records.find(
      (record): record is SealLine =>
        record.kind === "seal" && record.segment === segment,
    ),
    `a real seal record for ${segment}`,
  );
  return {
    segment: seal.segment,
    at: seal.at,
    entryCount: seal.entryCount,
    byteLength: seal.byteLength,
    sha256: seal.sha256,
  };
}

/** The baseline the real writer stamped, or `undefined` when it stated none. */
async function statedBaseline(dir: string): Promise<BaselineLine | undefined> {
  const records = await readManifestRecords(dir);
  return records
    .filter((record): record is BaselineLine => record.kind === "baseline")
    .at(-1);
}

/**
 * The measurement an INDEPENDENT reading of `segment`'s bytes produces:
 * newline-terminated entries, raw byte length, and `node:crypto`'s own plain
 * `sha256` over those bytes.
 *
 * Deliberately computed here rather than read back out of the error under
 * test — asserting `context.observed` against whatever the implementation
 * reported would be circular. `sha256` is a plain digest of the raw bytes by
 * contract (ADR-0102), so `createHash("sha256")` over the file reproduces it
 * with none of the library involved, exactly as `sha256sum` would off-host.
 */
async function measureOnDisk(
  dir: string,
  segment: string,
): Promise<M3LAppendOnlySegmentMeasurement> {
  const bytes = await readFile(path.join(dir, segment));
  let entryCount = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      entryCount += 1;
    }
  }
  return {
    entryCount,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Overwrites one segment's bytes AFTER the real sealer has sealed them — the
 * tampering every P1/P2 case is about, and the one thing in this file the
 * writer could never have produced itself.
 */
async function tamperSegment(
  dir: string,
  segment: string,
  bytes: string,
): Promise<void> {
  await writeFile(path.join(dir, segment), bytes, "utf8");
}

/** What one `read()` handed back, and how it ended. */
interface ReadOutcome {
  /** Every entry the consumer actually received, in read order. */
  readonly entries: readonly M3LAppendOnlyEntry[];
  /** Whatever the iteration threw, or `undefined` when it completed. */
  readonly thrown: unknown;
}

/**
 * Drains `read()` over `dir`, capturing BOTH the entries the consumer
 * received and the failure (if any) that ended the iteration.
 *
 * Capturing the entries is not incidental: "it threw" alone cannot tell an
 * early refusal from a late one, and for the byte-overrun case that
 * difference is the whole contract.
 *
 * `readChunkCeiling` is OPTIONAL and omitted by every case that does not name
 * it, which keeps the default read exactly the single-chunk read every P1–P5
 * case above was written against. Supplying it lowers `maxLineBytes` on the
 * READING stream only — the fixtures are written by a different stream
 * instance, so the sealed bytes and the seals themselves are untouched — and
 * `maxLineBytes` is also the size of every buffer
 * `internal/storage/append-only-lines.ts`' `readChunks` fills, which is the
 * only lever this suite has for making one segment arrive in more than one
 * chunk (see {@link MULTI_CHUNK_READ_CEILING}).
 */
async function readTrail(
  dir: string,
  options?: M3LAppendOnlyReadOptions,
  readChunkCeiling?: number,
): Promise<ReadOutcome> {
  // Built as two whole bags rather than one with a `maxLineBytes: undefined`
  // key: the constructor reads its ceilings through `Object.hasOwn`, so a
  // present-but-undefined key is rejected as `not-a-positive-integer` rather
  // than resolved to the default.
  const stream = new M3LAppendOnlyStream(
    readChunkCeiling === undefined
      ? { directory: dir, maxSegmentBytes: SEGMENT_CEILING_BYTES }
      : {
          directory: dir,
          maxSegmentBytes: SEGMENT_CEILING_BYTES,
          maxLineBytes: readChunkCeiling,
        },
  );
  const entries: M3LAppendOnlyEntry[] = [];
  try {
    for await (const entry of stream.read(options)) {
      entries.push(entry);
    }
  } catch (error) {
    return { entries, thrown: error };
  }
  return { entries, thrown: undefined };
}

/** Narrows a captured failure to the integrity error, or fails the test. */
function asIntegrityError(thrown: unknown): M3LAppendOnlyStreamIntegrityError {
  expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamIntegrityError);
  if (!(thrown instanceof M3LAppendOnlyStreamIntegrityError)) {
    throw new Error("expected an M3LAppendOnlyStreamIntegrityError");
  }
  return thrown;
}

/** The `{ sealed, observed }` pair the integrity error's `context` carries. */
function integrityContext(error: M3LAppendOnlyStreamIntegrityError): {
  readonly sealed: unknown;
  readonly observed: unknown;
} {
  const context = definedOrThrow(error.context, "the integrity error context");
  return { sealed: context["sealed"], observed: context["observed"] };
}

/**
 * The OWN-enumerable keys of one `context` payload, sorted — the shape
 * statement neither `toMatchObject` nor a property-presence check can make.
 *
 * The direction that matters is that nothing EXTRA appears, and only an exact
 * key set fails when a field is ADDED. `Object.keys` is the right tool twice
 * over: it sees a present-but-`undefined` key that a values-only `toEqual`
 * treats as absent, and it never falls back to `in` the way
 * `not.toHaveProperty` does — that fallback walks the prototype chain, so a
 * `not.toHaveProperty("sha256")` guard here could pass vacuously.
 */
function ownKeysOf(payload: unknown, label: string): readonly string[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`expected ${label} to be an object`);
  }
  return Object.keys(payload).sort();
}

/** One own numeric field of a `context` payload, or a test failure. */
function ownNumberOf(payload: unknown, key: string, label: string): number {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`expected ${label} to be an object`);
  }
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "number") {
    throw new Error(`expected ${label} to carry a numeric own ${key}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// P1 — verification is not optional: there is no opt-out to find
// ---------------------------------------------------------------------------

describe("P1 — no caller can consent to reading bytes that are not the sealed bytes", () => {
  test("the read-options key set did not grow a verification switch", () => {
    // The EXACT shape of this bag is already pinned once, in
    // storage-append-only-read.test.ts ("read options carry exactly two
    // optional callbacks"); this is deliberately the narrower `keyof`
    // statement of the same fact, stated here because "no opt-out exists" is
    // this slice's contract and this is the file a reader comes to for it.
    // Exact equality, never `toMatchTypeOf`: a third key — `verifyDigests`,
    // `onIntegrityMismatch`, anything — must fail this line.
    expectTypeOf<keyof M3LAppendOnlyReadOptions>().toEqualTypeOf<
      "onTruncatedTail" | "onArchivedSegment"
    >();
  });

  test("read() refuses an unknown own key, so an opt-out cannot be smuggled past the type system", async () => {
    const dir = path.join(workDir, "audit");
    await buildSealedTrail(dir);
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: SEGMENT_CEILING_BYTES,
    });

    let thrown: unknown;
    try {
      stream.read({
        verifyDigests: false,
      } as unknown as M3LAppendOnlyReadOptions);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
  });

  test("an in-place edit of the same length and newline count throws the integrity error", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const tampered = definedOrThrow(names[0], "the first sealed segment");
    const seal = await sealedClaim(dir, tampered);

    // The tamper's whole point: only the `sha256` can possibly move. Asserted
    // as a PRECONDITION so it cannot silently drift into the byte-length or
    // entry-count case and still pass.
    await tamperSegment(dir, tampered, '{"seq":9}\n{"seq":1}\n');
    const observed = await measureOnDisk(dir, tampered);
    expect(observed.byteLength).toBe(seal.byteLength);
    expect(observed.entryCount).toBe(seal.entryCount);
    expect(observed.sha256).not.toBe(seal.sha256);

    const outcome = await readTrail(dir);
    const error = asIntegrityError(outcome.thrown);
    expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
    // `sealed` is the manifest's claim and `observed` is what the bytes
    // actually measure — both compared against values derived OUTSIDE the
    // implementation (the sealer's own manifest line, and node:crypto over
    // the file), never read back out of the error.
    expect(integrityContext(error).sealed).toEqual(seal);
    expect(integrityContext(error).observed).toEqual(observed);
  });

  test("a changed entry count at an unchanged byte length throws the integrity error", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const tampered = definedOrThrow(names[0], "the first sealed segment");
    const seal = await sealedClaim(dir, tampered);

    // One 19-byte line plus its terminator: the same 20 bytes the seal
    // claims, but one entry instead of two. Byte length is held EQUAL on
    // purpose, so neither the shrink check nor the overrun check can be what
    // fires here.
    await tamperSegment(dir, tampered, '{"pad":"xxxxxxxxx"}\n');
    const observed = await measureOnDisk(dir, tampered);
    expect(observed.byteLength).toBe(seal.byteLength);
    expect(observed.entryCount).toBe(1);
    expect(seal.entryCount).toBe(CLEAN_SEGMENT_ENTRIES);

    const outcome = await readTrail(dir);
    const error = asIntegrityError(outcome.thrown);
    expect(integrityContext(error).sealed).toEqual(seal);
    expect(integrityContext(error).observed).toEqual(observed);
  });

  test("a segment that shrank below its sealed byte length throws the integrity error", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const tampered = definedOrThrow(names[0], "the first sealed segment");
    const seal = await sealedClaim(dir, tampered);

    // Two terminated lines still, so the entry count is held EQUAL and the
    // byte length is the only number below the seal. A shrink is not
    // detectable before the segment's end — cumulative bytes never exceed
    // the claim — which is what separates this from the P2 overrun case.
    await tamperSegment(dir, tampered, "{}\n{}\n");
    const observed = await measureOnDisk(dir, tampered);
    expect(observed.entryCount).toBe(seal.entryCount);
    expect(observed.byteLength).toBeLessThan(seal.byteLength);

    const outcome = await readTrail(dir);
    const error = asIntegrityError(outcome.thrown);
    expect(integrityContext(error).sealed).toEqual(seal);
    expect(integrityContext(error).observed).toEqual(observed);
  });

  test("a tampered segment is NOT reported as a manifest failure, and an archived one is NOT reported as an integrity failure", async () => {
    const dirTampered = path.join(workDir, "tampered");
    const tamperedNames = await buildSealedTrail(dirTampered);
    const tampered = definedOrThrow(
      tamperedNames[0],
      "the first sealed segment",
    );
    await tamperSegment(dirTampered, tampered, '{"seq":9}\n{"seq":1}\n');
    const tamperOutcome = await readTrail(dirTampered);
    expect(tamperOutcome.thrown).toBeInstanceOf(
      M3LAppendOnlyStreamIntegrityError,
    );
    expect(tamperOutcome.thrown).not.toBeInstanceOf(
      M3LAppendOnlyStreamManifestError,
    );

    // The other direction. NOTE: this half is a REGRESSION LOCK, not a proof
    // of new behaviour — a sealed segment that is no longer on disk already
    // throws M3LAppendOnlyStreamManifestError today, so this half passes
    // against the pre-slice code. It is here because telling a tampered
    // segment from an archived one is the entire reason the integrity class
    // exists: the new digest check must not start claiming the archived case
    // too.
    const dirArchived = path.join(workDir, "archived");
    const archivedNames = await buildSealedTrail(dirArchived);
    const archived = definedOrThrow(
      archivedNames[0],
      "the first sealed segment",
    );
    await unlink(path.join(dirArchived, archived));
    const archivedOutcome = await readTrail(dirArchived);
    expect(archivedOutcome.thrown).toBeInstanceOf(
      M3LAppendOnlyStreamManifestError,
    );
    expect(archivedOutcome.thrown).not.toBeInstanceOf(
      M3LAppendOnlyStreamIntegrityError,
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — an overrun refuses MID-segment, before the appended entries are yielded
// ---------------------------------------------------------------------------

describe("P2 — a grown segment is refused before its appended entries reach the caller", () => {
  test("cumulative bytes past the sealed byte length refuse without yielding the appended entries", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const grown = definedOrThrow(names[0], "the first sealed segment");
    const seal = await sealedClaim(dir, grown);

    // The segment's own sealed bytes, plus two well-formed entries the
    // writer never wrote. Every appended entry carries a marker key (`x`)
    // no honest entry in this fixture has, so "was it yielded?" needs no
    // positional reasoning.
    await tamperSegment(dir, grown, '{"seq":0}\n{"seq":1}\n{"x":1}\n{"x":2}\n');
    const observed = await measureOnDisk(dir, grown);
    expect(observed.byteLength).toBeGreaterThan(seal.byteLength);

    const outcome = await readTrail(dir);
    const error = asIntegrityError(outcome.thrown);
    expect(integrityContext(error).sealed).toEqual(seal);

    // THE POINT OF THIS TEST. Exceeding the seal's byte length is already
    // proof, so the refusal must land before the appended entries are handed
    // over — not at the segment's end like every P1 case. A late refusal
    // would have yielded all four entries, so these two marker assertions
    // carry the contract.
    expect(outcome.entries).not.toContainEqual(
      expect.objectContaining({ x: 1 }),
    );
    expect(outcome.entries).not.toContainEqual(
      expect.objectContaining({ x: 2 }),
    );

    // Not filler, and deliberately not an exact count: this is the only
    // statement bounding how much of the tampered segment leaked before the
    // refusal, and the markers above cannot make it — they speak only about
    // the two APPENDED entries, so an implementation that refused this
    // segment yet carried on into the trail's later segments would satisfy
    // both of them and fail only this line. It stays `<=` because
    // whether the honest prefix is yielded at all depends on which read
    // chunk the overrun is caught in (P6 drives the same trail at a lower
    // chunk ceiling), and BOTH outcomes satisfy the contract — so an exact
    // figure here would pin this suite's chunking rather than the contract.
    expect(outcome.entries.length).toBeLessThanOrEqual(CLEAN_SEGMENT_ENTRIES);
  });
});

// ---------------------------------------------------------------------------
// P3 — what is never verified (rule C2 of internal/storage/append-only-verify.ts)
// ---------------------------------------------------------------------------

describe("P3 — an unclaimed segment carries no claim to check, and a claim outranks the baseline", () => {
  test("the still-active, unsealed segment is never digested, even tampered", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const active = definedOrThrow(names.at(-1), "the still-active segment");
    const records = await readManifestRecords(dir);
    // Precondition: the writer has made no claim about the active segment,
    // so there is nothing this read could compare its bytes against.
    expect(
      records.some(
        (record) => record.kind === "seal" && record.segment === active,
      ),
    ).toBe(false);

    await tamperSegment(dir, active, '{"seq":7}\n{"seq":8}\n');

    const outcome = await readTrail(dir);
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.entries).toContainEqual({ seq: 7 });
    expect(outcome.entries).toContainEqual({ seq: 8 });
  });

  test("a legacy segment — at or before the baseline AND unclaimed — is never digested, even tampered", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildBaselinedTrail(dir);
    const legacy = definedOrThrow(names[0], "the first, legacy segment");
    const baseline = definedOrThrow(
      await statedBaseline(dir),
      "the stated baseline",
    );
    const records = await readManifestRecords(dir);
    // Preconditions for "legacy": at or before the boundary AND unclaimed.
    // Both are asserted, because a fixture that satisfied only the second
    // would make this test a duplicate of the unsealed case above.
    expect(baseline.upTo).not.toBeNull();
    expect(legacy <= String(baseline.upTo)).toBe(true);
    expect(
      records.some(
        (record) => record.kind === "seal" && record.segment === legacy,
      ),
    ).toBe(false);

    await tamperSegment(dir, legacy, '{"seq":7}\n{"seq":8}\n');

    const outcome = await readTrail(dir);
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.entries).toContainEqual({ seq: 7 });
  });

  test("a SEALED segment at or before the baseline is still verified — a seal outranks the baseline", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildBaselinedTrail(dir);
    const baseline = definedOrThrow(
      await statedBaseline(dir),
      "the stated baseline",
    );
    const boundary = definedOrThrow(
      baseline.upTo ?? undefined,
      "a non-null baseline boundary",
    );
    // The fixture's load-bearing overlap: this segment is BOTH claimed by a
    // real seal AND at or before the stated boundary. Both arms are
    // reachable, so an implementation that checked the baseline FIRST and
    // skipped this segment as `legacy` fails this test — which is the whole
    // reason it exists (rule C2).
    const sealedAtBoundary = definedOrThrow(
      names.find((name) => name === boundary),
      "a segment that is both sealed and at the baseline boundary",
    );
    const seal = await sealedClaim(dir, sealedAtBoundary);

    await tamperSegment(dir, sealedAtBoundary, '{"seq":9}\n{"seq":5}\n');
    const observed = await measureOnDisk(dir, sealedAtBoundary);
    expect(observed.byteLength).toBe(seal.byteLength);
    expect(observed.entryCount).toBe(seal.entryCount);
    expect(observed.sha256).not.toBe(seal.sha256);

    const outcome = await readTrail(dir);
    const error = asIntegrityError(outcome.thrown);
    expect(integrityContext(error).sealed).toEqual(seal);
    expect(integrityContext(error).observed).toEqual(observed);
  });
});

// ---------------------------------------------------------------------------
// P4 — a clean trail reads clean (the anti-vacuity guard for everything above)
// ---------------------------------------------------------------------------

describe("P4 — an untampered trail yields every entry in order and never throws", () => {
  test("a fully sealed, multi-segment trail reads back every entry in append order", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    expect(names).toHaveLength(3);
    // The segments really are sealed at the measurements this read will
    // check — so a clean read here is a read that compared and agreed, not
    // one that had nothing to compare.
    for (const name of names.slice(0, -1)) {
      const seal = await sealedClaim(dir, name);
      expect(seal.byteLength).toBe(CLEAN_SEGMENT_BYTES);
      expect(seal.entryCount).toBe(CLEAN_SEGMENT_ENTRIES);
      expect(seal.sha256).toBe((await measureOnDisk(dir, name)).sha256);
    }

    const outcome = await readTrail(dir);
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.entries).toEqual([
      { seq: 0 },
      { seq: 1 },
      { seq: 2 },
      { seq: 3 },
      { seq: 4 },
      { seq: 5 },
    ]);
  });

  test("a clean trail carrying a baseline, legacy segments and seals on both sides of it reads clean", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildBaselinedTrail(dir);
    expect(names).toHaveLength(5);

    const outcome = await readTrail(dir);
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.entries).toEqual([
      { seq: 0 },
      { seq: 1 },
      { seq: 2 },
      { seq: 3 },
      { seq: 4 },
      { seq: 5 },
      { seq: 100 },
      { seq: 101 },
      { seq: 102 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// P5 — the documented limitation, recorded as real behaviour
// ---------------------------------------------------------------------------

describe("P5 — a mismatch is only detectable at a segment's end, and a partial read never reaches it", () => {
  test("the tampered segment's entries ARE yielded before the mismatch throws", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const tampered = definedOrThrow(names[0], "the first sealed segment");
    await tamperSegment(dir, tampered, '{"seq":9}\n{"seq":1}\n');

    const outcome = await readTrail(dir);
    expect(outcome.thrown).toBeInstanceOf(M3LAppendOnlyStreamIntegrityError);
    // This is the LIMITATION, deliberately pinned rather than filed as a
    // defect: a `sha256` disagreement cannot be known until the segment's
    // last byte has been read, and the reader streams entries as it goes, so
    // the consumer has already acted on this segment's entries by the time
    // it learns they came from bytes nobody sealed. The maintainer chose to
    // document this as a contract limit rather than buffer a whole segment
    // to close it. The refusal still lands before the NEXT segment's
    // entries, which is what keeps the damage bounded.
    expect(outcome.entries).toEqual([{ seq: 9 }, { seq: 1 }]);
    expect(outcome.entries).not.toContainEqual({ seq: 2 });
  });

  test("a consumer that abandons iteration inside a tampered segment never triggers verification", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const tampered = definedOrThrow(names[0], "the first sealed segment");
    await tamperSegment(dir, tampered, '{"seq":9}\n{"seq":1}\n');

    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: SEGMENT_CEILING_BYTES,
    });
    const received: M3LAppendOnlyEntry[] = [];
    let thrown: unknown;
    try {
      for await (const entry of stream.read()) {
        received.push(entry);
        break;
      }
    } catch (error) {
      thrown = error;
    }

    // Also the LIMITATION, not a defect: breaking out resumes the reader's
    // generator at its `finally`, which releases the handle without ever
    // finishing the digest — so a caller that reads a prefix gets no
    // integrity verdict for the segment it stopped inside. `break` is a
    // normal, successful way to stop reading, so this stays silent rather
    // than throwing.
    expect(thrown).toBeUndefined();
    expect(received).toEqual([{ seq: 9 }]);
  });
});

// ---------------------------------------------------------------------------
// P6 — a segment larger than ONE read chunk is verified over ALL of its chunks
// ---------------------------------------------------------------------------

/**
 * The read chunk size the P6 cases drive `read()` at, and the reason they
 * exist: every other case in this file reads a 20-byte segment under the
 * default `maxLineBytes` of 65,536, so the segment arrives in exactly ONE
 * chunk and "the first chunk" is indistinguishable from "every chunk". A
 * verification that digested only the opening chunk would satisfy all of
 * them while passing a large segment as whole on its first 64 KiB.
 *
 * 12 is inside the only window this suite's fixtures leave open:
 * `internal/storage/append-only-lines.ts`' `splitLines` refuses any COMPLETE
 * line whose on-disk width reaches past the ceiling, and these lines are 10
 * bytes (`{"seq":0}` plus its terminator), so the ceiling must be at least
 * 10 — and below the segment's own {@link CLEAN_SEGMENT_BYTES} to split it
 * at all. Applied to the READING stream only, so the sealed bytes stay
 * exactly what the real sealer measured.
 */
const MULTI_CHUNK_READ_CEILING = 12;

/** The chunk count `readChunks` produces for `byteLength` under that ceiling. */
function expectedChunkCount(byteLength: number): number {
  return Math.ceil(byteLength / MULTI_CHUNK_READ_CEILING);
}

describe("P6 — verification spans every chunk of a segment, not just its first", () => {
  test("a clean sealed segment read in more than one chunk still verifies clean", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const first = definedOrThrow(names[0], "the first sealed segment");
    const observed = await measureOnDisk(dir, first);

    // The PRECONDITION this whole section rests on, derived from the bytes on
    // disk and the ceiling actually passed below rather than asserted as a
    // bare constant: if a future change to the fixture width or to how
    // `readChunks` sizes its buffer collapsed this read back to one chunk,
    // this line fails loudly instead of silently re-opening the gap.
    expect(expectedChunkCount(observed.byteLength)).toBe(2);

    const outcome = await readTrail(dir, undefined, MULTI_CHUNK_READ_CEILING);
    expect(outcome.thrown).toBeUndefined();
    expect(outcome.entries).toEqual([
      { seq: 0 },
      { seq: 1 },
      { seq: 2 },
      { seq: 3 },
      { seq: 4 },
      { seq: 5 },
    ]);
  });

  test("a tamper confined to a LATER chunk is caught, and the reported measurement covers the whole segment", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const tampered = definedOrThrow(names[0], "the first sealed segment");
    const seal = await sealedClaim(dir, tampered);
    const honestBytes = await readFile(path.join(dir, tampered));

    // Byte 17 — the SECOND entry's `seq` digit — is the only byte that moves,
    // and it lands past the 12-byte opening chunk. Placement is the point: a
    // tamper in the FIRST chunk would still be seen by a verification that
    // read nothing else, so it could not tell the two apart.
    await tamperSegment(dir, tampered, '{"seq":0}\n{"seq":9}\n');
    const tamperedBytes = await readFile(path.join(dir, tampered));
    const observed = await measureOnDisk(dir, tampered);

    // Preconditions: the opening chunk is byte-identical to what the sealer
    // measured, the file as a whole is not, and it really does span two
    // chunks. Only the `sha256` moves, so neither the shrink check nor the
    // mid-read overrun check can be what fires here.
    expect(
      tamperedBytes
        .subarray(0, MULTI_CHUNK_READ_CEILING)
        .equals(honestBytes.subarray(0, MULTI_CHUNK_READ_CEILING)),
    ).toBe(true);
    expect(tamperedBytes.equals(honestBytes)).toBe(false);
    expect(expectedChunkCount(observed.byteLength)).toBe(2);
    expect(observed.byteLength).toBe(seal.byteLength);
    expect(observed.entryCount).toBe(seal.entryCount);
    expect(observed.sha256).not.toBe(seal.sha256);

    const outcome = await readTrail(dir, undefined, MULTI_CHUNK_READ_CEILING);
    const error = asIntegrityError(outcome.thrown);
    expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
    expect(integrityContext(error).sealed).toEqual(seal);
    // THE POINT OF THIS TEST. `observed` is an independent measurement of ALL
    // 20 bytes, so this line can only hold if every chunk reached the digest:
    // a measurement of the opening chunk alone would report 12 bytes, one
    // entry, and the `sha256` of a pristine prefix.
    expect(integrityContext(error).observed).toEqual(observed);
  });
});

// ---------------------------------------------------------------------------
// P7 — a MANIFEST-side forgery: a correct sha256 over counts that lie
// ---------------------------------------------------------------------------

/**
 * Rewrites ONE claimed number of `segment`'s real seal, leaving the segment's
 * bytes — and therefore the `sha256` the sealer honestly measured — exactly
 * as they were.
 *
 * The line is REPLACED rather than appended: `append-only-manifest-records.ts`
 * refuses a second seal that disagrees with the first, so appending would be
 * caught as a manifest conflict long before any byte was read, which is a
 * different contract from the one P7 is about.
 */
async function forgeSealedNumber(
  dir: string,
  segment: string,
  field: "entryCount" | "byteLength",
  value: number,
): Promise<void> {
  const records = await readManifestRecords(dir);
  const rewritten = records.map((record) =>
    record.kind === "seal" && record.segment === segment
      ? { ...record, [field]: value }
      : record,
  );
  await writeFile(
    path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME),
    `${rewritten.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

/**
 * The two forgeries a digest-only comparison would wave through. Both INFLATE
 * their number, which is deliberate: the read path's mid-segment overrun
 * check reads `seal.byteLength` directly and refuses once cumulative bytes
 * pass it, so a DEFLATED byte length is already caught by that other guard
 * and cannot distinguish a three-number comparison from a `sha256`-only one.
 * An inflated one never trips it — cumulative bytes stay under the claim —
 * and an entry count has no second consumer in either direction.
 */
const SEAL_FORGERIES = [
  { field: "entryCount", forged: 5, label: "an inflated entry count" },
  { field: "byteLength", forged: 40, label: "an inflated byte length" },
] as const;

describe("P7 — a seal whose sha256 is genuinely correct but whose counts lie is still refused", () => {
  test.each(SEAL_FORGERIES)(
    "$label on an untouched segment throws the integrity error",
    async ({ field, forged }) => {
      const dir = path.join(workDir, "audit");
      const names = await buildSealedTrail(dir);
      const target = definedOrThrow(names[0], "the first sealed segment");
      const observed = await measureOnDisk(dir, target);
      const honest = await sealedClaim(dir, target);

      // Every other case in this file tampers the BYTES, and all three
      // numbers derive from those same bytes — so any real byte change moves
      // the `sha256` too, and a comparison that checked only the `sha256`
      // would satisfy all of them. This is the input that separates the two:
      // the bytes are never touched, so the forged seal keeps a hash that is
      // correct by construction rather than by luck, and ONLY the counts
      // disagree. A realistic threat, not a contrived one — an actor who can
      // write the sidecar but not the segments inflates a claimed entry count
      // so an auditor believes a segment held records it never held.
      expect(honest.sha256).toBe(observed.sha256);
      expect(honest[field]).not.toBe(forged);

      await forgeSealedNumber(dir, target, field, forged);
      const forgedClaim = await sealedClaim(dir, target);
      expect(forgedClaim.sha256).toBe(observed.sha256);
      expect(forgedClaim[field]).toBe(forged);
      expect((await measureOnDisk(dir, target)).sha256).toBe(observed.sha256);

      const outcome = await readTrail(dir);
      const error = asIntegrityError(outcome.thrown);
      expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
      expect(integrityContext(error).sealed).toEqual(forgedClaim);
      expect(integrityContext(error).observed).toEqual(observed);
    },
  );
});

// ---------------------------------------------------------------------------
// P8 — the digest's verdict is reached BEFORE the segment's shape is judged
// ---------------------------------------------------------------------------

describe("P8 — a zero-byte file at a claimed, non-last segment name is an integrity refusal", () => {
  test("the seal's verdict outranks the mid-stream-empty refusal", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const planted = definedOrThrow(names[0], "the first sealed segment");
    const records = await readManifestRecords(dir);

    // BOTH preconditions are load-bearing, so both are asserted. An
    // UNCLAIMED segment has nothing to verify, and the LAST segment in read
    // order is allowed to be empty — either one would make this input reach
    // only one of the two refusals and stop discriminating between them.
    expect(
      records.some(
        (record) => record.kind === "seal" && record.segment === planted,
      ),
    ).toBe(true);
    expect(names.at(-1)).not.toBe(planted);
    expect(names.indexOf(planted)).toBeLessThan(names.length - 1);

    // Truncated to nothing after the seal: zero bytes, zero complete lines
    // and zero trailing carry, which is the one input that makes the
    // empty-segment refusal and the digest's refusal BOTH reachable at the
    // same moment in the same segment.
    await tamperSegment(dir, planted, "");
    const observed = await measureOnDisk(dir, planted);
    expect(observed.byteLength).toBe(0);
    expect(observed.entryCount).toBe(0);

    const outcome = await readTrail(dir);
    // Pinned on CLASS and `code`, never message text: the reversed order
    // would judge the segment's shape first and raise
    // `M3LAppendOnlyStreamReadError` / `ERR_APPEND_ONLY_STREAM_READ` for a
    // mid-stream segment holding no entries. A seal is a claim about the
    // segment's ENTIRE byte range, so once the bytes disagree with it, any
    // later judgement about the segment's shape is a judgement about bytes
    // nobody sealed — which is what makes this ordering deliberate rather
    // than incidental.
    const error = asIntegrityError(outcome.thrown);
    expect(error.code).toBe("ERR_APPEND_ONLY_STREAM_INTEGRITY");
    expect(outcome.thrown).not.toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(integrityContext(error).sealed).toEqual(
      await sealedClaim(dir, planted),
    );
    expect(integrityContext(error).observed).toEqual(observed);
    expect(outcome.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P9 — each refusal's `context` payload carries EXACTLY what it promises
// ---------------------------------------------------------------------------

/**
 * `read()` has TWO refusal points and they carry deliberately DIFFERENT
 * payloads — at a segment's end the full `observed` triple, mid-read the
 * `byteLength` alone. Every case above asserts the payload's VALUES; these
 * two assert its KEY SET, which is the only direction in which a leaked field
 * can fail a test. The distinction matters because the fields absent from the
 * mid-read payload are absent on purpose: `M3LAppendOnlyStreamIntegrityError`
 * argues in its own TSDoc that stating a `sha256` the digest never finished,
 * under the segment's name, inside an audit error, is worse than stating
 * less.
 */
describe("P9 — a refusal states no number the library did not compute", () => {
  test("the mid-read overrun reports byteLength ALONE, as a lower bound", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const grown = definedOrThrow(names[0], "the first sealed segment");
    const seal = await sealedClaim(dir, grown);

    // The same tamper P2 uses — the segment's own sealed bytes plus two
    // marker entries the writer never wrote. Load-bearing here because it is
    // what makes the refusal the MID-READ one: the cumulative count passes
    // the claim before the segment's last byte, so the digest is abandoned
    // and `finish()` is never reached.
    await tamperSegment(dir, grown, '{"seq":0}\n{"seq":1}\n{"x":1}\n{"x":2}\n');
    const onDisk = await measureOnDisk(dir, grown);
    expect(onDisk.byteLength).toBeGreaterThan(seal.byteLength);

    const outcome = await readTrail(dir);
    const error = asIntegrityError(outcome.thrown);
    // Confirms the refusal really was the mid-read one and not the
    // end-of-segment comparison, without pinning message text.
    expect(outcome.entries).not.toContainEqual(
      expect.objectContaining({ x: 1 }),
    );

    const observed = integrityContext(error).observed;

    // THE POINT OF THIS TEST, and an EXACT key set on purpose. This payload
    // is deliberately NARROWER than the end-of-segment one every P1/P3/P6/P7
    // case pins: the digest was abandoned mid-segment, so no `sha256` over
    // this segment was ever finished and the entries counted so far are a
    // prefix's, not the segment's. A future reader must therefore NOT
    // "complete" this payload — an added `sha256` or `entryCount` would put a
    // figure the library never computed inside an audit error under the
    // segment's name, which is the exact leak the error class's TSDoc argues
    // against, and this line is what fails when one appears.
    expect(ownKeysOf(observed, "the overrun `observed` payload")).toEqual([
      "byteLength",
    ]);
    // The pair itself, for the same reason: the claim and the partial
    // measurement, and no third field.
    expect(
      ownKeysOf(
        definedOrThrow(error.context, "the integrity error context"),
        "the overrun `context`",
      ),
    ).toEqual(["observed", "sealed"]);

    // A LOWER BOUND, stated as a relationship rather than a magic number so
    // a chunking change cannot invalidate it: the figure must EXCEED the
    // seal's claim, since crossing the claim is the whole reason the refusal
    // fired; and it need not REACH the file's real size, since the read
    // stopped on the crossing chunk. A `>=` against the claim would also
    // pass for a figure that had not yet crossed it.
    const reported = ownNumberOf(
      observed,
      "byteLength",
      "the overrun `observed` payload",
    );
    expect(Number.isInteger(reported)).toBe(true);
    expect(reported).toBeGreaterThan(seal.byteLength);
    expect(reported).toBeLessThanOrEqual(onDisk.byteLength);
  });

  test("the end-of-segment mismatch reports exactly the three sealed numbers", async () => {
    const dir = path.join(workDir, "audit");
    const names = await buildSealedTrail(dir);
    const tampered = definedOrThrow(names[0], "the first sealed segment");
    const seal = await sealedClaim(dir, tampered);

    // A same-length, same-entry-count rewrite, so only the `sha256` moves
    // and the mid-read overrun check cannot be what fires: this refusal is
    // reached at the segment's END, where the full triple exists.
    await tamperSegment(dir, tampered, '{"seq":4}\n{"seq":5}\n');
    const onDisk = await measureOnDisk(dir, tampered);
    expect(onDisk.byteLength).toBe(seal.byteLength);
    expect(onDisk.entryCount).toBe(seal.entryCount);
    expect(onDisk.sha256).not.toBe(seal.sha256);

    const outcome = await readTrail(dir);
    const error = asIntegrityError(outcome.thrown);

    // The companion to the case above, and not a duplicate of P1's
    // `toEqual(observed)`: that compares VALUES, so it fails on an added
    // field only when the field carries a defined value — `toEqual` treats a
    // present-but-`undefined` key as absent. This states the key set itself,
    // which an added field fails either way. Exactly the three numbers a
    // seal records, because at this refusal point all three really have been
    // measured.
    expect(
      ownKeysOf(
        integrityContext(error).observed,
        "the end-of-segment `observed` payload",
      ),
    ).toEqual(["byteLength", "entryCount", "sha256"]);
    expect(
      ownKeysOf(
        definedOrThrow(error.context, "the integrity error context"),
        "the end-of-segment `context`",
      ),
    ).toEqual(["observed", "sealed"]);
  });
});
