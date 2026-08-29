/**
 * Integration tests for `src/sessions/artifacts.ts` — the session artifact
 * store (m3l-console-server X6 workbench-sessions module, slice 3,
 * ADR-0068/ADR-0069).
 *
 * These are the cases that need a REAL filesystem or a real OS process,
 * which is exactly why they live in the integration pass and not the unit
 * pass (see `vitest.integration.config.ts`): whether the OS actually honors
 * a requested permission mode, a genuine `EEXIST` collision between two real
 * writes, a real symlink or FIFO planted at rest, and digest verification
 * against bytes an external process actually tampered with are none of them
 * observable through a mock — the unit suite
 * (`tests/sessions-artifacts.test.ts`) proves `artifacts.ts` REQUESTS the
 * right syscalls with the right arguments and branches correctly on every
 * mocked outcome; this file proves the OS actually does what those mocks
 * assumed.
 *
 * Bare `node:fs/promises` named-function imports, never a `fs.`/`fsp.`
 * member-expression call — see `eslint.config.js`'s `no-restricted-syntax`
 * block and `tests/integration/store.integration.test.ts`'s own header for
 * the rationale.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { M3LConsoleError } from "../../src/errors/console-error.js";
import type { M3LConsoleSessionsConfig } from "../../src/config/sessions.js";
import { createSessionArtifactStore } from "../../src/sessions/artifacts.js";
import type { M3LSessionArtifactRef } from "../../src/sessions/artifacts.js";

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
// Every FIFO writer child spawned by a test in this file is tracked here and
// force-killed in afterEach. The original version of these tests spawned a
// detached, unref'd writer and relied on it exiting on its own once the FIFO
// closed — but a writer blocked on a FIFO's open() (no reader ever connects,
// or the reader never reads to EOF) stays blocked indefinitely, so unref()
// alone does not guarantee cleanup: the child can outlive both the test and
// the afterEach `rm` of `dir` below, leaking a process and (briefly) a
// dangling FIFO path. Tracking the handle and calling kill() explicitly
// closes that gap (PR #740 review, Must-fix finding).
let spawnedChildren: ChildProcess[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "m3l-console-artifacts-"));
  spawnedChildren = [];
});

afterEach(async () => {
  for (const child of spawnedChildren) {
    if (!child.killed) {
      child.kill();
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe("put — writes a real file under <root>/<sessionId>/<stepId>.json and returns a matching file ref", () => {
  test("the on-disk content and its independently recomputed digest match the returned ref", async () => {
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

  test.skipIf(process.platform === "win32")(
    "creates the session directory 0700 and the artifact file 0600 — proving the OS honors the requested modes",
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

describe("put — exclusive-create duplicate write, against a real second write attempt", () => {
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

describe("put + readArtifact — the file branch round-trips a Date-valued field identically to the inline branch (control)", () => {
  test("a Date-valued field round-trips to its JSON (ISO string) form, needing a real write+read to exercise the file path end to end", async () => {
    const isoWhen = "2024-01-01T00:00:00.000Z";
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

describe("readArtifact — digest mismatch on a real tampered file", () => {
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

describe("readArtifact — size bound against a real oversized on-disk file (unbounded-read finding)", () => {
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

describe("readArtifact — digest verified before content is trusted/parsed, and never leaked into the thrown message (real files)", () => {
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

describe("readArtifact — validates ref.path itself against a real out-of-root file, independent of decodeArtifactRef", () => {
  test("throws ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT for a hand-constructed ref whose path traverses outside the store root, and never reads the real sentinel file placed there", async () => {
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
      // opening it — hanging the suite), a shell child does the blocking
      // `> fifo` open on its own thread/process. Tracked in
      // `spawnedChildren` and force-killed in `afterEach` — if the fixed
      // implementation never opens the FIFO (or the writer's blocking
      // open() never completes for any other reason), this child would
      // otherwise linger blocked in the background indefinitely.
      const writer = spawn("sh", ["-c", `cat > ${fifoPath}`], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      spawnedChildren.push(writer);
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
