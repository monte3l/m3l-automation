/**
 * Tests for `internal/storage/append-only-manifest-records` — the RECORD half
 * of the sealed-segment manifest of ADR-0102 (X8b slice 4): the shapes a
 * `manifest.jsonl` is made of, the rules that admit or refuse one of them, and
 * `collectRecords`, the fold of many already-framed lines into what one
 * manifest states.
 *
 * The two suites mirror the two modules, and that is the whole rule for where
 * a new test goes — no one should have to measure a file to decide. This suite
 * owns the RECORD: a record's shape, its `formatVersion`, its measurement, the
 * forward-compatibility rule on `kind`, and the fold of many records into one
 * manifest's contents. Two record rules are the known exception and are still
 * pinned in the FILE suite — `duplicate seals` and `inherited field reads` —
 * so look there before concluding a rule is untested.
 * `storage-append-only-manifest.test.ts` owns the FILE: its name and its
 * invisibility to the segment layer, baseline initialization, the bounded
 * guarded read and its ceiling, the torn tail that reader frames, and the
 * append.
 *
 * One rule is deliberately pinned across BOTH files, because it is one rule
 * about two things: a malformed or too-new record is FATAL here, while the
 * identical bytes arriving as an unterminated TORN tail are ignored there. The
 * tolerance is safe only because of the fatality; each side names the other so
 * nobody changes one half alone.
 *
 * The two halves are also exercised at the two boundaries they are met at. The
 * fold takes lines, not a file, so it is called directly with the terminators
 * already stripped — ordering, seal keying and last-wins pinned with no
 * filesystem in the picture at all. A shape rule, by contrast, governs bytes
 * somebody else wrote, so those tests read a real manifest out of a real
 * `mkdtemp` sandbox through the genuine `node:fs`: a fixture built from
 * anything but real bytes would assert this suite's idea of the format rather
 * than the format. Nothing in this file is mocked.
 *
 * The record TYPES are pinned here too, because this module is where they are
 * declared — `./append-only-manifest.js` only re-exports them. They are a real
 * part of the contract, not a restatement of the runtime assertions: a seal
 * record must carry the digest's measurement VERBATIM (so a sealer can hand one
 * straight through), the two kinds must stay discriminated by `kind`, and a
 * baseline's `upTo` must stay a segment name or an EXPLICIT `null` — what keeps
 * "sealed since the first segment" distinguishable from a boundary nobody ever
 * stated.
 *
 * A new sibling file on purpose: `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings as unmatched by
 * design.
 *
 * @packageDocumentation
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { SegmentDigestResult } from "../src/internal/storage/append-only-digest.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";
import {
  M3L_APPEND_ONLY_MANIFEST_NAME,
  readManifest,
} from "../src/internal/storage/append-only-manifest.js";
import {
  MANIFEST_FORMAT_VERSION,
  collectRecords,
} from "../src/internal/storage/append-only-manifest-records.js";
import type {
  ManifestBaselineRecord,
  ManifestContents,
  ManifestSealRecord,
} from "../src/internal/storage/append-only-manifest-records.js";

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * A record rule governs bytes somebody else wrote, so the tests that drive one
 * read a real `manifest.jsonl` out of a real per-test sandbox (ADR-0100) —
 * through the genuine `node:fs`, with no module mocked anywhere in this file.
 * A fixture built from anything but real bytes would be asserting this suite's
 * idea of the format rather than the format. The fold is the exception and
 * needs none of this: it takes lines, not a file.
 */
let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "m3l-append-only-records-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * A generous ceiling for the manifest read. Every test here passes this, so a
 * ceiling refusal — a rule of the FILE, tested in the sibling suite — can never
 * be mistaken for the record rule under test.
 */
const AMPLE_MAX_BYTES = 1_048_576;

/**
 * A string no library-computed fact could ever contain. Planted inside a
 * malformed manifest line so a failure that echoes the offending bytes back
 * to the caller is caught, not merely hoped against.
 */
const CALLER_SECRET = "SECRET-CALLER-VALUE-9f2c";

/** The absolute path of the manifest inside the current sandbox. */
function manifestPath(): string {
  return path.join(sandbox, M3L_APPEND_ONLY_MANIFEST_NAME);
}

/** Writes EXACT bytes as the sandbox's manifest. */
async function writeManifestBytes(content: string): Promise<void> {
  await writeFile(manifestPath(), content);
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

/** 64 lowercase hex characters — the documented shape of a seal's `sha256`. */
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** Segment names this writer would itself have produced, oldest first. */
const SEGMENT_OLD = "2026-09-09-0004.jsonl";
const SEGMENT_MID = "2026-09-10-0002.jsonl";
const SEGMENT_NEW = "2026-09-11-0001.jsonl";

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/** One `baseline` line, terminator included. */
function baselineLine(
  upTo: string | null,
  at = "2026-09-11T00:00:00.000Z",
): string {
  return `${JSON.stringify({ kind: "baseline", formatVersion: MANIFEST_FORMAT_VERSION, at, upTo })}\n`;
}

/**
 * One `baseline` line at an arbitrary `formatVersion` — the only fixture that
 * needs to state the version explicitly, so {@link baselineLine} stays the
 * single-argument shape every other test reads better with.
 */
function baselineLineAtVersion(
  formatVersion: number,
  upTo: string | null,
): string {
  return `${JSON.stringify({ kind: "baseline", formatVersion, at: "2026-09-11T00:00:00.000Z", upTo })}\n`;
}

/** One `seal` line, terminator included; every field overridable. */
function sealLine(overrides: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({
    kind: "seal",
    formatVersion: MANIFEST_FORMAT_VERSION,
    at: "2026-09-11T01:00:00.000Z",
    segment: SEGMENT_NEW,
    entryCount: 128,
    byteLength: 8_388_012,
    sha256: SHA_A,
    ...overrides,
  })}\n`;
}

/** One failure the module asked its {@link AppendOnlyReadFailure} port for. */
interface RecordedFailure {
  readonly message: string;
  readonly cause: unknown;
  readonly context: Readonly<Record<string, unknown>>;
  readonly error: M3LError;
}

/** An {@link AppendOnlyReadFailure} port that records what it was asked for. */
interface RecordingFailurePort {
  readonly build: AppendOnlyReadFailure;
  readonly calls: RecordedFailure[];
}

/**
 * A real failure port, not a mock of the behaviour under test: it builds a
 * genuine `M3LError` the way an owner would, and keeps every call so a test
 * can assert the module routed its failure THROUGH the port rather than
 * inventing an error class it does not own. The `code` is a test-local
 * sentinel precisely because this module has no say in the real one.
 */
function createFailurePort(): RecordingFailurePort {
  const calls: RecordedFailure[] = [];
  const build: AppendOnlyReadFailure = (message, options) => {
    const context: Record<string, unknown> = { ...options?.context };
    const error = new M3LError(message, {
      code: "ERR_TEST_APPEND_ONLY_MANIFEST",
      cause: options?.cause,
      context,
    });
    calls.push({ message, cause: options?.cause, context, error });
    return error;
  };
  return { build, calls };
}

/**
 * Asserts the module raised its failure through the injected port, and that
 * what it handed the port carries no caller data.
 *
 * The rule here is deliberately LOOSER than the sibling segment-read error's:
 * a segment NAME is permitted in `context`, because it derives from the
 * writer's clock and counter, carries zero caller bytes, and is already
 * public through `listSegments()`. A directory PATH, an entry key and an
 * entry value are not, and neither is any byte of a malformed line.
 */
function expectPortFailure(
  thrown: unknown,
  port: RecordingFailurePort,
): RecordedFailure {
  expect(port.calls.length).toBeGreaterThanOrEqual(1);
  const call = definedOrThrow(port.calls.at(-1), "a recorded port failure");
  // Identity, not shape: an implementation that built its own error and threw
  // that instead would leave `calls` empty above, and one that called the port
  // but threw something else fails right here.
  expect(thrown).toBe(call.error);

  const serializedContext = JSON.stringify(call.context) ?? "";
  for (const secret of [
    sandbox,
    path.dirname(sandbox),
    path.basename(sandbox),
    CALLER_SECRET,
  ]) {
    expect(call.message).not.toContain(secret);
    expect(serializedContext).not.toContain(secret);
  }
  // Keys, not just values: a key like `manifestPath`/`directory` announces
  // caller data even when the value happens to be redacted. `segment` is the
  // sanctioned exception and must survive this check, which is why `name` is
  // absent from the pattern (unlike the digest suite's stricter one).
  for (const key of Object.keys(call.context)) {
    expect(key).not.toMatch(/path|dir/i);
  }
  return call;
}

// ---------------------------------------------------------------------------
// Integrity — the fatal half of the asymmetry
// ---------------------------------------------------------------------------

describe("manifest integrity", () => {
  // The fatal half of the format's most subtle rule. A record this parser
  // cannot read, or one it can NAME but not fully understand, stops the whole
  // read — because an audit reader must never report "verified" for a claim it
  // skipped. Its tolerant twin — the same bytes, arriving as an unterminated
  // TORN tail and therefore ignored — is in
  // `storage-append-only-manifest.test.ts`, where the reader that frames the
  // lines lives. The pair is split across the two files ON PURPOSE, and
  // neither half means anything without the other.
  test("is fatal on a malformed mid-file line", async () => {
    await writeManifestBytes(
      `${baselineLine(null)}not json at all ${CALLER_SECRET}\n${sealLine()}`,
    );
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expectPortFailure(thrown, port);
  });

  test.each([
    ["a JSON number", "42"],
    ["a JSON string", '"a seal"'],
    ["a JSON array", '["kind","seal"]'],
    ["JSON null", "null"],
  ])(
    "is fatal on a mid-file line that parses to %s rather than a record",
    async (_label, body) => {
      await writeManifestBytes(`${baselineLine(null)}${body}\n${sealLine()}`);
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      expectPortFailure(thrown, port);
    },
  );

  test("is fatal on a mid-file seal missing a required field", async () => {
    const withoutSha = `${JSON.stringify({
      kind: "seal",
      formatVersion: MANIFEST_FORMAT_VERSION,
      at: "2026-09-11T01:00:00.000Z",
      segment: SEGMENT_OLD,
      entryCount: 1,
      byteLength: 10,
    })}\n`;
    await writeManifestBytes(`${baselineLine(null)}${withoutSha}${sealLine()}`);
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expectPortFailure(thrown, port);
  });

  test("ignores an unknown kind, for forward compatibility", async () => {
    const unknown = `${JSON.stringify({
      kind: "checkpoint",
      formatVersion: MANIFEST_FORMAT_VERSION,
      at: "2026-09-11T02:00:00.000Z",
      chain: "whatever a later version adds",
    })}\n`;
    await writeManifestBytes(`${baselineLine(null)}${unknown}${sealLine()}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(contents.seals.has(SEGMENT_NEW)).toBe(true);
  });

  test("ignores an unknown kind even at a formatVersion ABOVE the reader's", async () => {
    // The control half of the pair below: forward compatibility on `kind` is
    // what makes the seal rule's strictness a deliberate asymmetry rather
    // than a blanket version check.
    const unknown = `${JSON.stringify({
      kind: "checkpoint",
      formatVersion: MANIFEST_FORMAT_VERSION + 1,
      at: "2026-09-11T02:00:00.000Z",
    })}\n`;
    await writeManifestBytes(`${baselineLine(null)}${unknown}${sealLine()}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(contents.seals.has(SEGMENT_NEW)).toBe(true);
  });

  test("is fatal on a seal whose formatVersion exceeds the reader's, unlike that unknown kind", async () => {
    // The asymmetry is the point: an audit reader must never report
    // "verified" for a claim it skipped, which is what forces readers to
    // upgrade before writers. A record it cannot even name is harmless; a
    // SEAL it cannot fully understand is not.
    await writeManifestBytes(
      `${baselineLine(null)}${sealLine({
        segment: SEGMENT_OLD,
        formatVersion: MANIFEST_FORMAT_VERSION + 1,
      })}`,
    );
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expectPortFailure(thrown, port);
  });

  test("is fatal on a too-new seal even when it is the LAST terminated line", async () => {
    // Tornness, not position, is what buys tolerance. A terminated too-new
    // seal at the end of the file is a complete claim this reader cannot
    // check, so the torn-tail rule must not be widened to cover it.
    await writeManifestBytes(
      `${baselineLine(null)}${sealLine()}${sealLine({
        segment: SEGMENT_MID,
        formatVersion: MANIFEST_FORMAT_VERSION + 7,
      })}`,
    );
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
  });

  test("is fatal on a baseline whose formatVersion exceeds the reader's", async () => {
    // The baseline's `upTo` is what decides which segments classify `legacy`.
    // A reader that merely SKIPPED a baseline it cannot parse would not just
    // miss a record — it would silently mis-classify every segment at or
    // before that boundary, reporting `unsealed` (a false alarm) or `legacy`
    // (a false reassurance) from a claim it never read. Same rule as the seal
    // case above, and the pairing with the ignored unknown `kind` at this very
    // version is what keeps the asymmetry visible: forward compatibility is on
    // `kind` and only `kind`.
    await writeManifestBytes(
      `${baselineLineAtVersion(MANIFEST_FORMAT_VERSION + 1, SEGMENT_OLD)}${sealLine()}`,
    );
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expectPortFailure(thrown, port);
  });

  test("is fatal on a too-new baseline that is the manifest's only record", async () => {
    // The discriminating half: an implementation that ignored the record
    // would resolve with `baseline: undefined` — indistinguishable from a
    // manifest that never had a baseline at all, which is precisely the
    // "unproven before here" boundary going silently missing.
    await writeManifestBytes(
      baselineLineAtVersion(MANIFEST_FORMAT_VERSION + 3, null),
    );
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
  });

  test("accepts a baseline at exactly the reader's formatVersion", async () => {
    await writeManifestBytes(
      baselineLineAtVersion(MANIFEST_FORMAT_VERSION, SEGMENT_OLD),
    );
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      SEGMENT_OLD,
    );
    expect(port.calls).toHaveLength(0);
  });

  test("accepts a seal at exactly the reader's formatVersion", async () => {
    await writeManifestBytes(
      sealLine({ formatVersion: MANIFEST_FORMAT_VERSION }),
    );
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(contents.seals.has(SEGMENT_NEW)).toBe(true);
    expect(port.calls).toHaveLength(0);
  });

  test.each([
    [
      "seal",
      {
        kind: "seal",
        at: "2026-09-11T01:00:00.000Z",
        segment: SEGMENT_OLD,
        entryCount: 1,
        byteLength: 10,
        sha256: SHA_B,
      },
    ],
    [
      "baseline",
      {
        kind: "baseline",
        at: "2026-09-11T00:00:00.000Z",
        upTo: SEGMENT_OLD,
      },
    ],
  ])(
    "is fatal on a %s carrying no formatVersion at all — absent is MALFORMED, not unknown",
    async (_kind, record: Readonly<Record<string, unknown>>) => {
      // The other half of the version rule, and it is not the too-new case in
      // disguise. This reader RECOGNISES the kind, so the record is one whose
      // every field it intends to act on — and it cannot even state which
      // format those fields are in. Treating that as the ignorable
      // unknown-`kind` case would hand a tamperer a one-field edit that
      // neutralizes any claim: delete `formatVersion` and the seal reads as
      // absent (its segment "unsealed", no failure raised), or the baseline
      // does (its boundary silently unstated). Incomplete is fatal; only an
      // unrecognised `kind` is skipped.
      await writeManifestBytes(`${JSON.stringify(record)}\n${sealLine()}`);
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      expectPortFailure(thrown, port);
    },
  );

  test("ignores an unknown kind carrying no formatVersion either, which is what makes the rule above about the KIND", async () => {
    // The discriminating twin of the two rows above: byte for byte the same
    // omission, and the only difference is whether this reader knows the
    // `kind`. Both arms are reachable in one manifest here — the unknown
    // record is skipped while the known records around it are parsed — so an
    // implementation that threw for either one, or skipped either one, fails.
    const unknown = `${JSON.stringify({
      kind: "checkpoint",
      at: "2026-09-11T02:00:00.000Z",
      chain: "whatever a later version adds",
    })}\n`;
    await writeManifestBytes(`${baselineLine(null)}${unknown}${sealLine()}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBeNull();
    expect(contents.seals.has(SEGMENT_NEW)).toBe(true);
  });

  test.each([
    [
      "no `at` field",
      { kind: "baseline", formatVersion: MANIFEST_FORMAT_VERSION, upTo: null },
    ],
    [
      "a non-string `at`",
      {
        kind: "baseline",
        formatVersion: MANIFEST_FORMAT_VERSION,
        at: 20_260_911,
        upTo: SEGMENT_OLD,
      },
    ],
    [
      "no `upTo` field at all",
      {
        kind: "baseline",
        formatVersion: MANIFEST_FORMAT_VERSION,
        at: "2026-09-11T00:00:00.000Z",
      },
    ],
    [
      "a numeric `upTo`",
      {
        kind: "baseline",
        formatVersion: MANIFEST_FORMAT_VERSION,
        at: "2026-09-11T00:00:00.000Z",
        upTo: 42,
      },
    ],
    [
      "a boolean `upTo`",
      {
        kind: "baseline",
        formatVersion: MANIFEST_FORMAT_VERSION,
        at: "2026-09-11T00:00:00.000Z",
        upTo: false,
      },
    ],
    [
      "a forged `upTo` that is not a segment name at all",
      {
        kind: "baseline",
        formatVersion: MANIFEST_FORMAT_VERSION,
        at: "2026-09-11T00:00:00.000Z",
        upTo: "archive-2026-09.tar",
      },
    ],
    [
      "a shape-valid but calendar-invalid `upTo`",
      // `9999-99-99` matches the segment pattern's digit shape but names no
      // real Gregorian date. `parseSegmentName` was tightened in this same
      // slice to refuse it, so this row is the join between that fix and
      // this one: `upTo` must name a segment `parseSegmentName` itself would
      // accept, not merely a string of the right length and punctuation.
      {
        kind: "baseline",
        formatVersion: MANIFEST_FORMAT_VERSION,
        at: "2026-09-11T00:00:00.000Z",
        upTo: "9999-99-99-9999.jsonl",
      },
    ],
  ])(
    "is fatal on a baseline with %s",
    async (_shape, record: Readonly<Record<string, unknown>>) => {
      // `upTo` is required AND explicitly nullable, which is why an absent
      // field and a `null` are different statements rather than two spellings
      // of one: `null` asserts "sealed since the first segment", while an
      // absent field is a boundary nobody ever stated. A writer serializing
      // `upTo: undefined` produces exactly the "no `upTo` field" row, which
      // is why that row exists and why it must not be admitted as `null`. A
      // value of some other type is not a segment name either — accepting it
      // would let `legacy` classification be decided by a number.
      await writeManifestBytes(`${JSON.stringify(record)}\n${sealLine()}`);
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      expectPortFailure(thrown, port);
    },
  );

  test("accepts a baseline whose upTo is an explicit null, the shape those refusals must not catch", async () => {
    // The positive control for the rows above: the refusal is about `upTo`
    // being absent or of the wrong type, never about it being falsy. Without
    // this, an implementation that rejected `null` outright would still pass
    // every row above.
    await writeManifestBytes(baselineLine(null));
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBeNull();
    expect(port.calls).toHaveLength(0);
  });

  test("accepts a baseline whose upTo names a genuine segment, the positive control for the forged-string and calendar-invalid rows above", async () => {
    await writeManifestBytes(baselineLine(SEGMENT_OLD));
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      SEGMENT_OLD,
    );
    expect(port.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A record's measurement, admitted on shape alone
// ---------------------------------------------------------------------------

describe("seal measurement shape", () => {
  // Admitted on SHAPE, never on type alone, and a violation takes the fatal
  // path a MISSING field takes, not a silent skip — a seal whose measurement
  // cannot be trusted is worse than no seal at all, because an audit reader
  // would go on to report it as "verified".
  //
  // Uppercase is refused rather than folded, which looks pedantic and is not:
  // lowercase is what `createHash(...).digest("hex")` emits and what
  // `sha256sum` reproduces, so an uppercase digest is one no honest writer of
  // this format produced. Folding the case would admit a line this library
  // could not have written, and would stop the stored bytes being comparable
  // to the ones an operator re-computes by hand.
  //
  // The torn-tail twin of the uppercase row — the same bytes, unterminated and
  // therefore ignored — is in `storage-append-only-manifest.test.ts`, because
  // what it exercises is the reader's framing rather than this shape check.
  test.each([
    ["an empty sha256", { sha256: "" }],
    ["a 63-char sha256", { sha256: "a".repeat(63) }],
    ["a 65-char sha256", { sha256: "a".repeat(65) }],
    ["an UPPERCASE sha256", { sha256: SHA_A.toUpperCase() }],
    ["a non-hex sha256", { sha256: `${"a".repeat(63)}z` }],
    ["a negative entryCount", { entryCount: -1 }],
    ["a negative byteLength", { byteLength: -1 }],
  ])(
    "is fatal on a mid-file seal stating %s",
    async (_label, overrides: Readonly<Record<string, unknown>>) => {
      await writeManifestBytes(
        `${sealLine({ segment: SEGMENT_OLD, ...overrides })}${sealLine()}`,
      );
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
      );

      expectPortFailure(thrown, port);
    },
  );

  test("accepts a seal stating ZERO counts", async () => {
    // The positive control for the two count rows above, and the only thing
    // that separates "non-negative" from "positive". An empty sealed segment
    // is legitimate — a segment can be rotated having taken no entry — and the
    // digest of one states `entryCount: 0, byteLength: 0`. Without this case
    // an implementation that tightened its guard to `> 0` would pass every
    // rejection row above while silently refusing that segment's seal, which
    // is the one failure mode a table of negatives cannot catch.
    await writeManifestBytes(sealLine({ entryCount: 0, byteLength: 0 }));
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(
      definedOrThrow(contents.seals.get(SEGMENT_NEW), "the seal"),
    ).toMatchObject({ entryCount: 0, byteLength: 0, sha256: SHA_A });
  });
});

// ---------------------------------------------------------------------------
// The fold, at its own boundary
// ---------------------------------------------------------------------------

describe("collectRecords", () => {
  test("folds lines in order, keying seals by segment, last-wins on a repeat", () => {
    // The fold at its own boundary, over lines the reader hands it with the
    // terminator stripped. A repeat is last-wins: agreeing seals differ only
    // in `at`, so `at` says which was kept.
    const port = createFailurePort();

    const contents = collectRecords(
      [
        sealLine({ segment: SEGMENT_OLD }),
        baselineLine(null),
        sealLine({ segment: SEGMENT_MID, sha256: SHA_B }),
        sealLine({ segment: SEGMENT_OLD, at: "2026-09-11T05:00:00.000Z" }),
        baselineLine(SEGMENT_MID),
      ].map((line) => line.trimEnd()),
      port.build,
    );

    expect([...contents.seals.keys()]).toEqual([SEGMENT_OLD, SEGMENT_MID]);
    expect(definedOrThrow(contents.seals.get(SEGMENT_OLD), "the seal").at).toBe(
      "2026-09-11T05:00:00.000Z",
    );
    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      SEGMENT_MID,
    );
    expect(port.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

describe("manifest record types", () => {
  test("a seal record carries the digest's measurement verbatim", () => {
    // Assignability, not equality: a seal record carries `kind`, `at`,
    // `formatVersion` and `segment` on TOP of the digest's three fields, so
    // `toEqualTypeOf` would be a different — and false — claim.
    expectTypeOf<ManifestSealRecord>().toExtend<SegmentDigestResult>();
    expectTypeOf<ManifestSealRecord>().toExtend<{
      readonly segment: string;
    }>();
  });

  test("the two record kinds are discriminated by `kind`", () => {
    expectTypeOf<ManifestSealRecord["kind"]>().toEqualTypeOf<"seal">();
    expectTypeOf<ManifestBaselineRecord["kind"]>().toEqualTypeOf<"baseline">();
  });

  test("a baseline's upTo is a segment name or an explicit null", () => {
    expectTypeOf<ManifestBaselineRecord["upTo"]>().toEqualTypeOf<
      string | null
    >();
  });

  test("contents expose the baseline optionally and the seals by segment name", () => {
    expectTypeOf<ManifestContents["baseline"]>().toEqualTypeOf<
      ManifestBaselineRecord | undefined
    >();
    expectTypeOf<ManifestContents["seals"]>().toEqualTypeOf<
      ReadonlyMap<string, ManifestSealRecord>
    >();
  });
});
