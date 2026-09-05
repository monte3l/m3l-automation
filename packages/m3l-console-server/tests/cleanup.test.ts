/**
 * Tests for `src/cleanup.ts` — `runCleanup` (m3l-console-server X8 slice 5c,
 * ADR-0070 operator-triggered retention sweep).
 *
 * Tests run against a REAL `:memory:` SQLite store and real temporary
 * directories rather than mocked I/O, to confirm actual database effects
 * and actual filesystem deletions rather than mock beliefs.
 *
 * The three retention drivers are independent — a failure in the first
 * (telemetry) must not prevent the other two from running. The failure test
 * deliberately makes telemetry (the FIRST driver in `runCleanup`'s sequence)
 * fail, so any regress to abort-on-first-failure is caught immediately:
 * if the failing driver were the last one, there would be nothing left to
 * lose and the test would pass against the broken code.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import {
  runCleanup,
  type M3LConsoleCleanupOutcome,
  type RunCleanupOptions,
} from "../src/cleanup.js";
import { openConsoleStore } from "../src/store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
} from "../src/store/store.js";

// ---------------------------------------------------------------------------
// Fixtures shared across tests
// ---------------------------------------------------------------------------

/** A timestamp far enough in the past that any record with endedAtMs = OLD_MS
 *  is eligible for deletion with any sane retention window. */
const OLD_MS = 1_000;

/** A very large "now" that makes every record old enough to sweep. */
const FAR_FUTURE_MS = Number.MAX_SAFE_INTEGER;

/** Minimal valid absolute fake DB path (bypassed by the openStore seam). */
const FAKE_DB_PATH = "/tmp/cleanup-test.sqlite";

/** Temporary roots created/removed per test. */
let runsRoot: string;
let artifactRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), "m3l-cleanup-runs-"));
  artifactRoot = await mkdtemp(join(tmpdir(), "m3l-cleanup-artifacts-"));
});

afterEach(async () => {
  await rm(runsRoot, { recursive: true, force: true });
  await rm(artifactRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opens a fresh `:memory:` store and wires it as the `openStore` seam.
 *  Returns both the store (for pre-test data insertion) and the seam function. */
function makeMemoryStore(): {
  store: M3LConsoleStore & M3LConsoleStoreHandle;
  openStore: (location: string) => M3LConsoleStore & M3LConsoleStoreHandle;
} {
  const store = openConsoleStore({ location: ":memory:" });
  const openStore = (
    _location: string,
  ): M3LConsoleStore & M3LConsoleStoreHandle => store;
  return { store, openStore };
}

/** Builds the minimal `env` needed by `runCleanup`, pointing it at the given
 *  temporary roots and the fake DB path so it never touches the real workspace. */
function buildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_DB_PATH: FAKE_DB_PATH,
    M3L_CONSOLE_RUNS_OUTPUT_ROOT: runsRoot,
    M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT: artifactRoot,
    // Keep default retention windows; the FAR_FUTURE_MS clock makes everything eligible.
    ...overrides,
  };
}

/**
 * Inserts a telemetry measurement into `store`. `bucketStartMs` must be
 * aligned to the minute boundary (a multiple of 60_000 ms).
 */
function insertTelemetry(
  store: M3LConsoleStore & M3LConsoleStoreHandle,
  bucketStartMs: number,
): void {
  store.telemetry.record({
    metric: "sse.stream",
    granularity: "minute",
    bucketStartMs,
  });
}

/** Inserts a terminal run record (insertQueued → claimForStart → finish) into
 *  `store` and creates a matching directory under `runsRoot`. */
async function insertTerminalRun(
  store: M3LConsoleStore & M3LConsoleStoreHandle,
  runId: string,
  endedAtMs: number,
): Promise<void> {
  store.runs.insertQueued({
    id: runId,
    script: "scripts/example",
    dryRun: false,
    executionMode: "spawn",
    parameters: null,
    operator: "alice",
    correlationId: `corr-${runId}`,
    queuedAtMs: OLD_MS,
  });
  store.runs.claimForStart(runId, OLD_MS);
  store.runs.finish(runId, { outcome: "success", endedAtMs });
  await mkdir(join(runsRoot, runId), { recursive: true });
  // Place a marker file so the directory is non-trivially populated.
  await writeFile(join(runsRoot, runId, "run-report.json"), "{}");
}

/** Inserts a finished step record and creates a matching artifact file under
 *  `artifactRoot`. Transitions the step through queued → running → terminal
 *  because `finishStep` guards on `status = 'running'`. */
async function insertFinishedStep(
  store: M3LConsoleStore & M3LConsoleStoreHandle,
  sessionId: string,
  stepId: string,
  endedAtMs: number,
): Promise<void> {
  store.sessions.insertSession({
    id: sessionId,
    operator: "alice",
    correlationId: `corr-${sessionId}`,
    createdAtMs: OLD_MS,
  });
  store.sessions.insertStep({
    id: stepId,
    sessionId,
    ordinal: 1,
    operation: "scripts/example",
    parameters: null,
    queuedAtMs: OLD_MS,
  });
  // claimStepForStart moves queued → running; finishStep requires running.
  store.sessions.claimStepForStart(stepId, OLD_MS);
  store.sessions.finishStep(stepId, { outcome: "success", endedAtMs });
  const sessionDir = join(artifactRoot, sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, `${stepId}.json`), "{}");
}

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

describe("M3LConsoleCleanupOutcome", () => {
  test("has the exact shape the contract declares", () => {
    expect<() => M3LConsoleCleanupOutcome>(() => {
      throw new Error("not called");
    }).toBeDefined();
  });
});

describe("RunCleanupOptions", () => {
  test("openStore seam is typed as (location: string) => M3LConsoleStore & M3LConsoleStoreHandle", () => {
    const options: RunCleanupOptions = {
      openStore: (_loc: string): M3LConsoleStore & M3LConsoleStoreHandle =>
        openConsoleStore({ location: ":memory:" }),
    };
    expect(options.openStore).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Happy path + observable effects (cases 1 + 2 combined)
// ---------------------------------------------------------------------------

describe("runCleanup — happy path", () => {
  test("all three drivers run and return real deletion counts", async () => {
    const { store, openStore } = makeMemoryStore();

    // Telemetry: one old minute-bucket row (must be aligned to 60_000 ms).
    insertTelemetry(store, 60_000);

    // Run output: one terminal run dir that is old enough to sweep.
    await insertTerminalRun(store, "run-alpha", OLD_MS);

    // Session artifact: one finished step file that is old enough to sweep.
    await insertFinishedStep(store, "session-alpha", "step-alpha", OLD_MS);

    const outcome = await runCleanup({
      env: buildEnv(),
      openStore,
      nowMs: () => FAR_FUTURE_MS,
    });

    // Each driver must report at least one deletion.
    expect(outcome.telemetry.total).toBeGreaterThan(0);
    expect(outcome.runOutputs.deleted).toBe(1);
    expect(outcome.sessionArtifacts.deleted).toBe(1);

    // The run output directory must be physically gone.
    await expect(stat(join(runsRoot, "run-alpha"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // The session artifact file must be physically gone.
    await expect(
      stat(join(artifactRoot, "session-alpha", "step-alpha.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("schedules nothing: no pending timers after a clean sweep", async () => {
    vi.useFakeTimers();
    try {
      const { openStore } = makeMemoryStore();
      await runCleanup({
        env: buildEnv(),
        openStore,
        nowMs: () => 1,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3: failing FIRST driver does not prevent the other two from running
// ---------------------------------------------------------------------------

describe("runCleanup — failing first driver (telemetry)", () => {
  test("runOutputs and sessionArtifacts still run, and their outcomes appear in the thrown error's context", async () => {
    const { store, openStore } = makeMemoryStore();

    // Make telemetry.prune (the FIRST driver) throw.
    vi.spyOn(store.telemetry, "prune").mockImplementation(() => {
      throw new Error("simulated telemetry prune failure");
    });

    // Set up data for the other two drivers so their outcomes are non-trivially
    // testable (rootExisted: true means readdir ran, regardless of deletions).
    await insertTerminalRun(store, "run-beta", OLD_MS);
    await insertFinishedStep(store, "session-beta", "step-beta", OLD_MS);

    let thrown: M3LConsoleError | undefined;
    try {
      await runCleanup({
        env: buildEnv(),
        openStore,
        nowMs: () => FAR_FUTURE_MS,
      });
    } catch (e) {
      if (e instanceof M3LConsoleError) thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("ERR_CONSOLE_INTERNAL");

    // The first failure (telemetry driver) is chained as cause. `pruneTelemetry`
    // wraps repository throws in its own M3LConsoleError, so the cause here is
    // that wrapper — not the raw mock error.
    const cause = thrown?.cause;
    expect(cause).toBeInstanceOf(M3LConsoleError);
    expect((cause as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
    expect((cause as M3LConsoleError).message).toContain(
      "telemetry prune failed",
    );

    // Successful drivers' outcomes are in context (telemetry is absent — it failed).
    const ctx = thrown?.context;
    expect(ctx).toBeDefined();
    expect(ctx).not.toHaveProperty("telemetry");
    expect(ctx).toHaveProperty("runOutputs");
    expect(ctx).toHaveProperty("sessionArtifacts");

    // The run output dir was deleted even though telemetry failed.
    await expect(stat(join(runsRoot, "run-beta"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The artifact file was deleted even though telemetry failed.
    await expect(
      stat(join(artifactRoot, "session-beta", "step-beta.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// Case 4: store is closed even when a driver throws
// ---------------------------------------------------------------------------

describe("runCleanup — store lifecycle", () => {
  test("store is closed in the finally block even when a driver fails", async () => {
    const { store, openStore } = makeMemoryStore();

    vi.spyOn(store.telemetry, "prune").mockImplementation(() => {
      throw new Error("prune boom");
    });

    await expect(
      runCleanup({
        env: buildEnv(),
        openStore,
        nowMs: () => FAR_FUTURE_MS,
      }),
    ).rejects.toBeInstanceOf(M3LConsoleError);

    // `isOpen` must be false — the store was closed in the finally block.
    expect(store.isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 5: context contains no absolute root path
// ---------------------------------------------------------------------------

describe("runCleanup — context does not leak absolute paths", () => {
  test("the thrown error's context carries only counts and flags, no root path", async () => {
    const { store, openStore } = makeMemoryStore();

    vi.spyOn(store.telemetry, "prune").mockImplementation(() => {
      throw new Error("boom");
    });

    let thrown: M3LConsoleError | undefined;
    try {
      await runCleanup({
        env: buildEnv(),
        openStore,
        nowMs: () => FAR_FUTURE_MS,
      });
    } catch (e) {
      if (e instanceof M3LConsoleError) thrown = e;
    }

    expect(thrown).toBeDefined();
    const contextJson = JSON.stringify(thrown?.context ?? {});

    // Neither the runs root nor the artifact root must appear in context.
    expect(contextJson).not.toContain(runsRoot);
    expect(contextJson).not.toContain(artifactRoot);
    // Sanity: context is not empty (the other two drivers succeeded).
    expect(contextJson.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// Case 6a: two simultaneous driver failures — both appear in context.failures
// ---------------------------------------------------------------------------

describe("runCleanup — two simultaneous driver failures", () => {
  test("both failed drivers appear in context.failures with their own driver names", async () => {
    const { store, openStore } = makeMemoryStore();

    // Make telemetry.prune (FIRST driver) throw.
    vi.spyOn(store.telemetry, "prune").mockImplementation(() => {
      throw new Error("simulated telemetry failure");
    });

    // Make pruneRunOutputs fail: create a bare directory in runsRoot so readdir
    // finds an entry, then make store.runs.get throw so classifyAndSweep fails.
    await mkdir(join(runsRoot, "run-two-fail"), { recursive: true });
    vi.spyOn(store.runs, "get").mockImplementation(() => {
      throw new Error("simulated runs repository failure");
    });

    // sessionArtifacts has nothing to process — it will succeed.

    let thrown: M3LConsoleError | undefined;
    try {
      await runCleanup({
        env: buildEnv(),
        openStore,
        nowMs: () => FAR_FUTURE_MS,
      });
    } catch (e) {
      if (e instanceof M3LConsoleError) thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("ERR_CONSOLE_INTERNAL");

    // context.failures must contain exactly two entries — one per failed driver.
    const ctx = thrown?.context;
    expect(ctx).toBeDefined();
    const failures = ctx?.["failures"];
    expect(Array.isArray(failures)).toBe(true);
    expect((failures as unknown[]).length).toBe(2);

    const failureDrivers = (failures as Array<{ driver: string }>).map(
      (f) => f.driver,
    );
    // Both failed drivers must be named — the second failure (runOutputs) must
    // not be lost as the old code dropped everything except the first failure.
    expect(failureDrivers).toContain("telemetry");
    expect(failureDrivers).toContain("runOutputs");

    // The successful driver's outcome is still published.
    expect(ctx).toHaveProperty("sessionArtifacts");
  });
});

// ---------------------------------------------------------------------------
// Case 6b: clean-sweep close() failure raises ERR_CONSOLE_INTERNAL
// ---------------------------------------------------------------------------

describe("runCleanup — close() failure after a clean sweep", () => {
  test("raises ERR_CONSOLE_INTERNAL when all drivers succeed but close() throws", async () => {
    const { store, openStore } = makeMemoryStore();

    // All three drivers succeed (no data → zero counts, still success).
    const closeError = new Error("simulated close failure");
    vi.spyOn(store, "close").mockImplementation(() => {
      throw closeError;
    });

    let thrown: M3LConsoleError | undefined;
    try {
      await runCleanup({
        env: buildEnv(),
        openStore,
        nowMs: () => FAR_FUTURE_MS,
      });
    } catch (e) {
      if (e instanceof M3LConsoleError) thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("ERR_CONSOLE_INTERNAL");
    // The close error must be chained as cause.
    expect(thrown?.cause).toBe(closeError);
  });
});

// ---------------------------------------------------------------------------
// Case 6c: driver failure + close() throws — driver error wins, not close error
// ---------------------------------------------------------------------------

describe("runCleanup — close() failure when a driver already failed", () => {
  test("reports the driver error, not the close() error", async () => {
    const { store, openStore } = makeMemoryStore();

    // Telemetry driver fails.
    const driverError = new Error("simulated driver failure");
    vi.spyOn(store.telemetry, "prune").mockImplementation(() => {
      throw driverError;
    });

    // close() also fails — must be silently swallowed.
    vi.spyOn(store, "close").mockImplementation(() => {
      throw new Error("simulated close failure — must not win");
    });

    let thrown: M3LConsoleError | undefined;
    try {
      await runCleanup({
        env: buildEnv(),
        openStore,
        nowMs: () => FAR_FUTURE_MS,
      });
    } catch (e) {
      if (e instanceof M3LConsoleError) thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("ERR_CONSOLE_INTERNAL");
    // The close error must NOT be the thrown error's cause.
    // The driver error is wrapped inside an M3LConsoleError from pruneTelemetry.
    const cause = thrown?.cause;
    expect(cause).toBeInstanceOf(M3LConsoleError);
    expect((cause as M3LConsoleError).message).toContain(
      "telemetry prune failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Case 6: no pending timers (broader variant — after a failure too)
// ---------------------------------------------------------------------------

describe("runCleanup — no pending timers on failure", () => {
  test("schedules nothing even when a driver throws", async () => {
    vi.useFakeTimers();
    try {
      const { store, openStore } = makeMemoryStore();
      vi.spyOn(store.telemetry, "prune").mockImplementation(() => {
        throw new Error("boom");
      });
      await expect(
        runCleanup({
          env: buildEnv(),
          openStore,
          nowMs: () => FAR_FUTURE_MS,
        }),
      ).rejects.toBeInstanceOf(M3LConsoleError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
