/**
 * Tests for `internal/storage/append-only-digest` — the sealed-segment
 * digest primitive of ADR-0102 (X8b slice 3): the incremental
 * {@link SegmentDigest} the reader feeds from its existing chunk loop, and
 * the one-shot {@link digestSegmentFile} the writer's sealer uses to measure
 * a segment it has rotated away from.
 *
 * The sha256 this module computes is a PUBLIC contract, not an
 * implementation detail: ADR-0102 § "The digest is plain sha256 of the
 * file's raw bytes — a contract" requires `sha256sum <archived-segment>` to
 * reproduce it with no library involved, because that property is the entire
 * reason an archived date is provable off-host. It is therefore pinned here
 * twice over — against a hash computed independently in the test with
 * `node:crypto`, AND against hard-coded literal digests for fixed inputs, so
 * that a future change to HOW the digest is computed cannot silently
 * redefine the contract by moving both sides together.
 *
 * Every failure is raised through the caller's own
 * {@link "../src/internal/storage/append-only-lines.js".AppendOnlyReadFailure}
 * port, exactly like the rest of this layer: `read()`'s inline verification
 * has to raise `M3LAppendOnlyStreamReadError`, a public class this internal
 * module must not name. These tests therefore assert that the port was
 * CALLED and that the rejected value is the very error the port returned —
 * an implementation that constructed an error of its own instead would leave
 * the port unused and fail here. What `code` or message that error carries is
 * the port owner's contract, not this module's, and is deliberately not
 * pinned.
 *
 * Everything this module does is a property of real bytes on a real
 * filesystem — a real symlink, a real hardlink, a real missing file, a real
 * multi-byte UTF-8 encoding — so this suite uses a REAL per-test `mkdtemp`
 * sandbox throughout (ADR-0100) and reads every one of those bytes through
 * the real `node:fs/promises`. A mocked read would be asserting the mock's
 * idea of the bytes, which is exactly the thing under test.
 *
 * ONE fault no fixture can arrange is a `close()` the kernel refuses — and it
 * is the only way to tell this module's two close paths apart: on the SUCCESS
 * path a failed close throws and displaces a measurement that already
 * completed, while on a FAILURE path it is CHAINED onto the error already in
 * flight rather than replacing it. So `open` ALONE is wrapped (see
 * "Handle-release fault injection" below). It is a pass-through returning the
 * real handle, and only when a test explicitly arms a close failure does it
 * hand back an object DELEGATING to that same real handle with `close()`
 * overridden. Every `read`, every `fstat` and every byte in this file —
 * armed tests included — is still the real filesystem's.
 *
 * A new sibling file on purpose: `check:test-counts` pins a count for
 * `storage.test.ts` alone and treats the append-only siblings as unmatched
 * by design.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

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
  SegmentDigest,
  digestSegmentFile,
} from "../src/internal/storage/append-only-digest.js";
import type { SegmentDigestResult } from "../src/internal/storage/append-only-digest.js";
import type { AppendOnlyReadFailure } from "../src/internal/storage/append-only-lines.js";

// ---------------------------------------------------------------------------
// Handle-release fault injection
// ---------------------------------------------------------------------------

/**
 * The one fault real bytes cannot produce: a `close()` that rejects. Held in
 * `vi.hoisted` state because the `vi.mock` factory below is hoisted above
 * every import in this file, and a plain module-level `const` would not yet
 * be initialized when that factory runs.
 */
const faults = vi.hoisted(() => ({
  /**
   * When set, every `open()` from here on returns a handle whose `close()`
   * rejects with this error. `undefined` — the state every test both starts
   * and ends in — makes the wrapper a pure pass-through.
   */
  closeError: undefined as Error | undefined,
  /**
   * The REAL handles behind an armed close failure. Their `close()` was
   * never reached, so this suite releases them itself rather than leaking a
   * descriptor (and Node's garbage-collection warning about one) into the
   * rest of the run.
   */
  unreleased: [] as FsPromises.FileHandle[],
  /**
   * How many times an ARMED handle's `close()` was called in the current
   * test. The only observable trace of a close on a path whose whole
   * contract is to stay silent about its failure — without it, a test of
   * that path passes identically against a module that never attempts the
   * release at all.
   */
  closeAttempts: 0,
  /**
   * When set, the SECOND `stat()` call on a freshly opened handle first
   * appends this many bytes to the SAME file through a second, independent
   * descriptor, then lets the real handle's own `stat()` report the grown
   * size. `undefined` (the state every test starts and ends in) makes the
   * wrapper a pure pass-through, exactly like `closeError` above.
   *
   * This is the narrow injection this suite uses in place of real
   * concurrency. `digestSegmentFile` calls `handle.stat()` TWICE on the same
   * handle: once from `assertSegmentIsReadable`'s pre-read `fstat` refusal,
   * and once from `digestOpenSegment`'s POST-read growth check. Growing on
   * the FIRST call would inflate the bytes the read loop itself digests
   * (proven the hard way: the first version of this fixture did exactly
   * that, and `byteLength` came back already including the grown bytes).
   * Growing on the second call reproduces "a concurrent append landed
   * between the read loop reaching end-of-file and the post-read `fstat`"
   * deterministically, without a real second process racing this one.
   */
  growBytesOnStat: undefined as number | undefined,
  /**
   * How many times an armed handle's `stat()` was actually called. The only
   * observable trace that the growth fired at the seam this suite claims,
   * rather than the refusal (or its absence) coming from somewhere else.
   */
  statAttempts: 0,
}));

/**
 * `open` and nothing else: `importOriginal` keeps every other export — the
 * `readFile`/`stat`/`mkdtemp`/`writeFile`/`symlink`/`link`/`rm` this file
 * uses, and the `read()` the module's own chunk loop runs — the genuine
 * article. Unarmed (every pre-existing test here) the wrapper returns the
 * real handle unchanged, so those tests reach the same filesystem through the
 * same call they did before this mock existed.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const open: typeof actual.open = async (filePath, flags, mode) => {
    const handle = await actual.open(filePath, flags, mode);
    const { closeError, growBytesOnStat } = faults;
    if (closeError === undefined && growBytesOnStat === undefined) {
      return handle;
    }
    // Prototype delegation, not a hand-written fake: `read()` and (unless
    // armed below) `stat()`/`close()` remain the real handle's own methods
    // over the real descriptor, so the bytes and the `fstat` refusals under
    // test are untouched and ONLY the armed method's behavior changes.
    const derived: FsPromises.FileHandle = Object.create(
      handle,
    ) as FsPromises.FileHandle;
    if (closeError !== undefined) {
      faults.unreleased.push(handle);
      derived.close = (): Promise<void> => {
        faults.closeAttempts += 1;
        return Promise.reject(closeError);
      };
    }
    if (growBytesOnStat !== undefined) {
      const growBytes = growBytesOnStat;
      derived.stat = (async () => {
        faults.statAttempts += 1;
        // Only the SECOND `stat()` call grows the file — see
        // `faults.growBytesOnStat`'s own doc above for why the first call
        // (the pre-read `fstat` refusal) must stay untouched. Append through
        // a SECOND, independent descriptor on the same path — `fstat` on the
        // real handle below reflects the file's current size regardless of
        // which descriptor wrote it.
        if (faults.statAttempts === 2) {
          await actual.appendFile(filePath, "g".repeat(growBytes));
        }
        return handle.stat();
      }) as FsPromises.FileHandle["stat"];
    }
    return derived;
  };
  return { ...actual, open };
});

/**
 * Arms a "grew during read" fault for the remainder of the current test —
 * see `faults.growBytesOnStat` above for the exact seam and why it stands in
 * for real concurrency.
 */
function armGrowDuringRead(growBytes: number): void {
  faults.growBytesOnStat = growBytes;
}

/**
 * Arms the close failure for the remainder of the current test and returns
 * the error a failing `close()` rejects with, so the test can assert on its
 * identity rather than on a message.
 */
function armCloseFailure(): Error {
  const closeError = new Error("simulated EIO on close");
  faults.closeError = closeError;
  return closeError;
}

afterEach(async () => {
  faults.closeError = undefined;
  faults.closeAttempts = 0;
  faults.growBytesOnStat = undefined;
  faults.statAttempts = 0;
  const unreleased = faults.unreleased.splice(0);
  await Promise.all(
    unreleased.map(async (handle) => {
      try {
        await handle.close();
      } catch {
        // Nothing left to release; the descriptor is already gone.
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Independently pinned digests
// ---------------------------------------------------------------------------

/**
 * `sha256` of ZERO bytes — the well-known empty-input digest, reproducible
 * with `printf '' | sha256sum`. Hard-coded rather than computed so the
 * "no framing, no salt, no canonicalization" half of ADR-0102's contract is
 * pinned by a value that cannot move with the implementation.
 */
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The exact bytes of one minimal JSONL entry, terminating newline included. */
const ONE_ENTRY = '{"a":1}\n';

/**
 * `sha256` of {@link ONE_ENTRY}'s 8 bytes, reproducible off-host with
 * `printf '{"a":1}\n' | sha256sum`. The second hard-coded literal: together
 * with {@link EMPTY_SHA256} it makes a redefinition of the digest visible
 * even if every derived assertion in this file were recomputed alongside it.
 */
const ONE_ENTRY_SHA256 =
  "e346432021b04179518d9614f3560ccd71354a4ee101ddcb893d6959a9d6301c";

/** 64 lowercase hex characters — the documented shape of `sha256`. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns `value`, or throws — used in place of a forbidden `!` assertion. */
function definedOrThrow<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

/**
 * The digest computed INDEPENDENTLY of the module under test, straight from
 * `node:crypto`, so neither side of a comparison is produced by the code the
 * comparison exists to check.
 */
function referenceSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Feeds one `SegmentDigest` every chunk in order and finishes it. */
function digestChunks(chunks: readonly Uint8Array[]): SegmentDigestResult {
  const digest = new SegmentDigest();
  for (const chunk of chunks) {
    digest.update(chunk);
  }
  return digest.finish();
}

/**
 * Asserts a misuse of a finished {@link SegmentDigest} is refused with the
 * library's own caller-input failure: an `M3LError` carrying
 * `ERR_INVALID_ARGUMENT`, never a bare `Error` and never a stray `TypeError`
 * a later refactor happens to produce. The class is load-bearing, not
 * decoration — this class is driven from the reader's inline verification on
 * the PUBLIC read path, so a misuse escaping as anything else is invisible to
 * a caller's `instanceof M3LError` catch.
 */
function expectInvalidArgument(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LError);
  expect(thrown).toMatchObject({ code: "ERR_INVALID_ARGUMENT" });
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

/** The `errno` code of a chained filesystem cause, when it has one. */
function errnoCodeOf(value: unknown): string | undefined {
  if (value instanceof Error && "code" in value) {
    const { code } = value;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
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
 * A real failure port, not a mock of the behavior under test: it builds a
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
      code: "ERR_TEST_APPEND_ONLY_DIGEST",
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
 * what it handed the port carries no caller data — no path, no directory, no
 * file name — in the message or the `context`, per the repo-wide
 * error-hygiene rule. A chained filesystem `cause` is the deliberate
 * exception (an `ENOENT` from `node:fs` names the path by construction) and
 * is therefore NOT inspected here.
 */
function expectPortBuiltFailure(
  thrown: unknown,
  port: RecordingFailurePort,
  secrets: readonly string[],
): RecordedFailure {
  expect(port.calls).toHaveLength(1);
  const call = definedOrThrow(port.calls[0], "a recorded port failure");
  // Identity, not shape: an implementation that built its own error and threw
  // that instead would leave `calls` empty above, and one that called the port
  // but threw something else fails right here.
  expect(thrown).toBe(call.error);

  const serializedContext = JSON.stringify(call.context) ?? "";
  for (const secret of secrets) {
    expect(call.message).not.toContain(secret);
    expect(serializedContext).not.toContain(secret);
  }
  // Keys, not just values: a key like `segmentPath`/`fileName` announces
  // caller data even when the value happens to be redacted. `isFile` (from
  // `assertSegmentIsReadable`) is a library-computed fact and must survive
  // this check, which is why `file` is not in the pattern.
  for (const key of Object.keys(call.context)) {
    expect(key).not.toMatch(/path|dir|name/i);
  }
  return call;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "m3l-append-only-digest-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** Writes EXACT bytes to a file in the sandbox and returns its path. */
async function writeFixture(
  fileName: string,
  content: string | Uint8Array,
): Promise<string> {
  const filePath = path.join(sandbox, fileName);
  await writeFile(filePath, content);
  return filePath;
}

/** Every string a leaked path could be recognized by, for one fixture. */
function pathSecrets(filePath: string): readonly string[] {
  return [filePath, path.dirname(filePath), path.basename(filePath)];
}

// ---------------------------------------------------------------------------
// SegmentDigest — the incremental half
// ---------------------------------------------------------------------------

describe("SegmentDigest", () => {
  test("reports zero entries, zero bytes and the empty-input sha256 before any update", () => {
    const result = new SegmentDigest().finish();

    expect(result).toEqual({
      entryCount: 0,
      byteLength: 0,
      sha256: EMPTY_SHA256,
    });
    expect(result.sha256).toBe(referenceSha256(Buffer.alloc(0)));
  });

  test("pins one entry's digest against a hard-coded literal AND an independently computed hash", () => {
    const bytes = Buffer.from(ONE_ENTRY, "utf8");

    const result = digestChunks([bytes]);

    expect(result.sha256).toBe(ONE_ENTRY_SHA256);
    expect(result.sha256).toBe(referenceSha256(bytes));
    expect(result.sha256).toMatch(HEX_SHA256);
    expect(result.entryCount).toBe(1);
    expect(result.byteLength).toBe(8);
  });

  // `entryCount` counts newline-TERMINATED lines: a trailing unterminated
  // fragment is a partial write the writer has not finished, never an entry.
  test.each([
    { label: "empty input", content: "", entryCount: 0, byteLength: 0 },
    { label: "a lone newline", content: "\n", entryCount: 1, byteLength: 1 },
    { label: "one entry", content: ONE_ENTRY, entryCount: 1, byteLength: 8 },
    {
      label: "three entries",
      content: '{"a":1}\n{"b":2}\n{"c":3}\n',
      entryCount: 3,
      byteLength: 24,
    },
    {
      label: "an empty line between entries",
      content: '{"a":1}\n\n{"c":3}\n',
      entryCount: 3,
      byteLength: 17,
    },
    {
      label: "an unterminated trailing fragment",
      content: '{"a":1}\n{"b":2}\n{"c":3',
      entryCount: 2,
      byteLength: 22,
    },
    {
      label: "a single unterminated line",
      content: '{"a":1}',
      entryCount: 0,
      byteLength: 7,
    },
  ])(
    "counts $entryCount newline-terminated entries and $byteLength bytes for $label",
    ({ content, entryCount, byteLength }) => {
      const bytes = Buffer.from(content, "utf8");

      const result = digestChunks([bytes]);

      expect(result.entryCount).toBe(entryCount);
      expect(result.byteLength).toBe(byteLength);
      expect(result.sha256).toBe(referenceSha256(bytes));
    },
  );

  test("measures byteLength in raw bytes, not characters, for multi-byte UTF-8", () => {
    const content = '{"note":"café 🎉"}\n';
    const bytes = Buffer.from(content, "utf8");

    const result = digestChunks([bytes]);

    expect(result.byteLength).toBe(Buffer.byteLength(content, "utf8"));
    // The assertion above is only meaningful while the two genuinely differ.
    expect(result.byteLength).toBeGreaterThan(content.length);
    expect(result.entryCount).toBe(1);
    expect(result.sha256).toBe(referenceSha256(bytes));
  });

  describe("chunk-boundary independence", () => {
    // A newline byte and a two-byte `é` sit at known-but-computed offsets, so
    // a split can be placed INSIDE a multi-byte character and immediately
    // BEFORE a newline — the two boundaries a naive per-chunk decode or a
    // per-chunk line count would get wrong. This is the property that lets
    // the reader feed `SegmentDigest` from `readChunks`: if it fails, the
    // digest is a function of the chunking, not of the file's content.
    const CONTENT = '{"note":"café"}\n{"n":2}\n';
    const BYTES = Buffer.from(CONTENT, "utf8");
    const NEWLINE_BYTE = 0x0a;
    const E_ACUTE_LEAD_BYTE = 0xc3;
    const E_ACUTE_TRAIL_BYTE = 0xa9;
    const midMultibyte = BYTES.indexOf(E_ACUTE_LEAD_BYTE) + 1;
    const beforeNewline = BYTES.indexOf(NEWLINE_BYTE);

    test("the fixture really contains the two boundaries these tests split on", () => {
      // Without this the offsets could both collapse to 0 and every split
      // below would silently degenerate into "one whole chunk".
      expect(midMultibyte).toBeGreaterThan(0);
      expect(beforeNewline).toBeGreaterThan(0);
      expect(BYTES[midMultibyte]).toBe(E_ACUTE_TRAIL_BYTE);
      expect(BYTES[beforeNewline]).toBe(NEWLINE_BYTE);
    });

    test.each([
      { label: "inside a multi-byte character", offset: midMultibyte },
      { label: "immediately before a newline", offset: beforeNewline },
      { label: "after the first byte", offset: 1 },
    ])("produces an identical result when split $label", ({ offset }) => {
      const whole = digestChunks([BYTES]);

      const split = digestChunks([
        BYTES.subarray(0, offset),
        BYTES.subarray(offset),
      ]);

      expect(split).toEqual(whole);
      expect(split.entryCount).toBe(2);
      expect(split.byteLength).toBe(Buffer.byteLength(CONTENT, "utf8"));
      expect(split.sha256).toBe(referenceSha256(BYTES));
    });

    test("produces an identical result at every possible split offset", () => {
      const expected = digestChunks([BYTES]);

      for (let offset = 1; offset < BYTES.length; offset += 1) {
        const split = digestChunks([
          BYTES.subarray(0, offset),
          BYTES.subarray(offset),
        ]);
        expect({ offset, ...split }).toEqual({ offset, ...expected });
      }
    });

    test("produces an identical result fed one byte at a time", () => {
      const expected = digestChunks([BYTES]);

      const perByte = digestChunks(
        Array.from(BYTES, (byte) => Uint8Array.of(byte)),
      );

      expect(perByte).toEqual(expected);
    });

    test("accepts a plain Uint8Array, not only a Buffer", () => {
      // The reader's chunks are Buffers, but the declared parameter is
      // `Uint8Array`; a hasher that only works for one of them would make the
      // signature a lie.
      const plain = Uint8Array.from(BYTES);

      expect(digestChunks([plain])).toEqual(digestChunks([BYTES]));
    });
  });

  describe("finish() is terminal", () => {
    // Stated contract, not an accident of whatever `node:crypto`'s hash
    // object happens to do once digested: a seal is a claim about one exact
    // byte range, so a measurement that could be re-read or extended after
    // the fact is a measurement two callers could disagree about.

    test("refuses a second finish()", () => {
      const digest = new SegmentDigest();
      digest.update(Buffer.from(ONE_ENTRY, "utf8"));

      // The first finish must SUCCEED, so the throw below is about
      // terminality rather than an instance that never worked at all.
      expect(digest.finish()).toEqual({
        entryCount: 1,
        byteLength: 8,
        sha256: ONE_ENTRY_SHA256,
      });
      expectInvalidArgument(() => digest.finish());
    });

    test("refuses an update() after finish()", () => {
      const digest = new SegmentDigest();
      digest.update(Buffer.from(ONE_ENTRY, "utf8"));
      expect(digest.finish().entryCount).toBe(1);

      expectInvalidArgument(() => {
        digest.update(Buffer.from('{"late":true}\n', "utf8"));
      });
    });
  });
});

// ---------------------------------------------------------------------------
// digestSegmentFile — the one-shot half
// ---------------------------------------------------------------------------

describe("digestSegmentFile", () => {
  test("measures a segment's entries, bytes and sha256 in one pass", async () => {
    const content = '{"a":1}\n{"b":2}\n{"c":3}\n';
    const filePath = await writeFixture("segment.jsonl", content);
    const port = createFailurePort();

    const result = await digestSegmentFile(filePath, 1024, port.build);

    expect(result).toEqual({
      entryCount: 3,
      byteLength: 24,
      sha256: referenceSha256(Buffer.from(content, "utf8")),
    });
    expect(result.sha256).toMatch(HEX_SHA256);
    // A healthy segment must not report a failure on the side.
    expect(port.calls).toEqual([]);
  });

  test("pins a fixed file's digest against the hard-coded literal", async () => {
    const filePath = await writeFixture("one-entry.jsonl", ONE_ENTRY);
    const port = createFailurePort();

    const result = await digestSegmentFile(filePath, 1024, port.build);

    expect(result.sha256).toBe(ONE_ENTRY_SHA256);
    expect(result.entryCount).toBe(1);
    expect(result.byteLength).toBe(8);
  });

  test("reports the empty-input digest for an empty file", async () => {
    const filePath = await writeFixture("empty.jsonl", "");
    const port = createFailurePort();

    await expect(
      digestSegmentFile(filePath, 1024, port.build),
    ).resolves.toEqual({ entryCount: 0, byteLength: 0, sha256: EMPTY_SHA256 });
    expect(port.calls).toEqual([]);
  });

  test("does not count an unterminated trailing line as an entry", async () => {
    const content = '{"a":1}\n{"b":2}\n{"partial":';
    const filePath = await writeFixture("torn.jsonl", content);
    const port = createFailurePort();

    const result = await digestSegmentFile(filePath, 1024, port.build);

    expect(result.entryCount).toBe(2);
    expect(result.byteLength).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.sha256).toBe(referenceSha256(Buffer.from(content, "utf8")));
  });

  test("counts raw bytes, not characters, for a multi-byte segment", async () => {
    const content = '{"note":"café 🎉"}\n{"b":"ü"}\n';
    const filePath = await writeFixture("utf8.jsonl", content);
    const port = createFailurePort();

    const result = await digestSegmentFile(filePath, 1024, port.build);

    expect(result.byteLength).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.byteLength).toBeGreaterThan(content.length);
    expect(result.entryCount).toBe(2);
    expect(result.sha256).toBe(referenceSha256(Buffer.from(content, "utf8")));
  });

  test("agrees with the incremental digest over the same bytes", async () => {
    const content = Array.from(
      { length: 64 },
      (_unused, index) => `{"i":${String(index)}}\n`,
    ).join("");
    const filePath = await writeFixture("agree.jsonl", content);
    const port = createFailurePort();

    const fromFile = await digestSegmentFile(filePath, 1_048_576, port.build);

    expect(fromFile).toEqual(digestChunks([Buffer.from(content, "utf8")]));
  });

  test("reads a file spanning many chunks without dropping or reordering bytes", async () => {
    // Comfortably past any plausible internal chunk size, so the chunk loop
    // itself — not a single lucky read — is what produces the result.
    const content = Array.from(
      { length: 20_000 },
      (_unused, index) => `{"i":${String(index)}}\n`,
    ).join("");
    const bytes = Buffer.from(content, "utf8");
    const filePath = await writeFixture("large.jsonl", bytes);
    const port = createFailurePort();

    const result = await digestSegmentFile(filePath, bytes.length, port.build);

    expect(result.entryCount).toBe(20_000);
    expect(result.byteLength).toBe(bytes.length);
    expect(result.sha256).toBe(referenceSha256(bytes));
  });

  test("agrees with the incremental digest on a many-chunk file with no trailing newline", async () => {
    // The shape a CRASHED writer leaves behind — a process killed between
    // the content and its terminating newline — which the cold-start sweep
    // meets in practice. Combining "many chunks" with "torn tail" is the
    // case where a carry-over fragment spanning the final chunk boundary
    // could be miscounted as an entry or dropped from the byte total.
    const content = Array.from(
      { length: 20_000 },
      (_unused, index) => `{"i":${String(index)}}`,
    ).join("\n");
    const bytes = Buffer.from(content, "utf8");
    const filePath = await writeFixture("crashed.jsonl", bytes);
    const port = createFailurePort();

    const result = await digestSegmentFile(filePath, bytes.length, port.build);

    expect(result.entryCount).toBe(19_999);
    expect(result.byteLength).toBe(bytes.length);
    expect(result.sha256).toBe(referenceSha256(bytes));
    expect(result).toEqual(digestChunks([bytes]));
    expect(port.calls).toEqual([]);
  });

  describe("the maxBytes ceiling", () => {
    const EXACT_CONTENT = `${"a".repeat(63)}\n`;

    test("accepts a file of exactly maxBytes", async () => {
      const filePath = await writeFixture("exact.jsonl", EXACT_CONTENT);
      expect(Buffer.byteLength(EXACT_CONTENT, "utf8")).toBe(64);
      const port = createFailurePort();

      await expect(
        digestSegmentFile(filePath, 64, port.build),
      ).resolves.toEqual({
        entryCount: 1,
        byteLength: 64,
        sha256: referenceSha256(Buffer.from(EXACT_CONTENT, "utf8")),
      });
      expect(port.calls).toEqual([]);
    });

    test("refuses a file one byte over maxBytes", async () => {
      const filePath = await writeFixture("over.jsonl", EXACT_CONTENT);
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(filePath, 63, port.build),
      );

      expectPortBuiltFailure(thrown, port, pathSecrets(filePath));
    });

    // `/proc/self/status` is a regular, single-link file whose `stat` reports
    // ZERO bytes while a read of it yields well over a kilobyte — so it
    // separates the two candidate implementations of the ceiling with no
    // race to win: an `fstat` pre-check compares `0 <= 1` and RESOLVES with a
    // digest of bytes it never bounded, while a mid-read byte counter refuses
    // on the first chunk. The pre-check is a TOCTOU in production too (a
    // segment can grow between the `fstat` and the last read), and this is
    // the only fixture that proves which one shipped. Linux-only by
    // construction; the plain over-the-ceiling test above covers the rest.
    const PROC_STATUS_PATH = "/proc/self/status";

    test.skipIf(process.platform !== "linux")(
      "enforces maxBytes against the bytes actually read, not a pre-checked size",
      async () => {
        const stats = await stat(PROC_STATUS_PATH);
        const readable = await readFile(PROC_STATUS_PATH);
        // The fixture's discriminating property, asserted rather than
        // assumed: if `stat` ever started reporting the real size here, this
        // test would silently stop distinguishing the two implementations.
        expect(stats.isFile()).toBe(true);
        expect(stats.nlink).toBe(1);
        expect(stats.size).toBe(0);
        expect(readable.byteLength).toBeGreaterThan(1);
        // Explicit, not merely implied by the two assertions above: `stat`
        // UNDER-reports here (`size < byteLength`) — the opposite direction
        // from a segment that grew during the read (`size > byteLength`,
        // see "a segment that grows..." below).
        expect(stats.size).toBeLessThan(readable.byteLength);
        const port = createFailurePort();

        const thrown = await catchRejected(() =>
          digestSegmentFile(PROC_STATUS_PATH, 1, port.build),
        );

        expectPortBuiltFailure(thrown, port, [PROC_STATUS_PATH, "/proc"]);
      },
    );

    // The test above never reaches the POST-read growth check at all: with
    // `maxBytes: 1`, the mid-read ceiling (`byteLength > maxBytes`) refuses
    // on the very first chunk, before `digestOpenSegment` ever calls
    // `handle.stat()` a second time. This is the fixture that DOES reach it:
    // a `maxBytes` large enough to read the whole file resolves successfully,
    // even though the post-read `stat()` still reports `size: 0` against a
    // `byteLength` of well over a kilobyte — proving the post-read growth
    // check's `postReadStat.size > byteLength` comparison is deliberately
    // NOT `!==`, exactly like `EXACT_CONTENT`'s equal-size case is deliberately
    // not `>=`. A `!==` here would refuse this same, perfectly healthy file.
    test.skipIf(process.platform !== "linux")(
      "resolves when maxBytes is large enough to read /proc/self/status in full, even though its post-read stat still under-reports size",
      async () => {
        // Deliberately does NOT compare against a separately-read snapshot:
        // `/proc/self/status` is a LIVE kernel-generated file whose content
        // (e.g. `VmRSS`) can shift by a byte between two independent reads of
        // this same process's own status, which would make a byte-for-byte
        // comparison across two reads flaky for a reason that has nothing to
        // do with this module. The property under test only needs ONE read
        // through `digestSegmentFile` itself: that it resolves at all, over
        // a plausible, non-trivial byte count.
        const port = createFailurePort();

        const result = await digestSegmentFile(
          PROC_STATUS_PATH,
          1_048_576,
          port.build,
        );

        expect(result.byteLength).toBeGreaterThan(1000);
        expect(port.calls).toEqual([]);
      },
    );

    // A ceiling that is not a size a segment could have is not a small
    // ceiling every segment fails — it is not a ceiling at all, and it is
    // refused through the caller's own port before anything is opened.
    //
    // The fixture is deliberately EMPTY, because that is what makes these
    // rows discriminate. Left unvalidated, each of these values is
    // normalised into a working buffer size by the module's private
    // `digestChunkSize` (`Math.min(65_536, Math.max(1, maxBytes + 1))`), an
    // empty segment then yields no bytes, no ceiling is ever crossed, and
    // the call RESOLVES — reporting a seal under a bound nobody could state.
    // Every row below resolves under that implementation and rejects under
    // this one.
    test.each([
      { label: "zero", maxBytes: 0 },
      { label: "a negative ceiling", maxBytes: -1 },
      { label: "a fractional ceiling", maxBytes: 1.5 },
      { label: "NaN", maxBytes: Number.NaN },
      { label: "Infinity", maxBytes: Number.POSITIVE_INFINITY },
    ])(
      "refuses $label as a ceiling instead of measuring under it",
      async ({ maxBytes }) => {
        const filePath = await writeFixture("unusable-ceiling.jsonl", "");
        const port = createFailurePort();

        const thrown = await catchRejected(() =>
          digestSegmentFile(filePath, maxBytes, port.build),
        );

        const call = expectPortBuiltFailure(
          thrown,
          port,
          pathSecrets(filePath),
        );
        // The ceiling the caller passed in and NOTHING else: no path, and no
        // byte count of a segment that was never opened. `toEqual` rather
        // than `toMatchObject`, so an added key fails here.
        expect(call.context).toEqual({ maxBytes });
        expect(Object.keys(call.context)).toEqual(["maxBytes"]);
      },
    );

    test("refuses an unusable ceiling before the segment is opened", async () => {
      // A path that does not exist: were the ceiling checked after `open`,
      // the caller would get the ENOENT-caused digest failure instead — the
      // wrong vocabulary for what is a caller-input violation, and proof the
      // segment was reached at all.
      const filePath = path.join(sandbox, "never-opened.jsonl");
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(filePath, 0, port.build),
      );

      const call = expectPortBuiltFailure(thrown, port, pathSecrets(filePath));
      expect(call.context).toEqual({ maxBytes: 0 });
      // No chained filesystem cause, because no filesystem call happened.
      expect(call.cause).toBeUndefined();
      expect(errnoCodeOf(call.cause)).toBeUndefined();
    });
  });

  // [security] Fix B: a forward clock step — NTP, a VM snapshot restore, a
  // bad container clock, NO attacker required — can make today's still-active
  // segment look old enough for the sealer to sweep it. Measuring it mid-
  // append seals a PREFIX of a live file, and that healthy segment reads as
  // tampered forever after. `digestOpenSegment` re-`stat`s the handle once
  // the read loop reaches end-of-file and refuses when the segment has grown
  // past the bytes just digested (`postReadStat.size > byteLength`).
  describe("[security] a segment that grows between the read loop and the post-read stat", () => {
    test("refuses a measurement when the segment grew after the read loop reached end-of-file", async () => {
      const content = '{"a":1}\n{"b":2}\n';
      const filePath = await writeFixture("grows-after-read.jsonl", content);
      armGrowDuringRead(30);
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(filePath, 1024, port.build),
      );

      const call = expectPortBuiltFailure(thrown, port, pathSecrets(filePath));
      // Library-computed facts only, per this suite's usual hygiene check
      // above: the bytes actually digested, and the larger size the same
      // descriptor reported moments later — proof this is the growth
      // refusal specifically, not some other failure.
      const expectedByteLength = Buffer.byteLength(content, "utf8");
      expect(call.context).toMatchObject({ byteLength: expectedByteLength });
      const reportedSize = call.context["size"];
      expect(typeof reportedSize).toBe("number");
      expect(reportedSize as number).toBeGreaterThan(expectedByteLength);
      // Confirms the refusal came from the seam this test claims to have
      // injected at, not from some other cause coincidentally rejecting —
      // two `stat()` calls total (the pre-read `fstat` refusal, then the
      // post-read growth check that actually fires the growth).
      expect(faults.statAttempts).toBe(2);
    });

    test("still resolves when the segment does not grow after the read loop (control)", async () => {
      // Proves the armed `stat()` wrapper itself is not what causes the
      // refusal above: with no growth armed, an otherwise-identical
      // measurement over the same mocked `node:fs/promises` still resolves.
      const content = '{"a":1}\n{"b":2}\n';
      const filePath = await writeFixture("does-not-grow.jsonl", content);
      const port = createFailurePort();

      await expect(
        digestSegmentFile(filePath, 1024, port.build),
      ).resolves.toEqual({
        entryCount: 2,
        byteLength: Buffer.byteLength(content, "utf8"),
        sha256: referenceSha256(Buffer.from(content, "utf8")),
      });
      expect(port.calls).toEqual([]);
    });
  });

  describe("failure paths", () => {
    test("rejects when the file does not exist, chaining the filesystem cause", async () => {
      const filePath = path.join(sandbox, "absent.jsonl");
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(filePath, 1024, port.build),
      );

      const call = expectPortBuiltFailure(thrown, port, pathSecrets(filePath));
      // The chained `cause` is the deliberate exception to the no-caller-data
      // rule: it is the raw `node:fs` error and names the path itself.
      expect(errnoCodeOf(call.cause)).toBe("ENOENT");
    });

    test("refuses a symlink planted at the path instead of following it", async () => {
      const target = await writeFixture("target.jsonl", ONE_ENTRY);
      const planted = path.join(sandbox, "planted.jsonl");
      await symlink(target, planted);
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(planted, 1024, port.build),
      );

      // A module opening without `SEGMENT_READ_FLAGS`' `O_NOFOLLOW` would
      // RESOLVE here with the target's digest — the whole point of the
      // refusal is that a planted link cannot nominate foreign bytes for a
      // seal that will later be read as this segment's proof.
      expectPortBuiltFailure(thrown, port, [
        ...pathSecrets(planted),
        ...pathSecrets(target),
      ]);
      expect((await stat(target)).size).toBe(8);
    });

    test("refuses a hardlinked file, whose link count is not one", async () => {
      const original = await writeFixture("original.jsonl", ONE_ENTRY);
      const planted = path.join(sandbox, "planted-hardlink.jsonl");
      await link(original, planted);
      // Guards the fixture: a filesystem that silently declined the link
      // would leave this test asserting nothing about hardlinks at all.
      expect((await stat(planted)).nlink).toBe(2);
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(planted, 1024, port.build),
      );

      const call = expectPortBuiltFailure(thrown, port, pathSecrets(planted));
      // `assertSegmentIsReadable`'s own library-computed context — the proof
      // that the shared refusal fired, rather than some unrelated failure.
      expect(call.context).toMatchObject({ isFile: true, nlink: 2 });
    });
  });

  // The two close paths are hand-written branches whose entire point is that
  // they behave DIFFERENTLY from each other, so these tests are written to
  // tell them apart rather than to agree that "it throws": swap the two
  // behaviours in the implementation and each of the first two tests below
  // fails — the first would resolve with its measurement, the second would
  // surface the close failure instead of the error already in flight.
  describe("releasing the segment handle", () => {
    const CONTENT = '{"a":1}\n{"b":2}\n';

    test("throws a success-path close failure, returning no measurement", async () => {
      const filePath = await writeFixture("close-fails.jsonl", CONTENT);
      const control = createFailurePort();

      // Control run over the SAME bytes with a working close: the
      // measurement completes and resolves. Without it, the rejection below
      // would be equally consistent with a segment that simply cannot be
      // read, and the test would not be about the close at all.
      await expect(
        digestSegmentFile(filePath, 1024, control.build),
      ).resolves.toEqual({
        entryCount: 2,
        byteLength: 16,
        sha256: referenceSha256(Buffer.from(CONTENT, "utf8")),
      });
      expect(control.calls).toEqual([]);

      const closeError = armCloseFailure();
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(filePath, 1024, port.build),
      );

      // The caller receives the CLOSE failure, not the completed
      // `SegmentDigestResult` the control run proved is available: a seal
      // reported over a descriptor the OS never released is not a clean
      // measurement, so the finished result is displaced rather than
      // returned. `expectPortBuiltFailure` pins both halves — exactly one
      // port call, and the rejected value IS that call's error, so no
      // measurement object can have been resolved.
      const call = expectPortBuiltFailure(thrown, port, pathSecrets(filePath));
      expect(call.cause).toBe(closeError);
      // Exactly one port call (asserted above) is also the proof that the
      // best-effort release did NOT fire a second failure over the same
      // handle: the success path claims the close before attempting it. The
      // attempt count says the same thing from the other side — ONE close,
      // not a second one from the `finally`.
      expect(port.calls).toHaveLength(1);
      expect(faults.closeAttempts).toBe(1);
    });

    test("chains a failure-path close failure onto the error in flight instead of replacing it", async () => {
      // A ceiling refusal raised MID-READ, with the handle still open — the
      // state the best-effort release exists for.
      const filePath = await writeFixture(
        "over-and-close-fails.jsonl",
        CONTENT,
      );
      const closeError = armCloseFailure();
      const port = createFailurePort();

      const thrown = await catchRejected(() =>
        digestSegmentFile(filePath, 8, port.build),
      );

      expect(port.calls).toHaveLength(2);
      const primary = definedOrThrow(port.calls[0], "the primary failure");
      const closeFailure = definedOrThrow(port.calls[1], "the close failure");
      // The PRIMARY error is what the caller receives and must act on. An
      // implementation that let the close failure win here — the success
      // path's behaviour, applied to the wrong path — would surface
      // `closeFailure.error` and fail both assertions.
      expect(thrown).toBe(primary.error);
      expect(thrown).not.toBe(closeFailure.error);
      expect(primary.context).toMatchObject({ maxBytes: 8 });
      expect(primary.cause).toBeUndefined();
      // ...and the close failure is not silently dropped either: a
      // descriptor the OS refused to release is a real second fault, so it
      // stays reachable through the primary error's own cause chain.
      expect(closeFailure.cause).toBe(closeError);
      expect(primary.error.cause).toBe(closeFailure.error);
      expect(faults.closeAttempts).toBe(1);
      // Neither failure carries caller data, the same hygiene every other
      // port call in this suite is held to.
      for (const recorded of port.calls) {
        for (const secret of pathSecrets(filePath)) {
          expect(recorded.message).not.toContain(secret);
          expect(JSON.stringify(recorded.context) ?? "").not.toContain(secret);
        }
      }
    });

    test("stays silent about a close failure when no primary error exists to chain onto", async () => {
      // The only honest route to the no-primary arm of the best-effort
      // release: the caller's OWN error port throws, so the `catch` never
      // gets as far as building — let alone assigning — a primary error.
      // What the caller must still receive is the port's own failure,
      // UN-MUTATED: a cleanup failure is never grafted onto an error this
      // module did not build, and never replaces it either.
      const original = await writeFixture(
        "original-throwing-port.jsonl",
        ONE_ENTRY,
      );
      const planted = path.join(sandbox, "planted-throwing-port.jsonl");
      await link(original, planted);
      // The hardlink is what makes the port be called at all (the shared
      // `nlink` refusal), with the handle already open.
      expect((await stat(planted)).nlink).toBe(2);
      const closeError = armCloseFailure();
      const portError = new Error("the caller's own error port failed");
      const build: AppendOnlyReadFailure = () => {
        throw portError;
      };

      const thrown = await catchRejected(() =>
        digestSegmentFile(planted, 1024, build),
      );

      expect(thrown).toBe(portError);
      expect(thrown).not.toBe(closeError);
      expect(portError.cause).toBeUndefined();
      expect(Object.hasOwn(portError, "cause")).toBe(false);
      // Silence is the contract here, so it has to be told apart from the
      // module simply never reaching the release: the handle WAS closed
      // (once), that close DID fail, and nothing about it surfaced.
      expect(faults.closeAttempts).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("types", () => {
  test("SegmentDigestResult is the three readonly measurements", () => {
    expectTypeOf<SegmentDigestResult>().toEqualTypeOf<{
      readonly entryCount: number;
      readonly byteLength: number;
      readonly sha256: string;
    }>();
  });

  test("the two halves report the same result shape", () => {
    expectTypeOf<
      SegmentDigest["finish"]
    >().returns.toEqualTypeOf<SegmentDigestResult>();
    expectTypeOf(
      digestSegmentFile,
    ).returns.resolves.toEqualTypeOf<SegmentDigestResult>();
    expectTypeOf(digestSegmentFile).parameters.toEqualTypeOf<
      [string, number, AppendOnlyReadFailure]
    >();
    expectTypeOf<Uint8Array>().toExtend<
      Parameters<SegmentDigest["update"]>[0]
    >();
  });
});
