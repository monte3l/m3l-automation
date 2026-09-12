/**
 * End-to-end tests for `M3LAppendOnlyStream`'s directory-wide `manifest.jsonl`
 * sidecar (ADR-0102, X8b slice 5), exercised through the PUBLIC surface only —
 * `M3LAppendOnlyStream.append`/`listSegments`/`read` and the constructor's
 * `onSealFailed` option. The internal writer/sealer/manifest seam is covered
 * by sibling internal-facing test files; this file pins only what a consumer
 * of the public class can observe: the sidecar appears and is a baseline on a
 * fresh trail, it stays invisible to the segment surface, a rotation seals the
 * segment it rotated away from with a digest independently reproducible by
 * `sha256sum`, and a seal that cannot be written is reported through
 * `onSealFailed` without ever failing the `append()` it follows.
 *
 * Two further describe blocks pin `M3LAppendOnlyStream.flush()` (X8b writer
 * seal wiring, flush) itself, end-to-end: after `await stream.flush()`, a
 * rotation's seal is deterministically on disk (no throwaway extra append
 * needed, unlike this file's own `flush()` helper below, which predates the
 * method), and the directory it just wrote can be `rm(..., { recursive: true
 * })`'d without the intermittent `ENOTEMPTY` a still-in-flight seal otherwise
 * causes.
 *
 * A real temporary directory is used throughout (no mocked `node:fs`): the
 * manifest sidecar and its seal records are a filesystem artifact, and a
 * mocked filesystem would assert the mock rather than the guarantee.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LAppendOnlyStream,
  type M3LAppendOnlyEntry,
  type M3LAppendOnlySealFailure,
} from "../src/core/storage/index.js";
import { M3L_APPEND_ONLY_MANIFEST_NAME } from "../src/internal/storage/append-only-manifest.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-seal-wiring-"));
});

afterEach(async () => {
  // Unconditional safety net for the one test below that uses fake timers:
  // harmless when real timers are already active, and guarantees a failed
  // assertion mid-test can never leak fake time into a later, unrelated test.
  vi.useRealTimers();
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
 * Appends one throwaway entry and awaits it.
 *
 * `M3LAppendOnlyWriter.write()` resolves once the entry's own bytes are
 * durable, but the manifest seal that FOLLOWS that append runs on a private
 * tail chain the caller never awaits directly. The next `append()` call,
 * however, cannot start its own write until that tail settles — so awaiting
 * one extra append after the operation under test is what makes the
 * PRECEDING append's seal attempt (baseline write, rotation seal, or a
 * reported seal failure) observable before any assertion runs, without a
 * timer or a retry loop.
 */
async function flush(stream: M3LAppendOnlyStream): Promise<void> {
  await stream.append({ flush: true });
}

/** Reads `manifest.jsonl` in `dir` and splits it into its non-empty lines. */
async function readManifestLines(dir: string): Promise<readonly string[]> {
  const content = await readFile(
    path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME),
    "utf8",
  );
  return content.split("\n").filter((line) => line.length > 0);
}

/** Parses one manifest line into `unknown`, never `any`. */
function parseManifestLine(line: string): unknown {
  const parsed: unknown = JSON.parse(line);
  return parsed;
}

/** Reads one own field off a parsed manifest record, guarding its shape. */
function readOwnField(record: unknown, field: string): unknown {
  if (typeof record !== "object" || record === null) {
    throw new Error(`expected a manifest record object for field "${field}"`);
  }
  if (!Object.hasOwn(record, field)) {
    throw new Error(`expected the manifest record to carry "${field}"`);
  }
  return (record as Readonly<Record<string, unknown>>)[field];
}

/** Reads one own field as a `string`, throwing on any other shape. */
function readStringField(record: unknown, field: string): string {
  const value = readOwnField(record, field);
  if (typeof value !== "string") {
    throw new Error(`expected manifest field "${field}" to be a string`);
  }
  return value;
}

/** Reads one own field as a `number`, throwing on any other shape. */
function readNumberField(record: unknown, field: string): number {
  const value = readOwnField(record, field);
  if (typeof value !== "number") {
    throw new Error(`expected manifest field "${field}" to be a number`);
  }
  return value;
}

/** Reads one own field as a `string | null`, throwing on any other shape. */
function readNullableStringField(
  record: unknown,
  field: string,
): string | null {
  const value = readOwnField(record, field);
  if (value !== null && typeof value !== "string") {
    throw new Error(
      `expected manifest field "${field}" to be a string or null`,
    );
  }
  return value;
}

/** Finds the one `seal` record naming `segment`, or `undefined`. */
function findSealFor(records: readonly unknown[], segment: string): unknown {
  return records.find(
    (record) =>
      readStringField(record, "kind") === "seal" &&
      readStringField(record, "segment") === segment,
  );
}

/** An entry padded to a stable, predictable serialized width. */
function paddedEntry(sequence: number): M3LAppendOnlyEntry {
  return { seq: sequence, pad: "p".repeat(80) };
}

/**
 * Measures the exact on-disk byte cost of one entry (JSON line + newline) by
 * appending it to a throwaway directory and reading the resulting file size.
 */
async function measureLineBytes(entry: M3LAppendOnlyEntry): Promise<number> {
  const probeDir = path.join(workDir, "measure-probe");
  const probe = new M3LAppendOnlyStream({ directory: probeDir });
  await probe.append(entry);
  const names = await readdir(probeDir);
  const only = definedOrThrow(names[0], "the probe segment");
  const content = await readFile(path.join(probeDir, only), "utf8");
  return Buffer.byteLength(content, "utf8");
}

// ---------------------------------------------------------------------------
// 1 — the sidecar appears, and is a baseline on a fresh trail
// ---------------------------------------------------------------------------

describe("the manifest sidecar on a fresh trail", () => {
  test("a fresh directory's first append writes a baseline record asserting upTo: null, excluding the writer's own just-created segment", async () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    await stream.append({ event: "first" });
    await flush(stream);

    const lines = await readManifestLines(dir);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const first = parseManifestLine(
      definedOrThrow(lines[0], "the first manifest line"),
    );
    expect(readStringField(first, "kind")).toBe("baseline");

    // The baseline excludes the writer's own ACTIVE segment when computing
    // `upTo` — that segment is bytes this writer produced, not a pre-upgrade
    // artifact the baseline needs to write off as unproven. A trail whose
    // very first byte was already sealing therefore asserts `upTo: null`:
    // the positive claim that sealing has been in force since the first
    // segment. That leaves this segment eligible for the ordinary lifecycle
    // — sweepable once it ages off today's date, sealable by rotation like
    // any other — rather than permanently classified `legacy` by naming
    // itself as its own boundary.
    const segments = await stream.listSegments();
    expect(segments.segments).toHaveLength(1);
    expect(readNullableStringField(first, "upTo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1b — REGRESSION: the fresh trail's own first segment is not permanently
// excluded once it ages off today's date — it is later swept and sealed
// ---------------------------------------------------------------------------

describe("the writer's own excluded segment is later sweepable and sealed", () => {
  test("[REGRESSION] a fresh trail's first segment, once it is yesterday's, is cold-start swept and sealed rather than permanently unprovable", async () => {
    const dir = path.join(workDir, "audit");

    // A fixed instant well clear of either UTC-day boundary, so the two
    // `setSystemTime` calls below are unambiguous about which day they land
    // on — mirrors the sanctioned fake-clock pattern this suite family
    // already uses for age-based rotation (storage-append-only-stream.test.ts,
    // "rotation by age").
    const day1 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const day2 = day1 + 24 * 60 * 60 * 1000;
    vi.useFakeTimers();
    vi.setSystemTime(day1);

    // A first writer instance, on day 1: its baseline excludes its own
    // just-created segment (`upTo: null` — see the fresh-trail test above),
    // which is the exact condition the pre-fix baseline got wrong.
    const firstWriter = new M3LAppendOnlyStream({ directory: dir });
    await firstWriter.append({ event: "day-one" });
    await flush(firstWriter);

    const afterDayOne = await firstWriter.listSegments();
    expect(afterDayOne.segments).toHaveLength(1);
    const day1Segment = definedOrThrow(
      afterDayOne.segments[0],
      "day 1's segment",
    ).name;

    // Cross into day 2, then construct a BRAND NEW stream instance — never
    // `firstWriter` — over the same directory. This is the scenario the fix
    // exists for: `discoverActiveSegment` only ever adopts TODAY's date
    // prefix, so this new instance's first append never names `day1Segment`
    // as `rotatedFrom` (a rotation seal would have sealed it unconditionally
    // either way, fixed or not, and would not have discriminated the bug).
    // The only path that can ever reach `day1Segment` now is the cold-start
    // sweep, which DOES consult the baseline — exactly where the pre-fix
    // `upTo` naming this very segment would have excluded it permanently via
    // `isAtOrBeforeBaseline`'s `<=`.
    vi.setSystemTime(day2);
    const secondWriter = new M3LAppendOnlyStream({ directory: dir });
    await secondWriter.append({ event: "day-two" });
    await flush(secondWriter);
    vi.useRealTimers();

    const lines = await readManifestLines(dir);
    const records = lines.map(parseManifestLine);
    expect(findSealFor(records, day1Segment)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2 — the sidecar is invisible to the public segment surface
// ---------------------------------------------------------------------------

describe("the manifest sidecar is invisible to the segment surface", () => {
  test("listSegments neither lists manifest.jsonl nor counts it as skipped", async () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({ directory: dir });

    await stream.append({ event: "first" });
    await flush(stream);

    // The manifest genuinely exists on disk by this point — otherwise the
    // assertions below would pass vacuously against a directory that simply
    // has nothing to hide yet.
    const rawNames = await readdir(dir);
    expect(rawNames).toContain(M3L_APPEND_ONLY_MANIFEST_NAME);

    // The mutation this catches: widening the segment-name pattern to also
    // accept `manifest.jsonl`. That would make it show up in `segments` AND
    // would count it as an ordinary segment rather than leaving it out of the
    // inventory entirely — neither half is acceptable on its own.
    const listing = await stream.listSegments();
    expect(listing.segments.map((segment) => segment.name)).not.toContain(
      M3L_APPEND_ONLY_MANIFEST_NAME,
    );
    expect(listing.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — rotation seals the segment it rotated away from
// ---------------------------------------------------------------------------

describe("rotation seals the segment it rotated away from", () => {
  test("a byte-ceiling rotation seals the FIRST segment and names no seal for the active one", async () => {
    const dir = path.join(workDir, "audit");
    // A one-byte ceiling forces every append after the first to find the
    // active segment's size already over it, so the second append always
    // rotates deterministically without measuring any entry's exact width.
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: 1,
    });

    await stream.append({ event: "into-first-segment" });
    const afterFirst = await stream.listSegments();
    expect(afterFirst.segments).toHaveLength(1);
    const firstSegment = definedOrThrow(
      afterFirst.segments[0],
      "the first segment",
    ).name;

    await stream.append({ event: "rotates-away-from-first" });
    // One more append + flush guarantees the SECOND append's own seal chain
    // (which seals `firstSegment`) has settled before the manifest is read.
    await flush(stream);

    const lines = await readManifestLines(dir);
    const records = lines.map(parseManifestLine);
    const sealForFirst = findSealFor(records, firstSegment);
    expect(sealForFirst).toBeDefined();

    const activeNow = definedOrThrow(
      [...(await stream.listSegments()).segments]
        .sort((left, right) => left.name.localeCompare(right.name))
        .at(-1),
      "the currently active segment",
    ).name;
    expect(activeNow).not.toBe(firstSegment);
    expect(findSealFor(records, activeNow)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3b — stream.flush() drains a rotation's seal deterministically
// ---------------------------------------------------------------------------

describe("stream.flush() drains a rotation's seal deterministically", () => {
  test("after stream.flush(), a rotation's seal for the rotated-away segment is on disk", async () => {
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: 1,
    });

    await stream.append({ event: "into-first-segment" });
    const afterFirst = await stream.listSegments();
    expect(afterFirst.segments).toHaveLength(1);
    const firstSegment = definedOrThrow(
      afterFirst.segments[0],
      "the first segment",
    ).name;

    // Forces the writer to seal `firstSegment` away, on its own internal
    // tail chain — not yet observable from here without draining that tail.
    await stream.append({ event: "rotates-away-from-first" });

    // The method under test: no throwaway extra append (unlike this file's
    // own `flush()` helper, which predates `M3LAppendOnlyStream.flush()`),
    // and no manual retry loop — `stream.flush()` alone must make the seal
    // for the rotated-away segment observable.
    await stream.flush();

    const lines = await readManifestLines(dir);
    const records = lines.map(parseManifestLine);
    expect(findSealFor(records, firstSegment)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3c — stream.flush() makes the directory safe to remove
// ---------------------------------------------------------------------------

describe("stream.flush() makes the directory safe to remove", () => {
  test("after stream.flush(), rm(dir, { recursive: true }) does not throw", async () => {
    // A regression guard for a flake, not a proof the race is impossible:
    // without the flush, this call intermittently threw ENOTEMPTY when a
    // still-in-flight manifest seal recreated manifest.jsonl partway through
    // the recursive remove (see this method's own TSDoc "What it is for").
    // This test only shows flush() closes that specific window.
    const dir = path.join(workDir, "audit");
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      maxSegmentBytes: 1,
    });

    await stream.append({ event: "into-first-segment" });
    await stream.append({ event: "rotates-away-from-first" });
    await stream.flush();

    await expect(rm(dir, { recursive: true })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4 — THE CONTRACT TEST: the digest is a plain sha256 of the raw bytes
// ---------------------------------------------------------------------------

describe("the sealed digest is a plain sha256 of the segment's raw bytes", () => {
  test("an independently-computed sha256 of the sealed segment's bytes matches the manifest's claim", async () => {
    const dir = path.join(workDir, "audit");
    const entry = paddedEntry(0);
    const lineBytes = await measureLineBytes(entry);
    // Two lines fit under the ceiling; a third does not, so the first
    // segment holds exactly two entries when it is rotated away from.
    const maxSegmentBytes = lineBytes * 2 - 1;
    const stream = new M3LAppendOnlyStream({ directory: dir, maxSegmentBytes });

    await stream.append(paddedEntry(1));
    await stream.append(paddedEntry(2));
    const beforeRotation = await stream.listSegments();
    expect(beforeRotation.segments).toHaveLength(1);
    const sealedSegment = definedOrThrow(
      beforeRotation.segments[0],
      "the segment about to be rotated away from",
    ).name;

    await stream.append(paddedEntry(3));
    // Guarantees the rotation's own seal chain (sealing `sealedSegment`) has
    // settled before the manifest and the segment file are read below.
    await flush(stream);

    const sealedPath = path.join(dir, sealedSegment);
    const sealedBytes = await readFile(sealedPath);
    // Computed with `node:crypto` directly over the file's RAW bytes — never
    // through any function under test — so this is an independent oracle,
    // not a restatement of the library's own digest. The mutation this
    // catches: digesting only the first chunk of a multi-chunk read, which
    // would agree with a library-computed "expected" value but disagree with
    // this one.
    const expectedSha256 = createHash("sha256")
      .update(sealedBytes)
      .digest("hex");

    const lines = await readManifestLines(dir);
    const records = lines.map(parseManifestLine);
    const seal = findSealFor(records, sealedSegment);
    expect(seal).toBeDefined();
    expect(readStringField(seal, "sha256")).toBe(expectedSha256);
    expect(readNumberField(seal, "byteLength")).toBe(sealedBytes.byteLength);
    expect(readNumberField(seal, "entryCount")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5, 6, 7 — onSealFailed, a genuinely refused manifest
// ---------------------------------------------------------------------------

/**
 * Plants a symlink at the manifest path inside `dir` (created fresh) so the
 * sealer's `O_NOFOLLOW` open of `manifest.jsonl` is refused rather than
 * followed — the same guarantee the segment path enjoys. The target is a
 * real, existing file so a wrong assumption about `ENOENT` vs `ELOOP` would
 * surface as an actual assertion failure rather than passing by accident.
 */
async function plantManifestSymlink(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "manifest-target.txt");
  await writeFile(target, "not a manifest", "utf8");
  await symlink(target, path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME));
}

describe("onSealFailed reports a genuinely refused manifest", () => {
  test("a symlinked manifest reports segment: undefined, and the triggering append still resolves with its entry durable", async () => {
    const secretDirName = "customer-8f4e-manifest-secret";
    const dir = path.join(workDir, secretDirName);
    await plantManifestSymlink(dir);

    const failures: M3LAppendOnlySealFailure[] = [];
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      onSealFailed: (failure) => {
        failures.push(failure);
      },
    });

    await expect(
      stream.append({ marker: "first-entry-marker" }),
    ).resolves.toBeUndefined();
    // Guarantees the first append's seal attempt (against the refused
    // manifest) has settled before `failures` is inspected.
    await flush(stream);

    expect(failures).toHaveLength(1);
    const failure = definedOrThrow(failures[0], "the one seal failure");

    // A manifest-level failure — the manifest itself could not be opened,
    // before any one segment was ever attempted — reports `segment:
    // undefined`, never the segment name the append landed in.
    expect(failure.segment).toBeUndefined();
    expect(failure.error).toBeInstanceOf(M3LError);

    // No caller data: neither the message nor the context may name the
    // stream's directory, which is caller input.
    const serializedContext = JSON.stringify(failure.error.context ?? {});
    expect(failure.error.message).not.toContain(secretDirName);
    expect(failure.error.message).not.toContain(workDir);
    expect(serializedContext).not.toContain(secretDirName);
    expect(serializedContext).not.toContain(workDir);

    // The entry itself is unaffected: already appended and durable.
    const listing = await stream.listSegments();
    expect(listing.segments).toHaveLength(1);
    const segmentName = definedOrThrow(
      listing.segments[0],
      "the only segment",
    ).name;
    const raw = await readFile(path.join(dir, segmentName), "utf8");
    expect(raw).toContain("first-entry-marker");
  });

  test("a throwing onSealFailed handler does not fail its append, and a later append still succeeds", async () => {
    const dir = path.join(workDir, "throwing-handler-audit");
    await plantManifestSymlink(dir);

    let handlerCalls = 0;
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      onSealFailed: () => {
        handlerCalls += 1;
        throw new Error("deliberately thrown from onSealFailed");
      },
    });

    await expect(stream.append({ event: "first" })).resolves.toBeUndefined();
    await expect(stream.append({ event: "second" })).resolves.toBeUndefined();

    expect(handlerCalls).toBeGreaterThanOrEqual(1);
  });

  test("with no onSealFailed handler at all, appends still succeed and nothing throws", async () => {
    const dir = path.join(workDir, "no-handler-audit");
    await plantManifestSymlink(dir);

    const stream = new M3LAppendOnlyStream({ directory: dir });

    await expect(stream.append({ event: "first" })).resolves.toBeUndefined();
    await expect(stream.append({ event: "second" })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8, 9, 10 — an ASYNC onSealFailed whose promise rejects (not a sync throw)
//
// `onSealFailed` is typed `(failure) => void`, but TypeScript's void-return
// compatibility rule accepts an `async` handler too — the shape this class's
// own `@example` invites for reporting elsewhere. `reportSealFailure`
// (internal/storage/append-only-seal-report.ts) detects the returned
// thenable and attaches a rejection handler without awaiting it, so a
// rejection never becomes an unhandled promise rejection outside the
// sealer — which, unhandled, terminates the process on this library's
// Node 24+ floor. This is a SEPARATE mechanism from the synchronous
// `try`/`catch` pinned above (test 3 here is the sync-throw sibling, kept
// in this same block so the two guards are visibly distinct and a mutation
// to one cannot hide behind the other).
// ---------------------------------------------------------------------------

describe("onSealFailed's returned promise rejecting does not break anything", () => {
  test("a promise-rejecting onSealFailed handler does not fail the triggering append, and the entry is durable in its segment", async () => {
    const dir = path.join(workDir, "async-rejecting-handler-audit");
    await plantManifestSymlink(dir);

    let handlerCalls = 0;
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pinning the exact hazard: onSealFailed is typed to return void, but TS's void-return compatibility rule accepts this async handler, the shape the public @example invites elsewhere
      onSealFailed: async (failure) => {
        handlerCalls += 1;
        void failure;
        await Promise.resolve();
        throw new Error("handler blew up asynchronously");
      },
    });

    await expect(
      stream.append({ marker: "async-rejecting-first" }),
    ).resolves.toBeUndefined();
    // Guarantees the first append's seal attempt — and its onSealFailed
    // call — has settled before `handlerCalls` and the manifest are read.
    await flush(stream);

    // Proves the handler actually ran (and thus that its rejection was the
    // thing under test) — without this, the test below would pass even if
    // the handler were never invoked at all.
    expect(handlerCalls).toBeGreaterThanOrEqual(1);

    const listing = await stream.listSegments();
    expect(listing.segments).toHaveLength(1);
    const segmentName = definedOrThrow(
      listing.segments[0],
      "the only segment",
    ).name;
    const raw = await readFile(path.join(dir, segmentName), "utf8");
    expect(raw).toContain("async-rejecting-first");

    // A later append still succeeds: the rejection did not poison the
    // sealer's serialized tail chain for subsequent appends.
    await expect(
      stream.append({ marker: "async-rejecting-second" }),
    ).resolves.toBeUndefined();
  });

  test("stream.flush() still resolves with a promise-rejecting onSealFailed handler wired", async () => {
    const dir = path.join(workDir, "async-rejecting-handler-flush-audit");
    await plantManifestSymlink(dir);

    let handlerCalls = 0;
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pinning the exact hazard: onSealFailed is typed to return void, but TS's void-return compatibility rule accepts this async handler, the shape the public @example invites elsewhere
      onSealFailed: async () => {
        handlerCalls += 1;
        await Promise.resolve();
        throw new Error("handler blew up asynchronously during flush");
      },
    });

    await stream.append({ marker: "flush-target" });
    await expect(stream.flush()).resolves.toBeUndefined();
    expect(handlerCalls).toBeGreaterThanOrEqual(1);
  });

  test("a synchronously-throwing onSealFailed handler is still swallowed — the pre-existing, separate guard", async () => {
    const dir = path.join(workDir, "sync-throwing-handler-sibling-audit");
    await plantManifestSymlink(dir);

    let handlerCalls = 0;
    const stream = new M3LAppendOnlyStream({
      directory: dir,
      onSealFailed: () => {
        handlerCalls += 1;
        throw new Error("deliberately thrown, synchronously");
      },
    });

    await expect(
      stream.append({ marker: "sync-throw-first" }),
    ).resolves.toBeUndefined();
    await flush(stream);

    expect(handlerCalls).toBeGreaterThanOrEqual(1);
    await expect(
      stream.append({ marker: "sync-throw-second" }),
    ).resolves.toBeUndefined();
  });
});
