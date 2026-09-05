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
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

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
// Gap 1a — firstCause when ONLY pruneRunOutputs fails (line 190 coverage)
// Every existing failure test makes telemetry (the first driver) fail, so the
// `else if (!rResult.ok)` branch at line 190 of cleanup.ts is never reached.
// This test makes only the second driver fail, forcing that branch to execute
// and verifying the "first failure wins as cause" semantics when the first
// driver succeeds.
// ---------------------------------------------------------------------------

describe("runCleanup — failing second driver only (runOutputs)", () => {
  test("telemetry and sessionArtifacts still run; cause is the runOutputs error; only runOutputs appears in context.failures", async () => {
    const { store, openStore } = makeMemoryStore();

    // Place one directory in runsRoot so readdir finds an entry and
    // pruneRunOutputs calls store.runs.get — where we inject the failure.
    await mkdir(join(runsRoot, "run-only-fail"), { recursive: true });
    const runsError = new Error("simulated runOutputs-only failure");
    vi.spyOn(store.runs, "get").mockImplementation(() => {
      throw runsError;
    });

    // telemetry: no data → succeeds with zero total
    // sessionArtifacts: empty artifactRoot → succeeds with zero deleted

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

    // firstCause is rResult.cause — the raw error that escaped pruneRunOutputs.
    // This exercises the `else if (!rResult.ok) firstCause = rResult.cause`
    // branch at cleanup.ts:190.
    expect(thrown?.cause).toBe(runsError);

    // context.failures must carry exactly one entry, tagged "runOutputs".
    const ctx = thrown?.context;
    expect(ctx).toBeDefined();
    const failures = ctx?.["failures"];
    expect(Array.isArray(failures)).toBe(true);
    expect((failures as unknown[]).length).toBe(1);
    expect((failures as Array<{ driver: string }>)[0]?.driver).toBe(
      "runOutputs",
    );

    // Successful drivers' outcomes are present in context.
    expect(ctx).toHaveProperty("telemetry");
    expect(ctx).toHaveProperty("sessionArtifacts");
    expect(ctx).not.toHaveProperty("runOutputs");
  });
});

// ---------------------------------------------------------------------------
// Gap 1b — firstCause when ONLY pruneSessionArtifacts fails (line 191 coverage)
// The `else if (!sResult.ok)` branch at line 191 of cleanup.ts can only run
// when BOTH tResult.ok and rResult.ok are true — a scenario no existing test
// exercises. This test makes only the third driver fail.
// ---------------------------------------------------------------------------

describe("runCleanup — failing third driver only (sessionArtifacts)", () => {
  test("telemetry and runOutputs still run; cause is the sessionArtifacts error; only sessionArtifacts appears in context.failures", async () => {
    const { store, openStore } = makeMemoryStore();

    // Place a session directory with a .json artifact file in artifactRoot so
    // sweepSessionDirectory calls store.sessions.getStep — where we inject
    // the failure. The session and step id must match SAFE_ID_PATTERN.
    const sessionDir = join(artifactRoot, "session-only-fail");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "step-only-fail.json"), "{}");

    vi.spyOn(store.sessions, "getStep").mockImplementation(() => {
      throw new Error("simulated sessions-only failure");
    });

    // telemetry: no data → succeeds with zero total
    // runOutputs: empty runsRoot → succeeds

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

    // firstCause is sResult.cause — the M3LConsoleError that
    // walkSessionDirectories wraps the raw getStep throw in. This exercises
    // the `else if (!sResult.ok) firstCause = sResult.cause` branch at
    // cleanup.ts:191.
    expect(thrown?.cause).toBeInstanceOf(M3LConsoleError);
    expect((thrown?.cause as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_INTERNAL",
    );

    // context.failures must carry exactly one entry, tagged "sessionArtifacts".
    const ctx = thrown?.context;
    expect(ctx).toBeDefined();
    const failures = ctx?.["failures"];
    expect(Array.isArray(failures)).toBe(true);
    expect((failures as unknown[]).length).toBe(1);
    expect((failures as Array<{ driver: string }>)[0]?.driver).toBe(
      "sessionArtifacts",
    );

    // Successful drivers' outcomes are present in context.
    expect(ctx).toHaveProperty("telemetry");
    expect(ctx).toHaveProperty("runOutputs");
    expect(ctx).not.toHaveProperty("sessionArtifacts");
  });
});

// ---------------------------------------------------------------------------
// Gap 1c — runOutputs AND sessionArtifacts both fail, telemetry succeeds
// Complements case 6a (telemetry + runOutputs fail). Verifies that when the
// second and third drivers both fail: runOutputs cause wins (it runs first of
// the two), and NEITHER failure is lost from context.failures.
// ---------------------------------------------------------------------------

describe("runCleanup — second and third drivers both fail (runOutputs + sessionArtifacts)", () => {
  test("cause is the runOutputs error; both runOutputs and sessionArtifacts appear in context.failures", async () => {
    const { store, openStore } = makeMemoryStore();

    // Make pruneRunOutputs fail: directory in runsRoot + throwing get().
    await mkdir(join(runsRoot, "run-both-fail"), { recursive: true });
    const runsError = new Error(
      "simulated runOutputs failure (both-fail case)",
    );
    vi.spyOn(store.runs, "get").mockImplementation(() => {
      throw runsError;
    });

    // Make pruneSessionArtifacts fail: session dir + file + throwing getStep().
    const sessionDir = join(artifactRoot, "session-both-fail");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "step-both-fail.json"), "{}");
    vi.spyOn(store.sessions, "getStep").mockImplementation(() => {
      throw new Error("simulated sessionArtifacts failure (both-fail case)");
    });

    // telemetry: no data → succeeds.

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

    // runOutputs runs before sessionArtifacts, so its cause wins.
    // The `else if (!rResult.ok)` branch at cleanup.ts:190 sets firstCause;
    // the `else if (!sResult.ok)` branch is unreachable in this scenario.
    expect(thrown?.cause).toBe(runsError);

    // Both failures must appear in context.failures — neither is lost.
    const ctx = thrown?.context;
    expect(ctx).toBeDefined();
    const failures = ctx?.["failures"];
    expect(Array.isArray(failures)).toBe(true);
    expect((failures as unknown[]).length).toBe(2);
    const driverNames = (failures as Array<{ driver: string }>).map(
      (f) => f.driver,
    );
    expect(driverNames).toContain("runOutputs");
    expect(driverNames).toContain("sessionArtifacts");

    // Telemetry succeeded — its outcome is in context.
    expect(ctx).toHaveProperty("telemetry");
    expect(ctx).not.toHaveProperty("runOutputs");
    expect(ctx).not.toHaveProperty("sessionArtifacts");
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — default openStore (the production path at cleanup.ts:349)
// Every other test injects the openStore seam; the production code path
// `options.openStore ?? ((location) => openConsoleStore({ location }))` is
// never executed. This test calls runCleanup WITHOUT openStore, pointing
// M3L_CONSOLE_DB_PATH at a file inside a mkdtemp directory so the real
// SQLite store is opened without touching the workspace's data/console/.
// ---------------------------------------------------------------------------

describe("runCleanup — default openStore (real SQLite path)", () => {
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "m3l-cleanup-db-"));
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  test("opens the real console store when no openStore seam is injected", async () => {
    const dbPath = join(dbDir, "console.sqlite");

    // Do NOT pass openStore — the production default path must execute.
    const outcome = await runCleanup({
      env: {
        M3L_CONSOLE_DB_PATH: dbPath,
        M3L_CONSOLE_RUNS_OUTPUT_ROOT: runsRoot,
        M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT: artifactRoot,
      },
      nowMs: () => FAR_FUTURE_MS,
    });

    // Empty store → zero counts across all three drivers.
    expect(outcome.telemetry.total).toBe(0);
    expect(outcome.runOutputs.deleted).toBe(0);
    expect(outcome.sessionArtifacts.deleted).toBe(0);

    // Both filesystem roots were created by the outer beforeEach — they exist.
    expect(outcome.runOutputs.rootExisted).toBe(true);
    expect(outcome.sessionArtifacts.rootExisted).toBe(true);
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

// ---------------------------------------------------------------------------
// Case 7 — the fourth driver, auditTrail (X8 audit-trail retention sweep,
// ADR-0070). RED: `M3LConsoleCleanupOutcome` does not yet carry an
// `auditTrail` field and `runCleanup` does not yet resolve
// `M3L_CONSOLE_AUDIT_ROOT` / call the fourth driver — every case below is
// expected to fail until that wiring lands.
//
// Each case manages its own `auditRoot` temp directory locally (mkdtemp/rm),
// mirroring the "default openStore" describe block's local `dbDir` pattern
// above, rather than touching the shared `runsRoot`/`artifactRoot` outer
// beforeEach/afterEach — the 15 pre-existing tests above are left untouched.
// ---------------------------------------------------------------------------

describe("runCleanup — fourth driver (auditTrail)", () => {
  let auditRoot: string;

  beforeEach(async () => {
    auditRoot = await mkdtemp(join(tmpdir(), "m3l-cleanup-audit-"));
  });

  afterEach(async () => {
    await rm(auditRoot, { recursive: true, force: true });
  });

  test("a successful sweep's outcome carries auditTrail derived from real segment files", async () => {
    const { openStore } = makeMemoryStore();

    const stream = new Core.M3LAppendOnlyStream({
      directory: auditRoot,
      maxSegmentBytes: 60,
    });
    for (let index = 0; index < 6; index += 1) {
      await stream.append({ index, note: "audit-fixture" });
    }
    const realSegments = await stream.listSegments();
    const expectedBytes = realSegments.reduce(
      (sum, segment) => sum + segment.byteLength,
      0,
    );

    const outcome = await runCleanup({
      env: buildEnv({ M3L_CONSOLE_AUDIT_ROOT: auditRoot }),
      openStore,
      nowMs: () => FAR_FUTURE_MS,
    });

    expect(outcome.auditTrail).toEqual({
      segments: realSegments.length,
      totalBytes: expectedBytes,
    });
  });

  test("an audit-listing failure does not abort the sweep, and only auditTrail appears in context.failures", async () => {
    const { store, openStore } = makeMemoryStore();

    // The other three drivers get real data so their outcomes are
    // non-trivially testable, mirroring the telemetry-fails test above.
    await insertTerminalRun(store, "run-audit-fail", OLD_MS);
    await insertFinishedStep(
      store,
      "session-audit-fail",
      "step-audit-fail",
      OLD_MS,
    );
    insertTelemetry(store, 60_000);

    // Make ONLY the audit section fail: a plain FILE named "blocker" makes
    // readdir(auditRoot) fail ENOTDIR, since auditRoot names a path
    // component underneath a non-directory.
    const blockerPath = join(auditRoot, "blocker");
    await writeFile(blockerPath, "not a directory");
    const brokenAuditRoot = join(blockerPath, "sub");

    let thrown: M3LConsoleError | undefined;
    try {
      await runCleanup({
        env: buildEnv({ M3L_CONSOLE_AUDIT_ROOT: brokenAuditRoot }),
        openStore,
        nowMs: () => FAR_FUTURE_MS,
      });
    } catch (e) {
      if (e instanceof M3LConsoleError) thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("ERR_CONSOLE_INTERNAL");

    const ctx = thrown?.context;
    expect(ctx).toBeDefined();
    expect(ctx).toHaveProperty("telemetry");
    expect(ctx).toHaveProperty("runOutputs");
    expect(ctx).toHaveProperty("sessionArtifacts");
    expect(ctx).not.toHaveProperty("auditTrail");

    const failures = ctx?.["failures"];
    expect(Array.isArray(failures)).toBe(true);
    expect((failures as unknown[]).length).toBe(1);
    expect((failures as Array<{ driver: string }>)[0]?.driver).toBe(
      "auditTrail",
    );

    // The run output dir and artifact file were still deleted even though
    // the audit driver failed — the other three drivers are unaffected.
    await expect(stat(join(runsRoot, "run-audit-fail"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(artifactRoot, "session-audit-fail", "step-audit-fail.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  // NOTE — regression lock, not yet proof: today `runCleanup` has no fourth
  // driver at all, so this passes vacuously (nothing touches `auditRoot`
  // regardless of what the assertions below check). It becomes a real proof
  // only once `auditTrail` is wired in; re-confirm it still passes THEN, and
  // mutation-test it by having the wiring delete segments to see it fail.
  test("the sweep does not delete audit segments", async () => {
    const { openStore } = makeMemoryStore();

    const stream = new Core.M3LAppendOnlyStream({
      directory: auditRoot,
      maxSegmentBytes: 200,
    });
    for (let index = 0; index < 3; index += 1) {
      await stream.append({ index, note: "must-survive-the-sweep" });
    }

    const beforeNames = (await readdir(auditRoot)).sort();
    const beforeSizes: number[] = [];
    for (const name of beforeNames) {
      const stats = await stat(join(auditRoot, name));
      beforeSizes.push(stats.size);
    }

    await runCleanup({
      env: buildEnv({ M3L_CONSOLE_AUDIT_ROOT: auditRoot }),
      openStore,
      nowMs: () => FAR_FUTURE_MS,
    });

    const afterNames = (await readdir(auditRoot)).sort();
    const afterSizes: number[] = [];
    for (const name of afterNames) {
      const stats = await stat(join(auditRoot, name));
      afterSizes.push(stats.size);
    }

    // The other three drivers delete; this one must not — a future change
    // that "harmonises" them across all four drivers has to fail here.
    expect(afterNames).toEqual(beforeNames);
    expect(afterSizes).toEqual(beforeSizes);
  });

  test("an audit root that has never been created does not fail the sweep", async () => {
    const { openStore } = makeMemoryStore();
    const neverCreatedAuditRoot = join(auditRoot, "never-created");

    const outcome = await runCleanup({
      env: buildEnv({ M3L_CONSOLE_AUDIT_ROOT: neverCreatedAuditRoot }),
      openStore,
      nowMs: () => FAR_FUTURE_MS,
    });

    expect(outcome.auditTrail).toEqual({ segments: 0, totalBytes: 0 });
  });
});
