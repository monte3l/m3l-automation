/**
 * Tests for `internal/storage/append-only-manifest` — the sealed-segment
 * manifest of ADR-0102 (X8b slice 4): the directory-wide, append-only
 * `manifest.jsonl` that makes whole-date archival provable. This module owns
 * that file's bounded guarded read and its append.
 *
 * The two suites mirror the two modules, and that is the whole rule for where
 * a new test goes — no one should have to measure a file to decide. This suite
 * owns the FILE: its name and its invisibility to the segment layer, baseline
 * initialization, the bounded guarded read and its ceiling, the torn tail this
 * reader frames, and the append.
 * `storage-append-only-manifest-records.test.ts` owns the RECORD: a record's
 * shape, its `formatVersion`, its measurement, and how repeated records fold
 * together.
 *
 * Two record rules are still pinned here rather than there — `duplicate seals`
 * and `inherited field reads` — and they are a known exception, not the
 * boundary: both state a rule of the parser, and both would read better beside
 * it. Neither module owns the decision of WHEN to seal — that is the sealer, a
 * later slice — so nothing here drives a rotation.
 *
 * Three properties carry the whole design and are pinned hardest:
 *
 * 1. **The name is invisible to the segment layer.** `manifest.jsonl` is not
 *    matched by `SEGMENT_NAME_PATTERN`, so it enters no inventory, no byte
 *    total and no `skipped` count. Asserted by driving the REAL segment-layer
 *    functions (`listSegmentFiles`, `discoverActiveSegment`, and the public
 *    `listSegments()` / `read()`) over a directory that contains one — the
 *    only assertion that would catch someone widening the pattern.
 * 2. **A torn LAST line is ignored unconditionally**, and that tolerance is
 *    safe only because the identical bytes anywhere else are FATAL. The two
 *    halves of that asymmetry are pinned in two files by design: tornness is
 *    framing, which only this reader can see, so it is tested here over real
 *    unterminated bytes; the fatal half — a malformed mid-file line, a record
 *    at a `formatVersion` above the reader's — belongs to the record parser
 *    and is pinned in `storage-append-only-manifest-records.test.ts`. A reader
 *    meeting either half alone is meeting half a rule; changing one without
 *    the other is how the pair gets broken.
 * 3. **Duplicate seals are compared field by field, never line by line.**
 *    `at` differs by construction between two writers sealing one segment, so
 *    an implementation comparing whole lines manufactures a false positive.
 *    The tolerance test therefore uses two same-claim seals whose `at`
 *    differ — it fails a whole-line comparison — while disagreement on any of
 *    `(entryCount, byteLength, sha256)` throws.
 *
 * Everything here is a property of real bytes on a real filesystem — a real
 * symlink, a real hardlink, a real missing file, a real torn tail — so this
 * suite uses a REAL per-test `mkdtemp` sandbox throughout (ADR-0100) and
 * reads and writes every one of them through the genuine `node:fs`. A mocked
 * read would be asserting the mock's idea of the bytes, which is exactly the
 * thing under test.
 *
 * ONE call is wrapped: `readdir`, as an inert pass-through that is armed by
 * the single test needing the segment listing to fail while the baseline's
 * `upTo` is being chosen. That fault cannot be staged with real bytes — the
 * nearest approximation, a directory stripped of read permission, is a no-op
 * for root and would make the test silently vacuous in some environments —
 * and it is the only `node:fs` behaviour here not produced by the filesystem
 * itself. Unarmed (every other test in this file, and every `mkdtemp`,
 * `open`, `read`, `lstat` and `write` in all of them) the wrapper is the real
 * call.
 *
 * A new sibling file on purpose: `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings as unmatched by
 * design.
 *
 * @packageDocumentation
 */

import type * as FsPromises from "node:fs/promises";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { M3LAppendOnlyStream } from "../src/core/storage/index.js";
import type { M3LAppendOnlyEntry } from "../src/core/storage/index.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";
import {
  M3L_APPEND_ONLY_MANIFEST_NAME,
  MANIFEST_FORMAT_VERSION,
  appendSeal,
  loadOrInitializeManifest,
  readManifest,
} from "../src/internal/storage/append-only-manifest.js";
import type { SegmentSealClaim } from "../src/internal/storage/append-only-manifest.js";
import {
  discoverActiveSegment,
  listSegmentFiles,
} from "../src/internal/storage/append-only-segments.js";

// ---------------------------------------------------------------------------
// The one injected fault
// ---------------------------------------------------------------------------

/**
 * The armed state of the `readdir` wrapper below. `undefined` — the state
 * every test both starts and ends in — makes it a pure pass-through.
 */
const faults = vi.hoisted(() => ({
  listingError: undefined as Error | undefined,
}));

/**
 * `readdir` and nothing else: `importOriginal` keeps every other export — the
 * `mkdtemp`/`writeFile`/`readFile`/`symlink`/`link`/`lstat`/`rm` this file
 * uses and the `open`/`read` the modules under test run — the genuine
 * article. Unarmed, the wrapper forwards to the real `readdir`, so the
 * segment-inventory tests here still read a real directory through the same
 * call they did before this wrapper existed.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  // The single-argument overload is the only one anything in this module
  // family calls, so the wrapper narrows to it rather than reproducing
  // `readdir`'s full overload set.
  const realReaddir: (directory: string) => Promise<string[]> = actual.readdir;
  const readdir = async (directory: string): Promise<string[]> => {
    const { listingError } = faults;
    if (listingError !== undefined) {
      throw listingError;
    }
    return await realReaddir(directory);
  };
  return { ...actual, readdir };
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

afterEach(() => {
  faults.listingError = undefined;
});

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "m3l-append-only-manifest-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * Property names this file may have planted on `Object.prototype`. Cleared
 * UNCONDITIONALLY after every test — a gadget that outlived its own test
 * would silently change how every later record in this file parses.
 */
const PROTOTYPE_GADGETS = ["sha256", "entryCount"] as const;

/**
 * Plants one inherited field on `Object.prototype`, non-enumerably so it
 * cannot reach the module through a spread or a `JSON.stringify` instead of
 * through a plain property read.
 */
function plantPrototypeGadget(
  property: (typeof PROTOTYPE_GADGETS)[number],
  value: unknown,
): void {
  Object.defineProperty(Object.prototype, property, {
    value,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

afterEach(() => {
  for (const property of PROTOTYPE_GADGETS) {
    Reflect.deleteProperty(Object.prototype, property);
  }
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * A generous ceiling for the manifest read. Every test that is not ABOUT the
 * ceiling passes this, so a ceiling refusal can never be mistaken for the
 * behaviour under test.
 */
const AMPLE_MAX_BYTES = 1_048_576;

/** 64 lowercase hex characters — the documented shape of a seal's `sha256`. */
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** Segment names this writer would itself have produced, oldest first. */
const SEGMENT_OLD = "2026-09-09-0004.jsonl";
const SEGMENT_MID = "2026-09-10-0002.jsonl";
const SEGMENT_NEW = "2026-09-11-0001.jsonl";

/**
 * A string no library-computed fact could ever contain, held in
 * {@link expectPortFailure}'s no-caller-data check.
 *
 * No fixture in this suite plants it today: the malformed-line fixture that
 * did moved to `storage-append-only-manifest-records.test.ts` with the parser
 * that refuses it, and the same marker is planted there. It stays armed here
 * because the check it belongs to is about every failure this suite can raise,
 * and the next test to write caller-ish bytes into a manifest must find the
 * guard already in place rather than have to remember to add it.
 */
const CALLER_SECRET = "SECRET-CALLER-VALUE-9f2c";

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * `JSON.parse` at the type it actually promises.
 *
 * The lib signature returns `any`, which makes every parse site an unsafe
 * assignment even when the binding is annotated `unknown` — the annotation
 * narrows what the test may then do with the value, but the RHS is still
 * `any`. Funnelling the one parse in this file through here keeps the
 * value opaque until an assertion says otherwise, with no suppression.
 */
function parseJsonValue(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * `expect.any(String)` as an opaque matcher.
 *
 * Vitest types its asymmetric matchers `any`, so every inline use is an
 * unsafe assignment into whatever literal holds it — the same problem
 * {@link parseJsonValue} solves for a parsed value, and solved the same way,
 * with no suppression. The matcher still matches exactly what it always did:
 * any string, and nothing that is not one.
 */
function anyString(): unknown {
  return expect.any(String) as unknown;
}

/** The absolute path of the manifest inside the current sandbox. */
function manifestPath(): string {
  return path.join(sandbox, M3L_APPEND_ONLY_MANIFEST_NAME);
}

/** Writes EXACT bytes as the sandbox's manifest. */
async function writeManifestBytes(content: string): Promise<void> {
  await writeFile(manifestPath(), content);
}

/** Creates an empty segment-named file in the sandbox. */
async function touchSegment(name: string, content = ""): Promise<void> {
  await writeFile(path.join(sandbox, name), content);
}

/** Reads the manifest back as raw text, for byte-level assertions. */
async function readManifestBytes(): Promise<string> {
  return await readFile(manifestPath(), "utf8");
}

/** The manifest's non-empty lines, in file order. */
async function manifestLines(): Promise<string[]> {
  const text = await readManifestBytes();
  return text.split("\n").filter((line) => line.length > 0);
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

/** A seal claim as the sealer would hand one to {@link appendSeal}. */
function sealClaim(
  overrides: Partial<SegmentSealClaim> = {},
): SegmentSealClaim {
  return {
    segment: SEGMENT_NEW,
    entryCount: 128,
    byteLength: 8_388_012,
    sha256: SHA_A,
    ...overrides,
  };
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

/** Collects a public `read()` into an array. */
async function collect(
  stream: AsyncIterable<M3LAppendOnlyEntry>,
): Promise<M3LAppendOnlyEntry[]> {
  const entries: M3LAppendOnlyEntry[] = [];
  for await (const entry of stream) {
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The file name, and its invisibility to the segment layer
// ---------------------------------------------------------------------------

describe("M3L_APPEND_ONLY_MANIFEST_NAME", () => {
  test("is manifest.jsonl", () => {
    expect(M3L_APPEND_ONLY_MANIFEST_NAME).toBe("manifest.jsonl");
  });

  test("is a name the segment inventory does not see, and does not count as skipped", async () => {
    await touchSegment(SEGMENT_OLD, '{"a":1}\n');
    await touchSegment(SEGMENT_NEW, '{"b":2}\n');
    await writeManifestBytes(baselineLine(null));

    const listing = await listSegmentFiles(sandbox);

    expect(listing.segments.map((segment) => segment.name)).toEqual([
      SEGMENT_OLD,
      SEGMENT_NEW,
    ]);
    // The decisive half: a widened SEGMENT_NAME_PATTERN that matched the
    // manifest would either list it above or, once its shape failed a later
    // check, raise this count. Neither may happen.
    expect(listing.skipped).toBe(0);
  });

  test("is never adopted as the active segment", async () => {
    await writeManifestBytes(baselineLine(null));

    const active = await discoverActiveSegment(sandbox);

    expect(path.basename(active.path)).not.toBe(M3L_APPEND_ONLY_MANIFEST_NAME);
    expect(path.basename(active.path)).toMatch(
      /^\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/,
    );
  });

  test("does not enter the public listSegments() inventory or its skipped count", async () => {
    await touchSegment(SEGMENT_NEW, '{"b":2}\n');
    await writeManifestBytes(baselineLine(SEGMENT_OLD));
    const stream = new M3LAppendOnlyStream({ directory: sandbox });

    const listing = await stream.listSegments();

    expect(listing.segments.map((segment) => segment.name)).toEqual([
      SEGMENT_NEW,
    ]);
    expect(listing.skipped).toBe(0);
  });

  test("is not read as a segment by the public read(), so its records are never yielded", async () => {
    await touchSegment("2026-09-11-0001.jsonl", '{"entry":"kept"}\n');
    // A manifest whose records would decode as perfectly valid JSON entries.
    // If `discoverSegmentsInOrder` ever matched the name, they would appear.
    await writeManifestBytes(`${baselineLine(null)}${sealLine()}`);
    const stream = new M3LAppendOnlyStream({ directory: sandbox });

    const entries = await collect(stream.read());

    expect(entries).toEqual([{ entry: "kept" }]);
  });
});

// ---------------------------------------------------------------------------
// Baseline load-or-initialize
// ---------------------------------------------------------------------------

describe("loadOrInitializeManifest", () => {
  test("writes exactly one baseline naming the HIGHEST existing segment, and digests nothing", async () => {
    await touchSegment(SEGMENT_MID, '{"a":1}\n');
    await touchSegment(SEGMENT_NEW, '{"b":2}\n');
    await touchSegment(SEGMENT_OLD, '{"c":3}\n');
    const port = createFailurePort();

    const contents = await loadOrInitializeManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      port.build,
    );

    const baseline = definedOrThrow(contents.baseline, "the written baseline");
    expect(baseline.kind).toBe("baseline");
    expect(baseline.formatVersion).toBe(MANIFEST_FORMAT_VERSION);
    expect(baseline.upTo).toBe(SEGMENT_NEW);
    // "Digesting nothing" is observable as the absence of any seal: a
    // retro-digest of the three pre-upgrade segments would have to land here.
    expect(contents.seals.size).toBe(0);
    expect(await manifestLines()).toHaveLength(1);
    expect(port.calls).toHaveLength(0);
  });

  test("writes upTo: null when no segment exists, asserting sealing has been in force from the start", async () => {
    const port = createFailurePort();

    const contents = await loadOrInitializeManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      port.build,
    );

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBeNull();
    expect(await manifestLines()).toHaveLength(1);
  });

  test("ignores foreign file names when choosing upTo", async () => {
    await touchSegment("notes.txt", "hello\n");
    await touchSegment("2026-09-11-00005.jsonl", "{}\n"); // over-padded: not ours
    const port = createFailurePort();

    const contents = await loadOrInitializeManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      port.build,
    );

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBeNull();
  });

  test("stamps the baseline with an ISO-8601 instant", async () => {
    const port = createFailurePort();

    const contents = await loadOrInitializeManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      port.build,
    );

    const { at } = definedOrThrow(contents.baseline, "the baseline");
    expect(new Date(at).toISOString()).toBe(at);
  });

  test("writes no second baseline when a manifest is already present", async () => {
    await touchSegment(SEGMENT_NEW, '{"b":2}\n');
    const existing = baselineLine(SEGMENT_OLD, "2026-09-01T00:00:00.000Z");
    await writeManifestBytes(existing);
    const port = createFailurePort();

    const contents = await loadOrInitializeManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      port.build,
    );

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      SEGMENT_OLD,
    );
    // Byte-identical: a second baseline would be a second, contradictory
    // statement about how far back the trail is unproven.
    expect(await readManifestBytes()).toBe(existing);
  });

  test("writes no second baseline when the manifest holds only seals", async () => {
    await writeManifestBytes(sealLine());
    const port = createFailurePort();

    const contents = await loadOrInitializeManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      port.build,
    );

    expect(contents.baseline).toBeUndefined();
    expect(await manifestLines()).toHaveLength(1);
  });

  test("refuses a too-new baseline rather than back-filling a second one", async () => {
    // The failure this guards is specific: if the fatal read were swallowed
    // and treated as "manifest absent", this call would APPEND a second,
    // contradictory baseline over a trail whose real boundary it could not
    // read — turning an upgrade-me error into silent evidence destruction.
    const existing = baselineLineAtVersion(
      MANIFEST_FORMAT_VERSION + 1,
      SEGMENT_OLD,
    );
    await writeManifestBytes(existing);
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      loadOrInitializeManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expect(await readManifestBytes()).toBe(existing);
  });

  test("is idempotent across repeated calls", async () => {
    const port = createFailurePort();

    await loadOrInitializeManifest(sandbox, AMPLE_MAX_BYTES, port.build);
    const first = await readManifestBytes();
    await loadOrInitializeManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(await readManifestBytes()).toBe(first);
  });
});

describe("loadOrInitializeManifest when the directory cannot be listed", () => {
  test("reports the listing failure through the port and writes no baseline at all", async () => {
    // Choosing `upTo` is the one place initialization asks the filesystem a
    // second question, and the answer decides which segments classify
    // `legacy`. A listing failure swallowed into "no segments" would write
    // `upTo: null` — the POSITIVE assertion that sealing has been in force
    // since this stream's first segment — over a directory whose real
    // contents were never seen: a false reassurance stamped permanently into
    // an append-only file. So the failure propagates and nothing is written.
    const listingError = armListingFailure();
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      loadOrInitializeManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    const call = expectPortFailure(thrown, port);
    // Identity of the CHAINED cause, not merely its presence: the raw
    // `readdir` rejection is the only diagnostic an operator has for why the
    // listing failed, and a wrap that dropped it would pass a shape check.
    expect(call.cause).toBe(listingError);
    // Once, not twice: the raw failure is wrapped at the listing boundary and
    // not re-wrapped by an outer catch on the way out.
    expect(port.calls).toHaveLength(1);
    const stillAbsent = await catchRejected(() => readManifestBytes());
    expect(stillAbsent).toMatchObject({ code: "ENOENT" });
  });

  test("resumes reading the real directory once the fault is disarmed", async () => {
    // The pass-through half, asserted rather than assumed: the wrapper is
    // inert outside an armed test, so a later suite reading this sandbox sees
    // the genuine filesystem. Without this, an arming bug that left the fault
    // latched would show up as an unrelated suite failing elsewhere.
    await touchSegment(SEGMENT_OLD);
    const port = createFailurePort();

    const contents = await loadOrInitializeManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      port.build,
    );

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      SEGMENT_OLD,
    );
    expect(port.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reading: the absent and happy cases
// ---------------------------------------------------------------------------

describe("readManifest", () => {
  test("reports an absent manifest as empty rather than as a failure", async () => {
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(contents.baseline).toBeUndefined();
    expect(contents.seals.size).toBe(0);
    expect(port.calls).toHaveLength(0);
  });

  test("returns the baseline and every seal, keyed by segment name", async () => {
    await writeManifestBytes(
      `${baselineLine(SEGMENT_OLD)}${sealLine({ segment: SEGMENT_MID, entryCount: 4, byteLength: 40, sha256: SHA_B })}${sealLine()}`,
    );
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(definedOrThrow(contents.baseline, "the baseline").upTo).toBe(
      SEGMENT_OLD,
    );
    expect([...contents.seals.keys()].sort()).toEqual([
      SEGMENT_MID,
      SEGMENT_NEW,
    ]);
    expect(
      definedOrThrow(contents.seals.get(SEGMENT_NEW), "the new seal"),
    ).toMatchObject({
      kind: "seal",
      formatVersion: MANIFEST_FORMAT_VERSION,
      segment: SEGMENT_NEW,
      entryCount: 128,
      byteLength: 8_388_012,
      sha256: SHA_A,
    });
  });

  test("reports an empty manifest file as empty", async () => {
    await writeManifestBytes("");
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(contents.baseline).toBeUndefined();
    expect(contents.seals.size).toBe(0);
    expect(port.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Torn tails — the half of the asymmetry this reader owns
// ---------------------------------------------------------------------------

describe("torn tails", () => {
  // The tolerant half of the format's most subtle rule, kept here because
  // tornness is a property of the FILE: only the reader that frames the lines
  // can know a line arrived unterminated, and only real unterminated bytes can
  // state it. Its fatal twin — the same malformation, the same too-new record,
  // MID-FILE — is in `storage-append-only-manifest-records.test.ts`, where the
  // parser that refuses it lives. The pair is split across the two files ON
  // PURPOSE, and neither half means anything without the other: ignoring a torn
  // tail is safe only because the identical bytes anywhere else are fatal.
  test("ignores a torn last line unconditionally, so its segment simply reads as unsealed", async () => {
    const torn = sealLine({ segment: SEGMENT_OLD }).slice(0, 40);
    expect(torn.endsWith("\n")).toBe(false); // the fixture really is torn
    await writeManifestBytes(`${baselineLine(null)}${sealLine()}${torn}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    // No throw: a half-written seal claims nothing.
    expect(port.calls).toHaveLength(0);
    expect(contents.seals.has(SEGMENT_NEW)).toBe(true);
    expect(contents.seals.has(SEGMENT_OLD)).toBe(false);
  });

  test("ignores a torn last line even when it is complete JSON but unterminated", async () => {
    const unterminated = sealLine({ segment: SEGMENT_OLD }).trimEnd();
    await writeManifestBytes(`${baselineLine(null)}${unterminated}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    // Terminated-ness, not parseability, is what makes a record a claim: the
    // writer's O_APPEND line is durable only once its newline lands.
    expect(port.calls).toHaveLength(0);
    expect(contents.seals.has(SEGMENT_OLD)).toBe(false);
  });

  test("ignores a torn last line that is a lone fragment in an otherwise empty manifest", async () => {
    await writeManifestBytes('{"kind":"se');
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(contents.seals.size).toBe(0);
  });

  test("tolerates an uppercase sha256 in a TORN last line, because tornness and not shape buys the tolerance", async () => {
    // The format's sharpest asymmetry, and the reason this case sits in the
    // I/O suite while the rejection table it twins with lives in
    // `storage-append-only-manifest-records.test.ts`: what it exercises is the
    // READER's framing, not the record's shape. A mid-file seal stating an
    // uppercase `sha256` is FATAL over there — lowercase is what
    // `createHash(...).digest("hex")` emits and what `sha256sum` reproduces, so
    // an uppercase digest is one no honest writer of this format produced —
    // and yet those very bytes, arriving unterminated, are ignored without a
    // murmur. Tornness and nothing else buys them that tolerance: a
    // half-written seal claims nothing, so its segment simply reads as
    // unsealed.
    const torn = sealLine({
      segment: SEGMENT_OLD,
      sha256: SHA_A.toUpperCase(),
    }).trimEnd();
    expect(torn.endsWith("\n")).toBe(false); // the fixture really is torn
    await writeManifestBytes(`${sealLine()}${torn}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(contents.seals.has(SEGMENT_OLD)).toBe(false);
    // The good line ahead of the torn one must still have been read, or the
    // assertion above would hold for a reader that parsed nothing at all.
    expect(contents.seals.has(SEGMENT_NEW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate seals — compared field by field, never line by line
// ---------------------------------------------------------------------------

describe("duplicate seals", () => {
  test("tolerates two seals for one segment that agree on the claim but differ in `at`", async () => {
    // THE anti-whole-line-comparison test. Two writers sealing one segment
    // stamp different instants by construction, so an implementation that
    // compared the two lines (or their JSON text) would report a false
    // disagreement here and fail.
    const first = sealLine({ at: "2026-09-11T01:00:00.000Z" });
    const second = sealLine({ at: "2026-09-11T01:00:03.250Z" });
    expect(first).not.toBe(second);
    await writeManifestBytes(`${baselineLine(null)}${first}${second}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(contents.seals.size).toBe(1);
    expect(
      definedOrThrow(contents.seals.get(SEGMENT_NEW), "the seal"),
    ).toMatchObject({
      entryCount: 128,
      byteLength: 8_388_012,
      sha256: SHA_A,
    });
  });

  test("tolerates agreeing duplicates whose fields are serialized in a different key order", async () => {
    const reordered = `${JSON.stringify({
      sha256: SHA_A,
      byteLength: 8_388_012,
      entryCount: 128,
      segment: SEGMENT_NEW,
      at: "2026-09-11T09:00:00.000Z",
      formatVersion: MANIFEST_FORMAT_VERSION,
      kind: "seal",
    })}\n`;
    await writeManifestBytes(`${sealLine()}${reordered}`);
    const port = createFailurePort();

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    expect(port.calls).toHaveLength(0);
    expect(contents.seals.size).toBe(1);
  });

  test.each([
    ["entryCount", { entryCount: 129 }],
    ["byteLength", { byteLength: 8_388_013 }],
    ["sha256", { sha256: SHA_B }],
  ])(
    "throws when two seals for one segment disagree on %s",
    async (_field, override) => {
      await writeManifestBytes(
        `${baselineLine(null)}${sealLine()}${sealLine({ ...override, at: "2026-09-11T02:00:00.000Z" })}`,
      );
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      expectPortFailure(thrown, port);
    },
  );

  test("names the disputed segment, and nothing else of the caller's, when duplicates disagree", async () => {
    await writeManifestBytes(
      `${sealLine()}${sealLine({ sha256: SHA_B, at: "2026-09-11T02:00:00.000Z" })}`,
    );
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    // A segment NAME is the sanctioned exception to the no-caller-data rule:
    // it derives from the writer's clock and counter, carries zero caller
    // bytes, and is already public through `listSegments()`. `expectPortFailure`
    // enforces that nothing else leaks.
    const call = expectPortFailure(thrown, port);
    expect(Object.keys(call.context)).toContain("segment");
    expect(call.context["segment"]).toBe(SEGMENT_NEW);
  });
});

// ---------------------------------------------------------------------------
// Field reads go through Object.hasOwn into a local
// ---------------------------------------------------------------------------

describe("inherited field reads", () => {
  /**
   * `JSON.parse` cannot, on its own, produce a record whose `sha256` arrives
   * through the prototype chain: a `"__proto__"` key in the source text is
   * defined as an OWN data property and never re-links the prototype, so a
   * fixture built that way is indistinguishable from a record that simply
   * carries the field. A test driven through it could never fail, so it is
   * not written.
   *
   * What IS observable through the real input path is a polluted
   * `Object.prototype`: every parsed record then inherits the field, and an
   * implementation reading `record.sha256` instead of checking
   * `Object.hasOwn(record, "sha256")` accepts a seal that claims nothing.
   * That is the gadget this test plants — non-enumerably, so it cannot reach
   * the module through a spread or a `JSON.stringify` instead.
   */
  test("does not accept a seal whose sha256 and entryCount come from a polluted prototype", async () => {
    const incomplete = `${JSON.stringify({
      kind: "seal",
      formatVersion: MANIFEST_FORMAT_VERSION,
      at: "2026-09-11T01:00:00.000Z",
      segment: SEGMENT_OLD,
      byteLength: 10,
    })}\n`;
    await writeManifestBytes(`${baselineLine(null)}${incomplete}${sealLine()}`);
    const port = createFailurePort();
    plantPrototypeGadget("sha256", SHA_B);
    plantPrototypeGadget("entryCount", 7);

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    // An implementation reading the property rather than checking ownership
    // would find the gadget's values, treat the record as a complete seal,
    // and resolve instead of rejecting here.
    expect(thrown).toBeInstanceOf(M3LError);
  });
});

// ---------------------------------------------------------------------------
// The read is bounded and guarded exactly as a segment is
// ---------------------------------------------------------------------------

describe("bounded, guarded reads", () => {
  test("refuses a manifest that is a symlink", async () => {
    const target = path.join(sandbox, "elsewhere.jsonl");
    await writeFile(target, baselineLine(null));
    await symlink(target, manifestPath());
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expectPortFailure(thrown, port);
  });

  test("refuses a manifest with more than one hard link", async () => {
    const other = path.join(sandbox, "other.jsonl");
    await writeFile(manifestPath(), baselineLine(null));
    await link(manifestPath(), other);
    expect((await lstat(manifestPath())).nlink).toBe(2);
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expectPortFailure(thrown, port);
  });

  test("refuses a manifest whose bytes exceed the ceiling", async () => {
    await writeManifestBytes(`${baselineLine(null)}${sealLine()}`);
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, 16, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expectPortFailure(thrown, port);
  });

  test("refuses a sole unterminated line of exactly the ceiling", async () => {
    // A narrow trigger, so the fixture is asserted before the call: anything
    // OVER the ceiling is caught by the byte counter first, and a TERMINATED
    // line of this size fits. The wording must be the manifest's own.
    const maxBytes = 512;
    const bytes = "x".repeat(maxBytes);
    expect(Buffer.byteLength(bytes, "utf8")).toBe(maxBytes);
    expect(bytes.endsWith("\n")).toBe(false);
    await writeManifestBytes(bytes);
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, maxBytes, port.build),
    );

    const call = expectPortFailure(thrown, port);
    expect(call.message).toBe(
      "append-only stream: a sealed-segment manifest line exceeds the maximum manifest size",
    );
    expect(call.context).toEqual({ maxBytes });
  });

  test("refuses a manifest holding bytes that are not valid UTF-8, rather than decoding them lossily", async () => {
    // The strict decoder is a proof control, not a nicety: a lenient decode
    // substitutes U+FFFD for an invalid sequence, so a tampered manifest
    // whose bytes were mangled in transit would parse into a record this
    // reader then reports as a verified claim. The failure also arrives RAW
    // (a `TypeError` from the decoder, not the port's own error), so this
    // pins the other half of the read guard: a raw failure is wrapped through
    // the port on its way out, with the original chained.
    const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d, 0x0a]);
    await writeFile(
      manifestPath(),
      Buffer.concat([Buffer.from(baselineLine(null), "utf8"), invalidUtf8]),
    );
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      readManifest(sandbox, AMPLE_MAX_BYTES, port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    const call = expectPortFailure(thrown, port);
    expect(call.cause).toBeInstanceOf(TypeError);
  });

  test("reads a manifest of exactly the ceiling's size", async () => {
    const bytes = `${baselineLine(null)}${sealLine()}`;
    await writeManifestBytes(bytes);
    const port = createFailurePort();

    const contents = await readManifest(
      sandbox,
      Buffer.byteLength(bytes, "utf8"),
      port.build,
    );

    expect(contents.seals.size).toBe(1);
    expect(port.calls).toHaveLength(0);
  });

  test.each([0, -1, 1.5, Number.NaN])(
    "refuses a ceiling of %p before opening anything",
    async (maxBytes) => {
      await writeManifestBytes(baselineLine(null));
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        readManifest(sandbox, maxBytes, port.build),
      );

      expect(thrown).toBeInstanceOf(M3LError);
      expectPortFailure(thrown, port);
    },
  );
});

// ---------------------------------------------------------------------------
// Appending a seal
// ---------------------------------------------------------------------------

describe("appendSeal", () => {
  test("appends one terminated record carrying exactly the claim's measurement", async () => {
    const port = createFailurePort();
    await loadOrInitializeManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    await appendSeal(sandbox, sealClaim(), port.build);

    const lines = await manifestLines();
    expect(lines).toHaveLength(2);
    const written = parseJsonValue(definedOrThrow(lines[1], "the seal line"));
    expect(written).toEqual({
      kind: "seal",
      formatVersion: MANIFEST_FORMAT_VERSION,
      at: anyString(),
      segment: SEGMENT_NEW,
      entryCount: 128,
      byteLength: 8_388_012,
      sha256: SHA_A,
    });
    expect((await readManifestBytes()).endsWith("\n")).toBe(true);
  });

  test("stamps the seal with an ISO-8601 instant", async () => {
    const port = createFailurePort();

    await appendSeal(sandbox, sealClaim(), port.build);

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);
    const { at } = definedOrThrow(contents.seals.get(SEGMENT_NEW), "the seal");
    expect(new Date(at).toISOString()).toBe(at);
  });

  test("round-trips through readManifest", async () => {
    const port = createFailurePort();
    await loadOrInitializeManifest(sandbox, AMPLE_MAX_BYTES, port.build);

    await appendSeal(sandbox, sealClaim({ segment: SEGMENT_OLD }), port.build);
    await appendSeal(
      sandbox,
      sealClaim({ segment: SEGMENT_MID, sha256: SHA_B }),
      port.build,
    );

    const contents = await readManifest(sandbox, AMPLE_MAX_BYTES, port.build);
    expect([...contents.seals.keys()].sort()).toEqual(
      [SEGMENT_OLD, SEGMENT_MID].sort(),
    );
    expect(
      definedOrThrow(contents.seals.get(SEGMENT_MID), "the mid seal").sha256,
    ).toBe(SHA_B);
  });

  test("never truncates or rewrites what is already in the manifest", async () => {
    const existing = `${baselineLine(SEGMENT_OLD)}${sealLine({ segment: SEGMENT_MID })}`;
    await writeManifestBytes(existing);
    const port = createFailurePort();

    await appendSeal(sandbox, sealClaim(), port.build);

    expect((await readManifestBytes()).startsWith(existing)).toBe(true);
  });

  test("creates the manifest owner-only when it does not yet exist", async () => {
    const port = createFailurePort();

    await appendSeal(sandbox, sealClaim(), port.build);

    expect((await lstat(manifestPath())).mode & 0o777).toBe(0o600);
  });

  test("refuses to append into a hardlinked manifest, and does not double-wrap the refusal", async () => {
    // The post-open half of the append guard: `O_NOFOLLOW` cannot see a hard
    // link, so this refusal comes from the `fstat` taken on the very
    // descriptor about to be written — the same rule the read path enforces,
    // on the path that would otherwise let a second name observe every
    // record as it lands. It is also the one append failure that arrives
    // ALREADY built by the caller's port, so it pins the no-double-wrap half:
    // exactly one port call, and the thrown error is that first one rather
    // than a second error wrapping it.
    const other = path.join(sandbox, "other.jsonl");
    await writeFile(manifestPath(), baselineLine(null));
    await link(manifestPath(), other);
    expect((await lstat(manifestPath())).nlink).toBe(2);
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      appendSeal(sandbox, sealClaim(), port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expect(port.calls).toHaveLength(1);
    expectPortFailure(thrown, port);
    // Nothing reached either name.
    expect(await readManifestBytes()).toBe(baselineLine(null));
  });

  test("refuses to append through a symlink planted at the manifest name", async () => {
    const target = path.join(sandbox, "elsewhere.jsonl");
    await writeFile(target, "");
    await symlink(target, manifestPath());
    const port = createFailurePort();

    const thrown = await catchRejected(() =>
      appendSeal(sandbox, sealClaim(), port.build),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    // The planted target must not have received the seal.
    expect(await readFile(target, "utf8")).toBe("");
  });
});
