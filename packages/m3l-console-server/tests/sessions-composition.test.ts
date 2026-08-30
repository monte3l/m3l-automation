/**
 * Tests for `src/sessions/composition.ts` — `createSessionSubsystem` (X6
 * workbench-sessions module, slice 4, Part B round 1, issue #554).
 *
 * RED: `../src/sessions/composition.ts` does not exist yet — every import
 * below is expected to fail to resolve until the implementer lands the
 * module.
 *
 * `createSessionSubsystem` is documented to build its own
 * {@link M3LSessionArtifactStore} internally via
 * `createSessionArtifactStore({ root: options.artifactRoot, config:
 * options.artifactCaps })` — the REAL factory, not a fake, since that
 * function performs no filesystem I/O by itself (root is created lazily,
 * only when a file-backed artifact is first written — see
 * `sessions/artifacts.ts`'s own TSDoc). None of the scenarios below ever
 * drive a `run.ended` event through to a real `put()` call, so no test here
 * touches the filesystem; `node:fs`/`node:fs/promises` are neither mocked
 * nor exercised.
 *
 * The `sessionsRepository`/`launcher` collaborators are hand-rolled,
 * Map-backed in-memory fakes mirroring `sessions-service.test.ts`'s own
 * idiom one layer down — this file's subject is composition wiring (does
 * `service` actually delegate to the injected collaborators, does
 * `eventSink` actually adapt `service.handleRunEvent` into a
 * never-throws-synchronously `publish`), not the service's own internal
 * behavior (already covered by `sessions-service.test.ts`).
 */
import { describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createSessionSubsystem } from "../src/sessions/composition.js";
import type {
  M3LSessionSubsystem,
  M3LSessionSubsystemOptions,
} from "../src/sessions/composition.js";
import type {
  M3LSessionLaunchRequest,
  M3LSessionRunEvent,
  M3LSessionRunHandle,
  M3LSessionRunLauncherPort,
} from "../src/sessions/ports.js";
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

// ---------------------------------------------------------------------------
// Fake M3LConsoleSessionsRepository — Map-backed, guarded-write semantics,
// mirroring sessions-service.test.ts's own fake one layer down. `throwOn`
// lets a single named method be swapped for one that throws synchronously,
// used to drive `handleRunEvent` into a rejection without ever reaching the
// artifact store.
// ---------------------------------------------------------------------------

interface FakeSessionsRepositoryOptions {
  readonly throwOnGetStepByRunId?: Error;
}

function createFakeSessionsRepository(
  options: FakeSessionsRepositoryOptions = {},
): M3LConsoleSessionsRepository {
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
      if (options.throwOnGetStepByRunId !== undefined) {
        throw options.throwOnGetStepByRunId;
      }
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
// Fake M3LSessionRunLauncherPort
// ---------------------------------------------------------------------------

function createFakeLauncher(): M3LSessionRunLauncherPort {
  let counter = 0;
  return {
    launch(request: M3LSessionLaunchRequest): M3LSessionRunHandle {
      const id = `run-${String(counter++)}`;
      return {
        id,
        scriptName: request.body.scriptName,
        status: "running",
        dryRun: request.body.dryRun,
        executionMode: "spawn",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// A real Core.M3LLogger backed by a handler that records every event and
// resolves a promise the first time one arrives — mirrors
// `handler.test.ts`'s `createResolvingLogger`, the established pattern for
// observing a fire-and-forget `.catch()`'s logged failure without a
// wall-clock sleep.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildOptions(
  overrides: Partial<M3LSessionSubsystemOptions> = {},
): M3LSessionSubsystemOptions {
  const { logger } = createResolvingLogger();
  return {
    sessionsRepository: createFakeSessionsRepository(),
    artifactRoot: "/var/lib/m3l/console/artifacts",
    artifactCaps: {
      artifactInlineMaxBytes: 65_536,
      artifactMaxBytes: 33_554_432,
      sessionTotalMaxBytes: 268_435_456,
    },
    openSessionsMax: 10,
    launcher: createFakeLauncher(),
    logger,
    newId: (() => {
      let counter = 0;
      return () => `id-${String(counter++)}`;
    })(),
    nowMs: () => 1_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createSessionSubsystem().service — delegates to the injected collaborators
// ---------------------------------------------------------------------------

describe("createSessionSubsystem — .service is a working M3LSessionService", () => {
  test("createSession delegates through to the injected sessionsRepository and returns a real session record", () => {
    const repository = createFakeSessionsRepository();
    const subsystem: M3LSessionSubsystem = createSessionSubsystem(
      buildOptions({ sessionsRepository: repository }),
    );

    const record = subsystem.service.createSession("alice", "corr-1");

    expect(record.status).toBe("open");
    expect(record.operator).toBe("alice");
    expect(repository.getSession(record.id)).toEqual(record);
  });

  test("addStep delegates through to the injected launcher, constructing the artifact store from artifactRoot/artifactCaps", async () => {
    const launcher = createFakeLauncher();
    const subsystem = createSessionSubsystem(
      buildOptions({ launcher, openSessionsMax: 10 }),
    );
    const session = subsystem.service.createSession("alice", "corr-1");

    const result = await subsystem.service.addStep(session.id, {
      operation: "scripts/example",
      bindings: [],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(result.handle.scriptName).toBe("scripts/example");
    expect(result.step.runId).toBe(result.handle.id);
  });

  test("openSessionsMax reaches the constructed service: a second session beyond the cap throws ERR_CONSOLE_SESSION_LIMIT_EXCEEDED", () => {
    const subsystem = createSessionSubsystem(
      buildOptions({ openSessionsMax: 1 }),
    );
    subsystem.service.createSession("alice", "corr-1");

    let thrown: unknown;
    try {
      subsystem.service.createSession("bob", "corr-2");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED",
    });
  });
});

// ---------------------------------------------------------------------------
// createSessionSubsystem().eventSink — the fire-and-forget adapter
// ---------------------------------------------------------------------------

describe("createSessionSubsystem — .eventSink adapts service.handleRunEvent into a never-throws publish", () => {
  test("publish() returns undefined synchronously (not a Promise), even though service.handleRunEvent is async", () => {
    const subsystem = createSessionSubsystem(buildOptions());
    const event: M3LSessionRunEvent = {
      event: "run.queued",
      runId: "run-unrelated",
      scriptName: "scripts/example",
      dryRun: false,
    };

    const returned = subsystem.eventSink.publish(event);

    expect(returned).toBeUndefined();
  });

  test("does not call logger.error for a benign event (run.queued for an unrelated run)", async () => {
    const { logger, events } = createResolvingLogger();
    const subsystem = createSessionSubsystem(buildOptions({ logger }));

    subsystem.eventSink.publish({
      event: "run.queued",
      runId: "run-unrelated",
      scriptName: "scripts/example",
      dryRun: false,
    });

    // Flush any pending microtasks the underlying handleRunEvent() promise
    // may still need to settle on, without a wall-clock sleep.
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveLength(0);
  });

  test("a rejecting handleRunEvent is caught and routed to logger.error, never surfacing as an unhandled rejection", async () => {
    const { logger, events, logged } = createResolvingLogger();
    const lookupFailure = new Error("getStepByRunId exploded");
    const repository = createFakeSessionsRepository({
      throwOnGetStepByRunId: lookupFailure,
    });
    const subsystem = createSessionSubsystem(
      buildOptions({ sessionsRepository: repository, logger }),
    );

    const returned = subsystem.eventSink.publish({
      event: "run.started",
      runId: "run-doomed",
      atMs: 5_000,
    });

    expect(returned).toBeUndefined();

    await logged;

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(Core.M3LLogEventCategory.ERROR);
  });
});

// ---------------------------------------------------------------------------
// M3LSessionSubsystemOptions / M3LSessionSubsystem — exact field shapes
// ---------------------------------------------------------------------------

describe("M3LSessionSubsystemOptions / M3LSessionSubsystem", () => {
  test("createSessionSubsystem accepts every documented option field", () => {
    // A type-level smoke check: this compiles only once every field in the
    // contract's sketch exists with the documented type. `vi.fn()` stands
    // in for the two injected functions purely to keep this declaration
    // self-contained.
    const options: M3LSessionSubsystemOptions = {
      sessionsRepository: createFakeSessionsRepository(),
      artifactRoot: "/tmp/artifacts",
      artifactCaps: {
        artifactInlineMaxBytes: 1,
        artifactMaxBytes: 2,
        sessionTotalMaxBytes: 3,
      },
      openSessionsMax: 1,
      launcher: createFakeLauncher(),
      logger: new Core.M3LLogger([]),
      newId: vi.fn(() => "id"),
      nowMs: vi.fn(() => 0),
    };

    const subsystem = createSessionSubsystem(options);

    expect(typeof subsystem.service.createSession).toBe("function");
    expect(typeof subsystem.eventSink.publish).toBe("function");
  });
});
