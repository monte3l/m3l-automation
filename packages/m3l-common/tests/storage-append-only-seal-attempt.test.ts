/**
 * Tests for `internal/storage/append-only-seal-attempt` — the BOUNDED RETRY
 * around measuring one segment ({@link measureSegment}) and appending its
 * claim ({@link appendClaim}), extracted from `./append-only-sealer.js`
 * (ADR-0102, X8b).
 *
 * The header of the module under test states the whole reason it exists as
 * two separate loops rather than one: {@link appendClaim} must append
 * EXACTLY the claim {@link measureSegment} produced, retry after retry,
 * never re-measuring the segment. Several tests below make that concrete by
 * arranging a claim that DISAGREES with what a fresh measurement of the
 * named segment would produce (or by naming a segment that does not exist on
 * disk at all) and confirming `appendClaim` still writes the given claim
 * byte-for-byte.
 *
 * Real bytes wherever real bytes can produce the fault (a segment file that
 * exists, a manifest that accumulates real records); the ONE fault no real
 * filesystem can stage on demand — a transient or a permanent `open()`
 * failure — is injected through an inert pass-through wrapper, unarmed by
 * default, mirroring the convention in `storage-append-only-sealer-failures
 * .test.ts` and `storage-append-only-digest.test.ts`.
 *
 * A new sibling file on purpose: `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings as unmatched
 * by design.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
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
  vi,
} from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import { APPEND_FLAGS } from "../src/internal/storage/append-only-fs.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";
import {
  M3L_APPEND_ONLY_MANIFEST_NAME,
  readManifest,
} from "../src/internal/storage/append-only-manifest.js";
import type { SegmentSealClaim } from "../src/internal/storage/append-only-manifest.js";
import type { ManifestSealRecord } from "../src/internal/storage/append-only-manifest-records.js";
import {
  appendClaim,
  corroborateClaim,
  measureSegment,
} from "../src/internal/storage/append-only-seal-attempt.js";
import type { SealAttemptOutcome } from "../src/internal/storage/append-only-seal-attempt.js";

// ---------------------------------------------------------------------------
// Injected fault: an `open()` this suite arms by file name and flags
// ---------------------------------------------------------------------------

/**
 * The armed state of the `open()` wrapper below. `undefined` — the state
 * every test both starts and ends in — makes it a pure pass-through.
 */
const faults = vi.hoisted(() => ({
  openFault: undefined as
    ((file: string, flags: number) => Error | undefined) | undefined,
  opened: [] as { file: string; flags: number }[],
}));

/**
 * `open` and nothing else: `importOriginal` keeps every other export — the
 * `mkdtemp`/`writeFile`/`rm` this file uses, and every `read`/`fstat`/
 * `appendFile` the modules under test run through `digestSegmentFile` and
 * `appendSeal` — the genuine article. Unarmed, the wrapper returns the real
 * handle unchanged.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const realOpen = actual.open;
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
  return { ...actual, open };
});

afterEach(() => {
  faults.openFault = undefined;
  faults.opened = [];
});

/** Opens of `name` so far — the attempt counter the retry tests read. */
function opensOf(name: string): number {
  return faults.opened.filter(({ file }) => path.basename(file) === name)
    .length;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "m3l-append-only-seal-attempt-"));
  faults.opened = [];
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** Writes EXACT bytes to a file in the sandbox and returns its base name. */
async function writeFixture(
  fileName: string,
  content: string,
): Promise<string> {
  await writeFile(path.join(sandbox, fileName), content);
  return fileName;
}

/** The digest computed independently of the module under test. */
function referenceSha256(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
}

/** One failure the module asked its {@link AppendOnlyReadFailure} port for. */
interface RecordedFailure {
  readonly cause: unknown;
  readonly error: M3LError;
}

/** A real failure port, building a genuine `M3LError` as an owner would. */
function createFailurePort(): {
  readonly build: AppendOnlyReadFailure;
  readonly calls: RecordedFailure[];
} {
  const calls: RecordedFailure[] = [];
  const build: AppendOnlyReadFailure = (message, options) => {
    const error = new M3LError(message, {
      code: "ERR_TEST_APPEND_ONLY_SEAL_ATTEMPT",
      cause: options?.cause,
      context: { ...options?.context },
    });
    calls.push({ cause: options?.cause, error });
    return error;
  };
  return { build, calls };
}

// ---------------------------------------------------------------------------
// measureSegment
// ---------------------------------------------------------------------------

describe("measureSegment", () => {
  test("measures a healthy segment on the first attempt", async () => {
    const content = '{"a":1}\n{"b":2}\n';
    const name = await writeFixture("healthy.jsonl", content);
    const port = createFailurePort();

    const outcome = await measureSegment({
      directory: sandbox,
      segment: name,
      maxDigestBytes: 1024,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    expect(outcome).toEqual({
      ok: true,
      value: {
        segment: name,
        entryCount: 2,
        byteLength: Buffer.byteLength(content, "utf8"),
        sha256: referenceSha256(content),
      },
    });
    expect(opensOf(name)).toBe(1);
    expect(port.calls).toEqual([]);
  });

  test("returns the successful measurement after a transient failure, not the failure", async () => {
    const content = '{"only":true}\n';
    const name = await writeFixture("transient.jsonl", content);
    let failed = false;
    faults.openFault = (file) => {
      if (path.basename(file) !== name || failed) {
        return undefined;
      }
      failed = true;
      return new Error("simulated transient EIO on the first attempt");
    };
    const port = createFailurePort();

    const outcome = await measureSegment({
      directory: sandbox,
      segment: name,
      maxDigestBytes: 1024,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    expect(outcome).toEqual({
      ok: true,
      value: {
        segment: name,
        entryCount: 1,
        byteLength: Buffer.byteLength(content, "utf8"),
        sha256: referenceSha256(content),
      },
    });
    expect(opensOf(name)).toBe(2);
  });

  test("gives up after exactly maxSealAttempts and returns the LAST failure", async () => {
    const name = await writeFixture("permanent.jsonl", '{"a":1}\n');
    const raw: Error[] = [];
    faults.openFault = (file) => {
      if (path.basename(file) !== name) {
        return undefined;
      }
      const error = new Error(
        `simulated EIO, attempt ${String(raw.length + 1)}`,
      );
      raw.push(error);
      return error;
    };
    const port = createFailurePort();

    const outcome: SealAttemptOutcome<SegmentSealClaim> = await measureSegment({
      directory: sandbox,
      segment: name,
      maxDigestBytes: 1024,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    // Exactly 3: neither fewer (the retry ran out its full budget) nor more
    // (the loop stopped once the budget was spent).
    expect(opensOf(name)).toBe(3);
    expect(port.calls).toHaveLength(3);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The LAST failure specifically, not the first: a loop that kept the
      // first failure instead would fail this against the third raw error.
      expect(outcome.failure).toBe(port.calls.at(-1)?.error);
      expect((outcome.failure as M3LError).cause).toBe(raw.at(-1));
      expect(outcome.failure).not.toBe(port.calls[0]?.error);
    }
  });

  test("does not throw when the failure port itself throws", async () => {
    const name = await writeFixture("port-throws.jsonl", '{"a":1}\n');
    faults.openFault = (file) =>
      path.basename(file) === name ? new Error("simulated EIO") : undefined;
    const portError = new Error("the caller's own error port failed");
    const build: AppendOnlyReadFailure = () => {
      throw portError;
    };

    const outcome = await measureSegment({
      directory: sandbox,
      segment: name,
      maxDigestBytes: 1024,
      maxSealAttempts: 2,
      buildError: build,
    });

    expect(outcome).toEqual({ ok: false, failure: portError });
    expect(opensOf(name)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// appendClaim
// ---------------------------------------------------------------------------

describe("appendClaim", () => {
  /** Filters the shared open fault to just the manifest append path. */
  function armManifestOpenFault(
    fault: (attemptNumber: number) => Error | undefined,
  ): void {
    let attempt = 0;
    faults.openFault = (file, flags) => {
      if (
        path.basename(file) !== M3L_APPEND_ONLY_MANIFEST_NAME ||
        flags !== APPEND_FLAGS
      ) {
        return undefined;
      }
      attempt += 1;
      return fault(attempt);
    };
  }

  test("appends the given claim to the manifest", async () => {
    const claim: SegmentSealClaim = {
      segment: "2026-01-01-0001.jsonl",
      entryCount: 2,
      byteLength: 16,
      sha256: "a".repeat(64),
    };
    const port = createFailurePort();

    const outcome = await appendClaim({
      directory: sandbox,
      claim,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    expect(outcome).toEqual({ ok: true, value: undefined });
    // Asserted BEFORE the verification read below, which opens the manifest
    // itself and would otherwise inflate this count.
    expect(opensOf(M3L_APPEND_ONLY_MANIFEST_NAME)).toBe(1);
    expect(port.calls).toEqual([]);
    const contents = await readManifest(sandbox, 1_048_576, port.build);
    expect(contents.seals.get(claim.segment)).toMatchObject({
      segment: claim.segment,
      entryCount: claim.entryCount,
      byteLength: claim.byteLength,
      sha256: claim.sha256,
    });
  });

  // The invariant worth stating in its own name: appendClaim appends the ONE
  // claim it was given and never re-measures. The segment named in `claim`
  // holds bytes that would digest to something else entirely — if
  // `appendClaim` re-measured before writing, the recorded seal would
  // disagree with `claim`, which `./append-only-manifest.js` treats as fatal
  // on a later read. It does not, because it never re-measures.
  test("appends the claim it was given, never re-measuring the segment on disk", async () => {
    const segmentName = "2026-01-03-0002.jsonl";
    await writeFixture(segmentName, '{"real":"very different content"}\n');
    const claim: SegmentSealClaim = {
      segment: segmentName,
      entryCount: 999,
      byteLength: 999,
      sha256: "c".repeat(64),
    };
    const port = createFailurePort();

    const outcome = await appendClaim({
      directory: sandbox,
      claim,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    expect(outcome).toEqual({ ok: true, value: undefined });
    const contents = await readManifest(sandbox, 1_048_576, port.build);
    expect(contents.seals.get(segmentName)).toMatchObject({
      entryCount: 999,
      byteLength: 999,
      sha256: claim.sha256,
    });
  });

  test("returns success after a transient append failure, not the failure", async () => {
    const claim: SegmentSealClaim = {
      segment: "2026-01-04-0001.jsonl",
      entryCount: 1,
      byteLength: 8,
      sha256: "d".repeat(64),
    };
    armManifestOpenFault((attempt) =>
      attempt === 1
        ? new Error("simulated transient EIO on the manifest append")
        : undefined,
    );
    const port = createFailurePort();

    const outcome = await appendClaim({
      directory: sandbox,
      claim,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    expect(outcome).toEqual({ ok: true, value: undefined });
    expect(opensOf(M3L_APPEND_ONLY_MANIFEST_NAME)).toBe(2);
    const contents = await readManifest(sandbox, 1_048_576, port.build);
    expect(contents.seals.get(claim.segment)).toMatchObject({
      sha256: claim.sha256,
    });
  });

  test("gives up after exactly maxSealAttempts and returns the LAST failure", async () => {
    const claim: SegmentSealClaim = {
      segment: "2026-01-05-0001.jsonl",
      entryCount: 1,
      byteLength: 8,
      sha256: "e".repeat(64),
    };
    armManifestOpenFault(
      (attempt) => new Error(`simulated EIO, attempt ${String(attempt)}`),
    );
    const port = createFailurePort();

    const outcome = await appendClaim({
      directory: sandbox,
      claim,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    expect(opensOf(M3L_APPEND_ONLY_MANIFEST_NAME)).toBe(3);
    expect(port.calls).toHaveLength(3);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe(port.calls.at(-1)?.error);
      expect(outcome.failure).not.toBe(port.calls[0]?.error);
    }
    // Nothing was ever recorded — a permanently-failing append must leave no
    // partial or disagreeing trace in the manifest.
    const contents = await readManifest(sandbox, 1_048_576, port.build);
    expect(contents.seals.get(claim.segment)).toBeUndefined();
  });

  test("does not throw when the failure port itself throws", async () => {
    const claim: SegmentSealClaim = {
      segment: "2026-01-06-0001.jsonl",
      entryCount: 1,
      byteLength: 8,
      sha256: "f".repeat(64),
    };
    armManifestOpenFault(() => new Error("simulated EIO"));
    const portError = new Error("the caller's own error port failed");
    const build: AppendOnlyReadFailure = () => {
      throw portError;
    };

    const outcome = await appendClaim({
      directory: sandbox,
      claim,
      maxSealAttempts: 2,
      buildError: build,
    });

    expect(outcome).toEqual({ ok: false, failure: portError });
    expect(opensOf(M3L_APPEND_ONLY_MANIFEST_NAME)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// corroborateClaim
// ---------------------------------------------------------------------------

describe("corroborateClaim", () => {
  const CONTENT = '{"a":1}\n{"b":2}\n{"c":3}\n';

  /** A `ManifestSealRecord` that agrees with a fresh measurement of `name`. */
  function agreeingRecord(name: string): ManifestSealRecord {
    return {
      kind: "seal",
      formatVersion: 1,
      at: new Date().toISOString(),
      segment: name,
      entryCount: 3,
      byteLength: Buffer.byteLength(CONTENT, "utf8"),
      sha256: referenceSha256(CONTENT),
    };
  }

  test("agreement returns success and asks the failure port for nothing", async () => {
    const name = await writeFixture("corroborate-agree.jsonl", CONTENT);
    const port = createFailurePort();

    const outcome = await corroborateClaim({
      directory: sandbox,
      segment: name,
      existing: agreeingRecord(name),
      maxDigestBytes: 1024,
      maxSealAttempts: 3,
      buildError: port.build,
    });

    expect(outcome).toEqual({ ok: true, value: undefined });
    expect(port.calls).toEqual([]);
  });

  // The negative half of the comparison: `at` is a timestamp the writer
  // stamps fresh on every seal and differs by construction between any two
  // measurements. Folding it into the comparison (or comparing whole
  // records) would make every corroboration report a disagreement — an
  // automatic false positive. Two records describing the SAME bytes, with
  // only `at` differing, must still agree.
  test("agreement holds even when `at` differs between the existing seal and now", async () => {
    const name = await writeFixture("corroborate-agree-at.jsonl", CONTENT);
    const existing: ManifestSealRecord = {
      ...agreeingRecord(name),
      at: new Date(0).toISOString(),
    };

    const outcome = await corroborateClaim({
      directory: sandbox,
      segment: name,
      existing,
      maxDigestBytes: 1024,
      maxSealAttempts: 3,
      buildError: createFailurePort().build,
    });

    expect(outcome).toEqual({ ok: true, value: undefined });
  });

  test.each([
    ["entryCount", { entryCount: 999 }],
    ["byteLength", { byteLength: 999 }],
    ["sha256", { sha256: "9".repeat(64) }],
  ] as const)(
    "disagreement on %s alone is reported as a failure",
    async (field, override) => {
      const name = await writeFixture(
        `corroborate-disagree-${field}.jsonl`,
        CONTENT,
      );
      const existing: ManifestSealRecord = {
        ...agreeingRecord(name),
        ...override,
      };
      const port = createFailurePort();

      const outcome = await corroborateClaim({
        directory: sandbox,
        segment: name,
        existing,
        maxDigestBytes: 1024,
        maxSealAttempts: 3,
        buildError: port.build,
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure).toBeInstanceOf(M3LError);
        expect(port.calls).toHaveLength(1);
        // No `cause` on the disagreement failure -- built fresh by
        // `corroborateClaim` itself, never chained from a raw fs error. The
        // next test below is what a real measurement FAILURE looks like
        // instead, and the two must be told apart.
        expect(port.calls[0]?.cause).toBeUndefined();
      }
    },
  );

  test("a measurement that fails outright surfaces that failure rather than a disagreement", async () => {
    const name = await writeFixture("corroborate-measure-fails.jsonl", CONTENT);
    faults.openFault = (file) =>
      path.basename(file) === name
        ? new Error("simulated permanent EIO")
        : undefined;
    const port = createFailurePort();

    const outcome = await corroborateClaim({
      directory: sandbox,
      segment: name,
      existing: agreeingRecord(name),
      maxDigestBytes: 1024,
      maxSealAttempts: 2,
      buildError: port.build,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBeInstanceOf(M3LError);
      // The measurement's OWN failure, chained to the raw fs error -- unlike
      // the disagreement failure above, which is built with no `cause` at
      // all.
      expect((outcome.failure as M3LError).cause).toBeInstanceOf(Error);
      expect(((outcome.failure as M3LError).cause as Error).message).toBe(
        "simulated permanent EIO",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("types", () => {
  test("SealAttemptOutcome is a success/failure union keyed on ok", () => {
    expectTypeOf<SealAttemptOutcome<string>>().toEqualTypeOf<
      | { readonly ok: true; readonly value: string }
      | { readonly ok: false; readonly failure: unknown }
    >();
  });
});
