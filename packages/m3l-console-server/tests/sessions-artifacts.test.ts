/**
 * Tests for src/sessions/artifacts.ts — the session artifact store
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
 * Every filesystem-touching test uses a real temp directory (bare
 * `node:fs/promises` named-function imports, never a `fs.`/`fsp.`
 * member-expression call — see `eslint.config.js`'s `no-restricted-syntax`
 * block and `tests/integration/store.integration.test.ts`'s own header for
 * the rationale), cleaned up in `afterEach`. Nothing here touches the real
 * repo `data/` directory.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleSessionsConfig } from "../src/config/sessions.js";
import {
  createSessionArtifactStore,
  decodeArtifactRef,
  encodeArtifactRef,
} from "../src/sessions/artifacts.js";
import type { M3LSessionArtifactRef } from "../src/sessions/artifacts.js";

/** A small, deterministic cap fixture — chosen so every threshold is easy to straddle in a single-digit/triple-digit byte payload. */
const CONFIG: M3LConsoleSessionsConfig = {
  artifactInlineMaxBytes: 50,
  artifactMaxBytes: 200,
  sessionTotalMaxBytes: 1000,
  openSessionsMax: 10,
};

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

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "m3l-console-artifacts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
  test("does not create the root directory merely by being called", async () => {
    const root = join(dir, "artifacts-root");

    createSessionArtifactStore({ root, config: CONFIG });

    const failure = await captureFailure(() => stat(root));
    expect(failure).toMatchObject({ code: "ENOENT" });
  });
});

describe("put — inline branch (payload size <= artifactInlineMaxBytes)", () => {
  test("returns an inline ref carrying the payload, with no filesystem I/O at all", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(30);

    const ref = await store.put("session-1", "step-1", payload, 0);

    expect(ref).toEqual({ kind: "inline", value: payload });
    // No I/O: not even the root directory should have been created.
    const failure = await captureFailure(() => stat(root));
    expect(failure).toMatchObject({ code: "ENOENT" });
  });

  test("accepts the exact boundary of artifactInlineMaxBytes as inline", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(CONFIG.artifactInlineMaxBytes);

    const ref = await store.put("session-1", "step-1", payload, 0);

    expect(ref).toEqual({ kind: "inline", value: payload });
  });
});

describe("put — file branch (artifactInlineMaxBytes < payload size <= artifactMaxBytes)", () => {
  test("writes a real file under <root>/<sessionId>/<stepId>.json and returns a matching file ref", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(100);

    const ref = await store.put("session-2", "step-1", payload, 0);

    expect(ref.kind).toBe("file");
    if (ref.kind !== "file") throw new Error("expected a file ref");
    expect(ref.sizeBytes).toBe(100);
    expect(ref.digest).toMatch(/^[0-9a-f]{64}$/);

    const resolvedPath = join(root, "session-2", "step-1.json");
    const written = await readFile(resolvedPath, "utf8");
    expect(written).toBe(JSON.stringify(payload));

    const independentDigest = createHash("sha256")
      .update(written, "utf8")
      .digest("hex");
    expect(ref.digest).toBe(independentDigest);
  });

  test("accepts the exact boundary of artifactMaxBytes as file-backed, not rejected", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(CONFIG.artifactMaxBytes);

    const ref = await store.put("session-boundary", "step-1", payload, 0);

    expect(ref.kind).toBe("file");
    if (ref.kind === "file") {
      expect(ref.sizeBytes).toBe(CONFIG.artifactMaxBytes);
    }
  });

  test.skipIf(process.platform === "win32")(
    "creates the session directory 0700 and the artifact file 0600",
    async () => {
      const originalUmask = process.umask(0o022);
      try {
        const root = join(dir, "artifacts-root");
        const store = createSessionArtifactStore({ root, config: CONFIG });
        const payload = jsonSizedPayload(100);

        await store.put("session-perm", "step-1", payload, 0);

        const sessionDirMode =
          (await stat(join(root, "session-perm"))).mode & 0o777;
        const fileMode =
          (await stat(join(root, "session-perm", "step-1.json"))).mode & 0o777;

        expect(sessionDirMode).toBe(0o700);
        expect(fileMode).toBe(0o600);
      } finally {
        process.umask(originalUmask);
      }
    },
  );
});

describe("put — per-artifact cap exceeded", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE and writes no partial file", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(CONFIG.artifactMaxBytes + 1);

    const thrown = await captureFailure(() =>
      store.put("session-3", "step-1", payload, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
    );
    const failure = await captureFailure(() =>
      stat(join(root, "session-3", "step-1.json")),
    );
    expect(failure).toMatchObject({ code: "ENOENT" });
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
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config });
    const payload = jsonSizedPayload(100);

    const thrown = await captureFailure(() =>
      store.put("session-4", "step-1", payload, 100),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
    );
    const failure = await captureFailure(() =>
      stat(join(root, "session-4", "step-1.json")),
    );
    expect(failure).toMatchObject({ code: "ENOENT" });
  });

  test("does not reject when currentSessionTotalBytes + sizeBytes lands exactly at sessionTotalMaxBytes", async () => {
    const config: M3LConsoleSessionsConfig = {
      ...CONFIG,
      sessionTotalMaxBytes: 200,
    };
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config });
    const payload = jsonSizedPayload(100);

    const ref = await store.put("session-5", "step-1", payload, 100);

    expect(ref.kind).toBe("file");
  });
});

describe("put — an unparseable (not JSON-serializable) payload", () => {
  test("rejects with ERR_CONSOLE_BAD_REQUEST from toParametersJson, never the size-cap codes", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });

    const thrown = await captureFailure(() =>
      store.put("session-6", "step-1", { onFinish: () => undefined }, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });
});

describe("put — exclusive-create duplicate write", () => {
  test("a second put for the same (sessionId, stepId) pair throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT (EEXIST), never silently overwriting", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const firstPayload = jsonSizedPayload(100);
    const secondPayload = jsonSizedPayload(120);

    const firstRef = await store.put("session-7", "step-1", firstPayload, 0);
    const thrown = await captureFailure(() =>
      store.put("session-7", "step-1", secondPayload, 0),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );

    // The original content survives the failed second attempt untouched.
    const resolvedPath = join(root, "session-7", "step-1.json");
    const onDisk = await readFile(resolvedPath, "utf8");
    expect(onDisk).toBe(JSON.stringify(firstPayload));
    if (firstRef.kind === "file") {
      expect(firstRef.sizeBytes).toBe(100);
    }
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
      const root = join(dir, "artifacts-root");
      const store = createSessionArtifactStore({ root, config: CONFIG });
      // File-range payload — the rejection must fire before ever reaching the
      // write step, not merely because this payload happened to be inline.
      const payload = jsonSizedPayload(100);

      const thrown = await captureFailure(() =>
        store.put(sessionId, stepId, payload, 0),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
      const failure = await captureFailure(() => stat(root));
      expect(failure).toMatchObject({ code: "ENOENT" });
    },
  );

  test("accepts a safe charset id (letters, digits, underscore, hyphen) and proceeds normally", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
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
      const root = join(dir, "artifacts-root");
      const store = createSessionArtifactStore({ root, config: CONFIG });
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
      const root = join(dir, "artifacts-root");
      const store = createSessionArtifactStore({ root, config: CONFIG });
      const payload = jsonSizedPayload(30);

      const thrown = await captureFailure(() =>
        store.put("session-14", "step-1", payload, currentSessionTotalBytes),
      );

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    },
  );

  test("still accepts a valid non-negative integer currentSessionTotalBytes (existing legitimate usage)", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(30);

    const ref = await store.put("session-15", "step-1", payload, 0);

    expect(ref).toEqual({ kind: "inline", value: payload });
  });
});

describe("put + readArtifact — inline and file branches return representationally consistent values", () => {
  const isoWhen = "2024-01-01T00:00:00.000Z";

  test("a Date-valued field round-trips to its JSON (ISO string) form on the inline branch, not a live Date instance", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
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

  test("the same Date-valued field round-trips identically on the file branch (control)", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = { when: new Date(isoWhen), padding: "x".repeat(100) };
    const sizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    // Sanity: this payload's JSON form is large enough to force file storage
    // but still within the per-artifact cap.
    expect(sizeBytes).toBeGreaterThan(CONFIG.artifactInlineMaxBytes);
    expect(sizeBytes).toBeLessThanOrEqual(CONFIG.artifactMaxBytes);

    const ref = await store.put("session-17", "step-1", payload, 0);
    expect(ref.kind).toBe("file");

    const result = await store.readArtifact(ref);

    expect(result).toMatchObject({ when: isoWhen });
  });
});

describe("readArtifact — inline", () => {
  test("returns the inline value directly", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(30);
    const ref = await store.put("session-10", "step-1", payload, 0);

    const result = await store.readArtifact(ref);

    expect(result).toBe(payload);
  });
});

describe("readArtifact — file happy path", () => {
  test("reads the file, verifies the digest, and returns the parsed JSON value", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(100);
    const ref = await store.put("session-11", "step-1", payload, 0);

    const result = await store.readArtifact(ref);

    expect(result).toBe(payload);
  });
});

describe("readArtifact — digest mismatch on a tampered file", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT when the on-disk bytes no longer match the recorded digest", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(100);
    const ref = await store.put("session-12", "step-1", payload, 0);
    if (ref.kind !== "file") throw new Error("expected a file ref");

    // Mutate the on-disk bytes directly — simulates external tampering or
    // silent corruption, independent of this module's own write path.
    const resolvedPath = join(root, "session-12", "step-1.json");
    await writeFile(
      resolvedPath,
      JSON.stringify(jsonSizedPayload(100)).replace("x", "y"),
    );

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe("readArtifact — size bound (unbounded-read finding)", () => {
  test("[regression lock] rejects when the on-disk file has been replaced with content far larger than the recorded sizeBytes, using the original ref", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(100);
    const ref = await store.put("session-18", "step-1", payload, 0);
    if (ref.kind !== "file") throw new Error("expected a file ref");

    // Externally overwrite the artifact file with content far larger than
    // the recorded sizeBytes (100) — big enough to prove a bound is real,
    // small enough to keep the test fast.
    const resolvedPath = join(root, "session-18", "step-1.json");
    const oversizedContent = JSON.stringify("x".repeat(2_000_000));
    await writeFile(resolvedPath, oversizedContent, "utf8");

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });

  test("[KNOWN BUG discriminator] rejects a file whose actual size disagrees with ref.sizeBytes even when its digest matches the actual (oversized) bytes exactly", async () => {
    // The digest-mismatch check alone cannot catch this: here the crafted
    // ref's digest is computed from the ACTUAL (oversized) on-disk bytes, so
    // it matches. Only an explicit size check — actual file size vs.
    // ref.sizeBytes, verified via stat before/without reading the full
    // content — can catch a ref whose recorded sizeBytes lies about the
    // real file size. This isolates the "unbounded read" finding from the
    // digest check that already exists, proving a dedicated size bound is
    // required (not just incidentally provided by the digest check).
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(100);
    const ref = await store.put("session-19", "step-1", payload, 0);
    if (ref.kind !== "file") throw new Error("expected a file ref");

    const resolvedPath = join(root, "session-19", "step-1.json");
    const oversizedContent = JSON.stringify("x".repeat(2_000_000));
    await writeFile(resolvedPath, oversizedContent, "utf8");
    const oversizedDigest = createHash("sha256")
      .update(oversizedContent, "utf8")
      .digest("hex");

    // sizeBytes intentionally still claims the ORIGINAL (small) recorded
    // size, while digest correctly matches the actual (oversized) bytes.
    const craftedRef: M3LSessionArtifactRef = {
      kind: "file",
      path: ref.path,
      sizeBytes: ref.sizeBytes,
      digest: oversizedDigest,
    };

    const thrown = await captureFailure(() => store.readArtifact(craftedRef));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe("readArtifact — digest verified before content is trusted/parsed, and never leaked into the thrown message", () => {
  test("invalid-JSON AND digest-mismatched content: rejects via the digest-mismatch path (no SyntaxError cause), proving digest verification runs before JSON.parse", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(100);
    const ref = await store.put("session-20", "step-1", payload, 0);
    if (ref.kind !== "file") throw new Error("expected a file ref");

    const resolvedPath = join(root, "session-20", "step-1.json");
    const replacementContent = "not json at all, and definitely wrong content";
    await writeFile(resolvedPath, replacementContent, "utf8");

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    // Digest-first ordering: the failure must be a digest mismatch, not a
    // wrapped JSON.parse SyntaxError — the digest-mismatch path never
    // attaches a `cause`, whereas a parse-failure path always would.
    expect(error.cause).toBeUndefined();
    // No file-content leak into the thrown error's own message.
    expect(error.message).not.toContain(replacementContent);
  });

  test("valid-JSON but digest-mismatched content: still rejects on the digest, not merely because parsing happened to fail", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });
    const payload = jsonSizedPayload(100);
    const ref = await store.put("session-21", "step-1", payload, 0);
    if (ref.kind !== "file") throw new Error("expected a file ref");

    const resolvedPath = join(root, "session-21", "step-1.json");
    const replacementValue = "not json at all, and definitely wrong content";
    const replacementContent = JSON.stringify(replacementValue);
    await writeFile(resolvedPath, replacementContent, "utf8");

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT");
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(replacementValue);
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

// ---------------------------------------------------------------------------
// X6 slice 3 — live re-verification pass (2026-08-29). Two prior
// exploit-demonstrated defects were fixed already; a second pass found the
// fix incomplete. The five describe blocks below each correspond to one
// re-verification finding.
// ---------------------------------------------------------------------------

describe("readArtifact — validates ref.path itself, independent of decodeArtifactRef", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT for a hand-constructed ref whose path traverses outside the store root, even though it was never passed through decodeArtifactRef", async () => {
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: CONFIG });

    // A real file outside the configured root, at the location the
    // traversal-reachable path resolves to (root/../outside-secret.json ==
    // dir/outside-secret.json).
    const sentinelPath = join(dir, "outside-secret.json");
    const sentinelContent = JSON.stringify("outside-secret-sentinel-value");
    await writeFile(sentinelPath, sentinelContent, "utf8");
    const sentinelDigest = createHash("sha256")
      .update(sentinelContent, "utf8")
      .digest("hex");

    // M3LSessionArtifactRef and readArtifact are both exported — a caller
    // constructing this object literal directly, skipping decodeArtifactRef
    // entirely, is a legitimate call shape, not a hypothetical.
    const handCraftedRef: M3LSessionArtifactRef = {
      kind: "file",
      path: "../outside-secret.json",
      sizeBytes: Buffer.byteLength(sentinelContent, "utf8"),
      digest: sentinelDigest,
    };

    const thrown = await captureFailure(() =>
      store.readArtifact(handCraftedRef),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

describe("readArtifact — rejects a non-regular file at the artifact's resolved location", () => {
  test.skipIf(process.platform === "win32")(
    "throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT for a real named pipe (FIFO) at the artifact's path, never trusting its streamed content as if it were a normal artifact file (closes the /dev/zero-style and same-machine-FIFO unbounded-read gap)",
    async () => {
      const root = join(dir, "artifacts-root");
      const store = createSessionArtifactStore({ root, config: CONFIG });
      const sessionDir = join(root, "session-fifo");
      await mkdir(sessionDir, { recursive: true });
      const fifoPath = join(sessionDir, "step-1.json");

      // Node has no built-in mkfifo; `mkfifo` is a standard coreutils binary
      // present on this repo's Linux dev/CI target.
      execFileSync("mkfifo", [fifoPath]);

      // The FIFO's reported stat().size (0 on Linux, independent of
      // whatever byte stream a writer later sends through it) is used
      // verbatim as ref.sizeBytes, so the EXISTING size check (actual size
      // vs. ref.sizeBytes) is made to pass by construction — isolating the
      // missing regular-file check from the already-fixed size check.
      const fifoStats = await stat(fifoPath);
      const pipeContent = JSON.stringify("fifo-leaked-content");
      const pipeDigest = createHash("sha256")
        .update(pipeContent, "utf8")
        .digest("hex");
      const ref: M3LSessionArtifactRef = {
        kind: "file",
        path: "session-fifo/step-1.json",
        sizeBytes: fifoStats.size,
        digest: pipeDigest,
      };

      // A writer connects out-of-process: opening a FIFO for read blocks
      // (no O_NONBLOCK) until a writer connects. Rather than opening the
      // writer end from THIS process (which would itself block on Node's
      // thread pool forever if the fix rejects the FIFO before ever
      // opening it — hanging the suite), a detached, unref'd shell child
      // does the blocking `> fifo` open on its own thread/process. If the
      // fixed implementation never opens the FIFO, this child simply
      // lingers blocked in the background — harmless, and it never keeps
      // the Node process or this test's promise alive.
      const writer = spawn("sh", ["-c", `cat > ${fifoPath}`], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      writer.unref();
      writer.stdin?.write(pipeContent);
      writer.stdin?.end();

      const thrown = await captureFailure(() => store.readArtifact(ref));

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      );
    },
    10000,
  );
});

describe("readArtifact — a FIFO with no writer must not block the fs thread pool forever (missing O_NONBLOCK denial-of-service)", () => {
  test.skipIf(process.platform === "win32")(
    "rejects promptly with ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT for a FIFO at the artifact's path with no writer ever connected, instead of blocking open() forever and starving every other fs operation in the process",
    async () => {
      const root = join(dir, "artifacts-root");
      const store = createSessionArtifactStore({ root, config: CONFIG });
      const sessionDir = join(root, "session-fifo-no-writer");
      await mkdir(sessionDir, { recursive: true });
      const fifoPath = join(sessionDir, "step-1.json");

      // Same mkfifo idiom as the "writer connects" FIFO test above — but
      // here, deliberately, no writer is ever spawned or connected. A
      // blocking O_RDONLY open() (no O_NONBLOCK) on a FIFO with zero
      // writers blocks INSIDE the kernel until a writer shows up, which
      // never happens here. That blocking call runs on one of Node's
      // libuv fs threadpool threads (4 by default) — a handful of such
      // refs starves every other filesystem operation in the process, a
      // real denial-of-service. The sizeBytes/digest values below never
      // matter: the fix must reject before ever reaching either
      // comparison.
      execFileSync("mkfifo", [fifoPath]);
      const fifoStats = await stat(fifoPath);
      const ref: M3LSessionArtifactRef = {
        kind: "file",
        path: "session-fifo-no-writer/step-1.json",
        sizeBytes: fifoStats.size,
        digest: "0".repeat(64),
      };

      // Bounded race, not an unbounded await: if the fix (O_NONBLOCK) is
      // present, readArtifact settles well within the deadline below. If
      // the underlying bug (a blocking open()) is still present, the
      // deadline branch wins the race instead — the test then FAILS FAST
      // on a clean assertion mismatch (the sentinel is not an
      // M3LConsoleError) rather than hanging past a vitest-level test
      // timeout, or hanging the whole suite.
      const DEADLINE_MS = 2000;
      const timeoutSentinel = Symbol("readArtifact-fifo-no-writer-timeout");
      const deadline = new Promise<typeof timeoutSentinel>((resolve) => {
        setTimeout(() => {
          resolve(timeoutSentinel);
        }, DEADLINE_MS);
      });

      const outcome = await Promise.race([
        captureFailure(() => store.readArtifact(ref)),
        deadline,
      ]);

      expect(outcome).not.toBe(timeoutSentinel);
      expect(outcome).toBeInstanceOf(M3LConsoleError);
      expect((outcome as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      );
    },
    5000,
  );
});

describe("readArtifact — the size check and the content read happen against the SAME resolved location, not two independently re-resolved path lookups (deterministic TOCTOU regression lock)", () => {
  test.skipIf(process.platform === "win32")(
    "throws rather than following a symlink planted at the artifact's expected file path, even when the symlink target's real size/digest match the ref exactly",
    async () => {
      const root = join(dir, "artifacts-root");
      const store = createSessionArtifactStore({ root, config: CONFIG });
      const sessionDir = join(root, "session-toctou");
      await mkdir(sessionDir, { recursive: true });
      const resolvedPath = join(sessionDir, "step-1.json");

      // Deterministic version of the TOCTOU finding: rather than racing a
      // live symlink swap between the stat() and readFile() calls (the
      // original exploit succeeded on the FIRST attempt, but a
      // race-dependent regression test would be flaky), this test plants
      // the symlink AT REST before readArtifact ever runs — a weaker
      // precondition than a live race (an attacker who can place a symlink
      // at the expected artifact path), but one the real fix must also
      // close. The real fix — opening the file once via a descriptor that
      // refuses to follow a symlink at the final path component, then
      // stat-ing and reading that SAME descriptor — closes both this
      // at-rest case and the live-race case the security review
      // demonstrated.
      const sentinelPath = join(dir, "toctou-out-of-root-sentinel.json");
      const sentinelContent = JSON.stringify("toctou-sentinel-value");
      await writeFile(sentinelPath, sentinelContent, "utf8");
      await symlink(sentinelPath, resolvedPath);

      const ref: M3LSessionArtifactRef = {
        kind: "file",
        path: "session-toctou/step-1.json",
        sizeBytes: Buffer.byteLength(sentinelContent, "utf8"),
        digest: createHash("sha256")
          .update(sentinelContent, "utf8")
          .digest("hex"),
      };

      const thrown = await captureFailure(() => store.readArtifact(ref));

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      );
    },
  );
});

describe("readArtifact — rejects a ref whose sizeBytes exceeds the store's configured artifactMaxBytes cap, before touching the filesystem", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE for an oversized-but-internally-consistent ref (claimed size matches the real on-disk size and digest), distinct from the already-enforced actual-size-mismatch check", async () => {
    const smallCapConfig: M3LConsoleSessionsConfig = {
      ...CONFIG,
      artifactMaxBytes: 150,
    };
    const root = join(dir, "artifacts-root");
    const store = createSessionArtifactStore({ root, config: smallCapConfig });
    const sessionDir = join(root, "session-cap");
    await mkdir(sessionDir, { recursive: true });
    const resolvedPath = join(sessionDir, "step-1.json");

    // Hand-write the file directly (bypassing store.put, which already
    // enforces this cap at write time) — simulating a ref that was
    // persisted under a formerly-larger cap, or any other route by which
    // an internally consistent but over-cap ref reaches readArtifact. Kept
    // small in absolute bytes (well under 1KB) so this test isolates the
    // missing cap check itself, not memory pressure.
    const payloadValue = jsonSizedPayload(
      smallCapConfig.artifactMaxBytes + 100,
    );
    const json = JSON.stringify(payloadValue);
    await writeFile(resolvedPath, json, "utf8");
    const digest = createHash("sha256").update(json, "utf8").digest("hex");
    const sizeBytes = Buffer.byteLength(json, "utf8");

    const ref: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-cap/step-1.json",
      sizeBytes,
      digest,
    };
    // Sanity: the ref IS internally consistent with the real file — this
    // isolates the missing cap check from the already-fixed actual-size-
    // mismatch check above.
    expect(sizeBytes).toBeGreaterThan(smallCapConfig.artifactMaxBytes);
    const actualFileStats = await stat(resolvedPath);
    expect(actualFileStats.size).toBe(sizeBytes);

    const thrown = await captureFailure(() => store.readArtifact(ref));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
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
  // though it does not currently discriminate a bug; see this suite's
  // handback report for the flagged discrepancy against the finding that
  // motivated it.
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
