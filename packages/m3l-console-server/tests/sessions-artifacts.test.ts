/**
 * Unit tests for src/sessions/artifacts.ts — the session artifact store —
 * and src/sessions/artifact-codec.ts — its wire codec, extracted from
 * artifacts.ts in a later, purely behavior-preserving slice
 * (m3l-console-server X6 workbench-sessions module, slice 3, ADR-0068/
 * ADR-0069).
 *
 * `M3LSessionArtifactStore.put` decides, purely from the JSON-serialized
 * byte size of the payload, whether to persist it inline (no I/O at all) or
 * to a real file under a per-store root directory — enforcing an
 * artifact-level cap and a caller-supplied running session-total cap.
 * `readArtifact` is the inverse, verifying a file-backed artifact's SHA-256
 * digest on every read.
 *
 * This file lives in the UNIT project (`vitest.config.ts`) — no real
 * filesystem access. `node:fs/promises`'s `mkdir`, `open`, and `writeFile`
 * are mocked via `vi.mock`, and `open`'s resolved `FileHandle` is a fake
 * object whose `stat`/`readFile`/`close` methods are individually
 * controllable `vi.fn()`s. This drives every one of `artifacts.ts`'s own
 * branches (success, `EEXIST`, a non-regular-file `stat`, a size mismatch,
 * a digest mismatch, `ELOOP`, an `ENOENT` (X8 slice 5b-ii's
 * `ERR_CONSOLE_SESSION_ARTIFACT_GONE` branch), a generic fs error, a
 * post-open failure, a failing `close()`) without ever touching a real
 * path, which is what recovers this module's unit-tier coverage per
 * `vitest.config.ts`'s `perFile` gate.
 *
 * Real-filesystem cases (permission bits actually honored by the OS, a
 * genuine `EEXIST` collision, a real symlink/FIFO at rest, digest
 * verification against externally-tampered bytes, and the file-backed
 * Date round-trip) live in
 * `tests/integration/sessions-artifacts.integration.test.ts` instead —
 * see that file's header for the split rationale (this file previously
 * shelled out to `mkfifo` and spawned real child processes, which does not
 * belong in the unit tier: `docs/logs/` PR #740 review).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import type * as FsPromises from "node:fs/promises";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return {
    ...actual,
    mkdir: vi.fn(),
    open: vi.fn(),
    writeFile: vi.fn(),
  };
});

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  mkdir,
  open,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleSessionsConfig } from "../src/config/sessions.js";
import { httpStatusForCode, isFaultError } from "../src/http/envelope.js";
import { createSessionArtifactStore } from "../src/sessions/artifacts.js";
import {
  decodeArtifactRef,
  encodeArtifactRef,
} from "../src/sessions/artifact-codec.js";
import type { M3LSessionArtifactRef } from "../src/sessions/artifact-codec.js";

/** A small, deterministic cap fixture — chosen so every threshold is easy to straddle in a single-digit/triple-digit byte payload. */
const CONFIG: M3LConsoleSessionsConfig = {
  artifactInlineMaxBytes: 50,
  artifactMaxBytes: 200,
  sessionTotalMaxBytes: 1000,
  openSessionsMax: 10,
};

const ROOT = "/fake/artifacts-root";

const EXPECTED_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/**
 * Builds a JSON string payload (a plain string value) whose
 * `JSON.stringify` output is exactly `bytes` bytes long — every character
 * used is ASCII, so `Buffer.byteLength` and `.length` agree.
 */
function jsonSizedPayload(bytes: number): string {
  if (bytes < 2) throw new Error("jsonSizedPayload requires bytes >= 2");
  return "x".repeat(bytes - 2);
}

/** Captures whatever `run` throws or rejects with, as a single `unknown` value. */
async function captureFailure(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A fake `FileHandle` whose `stat`/`readFile`/`close` are independently controllable `vi.fn()`s. */
interface FakeFileHandle {
  readonly stat: ReturnType<typeof vi.fn>;
  readonly readFile: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function createFakeHandle(): FakeFileHandle {
  return {
    stat: vi.fn(),
    readFile: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.mocked(mkdir).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(writeFile).mockReset();
});

afterEach(() => {
  vi.mocked(mkdir).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(writeFile).mockReset();
});

describe("M3LSessionArtifactRef — discriminated union shape", () => {
  test("has exactly the inline and file variants the contract declares", () => {
    expectTypeOf<M3LSessionArtifactRef>().toMatchTypeOf<
      | { kind: "inline"; value: unknown }
      | { kind: "file"; path: string; sizeBytes: number; digest: string }
    >();
  });
});

describe("createSessionArtifactStore — the factory itself does no I/O", () => {
  test("performs no mkdir/open/writeFile merely by being called", () => {
    createSessionArtifactStore({ root: ROOT, config: CONFIG });

    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("put — inline branch (payload size <= artifactInlineMaxBytes)", () => {
  test("returns an inline ref carrying the payload, with no filesystem I/O at all", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(30);

    const ref = await store.put("session-1", "step-1", payload, 0);

    expect(ref).toEqual({ kind: "inline", value: payload });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  test("accepts the exact boundary of artifactInlineMaxBytes as inline", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(CONFIG.artifactInlineMaxBytes);

    const ref = await store.put("session-1", "step-1", payload, 0);

    expect(ref).toEqual({ kind: "inline", value: payload });
  });
});

describe("put — file branch (artifactInlineMaxBytes < payload size <= artifactMaxBytes)", () => {
  test("mkdir(sessionDir, 0700) then writeFile(absolutePath, json, wx/0600), returning a matching file ref", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(100);

    const ref = await store.put("session-2", "step-1", payload, 0);

    expect(ref.kind).toBe("file");
    if (ref.kind !== "file") throw new Error("expected a file ref");
    expect(ref.sizeBytes).toBe(100);
    expect(ref.path).toBe(join("session-2", "step-1.json"));
    expect(ref.digest).toMatch(/^[0-9a-f]{64}$/);

    expect(mkdir).toHaveBeenCalledWith(join(ROOT, "session-2"), {
      recursive: true,
      mode: 0o700,
    });
    expect(writeFile).toHaveBeenCalledWith(
      join(ROOT, "session-2", "step-1.json"),
      JSON.stringify(payload),
      { flag: "wx", mode: 0o600 },
    );
  });

  test("accepts the exact boundary of artifactMaxBytes as file-backed, not rejected", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(CONFIG.artifactMaxBytes);

    const ref = await store.put("session-boundary", "step-1", payload, 0);

    expect(ref.kind).toBe("file");
    if (ref.kind === "file") {
      expect(ref.sizeBytes).toBe(CONFIG.artifactMaxBytes);
    }
  });
});

describe("put — writeArtifactFile failures wrap under one catch as ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT", () => {
  test("a mkdir rejection is wrapped, chaining the original cause", async () => {
    const mkdirFailure = new Error("boom-mkdir");
    vi.mocked(mkdir).mockRejectedValue(mkdirFailure);
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(100);

    const thrown = await captureFailure(() =>
      store.put("session-e1", "step-1", payload, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBe(mkdirFailure);
    expect(writeFile).not.toHaveBeenCalled();
  });

  test("an EEXIST from writeFile (exclusive-create collision) is wrapped as CORRUPT, not silently overwritten", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    const eexist = Object.assign(new Error("file already exists"), {
      code: "EEXIST",
    });
    vi.mocked(writeFile).mockRejectedValue(eexist);
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(100);

    const thrown = await captureFailure(() =>
      store.put("session-e2", "step-1", payload, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBe(eexist);
  });

  test("a generic writeFile failure is wrapped the same way as EEXIST", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    const genericFailure = new Error("disk full");
    vi.mocked(writeFile).mockRejectedValue(genericFailure);
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(100);

    const thrown = await captureFailure(() =>
      store.put("session-e3", "step-1", payload, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe("put — per-artifact cap exceeded (checked before any filesystem call)", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE and never calls mkdir/writeFile", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(CONFIG.artifactMaxBytes + 1);

    const thrown = await captureFailure(() =>
      store.put("session-3", "step-1", payload, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
    );
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("put — session-total cap exceeded (distinct from the per-artifact cap)", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE when currentSessionTotalBytes + sizeBytes exceeds sessionTotalMaxBytes, even though sizeBytes alone is within artifactMaxBytes", async () => {
    // Both arms reachable: sizeBytes=100 is comfortably <= artifactMaxBytes
    // (200) on its own, so ONLY the running-total comparison against
    // sessionTotalMaxBytes can reject this call — discriminating this check
    // from the standalone per-artifact cap above.
    const config: M3LConsoleSessionsConfig = {
      ...CONFIG,
      sessionTotalMaxBytes: 150,
    };
    const store = createSessionArtifactStore({ root: ROOT, config });
    const payload = jsonSizedPayload(100);

    const thrown = await captureFailure(() =>
      store.put("session-4", "step-1", payload, 100),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  test("does not reject when currentSessionTotalBytes + sizeBytes lands exactly at sessionTotalMaxBytes", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const config: M3LConsoleSessionsConfig = {
      ...CONFIG,
      sessionTotalMaxBytes: 200,
    };
    const store = createSessionArtifactStore({ root: ROOT, config });
    const payload = jsonSizedPayload(100);

    const ref = await store.put("session-5", "step-1", payload, 100);

    expect(ref.kind).toBe("file");
  });
});

describe("put — an unparseable (not JSON-serializable) payload", () => {
  test("rejects with ERR_CONSOLE_BAD_REQUEST from toParametersJson, never the size-cap codes, before any filesystem call", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });

    const thrown = await captureFailure(() =>
      store.put("session-6", "step-1", { onFinish: () => undefined }, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("put — path-traversal rejection on sessionId/stepId", () => {
  test.each<[string, string, string]>([
    ["sessionId traversal", "../../etc", "step-1"],
    ["sessionId with a slash", "a/b", "step-1"],
    ["stepId traversal", "session-8", "../../etc"],
    ["stepId with a slash", "session-8", "a/b"],
  ])(
    "rejects %s with ERR_CONSOLE_BAD_REQUEST, before any filesystem write",
    async (_label, sessionId, stepId) => {
      const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
      // File-range payload — the rejection must fire before ever reaching the
      // write step, not merely because this payload happened to be inline.
      const payload = jsonSizedPayload(100);

      const thrown = await captureFailure(() =>
        store.put(sessionId, stepId, payload, 0),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    },
  );

  test("accepts a safe charset id (letters, digits, underscore, hyphen) and proceeds normally", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(10);

    const ref = await store.put("session_9-ok", "step-1_ok", payload, 0);

    expect(ref).toEqual({ kind: "inline", value: payload });
  });
});

describe("put — sessionId/stepId length bound", () => {
  // The fix is expected to enforce an explicit ceiling of 128 characters on
  // both sessionId and stepId — generous for any real caller, but small
  // enough to reject before ever reaching the filesystem (avoiding a
  // platform-specific ENAMETOOLONG once the id is used as a directory/file
  // name component). 5000 chars still matches SAFE_ID_PATTERN's charset, so
  // only a length check (not the existing charset check) can catch it.
  test.each<[string, string, string]>([
    ["an over-length sessionId", "a".repeat(5000), "step-1"],
    ["an over-length stepId", "session-13", "a".repeat(5000)],
  ])(
    "rejects %s (> 128 chars) with ERR_CONSOLE_BAD_REQUEST, not a filesystem-layer failure",
    async (_label, sessionId, stepId) => {
      const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
      // File-range payload — the rejection must fire before ever reaching the
      // write step, not merely because this payload happened to be inline.
      const payload = jsonSizedPayload(100);

      const thrown = await captureFailure(() =>
        store.put(sessionId, stepId, payload, 0),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    },
  );
});

describe("put — currentSessionTotalBytes validation", () => {
  test.each<[string, number]>([
    ["NaN", Number.NaN],
    ["a negative value", -1],
  ])(
    "rejects currentSessionTotalBytes of %s with ERR_CONSOLE_BAD_REQUEST",
    async (_label, currentSessionTotalBytes) => {
      const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
      const payload = jsonSizedPayload(30);

      const thrown = await captureFailure(() =>
        store.put("session-14", "step-1", payload, currentSessionTotalBytes),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    },
  );

  test("still accepts a valid non-negative integer currentSessionTotalBytes (existing legitimate usage)", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(30);

    const ref = await store.put("session-15", "step-1", payload, 0);

    expect(ref).toEqual({ kind: "inline", value: payload });
  });
});

describe("put + readArtifact — inline branch round-trip is representationally consistent", () => {
  test("a Date-valued field round-trips to its JSON (ISO string) form on the inline branch, not a live Date instance", async () => {
    const isoWhen = "2024-01-01T00:00:00.000Z";
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = { when: new Date(isoWhen) };
    // Sanity: this payload's JSON form is small enough to land inline.
    expect(
      Buffer.byteLength(JSON.stringify(payload), "utf8"),
    ).toBeLessThanOrEqual(CONFIG.artifactInlineMaxBytes);

    const ref = await store.put("session-16", "step-1", payload, 0);
    expect(ref.kind).toBe("inline");

    const result = await store.readArtifact(ref);

    // Post-JSON-round-trip form: a plain ISO string, matching what the file
    // branch already produces via JSON.parse — never a live Date instance.
    expect(result).toEqual({ when: isoWhen });
  });
});

describe("readArtifact — inline", () => {
  test("returns the inline value directly, with no filesystem I/O", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const payload = jsonSizedPayload(30);
    const ref = await store.put("session-10", "step-1", payload, 0);

    const result = await store.readArtifact(ref);

    expect(result).toBe(payload);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("readArtifact — ref.path shape rejection (pre-flight, before any filesystem access)", () => {
  test.each<[string, string]>([
    ["a parent-directory traversal", "../outside-secret.json"],
    ["an absolute path", "/etc/passwd"],
    ["a single segment (missing the sessionId/ prefix)", "step-1.json"],
    ["an extra segment", "a/b/c.json"],
    ["a final segment not ending in .json", "session-1/step-1.txt"],
  ])(
    "rejects %s with ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT and never calls open()",
    async (_label, path) => {
      const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
      const ref: M3LSessionArtifactRef = {
        kind: "file",
        path,
        sizeBytes: 10,
        digest: "a".repeat(64),
      };

      const thrown = await captureFailure(() => store.readArtifact(ref));

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      );
      expect(open).not.toHaveBeenCalled();
    },
  );
});

describe("readArtifact — rejects ref.sizeBytes over caps.artifactMaxBytes, before any filesystem access", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE and never calls open(), even for an otherwise well-formed ref", async () => {
    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: CONFIG.artifactMaxBytes + 1,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
    );
    expect(open).not.toHaveBeenCalled();
  });
});

describe("readArtifact — file happy path (mocked open/stat/readFile/close)", () => {
  test("opens with O_RDONLY|O_NOFOLLOW|O_NONBLOCK, verifies size via the same descriptor, verifies digest, JSON.parses, and closes", async () => {
    const value = jsonSizedPayload(100);
    const json = JSON.stringify(value);
    const buffer = Buffer.from(json, "utf8");
    const digest = createHash("sha256").update(buffer).digest("hex");
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => true, size: buffer.length });
    handle.readFile.mockResolvedValue(buffer);
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: buffer.length,
      digest,
    };

    const result = await store.readArtifact(ref);

    expect(result).toBe(value);
    expect(open).toHaveBeenCalledWith(
      join(ROOT, "session-1", "step-1.json"),
      EXPECTED_OPEN_FLAGS,
    );
    expect(handle.stat).toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
  });
});

describe("readArtifact — a non-regular-file stat() result is rejected before any content is read", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT and never calls readFile() when stats.isFile() is false", async () => {
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => false, size: 100 });
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
    expect(handle.readFile).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
  });
});

describe("readArtifact — actual stats.size disagreeing with ref.sizeBytes is rejected before any content is read", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT and never calls readFile() on a size mismatch (the unbounded-read defense)", async () => {
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => true, size: 2_000_000 });
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
    expect(handle.readFile).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
  });
});

describe("readArtifact — digest mismatch is rejected before JSON.parse ever runs", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT with no cause and no content leak, even for otherwise-valid JSON content", async () => {
    const buffer = Buffer.from(JSON.stringify("this is not what it claims"));
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => true, size: buffer.length });
    handle.readFile.mockResolvedValue(buffer);
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: buffer.length,
      // Deliberately wrong: does not match the buffer's real SHA-256.
      digest: "0".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain("this is not what it claims");
  });
});

describe("readArtifact — a digest-verified but non-JSON file surfaces as CORRUPT, chaining the SyntaxError", () => {
  test("only once the digest matches does JSON.parse run; a parse failure at that point is safe to chain as cause", async () => {
    const buffer = Buffer.from("not json at all", "utf8");
    const digest = createHash("sha256").update(buffer).digest("hex");
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => true, size: buffer.length });
    handle.readFile.mockResolvedValue(buffer);
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: buffer.length,
      digest,
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });
});

describe("readArtifact — an open() failure surfaces as CORRUPT for every errno EXCEPT ENOENT, chaining the cause", () => {
  // THE MUTATION-KILL PIN for the whole X8 slice 5b-ii ENOENT branch: ELOOP
  // is exactly what O_NOFOLLOW is there to produce when a symlink has been
  // planted at the artifact's final path component. Widening the ENOENT
  // guard to accept any errno (or removing it) must NOT make this into
  // ERR_CONSOLE_SESSION_ARTIFACT_GONE — that would silently defeat the
  // O_NOFOLLOW security control.
  test("ELOOP (symlink at the final path component) still raises CORRUPT, and close() is never called since no handle was ever acquired", async () => {
    const eloop = Object.assign(new Error("too many symbolic links"), {
      code: "ELOOP",
    });
    vi.mocked(open).mockRejectedValue(eloop);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBe(eloop);
  });

  test("a generic open() failure (e.g. EACCES) is wrapped the same way as CORRUPT", async () => {
    const eacces = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    vi.mocked(open).mockRejectedValue(eacces);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBe(eacces);
  });
});

describe("readArtifact — an ENOENT opening a file-backed artifact's referenced path raises GONE, not CORRUPT (X8 slice 5b-ii)", () => {
  test("a file-backed ref whose file has been deleted (ENOENT) raises ERR_CONSOLE_SESSION_ARTIFACT_GONE, chaining the cause", async () => {
    const enoent = Object.assign(new Error("no such file or directory"), {
      code: "ENOENT",
    });
    vi.mocked(open).mockRejectedValue(enoent);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_GONE");
    expect(error.cause).toBe(enoent);
  });

  test("the envelope maps ERR_CONSOLE_SESSION_ARTIFACT_GONE to HTTP 410 with fault: false", () => {
    const error = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_GONE",
      "artifact file no longer exists",
    );

    expect(httpStatusForCode("ERR_CONSOLE_SESSION_ARTIFACT_GONE")).toBe(410);
    expect(isFaultError(error)).toBe(false);
  });
});

describe("readArtifact — a post-acquire failure (stat()/readFile() rejecting after a successful open()) still surfaces as CORRUPT, and close() still runs", () => {
  test("a stat() rejection after a successful open() is wrapped, and close() is still called in finally", async () => {
    const statFailure = new Error("stat exploded");
    const handle = createFakeHandle();
    handle.stat.mockRejectedValue(statFailure);
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBe(statFailure);
    expect(handle.close).toHaveBeenCalled();
  });

  test("a readFile() rejection after a successful open()+stat() is wrapped, and close() is still called in finally", async () => {
    const readFailure = new Error("readFile exploded");
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => true, size: 100 });
    handle.readFile.mockRejectedValue(readFailure);
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBe(readFailure);
    expect(handle.close).toHaveBeenCalled();
  });
});

describe("readArtifact — a failing close() never shadows the primary outcome (best-effort, ignored)", () => {
  test("a close() rejection does not mask a successful read", async () => {
    const value = jsonSizedPayload(30);
    const json = JSON.stringify(value);
    const buffer = Buffer.from(json, "utf8");
    const digest = createHash("sha256").update(buffer).digest("hex");
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => true, size: buffer.length });
    handle.readFile.mockResolvedValue(buffer);
    handle.close.mockRejectedValue(new Error("close exploded"));
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: buffer.length,
      digest,
    };

    const result = await store.readArtifact(ref);

    expect(result).toBe(value);
  });

  test("a close() rejection does not mask an earlier typed error (stat/size/digest failure)", async () => {
    const handle = createFakeHandle();
    handle.stat.mockResolvedValue({ isFile: () => false, size: 100 });
    handle.close.mockRejectedValue(new Error("close exploded"));
    vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);

    const store = createSessionArtifactStore({ root: ROOT, config: CONFIG });
    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 100,
      digest: "a".repeat(64),
    };

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe("encodeArtifactRef / decodeArtifactRef — round trip", () => {
  test.each<[string, M3LSessionArtifactRef]>([
    ["an inline ref carrying a string", { kind: "inline", value: "hello" }],
    [
      "an inline ref carrying an object",
      { kind: "inline", value: { a: 1, b: [1, 2, 3] } },
    ],
    ["an inline ref carrying null", { kind: "inline", value: null }],
    [
      "a file ref",
      {
        kind: "file",
        path: "session-1/step-1.json",
        sizeBytes: 123,
        digest: "a".repeat(64),
      },
    ],
  ])("round-trips %s through encode then decode", (_label, ref) => {
    const text = encodeArtifactRef(ref);
    const decoded = decodeArtifactRef(text);

    expect(decoded).toEqual(ref);
    // Fixed-point property: re-encoding the decoded value reproduces the
    // exact same text.
    expect(encodeArtifactRef(decoded)).toBe(text);
  });
});

describe("encodeArtifactRef — a non-JSON-serializable inline value throws ERR_CONSOLE_BAD_REQUEST via toParametersJson", () => {
  // toParametersJson (src/store/parameters-json.ts) has two distinct
  // internal failure branches: a raw TypeError that JSON.stringify itself
  // throws (a BigInt, or a cycle its own circularity detection catches) is
  // caught by the generic catch-all and chained as-is; a function/symbol/
  // undefined value is instead detected explicitly by the path-tracking
  // replacer and raised as its own UnserializableParameterValue before ever
  // reaching JSON.stringify's native detection (see the "put — an
  // unparseable ... payload" describe above for that second branch). Both
  // fixtures below exercise the FIRST branch — BigInt and a circular
  // reference are the two shapes JSON.stringify's native serializer itself
  // rejects, as opposed to the replacer-detected shapes.
  test("a BigInt value in the payload: JSON.stringify's own TypeError is chained as cause", () => {
    let thrown: unknown;
    try {
      encodeArtifactRef({ kind: "inline", value: { count: 10n } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  test("a circular-reference object value: JSON.stringify's own circularity detection TypeError is chained as cause", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    let thrown: unknown;
    try {
      encodeArtifactRef({ kind: "inline", value: cyclic });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});

describe("decodeArtifactRef — path must decompose into <sessionId>/<stepId>.json, both segments safe-id charset", () => {
  /** Builds a `"file"`-kind envelope JSON text with a given `path`, otherwise-valid `sizeBytes`/`digest`. */
  function fileEnvelope(path: string): string {
    return JSON.stringify({
      kind: "file",
      path,
      sizeBytes: 123,
      digest: "a".repeat(64),
    });
  }

  test.each<[string, string]>([
    ["a parent-directory traversal", "../outside-secret.json"],
    ["a deep parent-directory traversal", "../../../../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["a single segment (missing the sessionId/ prefix)", "step-1.json"],
    ["an extra segment", "a/b/c.json"],
    ["a final segment not ending in .json", "session-1/step-1.txt"],
  ])("rejects %s with ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT", (_label, path) => {
    let thrown: unknown;
    try {
      decodeArtifactRef(fileEnvelope(path));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });

  test("decodes successfully when path is exactly <safe sessionId>/<safe stepId>.json", () => {
    const decoded = decodeArtifactRef(fileEnvelope("session-1/step-1.json"));

    expect(decoded).toEqual({
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes: 123,
      digest: "a".repeat(64),
    });
  });
});

describe("decodeArtifactRef — sizeBytes and digest validation", () => {
  /** Builds a `"file"`-kind envelope JSON text with a given `sizeBytes`/`digest`, otherwise-valid `path`. */
  function fileEnvelope(sizeBytes: unknown, digest: unknown): string {
    return JSON.stringify({
      kind: "file",
      path: "session-1/step-1.json",
      sizeBytes,
      digest,
    });
  }

  test.each<[string, unknown, unknown]>([
    ["a negative sizeBytes", -1, "a".repeat(64)],
    ["a non-integer sizeBytes", 1.5, "a".repeat(64)],
    ["a digest that is too short", 123, "a".repeat(63)],
    ["a digest that is too long", 123, "a".repeat(65)],
    ["an uppercase-hex digest", 123, "A".repeat(64)],
    ["a non-hex-character digest", 123, "z".repeat(64)],
  ])(
    "rejects %s with ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    (_label, sizeBytes, digest) => {
      let thrown: unknown;
      try {
        decodeArtifactRef(fileEnvelope(sizeBytes, digest));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      );
    },
  );
});

describe("decodeArtifactRef — the parsed JSON value itself must be an object", () => {
  test.each<[string, string]>([
    ["a JSON array", JSON.stringify([1, 2, 3])],
    ["a JSON string primitive", JSON.stringify("just a string")],
    ["a JSON number primitive", JSON.stringify(42)],
    ["a JSON null", JSON.stringify(null)],
  ])("rejects %s with ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT", (_label, text) => {
    let thrown: unknown;
    try {
      decodeArtifactRef(text);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe('decodeArtifactRef — a "file"-kind envelope whose path field is not a string', () => {
  test("rejects with ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT before ever reaching assertSafeArtifactFilePath's shape check", () => {
    const text = JSON.stringify({
      kind: "file",
      path: 12345,
      sizeBytes: 123,
      digest: "a".repeat(64),
    });

    let thrown: unknown;
    try {
      decodeArtifactRef(text);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe("decodeArtifactRef — malformed input", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT on unparseable JSON text", () => {
    let thrown: unknown;
    try {
      decodeArtifactRef("not json{");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });

  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT on well-formed JSON that is not a valid envelope shape", () => {
    let thrown: unknown;
    try {
      decodeArtifactRef(JSON.stringify({ kind: "not-a-real-kind" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe("decodeArtifactRef — never lets a raw (non-M3LConsoleError) exception escape on a wrong-runtime-type kind field", () => {
  // NOTE ON THIS TEST'S CURRENT STATUS: verified directly against the source
  // (parseArtifactRefShape's final branch does `String(parsed["kind"])`,
  // which does not throw for a plain-JSON-parsed object or array — see
  // Array.prototype.toString / Object.prototype.toString, neither of which
  // throw) — the two fixtures below already pass against the CURRENT
  // implementation via that existing "unrecognized kind" fallback. Kept as a
  // regression lock for the documented guarantee (never a raw TypeError) even
  // though it does not currently discriminate a bug.
  test.each<[string, string]>([
    [
      "kind as a nested object",
      JSON.stringify({
        kind: { nested: "object" },
        path: "s/p.json",
        sizeBytes: 1,
        digest: "a".repeat(64),
      }),
    ],
    [
      "kind as an array",
      JSON.stringify({
        kind: ["array"],
        path: "s/p.json",
        sizeBytes: 1,
        digest: "a".repeat(64),
      }),
    ],
  ])(
    "rejects %s with ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT, not a raw TypeError or any other error type",
    (_label, text) => {
      let thrown: unknown;
      try {
        decodeArtifactRef(text);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      );
    },
  );
});
