/**
 * Tests for src/runs/orchestrator.ts — queue pumping (skip-on-busy, one start
 * per pump call) and the queue-timeout timer. Split out of
 * `runs-orchestrator.test.ts` to keep each file under the per-file char
 * budget; `vitest.config.ts`'s `perFile: true` coverage binds `orchestrator.ts`
 * to every test file importing from it, so both files together are what
 * satisfy that module's coverage floor.
 *
 * Fakes are copied locally rather than imported from the sibling test file
 * (this package's established convention — see `runs-events.test.ts`'s own
 * comment on `RecordingHandler`), and are trimmed to only what this file's
 * scenarios need. `resolveScript` is exercised for real; only `node:fs`'s
 * `existsSync` is mocked, via the async-factory form.
 *
 * RED: `../src/runs/orchestrator.ts` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands the module.
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

/** A fake `timerImpl` whose returned handle is a bare object with no `unref` method at all. */
function createBareHandleTimer(): {
  readonly timerImpl: typeof setTimeout;
  readonly scheduled: { readonly callback: () => void }[];
} {
  const scheduled: { readonly callback: () => void }[] = [];
  const timerImpl = vi.fn((callback: () => void) => {
    scheduled.push({ callback });
    return {} as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  return { timerImpl, scheduled };
}

/** Configures `existsSync` so every `resolveScript` call resolves a spawn-mode script (no command module). */
function mockSpawnModeScripts(): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) => !String(target).endsWith("command.js"),
  );
}

/** Yields to the microtask queue so pending `.then`/`.catch` chains settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("createRunOrchestrator — queue pumping: skip-on-busy", () => {
  test("a busy script's queued row is skipped in favour of a later row the governor accepts", async () => {
    mockSpawnModeScripts();
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, {
      "busy-script": ["queue", "reject"],
      "free-script": ["queue", "accept"],
      "active-script": ["accept"],
    });
    const policy = createFakeAllowPolicy(log);
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createUnusedExecutor(log, "inProcess");
    const logger = new Core.M3LLogger([new RecordingHandler()]);
    const orchestrator = createRunOrchestrator(
      {
        config: buildConfig(),
        registry,
        governor,
        policy,
        audit,
        events,
        spawnExecutor,
        inProcessExecutor,
        logger,
      },
      { newId: createIdSequence("run"), nowMs: createClock() },
    );

    orchestrator.launch(buildRequest("busy-script")); // run-1, stays queued
    orchestrator.launch(buildRequest("free-script")); // run-2, stays queued
    orchestrator.launch(buildRequest("active-script")); // run-3, starts immediately
    await flush();

    const activeCall = spawnExecutor.calls.find(
      (call) =>
        call.options.scriptDir === path.join(SCRIPTS_ROOT, "active-script"),
    );
    if (activeCall === undefined) {
      throw new Error("active-script did not start");
    }
    activeCall.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    expect(registry.rows.get("run-1")?.status).toBe("queued");
    expect(registry.rows.get("run-2")?.status).toBe("running");
    expect(log).toContain("governor.decide:busy-script:reject");
    expect(log).toContain("governor.decide:free-script:accept");
    expect(log.indexOf("governor.decide:busy-script:reject")).toBeLessThan(
      log.indexOf("governor.decide:free-script:accept"),
    );
    expect(
      spawnExecutor.calls.some(
        (call) =>
          call.options.scriptDir === path.join(SCRIPTS_ROOT, "busy-script"),
      ),
    ).toBe(false);
    expect(
      spawnExecutor.calls.some(
        (call) =>
          call.options.scriptDir === path.join(SCRIPTS_ROOT, "free-script"),
      ),
    ).toBe(true);
  });

  test("pumping starts at most one run per finish — the second acceptable queued row waits for the NEXT pump", async () => {
    mockSpawnModeScripts();
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, {
      "queued-a": ["queue", "accept"],
      "queued-b": ["queue", "accept"],
      "active-script": ["accept"],
    });
    const policy = createFakeAllowPolicy(log);
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createUnusedExecutor(log, "inProcess");
    const logger = new Core.M3LLogger([new RecordingHandler()]);
    const orchestrator = createRunOrchestrator(
      {
        config: buildConfig(),
        registry,
        governor,
        policy,
        audit,
        events,
        spawnExecutor,
        inProcessExecutor,
        logger,
      },
      { newId: createIdSequence("run"), nowMs: createClock() },
    );

    orchestrator.launch(buildRequest("queued-a")); // run-1
    orchestrator.launch(buildRequest("queued-b")); // run-2
    orchestrator.launch(buildRequest("active-script")); // run-3
    await flush();

    const activeCall = spawnExecutor.calls.find(
      (call) =>
        call.options.scriptDir === path.join(SCRIPTS_ROOT, "active-script"),
    );
    if (activeCall === undefined) {
      throw new Error("active-script did not start");
    }
    activeCall.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    expect(registry.rows.get("run-1")?.status).toBe("running");
    expect(registry.rows.get("run-2")?.status).toBe("queued");
    expect(
      log.filter((entry) => entry.startsWith("governor.decide:queued-b")),
    ).toHaveLength(1); // only its own launch-time enqueue decide — never reached by this pump
  });
});

describe("createRunOrchestrator — queue timeout", () => {
  test("firing while still queued abandons the run as interrupted via abandonQueued, dequeues, and publishes/audits it — WITHOUT ever calling claimForStart", () => {
    mockSpawnModeScripts();
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["queue"] });
    const policy = createFakeAllowPolicy(log);
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createUnusedExecutor(log, "spawn");
    const inProcessExecutor = createUnusedExecutor(log, "inProcess");
    const logger = new Core.M3LLogger([new RecordingHandler()]);
    const { timerImpl, scheduled } = createFakeTimer();
    const orchestrator = createRunOrchestrator(
      {
        config: buildConfig({ queueTimeoutMs: 30_000 }),
        registry,
        governor,
        policy,
        audit,
        events,
        spawnExecutor,
        inProcessExecutor,
        logger,
      },
      { newId: () => "run-1", nowMs: () => 1_000, timerImpl },
    );

    orchestrator.launch(buildRequest("sqs-etl"));

    const armed = scheduled[0];
    if (armed === undefined)
      throw new Error("no queue-timeout timer was armed");
    expect(armed.delayMs).toBe(30_000);
    armed.callback();

    expect(registry.rows.get("run-1")?.status).toBe("interrupted");
    expect(registry.rows.get("run-1")?.outcome).toBe("interrupted");
    // The whole point of this fix: a run that timed out while still queued
    // never executed, so its startedAtMs must stay undefined — the
    // orchestrator must call the guarded abandonQueued transition, never
    // the claimForStart-then-finish workaround that would fabricate one.
    expect(registry.rows.get("run-1")?.startedAtMs).toBeUndefined();
    expect(log).toContain("registry.abandonQueued:run-1");
    expect(
      log.some((entry) => entry.startsWith("registry.claimForStart")),
    ).toBe(false);
    expect(governor.queuedCount).toBe(0);
    expect(
      events.published.some(
        (event) =>
          event.event === "run.ended" && event.outcome === "interrupted",
      ),
    ).toBe(true);
    expect(
      audit.records.some(
        (record) =>
          record.runId === "run-1" && record.action === "run.finished",
      ),
    ).toBe(true);
    expect(spawnExecutor).toBeDefined(); // never invoked — see createUnusedExecutor
  });

  test("the timer's handle is unref()'d immediately after arming, so it cannot keep the process alive", () => {
    mockSpawnModeScripts();
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["queue"] });
    const policy = createFakeAllowPolicy(log);
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createUnusedExecutor(log, "spawn");
    const inProcessExecutor = createUnusedExecutor(log, "inProcess");
    const logger = new Core.M3LLogger([new RecordingHandler()]);
    const { timerImpl, scheduled } = createFakeTimer();
    const orchestrator = createRunOrchestrator(
      {
        config: buildConfig(),
        registry,
        governor,
        policy,
        audit,
        events,
        spawnExecutor,
        inProcessExecutor,
        logger,
      },
      { newId: () => "run-1", nowMs: () => 1_000, timerImpl },
    );

    orchestrator.launch(buildRequest("sqs-etl"));

    const armed = scheduled[0];
    if (armed === undefined)
      throw new Error("no queue-timeout timer was armed");
    expect(armed.handle.unref).toHaveBeenCalled();
  });

  test("a timer handle with no unref() method never throws — the guard tolerates a bare handle", () => {
    mockSpawnModeScripts();
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["queue"] });
    const policy = createFakeAllowPolicy(log);
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createUnusedExecutor(log, "spawn");
    const inProcessExecutor = createUnusedExecutor(log, "inProcess");
    const logger = new Core.M3LLogger([new RecordingHandler()]);
    const { timerImpl } = createBareHandleTimer();
    const orchestrator = createRunOrchestrator(
      {
        config: buildConfig(),
        registry,
        governor,
        policy,
        audit,
        events,
        spawnExecutor,
        inProcessExecutor,
        logger,
      },
      { newId: () => "run-1", nowMs: () => 1_000, timerImpl },
    );

    expect(() => {
      orchestrator.launch(buildRequest("sqs-etl"));
    }).not.toThrow();
  });

  test("starting a queued run via pump clears its armed queue-timeout timer", async () => {
    mockSpawnModeScripts();
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, {
      "timeout-script": ["queue", "accept"],
      "active-script": ["accept"],
    });
    const policy = createFakeAllowPolicy(log);
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createUnusedExecutor(log, "inProcess");
    const logger = new Core.M3LLogger([new RecordingHandler()]);
    const { timerImpl, scheduled } = createFakeTimer();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const orchestrator = createRunOrchestrator(
      {
        config: buildConfig(),
        registry,
        governor,
        policy,
        audit,
        events,
        spawnExecutor,
        inProcessExecutor,
        logger,
      },
      { newId: createIdSequence("run"), nowMs: createClock(), timerImpl },
    );

    orchestrator.launch(buildRequest("timeout-script")); // run-1, queued, timer armed
    const armed = scheduled[0];
    if (armed === undefined)
      throw new Error("no queue-timeout timer was armed");

    orchestrator.launch(buildRequest("active-script")); // run-2, starts immediately
    await flush();

    const activeCall = spawnExecutor.calls.find(
      (call) =>
        call.options.scriptDir === path.join(SCRIPTS_ROOT, "active-script"),
    );
    if (activeCall === undefined)
      throw new Error("active-script did not start");
    activeCall.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    expect(registry.rows.get("run-1")?.status).toBe("running");
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed.handle);
  });
});
