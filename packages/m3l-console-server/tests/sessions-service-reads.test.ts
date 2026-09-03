/**
 * Tests for `sessions/service-reads.ts`'s `readStepArtifact` (X7d) — the read
 * behind `GET /api/v1/sessions/:id/steps/:stepId/artifact`.
 *
 * Driven through the assembled `M3LSessionService`, not the builder in
 * isolation: that is what proves the extraction is actually wired into the
 * service a caller gets.
 *
 * Its own file because `tests/sessions-service.test.ts` reached 64,205 of
 * ADR-0072's 60,000-byte test ceiling once these cases were added.
 * `listBindingsForSession` — the module's other method, moved there
 * unchanged — keeps its existing coverage in that file rather than being
 * relocated for tidiness; moving passing tests buys nothing and loses their
 * history. The fixtures below are COPIED from that file rather than imported,
 * this package's established convention (see `.claude/rules/tests.md`, and
 * `runs-orchestrator-correlation.test.ts`'s own note on the same choice).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { encodeArtifactRef } from "../src/sessions/artifacts.js";
import type {
  M3LSessionArtifactRef,
  M3LSessionArtifactStore,
} from "../src/sessions/artifacts.js";
// RED: `M3LSessionStepSummary` does not exist yet in `service-reads.ts` —
// this import is the deliberate compile failure that keeps this file RED
// until the GREEN pass adds it.
import type { M3LSessionStepSummary } from "../src/sessions/service-reads.js";
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

/** Runs `run`, capturing whatever it throws synchronously as a single `unknown` value — mirrors `sessions-service.test.ts`'s own `captureFailure`. */
function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// readStepArtifact (X7d) — the read behind
// `GET /api/v1/sessions/:id/steps/:stepId/artifact`. Lives in
// `sessions/service-reads.ts` alongside listBindingsForSession, and is
// exercised here through the assembled service, which is what proves the
// extraction is wired in at all.
// ---------------------------------------------------------------------------

describe("M3LSessionService — readStepArtifact()", () => {
  test("resolves the step's recorded output through the artifact store", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { queues: ["a", "b"] },
      }),
    });

    expect(await service.readStepArtifact(sessionId, stepId)).toEqual({
      queues: ["a", "b"],
    });
  });

  test("resolves a FILE-backed ref through the store", async () => {
    const artifactStore = createFakeArtifactStore();
    artifactStore.fileArtifacts.set("session/step.json", { big: true });
    const { service, repository } = buildHarness({}, { artifactStore });
    const sessionId = seedOpenSession(repository);
    const stepId = seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "file",
        path: "session/step.json",
        sizeBytes: 12,
        digest: "a".repeat(64),
      }),
    });

    expect(await service.readStepArtifact(sessionId, stepId)).toEqual({
      big: true,
    });
  });

  // INVARIANT: EVERY read goes through the store, including an inline one.
  // The store re-verifies a reference's shape and — for a file ref — its
  // SHA-256 digest on every read; a short-circuit here would quietly move
  // one arm of that decision into this module, where it would drift.
  //
  // The stub deliberately returns a value the ref does NOT contain. A store
  // that echoed `ref.value` for an inline ref (which the default fake does)
  // could not tell a delegating implementation from a short-circuiting one —
  // this is exactly the vacuous-double-check shape, and the sentinel is what
  // breaks it. Mutation-tested: adding
  // `if (ref.kind === "inline") return ref.value;` fails here and nowhere
  // else.
  test("resolves an INLINE ref through the store too, never by reading ref.value", async () => {
    const sentinel = { cameFrom: "the store" };
    const artifactStore: FakeArtifactStore = {
      ...createFakeArtifactStore(),
      readArtifact: () => Promise.resolve(sentinel),
    };
    const { service, repository } = buildHarness({}, { artifactStore });
    const sessionId = seedOpenSession(repository);
    const stepId = seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: encodeArtifactRef({
        kind: "inline",
        value: { cameFrom: "the ref" },
      }),
    });

    expect(await service.readStepArtifact(sessionId, stepId)).toBe(sentinel);
  });

  test("throws ERR_CONSOLE_SESSION_NOT_FOUND for an unknown session id", async () => {
    const { service } = buildHarness();

    const thrown = await captureAsyncFailure(() =>
      service.readStepArtifact("does-not-exist", "step-ordinal-1"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });

  test("throws ERR_CONSOLE_SESSION_STEP_NOT_FOUND for an unknown step id", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);

    const thrown = await captureAsyncFailure(() =>
      service.readStepArtifact(sessionId, "no-such-step"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
  });

  // INVARIANT: a step is readable through the session that OWNS it and no
  // other, and the refusal must be indistinguishable from "no such step" —
  // otherwise a caller probing ids learns which ones exist elsewhere.
  // Mutation-tested: dropping the `step.sessionId !== sessionId` clause makes
  // this return the other session's artifact.
  test("refuses a step owned by a DIFFERENT session, indistinguishably from not-found", async () => {
    const { service, repository } = buildHarness();
    const ownerSession = seedOpenSession(repository, { id: "session-owner" });
    const otherSession = seedOpenSession(repository, { id: "session-other" });
    const stepId = seedFinishedStep(repository, {
      sessionId: ownerSession,
      ordinal: 1,
      resultRef: encodeArtifactRef({ kind: "inline", value: { secret: true } }),
    });

    const thrown = await captureAsyncFailure(() =>
      service.readStepArtifact(otherSession, stepId),
    );
    const unknownStep = await captureAsyncFailure(() =>
      service.readStepArtifact(otherSession, "no-such-step"),
    );

    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
    // The two messages must be identical, not merely the same code — a
    // distinguishable message is the leak.
    expect((thrown as M3LConsoleError).message).toBe(
      (unknownStep as M3LConsoleError).message.replace("no-such-step", stepId),
    );
  });

  test("throws ERR_CONSOLE_SESSION_STEP_NOT_FOUND for a step with no recorded output yet", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedRunningStep(repository, { sessionId, ordinal: 1 });

    const thrown = await captureAsyncFailure(() =>
      service.readStepArtifact(sessionId, stepId),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
    expect((thrown as M3LConsoleError).message).toContain(
      "no recorded output yet",
    );
  });

  test("propagates a corrupt persisted reference unchanged", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const stepId = seedFinishedStep(repository, {
      sessionId,
      ordinal: 1,
      resultRef: "{not json",
    });

    const thrown = await captureAsyncFailure(() =>
      service.readStepArtifact(sessionId, stepId),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT",
    );
  });
});

// ---------------------------------------------------------------------------
// listStepsForSession (X11) — the read behind
// `GET /api/v1/sessions/:id/steps`. `M3LSessionStepSummary` is
// `Omit<M3LSessionStepRecord, "resultRef"> & { readonly hasResult: boolean }`
// — a DELIBERATE redaction: `resultRef` is the step's ENCODED artifact
// reference, which for an inline artifact literally embeds the resolved
// VALUE (see `sessions/artifacts.ts`'s `encodeArtifactRef`), so it must never
// appear in a step LIST response. The sanctioned way to read a step's value
// is the already-existing `GET .../steps/:stepId/artifact` route — exactly
// the same "no resolved VALUE" boundary `listBindingsForSession` draws for
// bindings.
// ---------------------------------------------------------------------------

describe("M3LSessionService — listStepsForSession()", () => {
  test("throws ERR_CONSOLE_SESSION_NOT_FOUND for an unknown session id", () => {
    const { service } = buildHarness();

    const thrown = captureFailure(() =>
      service.listStepsForSession("does-not-exist"),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });

  test("redacts resultRef into a hasResult boolean, passing every other field through unchanged", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    const pendingStepId = seedRunningStep(repository, {
      sessionId,
      ordinal: 1,
    });
    const finishedStepId = seedFinishedStep(repository, {
      sessionId,
      ordinal: 2,
      resultRef: encodeArtifactRef({ kind: "inline", value: 42 }),
    });

    const summaries: readonly M3LSessionStepSummary[] =
      service.listStepsForSession(sessionId);

    expect(summaries).toHaveLength(2);
    const [pending, finished] = summaries;
    if (pending === undefined || finished === undefined) {
      throw new Error("expected two step summaries");
    }

    // (a) `resultRef` is OMITTED entirely, not merely undefined.
    expect(pending).not.toHaveProperty("resultRef");
    expect(finished).not.toHaveProperty("resultRef");

    // (b) `hasResult` reflects whether a result was actually recorded.
    expect(pending.hasResult).toBe(false);
    expect(finished.hasResult).toBe(true);

    // (c) every other field is passed through unchanged from the repository row.
    const pendingRow = repository.getStep(pendingStepId);
    const finishedRow = repository.getStep(finishedStepId);
    if (pendingRow === undefined || finishedRow === undefined) {
      throw new Error("expected both seeded steps to exist");
    }
    expect(pending).toMatchObject({
      id: pendingRow.id,
      sessionId: pendingRow.sessionId,
      ordinal: pendingRow.ordinal,
      operation: pendingRow.operation,
      parameters: pendingRow.parameters,
      runId: pendingRow.runId,
      status: pendingRow.status,
      queuedAtMs: pendingRow.queuedAtMs,
      startedAtMs: pendingRow.startedAtMs,
      endedAtMs: pendingRow.endedAtMs,
      outcome: pendingRow.outcome,
      failureMessage: pendingRow.failureMessage,
    });
    expect(finished).toMatchObject({
      id: finishedRow.id,
      sessionId: finishedRow.sessionId,
      ordinal: finishedRow.ordinal,
      operation: finishedRow.operation,
      parameters: finishedRow.parameters,
      runId: finishedRow.runId,
      status: finishedRow.status,
      queuedAtMs: finishedRow.queuedAtMs,
      startedAtMs: finishedRow.startedAtMs,
      endedAtMs: finishedRow.endedAtMs,
      outcome: finishedRow.outcome,
      failureMessage: finishedRow.failureMessage,
    });
  });

  test("delegates straight to the repository, returning an empty array for a session with no steps", () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    let callCount = 0;
    repository.listStepsForSession = (id: string) => {
      callCount += 1;
      return [...repository.steps.values()].filter(
        (row) => row.sessionId === id,
      );
    };

    const summaries = service.listStepsForSession(sessionId);

    expect(summaries).toEqual([]);
    expect(callCount).toBe(1);
  });
});
