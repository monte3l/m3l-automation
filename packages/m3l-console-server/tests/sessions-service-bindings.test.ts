/**
 * Tests for `sessions/service-bindings.ts`'s `selectBinding` (X7d) — the
 * write behind `POST /api/v1/sessions/:id/bindings`.
 *
 * Driven through the assembled `M3LSessionService`, which is what proves the
 * slice is wired into the service a caller actually gets.
 *
 * Its own file for the same reason `sessions-service-reads.test.ts` is:
 * `tests/sessions-service.test.ts` sits against ADR-0072's 60,000-byte
 * ceiling, and the split mirrors the one `sessions/service.ts` took.
 * Fixtures are COPIED from that file rather than imported, this package's
 * established convention (see `.claude/rules/tests.md`).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { encodeArtifactRef } from "../src/sessions/artifact-codec.js";
import type { M3LSessionArtifactRef } from "../src/sessions/artifact-codec.js";
import type { M3LSessionArtifactStore } from "../src/sessions/artifacts.js";
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

// ---------------------------------------------------------------------------
// selectBinding (X7d) — the standalone binding write. `addStep` has always
// created bindings, but only as a side effect of launching; this is the same
// resolution and persistence without the launch.
// ---------------------------------------------------------------------------

/** A well-formed selection against step 1's recorded output. */
const SELECTION = {
  reference: "step-1.output.name",
  expectedType: "string",
  multiSelect: false,
  parameterName: "name",
} as const;

/** Seeds an open session with one finished step carrying `value` as its output. */
function seedSessionWithOutput(
  repository: FakeSessionsRepository,
  value: unknown,
): { readonly sessionId: string; readonly stepId: string } {
  const sessionId = seedOpenSession(repository);
  const stepId = seedFinishedStep(repository, {
    sessionId,
    ordinal: 1,
    resultRef: encodeArtifactRef({ kind: "inline", value }),
  });
  return { sessionId, stepId };
}

describe("M3LSessionService — selectBinding()", () => {
  test("persists the selection and returns the stored record", async () => {
    const { service, repository } = buildHarness();
    const { sessionId } = seedSessionWithOutput(repository, {
      name: "queue-a",
    });

    const record = await service.selectBinding(sessionId, SELECTION);

    expect(record).toMatchObject({
      sessionId,
      reference: "step-1.output.name",
      expectedType: "string",
      multiSelect: false,
    });
    expect(service.listBindingsForSession(sessionId)).toEqual([record]);
  });

  // INVARIANT: the resolved VALUE is never stored. `console_session_bindings`
  // has no column for one, and putting arbitrary step output in the binding
  // trail is what ADR-0070's display-vs-persist split forbids. Mutation-
  // tested: adding the value to the `insertBinding` input fails here.
  test("stores the reference, never the value it resolved to", async () => {
    const { service, repository } = buildHarness();
    // Assembled at runtime, never a single source literal: gitleaks scans
    // source text and this repo has no `.gitleaksignore`
    // (`.claude/rules/tests.md`). Same pattern as
    // `boot-human-action-audit.test.ts`'s planted-parameter fixture.
    const secret = ["AKIA", "EXAMPLE", "NOTREAL"].join("");
    const { sessionId } = seedSessionWithOutput(repository, { name: secret });

    const record = await service.selectBinding(sessionId, SELECTION);

    expect(JSON.stringify(record)).not.toContain(secret);
  });

  // INVARIANT: resolution happens BEFORE persistence. A binding trail whose
  // entries never pointed at anything is worse than no trail. Mutation-
  // tested: moving `insertBinding` ahead of `resolveBindingValue` leaves a
  // row behind here.
  test("persists nothing when the reference names a step with no output yet", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);
    seedRunningStep(repository, { sessionId, ordinal: 1 });

    const thrown = await captureAsyncFailure(() =>
      service.selectBinding(sessionId, SELECTION),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
    );
    expect(service.listBindingsForSession(sessionId)).toEqual([]);
  });

  // INVARIANT: the SAME shape check the inline `addStep` path applies — both
  // resolve through `launch-parameters.ts`'s `resolveBindingValue`, so a
  // selection one accepts the other accepts.
  test("refuses a value that does not match the declared expectedType", async () => {
    const { service, repository } = buildHarness();
    const { sessionId } = seedSessionWithOutput(repository, { name: 42 });

    const thrown = await captureAsyncFailure(() =>
      service.selectBinding(sessionId, SELECTION),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_REFERENCE_INVALID",
    );
    expect(service.listBindingsForSession(sessionId)).toEqual([]);
  });

  test("refuses a reference to an ordinal with no step in this session", async () => {
    const { service, repository } = buildHarness();
    const sessionId = seedOpenSession(repository);

    const thrown = await captureAsyncFailure(() =>
      service.selectBinding(sessionId, SELECTION),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_STEP_NOT_FOUND",
    );
  });

  test("throws ERR_CONSOLE_SESSION_NOT_FOUND for an unknown session id", async () => {
    const { service } = buildHarness();

    const thrown = await captureAsyncFailure(() =>
      service.selectBinding("does-not-exist", SELECTION),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SESSION_NOT_FOUND",
    );
  });

  // INVARIANT: a CLOSED session takes no new bindings, exactly as it takes no
  // new steps. Without this a closed session's binding trail could still
  // grow, which makes "closed" mean nothing. Mutation-tested: dropping the
  // status check lets this persist.
  test("refuses a closed session, persisting nothing", async () => {
    const { service, repository } = buildHarness();
    const { sessionId } = seedSessionWithOutput(repository, {
      name: "queue-a",
    });
    repository.closeSession(sessionId, 3_000);

    const thrown = await captureAsyncFailure(() =>
      service.selectBinding(sessionId, SELECTION),
    );

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_SESSION_CLOSED");
    expect(repository.listBindingsForSession(sessionId)).toEqual([]);
  });

  // X11 slice 1 (issue #559): parameterName is validated at the HTTP boundary
  // today but silently dropped before `insertBinding` — this asserts it
  // actually persists, not just echoes back on the returned object. The
  // returned record and a SEPARATE `listBindingsForSession` read are checked
  // independently so this cannot pass on structural echo alone.
  test("persists parameterName and returns it in the stored record", async () => {
    const { service, repository } = buildHarness();
    const { sessionId } = seedSessionWithOutput(repository, {
      name: "queue-a",
    });
    const binding = { ...SELECTION, parameterName: "queueUrl" };

    const record = await service.selectBinding(sessionId, binding);

    expect(record.parameterName).toBe("queueUrl");
    const stored = repository
      .listBindingsForSession(sessionId)
      .find((candidate) => candidate.id === record.id);
    expect(stored?.parameterName).toBe("queueUrl");
  });

  test("appends to the trail an addStep-created binding already started", async () => {
    // The two paths write the same table. A selection made after a launch
    // must sit alongside that launch's bindings, not replace or shadow them.
    const { service, repository } = buildHarness();
    const { sessionId } = seedSessionWithOutput(repository, {
      name: "queue-a",
    });
    await service.addStep(sessionId, {
      operation: "scripts/example",
      bindings: [{ ...SELECTION, parameterName: "fromStep" }],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    await service.selectBinding(sessionId, SELECTION);

    expect(service.listBindingsForSession(sessionId)).toHaveLength(2);
  });
});
