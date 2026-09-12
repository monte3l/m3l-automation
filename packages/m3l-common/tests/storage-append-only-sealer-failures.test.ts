/**
 * Tests for `internal/storage/append-only-sealer` — the half that carries the
 * slice's central claim: **the sealer NEVER throws** (ADR-0102, "Seal-write
 * failure is best-effort and never fatal to the append").
 *
 * A seal is metadata about bytes already durably appended. Failing the append
 * to protect a proof about older bytes would discard a new auditable record to
 * defend an old one, so every failure — a digest that cannot run, a manifest
 * that cannot be read, an append that cannot be written, two seals that
 * disagree, an I/O error, even a `buildError` port that itself throws — is
 * REPORTED and never propagated.
 *
 * That claim is driven here as a **property, not a list**: one runner asserts
 * `resolves` over every fault this suite can construct, so a new fault is one
 * table row rather than a new test.
 *
 * **The honest limit, so a passing table is not mistaken for a proof.** The
 * property is only as wide as the faults it can build, and these tests would
 * NOT catch a sealer that threw on a path no row constructs. Uncovered by
 * construction: a rejection from any `node:fs` call this suite never makes
 * fail (`appendFile`, `fstat`, `read`, `close`, `mkdir`); an `onSealFailed`
 * handler that returns a REJECTING promise rather than throwing
 * synchronously; a throw after the last `await` on a path only reachable
 * under concurrency; and errno classes unique to another filesystem. What
 * actually closes that gap is the implementation's own total guard — one
 * `catch` around the whole operation — plus mutation-testing that guard
 * (delete it and watch this file go red). A longer table narrows the gap; it
 * never closes it.
 *
 * The sibling `storage-append-only-sealer.test.ts` owns WHEN a segment is
 * sealed — rotation, the cold-start sweep and its ceiling. Nothing here
 * re-asserts a trigger; everything here is about what happens when one fails.
 *
 * Faults are real bytes wherever real bytes can produce them (a deleted
 * segment, a planted symlink, a hardlink, a malformed manifest line, a seal at
 * a newer `formatVersion`, two disagreeing seals, a ceiling a fixture
 * exceeds). Only the two that the filesystem cannot stage for a test that must
 * also run as an unprivileged user — an `open` that fails on the WRITE path
 * and a `readdir` that fails outright — are injected, through inert
 * pass-through wrappers armed by the single test that needs them. A directory
 * stripped of its permissions is a no-op for root and would make those tests
 * silently vacuous.
 *
 * A new sibling file on purpose, and split from the trigger suite from the
 * start rather than at a byte ceiling: `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings as unmatched by
 * design.
 *
 * @packageDocumentation
 */

import type * as FsPromises from "node:fs/promises";
import {
  link,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { APPEND_FLAGS } from "../src/internal/storage/append-only-fs.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";
import {
  M3L_APPEND_ONLY_MANIFEST_NAME,
  MANIFEST_FORMAT_VERSION,
  readManifest,
} from "../src/internal/storage/append-only-manifest.js";
import { AppendOnlySealer } from "../src/internal/storage/append-only-sealer.js";
import type {
  AppendOnlySealFailure,
  AppendOnlySealerOptions,
} from "../src/internal/storage/append-only-sealer.js";

// ---------------------------------------------------------------------------
// The two injected faults
// ---------------------------------------------------------------------------

/**
 * The armed state of the wrappers below. `undefined` — the state every test
 * both starts and ends in — makes each one a pure pass-through.
 */
const faults = vi.hoisted(() => ({
  openFault: undefined as
    ((file: string, flags: number) => Error | undefined) | undefined,
  listingError: undefined as Error | undefined,
  opened: [] as { file: string; flags: number }[],
}));

/**
 * `open` and `readdir`, and nothing else. `importOriginal` keeps every other
 * export — the `mkdtemp`/`writeFile`/`symlink`/`link`/`unlink`/`rm` this file
 * uses and the `read`/`fstat`/`appendFile` the modules under test run — the
 * genuine article, so an unarmed test is reading and writing real bytes.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const realOpen: (
    file: string,
    flags: number,
    mode?: number,
  ) => Promise<FsPromises.FileHandle> = actual.open;
  const realReaddir: (directory: string) => Promise<string[]> = actual.readdir;
  const open = async (
    file: string,
    flags: number,
    mode?: number,
  ): Promise<FsPromises.FileHandle> => {
    faults.opened.push({ file, flags });
    const fault = faults.openFault?.(file, flags);
    if (fault !== undefined) {
      throw fault;
    }
    return await realOpen(file, flags, mode);
  };
  const readdir = async (directory: string): Promise<string[]> => {
    const { listingError } = faults;
    if (listingError !== undefined) {
      throw listingError;
    }
    return await realReaddir(directory);
  };
  return { ...actual, open, readdir };
});

afterEach(() => {
  faults.openFault = undefined;
  faults.listingError = undefined;
  faults.opened = [];
});

/** Opens of `file` so far — the attempt counter the retry tests read. */
function opensOf(name: string): number {
  return faults.opened.filter(({ file }) => path.basename(file) === name)
    .length;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "m3l-append-only-sealer-fail-"));
  faults.opened = [];
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The UTC date prefix `offsetDays` before now, `YYYY-MM-DD`. */
function datePrefix(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

const TODAY = datePrefix(0);
const YESTERDAY = datePrefix(-1);

/** A segment file name this writer would itself have produced. */
function segmentName(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}.jsonl`;
}

/** A generous manifest ceiling, so no test is accidentally about it. */
const AMPLE_MAX_BYTES = 1_048_576;

/** 64 lowercase hex characters — the documented shape of a seal's `sha256`. */
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** The segment the writer rotated away from in every scenario below. */
const ROTATED = segmentName(TODAY, 1);
/** The segment a crashed predecessor left behind for the sweep. */
const STALE = segmentName(YESTERDAY, 1);

/** Three newline-terminated entries: what every fixture segment holds. */
const FIXTURE_CONTENT =
  '{"entry":"alpha"}\n{"entry":"beta"}\n{"entry":"gamma"}\n';

/** An absolute path inside the sandbox. */
function inSandbox(name: string): string {
  return path.join(sandbox, name);
}

/** Writes a segment file holding `content`, and returns its name. */
async function writeSegment(
  name: string,
  content = FIXTURE_CONTENT,
): Promise<string> {
  await writeFile(inSandbox(name), content);
  return name;
}

/** Appends one raw line to the sandbox's manifest. */
async function appendManifestText(line: string): Promise<void> {
  await writeFile(inSandbox(M3L_APPEND_ONLY_MANIFEST_NAME), line, {
    flag: "a",
  });
}

/** Seeds the manifest with one `baseline` record stating `upTo`. */
async function seedBaseline(upTo: string | null): Promise<void> {
  await appendManifestText(
    `${JSON.stringify({
      kind: "baseline",
      formatVersion: MANIFEST_FORMAT_VERSION,
      at: new Date().toISOString(),
      upTo,
    })}\n`,
  );
}

/** Seeds one `seal` record, with overridable fields for the fatal cases. */
async function seedSeal(
  segment: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await appendManifestText(
    `${JSON.stringify({
      kind: "seal",
      formatVersion: MANIFEST_FORMAT_VERSION,
      at: new Date().toISOString(),
      segment,
      entryCount: 3,
      byteLength: 53,
      sha256: SHA_A,
      ...overrides,
    })}\n`,
  );
}

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/** A real failure port building a genuine `M3LError`, as an owner would. */
function failurePort(): AppendOnlyReadFailure {
  return (message, options) =>
    new M3LError(message, {
      code: "ERR_TEST_APPEND_ONLY_SEALER",
      cause: options?.cause,
      context: { ...options?.context },
    });
}

/** Everything one scenario's sealer reported, in order. */
let reported: AppendOnlySealFailure[];

beforeEach(() => {
  reported = [];
});

/** A sealer over the sandbox, recording every failure it reports. */
function createSealer(
  overrides: Partial<AppendOnlySealerOptions> = {},
): AppendOnlySealer {
  return new AppendOnlySealer({
    directory: sandbox,
    maxSegmentBytes: 8_388_608,
    maxLineBytes: 65_536,
    maxManifestBytes: AMPLE_MAX_BYTES,
    buildError: failurePort(),
    onSealFailed: (failure: AppendOnlySealFailure) => {
      reported.push(failure);
    },
    ...overrides,
  });
}

/**
 * The healthy starting point every fault below damages: a manifest stating no
 * legacy boundary, one segment the writer rotated away from, one segment a
 * crashed predecessor left unsealed, and today's active segment.
 */
async function seedHealthyTrail(): Promise<void> {
  await seedBaseline(null);
  await writeSegment(ROTATED);
  await writeSegment(STALE);
  await writeSegment(segmentName(TODAY, 2));
}

// ---------------------------------------------------------------------------
// The property: the sealer never throws
// ---------------------------------------------------------------------------

/** One constructible fault, and the option overrides it needs. */
interface FaultScenario {
  readonly name: string;
  readonly arm: () =>
    | Partial<AppendOnlySealerOptions>
    | Promise<Partial<AppendOnlySealerOptions>>;
  /**
   * What the writer claims to have rotated away from, when the fault IS that
   * claim. Defaults to {@link ROTATED}, the real segment every other row
   * damages some other way.
   */
  readonly rotatedFrom?: string;
}

const NO_OVERRIDES: Partial<AppendOnlySealerOptions> = {};

const FAULTS: readonly FaultScenario[] = [
  {
    name: "the rotated segment has been deleted",
    arm: async () => {
      await unlink(inSandbox(ROTATED));
      return NO_OVERRIDES;
    },
  },
  {
    name: "the rotated segment has been replaced by a symlink",
    arm: async () => {
      await unlink(inSandbox(ROTATED));
      await symlink(inSandbox(segmentName(TODAY, 2)), inSandbox(ROTATED));
      return NO_OVERRIDES;
    },
  },
  {
    name: "the rotated segment carries a second hard link",
    arm: async () => {
      await link(inSandbox(ROTATED), inSandbox("planted-second-link"));
      return NO_OVERRIDES;
    },
  },
  {
    name: "the rotated segment exceeds the digest ceiling",
    arm: () => ({ maxSegmentBytes: 8, maxLineBytes: 8 }),
  },
  {
    name: "the digest ceiling is not a size a segment could have",
    arm: () => ({ maxSegmentBytes: 0, maxLineBytes: 0 }),
  },
  {
    name: "the manifest holds a malformed line before its last",
    arm: async () => {
      await appendManifestText("this is not a manifest record\n");
      await seedBaseline(null);
      return NO_OVERRIDES;
    },
  },
  {
    name: "the manifest holds a seal this reader is too old to understand",
    arm: async () => {
      await seedSeal(STALE, { formatVersion: MANIFEST_FORMAT_VERSION + 1 });
      return NO_OVERRIDES;
    },
  },
  {
    name: "two seals disagree about one segment's measurement",
    arm: async () => {
      await seedSeal(STALE);
      await seedSeal(STALE, { sha256: SHA_B });
      return NO_OVERRIDES;
    },
  },
  {
    name: "the manifest exceeds the ceiling it is read under",
    arm: () => ({ maxManifestBytes: 8 }),
  },
  {
    name: "the manifest has been replaced by a symlink",
    arm: async () => {
      await unlink(inSandbox(M3L_APPEND_ONLY_MANIFEST_NAME));
      await symlink(
        inSandbox(segmentName(TODAY, 2)),
        inSandbox(M3L_APPEND_ONLY_MANIFEST_NAME),
      );
      return NO_OVERRIDES;
    },
  },
  {
    name: "the manifest cannot be opened for appending",
    arm: () => {
      faults.openFault = (file, flags) =>
        path.basename(file) === M3L_APPEND_ONLY_MANIFEST_NAME &&
        flags === APPEND_FLAGS
          ? new Error("simulated EACCES on the manifest append")
          : undefined;
      return NO_OVERRIDES;
    },
  },
  {
    name: "the stream directory cannot be listed",
    arm: () => {
      faults.listingError = new Error("simulated EACCES on readdir");
      return NO_OVERRIDES;
    },
  },
  {
    name: "the stream directory does not exist",
    arm: () => ({ directory: inSandbox("no-such-directory") }),
  },
  {
    name: "the failure port itself throws",
    arm: async () => {
      await unlink(inSandbox(ROTATED));
      return {
        buildError: () => {
          throw new Error("a failure port that cannot build a failure");
        },
      };
    },
  },
  {
    name: "the onSealFailed handler itself throws",
    arm: async () => {
      await unlink(inSandbox(ROTATED));
      return {
        onSealFailed: () => {
          throw new Error("a handler that cannot handle");
        },
      };
    },
  },
  {
    // A name no writer here renders reaches the sealer as a SHAPE fault, not
    // an I/O one: whatever it does with the parse — a `parseSegmentName`
    // returning `undefined`, a path join on a name with no date to order by —
    // must stay inside the guard rather than surface as a synchronous
    // `TypeError` on the append path.
    name: "the rotated name is not one this writer would produce",
    arm: () => NO_OVERRIDES,
    rotatedFrom: "not-a-segment.txt",
  },
];

describe("the sealer never throws", () => {
  test.each(FAULTS)("resolves when $name", async ({ arm, rotatedFrom }) => {
    await seedHealthyTrail();
    const overrides = await arm();

    await expect(
      createSealer(overrides).sealAfterAppend(rotatedFrom ?? ROTATED),
    ).resolves.toBeUndefined();
  });

  test.each(FAULTS)(
    "resolves when $name and no append rotated",
    async ({ arm }) => {
      // The sweep reaches most of these faults by a different route than the
      // rotation seal does, and a guard scoped to the rotation path alone would
      // leave that route bare.
      await seedHealthyTrail();
      const overrides = await arm();

      await expect(
        createSealer(overrides).sealAfterAppend(undefined),
      ).resolves.toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// What a failure reports
// ---------------------------------------------------------------------------

describe("reporting a failed seal", () => {
  test("names the segment that could not be sealed", async () => {
    // A segment NAME is permitted here: it derives from the writer's clock
    // and counter, carries zero caller bytes, and is already public through
    // `listSegments()`. A directory PATH is caller input and is not.
    await seedHealthyTrail();
    await unlink(inSandbox(ROTATED));

    await createSealer().sealAfterAppend(ROTATED);

    const failure = definedOrThrow(reported.at(0), "a reported failure");
    expect(failure.segment).toBe(ROTATED);
  });

  test("reports the failure the injected port built, with its raw cause chained", async () => {
    await seedHealthyTrail();
    await unlink(inSandbox(ROTATED));

    await createSealer().sealAfterAppend(ROTATED);

    const failure = definedOrThrow(reported.at(0), "a reported failure");
    expect(failure.error).toBeInstanceOf(M3LError);
    // The sentinel code proves the failure went THROUGH the port rather than
    // the sealer inventing an error class it does not own.
    expect(failure.error.code).toBe("ERR_TEST_APPEND_ONLY_SEALER");
    expect(failure.error.cause).toMatchObject({ code: "ENOENT" });
  });

  test("carries no directory path in the reported message or context", async () => {
    await seedHealthyTrail();
    await unlink(inSandbox(ROTATED));

    await createSealer().sealAfterAppend(ROTATED);

    const failure = definedOrThrow(reported.at(0), "a reported failure");
    const context = JSON.stringify(failure.error.context) ?? "";
    for (const secret of [sandbox, path.basename(sandbox)]) {
      expect(failure.error.message).not.toContain(secret);
      expect(context).not.toContain(secret);
    }
  });

  test("reports nothing at all on a healthy trail", async () => {
    await seedHealthyTrail();

    await createSealer().sealAfterAppend(ROTATED);

    expect(reported).toEqual([]);
  });

  test("reports the manifest failure once rather than once per segment", async () => {
    // A manifest that cannot be read stops the whole operation, so the
    // reporting must not fan the single fault out into one report per
    // candidate segment.
    await seedHealthyTrail();
    await writeSegment(segmentName(YESTERDAY, 2));
    await appendManifestText("this is not a manifest record\n");
    await seedBaseline(null);

    await createSealer().sealAfterAppend(ROTATED);

    expect(reported).toHaveLength(1);
  });

  test("resolves with no handler supplied at all", async () => {
    // `onSealFailed` is optional, so the never-throws guard cannot depend on
    // a handler being there to absorb the failure.
    await seedHealthyTrail();
    await unlink(inSandbox(ROTATED));
    const sealer = new AppendOnlySealer({
      directory: sandbox,
      maxSegmentBytes: 8_388_608,
      maxLineBytes: 65_536,
      maxManifestBytes: AMPLE_MAX_BYTES,
      buildError: failurePort(),
    });

    await expect(sealer.sealAfterAppend(ROTATED)).resolves.toBeUndefined();
  });

  test("one unsealable segment does not stop the others being sealed", async () => {
    // The bad-record/source-failure split: a single segment the sweep cannot
    // digest is skipped and reported, while every other candidate still
    // reaches the manifest. A sweep that abandoned the batch would leave a
    // whole backlog unproven because of one unreadable file.
    await seedBaseline(null);
    await writeSegment(ROTATED);
    const good = await writeSegment(segmentName(YESTERDAY, 1));
    const bad = await writeSegment(segmentName(YESTERDAY, 2));
    faults.openFault = (file) =>
      path.basename(file) === bad
        ? new Error("a permanent EIO on one segment only")
        : undefined;

    await createSealer().sealAfterAppend(ROTATED);

    const contents = await readManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      failurePort(),
    );
    expect([...contents.seals.keys()].toSorted()).toEqual([good, ROTATED]);
    expect(reported.map((failure) => failure.segment)).toEqual([bad]);
  });
});

// ---------------------------------------------------------------------------
// Bounded in-process retry
// ---------------------------------------------------------------------------

describe("bounded in-process retry", () => {
  test("a seal that fails once and then succeeds is not reported", async () => {
    await seedHealthyTrail();
    let failed = false;
    faults.openFault = (file) => {
      if (path.basename(file) !== ROTATED || failed) {
        return undefined;
      }
      failed = true;
      return new Error("a transient EIO on the first digest attempt");
    };

    await createSealer({ maxSealAttempts: 3 }).sealAfterAppend(ROTATED);

    const contents = await readManifest(
      sandbox,
      AMPLE_MAX_BYTES,
      failurePort(),
    );
    expect([...contents.seals.keys()]).toContain(ROTATED);
    expect(reported).toEqual([]);
  });

  test("gives up after the stated number of attempts and reports once", async () => {
    await seedHealthyTrail();
    faults.openFault = (file) =>
      path.basename(file) === ROTATED
        ? new Error("a permanent EIO on every digest attempt")
        : undefined;

    await createSealer({ maxSealAttempts: 3 }).sealAfterAppend(ROTATED);

    expect(opensOf(ROTATED)).toBe(3);
    expect(reported.map((failure) => failure.segment)).toEqual([ROTATED]);
  });

  test("retries at all — a single attempt is not a bounded retry", async () => {
    // The discriminating half of the pair above: a sealer with no retry at
    // all satisfies "gives up and reports", so boundedness alone proves
    // nothing without evidence a second attempt happened.
    await seedHealthyTrail();
    faults.openFault = (file) =>
      path.basename(file) === ROTATED
        ? new Error("a permanent EIO on every digest attempt")
        : undefined;

    await createSealer().sealAfterAppend(ROTATED);

    expect(opensOf(ROTATED)).toBeGreaterThan(1);
  });
});
