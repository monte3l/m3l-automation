/**
 * Tests for `src/main.ts`'s X4 slice 6 round 3b run-subsystem wiring:
 * `M3LConsoleRuntimeOptions.runs`/`runsConfig`, `M3LConsoleRuntime.runs`, the
 * env-variable-gated skip-with-warning posture line, and boot
 * reconciliation (`runtime.runs?.orchestrator.reconcileOnBoot()`) running
 * strictly before the listener binds. Split into its own file — per the
 * task brief, `tests/main.test.ts` is 52,157 chars against the 60,000
 * `check:file-budget` ceiling, so a new slice of coverage goes in a new
 * file rather than growing that one further.
 *
 * No real socket and no real OS signal delivery is ever used — a fake
 * `Server` double (mirroring `tests/main.test.ts`/`tests/main-store.test.ts`)
 * stands in for both.
 *
 * RED until `main.ts` gains `runs`/`runsConfig`, builds the subsystem via
 * `createRunSubsystem`, and calls `reconcileOnBoot()` in
 * `buildRuntimeAndBindListener`.
 */
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime, startConsole } from "../src/main.js";
import type {
  M3LConsoleRuntime,
  M3LConsoleRuntimeOptions,
  StartConsoleOptions,
} from "../src/main.js";
import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import type { M3LConsoleSessionsConfig } from "../src/config/sessions.js";
import type { M3LSessionSubsystem } from "../src/sessions/composition.js";
import type { M3LConsoleMetaRepository } from "../src/store/meta-repository.js";
import type {
  M3LConsoleRunsRepository,
  M3LRunFinish,
  M3LRunInsert,
  M3LRunListQuery,
  M3LRunRecord,
} from "../src/store/runs-repository.js";
import type { M3LRunStatus } from "../src/store/run-status.js";
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
import type { M3LConsoleAuditRepository } from "../src/store/audit-repository.js";
import type { M3LConsoleStoreUnit } from "../src/store/store.js";
import type { M3LRunRegistry } from "../src/runs/registry.js";

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
  scriptsDir: "/opt/scripts",
  maxPerScript: 1,
  queueCapacity: 16,
  streamRetention: 256,
  killTimeoutMs: 5000,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
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
 * A `M3LRunRegistry` fake whose every method throws except
 * `reconcileOrphaned`, which records its own call into `calls` (letting a
 * test pin call ORDER against a fake server's own `calls` array) and either
 * returns `0` or throws `reconcileShouldThrow`, per `options`.
 */
function createOrderRecordingRegistry(
  calls: string[],
  options: { reconcileShouldThrow?: Error } = {},
): M3LRunRegistry {
  const unexpectedCall = (): never => {
    throw new Error("unexpected call on order-recording fake registry");
  };
  return {
    insertQueued: unexpectedCall,
    claimForStart: unexpectedCall,
    finish: unexpectedCall,
    get: unexpectedCall,
    list: unexpectedCall,
    countRunningForScript: unexpectedCall,
    abandonQueued: unexpectedCall,
    reconcileOrphaned: (): number => {
      calls.push("reconcileOrphaned");
      if (options.reconcileShouldThrow !== undefined) {
        throw options.reconcileShouldThrow;
      }
      return 0;
    },
  };
}

/** A `M3LConsoleRunsRepository` fake built from an `M3LRunRegistry`-shaped core, plus the two extra repository-only members. */
function toRunsRepository(registry: M3LRunRegistry): M3LConsoleRunsRepository {
  const unexpectedCall = (): never => {
    throw new Error("unexpected call on order-recording fake runs repository");
  };
  return {
    insertQueued: (input: M3LRunInsert): void => {
      registry.insertQueued(input);
    },
    claimForStart: (id: string, startedAtMs: number): boolean =>
      registry.claimForStart(id, startedAtMs),
    finish: (id: string, result: M3LRunFinish): boolean =>
      registry.finish(id, result),
    get: (id: string): M3LRunRecord | undefined => registry.get(id),
    list: (query: M3LRunListQuery): readonly M3LRunRecord[] =>
      registry.list(query),
    countByStatus: (_status: M3LRunStatus): number => unexpectedCall(),
    countRunningForScript: (script: string): number =>
      registry.countRunningForScript(script),
    reconcileOrphaned: (endedAtMs: number): number =>
      registry.reconcileOrphaned(endedAtMs),
    abandonQueued: (id: string, endedAtMs: number): boolean =>
      registry.abandonQueued(id, endedAtMs),
  };
}

/** A minimal local stand-in for `M3LConsoleStoreHandle & M3LConsoleStore`, duplicated from `tests/main-store.test.ts` per `.claude/rules/tests.md` (small helpers are not shared across test files). */
interface FakeConsoleStoreHandle {
  readonly isOpen: boolean;
  readonly location: string;
  readonly schemaVersion: number;
  close(): void;
  all(): never;
  get(): never;
  run(): never;
  script(): never;
  readonly meta: M3LConsoleMetaRepository;
  readonly runs: M3LConsoleRunsRepository;
  readonly sessions: M3LConsoleSessionsRepository;
  readonly audit: M3LConsoleAuditRepository;
  transaction<T>(work: (unit: M3LConsoleStoreUnit) => T): T;
}

/** Throws when a `sessions`-repository method is called unexpectedly on a fake store (added for X6 slice 1's `M3LConsoleStoreUnit.sessions` field — none of this file's tests exercise it). */
const unexpectedSessionsCall = (): never => {
  throw new Error("unexpected sessions-repository call on the fake store");
};

/** A loud-throwing `sessions` stub, shared by every fake store in this file. */
const stubSessionsRepository: M3LConsoleSessionsRepository = {
  insertSession: unexpectedSessionsCall,
  getSession: unexpectedSessionsCall,
  listSessions: unexpectedSessionsCall,
  closeSession: unexpectedSessionsCall,
  reopenSession: unexpectedSessionsCall,
  insertStep: unexpectedSessionsCall,
  claimStepForStart: unexpectedSessionsCall,
  finishStep: unexpectedSessionsCall,
  getStep: unexpectedSessionsCall,
  getStepByOrdinal: unexpectedSessionsCall,
  listStepsForSession: unexpectedSessionsCall,
  insertBinding: unexpectedSessionsCall,
  listBindingsForSession: unexpectedSessionsCall,
  insertDecision: unexpectedSessionsCall,
  answerDecision: unexpectedSessionsCall,
  getDecision: unexpectedSessionsCall,
  listDecisionsForSession: unexpectedSessionsCall,
  countOpenSessions: unexpectedSessionsCall,
  attachStepRun: unexpectedSessionsCall,
  getStepByRunId: unexpectedSessionsCall,
};

/** Throws when an `audit`-repository method is called unexpectedly on a fake store (added for X7c's `M3LConsoleStoreUnit.audit` field — none of this file's tests exercise it). */
const unexpectedAuditCall = (): never => {
  throw new Error("unexpected audit-repository call on the fake store");
};

/** A loud-throwing `audit` stub, shared by every fake store in this file. */
const stubAuditRepository: M3LConsoleAuditRepository = {
  insert: unexpectedAuditCall,
  insertAll: unexpectedAuditCall,
  deleteAll: unexpectedAuditCall,
  list: unexpectedAuditCall,
  count: unexpectedAuditCall,
};

/**
 * Builds a {@link FakeConsoleStoreHandle} whose `runs` field is
 * `runsRepository` and whose `sessions` field is `sessionsRepository` — the
 * latter defaults to {@link stubSessionsRepository} so every pre-existing
 * caller in this file (none of which touch `store.sessions`) is unaffected.
 */
function createFakeStore(
  runsRepository: M3LConsoleRunsRepository,
  sessionsRepository: M3LConsoleSessionsRepository = stubSessionsRepository,
): {
  readonly store: FakeConsoleStoreHandle;
  readonly closeCallCount: () => number;
} {
  let closeCalls = 0;
  const unexpectedCall = (): never => {
    throw new Error("unexpected query-executor call on the fake store");
  };
  const unexpectedMetaCall = (): never => {
    throw new Error("unexpected meta-repository call on the fake store");
  };
  const store: FakeConsoleStoreHandle = {
    isOpen: true,
    location: ":memory:",
    schemaVersion: 0,
    close(): void {
      closeCalls += 1;
    },
    all: unexpectedCall,
    get: unexpectedCall,
    run: unexpectedCall,
    script: unexpectedCall,
    meta: { describe: unexpectedMetaCall, history: unexpectedMetaCall },
    runs: runsRepository,
    sessions: sessionsRepository,
    audit: stubAuditRepository,
    transaction: <T>(): T => {
      throw new Error("unexpected transaction() call on the fake store");
    },
  };
  return { store, closeCallCount: () => closeCalls };
}

/**
 * A full `Map`-backed fake {@link M3LConsoleSessionsRepository}, duplicated
 * from `tests/main-sessions.test.ts` per `.claude/rules/tests.md` (small
 * helpers are not shared across test files) — needed here only for the
 * `startConsole` sessions-wiring test below, which requires a *working*
 * `sessions` repository (unlike this file's other tests, which never touch
 * `store.sessions` and use `stubSessionsRepository` instead).
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

/** Builds a TCP `AddressInfo` fixture for a fake server's `address()`. */
function tcpAddress(address = "127.0.0.1", port = 48651): AddressInfo {
  return { address, family: address.includes(":") ? "IPv6" : "IPv4", port };
}

/**
 * A controllable fake `Server`, mirroring `tests/main-store.test.ts`'s own
 * `FakeServer` (duplicated here rather than imported — small test helpers
 * are not shared across test files per `.claude/rules/tests.md`). `calls`
 * is shared with the registry fake above, so `reconcileOrphaned` and
 * `listen` land in one array a test can assert an exact order against.
 */
interface FakeServer {
  readonly instance: Server;
  readonly calls: string[];
  resolveClose: (error?: Error) => void;
  emitListening: () => void;
}

function createFakeServer(calls: string[]): FakeServer {
  const emitter = new EventEmitter();
  const state = {
    pendingCloseCallback: undefined as ((error?: Error) => void) | undefined,
  };
  const extensions = {
    listen(...args: unknown[]): Server {
      void args;
      calls.push("listen");
      return extensions as unknown as Server;
    },
    close(callback?: (error?: Error) => void): Server {
      calls.push("close");
      state.pendingCloseCallback = callback;
      return extensions as unknown as Server;
    },
    closeIdleConnections(): void {
      /* no-op */
    },
    closeAllConnections(): void {
      /* no-op */
    },
    address(): AddressInfo | string | null {
      return tcpAddress();
    },
  };
  const instance = Object.assign(emitter, extensions) as unknown as Server;
  return {
    instance,
    calls,
    resolveClose(error?: Error) {
      state.pendingCloseCallback?.(error);
    },
    emitListening() {
      emitter.emit("listening");
    },
  };
}

/**
 * Starts `startConsole` against a fake server that immediately reports a
 * verified loopback bind once `emitListening` is called — mirrors
 * `tests/main-store.test.ts`'s established timing.
 */
function startWithFakeServer(
  calls: string[],
  overrides: Partial<StartConsoleOptions> = {},
): {
  readonly promise: ReturnType<typeof startConsole>;
  readonly fake: FakeServer;
} {
  const fake = createFakeServer(calls);
  const promise = startConsole({
    env: buildEnv(),
    createServer: () => fake.instance,
    ...overrides,
  });
  fake.emitListening();
  return { promise, fake };
}

describe("createConsoleRuntime — builds a run subsystem when both runsConfig and runs are supplied", () => {
  test("runtime.runs is a working M3LRunSubsystem", () => {
    const registry = createOrderRecordingRegistry([]);

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      runsConfig: MINIMAL_RUNS_CONFIG,
      runs: registry,
    });

    expect(runtime.runs).not.toBeUndefined();
    expect(typeof runtime.runs?.orchestrator.reconcileOnBoot).toBe("function");
    expect(typeof runtime.runs?.drain).toBe("function");
  });
});

describe("createConsoleRuntime — skips the subsystem when M3L_CONSOLE_RUNS_SCRIPTS_DIR is absent, even though 'runs' was supplied", () => {
  test("runtime.runs is undefined, and a warning posture line names the missing variable and the disabled state", () => {
    const handler = new RecordingHandler();
    const registry = createOrderRecordingRegistry([]);

    const runtime = createConsoleRuntime({
      env: buildEnv(),
      runs: registry,
      handlers: [handler],
    });

    expect(runtime.runs).toBeUndefined();

    const warningEvents = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.WARNING,
    );
    expect(warningEvents).toHaveLength(1);
    const rendered = JSON.stringify(warningEvents);
    expect(rendered).toContain("M3L_CONSOLE_RUNS_SCRIPTS_DIR");
    expect(rendered.toLowerCase()).toContain("disabled");
  });
});

describe("createConsoleRuntime — skips the subsystem when 'runs' is absent, even though a config resolves", () => {
  test("runtime.runs is undefined when runsConfig is supplied but 'runs' is not", () => {
    const runtime = createConsoleRuntime({
      env: buildEnv(),
      runsConfig: MINIMAL_RUNS_CONFIG,
    });

    expect(runtime.runs).toBeUndefined();
  });
});

describe("startConsole — boot reconciliation runs strictly before the listener binds", () => {
  test("reconcileOnBoot() is recorded before listen() in call order, not merely 'both happened'", async () => {
    const calls: string[] = [];
    const registry = createOrderRecordingRegistry(calls);
    const { store } = createFakeStore(toRunsRepository(registry));
    const { promise, fake } = startWithFakeServer(calls, {
      runsConfig: MINIMAL_RUNS_CONFIG,
      openStore: () => store,
    });

    const running = await promise;

    expect(fake.calls).toEqual(["reconcileOrphaned", "listen"]);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});

describe("startConsole — a throwing reconcileOnBoot() closes the store and propagates", () => {
  test("the store's close() is called exactly once, and the original cause propagates unchanged", async () => {
    const calls: string[] = [];
    const reconcileError = new Error("boom-reconcile");
    const registry = createOrderRecordingRegistry(calls, {
      reconcileShouldThrow: reconcileError,
    });
    const { store, closeCallCount } = createFakeStore(
      toRunsRepository(registry),
    );
    const fake = createFakeServer(calls);

    const promise = startConsole({
      env: buildEnv(),
      createServer: () => fake.instance,
      runsConfig: MINIMAL_RUNS_CONFIG,
      openStore: () => store,
    });
    // Pre-implementation, nothing calls `reconcileOrphaned` yet, so the bind
    // proceeds normally unless this is emitted — without it the promise
    // would hang until the listener binds, which never happens on its own.
    // Once reconciliation lands ahead of the bind, `emitListening` is simply
    // never reached because the reconciliation failure short-circuits first.
    fake.emitListening();

    await expect(promise).rejects.toThrow(reconcileError);
    expect(closeCallCount()).toBe(1);
    // The listener must never have bound — reconciliation failed first.
    expect(fake.calls).not.toContain("listen");
  });
});

describe("startConsole — the shutdown sequence drains the run subsystem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("shutdown() calls the run subsystem's drain() exactly once", async () => {
    const calls: string[] = [];
    const registry = createOrderRecordingRegistry(calls);
    const { store } = createFakeStore(toRunsRepository(registry));
    const { promise, fake } = startWithFakeServer(calls, {
      runsConfig: MINIMAL_RUNS_CONFIG,
      openStore: () => store,
    });

    const running = await promise;
    const runsSubsystem = running.runtime.runs;
    if (runsSubsystem === undefined) {
      throw new Error("test setup: the run subsystem must be present");
    }
    const drainSpy = vi.spyOn(runsSubsystem, "drain");

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;

    expect(drainSpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// X6 slice 4 round 3 (issue #554): `M3LConsoleRuntimeOptions` gains
// `sessions`/`sessionsConfig`, mirroring the existing `runs`/`runsConfig`
// fields exactly, and `M3LConsoleRuntime` gains `sessions`, mirroring the
// existing `runs` field exactly (same "present only when a sessions
// subsystem was actually built" semantics). Pinned narrowly (per-field,
// mirroring `tests/shutdown.test.ts`'s own established style for pinning
// `M3LConsoleRuntime["runs"]`) rather than an exhaustive `toEqualTypeOf` of
// the whole interface — no such exhaustive pin exists for either type today,
// and a whole-interface pin is needlessly brittle against unrelated field
// changes.
// =============================================================================

describe("M3LConsoleRuntimeOptions / M3LConsoleRuntime — sessions fields (X6 slice 4 round 3, issue #554)", () => {
  test("M3LConsoleRuntimeOptions declares 'sessions'/'sessionsConfig', mirroring the existing 'runs'/'runsConfig' fields exactly", () => {
    expectTypeOf<M3LConsoleRuntimeOptions["sessions"]>().toEqualTypeOf<
      M3LConsoleSessionsRepository | undefined
    >();
    expectTypeOf<M3LConsoleRuntimeOptions["sessionsConfig"]>().toEqualTypeOf<
      M3LConsoleSessionsConfig | undefined
    >();
  });

  test("M3LConsoleRuntime declares 'sessions', mirroring the existing 'runs' field exactly", () => {
    expectTypeOf<M3LConsoleRuntime["sessions"]>().toEqualTypeOf<
      M3LSessionSubsystem | undefined
    >();
  });
});

// =============================================================================
// `startConsole` sessions wiring — `buildRuntimeAndBindListener` fix round 3
// (issue #554): it now passes `sessions: store.sessions` alongside
// `runs: store.runs` into `createConsoleRuntime`. No prior test drove
// `startConsole` (as opposed to `createConsoleRuntime` directly) with a
// store whose `sessions` field is a working repository, so this exact path
// — store handle -> `buildRuntimeAndBindListener` -> `createConsoleRuntime`
// -> built session subsystem — went unexercised.
// =============================================================================

describe("startConsole — sessions: store.sessions reaches createConsoleRuntime (issue #554 fix)", () => {
  test("running.runtime.sessions is a working M3LSessionSubsystem built from store.sessions", async () => {
    const calls: string[] = [];
    const registry = createOrderRecordingRegistry(calls);
    const { store } = createFakeStore(
      toRunsRepository(registry),
      createFakeSessionsRepository(),
    );
    const { promise, fake } = startWithFakeServer(calls, {
      runsConfig: MINIMAL_RUNS_CONFIG,
      openStore: () => store,
    });

    const running = await promise;

    expect(running.runtime.sessions).not.toBeUndefined();
    const created = running.runtime.sessions?.service.createSession(
      "ada",
      "corr-1",
    );
    expect(created?.status).toBe("open");
    expect(created?.operator).toBe("ada");

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});

// =============================================================================
// The sibling of the #554 test above, for X7c's `audit` hand-off.
//
// `buildRuntimeAndBindListener` passes `audit: store.audit` alongside
// `runs`/`sessions`, and the runtime has no `audit` field to read it back from
// (the index is not republished — it is consumed by the composed audit port).
// So this asserts the hand-off directly: that `startConsole` READS
// `store.audit` at all. Drop that line from `main.ts` and this fails.
//
// What the repository then does with a real request is proved end-to-end in
// `tests/main-audit.test.ts` ("options.audit reaches the composed audit port"),
// which drives `POST /api/v1/runs` through the composed listener.
// =============================================================================
describe("startConsole — audit: store.audit reaches createConsoleRuntime (X7c)", () => {
  test("the store's audit repository is read during runtime construction", async () => {
    const calls: string[] = [];
    const registry = createOrderRecordingRegistry(calls);
    const { store } = createFakeStore(toRunsRepository(registry));
    let auditReads = 0;
    Object.defineProperty(store, "audit", {
      configurable: true,
      get: (): M3LConsoleAuditRepository => {
        auditReads += 1;
        return stubAuditRepository;
      },
    });

    const { promise, fake } = startWithFakeServer(calls, {
      runsConfig: MINIMAL_RUNS_CONFIG,
      openStore: () => store,
    });
    const running = await promise;

    expect(auditReads).toBeGreaterThan(0);

    const shutdownPromise = running.shutdown();
    fake.resolveClose();
    await shutdownPromise;
  });
});
