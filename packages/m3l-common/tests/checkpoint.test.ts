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
import { inspect } from "node:util";

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
    // wrongFingerprint is all a's — guaranteed to differ from
    // canonicalJsonHash({ query: "SELECT 1" }) (the store's real fingerprint).
    // A fingerprint-first implementation would see the mismatch and throw
    // ERR_CHECKPOINT_FINGERPRINT_MISMATCH; the correct checksum-first
    // implementation throws ERR_CHECKPOINT_CORRUPT (bad checksum) first.
    // Having a definition in the store is what makes this test discriminate:
    // without it #fingerprint is undefined, the mismatch branch never fires
    // regardless of ordering, and the test proves nothing about priority.
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
      // definition whose hash definitely differs from wrongFingerprint
      definition: { query: "SELECT 1" },
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

// ---------------------------------------------------------------------------
// A. definition rejection / acceptance — covers lines 378-396 + helper
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore constructor — definition rejection / acceptance", () => {
  // -------------------------------------------------------------------------
  // A1. Rejected definitions
  // -------------------------------------------------------------------------

  test.each([
    ["arrow function", () => 1],
    [
      "named function declaration",
      function namedFn() {
        return 1;
      },
    ],
  ])(
    "definition: %s — rejects with ERR_CHECKPOINT_DEFINITION (cause undefined, no definition value in message/context)",
    (_label, badDef) => {
      let thrown: unknown;
      try {
        new M3LCheckpointStore<TestCheckpoint>({
          paths: makePathsPort(dir),
          name: "run-def-fn",
          validate: isTestCheckpoint,
          missing: { kind: "error" },
          definition: badDef,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCheckpointError);
      expect((thrown as M3LCheckpointError).code).toBe(
        "ERR_CHECKPOINT_DEFINITION",
      );
      expect((thrown as M3LCheckpointError).cause).toBeUndefined();
      // The definition value itself must never appear in the public error output.
      const contextStr = JSON.stringify(
        (thrown as M3LCheckpointError).context ?? {},
      );
      expect((thrown as M3LCheckpointError).message).not.toContain("namedFn");
      expect(contextStr).not.toContain("namedFn");
    },
  );

  test("definition: symbol — rejects with ERR_CHECKPOINT_DEFINITION (cause undefined)", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-symbol",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: Symbol("test"),
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

  test.each([
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1, 2, 3])],
    ["RegExp", /x/],
  ])(
    "definition: %s — rejects with ERR_CHECKPOINT_DEFINITION (no accessible content → fingerprint identical to {})",
    (_label, badDef) => {
      let thrown: unknown;
      try {
        new M3LCheckpointStore<TestCheckpoint>({
          paths: makePathsPort(dir),
          name: "run-def-noop",
          validate: isTestCheckpoint,
          missing: { kind: "error" },
          definition: badDef,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCheckpointError);
      expect((thrown as M3LCheckpointError).code).toBe(
        "ERR_CHECKPOINT_DEFINITION",
      );
      expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    },
  );

  test("definition: class instance with only prototype accessors (no own enumerable props, no toJSON) — rejects with ERR_CHECKPOINT_DEFINITION", () => {
    // Data lives only in prototype getters — Object.keys() returns 0 own props.
    class ProtoAccessor {
      get value(): number {
        return 42;
      }
    }
    const instance = new ProtoAccessor();

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-proto-accessor",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: instance,
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

  test("definition: Proxy whose ownKeys trap throws — rejected (not a raw error escape) with ERR_CHECKPOINT_DEFINITION", () => {
    // The isContentDiscardingObject helper wraps its checks in try/catch
    // (line 128-130 of the impl): a hostile Proxy that throws must be treated
    // as content-discarding (fail safe), surfaced as ERR_CHECKPOINT_DEFINITION
    // from the constructor — never as a raw non-M3LCheckpointError.
    //
    // The target must be a NON-plain object (e.g. Map) so that isPlainObject()
    // returns false and the helper enters the try block rather than short-
    // circuiting at line 120. With a {} target, isPlainObject returns true and
    // the catch path (line 130) is never reached.
    const hostile = new Proxy(new Map(), {
      ownKeys(): never {
        throw new Error("hostile trap");
      },
      getOwnPropertyDescriptor(): never {
        throw new Error("hostile trap");
      },
    });

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-proxy",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: hostile,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    // The hostile proxy's raw error must not become the cause.
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // A2. Accepted definitions — construction succeeds; fingerprint is stamped
  // -------------------------------------------------------------------------

  test("definition: plain object { query: 'SELECT 1' } — accepted; write() stamps a fingerprint", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-def-plain",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: { query: "SELECT 1" },
    });

    await store.write({ queryId: "q-plain-def" });
    const rawJson = await readFile(store.path, "utf8");
    const parsed: unknown = JSON.parse(rawJson);
    expect(Object.hasOwn(parsed as object, "fingerprint")).toBe(true);
    expect(typeof (parsed as Record<string, unknown>)["fingerprint"]).toBe(
      "string",
    );
  });

  test("definition: empty plain object {} — accepted; construction succeeds", () => {
    expect(() => {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-empty-obj",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: {},
      });
    }).not.toThrow();
  });

  test.each([
    ["empty array []", []],
    ["non-empty array", [1, 2, 3]],
  ])(
    "definition: %s — accepted; write() stamps a fingerprint",
    async (_label, def) => {
      const store = new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-array",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: def,
      });

      await store.write({ queryId: "q-array-def" });
      const rawJson = await readFile(store.path, "utf8");
      const parsed: unknown = JSON.parse(rawJson);
      expect(Object.hasOwn(parsed as object, "fingerprint")).toBe(true);
    },
  );

  test("definition: Date — rejected with ERR_CHECKPOINT_DEFINITION (cause undefined, no value/type leak); a Date was accepted under the old toJSON rule but the new allowlist requires prototype === Object.prototype", () => {
    // Under the old shape-based guard, Date was accepted because it has a
    // callable toJSON — so canonicalJsonStringify serialised it as a string.
    // The new recursive allowlist rejects it because Date.prototype is not
    // Object.prototype or null: a class instance can hold state in #private
    // fields or prototype accessors that no serialiser and no type-test can
    // see. Pass a Date as date.toISOString() instead.
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-date",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: new Date("2026-01-01T00:00:00Z"),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    // The Date value itself (e.g. "2026-01-01") must not appear in the message
    // or context — the definition is never persisted or surfaced.
    expect((thrown as M3LCheckpointError).message).not.toContain("2026-01-01");
    const contextStr = JSON.stringify(
      (thrown as M3LCheckpointError).context ?? {},
    );
    expect(contextStr).not.toContain("2026-01-01");
  });

  test("definition: class instance with own data properties — rejected with ERR_CHECKPOINT_DEFINITION (cause undefined); class instances can hold #private state no serialiser can see", () => {
    // Under the old shape-based guard, a class with only plain own-data
    // properties was accepted because Object.keys() enumerated those fields.
    // The new recursive allowlist rejects it because the prototype is not
    // Object.prototype or null — the allowlist cannot verify that the class
    // holds no additional state in #private fields or prototype accessors.
    class WithOwnData {
      readonly query: string;
      readonly table: string;
      constructor(query: string, table: string) {
        this.query = query;
        this.table = table;
      }
    }
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-own-data",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: new WithOwnData("SELECT 1", "t"),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    // The class property values must not appear in the message or context.
    expect((thrown as M3LCheckpointError).message).not.toContain("SELECT 1");
    const contextStr = JSON.stringify(
      (thrown as M3LCheckpointError).context ?? {},
    );
    expect(contextStr).not.toContain("SELECT 1");
  });

  test.each([
    ["null", null],
    ["0", 0],
    ["false", false],
    ["empty string", ""],
    ["version string 'v1'", "v1"],
  ])(
    "definition: primitive %s — accepted; construction succeeds (null opts in, gate is !== undefined)",
    (_label, def) => {
      expect(() => {
        new M3LCheckpointStore<TestCheckpoint>({
          paths: makePathsPort(dir),
          name: "run-def-primitive",
          validate: isTestCheckpoint,
          missing: { kind: "error" },
          definition: def,
        });
      }).not.toThrow();
    },
  );

  test("definition: null — opts in to fingerprinting; write() stamps a real fingerprint (null !== undefined, gate is !== undefined)", async () => {
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-def-null",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: null,
    });

    await store.write({ queryId: "q-null-def" });
    const rawJson = await readFile(store.path, "utf8");
    const parsed: unknown = JSON.parse(rawJson);
    // null opted in → fingerprint key must be present and must be a string
    expect(Object.hasOwn(parsed as object, "fingerprint")).toBe(true);
    expect(typeof (parsed as Record<string, unknown>)["fingerprint"]).toBe(
      "string",
    );
  });
});

// ---------------------------------------------------------------------------
// B. Object.hasOwn prototype-pollution guard — security must-fix
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore — Object.hasOwn prototype-pollution guard", () => {
  test("polluted Object.prototype.fingerprint does not cause a false ERR_CHECKPOINT_FINGERPRINT_MISMATCH on a valid pre-fingerprint envelope (no own fingerprint key)", async () => {
    // A legacy pre-fingerprint envelope has a valid checksum but no own
    // 'fingerprint' property. Before the Object.hasOwn fix, a prototype-
    // polluted 'fingerprint' was read as if it were the envelope's own field,
    // causing a spurious ERR_CHECKPOINT_FINGERPRINT_MISMATCH and denying a
    // valid resume.
    const payload: TestCheckpoint = { queryId: "q-proto-polluted" };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: canonicalJsonHash(payload),
      // no own 'fingerprint' key — simulates a pre-fingerprint envelope
      payload,
    };
    const filePath = path.join(dir, "run-proto-pollution.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-proto-pollution",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: { query: "SELECT 1" },
    });

    // Pollute Object.prototype with an attacker-controlled fingerprint.
    // Use Object.defineProperty so we can control configurability and clean
    // up in finally regardless of how the test goes.
    Object.defineProperty(Object.prototype, "fingerprint", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: "ATTACKER",
    });

    let result: TestCheckpoint | undefined;
    let thrown: unknown;
    try {
      result = await store.read();
    } catch (error) {
      thrown = error;
    } finally {
      delete (Object.prototype as Record<string, unknown>)["fingerprint"];
    }

    // Must resolve — the prototype-polluted value must never be treated as
    // an own fingerprint on the envelope.
    expect(thrown).toBeUndefined();
    expect(result).toEqual(payload);
  });

  test("throwing getter on Object.prototype.fingerprint does not propagate a raw error from read()", async () => {
    // If read() uses a plain property access (envelope.fingerprint) instead of
    // Object.hasOwn, a throwing prototype getter would escape as a raw Error
    // with no M3LCheckpointError code, breaking the documented contract.
    const payload: TestCheckpoint = { queryId: "q-throwing-getter" };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: canonicalJsonHash(payload),
      // no own 'fingerprint' key
      payload,
    };
    const filePath = path.join(dir, "run-throwing-getter.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-throwing-getter",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: { query: "SELECT 1" },
    });

    Object.defineProperty(Object.prototype, "fingerprint", {
      configurable: true,
      enumerable: false,
      get(): never {
        throw new Error("getter trap — must not be invoked");
      },
    });

    let result: TestCheckpoint | undefined;
    let thrown: unknown;
    try {
      result = await store.read();
    } catch (error) {
      thrown = error;
    } finally {
      delete (Object.prototype as Record<string, unknown>)["fingerprint"];
    }

    // Must resolve normally — the getter is never invoked because Object.hasOwn
    // confirms the envelope has no own 'fingerprint' property before accessing it.
    expect(thrown).toBeUndefined();
    expect(result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// C. write()'s two ERR_CHECKPOINT_IO arms produce distinct messages
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore.write() — ERR_CHECKPOINT_IO arm distinctness", () => {
  test("unhashable-checkpoint arm and rename-failure arm both produce ERR_CHECKPOINT_IO but with DIFFERENT messages", async () => {
    // Arm 1: hash failure (circular checkpoint)
    const circular: CircularCheckpoint = { queryId: "q-circular-msg" };
    circular.self = circular;

    const hashStore = new M3LCheckpointStore<CircularCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-hash-msg",
      validate: isCircularCheckpoint,
      missing: { kind: "error" },
    });

    let hashThrown: unknown;
    try {
      await hashStore.write(circular);
    } catch (error) {
      hashThrown = error;
    }

    expect(hashThrown).toBeInstanceOf(M3LCheckpointError);
    expect((hashThrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
    const hashMessage = (hashThrown as M3LCheckpointError).message;

    // Arm 2: rename failure (I/O error after hashing succeeds)
    const ioStore = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-rename-msg",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    // Write once to set up the file, then fail the next rename.
    await ioStore.write({ queryId: "original" });
    const renameFailure = Object.assign(new Error("EPERM: rename failed"), {
      code: "EPERM",
    });
    vi.spyOn(fsp, "rename").mockRejectedValueOnce(renameFailure);

    let renameThrown: unknown;
    try {
      await ioStore.write({ queryId: "should-not-land" });
    } catch (error) {
      renameThrown = error;
    }

    expect(renameThrown).toBeInstanceOf(M3LCheckpointError);
    expect((renameThrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
    const renameMessage = (renameThrown as M3LCheckpointError).message;

    // The two arms must produce diagnostically distinct messages —
    // collapsing them back would be a diagnostic regression.
    expect(hashMessage).not.toBe(renameMessage);
    expect(hashMessage).not.toContain(renameMessage);
  });

  test("unhashable-checkpoint arm: cause is undefined and no caller data appears in the message", async () => {
    // The hash-failure arm must never chain cause (canonicalJsonHash's thrown
    // message can embed the caller's actual value, e.g. a DynamoDB primary key).
    const SENSITIVE_MARKER = "sensitive-value-must-not-leak-9f3a";
    const circular: CircularCheckpoint = { queryId: SENSITIVE_MARKER };
    circular.self = circular;

    const store = new M3LCheckpointStore<CircularCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-hash-no-leak",
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
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    expect((thrown as M3LCheckpointError).message).not.toContain(
      SENSITIVE_MARKER,
    );
  });
});

// ---------------------------------------------------------------------------
// D. Sixth read-matrix row: present-but-non-string fingerprint is ERR_CHECKPOINT_CORRUPT
//    unconditionally (whether or not the store has a definition)
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore — sixth read-matrix row (non-string fingerprint)", () => {
  test("a valid checksum with a non-string (numeric) fingerprint throws ERR_CHECKPOINT_CORRUPT even when the store HAS a definition — type check is unconditional", async () => {
    // Complements the existing definition-less variant at line ~971.
    // The corrupt-fingerprint check must fire before the fingerprint-mismatch
    // check — ERR_CHECKPOINT_CORRUPT, not ERR_CHECKPOINT_FINGERPRINT_MISMATCH.
    const payload: TestCheckpoint = { queryId: "q-num-fp-with-def" };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: canonicalJsonHash(payload),
      fingerprint: 99, // present-but-non-string → corrupt regardless of definition
      payload,
    };
    const filePath = path.join(dir, "run-fp-numeric-with-def.checkpoint.json");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-numeric-with-def",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      // A definition whose hash would match the envelope's numeric fingerprint
      // if the type check were skipped — this ensures CORRUPT fires because of
      // the non-string type, not because of a hash mismatch.
      definition: { query: "SELECT 1" },
    });

    let thrown: unknown;
    try {
      await store.read();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_CORRUPT");
  });
});

// ---------------------------------------------------------------------------
// E. Definition allowlist — round-2 regression and walk-branch coverage
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore constructor — definition allowlist (round-2)", () => {
  // -------------------------------------------------------------------------
  // E1. The motivating regression: nested non-plain objects in a plain-object definition
  // -------------------------------------------------------------------------

  test("regression: { region, logGroups: new Set([...]) } — rejected at construction; the nested Set canonicalises to {} so two runs over different log groups would fingerprint identically under the old denylist", () => {
    // This is the exact shape the spec documents as the motivating defect:
    // a denylist checking only top-level Map/Set/RegExp still accepted this
    // object, causing two runs over different log groups to resume from each
    // other's offsets silently. The recursive allowlist closes this.
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-reg-nested-set",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: {
          region: "eu-west-1",
          logGroups: new Set(["/aws/lambda/a"]),
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    // The definition value must not appear in the message or context.
    expect((thrown as M3LCheckpointError).message).not.toContain("eu-west-1");
    const contextStr = JSON.stringify(
      (thrown as M3LCheckpointError).context ?? {},
    );
    expect(contextStr).not.toContain("eu-west-1");
  });

  test("regression sibling: nested Map in a plain object — rejected (Map entries are invisible to canonical JSON, so two runs with different Map contents fingerprint identically)", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-reg-nested-map",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: { config: new Map([["key", "value"]]) },
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

  test("regression sibling: nested RegExp in a plain object — rejected", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-reg-nested-regexp",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: { pattern: /^foo/ },
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

  test("regression sibling: nested function-valued property in a plain object — rejected (functions canonicalise to null, silently losing their identity)", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-reg-nested-fn",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: { transform: (x: string) => x.toUpperCase() },
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

  // -------------------------------------------------------------------------
  // E2. Rejection at depth — bad values nested 2-3 levels inside plain objects/arrays
  // -------------------------------------------------------------------------

  test("rejection at depth: a Set nested two levels inside plain objects — rejected", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-depth-bad-set",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: { outer: { inner: new Set([1, 2]) } },
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

  test("rejection at depth: NaN nested inside an array inside a plain object — rejected (non-finite numbers are not accepted)", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-depth-bad-nan",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: { values: [1, NaN, 3] },
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

  // -------------------------------------------------------------------------
  // E3. Non-finite numbers: NaN, Infinity, -Infinity — top-level
  // -------------------------------------------------------------------------

  test.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])(
    "definition: %s (top-level) — rejected with ERR_CHECKPOINT_DEFINITION (non-finite numbers are not accepted)",
    (_label, badDef) => {
      let thrown: unknown;
      try {
        new M3LCheckpointStore<TestCheckpoint>({
          paths: makePathsPort(dir),
          name: "run-def-nonfinite",
          validate: isTestCheckpoint,
          missing: { kind: "error" },
          definition: badDef,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LCheckpointError);
      expect((thrown as M3LCheckpointError).code).toBe(
        "ERR_CHECKPOINT_DEFINITION",
      );
      expect((thrown as M3LCheckpointError).cause).toBeUndefined();
    },
  );

  // -------------------------------------------------------------------------
  // E4. bigint, Symbol, and functions — nested form (top-level already covered in A1)
  // -------------------------------------------------------------------------

  test("definition: bigint nested in a plain object — rejected with ERR_CHECKPOINT_DEFINITION", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-nested-bigint",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: { count: BigInt(42) },
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

  test("definition: Symbol nested in a plain object — rejected with ERR_CHECKPOINT_DEFINITION", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-nested-symbol",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: { tag: Symbol("tag") },
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

  test("definition: function nested inside an array — rejected with ERR_CHECKPOINT_DEFINITION", () => {
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-nested-fn-arr",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: [1, () => 2, 3],
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

  // -------------------------------------------------------------------------
  // E5. Map/Set subclass with own property — rejected (prototype is not Object.prototype)
  // -------------------------------------------------------------------------

  test("definition: Map subclass with an own data property — rejected; its Map entries are invisible to canonical JSON, and its prototype is not Object.prototype", () => {
    // Previously a denylist checking instanceof Map might miss a subclass.
    // The allowlist rejects all class instances since their prototype is not
    // Object.prototype or null.
    class TaggedMap extends Map<string, number> {
      readonly label: string;
      constructor(label: string) {
        super();
        this.label = label;
      }
    }
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-map-subclass",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: new TaggedMap("my-map"),
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

  // -------------------------------------------------------------------------
  // E6. Class with non-callable toJSON on prototype — rejected
  // -------------------------------------------------------------------------

  test("definition: class whose prototype has a non-callable toJSON property — rejected; class instances are not plain objects regardless of toJSON", () => {
    // Previously canonicalJsonStringify required a callable toJSON, so a
    // non-callable toJSON fell through to {} serialisation — two different
    // instances of this class would fingerprint identically. The allowlist
    // rejects all class instances outright.
    class WithNonCallableToJSON {
      readonly toJSON: string = "not a function";
    }
    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-non-callable-tojson",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: new WithNonCallableToJSON(),
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

  // -------------------------------------------------------------------------
  // E7. null-prototype object (Object.create(null)) — ACCEPTED
  // -------------------------------------------------------------------------

  test("definition: null-prototype plain object (Object.create(null)) — accepted; construction succeeds", () => {
    // Object.create(null) has prototype === null, which is one of the two
    // allowlisted prototypes alongside Object.prototype. Useful for config
    // dicts parsed from YAML/TOML with no inherited properties.
    const nullProtoObj = Object.create(null) as Record<string, unknown>;
    nullProtoObj["region"] = "us-east-1";
    nullProtoObj["limit"] = 100;

    expect(() => {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-null-proto",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: nullProtoObj,
      });
    }).not.toThrow();
  });

  test("definition: null-prototype object — accepted; write() stamps a real 64-char hex fingerprint", async () => {
    const nullProtoObj = Object.create(null) as Record<string, unknown>;
    nullProtoObj["query"] = "SELECT 1";

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-def-null-proto-fp",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: nullProtoObj,
    });

    await store.write({ queryId: "q-null-proto" });
    const rawJson = await readFile(store.path, "utf8");
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const fp = parsed["fingerprint"];
    expect(typeof fp).toBe("string");
    expect((fp as string).length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(fp as string)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // E8. Depth limit — structure exceeding DEFINITION_MAX_DEPTH (512)
  // -------------------------------------------------------------------------

  test("definition: structure nested deeper than DEFINITION_MAX_DEPTH — throws ERR_CHECKPOINT_DEFINITION, never a raw RangeError", () => {
    // DEFINITION_MAX_DEPTH = 512. Build a 514-deep structure in a loop so
    // fixture setup itself does not recurse — only the walk inside the
    // constructor does. A raw RangeError escaping would fail the
    // toBeInstanceOf(M3LCheckpointError) assertion.
    let deep: unknown = "leaf";
    for (let i = 0; i < 514; i++) {
      deep = { nested: deep };
    }

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-too-deep",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: deep,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(RangeError);
    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // E9. Hostile Proxy — one test per trap the walk touches
  //     (ownKeys trap already covered in describe block A above)
  // -------------------------------------------------------------------------

  test("definition: revoked Proxy — rejected with ERR_CHECKPOINT_DEFINITION, not a raw TypeError", () => {
    // A revoked Proxy throws a TypeError on any operation. The walk's
    // Array.isArray call invokes [[IsArray]] which throws on a revoked Proxy;
    // the try/catch in isDefinitionValueAccepted catches it (fail-closed) and
    // returns false → ERR_CHECKPOINT_DEFINITION.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-revoked-proxy",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: proxy,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
  });

  test("definition: Proxy whose getPrototypeOf trap throws — rejected with ERR_CHECKPOINT_DEFINITION, raw error does not escape", () => {
    // isDefinitionPlainObject wraps Object.getPrototypeOf in a try/catch —
    // a throwing trap is caught and treated as fail-closed (returns false),
    // surfaced as ERR_CHECKPOINT_DEFINITION. The raw trap error must not
    // become the cause or otherwise escape the constructor.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("getPrototypeOf trap — must not escape");
        },
      },
    );

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-getprototypeof-trap",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: hostile,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_DEFINITION",
    );
    // The trap's own error must not be chained as cause.
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();
  });

  test("definition: Proxy wrapping an array whose get trap throws on element access — rejected with ERR_CHECKPOINT_DEFINITION, raw error does not escape", () => {
    // Array.isArray works correctly for Proxies wrapping arrays (it calls
    // [[IsArray]] on the proxy target). The walk then enters isDefinitionArrayAccepted
    // and tries to read arr[i] via the get trap, which throws — caught by the
    // per-element try/catch (fail-closed). The `length` property must be let
    // through (to allow the for-loop bound check) so the throw happens at the
    // element-access step, exercising the inner catch rather than the outer one.
    const hostile = new Proxy([1, 2, 3], {
      get(target: number[], p: string | symbol, receiver: unknown): unknown {
        if (p === "length") return Reflect.get(target, p, receiver);
        throw new Error("array element get trap — must not escape");
      },
    });

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-array-get-trap",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: hostile,
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

  test("definition: Proxy wrapping a plain {} target whose ownKeys trap throws — rejected with ERR_CHECKPOINT_DEFINITION; the {} target makes Object.getPrototypeOf return Object.prototype so the walk reaches the ownKeys-catch branch in isDefinitionObjectAccepted", () => {
    // The A1 ownKeys test uses a Map as the Proxy target, so the prototype
    // check (isDefinitionPlainObject) rejects it before isDefinitionObjectAccepted
    // is ever called. This test wraps {} (Object.prototype), ensuring the walk
    // actually reaches Object.keys() and exercises the ownKeys-catch path there.
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error(
            "ownKeys trap in plain-object walk — must not escape",
          );
        },
        getOwnPropertyDescriptor(): never {
          throw new Error("getOwnPropertyDescriptor trap — must not escape");
        },
      },
    );

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-ownkeys-plain-target",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: hostile,
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

  test("definition: Proxy whose get trap throws on property access — rejected with ERR_CHECKPOINT_DEFINITION, raw error does not escape", () => {
    // isDefinitionObjectAccepted wraps each property read in a try/catch —
    // a throwing get trap must be caught (fail-closed) and surfaced as
    // ERR_CHECKPOINT_DEFINITION, never as a raw Error.
    // The {} target means getPrototypeOf returns Object.prototype (passes the
    // plain-object check), and the ownKeys + getOwnPropertyDescriptor traps
    // expose one enumerable key — reaching the per-property get branch.
    const hostile = new Proxy(
      {},
      {
        ownKeys(_target: object): string[] {
          return ["data"];
        },
        getOwnPropertyDescriptor(
          _target: object,
          _key: string | symbol,
        ): PropertyDescriptor {
          return {
            value: undefined,
            writable: true,
            enumerable: true,
            configurable: true,
          };
        },
        get(_target: object, _p: string | symbol, _receiver: unknown): never {
          throw new Error("get trap — must not escape");
        },
      },
    );

    let thrown: unknown;
    try {
      new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-get-trap",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: hostile,
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

  // -------------------------------------------------------------------------
  // E10. Accepted shapes — real 64-char hex fingerprint actually stamped
  // -------------------------------------------------------------------------

  test("definition: realistic adopter settings object (logGroups as string[], undefined optional) — accepted; write() stamps a real 64-char hex fingerprint", async () => {
    // Mirrors the shape a Logs-Insights adopter would pass.
    const definition = {
      query: "fields @message | filter @message like /ERROR/",
      logGroups: ["/aws/lambda/my-fn", "/aws/lambda/other-fn"],
      limit: undefined, // undefined-valued properties are allowed and skipped
      windowMinutes: 60,
    };

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-def-adopter",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition,
    });

    await store.write({ queryId: "q-adopter" });
    const rawJson = await readFile(store.path, "utf8");
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const fp = parsed["fingerprint"];
    expect(typeof fp).toBe("string");
    expect((fp as string).length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(fp as string)).toBe(true);
  });

  test("definition: deeply nested plain object/array mix — accepted; write() stamps a fingerprint", async () => {
    const definition = {
      level1: {
        level2: [{ level3: { level4: "deep-value" } }, null, 42, false, ""],
      },
    };

    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-def-deep-mix",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition,
    });

    await store.write({ queryId: "q-deep-mix" });
    const rawJson = await readFile(store.path, "utf8");
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "fingerprint")).toBe(true);
    expect(typeof parsed["fingerprint"]).toBe("string");
  });

  test.each([
    ["empty object {}", {}],
    ["empty array []", []],
    ["null", null],
    ["0", 0],
    ["false", false],
    ["empty string ''", ""],
    ["negative float -1.5", -1.5],
  ])(
    "definition: %s — accepted; write() stamps a real 64-char hex fingerprint",
    async (_label, def) => {
      const store = new M3LCheckpointStore<TestCheckpoint>({
        paths: makePathsPort(dir),
        name: "run-def-primitive-fp",
        validate: isTestCheckpoint,
        missing: { kind: "error" },
        definition: def,
      });

      await store.write({ queryId: "q-primitive-fp" });
      const rawJson = await readFile(store.path, "utf8");
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const fp = parsed["fingerprint"];
      expect(typeof fp).toBe("string");
      expect((fp as string).length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(fp as string)).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // E11. Omitted key vs explicit undefined key — fingerprint identically
  // -------------------------------------------------------------------------

  test("definition: {a:1} and {a:1,b:undefined} produce the same stored fingerprint — load-bearing for adopters forwarding absent optional settings", async () => {
    // A property whose value is undefined is allowed and skipped during the
    // allowlist walk AND by JSON serialization. This means an adopter that
    // forwards an absent optional setting as an undefined-valued key gets the
    // same fingerprint as simply omitting the key — the two runs are
    // compatible for --resume.
    const storeWithout = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-omit",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: { a: 1 },
    });

    const storeWith = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-fp-undef",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
      definition: { a: 1, b: undefined },
    });

    await storeWithout.write({ queryId: "q-omit" });
    const rawWithout = await readFile(storeWithout.path, "utf8");
    const parsedWithout = JSON.parse(rawWithout) as Record<string, unknown>;

    await storeWith.write({ queryId: "q-undef" });
    const rawWith = await readFile(storeWith.path, "utf8");
    const parsedWith = JSON.parse(rawWith) as Record<string, unknown>;

    // Both envelopes must carry the same fingerprint — the undefined-valued
    // key is treated as absent for hashing purposes.
    expect(parsedWithout["fingerprint"]).toBe(parsedWith["fingerprint"]);
    expect(typeof parsedWithout["fingerprint"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// F. write() — serialization failure arm (Fix B)
//    JSON.stringify is hoisted out of the I/O try so its failure does not
//    reach the I/O catch, where the thrown message (embedding caller property
//    paths) would be chained as `cause`.
// ---------------------------------------------------------------------------
describe("M3LCheckpointStore.write() — serialization failure arm (Fix B)", () => {
  // Distinctive string planted as a PROPERTY NAME — that is the channel that
  // leaked before the fix: JSON.stringify errors can include property names in
  // their message (e.g. "Converting circular structure to JSON at property
  // SEKRET_PROP..."), and chaining that error as cause exposed it through
  // util.inspect.
  const SEKRET_KEY = "SEKRET_PROP_NAME_DO_NOT_LEAK_9f3a";

  test("non-idempotent toJSON: passes canonicalJsonHash on first call, returns circular structure (containing SEKRET_KEY) on second call so JSON.stringify fails → ERR_CHECKPOINT_IO with cause undefined, planted property name in no error output", async () => {
    // canonicalJsonStringify (used by canonicalJsonHash) calls toJSON() exactly
    // once on the checkpoint, then recursively canonicalizes the result.
    // Native JSON.stringify also calls toJSON() when it reaches the payload.
    // A non-idempotent toJSON that returns a safe value on call 1 (hash) and a
    // circular structure on call 2 (stringify) exercises the serialization
    // failure arm at line 787 of the implementation.
    //
    // The circular structure uses SEKRET_KEY as the property that closes the
    // cycle — Node.js JSON.stringify includes the property path in its circular-
    // structure error message. Before the fix, that error was caught inside the
    // I/O try and chained as cause, leaking SEKRET_KEY through util.inspect.
    // After the fix, the stringify step is outside the I/O try, cause is
    // undefined, and the property name is contained.

    let callCount = 0;
    const circRef: Record<string, unknown> = {};

    const checkpoint = {
      queryId: "q-serialize-fail",
      toJSON(): unknown {
        callCount++;
        if (callCount === 1) {
          // First call (from canonicalJsonHash): return a safe serializable value.
          return { queryId: "q-serialize-fail-safe" };
        }
        // Second call (from JSON.stringify on the envelope): return a circular
        // structure. circRef[SEKRET_KEY] = circRef closes the cycle; JSON.stringify
        // will include SEKRET_KEY in its error message.
        circRef[SEKRET_KEY] = circRef;
        return circRef;
      },
    };

    // Use a permissive validator so the non-standard checkpoint shape passes.
    function isAny(v: unknown): v is Record<string, unknown> {
      return typeof v === "object" && v !== null;
    }

    const store = new M3LCheckpointStore<Record<string, unknown>>({
      paths: makePathsPort(dir),
      name: "run-serialize-fail",
      validate: isAny,
      missing: { kind: "error" },
    });

    let thrown: unknown;
    try {
      await store.write(checkpoint);
    } catch (error) {
      thrown = error;
    }

    // Must throw ERR_CHECKPOINT_IO from the serialization arm, not a raw Error.
    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");

    // cause MUST be undefined — chaining the stringify error would expose the
    // property name through util.inspect(cause.message).
    expect((thrown as M3LCheckpointError).cause).toBeUndefined();

    const err = thrown as M3LCheckpointError;

    // The planted property name must appear in none of the public error fields.
    expect(err.message).not.toContain(SEKRET_KEY);
    expect(JSON.stringify(err.context ?? {})).not.toContain(SEKRET_KEY);
    if (err.stack !== undefined) {
      expect(err.stack).not.toContain(SEKRET_KEY);
    }
    // util.inspect with getters:true reveals any getter that embeds the key.
    const inspected = inspect(err, {
      depth: 10,
      showHidden: true,
      getters: true,
    });
    expect(inspected).not.toContain(SEKRET_KEY);
  });

  test("rename-failure arm still chains the errno cause — the no-cause rule applies only to the serialization arm, not to OS I/O failures", async () => {
    // Confirms the fix did not accidentally suppress the cause in the I/O arm
    // too. An OS errno (EPERM from a failed rename) is safe to chain because
    // it carries no caller-supplied content; chaining it provides actionable
    // diagnostics.
    const store = new M3LCheckpointStore<TestCheckpoint>({
      paths: makePathsPort(dir),
      name: "run-rename-cause",
      validate: isTestCheckpoint,
      missing: { kind: "error" },
    });

    await store.write({ queryId: "original" });

    const renameFailure = Object.assign(
      new Error("EPERM: operation not permitted"),
      { code: "EPERM" },
    );
    vi.spyOn(fsp, "rename").mockRejectedValueOnce(renameFailure);

    let thrown: unknown;
    try {
      await store.write({ queryId: "should-not-land" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCheckpointError);
    expect((thrown as M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
    // The I/O arm DOES chain the errno cause — the distinction from the
    // serialization arm (cause === undefined) is the point.
    expect((thrown as M3LCheckpointError).cause).toBe(renameFailure);
  });
});
