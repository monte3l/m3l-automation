/**
 * Tests for `src/sessions/flow-export-writer.ts` — `exportSessionFlow` (X13
 * session-flow-export module, issue #561, PR 5/6).
 *
 * RED: `../src/sessions/flow-export-writer.ts` does not exist yet — every
 * import from it below is expected to fail to resolve until the implementer
 * lands it.
 *
 * `exportSessionFlow` composes `buildSessionFlowExport` (pure domain
 * composition, already implemented in `sessions/flow-export.ts`, PR 4/6)
 * with a real filesystem write. Fixtures mirror
 * `sessions-flow-export.test.ts`'s own fake-repository shape (a minimal,
 * Map-free fake backing only the read methods this module needs).
 *
 * Real filesystem I/O is confined to a per-test `mkdtemp` sandbox, per this
 * repo's test-I/O policy.
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildSessionFlowExport } from "../src/sessions/flow-export.js";
import type { SessionFlowExportDependencies } from "../src/sessions/flow-export.js";
import { exportSessionFlow } from "../src/sessions/flow-export-writer.js";
import type { M3LSessionFlowWriteResult } from "../src/sessions/flow-export-writer.js";
import { isConsoleError } from "../src/errors/console-error.js";
import type { M3LConsoleError } from "../src/errors/console-error.js";
import { errnoCodeOf } from "../src/errors/errno.js";
import type {
  M3LConsoleSessionsRepository,
  M3LSessionBindingRecord,
  M3LSessionDecisionRecord,
  M3LSessionRecord,
  M3LSessionStepRecord,
} from "../src/store/sessions-repository-types.js";
import type { M3LSessionScriptCatalogPort } from "../src/sessions/ports.js";

// ---------------------------------------------------------------------------
// Temp sandbox lifecycle
// ---------------------------------------------------------------------------

const createdRoots: string[] = [];

/**
 * Directories `chmod`'d unwritable by a test, restored before the sandbox
 * removal above — matches `session-artifact-retention.test.ts`'s idiom: a
 * directory left at `0o500` cannot have its own entries unlinked, so
 * restoring write permission has to run before `rmSync` reaches it.
 */
let chmodTargets: string[];

beforeEach(() => {
  chmodTargets = [];
});

afterEach(async () => {
  for (const dir of chmodTargets) {
    await chmod(dir, 0o700).catch(() => undefined);
  }
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Creates a fresh, real temp directory, tracked for removal in `afterEach`. */
function createSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "m3l-flow-export-writer-"));
  createdRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// Fixture builders (mirrors sessions-flow-export.test.ts's own idiom)
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

const FIXED_NOW_ISO = "2026-09-12T00:00:00.000Z";

function deps(
  repositoryOptions: FakeRepositoryOptions = {},
): SessionFlowExportDependencies {
  return {
    sessionsRepository: createFakeRepository(repositoryOptions),
    scripts: nonSecretCatalog(),
    now: () => new Date(FIXED_NOW_ISO),
  };
}

/** One valid session with one successful step — the common non-empty fixture. */
function nonEmptySessionDeps(): SessionFlowExportDependencies {
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
  return deps({ session, steps });
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
// Happy path
// ---------------------------------------------------------------------------

describe("exportSessionFlow — happy path", () => {
  test("writes <flowsDirectory>/<name>.yaml matching result.yaml byte-for-byte, and every other field matches buildSessionFlowExport alone", async () => {
    const flowsDirectory = createSandbox();
    const dependencies = nonEmptySessionDeps();

    const result: M3LSessionFlowWriteResult = await exportSessionFlow(
      dependencies,
      flowsDirectory,
      "session-1",
      { name: "dlq-reconcile" },
    );

    const expectedPath = join(flowsDirectory, "dlq-reconcile.yaml");
    expect(result.path).toBe(expectedPath);

    const onDisk = await readFile(expectedPath, "utf8");
    expect(onDisk).toBe(result.yaml);

    const pureResult = await buildSessionFlowExport(dependencies, "session-1", {
      name: "dlq-reconcile",
    });
    expect(result.name).toBe(pureResult.name);
    expect(result.steps).toEqual(pureResult.steps);
    expect(result.decisionsDropped).toBe(pureResult.decisionsDropped);
    expect(result.yaml).toBe(pureResult.yaml);
  });
});

// ---------------------------------------------------------------------------
// Collision handling
// ---------------------------------------------------------------------------

describe("exportSessionFlow — collision, no overwrite", () => {
  test("refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_EXISTS and leaves the pre-existing file unchanged", async () => {
    const flowsDirectory = createSandbox();
    const targetPath = join(flowsDirectory, "dlq-reconcile.yaml");
    const preExistingContent = "pre-existing content, must survive untouched";
    writeFileSync(targetPath, preExistingContent, "utf8");

    const error = await captureFailure(() =>
      exportSessionFlow(nonEmptySessionDeps(), flowsDirectory, "session-1", {
        name: "dlq-reconcile",
      }),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_EXISTS");
    }

    const onDisk = readFileSync(targetPath, "utf8");
    expect(onDisk).toBe(preExistingContent);
  });
});

describe("exportSessionFlow — collision, overwrite: true", () => {
  test("succeeds and the file's new content matches result.yaml", async () => {
    const flowsDirectory = createSandbox();
    const targetPath = join(flowsDirectory, "dlq-reconcile.yaml");
    writeFileSync(targetPath, "stale content, must be replaced", "utf8");

    const result = await exportSessionFlow(
      nonEmptySessionDeps(),
      flowsDirectory,
      "session-1",
      { name: "dlq-reconcile", overwrite: true },
    );

    const onDisk = readFileSync(targetPath, "utf8");
    expect(onDisk).toBe(result.yaml);
    expect(onDisk).not.toBe("stale content, must be replaced");
  });
});

// ---------------------------------------------------------------------------
// flowsDirectory does not exist yet
// ---------------------------------------------------------------------------

describe("exportSessionFlow — flowsDirectory does not exist yet", () => {
  test("creates the directory (recursively) and writes the file successfully", async () => {
    const parent = createSandbox();
    // Deliberately NOT pre-created: a nested path under `parent`.
    const flowsDirectory = join(parent, "nested", "flows");

    const result = await exportSessionFlow(
      nonEmptySessionDeps(),
      flowsDirectory,
      "session-1",
      { name: "dlq-reconcile" },
    );

    const onDisk = await readFile(result.path, "utf8");
    expect(onDisk).toBe(result.yaml);
  });
});

// ---------------------------------------------------------------------------
// Composition failure propagates, no partial write
// ---------------------------------------------------------------------------

describe("exportSessionFlow — a composition failure from buildSessionFlowExport propagates unchanged", () => {
  test("an empty session refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY and writes nothing to flowsDirectory", async () => {
    const flowsDirectory = createSandbox();
    const session = sessionRecord();
    const dependencies = deps({ session, steps: [] });

    const error = await captureFailure(() =>
      exportSessionFlow(dependencies, flowsDirectory, "session-1", {
        name: "dlq-reconcile",
      }),
    );

    expect(isConsoleError(error)).toBe(true);
    if (isConsoleError(error)) {
      expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_EMPTY");
    }

    const entries = readdirSync(flowsDirectory);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-EEXIST write failure -> ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID
// ---------------------------------------------------------------------------

describe("exportSessionFlow — a non-EEXIST write failure", () => {
  // Root ignores permission bits entirely, so the chmod-based failure test
  // would be flaky (never fail) under it — same guard as
  // `audit-stream.test.ts` and `session-artifact-retention.test.ts`.
  const skipAsRoot = process.getuid?.() === 0;

  test.skipIf(skipAsRoot)(
    "an unwritable flowsDirectory refuses with ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID, chaining the real EACCES as cause",
    async () => {
      const flowsDirectory = createSandbox();
      // `mkdir(flowsDirectory, { recursive: true })` succeeds unconditionally
      // on an already-existing directory (no write needed to stat it), so
      // only the subsequent `writeFile` trips the permission failure —
      // exercising the write path, not a directory-creation failure.
      await chmod(flowsDirectory, 0o500);
      chmodTargets.push(flowsDirectory);

      const error = await captureFailure(() =>
        exportSessionFlow(nonEmptySessionDeps(), flowsDirectory, "session-1", {
          name: "dlq-reconcile",
        }),
      );

      expect(isConsoleError(error)).toBe(true);
      if (isConsoleError(error)) {
        expect(error.code).toBe("ERR_CONSOLE_SESSION_FLOW_EXPORT_INVALID");
      }

      const cause = (error as M3LConsoleError).cause;
      expect(cause).toBeInstanceOf(Error);
      expect(errnoCodeOf(cause)).toBe("EACCES");
    },
  );
});
