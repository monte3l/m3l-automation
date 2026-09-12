/**
 * `sessions-service-flow-export-wiring` — proves `createSessionService`'s
 * ASSEMBLY: that the real factory threads its `scripts`/`flowsDirectory`
 * options through to a working `exportFlow()`, end to end, against a real
 * (mkdtemp-sandboxed) filesystem.
 *
 * Split out of `sessions-service.test.ts` purely to keep that file under the
 * 60,000-byte test-file-budget cap (`bin/check-file-budget.mjs`, ADR-0072) —
 * a pure, behavior-preserving extraction (the `M3LSessionService —
 * exportFlow()` describe block plus its dedicated real-mkdtemp sandbox
 * lifecycle), not a design change. This is deliberately distinct from
 * `sessions-service-flow-export.test.ts`, which tests
 * `service-flow-export.ts`'s `buildSessionFlowExportMethods` directly, in
 * isolation from `createSessionService`'s own wiring.
 *
 * The fake `M3LConsoleSessionsRepository`/`M3LSessionArtifactStore`/launcher
 * collaborators below are duplicated (not imported) from
 * `sessions-service.test.ts`'s own fakes, since this file exercises a single
 * scenario and importing that file's much larger fixture surface just for
 * one test would defeat the byte-budget split this file exists for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { M3LSessionArtifactRef } from "../src/sessions/artifact-codec.js";
import type { M3LSessionArtifactStore } from "../src/sessions/artifacts.js";
import type { M3LSessionScriptCatalogPort } from "../src/sessions/ports.js";
import { createSessionService } from "../src/sessions/service.js";
import type { M3LSessionService } from "../src/sessions/service.js";
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
// Real mkdtemp sandbox lifecycle — for the X13 exportFlow() thin-delegation
// test's real `flowsDirectory` only.
// ---------------------------------------------------------------------------

const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Creates a fresh, real temp directory, tracked for removal in `afterEach`. */
function createFlowsDirectorySandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "m3l-session-service-flow-export-"));
  createdRoots.push(root);
  return root;
}

/** No script declares any secret parameter — the default `scripts` fixture. */
function nonSecretCatalog(): M3LSessionScriptCatalogPort {
  return {
    describe: () =>
      Promise.resolve({
        parameters: [{ name: "command", aliases: [], secret: false }],
      }),
  };
}

// ---------------------------------------------------------------------------
// Fake M3LConsoleSessionsRepository — Map-backed, guarded-write semantics.
// Duplicated from sessions-service.test.ts's own fake (see file header).
// ---------------------------------------------------------------------------

/** The narrow slice of `M3LConsoleSessionsRepository` (plus the two new Part-A methods) this service depends on. */
interface FakeSessionsRepository extends M3LConsoleSessionsRepository {
  attachStepRun(id: string, runId: string): boolean;
  getStepByRunId(runId: string): M3LSessionStepRecord | undefined;
}

function createFakeSessionsRepository(): FakeSessionsRepository {
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
// Fake M3LSessionArtifactStore — pure in-memory, no filesystem I/O.
// Duplicated from sessions-service.test.ts's own fake (see file header).
// ---------------------------------------------------------------------------

function createFakeArtifactStore(): M3LSessionArtifactStore {
  const fileArtifacts = new Map<string, unknown>();
  return {
    put(
      _sessionId: string,
      _stepId: string,
      payload: unknown,
    ): Promise<M3LSessionArtifactRef> {
      return Promise.resolve({ kind: "inline", value: payload });
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
// Fake M3LSessionRunLauncherPort.
// Duplicated from sessions-service.test.ts's own fake (see file header).
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

function createFakeLauncher(): {
  launch(request: FakeLaunchRequest): FakeRunHandle;
} {
  let index = 0;
  return {
    launch(request: FakeLaunchRequest): FakeRunHandle {
      const handle: FakeRunHandle = {
        id: `run-${String(index)}`,
        scriptName: request.body.scriptName,
        status: "running",
        dryRun: request.body.dryRun,
        executionMode: "spawn",
      };
      index += 1;
      return handle;
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Builds a real `M3LSessionService` wired to real (sandboxed) `flowsDirectory`, otherwise fully faked. */
function buildServiceWithFlowsDirectory(
  flowsDirectory: string,
): M3LSessionService {
  let idCounter = 0;
  return createSessionService({
    sessionsRepository: createFakeSessionsRepository(),
    artifactStore: createFakeArtifactStore(),
    launcher: createFakeLauncher(),
    openSessionsMax: 10,
    newId: () => `id-${String(idCounter++)}`,
    nowMs: () => 1_000,
    scripts: nonSecretCatalog(),
    flowsDirectory,
  });
}

// ---------------------------------------------------------------------------
// exportFlow() — X13 Round B: proves the two new option fields
// (`scripts`/`flowsDirectory`) are actually threaded through the service's
// spread wiring, not a re-test of Round A's/`sessions/service-flow-export.ts`'s
// own full contract (owned by `sessions-flow-export-writer.test.ts` and
// `sessions-service-flow-export.test.ts`).
// ---------------------------------------------------------------------------

describe("M3LSessionService — exportFlow()", () => {
  test("createSessionService threads scripts/flowsDirectory through to a working exportFlow", async () => {
    const flowsDirectory = createFlowsDirectorySandbox();
    const service = buildServiceWithFlowsDirectory(flowsDirectory);

    const session = service.createSession("alice", "corr-1");
    await service.addStep(session.id, {
      operation: "sqs-etl",
      bindings: [],
      confirmed: true,
      dryRun: false,
      operator: "alice",
      correlationId: "corr-2",
    });

    const result = await service.exportFlow(session.id, {
      name: "dlq-reconcile",
    });

    expect(result.name).toBe("dlq-reconcile");
    expect(result.path).toBe(join(flowsDirectory, "dlq-reconcile.yaml"));
    const onDisk = await readFile(result.path, "utf8");
    expect(onDisk).toBe(result.yaml);
  });
});
