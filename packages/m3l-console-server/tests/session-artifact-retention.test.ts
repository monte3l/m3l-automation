/**
 * Tests for src/session-artifact-retention.ts — `pruneSessionArtifacts`
 * (m3l-console-server X8 slice 5b-ii session-artifact retention sweep,
 * ADR-0070). Mirrors `tests/run-output-retention.test.ts`'s harness
 * technique, adapted for the two-level `<root>/<sessionId>/<stepId>.json`
 * layout and step-based (`endedAtMs`, not a terminal status) liveness.
 *
 * These run against a REAL temporary directory rather than a mocked
 * `node:fs` — this driver's whole job is filesystem effects (`readdir`,
 * `unlink`, symlink handling), and a mocked `fs` would only ever confirm
 * the mock's own beliefs about those. The step-record side is independent
 * of disk: a hand-written fake `M3LConsoleSessionsRepository` backed by a
 * `Map` supplies `getStep`; every other member throws, so an accidental
 * call surfaces immediately as a test failure.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  pruneSessionArtifacts,
  type M3LSessionArtifactPruneOutcome,
} from "../src/session-artifact-retention.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionStepRecord,
} from "../src/store/sessions-repository-types.js";

/** Root ignores permission bits entirely, so the chmod-based failure test cannot run as root. */
const skipAsRoot = process.getuid?.() === 0;

/** The one temporary artifact root each test gets its own copy of. */
let root: string;
/** Directories whose permissions a test narrowed; restored before `rm` in `afterEach`. */
let chmodTargets: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "m3l-session-artifact-retention-"));
  chmodTargets = [];
});

afterEach(async () => {
  // Restore write permission first — `rm(root, { recursive: true })` on a
  // tree containing a write-protected directory would itself fail.
  for (const dir of chmodTargets) {
    await chmod(dir, 0o700).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
});

/** Builds a complete, valid `M3LSessionStepRecord`, with `overrides` applied on top. */
function buildStepRecord(
  overrides: Partial<M3LSessionStepRecord> = {},
): M3LSessionStepRecord {
  return {
    id: "step-default",
    sessionId: "session-default",
    ordinal: 1,
    operation: "scripts/example",
    parameters: undefined,
    runId: undefined,
    status: "success",
    resultRef: undefined,
    queuedAtMs: 0,
    startedAtMs: undefined,
    endedAtMs: undefined,
    outcome: "success",
    failureMessage: undefined,
    ...overrides,
  };
}

/**
 * A hand-written fake `M3LConsoleSessionsRepository`: `getStep` reads from
 * `records` (a plain `Map`, independent of disk); every other member
 * throws, so a call `pruneSessionArtifacts` has no business making
 * surfaces immediately.
 */
function createFakeSessionsRepository(
  records: Map<string, M3LSessionStepRecord>,
): M3LConsoleSessionsRepository {
  const unexpected = (member: string) => (): never => {
    throw new Error(`pruneSessionArtifacts must not call repository.${member}`);
  };
  return {
    insertSession: unexpected("insertSession"),
    getSession: unexpected("getSession"),
    listSessions: unexpected("listSessions"),
    closeSession: unexpected("closeSession"),
    reopenSession: unexpected("reopenSession"),
    insertStep: unexpected("insertStep"),
    claimStepForStart: unexpected("claimStepForStart"),
    finishStep: unexpected("finishStep"),
    getStep: (id: string) => records.get(id),
    getStepByOrdinal: unexpected("getStepByOrdinal"),
    listStepsForSession: unexpected("listStepsForSession"),
    attachStepRun: unexpected("attachStepRun"),
    getStepByRunId: unexpected("getStepByRunId"),
    insertBinding: unexpected("insertBinding"),
    listBindingsForSession: unexpected("listBindingsForSession"),
    insertDecision: unexpected("insertDecision"),
    answerDecision: unexpected("answerDecision"),
    getDecision: unexpected("getDecision"),
    listDecisionsForSession: unexpected("listDecisionsForSession"),
    countOpenSessions: unexpected("countOpenSessions"),
  };
}

/** Creates a session directory at `root/sessionId`. */
async function makeSessionDir(sessionId: string): Promise<string> {
  const dir = join(root, sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Writes an artifact file at `root/sessionId/stepId.json`. */
async function makeArtifactFile(
  sessionId: string,
  stepId: string,
): Promise<string> {
  await makeSessionDir(sessionId);
  const filePath = join(root, sessionId, `${stepId}.json`);
  await writeFile(filePath, '{"ok":true}', "utf8");
  return filePath;
}

/** Asserts a path still exists (does not throw `ENOENT`). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("M3LSessionArtifactPruneOutcome", () => {
  test("has the exact four-bucket-plus-rootExisted shape the contract declares", () => {
    const outcome: M3LSessionArtifactPruneOutcome = {
      deleted: 0,
      retainedLive: 0,
      retainedYoung: 0,
      orphaned: 0,
      rootExisted: true,
    };
    expect(outcome).toEqual({
      deleted: 0,
      retainedLive: 0,
      retainedYoung: 0,
      orphaned: 0,
      rootExisted: true,
    });
  });
});

/**
 * Builds one step whose artifact file would be eligible for deletion under
 * any sane `retentionMs`/`nowMs` (it ended 1ms before `nowMs`), so a
 * rejected call that nonetheless deleted it would prove the input-validation
 * guard is not actually bounding the deletion.
 */
async function seedEligibleArtifact(): Promise<{
  filePath: string;
  records: Map<string, M3LSessionStepRecord>;
}> {
  const sessionId = "session-would-be-eligible";
  const stepId = "step-would-be-eligible";
  const nowMs = 100_000;
  const records = new Map<string, M3LSessionStepRecord>([
    [
      stepId,
      buildStepRecord({
        id: stepId,
        sessionId,
        endedAtMs: nowMs - 1,
      }),
    ],
  ]);
  const filePath = await makeArtifactFile(sessionId, stepId);
  return { filePath, records };
}

describe("pruneSessionArtifacts — retentionMs is validated before any filesystem access", () => {
  test.each<[string, number]>([
    ["NaN", Number.NaN],
    ["a negative value", -1_000_000],
    ["zero", 0],
    ["a non-integer", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "rejects retentionMs = %s with ERR_CONSOLE_CONFIG_INVALID and deletes nothing",
    async (_label, retentionMs) => {
      const { filePath, records } = await seedEligibleArtifact();

      let thrown: unknown;
      try {
        await pruneSessionArtifacts({
          artifactRoot: root,
          repository: createFakeSessionsRepository(records),
          retentionMs,
          nowMs: () => 100_000,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_CONFIG_INVALID",
      );
      // The important part: input validation runs before ANY unlink, so
      // the eligible file survives a rejected call.
      expect(await fileExists(filePath)).toBe(true);
    },
  );
});

describe("pruneSessionArtifacts — the resolved nowMs() is validated before any filesystem access", () => {
  test("rejects a nowMs() returning NaN with ERR_CONSOLE_CONFIG_INVALID and deletes nothing", async () => {
    const { filePath, records } = await seedEligibleArtifact();

    let thrown: unknown;
    try {
      await pruneSessionArtifacts({
        artifactRoot: root,
        repository: createFakeSessionsRepository(records),
        retentionMs: 1_000,
        nowMs: () => Number.NaN,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(await fileExists(filePath)).toBe(true);
  });
});

describe("pruneSessionArtifacts — classification is total", () => {
  test("seeds one file per bucket and asserts both the returned counts and which files still exist on disk", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;
    const sessionId = "session-a";

    const records = new Map<string, M3LSessionStepRecord>([
      [
        "step-deleted",
        buildStepRecord({
          id: "step-deleted",
          sessionId,
          endedAtMs: nowMs - retentionMs - 1,
        }),
      ],
      [
        "step-retained-live",
        buildStepRecord({
          id: "step-retained-live",
          sessionId,
          status: "running",
          outcome: undefined,
          endedAtMs: undefined,
        }),
      ],
      [
        "step-retained-young",
        buildStepRecord({
          id: "step-retained-young",
          sessionId,
          endedAtMs: nowMs - retentionMs + 1,
        }),
      ],
    ]);

    const deletedFile = await makeArtifactFile(sessionId, "step-deleted");
    const retainedLiveFile = await makeArtifactFile(
      sessionId,
      "step-retained-live",
    );
    const retainedYoungFile = await makeArtifactFile(
      sessionId,
      "step-retained-young",
    );
    const orphanedFile = await makeArtifactFile(
      sessionId,
      "step-orphaned-no-record",
    );

    const outcome = await pruneSessionArtifacts({
      artifactRoot: root,
      repository: createFakeSessionsRepository(records),
      retentionMs,
      nowMs: () => nowMs,
    });

    expect(outcome).toEqual({
      deleted: 1,
      retainedLive: 1,
      retainedYoung: 1,
      orphaned: 1,
      rootExisted: true,
    });

    expect(await fileExists(deletedFile)).toBe(false);
    expect(await fileExists(retainedLiveFile)).toBe(true);
    expect(await fileExists(retainedYoungFile)).toBe(true);
    expect(await fileExists(orphanedFile)).toBe(true);

    // The emptied session directory itself is left in place.
    expect(await fileExists(join(root, sessionId))).toBe(true);
  });
});

describe("pruneSessionArtifacts — boundary (strict `<`)", () => {
  test("a step whose endedAtMs equals nowMs - retentionMs exactly is retained, not deleted", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;
    const sessionId = "session-boundary";
    const stepId = "step-boundary";
    const records = new Map<string, M3LSessionStepRecord>([
      [
        stepId,
        buildStepRecord({
          id: stepId,
          sessionId,
          endedAtMs: nowMs - retentionMs,
        }),
      ],
    ]);
    const filePath = await makeArtifactFile(sessionId, stepId);

    const outcome = await pruneSessionArtifacts({
      artifactRoot: root,
      repository: createFakeSessionsRepository(records),
      retentionMs,
      nowMs: () => nowMs,
    });

    expect(outcome).toEqual({
      deleted: 0,
      retainedLive: 0,
      retainedYoung: 1,
      orphaned: 0,
      rootExisted: true,
    });
    expect(await fileExists(filePath)).toBe(true);
  });

  test("one millisecond older than the boundary is deleted", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;
    const sessionId = "session-just-old";
    const stepId = "step-just-old";
    const records = new Map<string, M3LSessionStepRecord>([
      [
        stepId,
        buildStepRecord({
          id: stepId,
          sessionId,
          endedAtMs: nowMs - retentionMs - 1,
        }),
      ],
    ]);
    const filePath = await makeArtifactFile(sessionId, stepId);

    const outcome = await pruneSessionArtifacts({
      artifactRoot: root,
      repository: createFakeSessionsRepository(records),
      retentionMs,
      nowMs: () => nowMs,
    });

    expect(outcome.deleted).toBe(1);
    expect(await fileExists(filePath)).toBe(false);
  });

  test("one millisecond younger than the boundary is retained", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;
    const sessionId = "session-just-young";
    const stepId = "step-just-young";
    const records = new Map<string, M3LSessionStepRecord>([
      [
        stepId,
        buildStepRecord({
          id: stepId,
          sessionId,
          endedAtMs: nowMs - retentionMs + 1,
        }),
      ],
    ]);
    const filePath = await makeArtifactFile(sessionId, stepId);

    const outcome = await pruneSessionArtifacts({
      artifactRoot: root,
      repository: createFakeSessionsRepository(records),
      retentionMs,
      nowMs: () => nowMs,
    });

    expect(outcome.retainedYoung).toBe(1);
    expect(await fileExists(filePath)).toBe(true);
  });
});

describe("pruneSessionArtifacts — a step with endedAtMs === undefined", () => {
  test("is retainedLive and survives regardless of how old the retention window is", async () => {
    const sessionId = "session-live";
    const stepId = "step-live";
    const records = new Map<string, M3LSessionStepRecord>([
      [
        stepId,
        buildStepRecord({
          id: stepId,
          sessionId,
          status: "running",
          outcome: undefined,
          endedAtMs: undefined,
        }),
      ],
    ]);
    const filePath = await makeArtifactFile(sessionId, stepId);

    const outcome = await pruneSessionArtifacts({
      artifactRoot: root,
      repository: createFakeSessionsRepository(records),
      retentionMs: 1,
      nowMs: () => 100_000_000,
    });

    expect(outcome).toEqual({
      deleted: 0,
      retainedLive: 1,
      retainedYoung: 0,
      orphaned: 0,
      rootExisted: true,
    });
    expect(await fileExists(filePath)).toBe(true);
  });
});

describe("pruneSessionArtifacts — a missing root", () => {
  test("returns a zero outcome with rootExisted: false and creates nothing on disk", async () => {
    const missingRoot = join(root, "does-not-exist");
    const records = new Map<string, M3LSessionStepRecord>();

    const outcome = await pruneSessionArtifacts({
      artifactRoot: missingRoot,
      repository: createFakeSessionsRepository(records),
      retentionMs: 1_000,
      nowMs: () => 100_000,
    });

    expect(outcome).toEqual({
      deleted: 0,
      retainedLive: 0,
      retainedYoung: 0,
      orphaned: 0,
      rootExisted: false,
    });
    expect(await fileExists(missingRoot)).toBe(false);
  });
});

describe("pruneSessionArtifacts — a present but empty root", () => {
  test("returns a zero outcome with rootExisted: true — distinguishing 'empty' from 'missing'", async () => {
    // `root` itself was created by `beforeEach` and has nothing swept into
    // it by this test, so it is present but empty.
    const records = new Map<string, M3LSessionStepRecord>();

    const outcome = await pruneSessionArtifacts({
      artifactRoot: root,
      repository: createFakeSessionsRepository(records),
      retentionMs: 1_000,
      nowMs: () => 100_000,
    });

    expect(outcome).toEqual({
      deleted: 0,
      retainedLive: 0,
      retainedYoung: 0,
      orphaned: 0,
      rootExisted: true,
    });
  });
});

describe("pruneSessionArtifacts — a non-ENOENT readdir failure on the root", () => {
  test("propagates instead of being swallowed into a zero outcome", async () => {
    // A regular file used as the "root" makes readdir fail with ENOTDIR —
    // deterministic and reversible without touching permission bits. Only
    // ENOENT is special-cased into a zero outcome; every other readdir
    // errno — ENOTDIR here — must propagate unchanged.
    const filePath = join(root, "not-a-directory");
    await writeFile(filePath, "content", "utf8");

    const records = new Map<string, M3LSessionStepRecord>();

    let thrown: unknown;
    try {
      await pruneSessionArtifacts({
        artifactRoot: filePath,
        repository: createFakeSessionsRepository(records),
        retentionMs: 1_000,
        nowMs: () => 100_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as NodeJS.ErrnoException).code).toBe("ENOTDIR");
  });
});

describe("pruneSessionArtifacts — a symlinked session directory is not followed", () => {
  test("a symlink pointing at a directory outside the root is skipped, and its target is untouched", async () => {
    const outsideDir = await mkdtemp(
      join(tmpdir(), "m3l-session-artifact-outside-"),
    );
    try {
      const markerFile = join(outsideDir, "marker.json");
      await writeFile(markerFile, "still here", "utf8");

      const symlinkPath = join(root, "session-symlinked");
      await symlink(outsideDir, symlinkPath, "dir");

      const records = new Map<string, M3LSessionStepRecord>();
      const outcome = await pruneSessionArtifacts({
        artifactRoot: root,
        repository: createFakeSessionsRepository(records),
        retentionMs: 1_000,
        nowMs: () => 100_000,
      });

      // Not classified into any bucket — the symlink is excluded before
      // it is ever walked into, so nothing here counts it.
      expect(outcome).toEqual({
        deleted: 0,
        retainedLive: 0,
        retainedYoung: 0,
        orphaned: 0,
        rootExisted: true,
      });
      expect(await fileExists(markerFile)).toBe(true);
      expect(await fileExists(outsideDir)).toBe(true);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("pruneSessionArtifacts — a non-.json file and a nested subdirectory are both ignored", () => {
  test("only .json files under a session directory are classified", async () => {
    const sessionId = "session-mixed";
    await makeSessionDir(sessionId);

    const notJsonFile = join(root, sessionId, "notes.txt");
    await writeFile(notJsonFile, "irrelevant", "utf8");

    const nestedDir = join(root, sessionId, "nested");
    await mkdir(nestedDir, { recursive: true });
    const nestedFile = join(nestedDir, "step-nested.json");
    await writeFile(nestedFile, '{"ok":true}', "utf8");

    const records = new Map<string, M3LSessionStepRecord>();
    const outcome = await pruneSessionArtifacts({
      artifactRoot: root,
      repository: createFakeSessionsRepository(records),
      retentionMs: 1_000,
      nowMs: () => 100_000,
    });

    expect(outcome).toEqual({
      deleted: 0,
      retainedLive: 0,
      retainedYoung: 0,
      orphaned: 0,
      rootExisted: true,
    });
    expect(await fileExists(notJsonFile)).toBe(true);
    expect(await fileExists(nestedFile)).toBe(true);
  });
});

describe("pruneSessionArtifacts — failure posture", () => {
  test.skipIf(skipAsRoot)(
    "a per-file unlink failure does not abort the walk, throws ERR_CONSOLE_INTERNAL with the original cause and the failing session/step id, and still deletes a later eligible file",
    async () => {
      const retentionMs = 1_000;
      const nowMs = 100_000;

      // Named so `session-a-fails` sorts strictly BEFORE `session-b-ok`:
      // `pruneSessionArtifacts` sorts session directories by name before
      // walking, so with this ordering a `break` inserted right after the
      // failure would leave the second session's file undeleted and the
      // "walk continued" assertion below would fail. Pin the assumption
      // literally so a future rename of either fixture can't silently make
      // this test vacuous again.
      const failingSessionId = "session-a-fails";
      const succeedsSessionId = "session-b-ok";
      expect(failingSessionId < succeedsSessionId).toBe(true);
      const failingStepId = "step-fails";
      const succeedsStepId = "step-ok";

      const records = new Map<string, M3LSessionStepRecord>([
        [
          failingStepId,
          buildStepRecord({
            id: failingStepId,
            sessionId: failingSessionId,
            endedAtMs: nowMs - retentionMs - 1,
          }),
        ],
        [
          succeedsStepId,
          buildStepRecord({
            id: succeedsStepId,
            sessionId: succeedsSessionId,
            endedAtMs: nowMs - retentionMs - 1,
          }),
        ],
      ]);

      const failingDir = await makeSessionDir(failingSessionId);
      const failingFile = await makeArtifactFile(
        failingSessionId,
        failingStepId,
      );
      const succeedsFile = await makeArtifactFile(
        succeedsSessionId,
        succeedsStepId,
      );

      // Narrowing the session directory's own write permission is what
      // makes exactly this one file's deletion fail: unlinking a file
      // requires write permission on its PARENT directory.
      await chmod(failingDir, 0o500);
      chmodTargets.push(failingDir);

      let thrown: unknown;
      try {
        await pruneSessionArtifacts({
          artifactRoot: root,
          repository: createFakeSessionsRepository(records),
          retentionMs,
          nowMs: () => nowMs,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      const consoleError = thrown as M3LConsoleError;
      expect(consoleError.code).toBe("ERR_CONSOLE_INTERNAL");

      // The original filesystem failure is chained, unmodified — never
      // re-normalised into a fresh Error with the same message, which
      // would defeat identity but pass a loose message-text comparison.
      expect(consoleError.cause).toBeInstanceOf(Error);
      expect((consoleError.cause as NodeJS.ErrnoException).code).toBe("EACCES");

      // The walk continued: the OTHER eligible file was still deleted
      // despite the failure on this one.
      expect(await fileExists(succeedsFile)).toBe(false);
      // The failing file's deletion never completed.
      expect(await fileExists(failingFile)).toBe(true);

      expect(Object.hasOwn(consoleError.context, "outcome")).toBe(true);
      expect(Object.hasOwn(consoleError.context, "failures")).toBe(true);

      // "the counts actually achieved" — the failed deletion must NOT be
      // counted as `deleted`; only the successful removal is.
      const outcome = consoleError.context[
        "outcome"
      ] as M3LSessionArtifactPruneOutcome;
      expect(outcome).toEqual({
        deleted: 1,
        retainedLive: 0,
        retainedYoung: 0,
        orphaned: 0,
        rootExisted: true,
      });

      const failures = consoleError.context["failures"] as ReadonlyArray<{
        sessionId: string;
        stepId: string;
        code: string | undefined;
      }>;
      expect(failures).toHaveLength(1);
      expect(failures[0]?.sessionId).toBe(failingSessionId);
      expect(failures[0]?.stepId).toBe(failingStepId);
      expect(failures[0]?.code).toBe("EACCES");

      // Never the absolute path — only the session id, step id and errno
      // code may be carried in a fault-classified error's context.
      expect(JSON.stringify(consoleError.context)).not.toContain(root);
    },
  );
});

describe("pruneSessionArtifacts — schedules nothing (ADR-0070 'never silent deletion')", () => {
  test("installs no pending timer of any kind when called", async () => {
    vi.useFakeTimers();
    try {
      const records = new Map<string, M3LSessionStepRecord>();
      await pruneSessionArtifacts({
        artifactRoot: root,
        repository: createFakeSessionsRepository(records),
        retentionMs: 1_000,
        nowMs: () => 100_000,
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pruneSessionArtifacts — clock injection", () => {
  test("defaults the clock to Date.now when nowMs is not supplied — asserted by behavior, not identity", async () => {
    const retentionMs = 1_000;
    const fixedNow = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const sessionId = "session-default-clock";
      const stepId = "step-default-clock";
      const records = new Map<string, M3LSessionStepRecord>([
        [
          stepId,
          buildStepRecord({
            id: stepId,
            sessionId,
            endedAtMs: fixedNow - retentionMs - 1,
          }),
        ],
      ]);
      const filePath = await makeArtifactFile(sessionId, stepId);

      const outcome = await pruneSessionArtifacts({
        artifactRoot: root,
        repository: createFakeSessionsRepository(records),
        retentionMs,
      });

      expect(outcome.deleted).toBe(1);
      expect(await fileExists(filePath)).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
