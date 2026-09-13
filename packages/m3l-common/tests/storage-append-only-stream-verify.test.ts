/**
 * `M3LAppendOnlyStream.verify()` — the PUBLIC method's wiring and contract
 * (ADR-0102, X8b slice 6), exercised through the public class only.
 *
 * Split from `storage-append-only-stream.test.ts` on purpose, for two
 * independent reasons: that file already sits at 55,996 bytes against
 * `check:file-budget`'s 60,000-byte ceiling, and `check:test-counts` pins a
 * count for `storage.test.ts` alone while treating these append-only sibling
 * files as unmatched by design — so a new sibling file, not a grown existing
 * one, is the only option either gate leaves open.
 *
 * This file is also deliberately NOT the classification-engine suite: a
 * concurrently-written `storage-append-only-verify.test.ts` owns
 * `internal/storage/append-only-verify.ts`'s classification rules
 * (sealed/unsealed/archived/mismatched/legacy) against hand-built fixture
 * directories. This file never constructs a fixture directory by hand — every
 * segment and every manifest line here is produced by driving a real
 * `M3LAppendOnlyStream` (small `maxSegmentBytes`, real rotations, real
 * seals), the same technique `storage-append-only-seal-wiring.test.ts` uses.
 * What this file pins is narrower and orthogonal to the engine's
 * classification rules: that `verify()` is wired to that engine at all —
 * the right directory, the right digest/manifest ceilings (in particular
 * `maxSegmentBytes + maxLineBytes`, not `maxSegmentBytes` alone), the right
 * two error-builder classes — and that it never rejects, which is the
 * entire reason an operator reaches for it once `read()` has already started
 * throwing.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  M3LAppendOnlyStreamManifestError,
  M3LAppendOnlyStreamReadError,
  type M3LAppendOnlySegmentVerdict,
  type M3LAppendOnlyVerification,
  type M3LAppendOnlyVerificationStatus,
} from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-verify-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * Drives a real stream through exactly `appendCount` appends with
 * `maxSegmentBytes: 1`, so every append after the first finds the active
 * segment already over the ceiling and rotates before writing — one segment
 * per append, deterministically, with no entry-width measuring required.
 * `flush()` afterwards guarantees every rotation's seal has settled before
 * the manifest or segment bytes are inspected.
 */
async function buildRotatedFixture(
  dir: string,
  appendCount: number,
): Promise<{
  readonly stream: M3LAppendOnlyStream;
  readonly segmentNames: readonly string[];
}> {
  const stream = new M3LAppendOnlyStream({
    directory: dir,
    maxSegmentBytes: 1,
  });
  for (let index = 0; index < appendCount; index += 1) {
    await stream.append({ seq: index });
  }
  await stream.flush();
  const listing = await stream.listSegments();
  return {
    stream,
    segmentNames: listing.segments.map((segment) => segment.name),
  };
}

/** Reads `manifest.jsonl` in `dir` and splits it into its non-empty lines. */
async function readManifestLines(dir: string): Promise<readonly string[]> {
  const content = await readFile(
    path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME),
    "utf8",
  );
  return content.split("\n").filter((line) => line.length > 0);
}

/** Overwrites `manifest.jsonl` in `dir` with `lines`, one per line. */
async function writeManifestLines(
  dir: string,
  lines: readonly string[],
): Promise<void> {
  await writeFile(
    path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

/** Finds a verdict by segment name, or throws — never a forbidden `!`. */
function findVerdict(
  report: M3LAppendOnlyVerification,
  segment: string,
): M3LAppendOnlySegmentVerdict {
  return definedOrThrow(
    report.verdicts.find((verdict) => verdict.segment === segment),
    `a verdict for ${segment}`,
  );
}

/** Every status `verify()` can report, independent of any one report. */
const ALL_STATUSES: readonly M3LAppendOnlyVerificationStatus[] = [
  "sealed",
  "unsealed",
  "archived",
  "mismatched",
  "legacy",
];

/** Tallies `report.verdicts` by status, for comparison against `report.totals`. */
function tallyByStatus(
  report: M3LAppendOnlyVerification,
): Record<M3LAppendOnlyVerificationStatus, number> {
  const tally: Record<M3LAppendOnlyVerificationStatus, number> = {
    sealed: 0,
    unsealed: 0,
    archived: 0,
    mismatched: 0,
    legacy: 0,
  };
  for (const verdict of report.verdicts) {
    tally[verdict.status] += 1;
  }
  return tally;
}

// ---------------------------------------------------------------------------
// The return type itself is part of the wiring contract.
// ---------------------------------------------------------------------------

test("verify() resolves to the public M3LAppendOnlyVerification shape", () => {
  expectTypeOf<
    Awaited<ReturnType<M3LAppendOnlyStream["verify"]>>
  >().toEqualTypeOf<M3LAppendOnlyVerification>();
});

// ---------------------------------------------------------------------------
// Happy path — classification, ordering, totals
// ---------------------------------------------------------------------------

describe("verify() wiring: sealed-vs-unsealed classification over a real rotated trail", () => {
  test("every rotated-away segment verifies sealed and the still-active segment verifies unsealed", async () => {
    const dir = path.join(workDir, "audit");
    const { segmentNames } = await buildRotatedFixture(dir, 4);
    expect(segmentNames).toHaveLength(4);

    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: 1,
    });
    const report = await stream.verify();

    for (const name of segmentNames.slice(0, -1)) {
      expect(findVerdict(report, name).status).toBe("sealed");
    }
    const activeSegment = definedOrThrow(
      segmentNames.at(-1),
      "the still-active segment",
    );
    expect(findVerdict(report, activeSegment).status).toBe("unsealed");

    // A fresh trail's first append writes a baseline asserting `upTo: null`
    // (storage-append-only-seal-wiring.test.ts, test 1) — verify() is wired
    // to report that same baseline back, not a hardcoded value.
    expect(report.unprovenBefore).toBeNull();
  });

  test("verdicts are ordered exactly as listSegments() reports them", async () => {
    const dir = path.join(workDir, "audit");
    const { stream, segmentNames } = await buildRotatedFixture(dir, 4);

    const report = await stream.verify();
    expect(report.verdicts.map((verdict) => verdict.segment)).toEqual(
      segmentNames,
    );
  });

  test("totals tally exactly against verdicts, and all five status keys are present even at zero", async () => {
    const dir = path.join(workDir, "audit");
    const { stream } = await buildRotatedFixture(dir, 4);

    const report = await stream.verify();
    expect(report.totals).toEqual(tallyByStatus(report));
    expect(Object.keys(report.totals).sort()).toEqual([...ALL_STATUSES].sort());
    // "legacy" and "mismatched" and "archived" are all genuinely zero on this
    // fixture (nothing predates a baseline, nothing was corrupted, nothing
    // was deleted) — proving the keys are present rather than merely absent
    // because nothing triggered them.
    expect(report.totals.legacy).toBe(0);
    expect(report.totals.mismatched).toBe(0);
    expect(report.totals.archived).toBe(0);
  });

  test("a sealed verdict's claimed sha256 is independently reproducible with node:crypto over the segment's raw bytes", async () => {
    const dir = path.join(workDir, "audit");
    const { stream, segmentNames } = await buildRotatedFixture(dir, 4);
    const sealedSegment = definedOrThrow(
      segmentNames[0],
      "the first, rotated-away segment",
    );

    const report = await stream.verify();
    const verdict = findVerdict(report, sealedSegment);
    if (verdict.status !== "sealed") {
      throw new Error(`expected status "sealed", got "${verdict.status}"`);
    }

    // Computed directly with node:crypto over the file's raw bytes — never
    // obtained from the library — so this is an independent oracle for the
    // documented "plain sha256, reproducible with sha256sum" contract.
    const bytes = await readFile(path.join(dir, sealedSegment));
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    expect(verdict.sealed.sha256).toBe(expectedSha256);
    expect(verdict.observed.sha256).toBe(expectedSha256);
  });
});

// ---------------------------------------------------------------------------
// Never throws — the contract that matters most
// ---------------------------------------------------------------------------

describe("verify() never throws, even where read() would", () => {
  test("a never-created stream directory resolves with empty verdicts and empty failures", async () => {
    const dir = path.join(workDir, "never-touched");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    const report = await stream.verify();
    expect(report.verdicts).toEqual([]);
    expect(report.failures).toEqual([]);
  });

  test("deleting a whole date's segments (archival) resolves with archived verdicts carrying the full sealed claim, not a rejection", async () => {
    const dir = path.join(workDir, "audit");
    const { stream, segmentNames } = await buildRotatedFixture(dir, 4);
    const sealedNames = segmentNames.slice(0, -1);

    for (const name of sealedNames) {
      await rm(path.join(dir, name));
    }

    // `await`ed directly (never `expect(fn).not.toThrow()`, which would
    // leave an async rejection unhandled) — resolving at all, against a
    // directory `read()` would already be throwing on, is the point.
    const report = await stream.verify();
    for (const name of sealedNames) {
      const verdict = findVerdict(report, name);
      if (verdict.status !== "archived") {
        throw new Error(`expected status "archived", got "${verdict.status}"`);
      }
      expect(verdict.sealed.sha256).toMatch(/^[0-9a-f]{64}$/u);
      // The `"archived"` arm carries no `observed` field at all — never
      // digested — so absence is an own-key check, not a `.toBeUndefined()`
      // read the type no longer permits.
      expect(Object.hasOwn(verdict, "observed")).toBe(false);
    }
    expect(report.failures).toEqual([]);
  });

  test("a corrupted sealed segment resolves with a mismatched verdict rather than a rejection", async () => {
    const dir = path.join(workDir, "audit");
    const { stream, segmentNames } = await buildRotatedFixture(dir, 2);
    const sealedSegment = definedOrThrow(segmentNames[0], "the sealed segment");

    const original = await readFile(path.join(dir, sealedSegment));
    await writeFile(
      path.join(dir, sealedSegment),
      Buffer.concat([original, Buffer.from([0x2a])]),
    );

    const report = await stream.verify();
    const verdict = findVerdict(report, sealedSegment);
    if (verdict.status !== "mismatched") {
      throw new Error(`expected status "mismatched", got "${verdict.status}"`);
    }
    expect(verdict.observed.byteLength).toBe(verdict.sealed.byteLength + 1);
    expect(verdict.observed.sha256).not.toBe(verdict.sealed.sha256);
  });

  test("a malformed mid-file manifest line resolves with a failures entry rather than a rejection", async () => {
    const dir = path.join(workDir, "audit");
    const { stream } = await buildRotatedFixture(dir, 2);

    const lines = await readManifestLines(dir);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const corrupted = [...lines];
    // Inserted before the last line (never appended as the new last line) so
    // this can never be read as a tolerated torn tail — only a genuine
    // mid-file corruption, which ADR-0102 states is fatal.
    corrupted.splice(Math.max(corrupted.length - 1, 0), 0, "{ not valid json");
    await writeManifestLines(dir, corrupted);

    const report = await stream.verify();
    expect(report.failures.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Error vocabulary — the wiring's whole job
// ---------------------------------------------------------------------------

describe("verify() reports the documented error classes for each failure kind", () => {
  test("a malformed manifest line is reported as M3LAppendOnlyStreamManifestError, never as M3LAppendOnlyStreamReadError", async () => {
    const secretDirName = "customer-8f4e-manifest-secret";
    const dir = path.join(workDir, secretDirName);
    const { stream } = await buildRotatedFixture(dir, 2);
    const secretFieldValue = "secret-field-value-9c21";
    await stream.append({ marker: secretFieldValue });
    await stream.flush();

    const lines = await readManifestLines(dir);
    const corrupted = [...lines];
    corrupted.splice(Math.max(corrupted.length - 1, 0), 0, "{ not valid json");
    await writeManifestLines(dir, corrupted);

    const report = await stream.verify();
    expect(report.failures.length).toBeGreaterThanOrEqual(1);
    const failure = definedOrThrow(report.failures[0], "the manifest failure");

    expect(failure.error).toBeInstanceOf(M3LError);
    expect(failure.error).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    expect(failure.error.code).toBe("ERR_APPEND_ONLY_STREAM_MANIFEST");
    // Falsifiable negation: a builder-swap bug (the two error builders passed
    // to the classification engine in the wrong slots) would make this an
    // M3LAppendOnlyStreamReadError instead, and this assertion would catch it.
    expect(failure.error).not.toBeInstanceOf(M3LAppendOnlyStreamReadError);

    // Hygiene: the sandbox directory and the entry's field value are caller
    // input and must never surface on the failure. `context` is asserted
    // non-empty first so the "does not contain" checks below cannot pass
    // vacuously against an empty object.
    const context = failure.error.context ?? {};
    expect(Object.keys(context).length).toBeGreaterThan(0);
    const serializedContext = JSON.stringify(context);
    expect(failure.error.message).not.toContain(secretDirName);
    expect(failure.error.message).not.toContain(workDir);
    expect(failure.error.message).not.toContain(secretFieldValue);
    expect(serializedContext).not.toContain(secretDirName);
    expect(serializedContext).not.toContain(workDir);
    expect(serializedContext).not.toContain(secretFieldValue);
  });

  test("a sealed segment refused via a planted symlink is reported as M3LAppendOnlyStreamReadError, never as M3LAppendOnlyStreamManifestError", async () => {
    const secretDirName = "customer-8f4e-segment-secret";
    const dir = path.join(workDir, secretDirName);
    const secretFieldValue = "secret-field-value-4d17";
    const { stream, segmentNames } = await buildRotatedFixture(dir, 2);
    await stream.append({ marker: secretFieldValue });
    await stream.flush();
    const sealedSegment = definedOrThrow(segmentNames[0], "the sealed segment");

    // The same shape storage-append-only-stream.test.ts's "symlink refusal"
    // describe block uses for a refused segment path: a real, existing
    // target file, symlinked in at the segment's own name after the real
    // file there is removed.
    const target = path.join(workDir, "victim.jsonl");
    await writeFile(target, "not a segment", "utf8");
    await rm(path.join(dir, sealedSegment));
    await symlink(target, path.join(dir, sealedSegment));

    const report = await stream.verify();
    expect(report.failures.length).toBeGreaterThanOrEqual(1);
    const failure = definedOrThrow(
      report.failures.find((entry) => entry.segment === sealedSegment),
      "a failure naming the symlinked segment",
    );

    expect(failure.error).toBeInstanceOf(M3LError);
    expect(failure.error).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect(failure.error.code).toBe("ERR_APPEND_ONLY_STREAM_READ");
    // Falsifiable negation, mirroring the manifest-failure test above: a
    // builder-swap bug here would surface as M3LAppendOnlyStreamManifestError
    // instead, and this assertion would catch it.
    expect(failure.error).not.toBeInstanceOf(M3LAppendOnlyStreamManifestError);

    // The refused segment must not ALSO appear as a verdict — the documented
    // invariant that a segment `verify()` considered is in `verdicts` or
    // `failures`, never both.
    expect(
      report.verdicts.some((verdict) => verdict.segment === sealedSegment),
    ).toBe(false);

    const context = failure.error.context ?? {};
    expect(Object.keys(context).length).toBeGreaterThan(0);
    const serializedContext = JSON.stringify(context);
    expect(failure.error.message).not.toContain(secretDirName);
    expect(failure.error.message).not.toContain(workDir);
    expect(failure.error.message).not.toContain(secretFieldValue);
    expect(serializedContext).not.toContain(secretDirName);
    expect(serializedContext).not.toContain(workDir);
    expect(serializedContext).not.toContain(secretFieldValue);
  });
});

// ---------------------------------------------------------------------------
// Ceiling wiring — maxSegmentBytes + maxLineBytes, not maxSegmentBytes alone
// ---------------------------------------------------------------------------

describe("verify() digests against maxSegmentBytes + maxLineBytes, not maxSegmentBytes alone", () => {
  test("a segment legitimately larger than maxSegmentBytes but within maxSegmentBytes + maxLineBytes still verifies sealed", async () => {
    const dir = path.join(workDir, "audit");
    const maxSegmentBytes = 50;
    const maxLineBytes = 500;
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes,
      maxLineBytes,
    });

    // The FIRST append never rotates (there is nothing yet to rotate away
    // from), so this single large entry legitimately produces a segment well
    // over `maxSegmentBytes` alone but comfortably under
    // `maxSegmentBytes + maxLineBytes` — exactly the segment ADR-0102 and
    // this class's own header document as "legal on purpose".
    await stream.append({ pad: "p".repeat(380) });
    const afterFirst = await stream.listSegments();
    expect(afterFirst.segments).toHaveLength(1);
    const bigSegment = definedOrThrow(
      afterFirst.segments[0],
      "the big segment",
    );
    expect(bigSegment.byteLength).toBeGreaterThan(maxSegmentBytes);
    expect(bigSegment.byteLength).toBeLessThanOrEqual(
      maxSegmentBytes + maxLineBytes,
    );

    // Triggers rotation: the active segment's current size already exceeds
    // maxSegmentBytes, so this append rotates first, sealing `bigSegment`.
    await stream.append({ tiny: true });
    await stream.flush();

    const report = await stream.verify();
    const verdict = findVerdict(report, bigSegment.name);
    // A verify() wired with `maxSegmentBytes` alone as its digest bound would
    // refuse to read the full segment and could never report it sealed —
    // that is the exact bug this test exists to catch.
    expect(verdict.status).toBe("sealed");
    expect(report.failures).toEqual([]);
  });
});
