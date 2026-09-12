/**
 * Tests for `src/sessions/service-flow-export.ts` — `buildSessionFlowExportMethods`
 * (X13 session-flow-export module, issue #561, PR 5/6, Round B: the wiring
 * layer).
 *
 * RED: `../src/sessions/service-flow-export.ts` does not exist yet — every
 * import from it below is expected to fail to resolve until the implementer
 * lands it.
 *
 * This is a THIN-DELEGATION proof, not a re-test of Round A's
 * `exportSessionFlow`/PR 4's `buildSessionFlowExport` logic — those already
 * own the full matrix (`tests/sessions-flow-export-writer.test.ts`,
 * `tests/sessions-flow-export.test.ts`). Exactly one happy-path case and one
 * error-propagation case, per the dispatching brief.
 *
 * Fixtures mirror `tests/sessions-flow-export-writer.test.ts`'s own
 * fake-repository/fake-catalog shapes exactly (a minimal, Map-free fake
 * backing only the read methods this module needs), plus a real `mkdtemp`
 * sandbox for `flowsDirectory` per this repo's test-I/O policy.
 *
 * **Dependency type name:** this file imports
 * `SessionFlowExportServiceDependencies` from the module — the implementer's
 * chosen name, distinct from `sessions/flow-export.ts`'s own
 * `SessionFlowExportDependencies` (a different shape: `sessionsRepository`,
 * `scripts`, `now` — no `flowsDirectory`) to avoid the near-miss-shape name
 * collision the original dispatching brief only guessed at.
 *
 * @packageDocumentation
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { isConsoleError } from "../src/errors/console-error.js";
import { buildSessionFlowExportMethods } from "../src/sessions/service-flow-export.js";
import type { SessionFlowExportServiceDependencies } from "../src/sessions/service-flow-export.js";
import type { M3LSessionScriptCatalogPort } from "../src/sessions/ports.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingRecord,
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepRecord,
} from "../src/store/sessions-repository-types.js";

// ---------------------------------------------------------------------------
// Temp sandbox lifecycle
// ---------------------------------------------------------------------------

/**
 * Fixed clock value for `nowMs`, matching `sessions-flow-export.test.ts`'s
 * own `FIXED_NOW_ISO` convention (same instant, epoch-ms form) — this
 * module doesn't assert on the timestamp itself, but a fixed value keeps
 * the fixture deterministic rather than reaching for `Date.now()`.
 */
const FIXED_NOW_MS = Date.parse("2026-09-12T00:00:00.000Z");

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
function createSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "m3l-service-flow-export-"));
  createdRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// Fixture builders (mirrors sessions-flow-export-writer.test.ts's own idiom)
// ---------------------------------------------------------------------------

function sessionRecord(id = "session-1"): M3LSessionRecord {
  return {
    id,
    operator: "ada",
    correlationId: "corr-1",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    status: "open",
  };
}

function stepRecord(fields: {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly operation: string;
  readonly parameters: unknown;
}): M3LSessionStepRecord {
  return {
    id: fields.id,
    sessionId: fields.sessionId,
    ordinal: fields.ordinal,
    operation: fields.operation,
    parameters: fields.parameters,
    runId: undefined,
    status: "success",
    resultRef: undefined,
    queuedAtMs: 1_000,
    startedAtMs: 1_000,
    endedAtMs: 1_500,
    outcome: "success",
    failureMessage: undefined,
  };
}

function notImplemented(name: string): never {
  throw new Error(`fake repository: '${name}' is not implemented`);
}

interface FakeRepositoryOptions {
  readonly session?: M3LSessionRecord;
  readonly steps?: readonly M3LSessionStepRecord[];
  readonly bindings?: readonly M3LSessionBindingRecord[];
  readonly decisions?: readonly M3LSessionDecisionRecord[];
}

/** A minimal, Map-free fake repository backing only the three read methods this module needs. */
function createFakeRepository(
  options: FakeRepositoryOptions = {},
): M3LConsoleSessionsRepository {
  return {
    insertSession: () => notImplemented("insertSession"),
    getSession: (id: string) =>
      options.session?.id === id ? options.session : undefined,
    listSessions: () => notImplemented("listSessions"),
    closeSession: () => notImplemented("closeSession"),
    reopenSession: () => notImplemented("reopenSession"),
    insertStep: () => notImplemented("insertStep"),
    claimStepForStart: () => notImplemented("claimStepForStart"),
    finishStep: () => notImplemented("finishStep"),
    getStep: () => notImplemented("getStep"),
    getStepByOrdinal: () => notImplemented("getStepByOrdinal"),
    listStepsForSession: (sessionId: string) =>
      options.session?.id === sessionId ? (options.steps ?? []) : [],
    attachStepRun: () => notImplemented("attachStepRun"),
    getStepByRunId: () => notImplemented("getStepByRunId"),
    insertBinding: () => notImplemented("insertBinding"),
    listBindingsForSession: (sessionId: string) =>
      options.session?.id === sessionId ? (options.bindings ?? []) : [],
    insertDecision: () => notImplemented("insertDecision"),
    answerDecision: () => notImplemented("answerDecision"),
    getDecision: () => notImplemented("getDecision"),
    listDecisionsForSession: (sessionId: string) =>
      options.session?.id === sessionId ? (options.decisions ?? []) : [],
    countOpenSessions: () => notImplemented("countOpenSessions"),
  };
}

/** No script declares any secret parameter. */
function nonSecretCatalog(): M3LSessionScriptCatalogPort {
  return {
    describe: () =>
      Promise.resolve({
        parameters: [{ name: "command", aliases: [], secret: false }],
      }),
  };
}

/** One valid session with one successful step — the common non-empty fixture. */
function buildNonEmptyDependencies(
  flowsDirectory: string,
): SessionFlowExportServiceDependencies {
  const session = sessionRecord();
  const steps = [
    stepRecord({
      id: "step-record-1",
      sessionId: session.id,
      ordinal: 1,
      operation: "sqs-etl",
      parameters: { command: "list-queues" },
    }),
  ];
  return {
    sessionsRepository: createFakeRepository({ session, steps }),
    scripts: nonSecretCatalog(),
    flowsDirectory,
    nowMs: () => FIXED_NOW_MS,
  };
}

/** Captures whatever `run` rejects with, as a single `unknown` value. */
async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// Happy path — thin delegation
// ---------------------------------------------------------------------------

describe("buildSessionFlowExportMethods(dependencies).exportFlow — happy path", () => {
  test("writes the flow file and returns the same shape a direct exportSessionFlow call would", async () => {
    const flowsDirectory = createSandbox();
    const dependencies = buildNonEmptyDependencies(flowsDirectory);

    const result = await buildSessionFlowExportMethods(dependencies).exportFlow(
      "session-1",
      { name: "dlq-reconcile" },
    );

    const expectedPath = join(flowsDirectory, "dlq-reconcile.yaml");
    expect(result.path).toBe(expectedPath);
    expect(result.name).toBe("dlq-reconcile");
    expect(result.steps).toHaveLength(1);
    expect(result.decisionsDropped).toBe(0);

    const onDisk = await readFile(expectedPath, "utf8");
    expect(onDisk).toBe(result.yaml);
  });
});

// ---------------------------------------------------------------------------
// Error propagation — unchanged
// ---------------------------------------------------------------------------

describe("buildSessionFlowExportMethods(dependencies).exportFlow — error propagation", () => {
  test("an empty session's ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY propagates unchanged", async () => {
    const flowsDirectory = createSandbox();
    const session = sessionRecord();
    const dependencies: SessionFlowExportServiceDependencies = {
      sessionsRepository: createFakeRepository({ session, steps: [] }),
      scripts: nonSecretCatalog(),
      flowsDirectory,
      nowMs: () => FIXED_NOW_MS,
    };

    const error = await captureFailure(() =>
      buildSessionFlowExportMethods(dependencies).exportFlow("session-1", {
        name: "dlq-reconcile",
      }),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY");
    }
  });
});

// ---------------------------------------------------------------------------
// SessionFlowExportMethods — exact interface shape
// ---------------------------------------------------------------------------

describe("SessionFlowExportMethods", () => {
  test("exposes exactly one method: exportFlow", () => {
    const flowsDirectory = createSandbox();
    const methods = buildSessionFlowExportMethods(
      buildNonEmptyDependencies(flowsDirectory),
    );

    expect(Object.keys(methods)).toEqual(["exportFlow"]);
    expect(typeof methods.exportFlow).toBe("function");
  });
});
