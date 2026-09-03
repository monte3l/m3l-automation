/**
 * Tests for src/runs/orchestrator.ts's optional `telemetry` option (X8 slice
 * 3a) — `M3LRunOrchestratorOptions.telemetry?: M3LTelemetryRecorder`, wired
 * so a run's ACTIVE-path terminal write (`finishActiveRun`/`recordFinish`)
 * records exactly one `telemetry.runFinished({ script, outcome, durationMs })`
 * call. Per the maintainer's decision (contract §A "Path 1 only"), a
 * queue-timeout eviction and a cancel-while-queued eviction record NOTHING —
 * neither ever executed, so there is no run duration to report.
 *
 * RED: `telemetry` does not exist on `M3LRunOrchestratorOptions` yet, and
 * `runFinished` is never called. Vitest does not typecheck, so every case
 * below runs — the option is ignored at runtime — and the assertions fail
 * for that reason. `pnpm typecheck` separately reports an excess-property
 * error on `telemetry` until the option is added; that diagnostic is
 * expected and is not worked around here (no cast, no `@ts-expect-error`).
 *
 * Fakes are copied and trimmed from `runs-orchestrator.test.ts` and
 * `runs-orchestrator-queue.test.ts` (this package's established convention —
 * see `runs-events.test.ts`'s own comment on `RecordingHandler`) rather than
 * imported, so this file stays independently readable and under the
 * per-file byte budget. `Core.M3LLogger` has private fields, so it cannot be
 * duck-typed — every test builds a real instance over a local
 * `RecordingHandler`.
 *
 * The injected `nowMs` clock advances by a fixed step on every call
 * (`createSteppingClock`) rather than returning a constant — a frozen clock
 * makes `durationMs` assertions vacuous (this exact defect shipped in slice
 * 2b and passed 19/19 against a deliberately broken implementation). Cases
 * that need an exact `durationMs` rely on the orchestrator's known,
 * documented clock-read sequence for the ACTIVE happy path with an
 * immediately-settling executor: one read for `launchRun`'s `attemptAtMs`,
 * one for `startRun`'s `startedAtMs`, and one for `recordFinish`'s
 * `endedAtMs` — `admitRun` takes `attemptAtMs` as a parameter and never
 * reads the clock itself (verified against `src/runs/admission.ts`).
 */
import * as fs from "node:fs";

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
import type {
  M3LRunLaunchRequest,
  M3LRunOrchestratorOptions,
} from "../src/runs/orchestrator.js";
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
import type {
  M3LTelemetryRecorder,
  M3LTelemetryRunFinishedSample,
} from "../src/telemetry/port.js";

/** See `runs-orchestrator.test.ts`'s identical constant for full rationale. */
const RUNS_OUTPUT_ROOT = "/runs-output";
const SCRIPTS_ROOT = "/scripts";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** Builds a validated {@link M3LRunLaunchRequest}, overridable per test. */
function buildRequest(
  overrides: Partial<{
    readonly body: Partial<M3LRunRequestBody>;
    readonly scriptName: string;
  }> = {},
): M3LRunLaunchRequest {
  return {
    body: {
      scriptName: overrides.scriptName ?? "sqs-etl",
      confirmed: true,
      dryRun: false,
      parameters: {},
      ...overrides.body,
    },
    operator: "ada",
    correlationId: "corr-1",
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

/** Builds a real `Core.M3LLogger` over a fresh `RecordingHandler`. */
function buildLogger(): Core.M3LLogger {
  return new Core.M3LLogger([new RecordingHandler()]);
}

/**
 * A `Map`-backed fake `M3LRunRegistry`, trimmed from
 * `runs-orchestrator.test.ts`'s own fixture to what this file's scenarios
 * need.
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

/** A fake `M3LRunGovernor` keyed by script name — see `runs-orchestrator.test.ts` for full rationale. */
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

/** A fake `M3LRunPolicy` that always returns `verdict`. */
function createFakeAllowPolicy(): M3LRunPolicy {
  const verdict: M3LRunPolicyVerdict = { kind: "allow" };
  return {
    evaluate(): M3LRunPolicyVerdict {
      return verdict;
    },
  };
}

/** A fake `M3LRunAuditSink` recording every entry, in order. */
function createFakeAudit(): M3LRunAuditSink & {
  readonly records: M3LRunAuditRecord[];
} {
  const records: M3LRunAuditRecord[] = [];
  return {
    records,
    record(entry: M3LRunAuditRecord): void {
      records.push(entry);
    },
  };
}

/** A fake `M3LRunEventSink` recording every event, in order. */
function createFakeEvents(): M3LRunEventSink & {
  readonly published: M3LRunEvent[];
} {
  const published: M3LRunEvent[] = [];
  return {
    published,
    publish(event: M3LRunEvent): void {
      published.push(event);
    },
  };
}

/** An outcome an executor fake resolves with, or a rejection it throws instead. */
type FakeExecutorOutcome = M3LSpawnExitInfo | { readonly reject: Error };

/** A fake `M3LRunExecutor` that resolves/rejects immediately (mirrors `runs-orchestrator.test.ts`). */
function createImmediateExecutor(outcome: FakeExecutorOutcome): M3LRunExecutor {
  return {
    execute(): Promise<M3LSpawnExitInfo> {
      if ("reject" in outcome) return Promise.reject(outcome.reject);
      return Promise.resolve(outcome);
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
function createControllableExecutor(): M3LRunExecutor & {
  readonly calls: PendingExecutorCall[];
} {
  const calls: PendingExecutorCall[] = [];
  return {
    calls,
    execute(options: ExecuteOptions): Promise<M3LSpawnExitInfo> {
      return new Promise<M3LSpawnExitInfo>((resolve, reject) => {
        calls.push({ options, resolve, reject });
      });
    },
  };
}

/** One scheduled call to an injected `timerImpl` (mirrors `runs-orchestrator-queue.test.ts`). */
interface ScheduledTimer {
  readonly callback: () => void;
  readonly delayMs: number;
}

/** A fake `timerImpl` (`typeof setTimeout`) recording every scheduled call. */
function createFakeTimer(): {
  readonly timerImpl: typeof setTimeout;
  readonly scheduled: ScheduledTimer[];
} {
  const scheduled: ScheduledTimer[] = [];
  const timerImpl = vi.fn((callback: () => void, delayMs?: number) => {
    const entry = { callback, delayMs: delayMs ?? 0 };
    scheduled.push(entry);
    return { unref: vi.fn() };
  }) as unknown as typeof setTimeout;
  return { timerImpl, scheduled };
}

/**
 * Configures `existsSync` so every `resolveScript` call resolves a
 * spawn-mode script (no command module) — mirrors
 * `runs-orchestrator-queue.test.ts`'s `mockSpawnModeScripts`.
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

/**
 * Builds a capturing {@link M3LTelemetryRecorder} test double: every method
 * is implemented (a plain interface can never be satisfied by a partial
 * object — `Core.M3LLogger` has private fields for the same reason a real
 * logger, not a duck-typed one, is used elsewhere in this file), and every
 * `runFinished` sample handed to it is captured, in order, into
 * `runFinishedCalls`.
 */
function createCapturingTelemetryRecorder(): {
  readonly telemetry: M3LTelemetryRecorder;
  readonly runFinishedCalls: M3LTelemetryRunFinishedSample[];
} {
  const runFinishedCalls: M3LTelemetryRunFinishedSample[] = [];
  const telemetry: M3LTelemetryRecorder = {
    httpRequest: () => undefined,
    runFinished: (sample) => {
      runFinishedCalls.push(sample);
    },
    sseStream: () => undefined,
    policyDecision: () => undefined,
    storeHealth: () => undefined,
  };
  return { telemetry, runFinishedCalls };
}

/**
 * A clock that advances by `stepMs` on every call, starting at `startMs`.
 * MUST advance (never a constant) — see this file's header comment.
 */
function createSteppingClock(startMs: number, stepMs: number): () => number {
  let calls = 0;
  return (): number => {
    calls += 1;
    return startMs + calls * stepMs;
  };
}

/** The full options bag `createRunOrchestrator` needs, minus `telemetry`. */
interface FixtureOptions {
  readonly registry: M3LRunRegistry & {
    readonly rows: Map<string, M3LRunRecord>;
  };
  readonly governor: M3LRunGovernor;
  readonly audit: M3LRunAuditSink & { readonly records: M3LRunAuditRecord[] };
  readonly events: M3LRunEventSink & { readonly published: M3LRunEvent[] };
  readonly spawnExecutor: M3LRunExecutor;
  readonly inProcessExecutor: M3LRunExecutor;
  readonly logger: Core.M3LLogger;
}

/** Builds a fresh set of orchestrator collaborators, overridable per test. */
function buildFixtures(
  overrides: Partial<{
    readonly decisionsByScript: Readonly<
      Record<string, readonly GovernorDecisionKind[]>
    >;
    readonly spawnExecutor: M3LRunExecutor;
    readonly inProcessExecutor: M3LRunExecutor;
  }> = {},
): FixtureOptions {
  const log: string[] = [];
  const idleExecutor = createImmediateExecutor({
    exitCode: 0,
    killRequested: false,
    dryRun: false,
  });
  return {
    registry: createFakeRegistry(log),
    governor: createFakeGovernor(log, overrides.decisionsByScript ?? {}),
    audit: createFakeAudit(),
    events: createFakeEvents(),
    spawnExecutor: overrides.spawnExecutor ?? idleExecutor,
    inProcessExecutor: overrides.inProcessExecutor ?? idleExecutor,
    logger: buildLogger(),
  };
}

/** Assembles a full `M3LRunOrchestratorOptions`, `telemetry` included. */
function buildOrchestratorOptions(
  fixtures: FixtureOptions,
  telemetry: M3LTelemetryRecorder | undefined,
  configOverrides: Partial<M3LConsoleRunsConfig> = {},
): M3LRunOrchestratorOptions {
  return {
    config: buildConfig(configOverrides),
    registry: fixtures.registry,
    governor: fixtures.governor,
    policy: createFakeAllowPolicy(),
    audit: fixtures.audit,
    events: fixtures.events,
    spawnExecutor: fixtures.spawnExecutor,
    inProcessExecutor: fixtures.inProcessExecutor,
    logger: fixtures.logger,
    runsOutputRoot: RUNS_OUTPUT_ROOT,
    telemetry,
  };
}

describe("createRunOrchestrator — telemetry.runFinished on a successful ACTIVE run", () => {
  test("records exactly one sample: script is the resolved script name, outcome is 'success', durationMs is the elapsed ms", async () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({
      decisionsByScript: { "sqs-etl": ["accept"] },
      spawnExecutor: createImmediateExecutor({
        exitCode: 0,
        killRequested: false,
        dryRun: false,
      }),
    });
    const { telemetry, runFinishedCalls } = createCapturingTelemetryRecorder();
    // The clock must advance (never a constant) to avoid vacuous durationMs
    // assertions — see this file's header comment. The step size (100 ms) is
    // chosen for readability only; the durationMs assertion below is pinned
    // against the audit atMs timestamps rather than a literal so it stays
    // correct if future slices add or remove clock reads on the launch path
    // (adding a read would silently shift any literal without signalling a bug).
    const nowMs = createSteppingClock(1_000, 100);
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs },
    );

    orchestrator.launch(buildRequest());
    await flush();

    expect(runFinishedCalls).toHaveLength(1);
    const sample = runFinishedCalls[0];
    expect(sample?.script).toBe("sqs-etl");
    expect(sample?.outcome).toBe("success");
    const startedEntry = fixtures.audit.records.find(
      (record) => record.action === "run.started" && record.runId === "run-1",
    );
    const finishedEntry = fixtures.audit.records.find(
      (record) => record.action === "run.finished" && record.runId === "run-1",
    );
    expect(startedEntry).toBeDefined();
    expect(finishedEntry).toBeDefined();
    // durationMs is computed in recordFinish as toValidDurationMs(endedAtMs -
    // startedAtMs), while audit atMs values come from separate audit.record
    // calls in startRun (startedAtMs) and recordFinish (endedAtMs). The two
    // sides are independently derived: a bug that threaded endedAtMs for
    // startedAtMs would produce durationMs === 0 while
    // finishedEntry.atMs - startedEntry.atMs remains non-zero, failing here.
    expect(sample?.durationMs).toBeGreaterThan(0);
    expect(sample?.durationMs).toBe(
      (finishedEntry?.atMs ?? 0) - (startedEntry?.atMs ?? 0),
    );
  });
});

describe("createRunOrchestrator — telemetry.runFinished's outcome tracks the audit trail's own outcome", () => {
  test.each<[string, M3LSpawnExitInfo]>([
    ["failure", { exitCode: 1, killRequested: false, dryRun: false }],
    ["interrupted", { exitCode: 0, killRequested: true, dryRun: false }],
    ["dry-run", { exitCode: 0, killRequested: false, dryRun: true }],
  ])(
    "outcome '%s' reaches the sample and matches the audit run.finished entry",
    async (expectedOutcome, exitInfo) => {
      mockSpawnModeScripts();
      const fixtures = buildFixtures({
        decisionsByScript: { "sqs-etl": ["accept"] },
        spawnExecutor: createImmediateExecutor(exitInfo),
      });
      const { telemetry, runFinishedCalls } =
        createCapturingTelemetryRecorder();
      const orchestrator = createRunOrchestrator(
        buildOrchestratorOptions(fixtures, telemetry),
        { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
      );

      orchestrator.launch(buildRequest());
      await flush();

      expect(runFinishedCalls).toHaveLength(1);
      expect(runFinishedCalls[0]?.outcome).toBe(expectedOutcome);
      const finishedAudit = fixtures.audit.records.find(
        (record) =>
          record.action === "run.finished" && record.runId === "run-1",
      );
      expect(finishedAudit?.detail["outcome"]).toBe(expectedOutcome);
      expect(runFinishedCalls[0]?.outcome).toBe(
        finishedAudit?.detail["outcome"],
      );
    },
  );
});

describe("createRunOrchestrator — telemetry.runFinished on an executor rejection", () => {
  test("an executor rejection still records a sample with outcome 'failure' (the finishActiveRun rejected-continuation path)", async () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({
      decisionsByScript: { "sqs-etl": ["accept"] },
      spawnExecutor: createImmediateExecutor({
        reject: new Error("executor exploded"),
      }),
    });
    const { telemetry, runFinishedCalls } = createCapturingTelemetryRecorder();
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    orchestrator.launch(buildRequest());
    await flush();

    expect(runFinishedCalls).toHaveLength(1);
    expect(runFinishedCalls[0]?.outcome).toBe("failure");
    expect(runFinishedCalls[0]?.script).toBe("sqs-etl");
  });
});

describe("createRunOrchestrator — telemetry.runFinished survives a backward clock step", () => {
  test("durationMs is clamped to 0, not negative, and the terminal write is genuinely persisted (not swallowed)", async () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({
      decisionsByScript: { "sqs-etl": ["accept"] },
      spawnExecutor: createImmediateExecutor({
        exitCode: 0,
        killRequested: false,
        dryRun: false,
      }),
    });
    const { telemetry, runFinishedCalls } = createCapturingTelemetryRecorder();
    // Call 1: launchRun's attemptAtMs. Call 2: startRun's startedAtMs
    // (5_000). Call 3: recordFinish's endedAtMs, stepped BACKWARD to 1_000 —
    // so a naive `endedAtMs - startedAtMs` would be negative.
    let callCount = 0;
    const nowMs = (): number => {
      callCount += 1;
      if (callCount === 2) return 5_000;
      if (callCount === 3) return 1_000;
      return 1_000;
    };
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs },
    );

    orchestrator.launch(buildRequest());
    await flush();

    expect(runFinishedCalls).toHaveLength(1);
    expect(runFinishedCalls[0]?.durationMs).toBe(0);
    // Genuinely persisted, not swallowed by a rejected clamp value: the
    // registry's terminal write and the audit trail both completed
    // normally, independent of what the telemetry recorder captured.
    expect(fixtures.registry.rows.get("run-1")?.status).toBe("success");
    expect(
      fixtures.audit.records.some(
        (record) =>
          record.action === "run.finished" && record.runId === "run-1",
      ),
    ).toBe(true);
  });
});

describe("createRunOrchestrator — telemetry.runFinished on a queue-timeout eviction", () => {
  test("records NO sample — the run never executed (decision 1: path 1 only)", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({
      decisionsByScript: { "sqs-etl": ["queue"] },
    });
    const { telemetry, runFinishedCalls } = createCapturingTelemetryRecorder();
    const { timerImpl, scheduled } = createFakeTimer();
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry, { queueTimeoutMs: 30_000 }),
      { newId: () => "run-1", nowMs: () => 1_000, timerImpl },
    );

    orchestrator.launch(buildRequest());
    const armed = scheduled[0];
    if (armed === undefined)
      throw new Error("no queue-timeout timer was armed");
    armed.callback();

    expect(fixtures.registry.rows.get("run-1")?.status).toBe("interrupted");
    expect(runFinishedCalls).toHaveLength(0);
  });
});

describe("createRunOrchestrator — telemetry.runFinished on a cancel-while-queued eviction", () => {
  test("records NO sample — the run never executed", () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({
      decisionsByScript: { "sqs-etl": ["queue"] },
    });
    const { telemetry, runFinishedCalls } = createCapturingTelemetryRecorder();
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry, { queueTimeoutMs: 30_000 }),
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    orchestrator.launch(buildRequest());
    const cancelled = orchestrator.cancel("run-1");

    expect(cancelled).toBe(true);
    expect(fixtures.registry.rows.get("run-1")?.status).toBe("interrupted");
    expect(runFinishedCalls).toHaveLength(0);
  });
});

describe("createRunOrchestrator — telemetry.runFinished on cancelling an ACTIVE run", () => {
  test("records exactly ONE sample — the abort settles through the same ACTIVE path, never double-counted", async () => {
    mockSpawnModeScripts();
    const controllableExecutor = createControllableExecutor();
    const fixtures = buildFixtures({
      decisionsByScript: { "sqs-etl": ["accept"] },
      spawnExecutor: controllableExecutor,
    });
    const { telemetry, runFinishedCalls } = createCapturingTelemetryRecorder();
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    orchestrator.launch(buildRequest());
    await flush();
    const call = controllableExecutor.calls[0];
    if (call === undefined) throw new Error("spawnExecutor was not called");

    const cancelled = orchestrator.cancel("run-1");
    expect(cancelled).toBe(true);
    expect(runFinishedCalls).toHaveLength(0); // cancel() only aborts; the run has not settled yet

    call.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await flush();

    expect(runFinishedCalls).toHaveLength(1);
    expect(runFinishedCalls[0]?.outcome).toBe("interrupted");
  });
});

describe("createRunOrchestrator — telemetry.runFinished on boot reconciliation", () => {
  test("records NO sample even when reconcileOnBoot() transitions orphaned rows", () => {
    // No mockSpawnModeScripts needed — reconcileOnBoot never calls resolveScript
    // and does not touch the filesystem.
    const fixtures = buildFixtures();
    // Pre-seed one orphaned 'running' row directly into the registry.  This is
    // what makes the test non-vacuous: if the registry were empty, reconcileOnBoot
    // would return 0 and "no samples recorded" would be true for the trivial
    // reason that nothing happened, not because the path explicitly skips
    // telemetry.  We assert count > 0 below to enforce the precondition.
    fixtures.registry.rows.set("orphan-1", {
      id: "orphan-1",
      script: "sqs-etl",
      status: "running",
      dryRun: false,
      executionMode: "spawn",
      parameters: {},
      operator: "ada",
      correlationId: "corr-0",
      queuedAtMs: 100,
      startedAtMs: 200,
      endedAtMs: undefined,
      outcome: undefined,
      exitCode: undefined,
      failureMessage: undefined,
    });
    const { telemetry, runFinishedCalls } = createCapturingTelemetryRecorder();
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, telemetry),
      { newId: () => "run-1", nowMs: () => 5_000 },
    );

    const count = orchestrator.reconcileOnBoot();

    // Non-vacuous gate: reconcileOnBoot must have actually transitioned at
    // least one orphaned row; otherwise the following assertion would pass for
    // the wrong reason (nothing happened, so of course nothing was recorded).
    expect(count).toBeGreaterThan(0);
    expect(runFinishedCalls).toHaveLength(0);
  });
});

describe("createRunOrchestrator — telemetry is optional", () => {
  test("omitting telemetry entirely does not throw, and the run still completes normally (no-op default)", async () => {
    mockSpawnModeScripts();
    const fixtures = buildFixtures({
      decisionsByScript: { "sqs-etl": ["accept"] },
      spawnExecutor: createImmediateExecutor({
        exitCode: 0,
        killRequested: false,
        dryRun: false,
      }),
    });
    const orchestrator = createRunOrchestrator(
      buildOrchestratorOptions(fixtures, undefined),
      { newId: () => "run-1", nowMs: createSteppingClock(1_000, 10) },
    );

    expect(() => {
      orchestrator.launch(buildRequest());
    }).not.toThrow();
    await flush();

    expect(fixtures.registry.rows.get("run-1")?.status).toBe("success");
  });
});
