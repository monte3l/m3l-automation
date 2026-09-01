/**
 * Tests for src/runs/orchestrator.ts — CORRELATION threading (X7b, ADR-0070):
 * that the correlation id a launch arrived with reaches that run's executor,
 * its registry row, and nothing else.
 *
 * A third orchestrator test file because the sibling two are near the ADR-0072
 * per-file budget (`runs-orchestrator.test.ts` at 53,189 of 60,000).
 *
 * The load-bearing case here is `a queued run is correlated to its OWN
 * launch`. It is the evidence that an `AsyncLocalStorage` would be WRONG for
 * this seam, not merely unnecessary: `pumpQueue` starts a queued run from
 * inside a DIFFERENT run's completion continuation (`finishActiveRun`), so an
 * ambient store would attribute run B's work to whichever request happened to
 * settle first. `onQueueTimeout` and `reconcileOnBoot` have no ambient context
 * at all. Only a value carried on the queued run itself survives the queue.
 *
 * Fakes are copied from `runs-orchestrator-queue.test.ts` rather than imported
 * — this package's established convention (see `runs-events.test.ts`'s own
 * comment on `RecordingHandler`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import type { M3LRunAuditRecord, M3LRunAuditSink } from "../src/runs/audit.js";
import type { M3LRunEvent, M3LRunEventSink } from "../src/runs/events.js";
import type { M3LRunExecutor } from "../src/runs/executor.js";
import type {
  M3LRunGovernor,
  M3LRunGovernorDecision,
} from "../src/runs/governor.js";
import { createRunOrchestrator } from "../src/runs/orchestrator.js";
import type { M3LRunLaunchRequest } from "../src/runs/orchestrator.js";
import type { M3LSpawnExitInfo } from "../src/runs/outcome.js";
import type { M3LRunRequestBody } from "../src/runs/parameters.js";
import type { M3LRunPolicy, M3LRunPolicyVerdict } from "../src/runs/policy.js";
import type { M3LRunRegistry } from "../src/runs/registry.js";
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

afterEach(() => {
  vi.restoreAllMocks();
});

const SCRIPTS_ROOT = "/scripts";

type GovernorDecisionKind = M3LRunGovernorDecision["kind"];
type ExecuteOptions = Parameters<M3LRunExecutor["execute"]>[0];

/** Builds a fully-populated {@link M3LConsoleRunsConfig}, overridable per test. */
function buildConfig(
  overrides: Partial<M3LConsoleRunsConfig> = {},
): M3LConsoleRunsConfig {
  return {
    scriptsDir: SCRIPTS_ROOT,
    maxPerScript: 1,
    queueCapacity: 16,
    streamRetention: 256,
    killTimeoutMs: 5000,
    maxConcurrency: 4,
    queueTimeoutMs: 30_000,
    ...overrides,
  };
}

/** Builds a validated {@link M3LRunLaunchRequest} for `scriptName`. */
function buildRequest(scriptName: string): M3LRunLaunchRequest {
  const body: M3LRunRequestBody = {
    scriptName,
    confirmed: true,
    dryRun: false,
    parameters: {},
  };
  return { body, operator: "ada", correlationId: `corr-${scriptName}` };
}

/** A monotonically increasing id generator, so launch order maps predictably to ids. */
function createIdSequence(prefix: string): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `${prefix}-${String(counter)}`;
  };
}

/** A monotonically increasing fake clock, so `queuedAtMs` orders deterministically. */
function createClock(start = 1_000): () => number {
  let current = start;
  return (): number => {
    current += 1;
    return current;
  };
}

/** A recording `M3LLoggerHandler` fake (mirrors `runs-events.test.ts`'s pattern). */
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
 * A `Map`-backed fake `M3LRunRegistry` — see `runs-orchestrator.test.ts` for
 * full rationale. This file never forces an `insertQueued` failure (that
 * branch is covered there), so unlike its sibling this fake has no
 * throw-injection option.
 */
function createFakeRegistry(
  log: string[],
): M3LRunRegistry & { readonly rows: Map<string, M3LRunRecord> } {
  const rows = new Map<string, M3LRunRecord>();
  return {
    rows,
    insertQueued(input: M3LRunInsert): void {
      log.push(`registry.insertQueued:${input.id}`);
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
      log.push(`registry.claimForStart:${id}`);
      const row = rows.get(id);
      if (row === undefined || row.status !== "queued") return false;
      rows.set(id, { ...row, status: "running", startedAtMs });
      return true;
    },
    finish(id: string, result: M3LRunFinish): boolean {
      log.push(`registry.finish:${id}:${result.outcome}`);
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
      log.push("registry.list");
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
      log.push(`registry.abandonQueued:${id}`);
      const row = rows.get(id);
      if (row === undefined || row.status !== "queued") return false;
      // Deliberately does NOT set startedAtMs — mirrors the real
      // repository's guarded `queued -> interrupted` write, which must
      // never fabricate a started_at_ms for a run that never executed.
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

/**
 * A fake `M3LRunGovernor` keyed by script name: each script's `decide` calls
 * consume `decisionsByScript`'s array in order, falling back to `"accept"`
 * once exhausted — see `runs-orchestrator.test.ts` for full rationale.
 */
function createFakeGovernor(
  log: string[],
  decisionsByScript: Readonly<
    Record<string, readonly GovernorDecisionKind[]>
  > = {},
): M3LRunGovernor {
  const remaining = new Map<string, GovernorDecisionKind[]>(
    Object.entries(decisionsByScript).map(([key, value]) => [key, [...value]]),
  );
  let activeCount = 0;
  let queuedCount = 0;
  return {
    decide(scriptName: string): M3LRunGovernorDecision {
      const queue = remaining.get(scriptName);
      const kind: GovernorDecisionKind =
        queue !== undefined && queue.length > 0
          ? (queue.shift() ?? "accept")
          : "accept";
      log.push(`governor.decide:${scriptName}:${kind}`);
      return { kind };
    },
    accept(scriptName: string): void {
      log.push(`governor.accept:${scriptName}`);
      activeCount += 1;
    },
    release(scriptName: string): void {
      log.push(`governor.release:${scriptName}`);
      activeCount -= 1;
    },
    enqueue(): void {
      log.push("governor.enqueue");
      queuedCount += 1;
    },
    dequeue(): void {
      log.push("governor.dequeue");
      queuedCount -= 1;
    },
    get activeCount(): number {
      return activeCount;
    },
    get queuedCount(): number {
      return queuedCount;
    },
  };
}

/** A fake `M3LRunPolicy` that always allows, recording each call. */
function createFakeAllowPolicy(log: string[]): M3LRunPolicy {
  const verdict: M3LRunPolicyVerdict = { kind: "allow" };
  return {
    evaluate(request): M3LRunPolicyVerdict {
      log.push(`policy.evaluate:${request.scriptName}`);
      return verdict;
    },
  };
}

/** A fake `M3LRunAuditSink` recording every entry into both `log` and `records`. */
function createFakeAudit(
  log: string[],
): M3LRunAuditSink & { readonly records: M3LRunAuditRecord[] } {
  const records: M3LRunAuditRecord[] = [];
  return {
    records,
    record(entry: M3LRunAuditRecord): void {
      log.push(`audit:${entry.action}:${entry.runId ?? "none"}`);
      records.push(entry);
    },
  };
}

/** A fake `M3LRunEventSink` recording every event into both `log` and `published`. */
function createFakeEvents(
  log: string[],
): M3LRunEventSink & { readonly published: M3LRunEvent[] } {
  const published: M3LRunEvent[] = [];
  return {
    published,
    publish(event: M3LRunEvent): void {
      log.push(`event:${event.event}`);
      published.push(event);
    },
  };
}

/** A fake `M3LRunExecutor` that resolves immediately with a fixed outcome; used for the executor slot this file never exercises. */
function createUnusedExecutor(log: string[], name: string): M3LRunExecutor {
  return {
    execute(): Promise<M3LSpawnExitInfo> {
      log.push(`${name}.execute (unexpected)`);
      return Promise.resolve({
        exitCode: 0,
        killRequested: false,
        dryRun: false,
      });
    },
  };
}

/** One deferred `execute()` call: the caller decides when/how it settles. */
interface PendingExecutorCall {
  readonly options: ExecuteOptions;
  readonly resolve: (info: M3LSpawnExitInfo) => void;
  readonly reject: (error: unknown) => void;
}

/** A fake `M3LRunExecutor` whose `execute()` calls never settle until the test resolves/rejects them. */
function createControllableExecutor(
  log: string[],
  name: string,
): M3LRunExecutor & { readonly calls: PendingExecutorCall[] } {
  const calls: PendingExecutorCall[] = [];
  return {
    calls,
    execute(options: ExecuteOptions): Promise<M3LSpawnExitInfo> {
      log.push(`${name}.execute:${options.scriptDir}`);
      return new Promise<M3LSpawnExitInfo>((resolve, reject) => {
        calls.push({ options, resolve, reject });
      });
    },
  };
}

/** One scheduled call to an injected `timerImpl`, with a fake handle carrying a spy `unref`. */
interface ScheduledTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  readonly handle: { readonly unref: ReturnType<typeof vi.fn> };
}

/** A fake `timerImpl` (`typeof setTimeout`) recording every scheduled call, with a spy-`unref` handle. */
function createFakeTimer(): {
  readonly timerImpl: typeof setTimeout;
  readonly scheduled: ScheduledTimer[];
} {
  const scheduled: ScheduledTimer[] = [];
  const timerImpl = vi.fn((callback: () => void, delayMs?: number) => {
    const handle = { unref: vi.fn() };
    scheduled.push({ callback, delayMs: delayMs ?? 0, handle });
    return handle as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  return { timerImpl, scheduled };
}

/**
 * Configures `existsSync` so every `resolveScript` call resolves a
 * spawn-mode script (no command module). Also stubs `fs.lstatSync` to
 * report a plain (non-symlink) directory entry — `resolveScript`'s symlink
 * containment guard fails CLOSED when a path cannot be stat'd, and the
 * fictional scripts root used throughout this file does not exist on the
 * real filesystem (mirrors `runs-resolver.test.ts`'s
 * `mockLstatSyncNotSymlink`).
 */
function mockSpawnModeScripts(): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) => !String(target).endsWith("command.js"),
  );
  vi.spyOn(fs, "lstatSync").mockImplementation((() => ({
    isSymbolicLink: () => false,
  })) as unknown as typeof fs.lstatSync);
}

/** Yields to the microtask queue so pending `.then`/`.catch` chains settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Builds a request for `scriptName` carrying an explicit correlation id. */
function requestWithCorrelation(
  scriptName: string,
  correlationId: string,
): M3LRunLaunchRequest {
  return { ...buildRequest(scriptName), correlationId };
}

/** Stands up an orchestrator over the shared fakes, returning what tests assert on. */
function harnessFor(
  decisionsByScript: Readonly<Record<string, readonly GovernorDecisionKind[]>>,
  timerImpl?: typeof setTimeout,
): {
  readonly orchestrator: ReturnType<typeof createRunOrchestrator>;
  readonly spawnExecutor: ReturnType<typeof createControllableExecutor>;
  readonly registry: ReturnType<typeof createFakeRegistry>;
  readonly log: string[];
} {
  mockSpawnModeScripts();
  const log: string[] = [];
  const registry = createFakeRegistry(log);
  const spawnExecutor = createControllableExecutor(log, "spawn");
  const orchestrator = createRunOrchestrator(
    {
      config: buildConfig(),
      registry,
      governor: createFakeGovernor(log, decisionsByScript),
      policy: createFakeAllowPolicy(log),
      audit: createFakeAudit(log),
      events: createFakeEvents(log),
      spawnExecutor,
      inProcessExecutor: createUnusedExecutor(log, "inProcess"),
      logger: new Core.M3LLogger([new RecordingHandler()]),
    },
    {
      newId: createIdSequence("run"),
      nowMs: createClock(),
      ...(timerImpl !== undefined && { timerImpl }),
    },
  );
  return { orchestrator, spawnExecutor, registry, log };
}

/** The correlation id the executor was invoked with for `scriptName`. */
function correlationForScript(
  spawnExecutor: ReturnType<typeof createControllableExecutor>,
  scriptName: string,
): string | undefined {
  return spawnExecutor.calls.find(
    (call) => call.options.scriptDir === path.join(SCRIPTS_ROOT, scriptName),
  )?.options.correlationId;
}

describe("createRunOrchestrator — correlation on an immediate start", () => {
  test("the launching request's correlation id reaches the executor", async () => {
    const { orchestrator, spawnExecutor } = harnessFor({
      "solo-script": ["accept"],
    });

    orchestrator.launch(requestWithCorrelation("solo-script", "corr-direct"));
    await flush();

    expect(correlationForScript(spawnExecutor, "solo-script")).toBe(
      "corr-direct",
    );
  });

  test("the same id is persisted on the run's registry row", async () => {
    const { orchestrator, spawnExecutor, registry } = harnessFor({
      "solo-script": ["accept"],
    });

    orchestrator.launch(requestWithCorrelation("solo-script", "corr-row"));
    await flush();

    // The row and the executor must agree — a trail that disagrees with the
    // process it describes is worse than no trail.
    expect(registry.rows.get("run-1")?.correlationId).toBe("corr-row");
    expect(correlationForScript(spawnExecutor, "solo-script")).toBe("corr-row");
  });
});

describe("createRunOrchestrator — correlation across the queue", () => {
  // THE ALS-REFUTING CASE. Run A is started by request 1; run B is queued by
  // request 2 and only starts later, from inside A's completion
  // continuation. B must carry request 2's id. An ambient store would hand
  // it request 1's.
  test("a queued run is correlated to its OWN launch, not the run whose completion started it", async () => {
    const { orchestrator, spawnExecutor, registry } = harnessFor({
      "script-a": ["accept"],
      "script-b": ["queue", "accept"],
    });

    orchestrator.launch(requestWithCorrelation("script-a", "corr-A"));
    orchestrator.launch(requestWithCorrelation("script-b", "corr-B"));
    await flush();

    // Only A is running; B is queued behind it.
    expect(registry.rows.get("run-2")?.status).toBe("queued");
    const callA = spawnExecutor.calls.find(
      (call) => call.options.scriptDir === path.join(SCRIPTS_ROOT, "script-a"),
    );
    if (callA === undefined) throw new Error("script-a did not start");

    // Settling A pumps the queue from within A's own continuation.
    callA.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    expect(registry.rows.get("run-2")?.status).toBe("running");
    expect(correlationForScript(spawnExecutor, "script-b")).toBe("corr-B");
    expect(correlationForScript(spawnExecutor, "script-b")).not.toBe("corr-A");
  });

  test("two runs queued behind one active run each keep their own id", async () => {
    const { orchestrator, spawnExecutor } = harnessFor({
      "script-a": ["accept"],
      "script-b": ["queue", "accept"],
      "script-c": ["queue", "accept"],
    });

    orchestrator.launch(requestWithCorrelation("script-a", "corr-A"));
    orchestrator.launch(requestWithCorrelation("script-b", "corr-B"));
    orchestrator.launch(requestWithCorrelation("script-c", "corr-C"));
    await flush();

    const callA = spawnExecutor.calls.find(
      (call) => call.options.scriptDir === path.join(SCRIPTS_ROOT, "script-a"),
    );
    if (callA === undefined) throw new Error("script-a did not start");
    callA.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    const callB = spawnExecutor.calls.find(
      (call) => call.options.scriptDir === path.join(SCRIPTS_ROOT, "script-b"),
    );
    if (callB === undefined) throw new Error("script-b did not start");
    callB.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    expect(correlationForScript(spawnExecutor, "script-b")).toBe("corr-B");
    expect(correlationForScript(spawnExecutor, "script-c")).toBe("corr-C");
  });

  test("a queued run that times out never starts, and the next pump still correlates correctly", async () => {
    const { timerImpl, scheduled } = createFakeTimer();
    const { orchestrator, spawnExecutor, registry } = harnessFor(
      {
        "script-a": ["accept"],
        "script-b": ["queue"],
        "script-c": ["queue", "accept"],
      },
      timerImpl,
    );

    orchestrator.launch(requestWithCorrelation("script-a", "corr-A"));
    orchestrator.launch(requestWithCorrelation("script-b", "corr-B"));
    orchestrator.launch(requestWithCorrelation("script-c", "corr-C"));
    await flush();

    // Time out B while it is still queued. `onQueueTimeout` runs on a timer
    // callback with no ambient request context whatsoever.
    const timeoutB = scheduled[0];
    if (timeoutB === undefined) throw new Error("no queue timeout scheduled");
    timeoutB.callback();
    await flush();

    expect(registry.rows.get("run-2")?.status).toBe("interrupted");
    expect(correlationForScript(spawnExecutor, "script-b")).toBeUndefined();

    const callA = spawnExecutor.calls.find(
      (call) => call.options.scriptDir === path.join(SCRIPTS_ROOT, "script-a"),
    );
    if (callA === undefined) throw new Error("script-a did not start");
    callA.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    expect(correlationForScript(spawnExecutor, "script-c")).toBe("corr-C");
  });
});
