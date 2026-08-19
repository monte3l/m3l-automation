/**
 * Tests for core/checkpoint submodule (RED phase — module not yet
 * implemented).
 *
 * Contract source: docs/reference/core/checkpoint.md.
 *
 * Exports under test: `M3LCheckpointStore` (class), `M3LCheckpointError`
 * (class), and types `M3LCheckpointStoreOptions`, `M3LCheckpointMissingPolicy`,
 * `M3LCheckpointPathsPort`, `M3LCheckpointErrorCode`.
 *
 * Key behavioral contracts under test:
 *  - read(): parses + validates a present file; applies the `missing` policy
 *    only on ENOENT (identity-return for `{kind:"empty"}`, throw
 *    ERR_CHECKPOINT_MISSING chaining the ENOENT cause for `{kind:"error"}`).
 *  - A present-but-corrupt file always throws ERR_CHECKPOINT_PARSE, even
 *    under a `{kind:"empty"}` policy — the missing policy governs absence
 *    only, never corruption.
 *  - ERR_CHECKPOINT_PARSE never chains the raw SyntaxError as `cause` and
 *    never leaks a snippet of the malformed content into `message` — a
 *    checkpoint may hold caller data.
 *  - A non-ENOENT read/write/delete failure always throws ERR_CHECKPOINT_IO,
 *    chaining the underlying errno error as `cause`.
 *  - write() is atomic: a uniquely-named temp file is written as a sibling of
 *    the target (never os.tmpdir()) and renamed onto it; a rejected rename
 *    must not corrupt the prior file and must not leave the temp file behind.
 *  - write()'s ENOENT (missing parent directory) maps to ERR_CHECKPOINT_IO,
 *    never ERR_CHECKPOINT_MISSING — that code is reserved for read().
 *  - delete() tolerates an absent file; a non-ENOENT failure is
 *    ERR_CHECKPOINT_IO.
 *  - `path` is resolved once at construction via
 *    `paths.resolveOutput(`${name}.checkpoint.json`)` and stays stable.
 *  - An unsafe `name` surfaces `M3LPathResolutionError` straight out of the
 *    constructor, unwrapped — never converted to `M3LCheckpointError`.
 */

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

import * as fsp from "node:fs/promises";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept individual
// functions while everything else still hits the real filesystem (ESM
// namespace objects are non-writable by default) — mirrors the pattern
// already used for 'fs' in tests/config.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

// Named imports (not `fsp.<method>` member calls) are used for every direct,
// real-filesystem call in this file: the repo's `no-restricted-syntax` guard
// bans mutating `fs`/`fsp`/`fsPromises` *member-expression* calls in tests,
// but a bare identifier call (`mkdtemp(...)`) is unaffected — the same
// pattern `tests/files.test.ts` already relies on. `fsp` itself is retained
// only as the `vi.spyOn(fsp, "...")` target for the handful of tests that
// force a specific rejection.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  M3LCheckpointError,
  M3LCheckpointStore,
} from "../src/core/checkpoint/index.js";
import type {
  M3LCheckpointErrorCode,
  M3LCheckpointPathsPort,
  M3LCheckpointStoreOptions,
} from "../src/core/checkpoint/index.js";
import { M3LError } from "../src/core/errors/index.js";
import { canonicalJsonHash } from "../src/core/json/index.js";
import { M3LPathResolutionError } from "../src/core/utils/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestCheckpoint {
  readonly queryId?: string;
}

function isTestCheckpoint(value: unknown): value is TestCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const id = (value as Partial<TestCheckpoint>).queryId;
  return id === undefined || typeof id === "string";
}

const EMPTY_CHECKPOINT: TestCheckpoint = {};

/**
 * A checkpoint shape that additionally permits a self-referential `self`
 * field, so a test can construct a genuinely circular value that still
 * satisfies its own `validate` predicate — used only to prove
 * `canonicalJsonHash` rejects a circular checkpoint.
 */
interface CircularCheckpoint {
  readonly queryId?: string;
  self?: CircularCheckpoint;
}

function isCircularCheckpoint(value: unknown): value is CircularCheckpoint {
  return typeof value === "object" && value !== null;
}

function makePathsPort(dir: string): M3LCheckpointPathsPort {
  return {
    resolveOutput: (name: string) => path.join(dir, name),
  };
}

/**
 * Narrows a mock-call argument to `string`, guarding the possibly-`undefined`
 * indexed access (`mock.calls[0]?.[0]`) without a non-null assertion.
 */
function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `expected ${label} to be a string, got ${typeof value}`,
    );
  }
  return value;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "m3l-checkpoint-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// M3LCheckpointStore.read()
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore.read()", () => {
  test("happy path: a valid checkpoint file on disk parses and validates, returned as TCheckpoint", async () => {
    const filePath = path.join(dir, "run-a.checkpoint.json");
    await writeFile(filePath, JSON.stringify({ queryId: "q-1" }), "utf8");
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-a",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await expect(store.read()).resolves.toEqual({ queryId: "q-1" });
  });

  test("{kind:'empty'} policy: file absent (ENOENT) resolves with the supplied value BY IDENTITY, not a clone", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-missing-empty",
      validate: isTestCheckpoint,
      missing: { kind: "empty", value: EMPTY_CHECKPOINT },
    });

    const result = await store.read();
    expect(result).toBe(EMPTY_CHECKPOINT);
  });

  test("{kind:'error'} policy: file absent (ENOENT) throws ERR_CHECKPOINT_MISSING chaining the ENOENT cause", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-missing-error",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_MISSING");
    const cause = (thrown as M3LCheckpointError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("a {kind:'empty'} policy does NOT suppress ERR_CHECKPOINT_PARSE for a present-but-corrupt file", async () => {
    const filePath = path.join(dir, "run-corrupt.checkpoint.json");
    await writeFile(filePath, "{ not valid json", "utf8");
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-corrupt",
      validate: isTestCheckpoint,
      missing: { kind: "empty", value: EMPTY_CHECKPOINT },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_PARSE");
  });

  test("invalid JSON: throws ERR_CHECKPOINT_PARSE with cause undefined and no raw-content leak in the message", async () => {
    const SENSITIVE_MARKER = "sekrit-marker-9f3a-do-not-leak";
    const filePath = path.join(dir, "run-invalid-json.checkpoint.json");
    await writeFile(
      filePath,
      `{ "queryId": "${SENSITIVE_MARKER}", not valid json`,
      "utf8",
    );
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-invalid-json",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_PARSE");
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    expect((thrown as M3LCheckpointError).message).not.toContain(
      SENSITIVE_MARKER,
    );
  });

  test("valid JSON failing validate: throws the same ERR_CHECKPOINT_PARSE code", async () => {
    const filePath = path.join(dir, "run-invalid-shape.checkpoint.json");
    await writeFile(filePath, JSON.stringify({ queryId: 42 }), "utf8");
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-invalid-shape",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_PARSE");
  });

  test("a non-ENOENT read failure (EACCES) throws ERR_CHECKPOINT_IO chaining the underlying errno error", async () => {
    const eaccesError = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fsp, "readFile").mockRejectedValueOnce(eaccesError);

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-locked-read",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
    expect((thrown as M3LCheckpointError).cause).toBe(eaccesError);
  });
});

// ---------------------------------------------------------------------------
// M3LCheckpointStore.write()
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore.write()", () => {
  test("happy path: after write(), read() returns the written value back out (round-trip)", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-roundtrip",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await store.write({ queryId: "q-roundtrip" });
    await expect(store.read()).resolves.toEqual({ queryId: "q-roundtrip" });
  });

  test("atomicity: the temp file is written as a sibling of the target directory, never os.tmpdir()", async () => {
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    const renameSpy = vi.spyOn(fsp, "rename").mockResolvedValue(undefined);

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-atomic",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await store.write({ queryId: "q-atomic" });

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const tempPathArg = asString(
      writeFileSpy.mock.calls[0]?.[0],
      "temp write path",
    );
    expect(path.dirname(tempPathArg)).toBe(dir);
    expect(path.dirname(tempPathArg)).not.toBe(tmpdir());

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const renameFrom = asString(renameSpy.mock.calls[0]?.[0], "rename from");
    const renameTo = asString(renameSpy.mock.calls[0]?.[1], "rename to");
    expect(renameFrom).toBe(tempPathArg);
    expect(renameTo).toBe(store.path);
  });

  test("atomicity: temp file names are unique across calls (no fixed shared temp name)", async () => {
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    vi.spyOn(fsp, "rename").mockResolvedValue(undefined);

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-unique-temp",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await store.write({ queryId: "q-1" });
    await store.write({ queryId: "q-2" });

    expect(writeFileSpy).toHaveBeenCalledTimes(2);
    const firstTemp = asString(
      writeFileSpy.mock.calls[0]?.[0],
      "first temp path",
    );
    const secondTemp = asString(
      writeFileSpy.mock.calls[1]?.[0],
      "second temp path",
    );
    expect(firstTemp).not.toBe(secondTemp);
  });

  test("a rejecting rename leaves the prior file's content byte-intact and removes the temp file", async () => {
    // Real disk for the successful first write and for the byte-level
    // assertions below; only `rename` is mocked (once) to force the specific
    // failure this test proves. A permissions-based approach (chmod 0) is
    // unreliable here because CI/containers commonly run tests as root,
    // where permission checks are bypassed — the failure would silently not
    // reproduce and the test would pass without exercising anything.
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-rename-fail",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await store.write({ queryId: "original" });
    const beforeBytes = await readFile(store.path, "utf8");

    const renameFailure = Object.assign(new Error("EPERM: rename failed"), {
      code: "EPERM",
    });
    vi.spyOn(fsp, "rename").mockRejectedValueOnce(renameFailure);

    await expect(store.write({ queryId: "should-not-land" })).rejects.toThrow();

    const afterBytes = await readFile(store.path, "utf8");
    expect(afterBytes).toBe(beforeBytes);

    const entries = await readdir(dir);
    expect(entries).toEqual([path.basename(store.path)]);
  });

  test("ENOENT from a missing parent directory maps to ERR_CHECKPOINT_IO, never ERR_CHECKPOINT_MISSING", async () => {
    const missingParentDir = path.join(dir, "does-not-exist");
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(missingParentDir),
      name: "run-no-parent",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.write({ queryId: "q-1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
    expect((thrown as M3LCheckpointError).code).not.toBe(
      "ERR_CHECKPOINT_MISSING",
    );
  });

  test("regression: write() wraps a canonicalJsonHash failure (e.g. a circular checkpoint) as M3LCheckpointError, not a bare M3LError", async () => {
    // write() computes `canonicalJsonHash(checkpoint)` to build the envelope
    // checksum BEFORE entering its try/catch — a circular checkpoint value
    // makes canonicalJsonHash throw a bare M3LError (ERR_INVALID_ARGUMENT),
    // which today escapes write() unwrapped instead of being reported as the
    // documented M3LCheckpointError ERR_CHECKPOINT_IO.
    const circular: CircularCheckpoint = { queryId: "q-circular" };
    circular.self = circular;

    const store = new M3LCheckpointStore<CircularCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-circular-checksum",
      validate: isCircularCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.write(circular);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
  });
});

// ---------------------------------------------------------------------------
// M3LCheckpointStore — content-addressed envelope (checksum integrity)
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore — content-addressed envelope", () => {
  test("write() then read() round-trips a value unchanged through the public API", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-envelope-roundtrip",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await store.write({ queryId: "q-envelope" });
    await expect(store.read()).resolves.toEqual({ queryId: "q-envelope" });
  });

  test("read() rejects with M3LCheckpointError ERR_CHECKPOINT_CORRUPT when an envelope's checksum does not match its payload", async () => {
    const filePath = path.join(dir, "run-tampered.checkpoint.json");
    // Hand-crafted envelope: `checksum` deliberately does NOT match
    // canonicalJsonHash({ queryId: "tampered" }) — simulates a hand-edited or
    // partially-corrupted-but-still-parseable-and-still-validate()-passing
    // checkpoint file.
    const tamperedEnvelope = {
      __m3lCheckpointFormat: 1,
      checksum:
        "0000000000000000000000000000000000000000000000000000000000000000",
      payload: { queryId: "tampered" },
    };
    await writeFile(filePath, JSON.stringify(tamperedEnvelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-tampered",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    // ERR_CHECKPOINT_CORRUPT is not yet a member of M3LCheckpointErrorCode —
    // this comparison is expected to be a TYPE ERROR until the GREEN phase
    // adds it to the union. That type error IS the RED signal here; do not
    // cast around it.
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_CORRUPT");
  });

  test("read() still succeeds for a legacy pre-envelope file (bare JSON.stringify(checkpoint), no envelope, no integrity check)", async () => {
    const filePath = path.join(dir, "run-legacy.checkpoint.json");
    // Exactly what today's unmodified write() persists: the bare checkpoint,
    // no envelope wrapper — must keep reading successfully after the
    // envelope format is introduced, with no integrity check performed
    // (there is no checksum to check).
    await writeFile(filePath, JSON.stringify({ queryId: "legacy" }), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-legacy",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await expect(store.read()).resolves.toEqual({ queryId: "legacy" });
  });

  test("a well-formed envelope whose checksum correctly matches canonicalJsonHash(payload) reads back the payload", async () => {
    const filePath = path.join(dir, "run-valid-envelope.checkpoint.json");
    const payload: TestCheckpoint = { queryId: "q-valid-envelope" };
    const validEnvelope = {
      __m3lCheckpointFormat: 1,
      checksum: canonicalJsonHash(payload),
      payload,
    };
    await writeFile(filePath, JSON.stringify(validEnvelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-valid-envelope",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await expect(store.read()).resolves.toEqual(payload);
  });

  test("regression: read() wraps a stack-overflow from a deeply-nested external checkpoint as M3LCheckpointError, not a raw RangeError", async () => {
    // read() recomputes canonicalJsonHash(parsed.payload) to verify the
    // envelope checksum; canonicalJsonHash recurses per nesting level, so a
    // deeply-nested (attacker/corruption-controlled) checkpoint file blows
    // the call stack. The raw JSON text is built via string concatenation
    // (never via a recursive JSON.stringify(deepObject) or by constructing
    // the nested value as a real JS object) so *fixture setup* itself never
    // recurses — only Node's iterative JSON.parse touches this string before
    // the store's own canonicalJsonHash call recurses over the parsed value.
    const DEPTH = 20_000;
    let nestedPayloadJson = "0";
    for (let index = 0; index < DEPTH; index += 1) {
      nestedPayloadJson = `{"nested":${nestedPayloadJson}}`;
    }
    const envelopeJson = `{"__m3lCheckpointFormat":1,"checksum":"irrelevant-fails-before-comparison","payload":${nestedPayloadJson}}`;

    const filePath = path.join(dir, "run-deeply-nested.checkpoint.json");
    await writeFile(filePath, envelopeJson, "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-deeply-nested",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(RangeError);
    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_PARSE");
  });
});

// ---------------------------------------------------------------------------
// M3LCheckpointStore.delete()
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore.delete()", () => {
  test("resolves without throwing when the checkpoint file does not exist (ENOENT-tolerant)", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-never-written",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await expect(store.delete()).resolves.toBeUndefined();
  });

  test("a non-ENOENT delete failure throws ERR_CHECKPOINT_IO", async () => {
    const filePath = path.join(dir, "run-locked-delete.checkpoint.json");
    await writeFile(filePath, JSON.stringify({}), "utf8");
    const permissionError = Object.assign(
      new Error("EPERM: operation not permitted"),
      { code: "EPERM" },
    );
    vi.spyOn(fsp, "unlink").mockRejectedValueOnce(permissionError);

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-locked-delete",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.delete();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
  });
});

// ---------------------------------------------------------------------------
// M3LCheckpointStore.path
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore.path", () => {
  test("is resolved once via paths.resolveOutput(`${name}.checkpoint.json`) and is stable across repeated reads", async () => {
    const resolveOutput = vi.fn((name: string) => path.join(dir, name));
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: { resolveOutput },
      name: "run-path",
      validate: isTestCheckpoint,
      missing: { kind: "empty", value: EMPTY_CHECKPOINT },
    });

    expect(resolveOutput).toHaveBeenCalledTimes(1);
    expect(resolveOutput).toHaveBeenCalledWith("run-path.checkpoint.json");
    expect(store.path).toBe(path.join(dir, "run-path.checkpoint.json"));

    const firstAccess = store.path;
    await store.read();
    await store.read();
    const secondAccess = store.path;

    expect(secondAccess).toBe(firstAccess);
    // Resolution happens once at construction — repeated reads must not
    // trigger additional resolveOutput calls.
    expect(resolveOutput).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// M3LCheckpointStore constructor — pass-through of an unsafe `name`
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore constructor", () => {
  test("an unsafe name propagates M3LPathResolutionError unchanged, not wrapped in M3LCheckpointError", () => {
    const pathResolutionFailure = new M3LPathResolutionError(
      "resolveOutput rejected an unsafe name",
    );
    const throwingPaths: M3LCheckpointPathsPort = {
      resolveOutput: () => {
        throw pathResolutionFailure;
      },
    };

    let thrown: unknown;
    try {
      const store = new M3LCheckpointStore<TestCheckpoint>({
        paths: throwingPaths,
        name: "../escape",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
      });
      // Referenced solely to avoid an unused-variable lint finding in the
      // (unreachable, since the constructor is expected to throw) success
      // path.
      expect(store).toBeUndefined();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(pathResolutionFailure);
    expect(thrown).not.toBeInstanceOf(M3LCheckpointError);
  });
});

// ---------------------------------------------------------------------------
// M3LCheckpointError (direct construction)
// ---------------------------------------------------------------------------
describe("M3LCheckpointError", () => {
  test("omits context and cause when neither is supplied", () => {
    const error = new M3LCheckpointError("boom", {
      code: "ERR_CHECKPOINT_IO",
    });

    expect(error).toBeInstanceOf(M3LCheckpointError);
    expect(error).toBeInstanceOf(M3LError);
    expect(error.code).toBe("ERR_CHECKPOINT_IO");
    // M3LError's base constructor defaults an omitted `context` to `{}`
    // (never `undefined`) — this still exercises the omitted-context branch
    // of M3LCheckpointError's conditional spread.
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  test("round-trips context and cause when both are supplied", () => {
    const cause = new Error("underlying failure");
    const context = { path: "/tmp/run.checkpoint.json" };

    const error = new M3LCheckpointError("boom", {
      code: "ERR_CHECKPOINT_MISSING",
      context,
      cause,
    });

    expect(error.code).toBe("ERR_CHECKPOINT_MISSING");
    expect(error.context).toEqual(context);
    expect(error.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------
describe("type-level contract", () => {
  test("read() returns Promise<TCheckpoint>, not TCheckpoint | undefined, under the 'empty' missing policy", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-type-empty",
      validate: isTestCheckpoint,
      missing: { kind: "empty", value: EMPTY_CHECKPOINT },
    });

    const result = store.read();
    expectTypeOf(result).toEqualTypeOf<Promise<TestCheckpoint>>();
    await result;
  });

  test("read() returns Promise<TCheckpoint>, not TCheckpoint | undefined, under the 'error' missing policy", async () => {
    const filePath = path.join(dir, "run-type-error.checkpoint.json");
    await writeFile(filePath, JSON.stringify({}), "utf8");
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-type-error",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    const result = store.read();
    expectTypeOf(result).toEqualTypeOf<Promise<TestCheckpoint>>();
    await result;
  });

  test("M3LCheckpointErrorCode is exactly the 6-member union (no wider, no narrower)", () => {
    expectTypeOf<M3LCheckpointErrorCode>().toEqualTypeOf<
      | "ERR_CHECKPOINT_CORRUPT"
      | "ERR_CHECKPOINT_DEFINITION"
      | "ERR_CHECKPOINT_FINGERPRINT_MISMATCH"
      | "ERR_CHECKPOINT_IO"
      | "ERR_CHECKPOINT_MISSING"
      | "ERR_CHECKPOINT_PARSE"
    >();
  });

  test("M3LCheckpointStoreOptions<T>['definition'] is genuinely optional and accepts unknown — omitting the key is valid under exactOptionalPropertyTypes", () => {
    // When 'definition' is added as optional in GREEN: this type-checks clean
    // (the key is omitted, satisfying exactOptionalPropertyTypes which disallows
    // { definition: undefined } but permits key absence).
    // In RED: the field does not exist in M3LCheckpointStoreOptions, which means
    // the interface has no 'definition' member at all — a different kind of
    // optionality, but key absence still compiles. The RED signal is in
    // behavioral tests 1–11 that pass a definition value and prove the feature
    // is absent from the implementation.
    const options: M3LCheckpointStoreOptions<TestCheckpoint> = {
      paths: makePathsPort(dir),
      name: "run-type-no-def",
      validate: isTestCheckpoint,
      missing: { kind: "empty", value: EMPTY_CHECKPOINT },
      // 'definition' deliberately omitted — must be valid in GREEN
    };
    expect(options).toBeDefined();
  });

  test("M3LCheckpointStoreOptions<T>['missing'] rejects the 'error' arm paired with an extra 'value' field", () => {
    // Aliased so the excess-property literal below fits on the same line as
    // its `@ts-expect-error` directive — TS reports an excess-property error
    // at the offending property's own line, not the annotation's line, so a
    // multi-line literal would leave the directive "unused" while the real
    // error fires one line down.
    type Missing = M3LCheckpointStoreOptions<TestCheckpoint>["missing"];
    // @ts-expect-error -- the "error" arm must not accept a `value` field
    const impossible: Missing = { kind: "error", value: {} };
    expect(impossible).toBeDefined();
  });

  test("M3LCheckpointError is assignable to M3LCheckpointError['code']'s narrowed union", () => {
    expectTypeOf<
      M3LCheckpointError["code"]
    >().toEqualTypeOf<M3LCheckpointErrorCode>();
  });
});

// ---------------------------------------------------------------------------
// M3LCheckpointStore — fingerprint (definition binding)
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore — fingerprint (definition binding)", () => {
  test("write() with a definition stamps fingerprint: canonicalJsonHash(definition) on the envelope; read() with the same definition round-trips the payload", async () => {
    const definition = {
      query: "SELECT id FROM table_a",
      database: "analytics",
    };
    // 'definition' is not yet in M3LCheckpointStoreOptions — TypeScript will
    // flag the excess property below as an error (expected RED diagnostic for
    // the not-yet-existing feature; the literal union at write's call site
    // triggers excess-property checking). Vitest still runs and the test fails
    // at runtime: the envelope has no fingerprint field.
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-write",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition,
    });

    await store.write({ queryId: "q-fp-1" });

    const rawJson = await readFile(store.path, "utf8");
    const parsed: unknown = JSON.parse(rawJson);

    // In RED: the implementation ignores `definition` — no fingerprint is
    // written. This assertion fails for the right reason.
    expect(parsed).toHaveProperty("fingerprint", canonicalJsonHash(definition));

    // Same definition → round-trip must also resolve.
    const storeForRead = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-write",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition,
    });
    await expect(storeForRead.read()).resolves.toEqual({ queryId: "q-fp-1" });
  });

  test("write() without a definition omits the 'fingerprint' key entirely — Object.hasOwn returns false, not merely === undefined", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-absent",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await store.write({ queryId: "q-no-fp" });

    const rawJson = await readFile(store.path, "utf8");
    const parsed: unknown = JSON.parse(rawJson);

    // Absence of the key, not merely undefined value.
    expect(Object.hasOwn(parsed as object, "fingerprint")).toBe(false);
  });

  test("read() with a definition differing from the writer's throws ERR_CHECKPOINT_FINGERPRINT_MISMATCH; no sensitive value in message or context", async () => {
    const writerDefinition = {
      query: "SELECT secret_column FROM sensitive_table",
    };
    const readerDefinition = { query: "SELECT id FROM public_table" };

    const writerStore = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-mismatch",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: writerDefinition,
    });
    await writerStore.write({ queryId: "q-stale" });

    const readerStore = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-mismatch",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: readerDefinition,
    });

    let thrown: unknown;
    try {
      await readerStore.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    // ERR_CHECKPOINT_FINGERPRINT_MISMATCH not yet in M3LCheckpointErrorCode —
    // in RED the read() does not throw at all (the impl ignores definition),
    // so this assertion never runs; the test fails at the toBeInstanceOf above.
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_FINGERPRINT_MISMATCH",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    // Neither definition value nor either fingerprint appears in message or context.
    const SENSITIVE = "secret_column";
    expect((thrown as M3LCheckpointError).message).not.toContain(SENSITIVE);
    expect(
      JSON.stringify((thrown as M3LCheckpointError).context ?? {}),
    ).not.toContain(SENSITIVE);
  });

  test("read(): store has a definition but the on-disk envelope has no fingerprint → resumes (backward-compatible with pre-fingerprint envelopes)", async () => {
    const payload: TestCheckpoint = { queryId: "q-no-fp-field" };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: canonicalJsonHash(payload),
      payload,
      // no fingerprint field — simulates a file written before this feature existed
    };
    const filePath = path.join(dir, "run-fp-compat-read.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-compat-read",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: { query: "SELECT 1" },
    });

    // An envelope without a fingerprint is backward-compatible regardless of
    // whether the store has a definition.
    await expect(store.read()).resolves.toEqual(payload);
  });

  test("read(): store has no definition but the on-disk envelope carries a fingerprint → resumes (no current definition to compare against)", async () => {
    const payload: TestCheckpoint = { queryId: "q-fp-no-def" };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: canonicalJsonHash(payload),
      // A real fingerprint from a prior write — the store has no definition to
      // compare against, so it is ignored.
      fingerprint: canonicalJsonHash({ query: "SELECT 1" }),
      payload,
    };
    const filePath = path.join(dir, "run-fp-no-def.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-no-def",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await expect(store.read()).resolves.toEqual(payload);
  });

  test("read(): a legacy bare-JSON checkpoint file combined with a store that has a definition still resolves — legacy path is untouched by fingerprinting", async () => {
    const filePath = path.join(dir, "run-fp-legacy.checkpoint.json");
    await writeFile(
      filePath,
      JSON.stringify({ queryId: "q-legacy-fp" }),
      "utf8",
    );

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-legacy",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: { query: "SELECT 2" },
    });

    await expect(store.read()).resolves.toEqual({ queryId: "q-legacy-fp" });
  });

  test("read(): an envelope with a valid checksum but a non-string (numeric) fingerprint throws ERR_CHECKPOINT_CORRUPT", async () => {
    const payload: TestCheckpoint = { queryId: "q-num-fp" };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: canonicalJsonHash(payload),
      // A numeric fingerprint — present-but-non-string is a corrupt envelope,
      // not a legacy file (the spec is explicit: widen the envelope guard to
      // skip non-string fingerprints and the checksum check is also skipped).
      fingerprint: 12345,
      payload,
    };
    const filePath = path.join(dir, "run-fp-numeric.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-numeric",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    // In RED: the impl does not check the fingerprint type. The checksum IS
    // correct so the envelope passes, payload is returned, no error is thrown.
    // The test fails at toBeInstanceOf above — right reason: non-string
    // fingerprint check not implemented.
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_CORRUPT");
  });

  test("read(): a numeric fingerprint with a WRONG checksum still throws ERR_CHECKPOINT_CORRUPT — not silently resumed via legacy-path demotion", async () => {
    // A legacy-path demotion (treating the object as the raw checkpoint because
    // fingerprint is non-string) would also skip the checksum check, so a file
    // that would normally be CORRUPT either resolves or throws ERR_CHECKPOINT_PARSE
    // from validate — never ERR_CHECKPOINT_CORRUPT. This case proves the demotion
    // did NOT happen regardless of checksum correctness.
    // In the current RED impl: the envelope IS detected (format + string checksum
    // + payload all present), the bad checksum makes it throw ERR_CHECKPOINT_CORRUPT
    // — this test passes for the right behavioral reason even before fingerprint
    // support is added, and remains valid in GREEN.
    const payload: TestCheckpoint = { queryId: "q-num-fp-bad-cksum" };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum:
        "0000000000000000000000000000000000000000000000000000000000000000",
      fingerprint: 99,
      payload,
    };
    const filePath = path.join(dir, "run-fp-numeric-bad.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-numeric-bad",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    // ERR_CHECKPOINT_CORRUPT must be thrown (not PARSE from validate), confirming
    // the envelope was not demoted to the legacy path.
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_CORRUPT");
  });

  test("read(): both checksum and fingerprint are wrong → ERR_CHECKPOINT_CORRUPT (integrity check wins over meaning check)", async () => {
    const payload: TestCheckpoint = { queryId: "q-both-wrong" };
    const wrongFingerprint =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum:
        "0000000000000000000000000000000000000000000000000000000000000000",
      fingerprint: wrongFingerprint,
      payload,
    };
    const filePath = path.join(dir, "run-fp-both-wrong.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-both-wrong",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    // ERR_CHECKPOINT_CORRUPT, not ERR_CHECKPOINT_FINGERPRINT_MISMATCH —
    // checksum is verified before fingerprint per the spec's read matrix.
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_CORRUPT");
  });

  test("constructor: a circular reference in 'definition' throws ERR_CHECKPOINT_DEFINITION at construction time, with cause undefined and no value in the message", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-circular",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: circular,
      });
    } catch (error) {
      thrown = error;
    }

    // In RED: the constructor ignores 'definition' entirely, does not throw.
    // Test fails at toBeInstanceOf — right reason: DEFINITION validation absent.
    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    // The definition value must not appear in the message — it's a circular
    // object whose serialisation would be "[object Object]" at best.
    expect((thrown as M3LCheckpointError).message).not.toContain(
      "[object Object]",
    );
    // context carries only path, never the definition.
    const contextStr = JSON.stringify(
      (thrown as M3LCheckpointError).context ?? {},
    );
    expect(contextStr).not.toContain("self");
  });

  test("constructor: a BigInt 'definition' throws ERR_CHECKPOINT_DEFINITION at construction time, with cause undefined", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-bigint",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: BigInt(42),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
  });

  test("fingerprint stability: two definition objects with the same entries in different key order produce the same fingerprint — read() resumes, not ERR_CHECKPOINT_FINGERPRINT_MISMATCH", async () => {
    const definitionA = { database: "analytics", query: "SELECT id FROM t" };
    const definitionB = { query: "SELECT id FROM t", database: "analytics" };

    const writerStore = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-key-order",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: definitionA,
    });
    await writerStore.write({ queryId: "q-key-order" });

    const readerStore = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-key-order",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: definitionB,
    });

    // Canonical hashing: same content, different key order → identical fingerprint
    // → resumes cleanly without ERR_CHECKPOINT_FINGERPRINT_MISMATCH.
    // In RED: the impl ignores both definitions and resolves anyway — this test
    // passes in RED and serves as a behavioral regression test in GREEN.
    await expect(readerStore.read()).resolves.toEqual({
      queryId: "q-key-order",
    });
  });

  test("constructor: an unsafe name combined with a circular definition still throws M3LPathResolutionError — path resolution precedes definition hashing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const pathResolutionFailure = new M3LPathResolutionError(
      "resolveOutput rejected an unsafe name",
    );
    const throwingPaths: M3LCheckpointPathsPort = {
      resolveOutput: () => {
        throw pathResolutionFailure;
      },
    };

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: throwingPaths,
        name: "../escape",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: circular,
      });
    } catch (error) {
      thrown = error;
    }

    // Path resolution runs first in the constructor — the M3LPathResolutionError
    // propagates unwrapped before definition hashing even begins.
    expect(thrown).toBe(pathResolutionFailure);
    expect(thrown).toBeInstanceOf(M3LPathResolutionError);
    expect(thrown).not.toBeInstanceOf(M3LCheckpointError);
  });
});
