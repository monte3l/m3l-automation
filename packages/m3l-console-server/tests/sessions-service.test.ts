/**
 * Tests for `src/sessions/service.ts` — `createSessionService`, the X6
 * workbench-sessions domain service (slice 4, Part A, issue #554).
 *
 * NEITHER `src/sessions/service.ts` NOR `src/sessions/ports.ts` exist yet
 * (RED): every import from either module is expected to fail to resolve
 * until the implementer lands both.
 *
 * **Discrepancy flagged against the dispatching brief:** the brief's sketch
 * declares `addStep` and `handleRunEvent` as SYNCHRONOUS
 * (`addStep(...): { step, handle }`, `handleRunEvent(event): void`). That
 * cannot be correct against the real collaborators this service is
 * documented to depend on: `addStep` must resolve a binding's reference
 * against a PRIOR step's recorded artifact output via
 * `M3LSessionArtifactStore.readArtifact`, and `handleRunEvent`'s `run.ended`
 * branch must persist the finishing step's payload via
 * `M3LSessionArtifactStore.put` — both real methods (verified directly
 * against `src/sessions/artifacts.ts`) return `Promise<...>`, not a bare
 * value. A synchronous `addStep`/`handleRunEvent` could not `await` either
 * call. This file therefore tests the CORRECT behavior — both methods
 * return a `Promise` — rather than codifying the brief's sketch verbatim;
 * flagged here for the hub/code-implementer rather than silently guessed.
 * (An async `handleRunEvent` is still compatible with
 * `runs/events.ts`'s `M3LRunEventSink.publish` "never throws" contract: the
 * composition-root sink adapter that wraps this service — Part B,
 * `sessions/composition.ts` — is documented as the layer responsible for
 * catching and logging, and can call `handleRunEvent` fire-and-forget with
 * its own `.catch()`.)
 *
 * **Guessed export name:** the brief names `CreateSessionServiceOptions` and
 * `M3LSessionService` but never the factory function itself. Following this
 * package's `create<Noun>` convention (`createConsoleSessionsRepository`,
 * `createSessionArtifactStore`, `createRunOrchestrator`), this file imports
 * `createSessionService` — flagged in case the implementer's choice differs.
 *
 * Every collaborator (`M3LConsoleSessionsRepository`, `M3LSessionArtifactStore`,
 * `M3LSessionRunLauncherPort`) is a hand-rolled, Map-backed in-memory fake —
 * no real SQLite, no real filesystem I/O — mirroring
 * `runs-orchestrator.test.ts`'s own fake-collaborator idiom (a shared `log`
 * array recording every guarded-write call, so "no write beyond the failed
 * lookup" assertions are provable, not merely "did not throw").
 */
import { describe, expect, test, vi } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { encodeArtifactRef } from "../src/sessions/artifacts.js";
import type {
  M3LSessionArtifactRef,
  M3LSessionArtifactStore,
} from "../src/sessions/artifacts.js";
import { createSessionService } from "../src/sessions/service.js";
import type {
  CreateSessionServiceOptions,
  M3LSessionService,
} from "../src/sessions/service.js";
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
import type { RunExecutionMode } from "../src/store/runs-repository.js";

// ---------------------------------------------------------------------------
// Fake M3LConsoleSessionsRepository — Map-backed, guarded-write semantics
// mirrored from the real store/sessions-repository.ts (including the two
// new methods this same task's Part A adds: attachStepRun/getStepByRunId).
// ---------------------------------------------------------------------------

/** The narrow slice of `M3LConsoleSessionsRepository` (plus the two new Part-A methods) this service depends on. */
interface FakeSessionsRepository extends M3LConsoleSessionsRepository {
  attachStepRun(id: string, runId: string): boolean;
  getStepByRunId(runId: string): M3LSessionStepRecord | undefined;
  readonly sessions: Map<string, M3LSessionRecord>;
  readonly steps: Map<string, M3LSessionStepRecord>;
}

function createFakeSessionsRepository(log: string[]): FakeSessionsRepository {
  const sessions = new Map<string, M3LSessionRecord>();
  const steps = new Map<string, M3LSessionStepRecord>();
  const bindings = new Map<string, M3LSessionBindingRecord>();
  const decisions = new Map<string, M3LSessionDecisionRecord>();
  const stepIdByRunId = new Map<string, string>();

  return {
    sessions,
    steps,
    insertSession(input: M3LSessionInsert): void {
      log.push(`insertSession:${input.id}`);
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
      log.push(`closeSession:${id}`);
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
      log.push(`reopenSession:${id}`);
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
      log.push(`insertStep:${input.id}`);
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
      log.push(`claimStepForStart:${id}`);
      const row = steps.get(id);
      if (row === undefined || row.status !== "queued") return false;
      steps.set(id, { ...row, status: "running", startedAtMs });
      return true;
    },
    finishStep(id: string, result: M3LSessionStepFinish): boolean {
      log.push(`finishStep:${id}`);
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
      log.push(`attachStepRun:${id}:${runId}`);
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
      log.push(`insertDecision:${input.id}`);
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
      log.push(`answerDecision:${id}`);
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

/** Seeds an open session directly (bypassing the service under test). */
function seedOpenSession(
  repository: FakeSessionsRepository,
  overrides: Partial<M3LSessionInsert> = {},
): string {
  const input: M3LSessionInsert = {
    id: "session-1",
    operator: "alice",
    correlationId: "corr-1",
    createdAtMs: 1_000,
    ...overrides,
  };
  repository.insertSession(input);
  return input.id;
}

/** Seeds a finished step at `ordinal` within `sessionId`, with an optional `resultRef`. */
function seedFinishedStep(
  repository: FakeSessionsRepository,
  options: {
    readonly id?: string;
    readonly sessionId: string;
    readonly ordinal: number;
    readonly resultRef?: string;
  },
): string {
  const id = options.id ?? `step-ordinal-${String(options.ordinal)}`;
  repository.insertStep({
    id,
    sessionId: options.sessionId,
    ordinal: options.ordinal,
    operation: "scripts/example",
    parameters: {},
    queuedAtMs: 1_000,
  });
  repository.claimStepForStart(id, 1_500);
  repository.finishStep(id, {
    outcome: "success",
    endedAtMs: 2_000,
    ...(options.resultRef !== undefined && { resultRef: options.resultRef }),
  });
  return id;
}

/** Seeds a still-running (unfinished) step at `ordinal` within `sessionId`. */
function seedRunningStep(
  repository: FakeSessionsRepository,
  options: {
    readonly id?: string;
    readonly sessionId: string;
    readonly ordinal: number;
  },
): string {
  const id = options.id ?? `step-ordinal-${String(options.ordinal)}`;
  repository.insertStep({
    id,
    sessionId: options.sessionId,
    ordinal: options.ordinal,
    operation: "scripts/example",
    parameters: {},
    queuedAtMs: 1_000,
  });
  repository.claimStepForStart(id, 1_500);
  return id;
}

// ---------------------------------------------------------------------------
// Fake M3LSessionArtifactStore — pure in-memory, no filesystem I/O
// ---------------------------------------------------------------------------

interface PutCall {
  readonly sessionId: string;
  readonly stepId: string;
  readonly payload: unknown;
  readonly currentSessionTotalBytes: number;
}

interface FakeArtifactStore extends M3LSessionArtifactStore {
  readonly putCalls: PutCall[];
  readonly fileArtifacts: Map<string, unknown>;
}

/** Default `put` behavior: always returns an inline ref carrying the payload verbatim (never touches "disk"). */
function createFakeArtifactStore(
  putResultFactory: (payload: unknown) => M3LSessionArtifactRef = (
    payload,
  ) => ({
    kind: "inline",
    value: payload,
  }),
): FakeArtifactStore {
  const putCalls: PutCall[] = [];
  const fileArtifacts = new Map<string, unknown>();
  return {
    putCalls,
    fileArtifacts,
    put(
      sessionId: string,
      stepId: string,
      payload: unknown,
      currentSessionTotalBytes: number,
    ): Promise<M3LSessionArtifactRef> {
      putCalls.push({ sessionId, stepId, payload, currentSessionTotalBytes });
      return Promise.resolve(putResultFactory(payload));
    },
    readArtifact(ref: M3LSessionArtifactRef): Promise<unknown> {
      if (ref.kind === "inline") return Promise.resolve(ref.value);
      const value = fileArtifacts.get(ref.path);
      if (value === undefined) {
        return Promise.reject(
          new Error(`no fake file artifact registered for path "${ref.path}"`),
        );
      }
      return Promise.resolve(value);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake M3LSessionRunLauncherPort
// ---------------------------------------------------------------------------

/** A minimal structural stand-in for `sessions/ports.ts`'s `M3LSessionLaunchRequest`, matched field for field. */
interface FakeLaunchRequest {
  readonly body: {
    readonly scriptName: string;
    readonly confirmed: boolean;
    readonly dryRun: boolean;
    readonly parameters: Readonly<Record<string, string>>;
  };
  readonly operator: string;
  readonly correlationId: string;
}

/** A minimal structural stand-in for `sessions/ports.ts`'s `M3LSessionRunHandle`. */
interface FakeRunHandle {
  readonly id: string;
  readonly scriptName: string;
  readonly status: "queued" | "running";
  readonly dryRun: boolean;
  readonly executionMode: RunExecutionMode;
}

interface FakeLauncher {
  readonly calls: FakeLaunchRequest[];
  launch(request: FakeLaunchRequest): FakeRunHandle;
}

function createFakeLauncher(
  buildHandle: (request: FakeLaunchRequest, index: number) => FakeRunHandle = (
    request,
    index,
  ) => ({
    id: `run-${String(index)}`,
    scriptName: request.body.scriptName,
    status: "running",
    dryRun: request.body.dryRun,
    executionMode: "spawn",
  }),
): FakeLauncher {
  const calls: FakeLaunchRequest[] = [];
  return {
    calls,
    launch(request: FakeLaunchRequest): FakeRunHandle {
      const handle = buildHandle(request, calls.length);
      calls.push(request);
      return handle;
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

interface TestHarness {
  readonly service: M3LSessionService;
  readonly repository: FakeSessionsRepository;
  readonly artifactStore: FakeArtifactStore;
  readonly launcher: FakeLauncher;
  readonly log: string[];
  readonly clock: { ms: number };
}

function buildHarness(
  overrides: Partial<
    Omit<
      CreateSessionServiceOptions,
      "sessionsRepository" | "artifactStore" | "launcher"
    >
  > = {},
  collaborators: {
    readonly artifactStore?: FakeArtifactStore;
    readonly launcher?: FakeLauncher;
  } = {},
): TestHarness {
  const log: string[] = [];
  const repository = createFakeSessionsRepository(log);
  const artifactStore =
    collaborators.artifactStore ?? createFakeArtifactStore();
  const launcher = collaborators.launcher ?? createFakeLauncher();
  const clock = { ms: 1_000 };
  let idCounter = 0;

  const service = createSessionService({
    sessionsRepository: repository,
    artifactStore,
    launcher,
    openSessionsMax: 10,
    newId: () => `id-${String(idCounter++)}`,
    nowMs: () => clock.ms,
    ...overrides,
  });

  return { service, repository, artifactStore, launcher, log, clock };
}

/** Runs `run`, capturing whatever it throws synchronously as a single `unknown` value. */
function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Runs `run`, capturing whatever the returned promise rejects with as a single `unknown` value. */
async function captureAsyncFailure(
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("M3LSessionService — createSession()", () => {
  test("returns a freshly created open session and increments countOpenSessions", () => {
    const { service, repository } = buildHarness();

    const record = service.createSession("alice", "corr-1");

    expect(record.status).toBe("open");
    expect(record.operator).toBe("alice");
    expect(record.correlationId).toBe("corr-1");
    expect(record.closedAtMs).toBeUndefined();
    expect(repository.countOpenSessions()).toBe(1);
    expect(repository.getSession(record.id)).toEqual(record);
  });

  test("throws ERR_CONSOLE_SESSION_LIMIT_EXCEEDED before ever inserting, when countOpenSessions >= openSessionsMax", () => {
    const { service, log } = buildHarness({ openSessionsMax: 0 });

    const thrown = captureFailure(() =>
      service.createSession("alice", "corr-1"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED",
    );
    expect(log).not.toContain(expect.stringContaining("insertSession"));
    expect(log.some((entry) => entry.startsWith("insertSession"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSession / listSessions — pass-through reads
// ---------------------------------------------------------------------------

describe("M3LSessionService — getSession() and listSessions()", () => {
  test("getSession returns the session created through the service", () => {
    const { service } = buildHarness();
    const created = service.createSession("alice", "corr-1");

    expect(service.getSession(created.id)).toEqual(created);
  });

  test("getSession returns undefined for an unknown id, never throwing", () => {
    const { service } = buildHarness();

    expect(() => service.getSession("does-not-exist")).not.toThrow();
    expect(service.getSession("does-not-exist")).toBeUndefined();
  });

  test("listSessions filters through to the repository", () => {
    const { service } = buildHarness();
    service.createSession("alice", "corr-1");
    service.createSession("bob", "corr-2");

    const results = service.listSessions({ operator: "bob", limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]?.operator).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// closeSession
// ---------------------------------------------------------------------------

describe("M3LSessionService — closeSession()", () => {
  test("on an open session: returns true and closes it", () => {
    const { service } = buildHarness();
    const created = service.createSession("alice", "corr-1");

    expect(service.closeSession(created.id)).toBe(true);
    expect(service.getSession(created.id)?.status).toBe("closed");
  });

  test("on an already-closed session: returns false, does not throw", () => {
    const { service } = buildHarness();
    const created = service.createSession("alice", "corr-1");
    service.closeSession(created.id);

    expect(() => service.closeSession(created.id)).not.toThrow();
    expect(service.closeSession(created.id)).toBe(false);
  });

  test("on an unknown id: throws ERR_CONSOLE_SESSION_NOT_FOUND", () => {
    const { service } = buildHarness();

    const thrown = captureFailure(() => service.closeSession("does-not-exist"));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// reopenSession
// ---------------------------------------------------------------------------

describe("M3LSessionService — reopenSession()", () => {
  test("on a closed session: returns true and reopens it", () => {
    const { service } = buildHarness();
    const created = service.createSession("alice", "corr-1");
    service.closeSession(created.id);

    expect(service.reopenSession(created.id)).toBe(true);
    expect(service.getSession(created.id)?.status).toBe("open");
  });

  test("on an already-open session: returns false, does not throw", () => {
    const { service } = buildHarness();
    const created = service.createSession("alice", "corr-1");

    expect(() => service.reopenSession(created.id)).not.toThrow();
    expect(service.reopenSession(created.id)).toBe(false);
  });

  test("on an unknown id: throws ERR_CONSOLE_SESSION_NOT_FOUND", () => {
    const { service } = buildHarness();

    const thrown = captureFailure(() =>
      service.reopenSession("does-not-exist"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });

  // Conformance gap (issue #554 follow-up): reopening a previously-closed
  // session also increases the open-session count, exactly like
  // `createSession` does — so it must be gated by the same
  // `openSessionsMax` cap. Mirrors the `createSession()` fixture/assertion
  // style above (`openSessionsMax: 0`/at-cap harness, `.code` check, and a
  // "never wrote" log assertion) rather than inventing a new one.
  test("throws ERR_CONSOLE_SESSION_LIMIT_EXCEEDED before ever reopening, when countOpenSessions >= openSessionsMax", () => {
    const { service, log } = buildHarness({ openSessionsMax: 1 });
    const toReopen = service.createSession("alice", "corr-1");
    service.closeSession(toReopen.id);
    // Fills the single open-session slot back up, so the cap is hit again
    // by the time `reopenSession` is attempted below.
    service.createSession("bob", "corr-2");

    const logLengthBeforeReopen = log.length;
    const thrown = captureFailure(() => service.reopenSession(toReopen.id));

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_LIMIT_EXCEEDED",
    );
    expect(log.slice(logLengthBeforeReopen)).not.toContain(
      `reopenSession:${toReopen.id}`,
    );
    expect(service.getSession(toReopen.id)?.status).toBe("closed");
  });

  // Bug fix (PR #746 review): the target session's own open slot must not
  // count against itself. Reopening an *already-open* session at capacity is
  // a no-op — it returns `false` (per the "already-open" contract above)
  // without ever throwing `ERR_CONSOLE_SESSION_LIMIT_EXCEEDED`, unlike the
  // closed-target case above, which genuinely increases the open count and
  // must stay gated.
  test("on an already-open session at capacity: returns false, does not throw ERR_CONSOLE_SESSION_LIMIT_EXCEEDED", () => {
    const { service } = buildHarness({ openSessionsMax: 1 });
    const created = service.createSession("alice", "corr-1");

    expect(() => service.reopenSession(created.id)).not.toThrow();
    expect(service.reopenSession(created.id)).toBe(false);
    expect(service.getSession(created.id)?.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// addStep
// ---------------------------------------------------------------------------

describe("M3LSessionService — addStep()", () => {
  test("happy path: resolves a binding against a prior finished step's inline artifact output, launches, and attaches the run", async () => {
    const { service, repository, launcher } = buildHarness();
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { Queues: ["queue-a", "queue-b"] },
      }),
    });

    const result = await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [
        {
          reference: "step-1.output.Queues[0]",
          expectedType: "string",
          multiSelect: false,
          parameterName: "queueName",
        },
      ],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]?.body.parameters["queueName"]).toBe("queue-a");
    expect(result.step.runId).toBe(result.handle.id);
    expect(repository.getStep(result.step.id)?.runId).toBe(result.handle.id);
  });

  test("a non-string resolved binding value is JSON.stringify'd into the parameters map", async () => {
    const { service, repository, launcher } = buildHarness();
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({ kind: "inline", value: { count: 42 } }),
    });

    await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [
        {
          reference: "step-1.output.count",
          expectedType: "number",
          multiSelect: false,
          parameterName: "countValue",
        },
      ],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(launcher.calls[0]?.body.parameters["countValue"]).toBe("42");
  });

  test("throws ERR_CONSOLE_SESSION_CLOSED when the target session is not open", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    repository.closeSession(sessionId, 2_000);

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_SESSION_CLOSED");
  });

  test("throws ERR_CONSOLE_SESSION_STEP_NOT_FOUND when a binding references an ordinal with no step yet in this session", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [
          {
            reference: "step-1.output.value",
            expectedType: "string",
            multiSelect: false,
            parameterName: "value",
          },
        ],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
  });

  test("throws ERR_CONSOLE_SESSION_REFERENCE_INVALID when the referenced step exists but has no resultRef yet", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    seedRunningStep(repository, { sessionId, ordinal: 1 });

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [
          {
            reference: "step-1.output.value",
            expectedType: "string",
            multiSelect: false,
            parameterName: "value",
          },
        ],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
    );
  });

  test("throws ERR_CONSOLE_SESSION_REFERENCE_INVALID naming the offending binding when validateBindingValue rejects the resolved value", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      // resolved value at .value is a string, but the binding expects a number
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { value: "not-a-number" },
      }),
    });

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [
          {
            reference: "step-1.output.value",
            expectedType: "number",
            multiSelect: false,
            parameterName: "value",
          },
        ],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
    );
    expect((thrown as M3LConsoleError).message).toContain(
      "step-1.output.value",
    );
  });

  test('catches up a step\'s status to "running" when the launcher\'s returned handle already reports "running" (the real orchestrator published run.started synchronously, before this step existed to attach to)', async () => {
    // `createFakeLauncher()`'s default `buildHandle` already returns
    // `status: "running"` — mirroring the real orchestrator's
    // synchronous-accept-and-start path — so no override is needed here.
    const { service, repository, log } = buildHarness();
    const sessionId = seedOpenSession(repository);

    const result = await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(result.handle.status).toBe("running");
    // Pre-fix, this step would be permanently stuck at "queued": the missed
    // `run.started` event never re-fires, and `handleRunEvent`'s `run.ended`
    // branch bails because `step.status !== "running"`.
    expect(result.step.status).toBe("running");
    expect(repository.getStep(result.step.id)?.status).toBe("running");
    expect(log).toContain(`claimStepForStart:${result.step.id}`);
  });

  test("does not eagerly claim the step for start when the launcher's returned handle still reports \"queued\" (that stays handleRunStarted's job, on the real run.started event)", async () => {
    const launcher = createFakeLauncher((request, index) => ({
      id: `run-${String(index)}`,
      scriptName: request.body.scriptName,
      status: "queued",
      dryRun: request.body.dryRun,
      executionMode: "spawn",
    }));
    const { service, repository, log } = buildHarness({}, { launcher });
    const sessionId = seedOpenSession(repository);

    const result = await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(result.handle.status).toBe("queued");
    expect(result.step.status).toBe("queued");
    expect(repository.getStep(result.step.id)?.status).toBe("queued");
    expect(log.some((entry) => entry.startsWith("claimStepForStart:"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// addStep — binding persistence (ADR-0068 audit trail; previously unwired —
// `resolveBindingValue`/`resolveLaunchParameters` resolved each binding but
// nothing ever called `sessionsRepository.insertBinding`).
// ---------------------------------------------------------------------------

describe("M3LSessionService — addStep() persists each resolved binding via insertBinding()", () => {
  test("calls insertBinding once per binding, with the exact fields insertBinding's contract documents", async () => {
    const { service, repository, clock } = buildHarness();
    const insertBindingSpy = vi.spyOn(repository, "insertBinding");
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { Queues: ["queue-a", "queue-b"] },
      }),
    });
    const binding = {
      reference: "step-1.output.Queues[0]",
      expectedType: "string" as const,
      multiSelect: false,
      parameterName: "queueName",
    };

    await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [binding],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(insertBindingSpy).toHaveBeenCalledTimes(1);
    expect(insertBindingSpy).toHaveBeenCalledWith({
      id: expect.any(String) as string,
      sessionId,
      reference: binding.reference,
      expectedType: binding.expectedType,
      multiSelect: binding.multiSelect,
      parameterName: binding.parameterName,
      createdAtMs: clock.ms,
    });
  });

  test("persists every binding when addStep is given several, one insertBinding call each", async () => {
    const { service, repository } = buildHarness();
    const insertBindingSpy = vi.spyOn(repository, "insertBinding");
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { name: "queue-a", count: 3 },
      }),
    });

    await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [
        {
          reference: "step-1.output.name",
          expectedType: "string",
          multiSelect: false,
          parameterName: "name",
        },
        {
          reference: "step-1.output.count",
          expectedType: "number",
          multiSelect: false,
          parameterName: "count",
        },
      ],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(insertBindingSpy).toHaveBeenCalledTimes(2);
    expect(insertBindingSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reference: "step-1.output.name" }),
    );
    expect(insertBindingSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ reference: "step-1.output.count" }),
    );
  });

  test("persists a binding only after its own successful resolution; a later binding's failure never reaches insertBinding and does not roll back the earlier persisted binding", async () => {
    const { service, repository } = buildHarness();
    const insertBindingSpy = vi.spyOn(repository, "insertBinding");
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { name: "queue-a", value: "not-a-number" },
      }),
    });
    const goodBinding = {
      reference: "step-1.output.name",
      expectedType: "string" as const,
      multiSelect: false,
      parameterName: "name",
    };
    const badBinding = {
      reference: "step-1.output.value",
      expectedType: "number" as const,
      multiSelect: false,
      parameterName: "value",
    };

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [goodBinding, badBinding],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
    );
    expect(insertBindingSpy).toHaveBeenCalledTimes(1);
    expect(insertBindingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reference: goodBinding.reference }),
    );
  });

  test("addStep with zero bindings never calls insertBinding", async () => {
    const { service, repository } = buildHarness();
    const insertBindingSpy = vi.spyOn(repository, "insertBinding");
    const sessionId = seedOpenSession(repository);

    await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    expect(insertBindingSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// addStep — collaborator-failure propagation and the attachStepRun defensive
// check (review round findings)
// ---------------------------------------------------------------------------

describe("M3LSessionService — addStep() propagates collaborator failures unchanged", () => {
  test("propagates launcher.launch()'s thrown error unchanged", async () => {
    const launchError = new M3LConsoleError(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
      "no script found with that name",
    );
    const throwingLauncher: FakeLauncher = {
      calls: [],
      launch(): FakeRunHandle {
        throw launchError;
      },
    };
    const { service, repository } = buildHarness(
      {},
      { launcher: throwingLauncher },
    );
    const sessionId = seedOpenSession(repository);

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBe(launchError);
    expect(thrown).toMatchObject({ code: "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND" });
  });

  test("propagates artifactStore.readArtifact()'s thrown error unchanged while resolving a binding against a prior step's output", async () => {
    const readError = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
      "artifact ref could not be decoded",
    );
    const rejectingArtifactStore: FakeArtifactStore = {
      putCalls: [],
      fileArtifacts: new Map(),
      put(): Promise<M3LSessionArtifactRef> {
        return Promise.resolve({ kind: "inline", value: {} });
      },
      readArtifact(): Promise<unknown> {
        return Promise.reject(readError);
      },
    };
    const { service, repository } = buildHarness(
      {},
      { artifactStore: rejectingArtifactStore },
    );
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({ kind: "inline", value: { x: 1 } }),
    });

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [
          {
            reference: "step-1.output.x",
            expectedType: "number",
            multiSelect: false,
            parameterName: "x",
          },
        ],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBe(readError);
    expect(thrown).toMatchObject({
      code: "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    });
  });

  test("throws ERR_CONSOLE_INTERNAL when attachStepRun returns false (freshly inserted step failed to attach)", async () => {
    const log: string[] = [];
    const baseRepository = createFakeSessionsRepository(log);
    const repository: FakeSessionsRepository = {
      ...baseRepository,
      attachStepRun(): boolean {
        log.push("attachStepRun:forced-false");
        return false;
      },
    };
    let idCounter = 0;
    const service = createSessionService({
      sessionsRepository: repository,
      artifactStore: createFakeArtifactStore(),
      launcher: createFakeLauncher(),
      openSessionsMax: 10,
      newId: () => `id-${String(idCounter++)}`,
      nowMs: () => 1_000,
    });
    const sessionId = seedOpenSession(repository);

    const thrown = await captureAsyncFailure(() =>
      service.addStep(sessionId, {
        operation: "scripts/example",
        bindings: [],
        confirmed: true,
        dryRun: false,
        operator: "alice",
        correlationId: "corr-2",
      }),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });
});

// ---------------------------------------------------------------------------
// handleRunEvent
// ---------------------------------------------------------------------------

describe("M3LSessionService — handleRunEvent()", () => {
  test("run.queued is a silent no-op: no throw, no repository write", async () => {
    const { service, log } = buildHarness();
    const before = log.length;

    await expect(
      service.handleRunEvent({
        event: "run.queued",
        runId: "run-unrelated",
        scriptName: "scripts/example",
        dryRun: false,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveLength(before);
  });

  test("run.line is a silent no-op: no throw, no repository write", async () => {
    const { service, log } = buildHarness();
    const before = log.length;

    await expect(
      service.handleRunEvent({
        event: "run.line",
        runId: "run-unrelated",
        line: "some output",
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveLength(before);
  });

  test("run.started with no matching step (unknown runId) is a silent no-op — no throw, no write beyond the failed lookup", async () => {
    const { service, log } = buildHarness();
    const before = log.length;

    await expect(
      service.handleRunEvent({
        event: "run.started",
        runId: "run-unknown",
        atMs: 5_000,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveLength(before);
  });

  test("run.ended with no matching step (unknown runId) is a silent no-op — no throw, no artifactStore.put, no write beyond the failed lookup", async () => {
    const { service, log, artifactStore } = buildHarness();
    const before = log.length;

    await expect(
      service.handleRunEvent({
        event: "run.ended",
        runId: "run-unknown",
        outcome: "success",
        exitCode: 0,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveLength(before);
    expect(artifactStore.putCalls).toHaveLength(0);
  });

  test("run.started with a matching step: claims it for start", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    // A freshly queued (never claimed) step: handleRunEvent itself must
    // perform the queued -> running transition, not merely observe one that
    // already happened.
    const stepId = "step-queued";
    repository.insertStep({
      id: stepId,
      sessionId,
      ordinal: 1,
      operation: "scripts/example",
      parameters: {},
      queuedAtMs: 1_000,
    });
    repository.attachStepRun(stepId, "run-fresh");

    await service.handleRunEvent({
      event: "run.started",
      runId: "run-fresh",
      atMs: 5_000,
    });

    const record = repository.getStep(stepId);
    expect(record?.status).toBe("running");
    expect(record?.startedAtMs).toBe(5_000);
  });

  test("run.ended computes the running total as the sum of prior finished steps' file-kind sizeBytes, 0 for inline/no-resultRef, scoped to this session only", async () => {
    const { service, repository, artifactStore } = buildHarness();
    const sessionId = seedOpenSession(repository, { id: "session-target" });
    const otherSessionId = seedOpenSession(repository, { id: "session-other" });

    const fileRef: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-target/step-file.json",
      sizeBytes: 500,
      digest: "a".repeat(64),
    };
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef(fileRef),
    });
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 2,
      resultRef: encodeArtifactRef({ kind: "inline", value: "small" }),
    });
    seedRunningStep(repository, { sessionId, ordinal: 3 });

    // A much larger file-kind artifact in a DIFFERENT session — must not
    // contribute to session-target's running total.
    const otherFileRef: M3LSessionArtifactRef = {
      kind: "file",
      path: "session-other/step-file.json",
      sizeBytes: 999_999,
      digest: "b".repeat(64),
    };
    seedFinishedStep(repository, {
      id: "step-other-1",
      sessionId: otherSessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef(otherFileRef),
    });

    const newStepId = "step-new";
    repository.insertStep({
      id: newStepId,
      sessionId,
      ordinal: 4,
      operation: "scripts/example",
      parameters: {},
      queuedAtMs: 1_000,
    });
    repository.claimStepForStart(newStepId, 1_500);
    repository.attachStepRun(newStepId, "run-new");

    await service.handleRunEvent({
      event: "run.ended",
      runId: "run-new",
      outcome: "success",
      exitCode: 0,
    });

    expect(artifactStore.putCalls).toHaveLength(1);
    expect(artifactStore.putCalls[0]?.currentSessionTotalBytes).toBe(500);
    expect(artifactStore.putCalls[0]?.sessionId).toBe(sessionId);
    expect(artifactStore.putCalls[0]?.stepId).toBe(newStepId);
    expect(artifactStore.putCalls[0]?.payload).toEqual({
      outcome: "success",
      exitCode: 0,
    });

    const finished = repository.getStep(newStepId);
    expect(finished?.status).toBe("success");
    expect(finished?.outcome).toBe("success");
    expect(finished?.resultRef).toBe(
      encodeArtifactRef({
        kind: "inline",
        value: { outcome: "success", exitCode: 0 },
      }),
    );
  });

  test("run.ended branch propagates artifactStore.put()'s thrown error unchanged, when the session's cumulative byte cap is exceeded", async () => {
    const putError = new M3LConsoleError(
      "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
      "artifact would exceed the session's configured byte cap",
    );
    const rejectingArtifactStore: FakeArtifactStore = {
      putCalls: [],
      fileArtifacts: new Map(),
      put(): Promise<M3LSessionArtifactRef> {
        return Promise.reject(putError);
      },
      readArtifact(ref: M3LSessionArtifactRef): Promise<unknown> {
        return ref.kind === "inline"
          ? Promise.resolve(ref.value)
          : Promise.reject(new Error("unused in this test"));
      },
    };
    const { service, repository } = buildHarness(
      {},
      { artifactStore: rejectingArtifactStore },
    );
    const sessionId = seedOpenSession(repository);
    const stepId = seedRunningStep(repository, { sessionId, ordinal: 1 });
    repository.attachStepRun(stepId, "run-too-large");

    const thrown = await captureAsyncFailure(() =>
      service.handleRunEvent({
        event: "run.ended",
        runId: "run-too-large",
        outcome: "success",
        exitCode: 0,
      }),
    );

    expect(thrown).toBe(putError);
    expect(thrown).toMatchObject({
      code: "ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE",
    });
  });

  test("run.ended for a step whose status is no longer running (already finished) is a silent no-op — no duplicate artifactStore.put", async () => {
    const { service, repository, artifactStore } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedRunningStep(repository, { sessionId, ordinal: 1 });
    repository.attachStepRun(stepId, "run-repeat");

    await service.handleRunEvent({
      event: "run.ended",
      runId: "run-repeat",
      outcome: "success",
      exitCode: 0,
    });
    expect(artifactStore.putCalls).toHaveLength(1);
    expect(repository.getStep(stepId)?.status).toBe("success");

    // A second delivery of the same terminal event for the same runId: the
    // step is no longer "running", so this must be a silent no-op rather
    // than a second finishStep/put.
    await expect(
      service.handleRunEvent({
        event: "run.ended",
        runId: "run-repeat",
        outcome: "success",
        exitCode: 0,
      }),
    ).resolves.toBeUndefined();
    expect(artifactStore.putCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// raiseDecision / answerDecision / listDecisionsForSession
// ---------------------------------------------------------------------------

describe("M3LSessionService — raiseDecision()", () => {
  test("raises a pending decision for the given session and step", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedRunningStep(repository, { sessionId, ordinal: 1 });

    const decision = service.raiseDecision(sessionId, stepId, "Proceed?", [
      "yes",
      "no",
    ]);

    expect(decision.status).toBe("pending");
    expect(decision.sessionId).toBe(sessionId);
    expect(decision.stepId).toBe(stepId);
    expect(decision.prompt).toBe("Proceed?");
    expect(repository.getDecision(decision.id)).toEqual(decision);
  });
});

describe("M3LSessionService — raiseDecision() failure paths", () => {
  test("throws ERR_CONSOLE_SESSION_NOT_FOUND when sessionId names no session", () => {
    const { service } = buildHarness();

    const thrown = captureFailure(() =>
      service.raiseDecision("does-not-exist", "step-1", "Proceed?"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });

  test("throws ERR_CONSOLE_SESSION_STEP_NOT_FOUND when stepId names no step at all", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);

    const thrown = captureFailure(() =>
      service.raiseDecision(sessionId, "does-not-exist", "Proceed?"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
  });

  test("throws ERR_CONSOLE_SESSION_STEP_NOT_FOUND when stepId names a step belonging to a different session", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository, { id: "session-a" });
    const otherSessionId = seedOpenSession(repository, { id: "session-b" });
    const stepId = seedRunningStep(repository, {
      sessionId: otherSessionId,
      ordinal: 1,
    });

    const thrown = captureFailure(() =>
      service.raiseDecision(sessionId, stepId, "Proceed?"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
  });
});

describe("M3LSessionService — answerDecision()", () => {
  test("on a pending decision: returns true and answers it", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedRunningStep(repository, { sessionId, ordinal: 1 });
    const decision = service.raiseDecision(sessionId, stepId, "Proceed?");

    expect(service.answerDecision(decision.id, "yes")).toBe(true);
    expect(repository.getDecision(decision.id)?.status).toBe("answered");
  });

  test("on an already-answered decision: returns false, does not throw", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedRunningStep(repository, { sessionId, ordinal: 1 });
    const decision = service.raiseDecision(sessionId, stepId, "Proceed?");
    service.answerDecision(decision.id, "yes");

    expect(() => service.answerDecision(decision.id, "no")).not.toThrow();
    expect(service.answerDecision(decision.id, "no")).toBe(false);
  });

  test("on an unknown decision id: throws an ERR_CONSOLE_SESSION_STEP_NOT_FOUND-style lookup error", () => {
    const { service } = buildHarness();

    const thrown = captureFailure(() =>
      service.answerDecision("does-not-exist", "yes"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
  });
});

describe("M3LSessionService — listDecisionsForSession()", () => {
  test("returns every decision raised for the session", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedRunningStep(repository, { sessionId, ordinal: 1 });
    service.raiseDecision(sessionId, stepId, "First?");
    service.raiseDecision(sessionId, stepId, "Second?");

    expect(service.listDecisionsForSession(sessionId)).toHaveLength(2);
  });

  test("returns an empty array for a session with no decisions", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);

    expect(service.listDecisionsForSession(sessionId)).toEqual([]);
  });

  // [RED] `listDecisionsForSession` has no session-existence guard, unlike
  // its siblings `listStepsForSession`/`listBindingsForSession` — an unknown
  // session id today silently returns `[]` instead of throwing, which is
  // inconsistent with `GET /api/v1/sessions/:id/decisions`'s sibling
  // `/steps` route. Mirrors the equivalent `answerDecision()` "on an unknown
  // decision id" test immediately above.
  test("on an unknown session id: throws ERR_CONSOLE_SESSION_NOT_FOUND", () => {
    const { service } = buildHarness();

    const thrown = captureFailure(() =>
      service.listDecisionsForSession("does-not-exist"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// listBindingsForSession — new service method, delegating straight to the
// repository (mirrors listDecisionsForSession's own test style).
// ---------------------------------------------------------------------------

describe("M3LSessionService — listBindingsForSession()", () => {
  test("returns every binding persisted for the session via addStep", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { name: "queue-a" },
      }),
    });

    await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [
        {
          reference: "step-1.output.name",
          expectedType: "string",
          multiSelect: false,
          parameterName: "name",
        },
      ],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    const bindings = service.listBindingsForSession(sessionId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId,
      reference: "step-1.output.name",
      expectedType: "string",
      multiSelect: false,
    });
  });

  test("delegates straight to the repository, returning an empty array for a session with no bindings", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);

    expect(service.listBindingsForSession(sessionId)).toEqual(
      repository.listBindingsForSession(sessionId),
    );
    expect(service.listBindingsForSession(sessionId)).toEqual([]);
  });

  // [RED — review-round Must-fix, Defect 1] `listBindingsForSession` never
  // calls `requireSession` the way every sibling method
  // (`closeSession`/`reopenSession`/`addStep`/`raiseDecision`) does — see
  // this file's own `closeSession()`/`reopenSession()` "on an unknown id"
  // tests immediately above for the exact assertion style this mirrors. A
  // typo'd session id is today indistinguishable from "this real session
  // has zero bindings": `repository.listBindingsForSession` on an in-memory
  // Map-backed fake simply returns `[]` for any id it has never seen,
  // exactly as it would for a genuinely empty, real session.
  test("on an unknown id: throws ERR_CONSOLE_SESSION_NOT_FOUND", () => {
    const { service } = buildHarness();

    const thrown = captureFailure(() =>
      service.listBindingsForSession("does-not-exist"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });
});
