/**
 * Tests for `src/main.ts`'s X6 workbench-sessions module wiring (slice 4,
 * Part B round 3, issue #554): `M3LConsoleRuntimeOptions.sessions`/
 * `sessionsConfig`, `M3LConsoleRuntime.sessions`, and the session REST
 * routes actually mounted and reachable through the live
 * `runtime.requestListener` — mirrors `tests/main-runs.test.ts`'s own
 * end-to-end wiring coverage for the run subsystem, one slice over.
 *
 * RED until `main.ts` gains `sessions`/`sessionsConfig`, builds the
 * subsystem (via `src/subsystems.ts`'s `buildConsoleSubsystems`, once that
 * module exists), and wires `createSessionRoutes` into the dispatch router
 * through `http/routes/built-in.ts`'s new `toSessionsRouteOptions`.
 *
 * No real socket and no real OS signal delivery is ever used — a fake
 * `IncomingMessage`/`ServerResponse` pair (mirroring `tests/main.test.ts`/
 * `tests/main-runs.test.ts`) drives the live `requestListener` end to end.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createConsoleRuntime } from "../src/main.js";
import type { M3LConsoleRuntimeOptions } from "../src/main.js";
import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
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
import type { M3LRunRegistry } from "../src/runs/registry.js";

/** A tmpdir root for everything this file writes, replaced per test. */
let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "m3l-console-sessions-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * A minimal valid env: the required operator name, plus the two data roots
 * this file's audited session writes actually reach, pointed inside
 * {@link workDir} (mirroring `tests/main-audit.test.ts`).
 *
 * The audit root is NOT optional here: `POST /api/v1/sessions` performs an
 * audited write, and the routes below are driven through the live
 * `requestListener` — so without an override this file appends a real
 * segment to the checkout's own `data/console/audit/`. That path is
 * gitignored at directory level, so no gate ever sees it.
 */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(workDir, "audit"),
    M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT: path.join(workDir, "sessions"),
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

/**
 * A `M3LRunRegistry` fake whose every method throws — sufficient here since
 * none of this file's tests ever launch or reconcile a run; only the
 * session subsystem's construction (which needs a `launcher`, i.e. a
 * successfully built run subsystem, but never actually calls into the
 * registry to do so) is under test.
 */
function createUnusedRunRegistry(): M3LRunRegistry {
  const unexpectedCall = (): never => {
    throw new Error("unexpected call on unused fake run registry");
  };
  return {
    insertQueued: unexpectedCall,
    claimForStart: unexpectedCall,
    finish: unexpectedCall,
    get: unexpectedCall,
    list: unexpectedCall,
    countRunningForScript: unexpectedCall,
    abandonQueued: unexpectedCall,
    reconcileOrphaned: unexpectedCall,
  };
}

// Referenced only for their field types below — silences an unused-import
// diagnostic that would otherwise fire once `M3LRunInsert` etc. are used
// solely inside `createUnusedRunRegistry`'s structural return type.
void (null as unknown as M3LRunInsert);
void (null as unknown as M3LRunFinish);
void (null as unknown as M3LRunListQuery);
void (null as unknown as M3LRunRecord);

/**
 * A full `Map`-backed fake {@link M3LConsoleSessionsRepository}, duplicated
 * from `tests/sessions-composition.test.ts`/`tests/subsystems.test.ts` per
 * `.claude/rules/tests.md` (small helpers are not shared across test
 * files).
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

/**
 * Builds {@link M3LConsoleRuntimeOptions} common to every scenario in this
 * file: a valid env, a resolvable runs config, and an (unused) run
 * registry — the run subsystem must successfully build for the session
 * subsystem to ever build (it needs a launcher), regardless of whether a
 * given scenario supplies `sessions`/`sessionsConfig` on top.
 */
function baseOptions(
  overrides: Partial<M3LConsoleRuntimeOptions> = {},
): M3LConsoleRuntimeOptions {
  return {
    env: buildEnv(),
    runsConfig: MINIMAL_RUNS_CONFIG,
    runs: createUnusedRunRegistry(),
    ...overrides,
  };
}

/**
 * Builds a minimal `IncomingMessage` double — an `EventEmitter` carrying
 * just the members the request listener reads, plus the `end` event a
 * body-bearing method's `readJsonBody` waits on. Mirrors
 * `tests/main.test.ts`'s established pattern; no `content-length` header is
 * set, so `readJsonBody` streams to `end` and resolves `undefined` having
 * read zero bytes — exactly what `POST /api/v1/sessions`' handler needs
 * (it never reads `ctx.body`).
 */
function createFakeIncomingMessage(
  overrides: Partial<Pick<IncomingMessage, "method" | "url" | "headers">> = {},
): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(req, {
    method: "GET",
    url: "/",
    headers: { host: "127.0.0.1" },
    ...overrides,
  });
  if ((overrides.method ?? "GET").toUpperCase() !== "GET") {
    queueMicrotask(() => {
      req.emit("end");
    });
  }
  return req;
}

/** What a {@link createRecordingServerResponse} double actually had written to it. */
interface RecordedWrite {
  status?: number;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
}

/**
 * Builds a `ServerResponse` double that records `writeHead`/`end` calls,
 * mirroring `tests/main.test.ts`'s established pattern. No real socket.
 */
function createRecordingServerResponse(): {
  readonly res: ServerResponse;
  readonly written: RecordedWrite;
  readonly finished: Promise<void>;
} {
  const written: RecordedWrite = {};
  const res = new EventEmitter() as unknown as ServerResponse & {
    headersSent: boolean;
    writableEnded: boolean;
  };
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  Object.assign(res, {
    writableEnded: false,
    headersSent: false,
    writeHead: (
      status: number,
      headers?: Readonly<Record<string, string>>,
    ): ServerResponse => {
      written.status = status;
      written.headers = headers;
      res.headersSent = true;
      return res;
    },
    end: (body?: string): ServerResponse => {
      written.body = body;
      res.writableEnded = true;
      resolveFinished();
      return res;
    },
  });
  return { res, written, finished };
}

/**
 * Races `promise` against a short timeout that rejects with a clear
 * message, mirroring `tests/main.test.ts`'s established pattern.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  ms = 1000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("createConsoleRuntime — builds a session subsystem when sessions/runs are both supplied", () => {
  test("runtime.sessions is a working M3LSessionSubsystem", () => {
    const runtime = createConsoleRuntime(
      baseOptions({ sessions: createFakeSessionsRepository() }),
    );

    expect(runtime.sessions).not.toBeUndefined();
    expect(typeof runtime.sessions?.service.createSession).toBe("function");
    expect(typeof runtime.sessions?.eventSink.publish).toBe("function");
  });
});

describe("createConsoleRuntime — session REST routes are mounted and reachable end to end", () => {
  test("POST /api/v1/sessions through the live requestListener returns 201 with a session record", async () => {
    const runtime = createConsoleRuntime(
      baseOptions({ sessions: createFakeSessionsRepository() }),
    );

    const req = createFakeIncomingMessage({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1" },
    });
    const { res, written, finished } = createRecordingServerResponse();

    runtime.requestListener(req, res);
    await withTimeout(
      finished,
      "requestListener never called res.end() for POST /api/v1/sessions",
    );

    expect(written.status).toBe(201);
    const body = JSON.parse(written.body ?? "null") as {
      id: unknown;
      status: unknown;
      operator: unknown;
    };
    expect(body.status).toBe("open");
    expect(body.operator).toBe("ada");
    expect(typeof body.id).toBe("string");
  });
});

describe("createConsoleRuntime — no 'sessions' option means no session routes at all", () => {
  test("runtime.sessions is undefined, and POST /api/v1/sessions returns 404 (no 'registered but always 404' middle state)", async () => {
    const runtime = createConsoleRuntime(baseOptions());

    expect(runtime.sessions).toBeUndefined();

    const req = createFakeIncomingMessage({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1" },
    });
    const { res, written, finished } = createRecordingServerResponse();

    runtime.requestListener(req, res);
    await withTimeout(
      finished,
      "requestListener never called res.end() for POST /api/v1/sessions",
    );

    expect(written.status).toBe(404);
  });
});
