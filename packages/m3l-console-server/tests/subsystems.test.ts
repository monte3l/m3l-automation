/**
 * Tests for `src/subsystems.ts` — `buildConsoleSubsystems` (X6
 * workbench-sessions module, slice 4, Part B round 3, issue #554): the
 * zone-free composition step `main.ts` delegates to once its own file
 * budget has no headroom left, extracted from `main.ts`'s existing
 * `buildRunSubsystem`/`RUNS_SCRIPTS_DIR_ENV` plus a brand-new sessions half.
 *
 * Every "runs subsystem" behavior here is a RELOCATION of coverage that used
 * to live in `tests/main-runs.test.ts` against `main.ts`'s own
 * `buildRunSubsystem` — the assertions are the same, only the call site
 * moves. The "sessions subsystem" and "forwarding sink" behaviors are new to
 * this round.
 *
 * RED: `../src/subsystems.ts` does not exist yet — every import below is
 * expected to fail to resolve until the implementer lands the module.
 *
 * Mocking mirrors `tests/runs-composition.test.ts`: `node:fs`'s
 * `existsSync` (script resolution) and `node:child_process`'s `spawn` (so a
 * "running" launch never touches a real process) are mocked via the
 * async-factory form that preserves every other real export. No real
 * filesystem or network I/O anywhere in this file — `sessions/artifacts.ts`'s
 * `createSessionArtifactStore` performs no I/O at construction (only its
 * `put`/`readArtifact` methods touch disk, neither of which any test here
 * calls into on a code path that would actually reach the filesystem: the
 * one test that drives a `run.ended` event deliberately overflows the
 * configured byte cap, which `assertWithinCaps` rejects strictly before any
 * `mkdir`/`writeFile` call).
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { buildConsoleSubsystems } from "../src/subsystems.js";
import type {
  M3LConsoleSubsystems,
  M3LConsoleSubsystemsOptions,
} from "../src/subsystems.js";
import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import type { M3LConsoleSessionsConfig } from "../src/config/sessions.js";
import type { M3LRunSubsystem } from "../src/runs/composition.js";
import type { M3LRunRegistry } from "../src/runs/registry.js";
import type { M3LSessionSubsystem } from "../src/sessions/composition.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingInsert,
  M3LSessionBindingRecord,
  M3LSessionDecisionAnswer,
  M3LSessionDecisionInsert,
  M3LSessionDecisionRecord,
  M3LSessionInsert,
  M3LSessionListQuery,
  M3LSessionRecord,
  M3LSessionStepFinish,
  M3LSessionStepInsert,
  M3LSessionStepRecord,
} from "../src/store/sessions-repository.js";
import type {
  M3LRunFinish,
  M3LRunInsert,
  M3LRunListQuery,
  M3LRunRecord,
} from "../src/store/runs-repository.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof childProcess>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(childProcess.spawn).mockReset();
});

// ---------------------------------------------------------------------------
// Shared fixtures / helpers
// ---------------------------------------------------------------------------

/** A minimal valid env: only the required operator name set — deliberately no `M3L_CONSOLE_RUNS_SCRIPTS_DIR`. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    ...overrides,
  };
}

/** A minimal resolved runs config, used as the `runsConfig` test seam to skip `loadRunsConfig`. */
const MINIMAL_RUNS_CONFIG: M3LConsoleRunsConfig = {
  scriptsDir: "/scripts",
  maxPerScript: 4,
  queueCapacity: 16,
  streamRetention: 256,
  killTimeoutMs: 5000,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
};

/** A minimal resolved sessions config, mirroring `config/sessions.ts`'s own documented defaults. */
const MINIMAL_SESSIONS_CONFIG: M3LConsoleSessionsConfig = {
  artifactInlineMaxBytes: 65_536,
  artifactMaxBytes: 33_554_432,
  sessionTotalMaxBytes: 268_435_456,
  openSessionsMax: 32,
};

/** A recording `M3LLoggerHandler` fake — the sanctioned test-double pattern. */
class RecordingHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];

  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/**
 * A real `Core.M3LLogger` backed by a handler that records every event and
 * resolves a promise the first time one arrives — mirrors
 * `tests/sessions-composition.test.ts`'s own `createResolvingLogger`, the
 * established pattern for observing a fire-and-forget `.catch()`'s logged
 * failure without a wall-clock sleep.
 */
function createResolvingLogger(): {
  readonly logger: Core.M3LLogger;
  readonly events: Core.M3LLogEvent[];
  readonly logged: Promise<void>;
} {
  const events: Core.M3LLogEvent[] = [];
  let resolveLogged: () => void = () => undefined;
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve;
  });
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
      resolveLogged();
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { logger: new Core.M3LLogger([handler]), events, logged };
}

/**
 * A `Map`-backed fake {@link M3LRunRegistry}: real enough to drive the
 * orchestrator through insert -> claim -> finish -> reconcile — duplicated
 * from `tests/runs-composition.test.ts` per `.claude/rules/tests.md` (small
 * helpers are not shared across test files).
 */
function createFakeRunRegistry(): M3LRunRegistry {
  const rows = new Map<string, M3LRunRecord>();
  return {
    insertQueued(input: M3LRunInsert): void {
      rows.set(input.id, {
        id: input.id,
        script: input.script,
        status: "queued",
        dryRun: input.dryRun,
        executionMode: input.executionMode,
        parameters: input.parameters,
        operator: input.operator,
        correlationId: input.correlationId,
        queuedAtMs: input.queuedAtMs,
        startedAtMs: undefined,
        endedAtMs: undefined,
        outcome: undefined,
        exitCode: undefined,
        failureMessage: undefined,
      });
    },
    claimForStart(id: string, startedAtMs: number): boolean {
      const row = rows.get(id);
      if (row === undefined || row.status !== "queued") return false;
      rows.set(id, { ...row, status: "running", startedAtMs });
      return true;
    },
    finish(id: string, result: M3LRunFinish): boolean {
      const row = rows.get(id);
      if (row === undefined || row.status !== "running") return false;
      rows.set(id, {
        ...row,
        status: result.outcome,
        outcome: result.outcome,
        endedAtMs: result.endedAtMs,
        exitCode: result.exitCode,
        failureMessage: result.failureMessage,
      });
      return true;
    },
    get(id: string): M3LRunRecord | undefined {
      return rows.get(id);
    },
    list(query: M3LRunListQuery): readonly M3LRunRecord[] {
      let result = [...rows.values()];
      if (query.status !== undefined) {
        result = result.filter((row) => row.status === query.status);
      }
      if (query.script !== undefined) {
        result = result.filter((row) => row.script === query.script);
      }
      result.sort((left, right) => left.queuedAtMs - right.queuedAtMs);
      return result.slice(0, query.limit);
    },
    countRunningForScript(script: string): number {
      return [...rows.values()].filter(
        (row) => row.status === "running" && row.script === script,
      ).length;
    },
    reconcileOrphaned(endedAtMs: number): number {
      let count = 0;
      for (const [id, row] of rows) {
        if (row.status === "queued" || row.status === "running") {
          rows.set(id, {
            ...row,
            status: "interrupted",
            outcome: "interrupted",
            endedAtMs,
          });
          count += 1;
        }
      }
      return count;
    },
    abandonQueued(id: string, endedAtMs: number): boolean {
      const row = rows.get(id);
      if (row === undefined || row.status !== "queued") return false;
      rows.set(id, {
        ...row,
        status: "interrupted",
        outcome: "interrupted",
        endedAtMs,
      });
      return true;
    },
  };
}

/** Builds a dry-run launch request for `scriptName` — bypasses the confirmation policy entirely. */
function buildDryRunRequest(scriptName: string): {
  readonly body: {
    readonly scriptName: string;
    readonly confirmed: boolean;
    readonly dryRun: boolean;
    readonly parameters: Readonly<Record<string, string>>;
  };
  readonly operator: string;
  readonly correlationId: string;
} {
  return {
    body: { scriptName, confirmed: false, dryRun: true, parameters: {} },
    operator: "ada",
    correlationId: "corr-1",
  };
}

/**
 * Configures `fs.existsSync` so `resolveScript` succeeds for any kebab-case
 * name under the configured scripts root with no `dist/command.js` — i.e.
 * every launch below runs the SPAWN executor, the one whose underlying
 * `spawn` call is mocked, never the in-process one. Also stubs
 * `fs.lstatSync` to report a plain (non-symlink) directory entry —
 * `resolveScript`'s symlink containment guard fails CLOSED when a path
 * cannot be stat'd, and the fictional scripts root used throughout this
 * file does not exist on the real filesystem (mirrors
 * `runs-resolver.test.ts`'s `mockLstatSyncNotSymlink`). Duplicated from
 * `tests/runs-composition.test.ts`.
 */
function mockScriptResolvable(): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) => !String(target).endsWith("command.js"),
  );
  vi.spyOn(fs, "lstatSync").mockImplementation((() => ({
    isSymbolicLink: () => false,
  })) as unknown as typeof fs.lstatSync);
}

/** A listener a fake spawned process's `once()` may be given. */
type FakeOnceListener = (...args: readonly unknown[]) => void;

/** The narrow shape `createSpawnExecutor`'s `spawn` seam is cast down to. */
interface FakeSpawnedProcess {
  readonly stdout: null;
  readonly stderr: null;
  kill(signal?: string): boolean;
  once(event: string, listener: FakeOnceListener): unknown;
}

/**
 * A fake spawned process that never exits on its own: `kill()` records the
 * signal it was sent, then asynchronously reports the process as closed with
 * exit code `0`. Duplicated from `tests/runs-composition.test.ts`.
 */
function createHangingSpawnedProcess(): {
  readonly childHandle: FakeSpawnedProcess;
} {
  let closeListener:
    ((code: number | null, signal: string | null) => void) | undefined;

  const childHandle: FakeSpawnedProcess = {
    stdout: null,
    stderr: null,
    kill(): boolean {
      queueMicrotask(() => {
        closeListener?.(0, null);
      });
      return true;
    },
    once(event: string, listener: FakeOnceListener): unknown {
      if (event === "close") {
        closeListener = listener;
      }
      return childHandle;
    },
  };

  return { childHandle };
}

/** Wires the mocked `node:child_process` `spawn` to return `childHandle` for every call. */
function mockSpawnReturns(childHandle: FakeSpawnedProcess): void {
  vi.mocked(childProcess.spawn).mockImplementation(
    (() => childHandle) as unknown as typeof childProcess.spawn,
  );
}

/**
 * A full `Map`-backed fake {@link M3LConsoleSessionsRepository}, duplicated
 * from `tests/sessions-composition.test.ts` per `.claude/rules/tests.md`.
 */
function createFakeSessionsRepository(): M3LConsoleSessionsRepository {
  const sessions = new Map<string, M3LSessionRecord>();
  const steps = new Map<string, M3LSessionStepRecord>();
  const bindings = new Map<string, M3LSessionBindingRecord>();
  const decisions = new Map<string, M3LSessionDecisionRecord>();
  const stepIdByRunId = new Map<string, string>();

  return {
    insertSession(input: M3LSessionInsert): void {
      sessions.set(input.id, {
        id: input.id,
        status: "open",
        operator: input.operator,
        correlationId: input.correlationId,
        createdAtMs: input.createdAtMs,
        updatedAtMs: input.createdAtMs,
      });
    },
    getSession(id: string): M3LSessionRecord | undefined {
      return sessions.get(id);
    },
    listSessions(query: M3LSessionListQuery): readonly M3LSessionRecord[] {
      const filtered = [...sessions.values()]
        .filter(
          (row) => query.status === undefined || row.status === query.status,
        )
        .filter(
          (row) =>
            query.operator === undefined || row.operator === query.operator,
        )
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
      return filtered.slice(0, query.limit);
    },
    closeSession(id: string, closedAtMs: number): boolean {
      const row = sessions.get(id);
      if (row === undefined || row.status !== "open") return false;
      sessions.set(id, {
        id: row.id,
        status: "closed",
        operator: row.operator,
        correlationId: row.correlationId,
        createdAtMs: row.createdAtMs,
        updatedAtMs: closedAtMs,
        closedAtMs,
      });
      return true;
    },
    reopenSession(id: string, updatedAtMs: number): boolean {
      const row = sessions.get(id);
      if (row === undefined || row.status !== "closed") return false;
      sessions.set(id, {
        id: row.id,
        status: "open",
        operator: row.operator,
        correlationId: row.correlationId,
        createdAtMs: row.createdAtMs,
        updatedAtMs,
      });
      return true;
    },
    countOpenSessions(): number {
      return [...sessions.values()].filter((row) => row.status === "open")
        .length;
    },
    insertStep(input: M3LSessionStepInsert): void {
      steps.set(input.id, {
        id: input.id,
        sessionId: input.sessionId,
        ordinal: input.ordinal,
        operation: input.operation,
        parameters: input.parameters,
        runId: undefined,
        status: "queued",
        resultRef: undefined,
        queuedAtMs: input.queuedAtMs,
        startedAtMs: undefined,
        endedAtMs: undefined,
        outcome: undefined,
        failureMessage: undefined,
      });
    },
    claimStepForStart(id: string, startedAtMs: number): boolean {
      const row = steps.get(id);
      if (row === undefined || row.status !== "queued") return false;
      steps.set(id, { ...row, status: "running", startedAtMs });
      return true;
    },
    finishStep(id: string, result: M3LSessionStepFinish): boolean {
      const row = steps.get(id);
      if (row === undefined || row.status !== "running") return false;
      steps.set(id, {
        ...row,
        status: result.outcome,
        outcome: result.outcome,
        endedAtMs: result.endedAtMs,
        resultRef: result.resultRef,
        failureMessage: result.failureMessage,
      });
      return true;
    },
    getStep(id: string): M3LSessionStepRecord | undefined {
      return steps.get(id);
    },
    getStepByOrdinal(
      sessionId: string,
      ordinal: number,
    ): M3LSessionStepRecord | undefined {
      return [...steps.values()].find(
        (row) => row.sessionId === sessionId && row.ordinal === ordinal,
      );
    },
    listStepsForSession(sessionId: string): readonly M3LSessionStepRecord[] {
      return [...steps.values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => a.ordinal - b.ordinal);
    },
    attachStepRun(id: string, runId: string): boolean {
      const row = steps.get(id);
      if (row === undefined || row.runId !== undefined) return false;
      steps.set(id, { ...row, runId });
      stepIdByRunId.set(runId, id);
      return true;
    },
    getStepByRunId(runId: string): M3LSessionStepRecord | undefined {
      const stepId = stepIdByRunId.get(runId);
      return stepId === undefined ? undefined : steps.get(stepId);
    },
    insertBinding(input: M3LSessionBindingInsert): void {
      bindings.set(input.id, { ...input });
    },
    listBindingsForSession(
      sessionId: string,
    ): readonly M3LSessionBindingRecord[] {
      return [...bindings.values()].filter(
        (row) => row.sessionId === sessionId,
      );
    },
    insertDecision(input: M3LSessionDecisionInsert): void {
      decisions.set(input.id, {
        id: input.id,
        sessionId: input.sessionId,
        stepId: input.stepId,
        prompt: input.prompt,
        options: input.options,
        status: "pending",
        createdAtMs: input.createdAtMs,
      });
    },
    answerDecision(id: string, answer: M3LSessionDecisionAnswer): boolean {
      const row = decisions.get(id);
      if (row === undefined || row.status !== "pending") return false;
      decisions.set(id, {
        id: row.id,
        sessionId: row.sessionId,
        stepId: row.stepId,
        prompt: row.prompt,
        options: row.options,
        status: "answered",
        answer: answer.answer,
        answeredAtMs: answer.answeredAtMs,
        createdAtMs: row.createdAtMs,
      });
      return true;
    },
    getDecision(id: string): M3LSessionDecisionRecord | undefined {
      return decisions.get(id);
    },
    listDecisionsForSession(
      sessionId: string,
    ): readonly M3LSessionDecisionRecord[] {
      return [...decisions.values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Runs subsystem behavior — relocated from `tests/main-runs.test.ts`'s
// `buildRunSubsystem` coverage.
// ---------------------------------------------------------------------------

describe("buildConsoleSubsystems — runs subsystem, relocated buildRunSubsystem behavior", () => {
  test("a resolvable runs config with options.runs supplied builds a real M3LRunSubsystem", () => {
    const registry = createFakeRunRegistry();

    const subsystems = buildConsoleSubsystems(
      { env: buildEnv(), runsConfig: MINIMAL_RUNS_CONFIG, runs: registry },
      new Core.M3LLogger([]),
    );

    expect(subsystems.runs).not.toBeUndefined();
    expect(typeof subsystems.runs?.orchestrator.launch).toBe("function");
    expect(typeof subsystems.runs?.drain).toBe("function");
  });

  test("options.runs undefined -> no runs subsystem, and no sessions subsystem either (even when options.sessions is supplied)", () => {
    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        sessions: createFakeSessionsRepository(),
        sessionsConfig: MINIMAL_SESSIONS_CONFIG,
      },
      new Core.M3LLogger([]),
    );

    expect(subsystems.runs).toBeUndefined();
    expect(subsystems.sessions).toBeUndefined();
  });

  test("an unresolvable runs config (M3L_CONSOLE_RUNS_SCRIPTS_DIR unset) -> undefined runs subsystem and a warning posture line", () => {
    const handler = new RecordingHandler();
    const registry = createFakeRunRegistry();

    const subsystems = buildConsoleSubsystems(
      { env: buildEnv(), runs: registry },
      new Core.M3LLogger([handler]),
    );

    expect(subsystems.runs).toBeUndefined();
    const warnings = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    expect(warnings).toHaveLength(1);
    const rendered = JSON.stringify(warnings);
    expect(rendered).toContain("M3L_CONSOLE_RUNS_SCRIPTS_DIR");
    expect(rendered.toLowerCase()).toContain("disabled");
  });

  test("runsConfig resolves but options.runs is absent -> undefined runs subsystem", () => {
    const subsystems = buildConsoleSubsystems(
      { env: buildEnv(), runsConfig: MINIMAL_RUNS_CONFIG },
      new Core.M3LLogger([]),
    );

    expect(subsystems.runs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sessions subsystem construction
// ---------------------------------------------------------------------------

describe("buildConsoleSubsystems — sessions subsystem construction", () => {
  test("options.sessions + a successfully built runs subsystem -> sessions is a real M3LSessionSubsystem", () => {
    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: createFakeRunRegistry(),
        sessionsConfig: MINIMAL_SESSIONS_CONFIG,
        sessions: createFakeSessionsRepository(),
      },
      new Core.M3LLogger([]),
    );

    expect(subsystems.sessions).not.toBeUndefined();
    const record = subsystems.sessions?.service.createSession(
      "alice",
      "corr-1",
    );
    expect(record?.status).toBe("open");
    expect(record?.operator).toBe("alice");
  });

  test("options.sessionsConfig, when supplied, is used verbatim — its openSessionsMax reaches the constructed service", () => {
    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: createFakeRunRegistry(),
        sessionsConfig: { ...MINIMAL_SESSIONS_CONFIG, openSessionsMax: 1 },
        sessions: createFakeSessionsRepository(),
      },
      new Core.M3LLogger([]),
    );
    const sessions = subsystems.sessions;
    if (sessions === undefined) {
      throw new Error("test setup: the sessions subsystem must be present");
    }

    sessions.service.createSession("alice", "corr-1");

    let thrown: unknown;
    try {
      sessions.service.createSession("bob", "corr-2");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED",
    });
  });

  test("sessionsConfig omitted -> loadSessionsConfig({ env }) is used — an env override reaches the constructed service", () => {
    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv({ M3L_CONSOLE_SESSIONS_OPEN_MAX: "1" }),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: createFakeRunRegistry(),
        sessions: createFakeSessionsRepository(),
      },
      new Core.M3LLogger([]),
    );
    const sessions = subsystems.sessions;
    if (sessions === undefined) {
      throw new Error("test setup: the sessions subsystem must be present");
    }

    sessions.service.createSession("alice", "corr-1");

    let thrown: unknown;
    try {
      sessions.service.createSession("bob", "corr-2");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED",
    });
  });

  test("artifactCaps is built from the resolved sessions config's three byte-cap fields", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const repository = createFakeSessionsRepository();

    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: createFakeRunRegistry(),
        sessionsConfig: {
          artifactInlineMaxBytes: 1,
          artifactMaxBytes: 2,
          sessionTotalMaxBytes: 2,
          openSessionsMax: 10,
        },
        sessions: repository,
      },
      logger,
    );
    const sessions = subsystems.sessions;
    if (sessions === undefined) {
      throw new Error("test setup: the sessions subsystem must be present");
    }

    const session = sessions.service.createSession("alice", "corr-1");
    repository.insertStep({
      id: "step-1",
      sessionId: session.id,
      ordinal: 1,
      operation: "sqs-etl",
      parameters: {},
      queuedAtMs: 0,
    });
    repository.claimStepForStart("step-1", 500);
    repository.attachStepRun("step-1", "run-1");

    // A run.ended payload whose JSON-serialized size (well over the 2-byte
    // cap configured above) is rejected by `assertWithinCaps` strictly
    // before any filesystem write — see this file's header comment.
    sessions.eventSink.publish({
      event: "run.ended",
      runId: "run-1",
      outcome: "success",
      exitCode: 0,
    });

    await logged;

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.ERROR);
    // `M3LLogger.error`'s `data` is redacted before any handler sees it
    // (`redactSensitiveLogValue`/`isRedactableRecord`), which rebuilds an
    // ordinary class instance — an `M3LConsoleError` included — into a
    // plain-object clone of its own-enumerable fields. The logged `cause` is
    // therefore never `instanceof M3LConsoleError`; assert its `code` field
    // instead, which redaction carries through unchanged.
    const cause = events[0]?.data?.["cause"];
    expect(cause).toMatchObject({
      code: "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
    });
  });
});

describe("buildConsoleSubsystems — session artifact root resolution", () => {
  test("a configured M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT reaches the constructed subsystem without throwing", () => {
    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv({
          M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT: "custom/artifacts",
        }),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: createFakeRunRegistry(),
        sessionsConfig: MINIMAL_SESSIONS_CONFIG,
        sessions: createFakeSessionsRepository(),
      },
      new Core.M3LLogger([]),
    );

    expect(subsystems.sessions).not.toBeUndefined();
    expect(() =>
      subsystems.sessions?.service.createSession("alice", "corr-1"),
    ).not.toThrow();
  });

  test("an absent M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT falls back to the default data-dir-relative root without throwing", () => {
    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: createFakeRunRegistry(),
        sessionsConfig: MINIMAL_SESSIONS_CONFIG,
        sessions: createFakeSessionsRepository(),
      },
      new Core.M3LLogger([]),
    );

    expect(subsystems.sessions).not.toBeUndefined();
    expect(() =>
      subsystems.sessions?.service.createSession("alice", "corr-1"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sessions disabled when the run launcher is unavailable
// ---------------------------------------------------------------------------

describe("buildConsoleSubsystems — sessions disabled when the run launcher is unavailable", () => {
  test("options.sessions supplied, options.runs undefined -> sessions undefined, with a warning explaining why", () => {
    const handler = new RecordingHandler();

    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        sessions: createFakeSessionsRepository(),
        sessionsConfig: MINIMAL_SESSIONS_CONFIG,
      },
      new Core.M3LLogger([handler]),
    );

    expect(subsystems.sessions).toBeUndefined();
    const warnings = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const rendered = JSON.stringify(warnings).toLowerCase();
    expect(rendered).toContain("session");
    expect(rendered).toContain("disabled");
  });

  test("options.sessions supplied, options.runs supplied but the runs config fails to resolve -> sessions undefined, with a warning", () => {
    const handler = new RecordingHandler();
    const registry = createFakeRunRegistry();

    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        runs: registry,
        sessions: createFakeSessionsRepository(),
        sessionsConfig: MINIMAL_SESSIONS_CONFIG,
      },
      new Core.M3LLogger([handler]),
    );

    expect(subsystems.runs).toBeUndefined();
    expect(subsystems.sessions).toBeUndefined();
    const warnings = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    // One warning for the disabled run subsystem, one for the sessions
    // subsystem it could not build a launcher for.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const rendered = JSON.stringify(warnings).toLowerCase();
    expect(rendered).toContain("session");
  });

  test("options.sessions === undefined -> sessions undefined, with no warning, regardless of runs", () => {
    const handler = new RecordingHandler();
    const registry = createFakeRunRegistry();

    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: registry,
      },
      new Core.M3LLogger([handler]),
    );

    expect(subsystems.sessions).toBeUndefined();
    const warnings = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The forwarding-sink wiring — the critical circular-dependency-breaking
// behavior described in the round brief: a local mutable-closure sink is
// passed into `createRunSubsystem`'s `extraEventSinks` BEFORE the session
// subsystem exists, and its target is set to the real `session.eventSink`
// once the session subsystem is built. This test proves the wiring actually
// connects — not merely that both subsystems construct independently.
// ---------------------------------------------------------------------------

describe("buildConsoleSubsystems — the forwarding sink connects runs' event stream to the session service", () => {
  test("a run.started event published through the real orchestrator reaches session.handleRunEvent's side effects", () => {
    mockScriptResolvable();
    const { childHandle } = createHangingSpawnedProcess();
    mockSpawnReturns(childHandle);

    const fixedStep: M3LSessionStepRecord = {
      id: "step-fixed",
      sessionId: "session-fixed",
      ordinal: 1,
      operation: "sqs-etl",
      parameters: {},
      runId: undefined,
      status: "queued",
      resultRef: undefined,
      queuedAtMs: 0,
      startedAtMs: undefined,
      endedAtMs: undefined,
      outcome: undefined,
      failureMessage: undefined,
    };
    const claimStepForStart = vi.fn(() => true);
    // Returns `fixedStep` regardless of the runId argument — this test's
    // subject is whether the wiring reaches `handleRunEvent` at all, not
    // whether `getStepByRunId`'s own runId-correlation logic is correct
    // (already covered by `tests/sessions-composition.test.ts` and
    // `sessions-service.test.ts` one layer down). The real orchestrator
    // generates the run's id internally with no injectable seam reachable
    // through `createRunSubsystem`, so it cannot be known ahead of the
    // synchronous `launch()` call below.
    const getStepByRunId = vi.fn(() => fixedStep);
    const attachStepRun = vi.fn(() => true);
    const unexpectedCall = (): never => {
      throw new Error(
        "unexpected call on forwarding-probe sessions repository",
      );
    };
    const probeRepository: M3LConsoleSessionsRepository = {
      insertSession: unexpectedCall,
      getSession: unexpectedCall,
      listSessions: unexpectedCall,
      closeSession: unexpectedCall,
      reopenSession: unexpectedCall,
      insertStep: unexpectedCall,
      claimStepForStart,
      finishStep: unexpectedCall,
      getStep: unexpectedCall,
      getStepByOrdinal: unexpectedCall,
      listStepsForSession: unexpectedCall,
      insertBinding: unexpectedCall,
      listBindingsForSession: unexpectedCall,
      insertDecision: unexpectedCall,
      answerDecision: unexpectedCall,
      getDecision: unexpectedCall,
      listDecisionsForSession: unexpectedCall,
      countOpenSessions: unexpectedCall,
      attachStepRun,
      getStepByRunId,
    };

    const subsystems = buildConsoleSubsystems(
      {
        env: buildEnv(),
        runsConfig: MINIMAL_RUNS_CONFIG,
        runs: createFakeRunRegistry(),
        sessionsConfig: MINIMAL_SESSIONS_CONFIG,
        sessions: probeRepository,
      },
      new Core.M3LLogger([]),
    );
    if (subsystems.runs === undefined || subsystems.sessions === undefined) {
      throw new Error("test setup: both subsystems must be present");
    }

    // `run.started` is published SYNCHRONOUSLY inside `launch()` (proven by
    // `tests/runs-composition.test.ts`'s own `extraEventSinks` coverage), so
    // by the time this call returns, the forwarding sink has already fanned
    // the event through to the session's real `handleRunEvent`.
    subsystems.runs.orchestrator.launch(buildDryRunRequest("sqs-etl"));

    expect(getStepByRunId).toHaveBeenCalled();
    expect(claimStepForStart).toHaveBeenCalledWith(
      fixedStep.id,
      expect.any(Number),
    );
  });
});

// ---------------------------------------------------------------------------
// M3LConsoleSubsystemsOptions / M3LConsoleSubsystems — exact field shapes
// ---------------------------------------------------------------------------

describe("M3LConsoleSubsystemsOptions / M3LConsoleSubsystems", () => {
  test("have the exact field shapes the contract declares", () => {
    expectTypeOf<M3LConsoleSubsystemsOptions>().toEqualTypeOf<{
      readonly env?: NodeJS.ProcessEnv;
      readonly runs?: M3LRunRegistry;
      readonly runsConfig?: M3LConsoleRunsConfig;
      readonly sessions?: M3LConsoleSessionsRepository;
      readonly sessionsConfig?: M3LConsoleSessionsConfig;
    }>();

    expectTypeOf<M3LConsoleSubsystems>().toEqualTypeOf<{
      readonly runs?: M3LRunSubsystem;
      readonly sessions?: M3LSessionSubsystem;
    }>();

    expectTypeOf<typeof buildConsoleSubsystems>().toEqualTypeOf<
      (
        options: M3LConsoleSubsystemsOptions,
        logger: Core.M3LLogger,
      ) => M3LConsoleSubsystems
    >();
  });
});
