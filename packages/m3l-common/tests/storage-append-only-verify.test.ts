/**
 * Tests for `internal/storage/append-only-verify` — the append-only stream's
 * bounded audit-trail verification (ADR-0102, X8b slice 5): re-digesting
 * every segment a directory's `manifest.jsonl` sidecar makes a claim about,
 * and classifying every segment — claimed or not — into one of five
 * verdicts, oldest first, never throwing on a damaged trail.
 *
 * This is a new sibling file, not an extension of
 * `storage-append-only-manifest.test.ts`: that suite owns the manifest's
 * bounded guarded READ and APPEND. This one owns the classification built ON
 * TOP of a read manifest — the precedence between a seal and a baseline, the
 * ordering of the report, the boundary and its `unprovenBefore` signal, and
 * the failure-vs-verdict partition. `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings — this one
 * included — as unmatched by design, the same rule the manifest suite's own
 * header states.
 *
 * Every fixture here is real bytes on a real filesystem: a real segment
 * file, a real hand-written `manifest.jsonl`, a real symlink planted at a
 * segment's name, and a real `sha256`/`entryCount`/`byteLength` computed
 * INDEPENDENTLY with `node:crypto` and a byte-level newline count — never by
 * calling the library's own `digestSegmentFile` and comparing it to the
 * library's own verification, which would make the comparison vacuous. A
 * sealed-then-tampered segment is built by writing the segment, computing
 * and writing its TRUE seal, and only then appending or altering bytes, so
 * the claim on disk really was genuine at the moment it was written. A real
 * per-test `mkdtemp` sandbox is used throughout (ADR-0100).
 *
 * TWO calls are wrapped, each only in its own dedicated describe block:
 * `readdir` (`"the directory cannot be listed"`) and `lstat`
 * (`"a claimed segment's presence cannot be determined"`), both as an inert
 * pass-through unless armed, in exactly the shape
 * `storage-append-only-manifest.test.ts` already established for the one
 * fault real bytes cannot stage — a stripped-permission directory is a
 * no-op for root and would make the test silently vacuous. Every other test
 * in this file drives the genuine `node:fs/promises`.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { appendFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
import { M3L_APPEND_ONLY_MANIFEST_NAME } from "../src/core/storage/append-only-manifest-types.js";
import type {
  M3LAppendOnlySegmentVerdict,
  M3LAppendOnlyVerification,
  M3LAppendOnlyVerificationFailure,
  M3LAppendOnlyVerificationStatus,
} from "../src/core/storage/append-only-verify-types.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";
import { MANIFEST_FORMAT_VERSION } from "../src/internal/storage/append-only-manifest.js";
// The module under test does not exist yet — this import is expected to fail
// module resolution until `code-implementer` writes it against this same
// contract. That failure IS the RED result this suite is meant to produce.
import type { AppendOnlyVerifyOptions } from "../src/internal/storage/append-only-verify.js";
import { verifyAppendOnlySegments } from "../src/internal/storage/append-only-verify.js";

// ---------------------------------------------------------------------------
// The one injected fault — mirrors storage-append-only-manifest.test.ts
// ---------------------------------------------------------------------------

/**
 * The armed state of the `readdir`/`lstat` wrappers below. `undefined` in
 * both fields — the state every test both starts and ends in — makes each
 * one a pure pass-through. `lstatFault` is keyed to one exact path so
 * arming it for one claimed segment never touches a sibling segment or the
 * manifest file itself.
 */
const faults = vi.hoisted(() => ({
  listingError: undefined as Error | undefined,
  lstatFault: undefined as { path: string; error: Error } | undefined,
}));

/**
 * `readdir` and `lstat`, and nothing else: every other export (`mkdtemp`,
 * `writeFile`, `appendFile`, `symlink`, `rm`, and the `open`/`read` the
 * module under test runs) stays the genuine article. Unarmed, both wrappers
 * forward to the real implementation.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  // The single-argument overload is the only one anything here calls.
  const realReaddir: (directory: string) => Promise<string[]> = actual.readdir;
  const readdir = async (directory: string): Promise<string[]> => {
    const { listingError } = faults;
    if (listingError !== undefined) {
      throw listingError;
    }
    return await realReaddir(directory);
  };
  const realLstat: (segmentPath: string) => Promise<Stats> = actual.lstat;
  const lstat = async (segmentPath: string): Promise<Stats> => {
    const { lstatFault } = faults;
    if (lstatFault !== undefined && lstatFault.path === segmentPath) {
      throw lstatFault.error;
    }
    return await realLstat(segmentPath);
  };
  return { ...actual, readdir, lstat };
});

/**
 * Arms the directory-listing failure for the remainder of the current test
 * and returns the error `readdir` rejects with, so the test can assert the
 * module chained THAT error rather than merely some error.
 */
function armListingFailure(): Error {
  const listingError = new Error("simulated EACCES on readdir");
  faults.listingError = listingError;
  return listingError;
}

/**
 * Arms an `lstat` failure for exactly one segment's path within the
 * sandbox — every sibling segment and the manifest file stay on the real
 * `lstat` — and returns the error so a test can assert it was chained as
 * `cause`. `code` lets a test pick ENOENT (genuine absence) or anything
 * else (presence could not be determined at all).
 */
function armPresenceCheckFailure(segment: string, code: string): Error {
  const lstatError = Object.assign(new Error(`simulated ${code} on lstat`), {
    code,
  });
  faults.lstatFault = { path: path.join(sandbox, segment), error: lstatError };
  return lstatError;
}

afterEach(() => {
  faults.listingError = undefined;
  faults.lstatFault = undefined;
});

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "m3l-append-only-verify-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** A generous ceiling for every call that is not itself about the ceiling. */
const AMPLE_MAX_DIGEST_BYTES = 1_048_576;
const AMPLE_MAX_MANIFEST_BYTES = 1_048_576;

/** A segment name most single-segment tests reuse. */
const SEG = "2026-09-01-0001.jsonl";

interface Measurement {
  readonly entryCount: number;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * Independently measures `buffer`: a newline-BYTE count (not decoded lines),
 * the raw byte length, and a plain `sha256` — computed here directly with
 * `node:crypto`, never by calling the library's own `digestSegmentFile`. A
 * fixture's expectation and the module's own computation must never share
 * one source, or the comparison proves nothing.
 */
function measureBytes(buffer: Buffer): Measurement {
  let entryCount = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) {
      entryCount += 1;
    }
  }
  return {
    entryCount,
    byteLength: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

/** Writes real bytes as a segment file and returns the buffer written. */
async function writeSegment(name: string, content: string): Promise<Buffer> {
  const buffer = Buffer.from(content, "utf8");
  await writeFile(path.join(sandbox, name), buffer);
  return buffer;
}

/**
 * Appends real bytes to an already-sealed segment — the tamper step, called
 * only AFTER the true seal has been computed and written, so the claim on
 * disk was genuine and only the segment moved afterwards.
 */
async function appendToSegment(name: string, extra: string): Promise<void> {
  await appendFile(path.join(sandbox, name), extra, { encoding: "utf8" });
}

function manifestFilePath(): string {
  return path.join(sandbox, M3L_APPEND_ONLY_MANIFEST_NAME);
}

async function writeManifestBytes(content: string): Promise<void> {
  await writeFile(manifestFilePath(), content);
}

async function appendManifestBytes(content: string): Promise<void> {
  await appendFile(manifestFilePath(), content, { encoding: "utf8" });
}

/** One `baseline` line, terminator included. */
function baselineLine(
  upTo: string | null,
  at = "2026-09-11T00:00:00.000Z",
): string {
  return `${JSON.stringify({
    kind: "baseline",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at,
    upTo,
  })}\n`;
}

/** One `seal` line, terminator included, stating exactly `measurement`. */
function sealLine(
  segment: string,
  measurement: Measurement,
  at = "2026-09-11T01:00:00.000Z",
): string {
  return `${JSON.stringify({
    kind: "seal",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at,
    segment,
    ...measurement,
  })}\n`;
}

/** A syntactically arbitrary measurement, for an archived claim's fixture. */
function arbitraryMeasurement(sha256Fill: string): Measurement {
  return { entryCount: 2, byteLength: 8, sha256: sha256Fill.repeat(64) };
}

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
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

interface RecordedFailure {
  readonly message: string;
  readonly cause: unknown;
  readonly context: Readonly<Record<string, unknown>>;
  readonly error: M3LError;
}

interface RecordingFailurePort {
  readonly build: AppendOnlyReadFailure;
  readonly calls: RecordedFailure[];
}

/**
 * A real failure port, not a mock of the behaviour under test: it builds a
 * genuine `M3LError` the way an owner would, tagging its `code` with `label`
 * so a test can tell WHICH of the two ports (`buildManifestError` vs
 * `buildSegmentError`) the module under test actually reached for.
 */
function createFailurePort(label: string): RecordingFailurePort {
  const calls: RecordedFailure[] = [];
  const build: AppendOnlyReadFailure = (message, options) => {
    const context: Record<string, unknown> = { ...options?.context };
    const error = new M3LError(message, {
      code: `ERR_TEST_APPEND_ONLY_VERIFY_${label}`,
      cause: options?.cause,
      context,
    });
    calls.push({ message, cause: options?.cause, context, error });
    return error;
  };
  return { build, calls };
}

interface VerifyHarness {
  readonly options: AppendOnlyVerifyOptions;
  readonly manifestPort: RecordingFailurePort;
  readonly segmentPort: RecordingFailurePort;
}

/**
 * Builds one call's options, defaulting to the current sandbox and generous
 * ceilings, with two independent recording ports so a test can assert not
 * just THAT a failure was raised but THROUGH WHICH vocabulary.
 */
function harness(
  overrides: Partial<AppendOnlyVerifyOptions> = {},
): VerifyHarness {
  const manifestPort = createFailurePort("MANIFEST");
  const segmentPort = createFailurePort("SEGMENT");
  return {
    options: {
      directory: sandbox,
      maxDigestBytes: AMPLE_MAX_DIGEST_BYTES,
      maxManifestBytes: AMPLE_MAX_MANIFEST_BYTES,
      buildManifestError: manifestPort.build,
      buildSegmentError: segmentPort.build,
      ...overrides,
    },
    manifestPort,
    segmentPort,
  };
}

// ---------------------------------------------------------------------------
// C2 — classification
// ---------------------------------------------------------------------------

describe("C2 classification", () => {
  test("an untouched sealed segment classifies sealed, with sealed and observed agreeing on all three fields", async () => {
    const buffer = await writeSegment(SEG, '{"a":1}\n{"b":2}\n');
    const measurement = measureBytes(buffer);
    await writeManifestBytes(sealLine(SEG, measurement));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(result.verdicts).toHaveLength(1);
    const verdict = definedOrThrow(result.verdicts[0], "the verdict");
    expect(verdict.segment).toBe(SEG);
    if (verdict.status !== "sealed") {
      throw new Error(`expected status "sealed", got "${verdict.status}"`);
    }
    expect(verdict.sealed).toMatchObject(measurement);
    expect(verdict.observed).toEqual(measurement);
    expect(result.failures).toEqual([]);
  });

  test("a sealed segment tampered with after sealing classifies mismatched, and observed reports the exact drifted numbers", async () => {
    const buffer = await writeSegment(SEG, '{"a":1}\n{"b":2}\n');
    const trueMeasurement = measureBytes(buffer);
    await writeManifestBytes(sealLine(SEG, trueMeasurement));
    // Tamper AFTER the true seal is written, and with bytes carrying NO
    // terminating newline — entryCount is therefore untouched while
    // byteLength and sha256 both move. A test that only checked
    // `status === "mismatched"` could not tell a garbage `observed` from a
    // correct one; this one pins which of the three fields moved.
    await appendToSegment(SEG, "TAMPERED");
    const tamperedBuffer = Buffer.concat([buffer, Buffer.from("TAMPERED")]);
    const observedMeasurement = measureBytes(tamperedBuffer);
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    const verdict = definedOrThrow(result.verdicts[0], "the verdict");
    if (verdict.status !== "mismatched") {
      throw new Error(`expected status "mismatched", got "${verdict.status}"`);
    }
    expect(verdict.sealed).toMatchObject(trueMeasurement);
    expect(verdict.observed).toEqual(observedMeasurement);
    expect(verdict.observed.entryCount).toBe(trueMeasurement.entryCount);
    expect(verdict.observed.byteLength).not.toBe(trueMeasurement.byteLength);
    expect(verdict.observed.sha256).not.toBe(trueMeasurement.sha256);
  });

  test("a sealed segment absent from disk classifies archived, carrying the full claim including sha256, with observed undefined", async () => {
    const measurement = arbitraryMeasurement("a");
    await writeManifestBytes(sealLine(SEG, measurement));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    const verdict = definedOrThrow(result.verdicts[0], "the verdict");
    if (verdict.status !== "archived") {
      throw new Error(`expected status "archived", got "${verdict.status}"`);
    }
    expect(verdict.sealed).toMatchObject(measurement);
    // `sha256` explicitly, not just "the claim": this is the field that lets
    // an operator holding an archive copy run `sha256sum` against it — the
    // whole point of `archived` carrying the full claim.
    expect(verdict.sealed.sha256).toBe(measurement.sha256);
    // The `"archived"` arm carries no `observed` field at all — never
    // digested — so absence is an own-key check, not a `.toBeUndefined()`
    // read the type no longer permits.
    expect(Object.hasOwn(verdict, "observed")).toBe(false);
  });

  test("an on-disk segment with no seal and no baseline classifies unsealed, with sealed and observed both undefined", async () => {
    await writeSegment(SEG, "{}\n");
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    const verdict = definedOrThrow(result.verdicts[0], "the verdict");
    if (verdict.status !== "unsealed") {
      throw new Error(`expected status "unsealed", got "${verdict.status}"`);
    }
    // The `"unsealed"` arm carries neither field at all — own-key checks,
    // not `.toBeUndefined()` reads the type no longer permits.
    expect(Object.hasOwn(verdict, "sealed")).toBe(false);
    expect(Object.hasOwn(verdict, "observed")).toBe(false);
  });

  test("a segment at or before the baseline boundary, with no seal, classifies legacy and is never digested", async () => {
    const legacySegment = "2026-08-01-0001.jsonl";
    await writeSegment(legacySegment, "{}\n");
    await writeManifestBytes(baselineLine(legacySegment));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    const verdict = definedOrThrow(result.verdicts[0], "the verdict");
    expect(verdict.segment).toBe(legacySegment);
    if (verdict.status !== "legacy") {
      throw new Error(`expected status "legacy", got "${verdict.status}"`);
    }
    // The `"legacy"` arm carries neither field at all — own-key checks, not
    // `.toBeUndefined()` reads the type no longer permits.
    expect(Object.hasOwn(verdict, "sealed")).toBe(false);
    expect(Object.hasOwn(verdict, "observed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C2 precedence — the security pin
// ---------------------------------------------------------------------------

describe("C2 precedence — a seal outranks a later baseline", () => {
  test("[security] a genuinely sealed-then-tampered segment still reports mismatched after a later, well-formed baseline names it — never legacy", async () => {
    // Defends the exact attack `append-only-manifest-types.ts` documents:
    // the manifest reader lets a later `baseline` record simply replace an
    // earlier one, and refuses only a non-segment-shaped `upTo` or one dated
    // later than today. Anyone with write access to the directory can
    // therefore append ONE well-formed, present-dated `baseline` line naming
    // the tampered segment (or a later one) — exactly what this fixture
    // does. An implementation that checks the baseline boundary BEFORE
    // checking for a seal would reclassify this genuinely-tampered segment
    // `legacy` and never digest it again: a tamper detector one appended
    // line can switch off has detected nothing.
    const buffer = await writeSegment(SEG, '{"a":1}\n');
    const trueMeasurement = measureBytes(buffer);
    await writeManifestBytes(
      sealLine(SEG, trueMeasurement, "2026-09-11T01:00:00.000Z"),
    );
    await appendToSegment(SEG, "X");
    // The attacker's move, staged as a genuinely separate, later append.
    await appendManifestBytes(baselineLine(SEG, "2026-09-11T02:00:00.000Z"));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    const verdict = definedOrThrow(result.verdicts[0], "the verdict");
    expect(verdict.status).toBe("mismatched");
  });
});

// ---------------------------------------------------------------------------
// C3 — ordering
// ---------------------------------------------------------------------------

describe("C3 ordering", () => {
  test("orders verdicts oldest (datePrefix, sequence) first, defeating a raw lexicographic sort at the 4-to-5-digit sequence boundary", async () => {
    const older = "2026-08-31-0001.jsonl";
    const boundaryLow = "2026-09-01-9999.jsonl"; // sequence 9999
    const boundaryHigh = "2026-09-01-10000.jsonl"; // sequence 10000
    // Verified independently before settling on this fixture: a raw
    // `Array.prototype.sort()` of these three NAMES puts `boundaryHigh`
    // BEFORE `boundaryLow` ('1' < '9' as the first differing character),
    // even though 9999 < 10000 numerically — exactly the ordering
    // `segmentOrderKey`'s wide zero-padding exists to reject.
    expect([boundaryHigh, older, boundaryLow].sort()).not.toEqual([
      older,
      boundaryLow,
      boundaryHigh,
    ]);
    await writeSegment(boundaryHigh, "{}\n");
    await writeSegment(older, "{}\n");
    await writeSegment(boundaryLow, "{}\n");
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(
      result.verdicts.map(
        (verdict: M3LAppendOnlySegmentVerdict) => verdict.segment,
      ),
    ).toEqual([older, boundaryLow, boundaryHigh]);
  });

  test("interleaves an archived (sealed-but-not-on-disk) segment into its correct chronological slot rather than appending it at the end", async () => {
    const before = "2026-09-01-0001.jsonl";
    const archived = "2026-09-02-0001.jsonl";
    const after = "2026-09-03-0001.jsonl";
    await writeSegment(before, "{}\n");
    await writeSegment(after, "{}\n");
    await writeManifestBytes(sealLine(archived, arbitraryMeasurement("c")));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(
      result.verdicts.map(
        (verdict: M3LAppendOnlySegmentVerdict) => verdict.segment,
      ),
    ).toEqual([before, archived, after]);
    expect(result.verdicts[1]?.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// C4 — the boundary / unprovenBefore
// ---------------------------------------------------------------------------

describe("C4 boundary / unprovenBefore", () => {
  test("a baseline naming a segment reports that exact name as unprovenBefore", async () => {
    const boundarySegment = "2026-08-01-0001.jsonl";
    await writeManifestBytes(baselineLine(boundarySegment));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(result.unprovenBefore).toBe(boundarySegment);
  });

  test("a baseline asserting upTo: null reports unprovenBefore as null, not undefined", async () => {
    await writeManifestBytes(baselineLine(null));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    // `toBeNull()` alone is the whole guarantee here: it already excludes
    // `undefined`, which is what keeps the three values `unprovenBefore` can
    // take — a segment name, `null` (a positive assertion), and `undefined`
    // (silence about whether one was ever stated at all) — from collapsing
    // into one another.
    expect(result.unprovenBefore).toBeNull();
  });

  test("no manifest at all reports unprovenBefore as undefined and classifies every on-disk segment unsealed — the manifest-deletion signal ADR-0102 relies on", async () => {
    await writeSegment(SEG, "{}\n");
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(result.unprovenBefore).toBeUndefined();
    expect(
      result.verdicts.every(
        (verdict: M3LAppendOnlySegmentVerdict) => verdict.status === "unsealed",
      ),
    ).toBe(true);
    // Paired with the C5 rule below: an ABSENT manifest is not a failure.
    expect(result.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C5 — failure routing
// ---------------------------------------------------------------------------

describe("C5 failure routing", () => {
  test("a malformed line in the MIDDLE of the manifest reports one failure and NO verdicts, even though segments are on disk", async () => {
    const segmentA = "2026-09-01-0001.jsonl";
    const segmentB = "2026-09-01-0002.jsonl";
    await writeSegment(segmentA, "{}\n");
    await writeSegment(segmentB, "{}\n");
    await writeManifestBytes(
      `${sealLine(segmentA, arbitraryMeasurement("d"))}not-json-at-all\n${sealLine(segmentB, arbitraryMeasurement("e"))}`,
    );
    const { options, manifestPort } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.segment).toBeUndefined();
    // The clause this defends: "the claims could not be read" must never be
    // reported as "no claim exists". An implementation that swallowed the
    // manifest failure and fell back to `unsealed` for every on-disk segment
    // would pass a bare `failures.length === 1` check but fail this one.
    expect(result.verdicts).toEqual([]);
    expect(manifestPort.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("a sealed segment replaced by a symlink reports one failure carrying that segment's name, and the OTHER segments still receive their verdicts", async () => {
    const readableSegment = "2026-09-01-0001.jsonl";
    const symlinkedSegment = "2026-09-01-0002.jsonl";
    const readableBuffer = await writeSegment(readableSegment, "{}\n");
    const readableMeasurement = measureBytes(readableBuffer);
    await symlink(
      path.join(sandbox, "nowhere-in-particular"),
      path.join(sandbox, symlinkedSegment),
    );
    await writeManifestBytes(
      `${sealLine(readableSegment, readableMeasurement)}${sealLine(symlinkedSegment, arbitraryMeasurement("f"))}`,
    );
    const { options, segmentPort } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.segment).toBe(symlinkedSegment);
    // The other segment in the same directory is unaffected: one unreadable
    // segment must not abandon the rest.
    expect(
      result.verdicts.map(
        (verdict: M3LAppendOnlySegmentVerdict) => verdict.segment,
      ),
    ).toEqual([readableSegment]);
    expect(result.verdicts[0]?.status).toBe("sealed");
    expect(segmentPort.calls.length).toBeGreaterThanOrEqual(1);
    // The raw filesystem detail (the real ELOOP-shaped rejection) is the
    // only diagnostic an operator has for why this segment could not be
    // read; dropping it would leave them nothing beyond a generic message.
    expect(result.failures[0]?.error.cause).toBeDefined();
  });

  describe("the directory cannot be listed", () => {
    test("one failure with segment undefined, empty verdicts, and the raw readdir error chained as cause", async () => {
      // Distinguishes this path from an ABSENT directory (see the C1
      // "does not exist at all" test below): here the directory exists and
      // holds a segment, but listing it fails for a reason other than
      // ENOENT, which `listSegmentFiles` does not treat as absence either.
      await writeSegment(SEG, "{}\n");
      const listingError = armListingFailure();
      const { options, manifestPort } = harness();

      const result = await verifyAppendOnlySegments(options);

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.segment).toBeUndefined();
      expect(result.verdicts).toEqual([]);
      expect(result.failures[0]?.error.cause).toBe(listingError);
      expect(manifestPort.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("a claimed segment's presence cannot be determined", () => {
    test('a non-ENOENT lstat failure on a claimed segment produces a failure, never an "archived" verdict', async () => {
      const healthySegment = "2026-09-01-0001.jsonl";
      const undeterminedSegment = "2026-09-01-0002.jsonl";
      const healthyBuffer = await writeSegment(healthySegment, "{}\n");
      const healthyMeasurement = measureBytes(healthyBuffer);
      // `undeterminedSegment` is claimed but deliberately never written to
      // disk: `listSegmentFiles` also `lstat`s every candidate NAME its own
      // `readdir` returns, and this suite's one global `lstat` mock is keyed
      // by path, not by caller — a physically-present file at this path
      // would make the DIRECTORY-LISTING pass hit the same armed failure
      // first and fail the whole run through `buildManifestError`, never
      // reaching the per-segment check this test exists to exercise.
      await writeManifestBytes(
        `${sealLine(healthySegment, healthyMeasurement)}${sealLine(undeterminedSegment, arbitraryMeasurement("c"))}`,
      );
      const lstatError = armPresenceCheckFailure(undeterminedSegment, "EACCES");
      const { options, segmentPort } = harness();

      const result = await verifyAppendOnlySegments(options);

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.segment).toBe(undeterminedSegment);
      expect(result.failures[0]?.error.cause).toBe(lstatError);
      // The assertion this branch exists for: "could not be determined"
      // must never be reported as an honest "archived" deletion. An
      // implementation that treated any lstat failure as absence would
      // report `undeterminedSegment` as archived here and fail this line.
      expect(
        result.verdicts.some(
          (verdict: M3LAppendOnlySegmentVerdict) =>
            verdict.status === "archived",
        ),
      ).toBe(false);
      // Verdicts and failures partition the claimed segments: the
      // undetermined segment gets no verdict at all.
      expect(
        result.verdicts.some(
          (verdict: M3LAppendOnlySegmentVerdict) =>
            verdict.segment === undeterminedSegment,
        ),
      ).toBe(false);
      expect(segmentPort.calls.length).toBeGreaterThanOrEqual(1);
    });

    test("a sibling claimed segment in the same directory is still classified when the other's lstat fails", async () => {
      const healthySegment = "2026-09-01-0004.jsonl";
      const undeterminedSegment = "2026-09-01-0005.jsonl";
      const healthyBuffer = await writeSegment(healthySegment, "{}\n");
      const healthyMeasurement = measureBytes(healthyBuffer);
      // Not written to disk — see the comment in the test above for why.
      await writeManifestBytes(
        `${sealLine(healthySegment, healthyMeasurement)}${sealLine(undeterminedSegment, arbitraryMeasurement("d"))}`,
      );
      armPresenceCheckFailure(undeterminedSegment, "EACCES");
      const { options } = harness();

      const result = await verifyAppendOnlySegments(options);

      // One undeterminable segment must not abandon the rest — the same
      // property the symlink test above pins for the digest path, now
      // pinned for the presence-check path.
      expect(
        result.verdicts.map(
          (verdict: M3LAppendOnlySegmentVerdict) => verdict.segment,
        ),
      ).toEqual([healthySegment]);
      expect(result.verdicts[0]?.status).toBe("sealed");
    });

    test("an lstat failure whose code is ENOENT still classifies archived, carrying the full claim, through the same armed wrapper", async () => {
      // Differs from the two tests above ONLY in the thrown error's `code`.
      // This is what makes the "never archived" assertion above falsifiable
      // rather than merely passing: an implementation that folded every
      // lstat failure onto ONE behaviour (either always "archived", or
      // always a failure) would fail this test or the one above, whichever
      // way it chose.
      const archivedSegment = "2026-09-01-0006.jsonl";
      // Written to disk on purpose (unlike the two tests above): an ENOENT
      // from the armed `lstat` is treated leniently everywhere it can be
      // seen — `listSegmentFiles`'s own per-entry `lstat` skips it as a
      // benign listing/lstat race and continues, so the mock's ENOENT here
      // still governs the final verdict rather than aborting the run,
      // proving classification trusts lstat's reported error CODE rather
      // than some independent existence check.
      await writeSegment(archivedSegment, "{}\n");
      const measurement = arbitraryMeasurement("f");
      await writeManifestBytes(sealLine(archivedSegment, measurement));
      armPresenceCheckFailure(archivedSegment, "ENOENT");
      const { options } = harness();

      const result = await verifyAppendOnlySegments(options);

      expect(result.failures).toEqual([]);
      const verdict = definedOrThrow(result.verdicts[0], "the verdict");
      if (verdict.status !== "archived") {
        throw new Error(`expected status "archived", got "${verdict.status}"`);
      }
      expect(verdict.sealed).toMatchObject(measurement);
      expect(Object.hasOwn(verdict, "observed")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// C1 — never throws
// ---------------------------------------------------------------------------

describe("C1 never-throws", () => {
  test("resolves — never rejects — for a directory that does not exist at all, with empty verdicts and empty failures", async () => {
    // `expect(fn).not.toThrow()` on an async function would leave a rejected
    // promise unhandled without proving anything; `.resolves` fails loudly
    // if the promise rejects instead.
    const missingDirectory = path.join(sandbox, "does-not-exist");
    const { options } = harness({ directory: missingDirectory });

    await expect(verifyAppendOnlySegments(options)).resolves.toEqual(
      expect.objectContaining({ verdicts: [], failures: [] }),
    );
  });
});

// ---------------------------------------------------------------------------
// C1 — misuse still throws, and throws BEFORE anything is opened
// ---------------------------------------------------------------------------

describe("C1 misuse still throws, before anything is opened", () => {
  const invalidCeilings = [0, -1, 1.5] as const;

  test.each(invalidCeilings)(
    "rejects a maxDigestBytes of %s, through buildManifestError, before the directory is opened",
    async (invalidCeiling) => {
      // Driven against a directory that does not exist: a successful
      // rejection here cannot have come from I/O, only from the ceiling
      // check itself running first.
      const missingDirectory = path.join(sandbox, "does-not-exist");
      const { options, manifestPort, segmentPort } = harness({
        directory: missingDirectory,
        maxDigestBytes: invalidCeiling,
      });

      const thrown = await catchRejected(() =>
        verifyAppendOnlySegments(options),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      // Refused through the caller's OWN vocabulary, per the contract, and
      // specifically the manifest port — a non-ceiling is misuse of the
      // whole call, not a per-segment finding.
      expect(manifestPort.calls.length).toBeGreaterThanOrEqual(1);
      expect(segmentPort.calls).toHaveLength(0);
    },
  );

  test.each(invalidCeilings)(
    "rejects a maxManifestBytes of %s, through buildManifestError, before the directory is opened",
    async (invalidCeiling) => {
      const missingDirectory = path.join(sandbox, "does-not-exist");
      const { options, manifestPort, segmentPort } = harness({
        directory: missingDirectory,
        maxManifestBytes: invalidCeiling,
      });

      const thrown = await catchRejected(() =>
        verifyAppendOnlySegments(options),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      expect(manifestPort.calls.length).toBeGreaterThanOrEqual(1);
      expect(segmentPort.calls).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// C5/C6 invariants — totals and the verdicts/failures partition
// ---------------------------------------------------------------------------

describe("C5/C6 invariants", () => {
  test("totals match the actual per-status counts in verdicts, and every considered segment appears in verdicts or failures — never both, never neither", async () => {
    const sealedSeg = "2026-09-05-0001.jsonl";
    const mismatchedSeg = "2026-09-05-0002.jsonl";
    const archivedSeg = "2026-09-04-0001.jsonl";
    const unsealedSeg = "2026-09-06-0001.jsonl";
    const legacySeg = "2026-09-01-0001.jsonl";
    const failureSeg = "2026-09-05-0003.jsonl";

    const sealedBuffer = await writeSegment(sealedSeg, "{}\n");
    const sealedMeasurement = measureBytes(sealedBuffer);
    const mismatchedBuffer = await writeSegment(mismatchedSeg, "{}\n");
    const trueMismatchedMeasurement = measureBytes(mismatchedBuffer);
    await appendToSegment(mismatchedSeg, "X");
    await writeSegment(unsealedSeg, "{}\n");
    await writeSegment(legacySeg, "{}\n");
    await symlink(
      path.join(sandbox, "nowhere"),
      path.join(sandbox, failureSeg),
    );

    await writeManifestBytes(
      `${baselineLine(legacySeg)}${sealLine(sealedSeg, sealedMeasurement)}${sealLine(mismatchedSeg, trueMismatchedMeasurement)}${sealLine(archivedSeg, arbitraryMeasurement("9"))}${sealLine(failureSeg, arbitraryMeasurement("8"))}`,
    );
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    const actualTotals: Record<M3LAppendOnlyVerificationStatus, number> = {
      sealed: 0,
      unsealed: 0,
      archived: 0,
      mismatched: 0,
      legacy: 0,
    };
    for (const verdict of result.verdicts) {
      const status: M3LAppendOnlyVerificationStatus = verdict.status;
      actualTotals[status] += 1;
    }
    expect(result.totals).toEqual(actualTotals);

    const consideredNames = [
      sealedSeg,
      mismatchedSeg,
      archivedSeg,
      unsealedSeg,
      legacySeg,
      failureSeg,
    ];
    const verdictNames = new Set(
      result.verdicts.map(
        (verdict: M3LAppendOnlySegmentVerdict) => verdict.segment,
      ),
    );
    const failureSegments: (string | undefined)[] = result.failures.map(
      (failure: M3LAppendOnlyVerificationFailure) => failure.segment,
    );
    const failureNames = new Set(
      failureSegments.filter((name): name is string => name !== undefined),
    );
    for (const name of consideredNames) {
      const inVerdicts = verdictNames.has(name);
      const inFailures = failureNames.has(name);
      expect(inVerdicts).not.toBe(inFailures);
    }
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.segment).toBe(failureSeg);
  });
});

// ---------------------------------------------------------------------------
// C7 — the skipped inventory
// ---------------------------------------------------------------------------

describe("C7 skipped inventory", () => {
  test("a planted link at an UNCLAIMED segment name raises skipped, appearing in neither verdicts nor failures, while the healthy segment still verifies sealed", async () => {
    const healthySegment = "2026-09-01-0001.jsonl";
    const plantedLinkName = "2026-09-02-0001.jsonl";
    const healthyBuffer = await writeSegment(healthySegment, "{}\n");
    const healthyMeasurement = measureBytes(healthyBuffer);
    await writeManifestBytes(sealLine(healthySegment, healthyMeasurement));
    // A symlink at a segment-shaped name this writer never sealed and never
    // claimed in the manifest: `listSegmentFiles` refuses it during
    // inventory (not `isFile()`), so it was never a segment in the first
    // place — never CONSIDERED at all, per this module's own doc. It
    // therefore cannot appear in either `verdicts` or `failures`; `skipped`
    // is the ONLY place its presence can surface.
    await symlink(
      path.join(sandbox, "nowhere-in-particular"),
      path.join(sandbox, plantedLinkName),
    );
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    expect(result.skipped).toBe(1);
    expect(
      result.verdicts.some(
        (verdict: M3LAppendOnlySegmentVerdict) =>
          verdict.segment === plantedLinkName,
      ),
    ).toBe(false);
    expect(
      result.failures.some(
        (failure: M3LAppendOnlyVerificationFailure) =>
          failure.segment === plantedLinkName,
      ),
    ).toBe(false);
    const healthyVerdict = definedOrThrow(
      result.verdicts.find(
        (verdict: M3LAppendOnlySegmentVerdict) =>
          verdict.segment === healthySegment,
      ),
      "the healthy segment's verdict",
    );
    expect(healthyVerdict.status).toBe("sealed");
  });

  test("an untouched trail reports skipped: 0", async () => {
    const buffer = await writeSegment(SEG, "{}\n");
    const measurement = measureBytes(buffer);
    await writeManifestBytes(sealLine(SEG, measurement));
    const { options } = harness();

    const result = await verifyAppendOnlySegments(options);

    // Falsifiable counterpart to the test above: without this, a `skipped`
    // field that was always `1` would pass that test too.
    expect(result.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("type-level contract", () => {
  test("M3LAppendOnlyVerificationStatus is exactly the five-member union, and totals is keyed by it", () => {
    expectTypeOf<M3LAppendOnlyVerificationStatus>().toEqualTypeOf<
      "sealed" | "unsealed" | "archived" | "mismatched" | "legacy"
    >();
    expectTypeOf<M3LAppendOnlyVerification["totals"]>().toEqualTypeOf<
      Readonly<Record<M3LAppendOnlyVerificationStatus, number>>
    >();
  });
});
