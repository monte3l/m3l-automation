/**
 * Tests for src/run-output-retention.ts — `pruneRunOutputs`
 * (m3l-console-server X8 slice 5b run-output retention sweep, ADR-0070).
 *
 * These run against a REAL temporary directory rather than a mocked
 * `node:fs` — this driver's whole job is filesystem effects (`readdir`,
 * `rm`, symlink handling), and a mocked `fs` would only ever confirm the
 * mock's own beliefs about those. The run-record side is independent of
 * disk: a hand-written fake `M3LConsoleRunsRepository` backed by a `Map`
 * supplies `get`; every other member throws, so an accidental call surfaces
 * immediately as a test failure.
 *
 * RED: `../src/run-output-retention.ts` does not exist yet — every import
 * below is expected to fail to resolve until the implementer lands it.
 * `../src/store/run-status.js` and `../src/store/runs-repository.js` are
 * already shipped and real — `RUN_TERMINAL_STATUSES` and
 * `M3LConsoleRunsRepository`/`M3LRunRecord` come from there, never a
 * hand-typed copy in this file.
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
  pruneRunOutputs,
  type M3LRunOutputPruneOutcome,
  type PruneRunOutputsOptions,
} from "../src/run-output-retention.js";
import { RUN_TERMINAL_STATUSES } from "../src/store/run-status.js";
import type { M3LRunTerminalStatus } from "../src/store/run-status.js";
import type {
  M3LConsoleRunsRepository,
  M3LRunRecord,
} from "../src/store/runs-repository.js";

/** Root ignores permission bits entirely, so the chmod-based failure tests cannot run as root. */
const skipAsRoot = process.getuid?.() === 0;

/** The one temporary runs-output root each test gets its own copy of. */
let root: string;
/** Directories whose permissions a test narrowed; restored before `rm` in `afterEach`. */
let chmodTargets: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "m3l-run-output-retention-"));
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

/** Builds a complete, valid `M3LRunRecord`, with `overrides` applied on top. */
function buildRunRecord(overrides: Partial<M3LRunRecord> = {}): M3LRunRecord {
  return {
    id: "run-default",
    script: "scripts/example",
    status: "success",
    dryRun: false,
    executionMode: "spawn",
    parameters: undefined,
    operator: "alice",
    correlationId: "corr-1",
    queuedAtMs: 0,
    startedAtMs: undefined,
    endedAtMs: undefined,
    outcome: "success",
    exitCode: undefined,
    failureMessage: undefined,
    ...overrides,
  };
}

/**
 * A hand-written fake `M3LConsoleRunsRepository`: `get` reads from `records`
 * (a plain `Map`, independent of disk); every other member throws, so a call
 * `pruneRunOutputs` has no business making surfaces immediately.
 */
function createFakeRunsRepository(
  records: Map<string, M3LRunRecord>,
): M3LConsoleRunsRepository {
  const unexpected = (member: string) => (): never => {
    throw new Error(`pruneRunOutputs must not call repository.${member}`);
  };
  return {
    insertQueued: unexpected("insertQueued"),
    claimForStart: unexpected("claimForStart"),
    finish: unexpected("finish"),
    get: (id: string) => records.get(id),
    list: unexpected("list"),
    countByStatus: unexpected("countByStatus"),
    countRunningForScript: unexpected("countRunningForScript"),
    reconcileOrphaned: unexpected("reconcileOrphaned"),
    abandonQueued: unexpected("abandonQueued"),
  };
}

/** Creates an (empty, unless `withFile`) run-output directory at `root/id`. */
async function makeRunDir(id: string, withFile = false): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  if (withFile) {
    await writeFile(join(dir, "output.txt"), "content", "utf8");
  }
  return dir;
}

/** Asserts a path still exists (does not throw `ENOENT`). */
async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("M3LRunOutputPruneOutcome", () => {
  test("has the exact four-bucket-plus-rootExisted shape the contract declares", () => {
    const outcome: M3LRunOutputPruneOutcome = {
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
 * Builds one run whose output directory would be eligible for deletion
 * under any sane `retentionMs`/`nowMs` (it ended 1ms before `nowMs`), so a
 * rejected call that nonetheless deleted it would prove the input-validation
 * guard is not actually bounding the recursive `rm`.
 */
async function seedEligibleRun(): Promise<{
  dir: string;
  records: Map<string, M3LRunRecord>;
}> {
  const runId = "run-would-be-eligible";
  const nowMs = 100_000;
  const records = new Map<string, M3LRunRecord>([
    [
      runId,
      buildRunRecord({
        id: runId,
        status: "success",
        outcome: "success",
        endedAtMs: nowMs - 1,
      }),
    ],
  ]);
  const dir = await makeRunDir(runId);
  return { dir, records };
}

describe("pruneRunOutputs — retentionMs is validated before any filesystem access", () => {
  test.each<[string, number]>([
    ["NaN", Number.NaN],
    ["a negative value", -1_000_000],
    ["zero", 0],
    ["a non-integer", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "rejects retentionMs = %s with ERR_CONSOLE_CONFIG_INVALID and deletes nothing",
    async (_label, retentionMs) => {
      const { dir, records } = await seedEligibleRun();

      let thrown: unknown;
      try {
        await pruneRunOutputs({
          runsOutputRoot: root,
          repository: createFakeRunsRepository(records),
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
      // The important part: input validation runs before ANY rm, so the
      // eligible directory survives a rejected call.
      expect(await dirExists(dir)).toBe(true);
    },
  );
});

describe("pruneRunOutputs — the resolved nowMs() is validated before any filesystem access", () => {
  test("rejects a nowMs() returning NaN with ERR_CONSOLE_CONFIG_INVALID and deletes nothing", async () => {
    const { dir, records } = await seedEligibleRun();

    let thrown: unknown;
    try {
      await pruneRunOutputs({
        runsOutputRoot: root,
        repository: createFakeRunsRepository(records),
        retentionMs: 1_000,
        nowMs: () => Number.NaN,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(await dirExists(dir)).toBe(true);
  });
});

describe("pruneRunOutputs — classification is total", () => {
  test("seeds one directory per bucket and asserts both the returned counts and which directories still exist on disk", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;

    const records = new Map<string, M3LRunRecord>([
      [
        "run-deleted",
        buildRunRecord({
          id: "run-deleted",
          status: "success",
          outcome: "success",
          endedAtMs: nowMs - retentionMs - 1,
        }),
      ],
      [
        "run-retained-live",
        buildRunRecord({
          id: "run-retained-live",
          status: "running",
          outcome: undefined,
          endedAtMs: undefined,
        }),
      ],
      [
        "run-retained-young",
        buildRunRecord({
          id: "run-retained-young",
          status: "success",
          outcome: "success",
          endedAtMs: nowMs - retentionMs + 1,
        }),
      ],
      [
        "run-orphaned-no-ended",
        buildRunRecord({
          id: "run-orphaned-no-ended",
          status: "success",
          outcome: "success",
          endedAtMs: undefined,
        }),
      ],
    ]);

    const deletedDir = await makeRunDir("run-deleted");
    const retainedLiveDir = await makeRunDir("run-retained-live");
    const retainedYoungDir = await makeRunDir("run-retained-young");
    const orphanedNoEndedDir = await makeRunDir("run-orphaned-no-ended");
    const orphanedNoRecordDir = await makeRunDir("run-orphaned-no-record");

    const outcome = await pruneRunOutputs({
      runsOutputRoot: root,
      repository: createFakeRunsRepository(records),
      retentionMs,
      nowMs: () => nowMs,
    });

    expect(outcome).toEqual({
      deleted: 1,
      retainedLive: 1,
      retainedYoung: 1,
      orphaned: 2,
      rootExisted: true,
    });

    expect(await dirExists(deletedDir)).toBe(false);
    expect(await dirExists(retainedLiveDir)).toBe(true);
    expect(await dirExists(retainedYoungDir)).toBe(true);
    expect(await dirExists(orphanedNoEndedDir)).toBe(true);
    expect(await dirExists(orphanedNoRecordDir)).toBe(true);
  });
});

describe("pruneRunOutputs — boundary (strict `<`)", () => {
  test("a run whose endedAtMs equals nowMs - retentionMs exactly is retained, not deleted", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;
    const records = new Map<string, M3LRunRecord>([
      [
        "run-boundary",
        buildRunRecord({
          id: "run-boundary",
          status: "success",
          outcome: "success",
          endedAtMs: nowMs - retentionMs,
        }),
      ],
    ]);
    const dir = await makeRunDir("run-boundary");

    const outcome = await pruneRunOutputs({
      runsOutputRoot: root,
      repository: createFakeRunsRepository(records),
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
    expect(await dirExists(dir)).toBe(true);
  });

  test("one millisecond older than the boundary is deleted", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;
    const records = new Map<string, M3LRunRecord>([
      [
        "run-just-old",
        buildRunRecord({
          id: "run-just-old",
          status: "success",
          outcome: "success",
          endedAtMs: nowMs - retentionMs - 1,
        }),
      ],
    ]);
    const dir = await makeRunDir("run-just-old");

    const outcome = await pruneRunOutputs({
      runsOutputRoot: root,
      repository: createFakeRunsRepository(records),
      retentionMs,
      nowMs: () => nowMs,
    });

    expect(outcome.deleted).toBe(1);
    expect(await dirExists(dir)).toBe(false);
  });

  test("one millisecond younger than the boundary is retained", async () => {
    const retentionMs = 1_000;
    const nowMs = 100_000;
    const records = new Map<string, M3LRunRecord>([
      [
        "run-just-young",
        buildRunRecord({
          id: "run-just-young",
          status: "success",
          outcome: "success",
          endedAtMs: nowMs - retentionMs + 1,
        }),
      ],
    ]);
    const dir = await makeRunDir("run-just-young");

    const outcome = await pruneRunOutputs({
      runsOutputRoot: root,
      repository: createFakeRunsRepository(records),
      retentionMs,
      nowMs: () => nowMs,
    });

    expect(outcome.retainedYoung).toBe(1);
    expect(await dirExists(dir)).toBe(true);
  });
});

describe("pruneRunOutputs — terminal statuses are enumerated, not sampled", () => {
  test.each<[M3LRunTerminalStatus]>(
    RUN_TERMINAL_STATUSES.map((status) => [status] as [M3LRunTerminalStatus]),
  )(
    "a terminal run past retention with status %s is deleted",
    async (status) => {
      const retentionMs = 1_000;
      const nowMs = 100_000;
      const runId = `run-terminal-${status}`;
      const records = new Map<string, M3LRunRecord>([
        [
          runId,
          buildRunRecord({
            id: runId,
            status,
            outcome: status,
            endedAtMs: nowMs - retentionMs - 1,
          }),
        ],
      ]);
      const dir = await makeRunDir(runId);

      const outcome = await pruneRunOutputs({
        runsOutputRoot: root,
        repository: createFakeRunsRepository(records),
        retentionMs,
        nowMs: () => nowMs,
      });

      expect(outcome.deleted).toBe(1);
      expect(await dirExists(dir)).toBe(false);
    },
  );
});

describe("pruneRunOutputs — a missing root", () => {
  test("returns a zero outcome with rootExisted: false and creates nothing on disk", async () => {
    const missingRoot = join(root, "does-not-exist");
    const records = new Map<string, M3LRunRecord>();

    const outcome = await pruneRunOutputs({
      runsOutputRoot: missingRoot,
      repository: createFakeRunsRepository(records),
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
    expect(await dirExists(missingRoot)).toBe(false);
  });
});

describe("pruneRunOutputs — a present but empty root", () => {
  test("returns a zero outcome with rootExisted: true — distinguishing 'empty' from 'missing'", async () => {
    // `root` itself was created by `beforeEach` and has nothing swept into
    // it by this test, so it is present but empty — the case Finding 2's
    // `rootExisted` field exists to distinguish from a missing root, which
    // produces byte-identical bucket counts (all zero) without it.
    const records = new Map<string, M3LRunRecord>();

    const outcome = await pruneRunOutputs({
      runsOutputRoot: root,
      repository: createFakeRunsRepository(records),
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

describe("pruneRunOutputs — a non-ENOENT readdir failure on the root", () => {
  test("propagates instead of being swallowed into a zero outcome", async () => {
    // A regular file used as the "root" makes readdir fail with ENOTDIR —
    // deterministic and reversible without touching permission bits (so,
    // unlike the EACCES technique in the failure-posture test below, this
    // needs no root skip). Only ENOENT is special-cased into a zero outcome;
    // every other readdir errno — ENOTDIR here — must propagate unchanged.
    const filePath = join(root, "not-a-directory");
    await writeFile(filePath, "content", "utf8");

    const records = new Map<string, M3LRunRecord>();

    let thrown: unknown;
    try {
      await pruneRunOutputs({
        runsOutputRoot: filePath,
        repository: createFakeRunsRepository(records),
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

describe("pruneRunOutputs — a symlink in the root is not followed", () => {
  test("a symlink pointing at a directory outside the root is skipped, and its target is untouched", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "m3l-run-output-outside-"));
    try {
      const markerFile = join(outsideDir, "marker.txt");
      await writeFile(markerFile, "still here", "utf8");

      const symlinkPath = join(root, "run-symlinked");
      await symlink(outsideDir, symlinkPath, "dir");

      const records = new Map<string, M3LRunRecord>();
      const outcome = await pruneRunOutputs({
        runsOutputRoot: root,
        repository: createFakeRunsRepository(records),
        retentionMs: 1_000,
        nowMs: () => 100_000,
      });

      // Not classified into any bucket — the symlink is excluded before
      // classification, so nothing here counts it.
      expect(outcome).toEqual({
        deleted: 0,
        retainedLive: 0,
        retainedYoung: 0,
        orphaned: 0,
        rootExisted: true,
      });
      expect(await dirExists(markerFile)).toBe(true);
      expect(await dirExists(outsideDir)).toBe(true);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("pruneRunOutputs — failure posture", () => {
  test.skipIf(skipAsRoot)(
    "a per-directory rm failure does not abort the walk, throws ERR_CONSOLE_INTERNAL with the original cause and the failing run id, and still deletes a later eligible directory",
    async () => {
      const retentionMs = 1_000;
      const nowMs = 100_000;

      // Named so `failingId` sorts strictly BEFORE `succeedsId`:
      // `pruneRunOutputs` sorts directory entries by name before walking
      // (see the sort in run-output-retention.ts), so with this ordering a
      // `break` inserted right after the failure would leave `succeedsDir`
      // undeleted and the "walk continued" assertion below would fail. Pin
      // the assumption literally so a future rename of either fixture can't
      // silently make this test vacuous again.
      const failingId = "run-a-fails-to-delete";
      const succeedsId = "run-b-deletes-fine";
      expect(failingId < succeedsId).toBe(true);

      const records = new Map<string, M3LRunRecord>([
        [
          failingId,
          buildRunRecord({
            id: failingId,
            status: "success",
            outcome: "success",
            endedAtMs: nowMs - retentionMs - 1,
          }),
        ],
        [
          succeedsId,
          buildRunRecord({
            id: succeedsId,
            status: "success",
            outcome: "success",
            endedAtMs: nowMs - retentionMs - 1,
          }),
        ],
      ]);

      // Contains a file, so recursive rm must unlink a child of this
      // directory — which requires WRITE permission on the directory
      // itself, not merely its parent. Narrowing that permission below is
      // what makes exactly this one deletion fail.
      const failingDir = await makeRunDir(failingId, true);
      const succeedsDir = await makeRunDir(succeedsId);

      await chmod(failingDir, 0o500);
      chmodTargets.push(failingDir);

      let thrown: unknown;
      try {
        await pruneRunOutputs({
          runsOutputRoot: root,
          repository: createFakeRunsRepository(records),
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
      // re-normalised into a fresh Error with the same message, which would
      // defeat identity but pass a loose message-text comparison.
      expect(consoleError.cause).toBeInstanceOf(Error);
      expect((consoleError.cause as NodeJS.ErrnoException).code).toBe("EACCES");

      // The walk continued: the OTHER eligible directory was still deleted
      // despite the failure on this one.
      expect(await dirExists(succeedsDir)).toBe(false);
      // The failing directory's deletion never completed.
      expect(await dirExists(failingDir)).toBe(true);

      expect(Object.hasOwn(consoleError.context, "outcome")).toBe(true);
      expect(Object.hasOwn(consoleError.context, "failures")).toBe(true);

      // "the counts actually achieved" — the failed deletion must NOT be
      // counted as `deleted`; only `succeedsId`'s successful removal is.
      const outcome = consoleError.context[
        "outcome"
      ] as M3LRunOutputPruneOutcome;
      expect(outcome).toEqual({
        deleted: 1,
        retainedLive: 0,
        retainedYoung: 0,
        orphaned: 0,
        rootExisted: true,
      });

      const failures = consoleError.context["failures"] as ReadonlyArray<{
        runId: string;
        code: string | undefined;
      }>;
      expect(failures).toHaveLength(1);
      expect(failures[0]?.runId).toBe(failingId);
      expect(failures[0]?.code).toBe("EACCES");

      // Never the absolute path — only the run id and errno code may be
      // carried in a fault-classified error's context.
      expect(JSON.stringify(consoleError.context)).not.toContain(root);
    },
  );
});

describe("pruneRunOutputs — schedules nothing (ADR-0070 'never silent deletion')", () => {
  test("installs no pending timer of any kind when called", async () => {
    vi.useFakeTimers();
    try {
      const records = new Map<string, M3LRunRecord>();
      await pruneRunOutputs({
        runsOutputRoot: root,
        repository: createFakeRunsRepository(records),
        retentionMs: 1_000,
        nowMs: () => 100_000,
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pruneRunOutputs — clock injection", () => {
  test("two sweeps with different pinned nowMs classify the same directory differently", async () => {
    const retentionMs = 1_000;
    const endedAtMs = 50_000;

    // Two independent roots, each seeded identically — the point is that the
    // SAME directory contents classify differently under a different `nowMs`,
    // demonstrated across two isolated sweeps rather than reusing one
    // already-deleted directory.
    const rootOld = await mkdtemp(join(tmpdir(), "m3l-run-output-clock-old-"));
    const rootYoung = await mkdtemp(
      join(tmpdir(), "m3l-run-output-clock-young-"),
    );
    try {
      const runId = "run-clock-probe";
      const recordFor = () =>
        new Map<string, M3LRunRecord>([
          [
            runId,
            buildRunRecord({
              id: runId,
              status: "success",
              outcome: "success",
              endedAtMs,
            }),
          ],
        ]);

      await mkdir(join(rootOld, runId), { recursive: true });
      await mkdir(join(rootYoung, runId), { recursive: true });

      // Old clock: retention window has fully elapsed since endedAtMs.
      const oldOutcome = await pruneRunOutputs({
        runsOutputRoot: rootOld,
        repository: createFakeRunsRepository(recordFor()),
        retentionMs,
        nowMs: () => endedAtMs + retentionMs + 1,
      });

      // Young clock: well inside the retention window.
      const youngOutcome = await pruneRunOutputs({
        runsOutputRoot: rootYoung,
        repository: createFakeRunsRepository(recordFor()),
        retentionMs,
        nowMs: () => endedAtMs + 1,
      });

      expect(oldOutcome.deleted).toBe(1);
      expect(youngOutcome.retainedYoung).toBe(1);
      expect(await dirExists(join(rootOld, runId))).toBe(false);
      expect(await dirExists(join(rootYoung, runId))).toBe(true);
    } finally {
      await rm(rootOld, { recursive: true, force: true });
      await rm(rootYoung, { recursive: true, force: true });
    }
  });

  test("defaults the clock to Date.now when nowMs is not supplied — asserted by behavior, not identity", async () => {
    const retentionMs = 1_000;
    const fixedNow = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const runId = "run-default-clock";
      const records = new Map<string, M3LRunRecord>([
        [
          runId,
          buildRunRecord({
            id: runId,
            status: "success",
            outcome: "success",
            endedAtMs: fixedNow - retentionMs - 1,
          }),
        ],
      ]);
      const dir = await makeRunDir(runId);

      const options: PruneRunOutputsOptions = {
        runsOutputRoot: root,
        repository: createFakeRunsRepository(records),
        retentionMs,
      };
      const outcome = await pruneRunOutputs(options);

      expect(outcome.deleted).toBe(1);
      expect(await dirExists(dir)).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
