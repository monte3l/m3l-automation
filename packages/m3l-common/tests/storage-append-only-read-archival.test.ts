/**
 * `M3LAppendOnlyStream.read()` consulting the directory-wide `manifest.jsonl`
 * sidecar to detect a SEALED-BUT-ABSENT segment (ADR-0102, X8b reader
 * verification), exercised through the public class only.
 *
 * The gap this covers is structural, not incidental. The reader's own
 * `assertNoSequenceGap` proves contiguity only WITHIN one date and only
 * among the segments it actually found on disk, and its TSDoc concedes both
 * limits: a whole deleted date is invisible to it (there is nothing left of
 * that date to be discontiguous with), and so is a date's deleted LAST
 * segment (the survivors still run contiguously from 1). The manifest is the
 * only artifact in the directory that remembers a segment which is no longer
 * there, so it is the only thing that can close either hole — and because it
 * is directory-wide rather than per-date, it survives the very deletion it
 * is being asked to detect.
 *
 * Every fixture here is produced by driving a REAL `M3LAppendOnlyStream`
 * (`maxSegmentBytes: 1`, real rotations, real seals, a real UTC date
 * rollover under fake timers), never by hand-assembling segment files — the
 * same technique `storage-append-only-stream-verify.test.ts` and
 * `storage-append-only-seal-wiring.test.ts` use. A real temporary directory
 * is used throughout rather than a mocked `node:fs`: what is under test is a
 * filesystem invariant about which files exist, and a mocked filesystem
 * would assert the mock instead. The only files ever mutated by hand are the
 * sidecar itself (a documented, public artifact named by
 * `M3L_APPEND_ONLY_MANIFEST_NAME`) and the segment files being deleted,
 * which is the operator action the whole feature exists to notice.
 *
 * @packageDocumentation
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  M3L_APPEND_ONLY_MANIFEST_NAME,
  M3LAppendOnlyStream,
  M3LAppendOnlyStreamManifestError,
  M3LAppendOnlyStreamReadError,
} from "../src/core/storage/index.js";
import type {
  M3LAppendOnlyEntry,
  M3LAppendOnlyReadOptions,
  M3LAppendOnlySealedSegment,
} from "../src/core/storage/index.js";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

/**
 * Midday UTC on two consecutive days: far enough from either UTC-day
 * boundary that `setSystemTime` is unambiguous about which date prefix the
 * writer stamps, the same fake-clock shape
 * `storage-append-only-seal-wiring.test.ts` uses for its cold-start sweep
 * regression.
 */
const DAY_ONE_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY_TWO_MS = DAY_ONE_MS + 24 * 60 * 60 * 1000;
const DAY_ONE = "2026-01-01";
const DAY_TWO = "2026-01-02";

/** The exact wording W5 pins; a drift here is a breaking change for operators. */
const SEQUENCE_GAP_MESSAGE =
  "append-only stream: a segment sequence number is missing";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-append-only-archival-"));
});

afterEach(async () => {
  // Unconditional: every fixture here uses fake timers, and a failed
  // assertion mid-test must not leak fake time into the next one.
  vi.useRealTimers();
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
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
 * `undefined` when it completed) alongside every entry yielded BEFORE the
 * throw — the same helper shape `storage-append-only-read.test.ts` uses.
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

/** Reads `manifest.jsonl` in `dir` and splits it into its non-empty lines. */
async function readManifestLines(dir: string): Promise<readonly string[]> {
  const content = await readFile(
    path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME),
    "utf8",
  );
  return content.split("\n").filter((line) => line.length > 0);
}

/** Overwrites `manifest.jsonl` in `dir` with `lines`, each newline-terminated. */
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

/** `true` when the line is a `seal` record naming `segment`. */
function isSealLineFor(line: string, segment: string): boolean {
  const record = parseManifestLine(line);
  return (
    readStringField(record, "kind") === "seal" &&
    readStringField(record, "segment") === segment
  );
}

/** Every segment name the manifest currently states a `seal` record for. */
function sealedSegmentNames(lines: readonly string[]): readonly string[] {
  return lines
    .map((line) => parseManifestLine(line))
    .filter((record) => readStringField(record, "kind") === "seal")
    .map((record) => readStringField(record, "segment"));
}

/**
 * The manifest's claim for `segment`, projected to exactly the five fields
 * {@link M3LAppendOnlySealedSegment} carries.
 *
 * Built by reading each field out of the sidecar by name rather than by
 * spreading the parsed record: the on-disk record ALSO carries `kind` and
 * `formatVersion`, and an expectation built by spreading would quietly
 * accept an implementation that handed those internal fields to the caller.
 */
function sealClaimFor(
  lines: readonly string[],
  segment: string,
): M3LAppendOnlySealedSegment {
  const line = definedOrThrow(
    lines.find((candidate) => isSealLineFor(candidate, segment)),
    `a seal record for ${segment}`,
  );
  const record = parseManifestLine(line);
  return {
    segment: readStringField(record, "segment"),
    at: readStringField(record, "at"),
    entryCount: readNumberField(record, "entryCount"),
    byteLength: readNumberField(record, "byteLength"),
    sha256: readStringField(record, "sha256"),
  };
}

/**
 * A trail spanning a UTC date rollover, with real seals.
 *
 * `maxSegmentBytes: 1` makes every append after the first rotate before
 * writing, so N appends produce exactly N segments without measuring entry
 * widths (the documented degenerate case). Day one's earlier segments are
 * sealed by those rotations; day one's LAST segment is sealed by the
 * cold-start sweep the day-two writer instance runs, which is why a second
 * `M3LAppendOnlyStream` is constructed rather than reusing the first.
 *
 * `flush()` after each day's appends settles the seal tail — the sealer runs
 * AFTER `append()` resolves, so without it a later `rm` races a seal that
 * would recreate `manifest.jsonl`.
 */
async function buildRolledOverTrail(
  dir: string,
  dayOneAppends: number,
  dayTwoAppends: number,
): Promise<{
  readonly dayOneEntries: readonly M3LAppendOnlyEntry[];
  readonly dayTwoEntries: readonly M3LAppendOnlyEntry[];
}> {
  const dayOneEntries: M3LAppendOnlyEntry[] = Array.from(
    { length: dayOneAppends },
    (_unused, index) => ({ day: 1, index }),
  );
  const dayTwoEntries: M3LAppendOnlyEntry[] = Array.from(
    { length: dayTwoAppends },
    (_unused, index) => ({ day: 2, index }),
  );

  vi.useFakeTimers();
  vi.setSystemTime(DAY_ONE_MS);
  const dayOneWriter = new M3LAppendOnlyStream({
    directory: dir,
    maxSegmentBytes: 1,
  });
  for (const entry of dayOneEntries) {
    await dayOneWriter.append(entry);
  }
  await dayOneWriter.flush();

  vi.setSystemTime(DAY_TWO_MS);
  const dayTwoWriter = new M3LAppendOnlyStream({
    directory: dir,
    maxSegmentBytes: 1,
  });
  for (const entry of dayTwoEntries) {
    await dayTwoWriter.append(entry);
  }
  await dayTwoWriter.flush();
  vi.useRealTimers();

  return { dayOneEntries, dayTwoEntries };
}

/** Every segment name currently on disk under `datePrefix`, oldest first. */
async function segmentNamesFor(
  dir: string,
  datePrefix: string,
): Promise<readonly string[]> {
  const listing = await new M3LAppendOnlyStream({
    directory: dir,
  }).listSegments();
  return listing.segments
    .filter((segment) => segment.datePrefix === datePrefix)
    .map((segment) => segment.name);
}

/** Deletes the named segment files from `dir`. */
async function deleteSegments(
  dir: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    await rm(path.join(dir, name));
  }
}

/**
 * Records every `onArchivedSegment` payload, so a test can assert both the
 * call count and the exact payloads.
 */
function archivalRecorder(): {
  readonly calls: readonly M3LAppendOnlySealedSegment[];
  readonly onArchivedSegment: (segment: M3LAppendOnlySealedSegment) => void;
} {
  const calls: M3LAppendOnlySealedSegment[] = [];
  return {
    calls,
    onArchivedSegment: (segment: M3LAppendOnlySealedSegment): void => {
      calls.push(segment);
    },
  };
}

/** Sorts payloads by segment name, so call ORDER is never over-pinned. */
function bySegment(
  claims: readonly M3LAppendOnlySealedSegment[],
): readonly M3LAppendOnlySealedSegment[] {
  return [...claims].sort((left, right) =>
    left.segment < right.segment ? -1 : 1,
  );
}

// ---------------------------------------------------------------------------
// The option's type is part of the public contract
// ---------------------------------------------------------------------------

// NOTE: this assertion is invisible to Vitest, which transforms without
// type-checking, so it can never fail in a test run — `pnpm typecheck` is the
// only gate that reads it. Its passing tick in a Vitest run therefore says
// nothing about the shape of `M3LAppendOnlyReadOptions`.
test("M3LAppendOnlyReadOptions.onArchivedSegment takes a sealed-segment claim and returns void", () => {
  expectTypeOf<M3LAppendOnlyReadOptions["onArchivedSegment"]>().toEqualTypeOf<
    ((segment: M3LAppendOnlySealedSegment) => void) | undefined
  >();
});

// ---------------------------------------------------------------------------
// W1 — a healthy sealed trail is unaffected
// ---------------------------------------------------------------------------

describe("a healthy sealed trail", () => {
  // INVARIANT: consulting the manifest changes nothing for a directory whose
  // every sealed segment is still on disk. The falsifiable half is the
  // handler: an implementation that escalated on any seal record at all —
  // rather than on a seal whose segment is absent — would fire it here.
  test("reads every entry in append order and never calls onArchivedSegment", async () => {
    const dir = path.join(workDir, "audit");
    const { dayOneEntries, dayTwoEntries } = await buildRolledOverTrail(
      dir,
      3,
      3,
    );

    // Non-vacuity: the manifest genuinely claims seals here, so "never
    // called" is a decision the implementation had to make, not the absence
    // of anything to decide about.
    const sealed = sealedSegmentNames(await readManifestLines(dir));
    expect(sealed.length).toBeGreaterThanOrEqual(4);

    const recorder = archivalRecorder();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(
      reader.read({ onArchivedSegment: recorder.onArchivedSegment }),
    );

    expect(recovered).toEqual([...dayOneEntries, ...dayTwoEntries]);
    expect(recorder.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W2 — a whole archived date escalates
// ---------------------------------------------------------------------------

describe("a whole date's segments deleted, manifest left behind", () => {
  // INVARIANT: deleting every segment of an older date leaves NOTHING on
  // disk for the sequence walk to notice — the remaining date is still
  // perfectly contiguous from 1 — so without the sidecar this read is
  // silently short. The directory-wide manifest is what survives the
  // deletion and remembers those segments existed.
  test("throws M3LAppendOnlyStreamManifestError when no handler is supplied", async () => {
    const dir = path.join(workDir, "audit");
    await buildRolledOverTrail(dir, 3, 2);
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    const lines = await readManifestLines(dir);
    // Precondition: the manifest claims every day-one segment. Without this
    // the deletion below would be indistinguishable from an unsealed gap.
    expect(sealedSegmentNames(lines)).toEqual(
      expect.arrayContaining([...dayOneSegments]),
    );

    await deleteSegments(dir, dayOneSegments);

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { thrown } = await collectUntilThrow(reader.read());

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    expect((thrown as M3LAppendOnlyStreamManifestError).code).toBe(
      "ERR_APPEND_ONLY_STREAM_MANIFEST",
    );
  });

  // INVARIANT: with a handler, the finding is reported rather than thrown —
  // and it is reported ONCE PER absent sealed segment, carrying the
  // manifest's full five-field claim so an operator holding an archive copy
  // can run `sha256sum` against it. `toEqual` (never `toMatchObject`) plus
  // an explicit own-key assertion, because the on-disk record also carries
  // `kind` and `formatVersion`, which must not reach a caller.
  test("reports each absent sealed segment with its full claim and reads the surviving entries", async () => {
    const dir = path.join(workDir, "audit");
    const { dayTwoEntries } = await buildRolledOverTrail(dir, 3, 2);
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    expect(dayOneSegments).toHaveLength(3);
    const lines = await readManifestLines(dir);
    const expectedClaims = dayOneSegments.map((name) =>
      sealClaimFor(lines, name),
    );

    await deleteSegments(dir, dayOneSegments);

    const recorder = archivalRecorder();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(
      reader.read({ onArchivedSegment: recorder.onArchivedSegment }),
    );

    expect(recovered).toEqual(dayTwoEntries);
    expect(bySegment(recorder.calls)).toEqual(bySegment(expectedClaims));
    for (const call of recorder.calls) {
      expect(Object.keys(call).sort()).toEqual([
        "at",
        "byteLength",
        "entryCount",
        "segment",
        "sha256",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// W3 — the escalation is eager
// ---------------------------------------------------------------------------

describe("archival escalation timing", () => {
  // INVARIANT: the scan needs only the manifest and the directory listing —
  // no segment bytes — so it resolves BEFORE the first entry is yielded.
  // This is a decided contract, not an accident: a caller that streams a
  // trail into a rebuild must learn the trail is incomplete before it has
  // committed a single entry, not after.
  //
  // Pinned by driving the iterator by hand: a lazy implementation that
  // yielded the surviving entries first and threw at the end would resolve
  // this `next()` with a value, and `firstResult` would not be `undefined`.
  test("rejects on the very first next(), before any entry is yielded", async () => {
    const dir = path.join(workDir, "audit");
    await buildRolledOverTrail(dir, 2, 2);
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    await deleteSegments(dir, dayOneSegments);

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const iterator = reader.read()[Symbol.asyncIterator]();
    let firstResult: IteratorResult<M3LAppendOnlyEntry> | undefined;
    let thrown: unknown;
    try {
      firstResult = await iterator.next();
    } catch (error) {
      thrown = error;
    }

    expect(firstResult).toBeUndefined();
    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamManifestError);

    // Non-vacuity: this directory genuinely still holds entries that a lazy
    // implementation COULD have yielded first, so the assertion above is
    // about ordering rather than about an empty trail.
    const tolerated = archivalRecorder();
    const survivors = await collectEntries(
      new M3LAppendOnlyStream({ directory: dir }).read({
        onArchivedSegment: tolerated.onArchivedSegment,
      }),
    );
    expect(survivors.length).toBeGreaterThan(0);
  });

  // INVARIANT (the other half of the same contract): supplying a handler
  // changes the CHANNEL, never the timing. Every `onArchivedSegment` call
  // must land before the first entry is yielded, for exactly the reason the
  // handler-less throw does: the archival scan needs only the manifest and
  // the directory listing, no segment bytes at all, so it can resolve up
  // front — and a caller must not have to consume a partial trail before
  // learning the trail is incomplete. Eagerness here is a decided contract,
  // not an implementation accident.
  //
  // Falsifiable by construction: archived segments AND surviving entries
  // both exist in this fixture, and the handler and the consuming loop push
  // into ONE shared ordered log, so a lazy implementation that reported
  // archival as it walked — interleaved with, or after, the entries it
  // yielded — produces a log whose marker kinds are out of order and fails
  // the `toEqual` below. W2 and W4 sort payloads before comparing and so
  // cannot see this at all, and a count-only assertion would pass under
  // either policy. The order AMONG the archival calls is deliberately left
  // unpinned (asserted separately, sorted): the contract is that they all
  // precede the entries, not which one comes first.
  test("calls onArchivedSegment for every absent segment before yielding the first entry", async () => {
    const dir = path.join(workDir, "audit");
    const { dayTwoEntries } = await buildRolledOverTrail(dir, 2, 2);
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    expect(dayOneSegments).toHaveLength(2);
    // Precondition: the manifest claims every one of them, so each deletion
    // below is a reportable finding rather than an unsealed gap.
    expect(sealedSegmentNames(await readManifestLines(dir))).toEqual(
      expect.arrayContaining([...dayOneSegments]),
    );

    await deleteSegments(dir, dayOneSegments);

    const log: {
      readonly kind: "archived" | "entry";
      readonly segment?: string;
    }[] = [];
    const recovered: M3LAppendOnlyEntry[] = [];
    const reader = new M3LAppendOnlyStream({ directory: dir });
    for await (const entry of reader.read({
      onArchivedSegment: (segment) => {
        log.push({ kind: "archived", segment: segment.segment });
      },
    })) {
      recovered.push(entry);
      log.push({ kind: "entry" });
    }

    // Non-vacuity: both marker kinds are genuinely present — surviving
    // entries a lazy implementation COULD have yielded first, and archival
    // findings it could have reported late — so the ordering assertion is
    // about interleaving rather than about an empty trail or a silent read.
    expect(recovered).toEqual(dayTwoEntries);
    expect(log.map((marker) => marker.kind)).toEqual([
      ...dayOneSegments.map(() => "archived"),
      ...dayTwoEntries.map(() => "entry"),
    ]);
    expect(
      log
        .filter((marker) => marker.kind === "archived")
        .map((marker) => marker.segment)
        .sort(),
    ).toEqual([...dayOneSegments].sort());
  });
});

// ---------------------------------------------------------------------------
// W4 — a date's deleted LAST segment
// ---------------------------------------------------------------------------

describe("a date's highest-sequence sealed segment deleted", () => {
  // INVARIANT: this is the headline capability. `assertNoSequenceGap`'s own
  // TSDoc concedes it "cannot detect the deletion of a date's own LAST
  // segment (the remaining ones are still perfectly contiguous starting at
  // 1)" — so the segments left behind are, by construction, indistinguishable
  // from a shorter but complete date. Only the manifest's claim about the
  // missing name closes that, which is why the error raised must be the
  // MANIFEST error: a read error here would mean the sequence walk somehow
  // produced it, which it cannot.
  test("throws the manifest error even though the survivors remain contiguous from 1", async () => {
    const dir = path.join(workDir, "audit");
    await buildRolledOverTrail(dir, 3, 2);
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    const lastDayOneSegment = definedOrThrow(
      dayOneSegments.at(-1),
      "day one's highest-sequence segment",
    );
    expect(sealedSegmentNames(await readManifestLines(dir))).toContain(
      lastDayOneSegment,
    );

    await deleteSegments(dir, [lastDayOneSegment]);

    // Precondition: what is left of day one really is contiguous from 1, so
    // nothing but the manifest could have raised the alarm.
    const listing = await new M3LAppendOnlyStream({
      directory: dir,
    }).listSegments();
    expect(
      listing.segments
        .filter((segment) => segment.datePrefix === DAY_ONE)
        .map((segment) => segment.sequence),
    ).toEqual([1, 2]);

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { thrown } = await collectUntilThrow(reader.read());

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
  });

  test("reports that one segment's claim to a supplied handler and reads on", async () => {
    const dir = path.join(workDir, "audit");
    const { dayOneEntries, dayTwoEntries } = await buildRolledOverTrail(
      dir,
      3,
      2,
    );
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    const lastDayOneSegment = definedOrThrow(
      dayOneSegments.at(-1),
      "day one's highest-sequence segment",
    );
    const expectedClaim = sealClaimFor(
      await readManifestLines(dir),
      lastDayOneSegment,
    );

    await deleteSegments(dir, [lastDayOneSegment]);

    const recorder = archivalRecorder();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(
      reader.read({ onArchivedSegment: recorder.onArchivedSegment }),
    );

    // `maxSegmentBytes: 1` puts exactly one entry in each segment, so the
    // deleted segment costs exactly day one's last entry.
    expect(recovered).toEqual([
      ...dayOneEntries.slice(0, -1),
      ...dayTwoEntries,
    ]);
    expect(recorder.calls).toEqual([expectedClaim]);
  });
});

// ---------------------------------------------------------------------------
// W5 — an unsealed gap keeps today's error, byte for byte
// ---------------------------------------------------------------------------

describe("a gap the manifest makes no claim about", () => {
  // INVARIANT: a missing segment the manifest never sealed (a crash before
  // the seal was written, a seal write that failed) is NOT an archival — it
  // is the unaccounted-for data loss `assertNoSequenceGap` already reports,
  // and it must keep reporting it in exactly the same words and with exactly
  // the same context. Operators and log greps depend on this wording, so the
  // message is asserted as a literal rather than a pattern.
  //
  // The fixture removes the seal LINE before deleting the file, which is
  // what makes the two cases distinguishable at all: same deletion, no
  // claim, therefore the old error rather than the new one.
  //
  // This test passes against the pre-archival reader, and that is expected:
  // it is a REGRESSION LOCK on wording and context that must survive the
  // new manifest consultation, not a proof of the new capability. Once the
  // capability exists it does discriminate — an implementation that
  // escalated any absent segment, claimed or not, would raise the manifest
  // error here instead.
  test("throws M3LAppendOnlyStreamReadError with the existing message and context", async () => {
    const dir = path.join(workDir, "audit");
    await buildRolledOverTrail(dir, 2, 3);
    const dayTwoSegments = await segmentNamesFor(dir, DAY_TWO);
    expect(dayTwoSegments).toHaveLength(3);
    const holed = definedOrThrow(dayTwoSegments[1], "day two's middle segment");

    const lines = await readManifestLines(dir);
    await writeManifestLines(
      dir,
      lines.filter((line) => !isSealLineFor(line, holed)),
    );
    // Precondition: the manifest now states nothing about the segment about
    // to be deleted, so the archival path has no claim to escalate.
    expect(sealedSegmentNames(await readManifestLines(dir))).not.toContain(
      holed,
    );
    await deleteSegments(dir, [holed]);

    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { thrown } = await collectUntilThrow(reader.read());

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect((thrown as M3LAppendOnlyStreamReadError).message).toBe(
      SEQUENCE_GAP_MESSAGE,
    );
    expect((thrown as M3LAppendOnlyStreamReadError).context).toEqual({
      datePrefix: DAY_TWO,
      expectedSequence: 2,
      foundSequence: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// W6 — tolerated archival does not suppress a real gap
// ---------------------------------------------------------------------------

describe("an archived segment and an unsealed gap in the same trail", () => {
  // INVARIANT: tolerating an archival tolerates THAT archival, never the
  // whole integrity check. The implementation this discriminates against is
  // the plausible one: having reconciled the manifest against the directory,
  // skip the sequence walk for any date that lost a segment (or for the
  // trail as a whole) because "the absence is already explained". Such an
  // implementation passes W2 and W4 and loses the data-loss signal entirely,
  // which is the more serious of the two findings.
  //
  // Call ORDER between the tolerated report and the throw is deliberately
  // not pinned — the contract states eagerness (W3), not interleaving.
  test("still throws the sequence-gap error with onArchivedSegment supplied", async () => {
    const dir = path.join(workDir, "audit");
    await buildRolledOverTrail(dir, 3, 3);

    // Half one: a genuine archival — day one's last segment, still sealed.
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    const archived = definedOrThrow(
      dayOneSegments.at(-1),
      "day one's highest-sequence segment",
    );
    expect(sealedSegmentNames(await readManifestLines(dir))).toContain(
      archived,
    );

    // Half two: an unsealed hole — day two's middle segment, with its seal
    // record removed first so it can never read as an archival.
    const dayTwoSegments = await segmentNamesFor(dir, DAY_TWO);
    const holed = definedOrThrow(dayTwoSegments[1], "day two's middle segment");
    const lines = await readManifestLines(dir);
    await writeManifestLines(
      dir,
      lines.filter((line) => !isSealLineFor(line, holed)),
    );
    await deleteSegments(dir, [archived, holed]);

    const recorder = archivalRecorder();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const { thrown } = await collectUntilThrow(
      reader.read({ onArchivedSegment: recorder.onArchivedSegment }),
    );

    expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamReadError);
    expect((thrown as M3LAppendOnlyStreamReadError).context).toEqual({
      datePrefix: DAY_TWO,
      expectedSequence: 2,
      foundSequence: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// W7 — a manifest that exists and cannot be read is fatal
// ---------------------------------------------------------------------------

describe("a corrupt manifest with every segment present and intact", () => {
  // INVARIANT: a sidecar that exists but cannot be parsed stops the read.
  // This is the decided tradeoff, and the reason it falls this way is that
  // the alternative is worse: tolerating the corruption would let a single
  // bad byte disable archival detection for the entire trail, silently, at
  // exactly the moment someone may have written that byte on purpose.
  //
  // The bad line is newline-TERMINATED, so it can never be excused as the
  // torn tail the manifest reader tolerates unconditionally — it is a
  // complete record that is not a record.
  //
  // Both rows matter: a handler supplied is the tolerating caller, and
  // tolerating an archival must not extend to tolerating an unreadable
  // sidecar.
  test.each([
    ["no options at all", false],
    ["a handler supplied", true],
  ] as [string, boolean][])(
    "throws the manifest error with %s",
    async (_label, withHandler) => {
      const dir = path.join(workDir, "audit");
      await buildRolledOverTrail(dir, 2, 2);
      const lines = await readManifestLines(dir);
      await writeManifestLines(dir, [...lines, "{ not valid json"]);

      const recorder = archivalRecorder();
      const reader = new M3LAppendOnlyStream({ directory: dir });
      const { thrown } = await collectUntilThrow(
        withHandler
          ? reader.read({ onArchivedSegment: recorder.onArchivedSegment })
          : reader.read(),
      );

      expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    },
  );
});

// ---------------------------------------------------------------------------
// W8 — an absent manifest reads exactly as before
// ---------------------------------------------------------------------------

describe("no manifest in the directory", () => {
  // This test pins an ACCEPTED BLIND SPOT, not a safety property. From
  // inside the directory, a manifest that was deleted and a trail that never
  // sealed anything are the same observation, so archival detection is
  // simply off here: a reader looking at these bytes cannot tell whether
  // segments are missing, and says nothing. That asymmetry is the price of
  // keeping a pre-sidecar trail readable at all; anyone who can delete the
  // segments can delete the sidecar alongside them, and the defence against
  // that lives outside this library (filesystem permissions, an offsite
  // copy of the manifest), not in `read()`.
  test("reads every entry and never calls onArchivedSegment", async () => {
    const dir = path.join(workDir, "audit");
    const { dayOneEntries, dayTwoEntries } = await buildRolledOverTrail(
      dir,
      2,
      2,
    );
    await rm(path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME));

    const recorder = archivalRecorder();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(
      reader.read({ onArchivedSegment: recorder.onArchivedSegment }),
    );

    expect(recovered).toEqual([...dayOneEntries, ...dayTwoEntries]);
    expect(recorder.calls).toEqual([]);
  });

  // The same blind spot, stated where it bites: with the sidecar gone, a
  // deleted whole date — the exact fixture W2 escalates on — reads clean.
  test("a whole deleted date reads short and silent once the manifest is gone", async () => {
    const dir = path.join(workDir, "audit");
    const { dayTwoEntries } = await buildRolledOverTrail(dir, 2, 2);
    const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
    await deleteSegments(dir, dayOneSegments);
    await rm(path.join(dir, M3L_APPEND_ONLY_MANIFEST_NAME));

    const recorder = archivalRecorder();
    const reader = new M3LAppendOnlyStream({ directory: dir });
    const recovered = await collectEntries(
      reader.read({ onArchivedSegment: recorder.onArchivedSegment }),
    );

    expect(recovered).toEqual(dayTwoEntries);
    expect(recorder.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W9 — handler validation polarity
// ---------------------------------------------------------------------------

describe("option validation: onArchivedSegment callable guard", () => {
  // INVARIANT: a truthy non-function is rejected at the boundary with a
  // machine-readable diagnostic, for the same reason `onTruncatedTail` is:
  // the escalation fires via an optional call, and a string or a plain
  // object would short-circuit that call and suppress the only signal the
  // caller asked for.
  test.each([
    ["string", "not-a-function"],
    ["number", 42],
    ["plain object", { notACallback: true }],
  ] as [string, unknown][])(
    "throws M3LError(ERR_INVALID_ARGUMENT) for a truthy non-function onArchivedSegment: %s",
    (_label, value) => {
      const reader = new M3LAppendOnlyStream({ directory: workDir });
      let thrown: unknown;
      try {
        reader.read({
          onArchivedSegment: value,
        } as unknown as M3LAppendOnlyReadOptions);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
      expect((thrown as M3LError).context).toEqual({
        field: "onArchivedSegment",
        violation: "not-a-function",
      });
    },
  );

  // INVARIANT: the rejection is SYNCHRONOUS, at the `read()` call itself.
  // `read()` is a plain method, not an async generator, so validation runs
  // before the iterable is built — a lazy rejection would not be caught by
  // this synchronous form at all.
  test("throws synchronously, before any iteration begins", () => {
    const reader = new M3LAppendOnlyStream({ directory: workDir });
    let thrown: unknown;
    try {
      // Nothing is awaited and the returned iterable is never iterated, so
      // the only failure this frame can observe at all is a synchronous
      // one; a validation deferred into the generator would leave `thrown`
      // undefined here (and surface as an unhandled rejection instead).
      reader.read({
        onArchivedSegment: "eager-throw-probe",
      } as unknown as M3LAppendOnlyReadOptions);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LError | undefined)?.context).toEqual({
      field: "onArchivedSegment",
      violation: "not-a-function",
    });
  });

  // INVARIANT: a FALSY non-function degrades to the THROWING path — the
  // no-handler behaviour — and is never treated as a present-but-uncallable
  // handler. The failure this rules out is the silent one: `null` passed
  // through as a "handler", invoked with `?.()`, no escalation reported and
  // no error raised, so a deleted date reads clean.
  test.each([
    ["null", null],
    ["zero", 0],
  ] as [string, unknown][])(
    "escalates as if no handler were supplied for a falsy onArchivedSegment: %s",
    async (_label, value) => {
      const dir = path.join(workDir, "audit");
      await buildRolledOverTrail(dir, 2, 2);
      const dayOneSegments = await segmentNamesFor(dir, DAY_ONE);
      await deleteSegments(dir, dayOneSegments);

      const reader = new M3LAppendOnlyStream({ directory: dir });
      const { thrown } = await collectUntilThrow(
        reader.read({
          onArchivedSegment: value,
        } as unknown as M3LAppendOnlyReadOptions),
      );

      expect(thrown).toBeInstanceOf(M3LAppendOnlyStreamManifestError);
    },
  );
});

// ---------------------------------------------------------------------------
// W10 — the closed-key check stays closed
// ---------------------------------------------------------------------------

describe("option validation: the read-options bag stays closed", () => {
  // INVARIANT: admitting `onArchivedSegment` widens the permitted key set by
  // exactly one key. The regression this guards is the lazy widening — a
  // permitted-keys check dropped or replaced with "anything callable is
  // fine" — which would make a typo'd option name a silently accepted
  // no-op, exactly what the read-options key set is documented to refuse.
  test("throws ERR_INVALID_ARGUMENT for an unknown own key alongside a valid onArchivedSegment", () => {
    const recorder = archivalRecorder();
    const reader = new M3LAppendOnlyStream({ directory: workDir });

    // The permitted set grew by EXACTLY one key. Asserting the accepted
    // half here as well as the rejected half is what stops this test
    // passing for the wrong reason: against a reader that has not learned
    // `onArchivedSegment` at all, the rejection below fires over the valid
    // key rather than the typo'd one.
    expect(() => {
      reader.read({ onArchivedSegment: recorder.onArchivedSegment });
    }).not.toThrow();

    let thrown: unknown;
    try {
      reader.read({
        onArchivedSegment: recorder.onArchivedSegment,
        onArchivedSegments: recorder.onArchivedSegment,
      } as unknown as M3LAppendOnlyReadOptions);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).context).toEqual({
      field: "options",
      violation: "unknown-key",
    });
  });
});
