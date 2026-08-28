/**
 * Tests for src/runs/composition.ts — `createRunSubsystem` (m3l-console-server
 * X4 slice 6 round 3a contract): the one-call factory that builds a real
 * governor/policy/audit-sink/event-sink/spawn-executor/in-process-executor
 * and wires them into a real `M3LRunOrchestrator`.
 *
 * `createRunGovernor` and `createConfirmationPolicy` are the behaviour under
 * test here (composition must actually forward `config`'s knobs to them), so
 * neither is mocked — only `node:fs`'s `existsSync` (resolver) and
 * `node:child_process`'s `spawn` (so a "running" launch never touches a real
 * process) are mocked, both via the async-factory form that preserves every
 * other real export (mirrors `runs-resolver.test.ts`/`runs-orchestrator.test.ts`).
 * A registry is a local in-memory fake — `runs/registry.ts`'s own port, not
 * the real store, since this file's subject is composition wiring, not
 * persistence (that is `store-open.test.ts`'s and `runs-orchestrator.test.ts`'s
 * job respectively).
 *
 * RED: `../src/runs/composition.ts` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands the module.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createRunSubsystem } from "../src/runs/composition.js";
import type {
  M3LRunSubsystem,
  M3LRunSubsystemOptions,
} from "../src/runs/composition.js";
import type { M3LRunEvent } from "../src/runs/events.js";
import type {
  M3LRunOrchestrator,
  M3LRunOrchestratorConfig,
} from "../src/runs/orchestrator.js";
import type { M3LRunRegistry } from "../src/runs/registry.js";
import type { M3LEventStreamHub } from "../src/stream/event-stream.js";
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

const SCRIPTS_ROOT = "/scripts";

/**
 * Configures `fs.existsSync` so `resolveScript` succeeds for any kebab-case
 * name under `SCRIPTS_ROOT` with no `dist/command.js` — i.e. every launch
 * below runs the SPAWN executor, the one whose underlying `spawn` call is
 * mocked, never the in-process one.
 */
function mockScriptResolvable(): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) => !String(target).endsWith("command.js"),
  );
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
 * exit code `0` — simulating a graceful `SIGTERM` response. This is what
 * lets a test observe "the run's signal was aborted" (the kill call) while
 * still letting `drain()`/the run's own promise resolve.
 */
function createHangingSpawnedProcess(): {
  readonly childHandle: FakeSpawnedProcess;
  readonly killSignals: string[];
} {
  let closeListener:
    ((code: number | null, signal: string | null) => void) | undefined;
  const killSignals: string[] = [];

  const childHandle: FakeSpawnedProcess = {
    stdout: null,
    stderr: null,
    kill(signal?: string): boolean {
      killSignals.push(signal ?? "");
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

  return { childHandle, killSignals };
}

/** Wires the mocked `node:child_process` `spawn` to return `childHandle` for every call. */
function mockSpawnReturns(childHandle: FakeSpawnedProcess): void {
  vi.mocked(childProcess.spawn).mockImplementation(
    (() => childHandle) as unknown as typeof childProcess.spawn,
  );
}

/** Builds a fully-populated {@link M3LRunOrchestratorConfig}, overridable per test. */
function buildConfig(
  overrides: Partial<M3LRunOrchestratorConfig> = {},
): M3LRunOrchestratorConfig {
  return {
    scriptsDir: SCRIPTS_ROOT,
    maxPerScript: 4,
    queueCapacity: 16,
    streamRetention: 256,
    killTimeoutMs: 5000,
    maxConcurrency: 4,
    queueTimeoutMs: 30_000,
    ...overrides,
  };
}

/**
 * A `Map`-backed fake {@link M3LRunRegistry}: real enough to drive the
 * orchestrator through insert -> claim -> finish -> reconcile, the same
 * shape as `runs-orchestrator.test.ts`'s own fake, simplified (no call log —
 * this file's subject is wiring, not the orchestrator's internal ordering).
 */
function createFakeRegistry(): M3LRunRegistry {
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

/** Builds {@link M3LRunSubsystemOptions} for `createRunSubsystem`, overridable per test. */
function buildOptions(
  configOverrides: Partial<M3LRunOrchestratorConfig> = {},
): M3LRunSubsystemOptions {
  return {
    config: buildConfig(configOverrides),
    logger: new Core.M3LLogger([]),
    registry: createFakeRegistry(),
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

describe("createRunSubsystem — builds a working subsystem", () => {
  test("exposes an orchestrator that can launch a run, and drain() resolves once it settles", async () => {
    mockScriptResolvable();
    const { childHandle } = createHangingSpawnedProcess();
    mockSpawnReturns(childHandle);

    const subsystem = createRunSubsystem(buildOptions());

    const handle = subsystem.orchestrator.launch(buildDryRunRequest("sqs-etl"));

    expect(handle.status).toBe("running");
    expect(subsystem.orchestrator.activeCount).toBe(1);

    await expect(subsystem.drain()).resolves.toBeUndefined();
    expect(subsystem.orchestrator.activeCount).toBe(0);
  });

  test("drain() aborts an in-flight run's signal — observed as a SIGTERM sent to the spawned process", async () => {
    mockScriptResolvable();
    const { childHandle, killSignals } = createHangingSpawnedProcess();
    mockSpawnReturns(childHandle);

    const subsystem = createRunSubsystem(buildOptions());
    subsystem.orchestrator.launch(buildDryRunRequest("sqs-etl"));

    expect(killSignals).toHaveLength(0);

    await subsystem.drain();

    expect(killSignals).toContain("SIGTERM");
  });
});

describe("createRunSubsystem — config.maxPerScript reaches the real governor", () => {
  test("a second launch of the same script is queued, not started, once maxPerScript's slot is occupied", () => {
    mockScriptResolvable();
    const { childHandle } = createHangingSpawnedProcess();
    mockSpawnReturns(childHandle);

    const subsystem = createRunSubsystem(
      buildOptions({ maxPerScript: 1, maxConcurrency: 10, queueCapacity: 10 }),
    );

    const first = subsystem.orchestrator.launch(buildDryRunRequest("sqs-etl"));
    const second = subsystem.orchestrator.launch(buildDryRunRequest("sqs-etl"));

    expect(first.status).toBe("running");
    expect(second.status).toBe("queued");
    // The second launch never reached an executor — proof it was actually
    // queued rather than started and merely reporting the wrong status.
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("createRunSubsystem — config.queueCapacity reaches the real governor", () => {
  test("a launch that would exceed a zero-capacity queue is rejected with ERR_CONSOLE_RUN_CAPACITY_EXCEEDED", () => {
    mockScriptResolvable();
    const { childHandle } = createHangingSpawnedProcess();
    mockSpawnReturns(childHandle);

    const subsystem = createRunSubsystem(
      buildOptions({ maxConcurrency: 1, maxPerScript: 1, queueCapacity: 0 }),
    );

    subsystem.orchestrator.launch(buildDryRunRequest("sqs-etl"));

    let thrown: unknown;
    try {
      subsystem.orchestrator.launch(buildDryRunRequest("json-etl"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
    );
  });
});

describe("M3LRunSubsystemOptions / M3LRunSubsystem", () => {
  test("have the exact field shapes the contract declares", () => {
    expectTypeOf<M3LRunSubsystemOptions>().toEqualTypeOf<{
      readonly config: M3LRunOrchestratorConfig;
      readonly logger: Core.M3LLogger;
      readonly registry: M3LRunRegistry;
    }>();

    expectTypeOf<M3LRunSubsystem>().toEqualTypeOf<{
      readonly orchestrator: M3LRunOrchestrator;
      readonly eventHub: M3LEventStreamHub<M3LRunEvent>;
      drain(): Promise<void>;
    }>();
  });
});
