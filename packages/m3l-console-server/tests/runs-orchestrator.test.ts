/**
 * Tests for src/runs/orchestrator.ts — `createRunOrchestrator` (m3l-console-server
 * X4 slice 6 round 2 contract): `launch`, starting a claimed run, `cancel`,
 * `reconcileOnBoot`, `activeCount`, and `drain`. Queue pumping and the
 * queue-timeout timer are covered separately in
 * `runs-orchestrator-queue.test.ts` to keep this file under the per-file
 * budget.
 *
 * Every collaborator (`M3LRunRegistry`, `M3LRunGovernor`, `M3LRunPolicy`,
 * `M3LRunAuditSink`, `M3LRunEventSink`, both `M3LRunExecutor`s) is a local
 * fake that pushes a tagged string into one shared `log` array per test, so
 * ordering guarantees ("audit before throw", "accept before release") are
 * asserted as an exact sequence rather than as independent `toHaveBeenCalled`
 * checks. `resolveScript` is imported for real (never mocked — the
 * spawn-vs-in-process executor selection it drives is real behaviour this
 * suite exercises); only `node:fs`'s `existsSync` is spied per test, via the
 * async-factory `vi.mock("node:fs", ...)` form that preserves every other
 * real export (mirrors `runs-resolver.test.ts`). `Core.M3LLogger` has private
 * fields, so it cannot be duck-typed — every test builds a real instance
 * over a local `RecordingHandler` and asserts on the recorded events (mirrors
 * `runs-events.test.ts`/`runs-audit.test.ts`).
 *
 * RED: `../src/runs/orchestrator.ts` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands the module.
 */
import * as fs from "node:fs";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import type { M3LRunAuditRecord, M3LRunAuditSink } from "../src/runs/audit.js";
import type { M3LRunEvent, M3LRunEventSink } from "../src/runs/events.js";
import type { M3LRunExecutor } from "../src/runs/executor.js";
import type {
  M3LRunGovernor,
  M3LRunGovernorDecision,
} from "../src/runs/governor.js";
import { createRunOrchestrator } from "../src/runs/orchestrator.js";
import type {
  M3LRunHandle,
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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SCRIPTS_ROOT = "/scripts";

/** The kind of decision `M3LRunGovernor.decide` may return. */
type GovernorDecisionKind = M3LRunGovernorDecision["kind"];

/** The (unexported) options `M3LRunExecutor.execute` accepts, recovered structurally. */
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
    readonly operator: string;
    readonly correlationId: string;
  }> = {},
): M3LRunLaunchRequest {
  return {
    body: {
      scriptName: "sqs-etl",
      confirmed: true,
      dryRun: false,
      parameters: {},
      ...overrides.body,
    },
    operator: overrides.operator ?? "ada",
    correlationId: overrides.correlationId ?? "corr-1",
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
function buildLogger(): { logger: Core.M3LLogger; handler: RecordingHandler } {
  const handler = new RecordingHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

/** Options controlling a fake registry's guarded-write behaviour. */
interface FakeRegistryOptions {
  /** When set, `claimForStart` always returns this value instead of computing it. */
  readonly claimForStartResult?: boolean;
  /** When set, `insertQueued` throws this value instead of writing a row. */
  readonly insertThrows?: Error;
}

/**
 * A `Map`-backed fake `M3LRunRegistry`: real enough to drive the orchestrator
 * through insert -> claim -> finish, with `log` recording every call in
 * order and `options` letting a test force a specific failure/race branch.
 */
function createFakeRegistry(
  log: string[],
  options: FakeRegistryOptions = {},
): M3LRunRegistry & { readonly rows: Map<string, M3LRunRecord> } {
  const rows = new Map<string, M3LRunRecord>();
  return {
    rows,
    insertQueued(input: M3LRunInsert): void {
      log.push(`registry.insertQueued:${input.id}`);
      if (options.insertThrows !== undefined) throw options.insertThrows;
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
      if (options.claimForStartResult !== undefined) {
        return options.claimForStartResult;
      }
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
      log.push(`registry.reconcileOrphaned:${String(count)}`);
      return count;
    },
    abandonQueued(id: string, endedAtMs: number): boolean {
      log.push(`registry.abandonQueued:${id}`);
      const row = rows.get(id);
      if (row === undefined || row.status !== "queued") return false;
      // Deliberately does NOT set startedAtMs — mirrors the real
      // repository's guarded queued -> interrupted write, which must
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
 * once exhausted. `log` records every call (including which script/kind was
 * decided) so a test can assert exact call sequence and skip-on-busy
 * discrimination.
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

/** A fake `M3LRunPolicy` that always returns `verdict`, recording each call. */
function createFakePolicy(
  log: string[],
  verdict: M3LRunPolicyVerdict,
): M3LRunPolicy {
  return {
    evaluate(request): M3LRunPolicyVerdict {
      log.push(`policy.evaluate:${request.scriptName}`);
      return verdict;
    },
  };
}

/** A fake `M3LRunAuditSink` recording every entry, in order, into both `log` and `records`. */
function createFakeAudit(
  log: string[],
): M3LRunAuditSink & { readonly records: M3LRunAuditRecord[] } {
  const records: M3LRunAuditRecord[] = [];
  return {
    records,
    record(entry: M3LRunAuditRecord): void {
      log.push(`audit:${entry.action}`);
      records.push(entry);
    },
  };
}

/** A fake `M3LRunEventSink` recording every event, in order, into both `log` and `published`. */
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

/** An outcome an executor fake resolves with, or a rejection it throws instead. */
type FakeExecutorOutcome = M3LSpawnExitInfo | { readonly reject: Error };

/** A fake `M3LRunExecutor` that resolves/rejects immediately, recording every call's options. */
function createImmediateExecutor(
  log: string[],
  name: string,
  outcome: FakeExecutorOutcome,
): M3LRunExecutor & { readonly calls: ExecuteOptions[] } {
  const calls: ExecuteOptions[] = [];
  return {
    calls,
    execute(options: ExecuteOptions): Promise<M3LSpawnExitInfo> {
      log.push(`${name}.execute`);
      calls.push(options);
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
function createControllableExecutor(
  log: string[],
  name: string,
): M3LRunExecutor & { readonly calls: PendingExecutorCall[] } {
  const calls: PendingExecutorCall[] = [];
  return {
    calls,
    execute(options: ExecuteOptions): Promise<M3LSpawnExitInfo> {
      log.push(`${name}.execute`);
      return new Promise<M3LSpawnExitInfo>((resolve, reject) => {
        calls.push({ options, resolve, reject });
      });
    },
  };
}

/** Configures `existsSync` so `resolveScript` resolves a script with (or without) a command module. */
function mockScriptExists(hasCommandModule: boolean): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) =>
      !(String(target).endsWith("command.js") && !hasCommandModule),
  );
}

/**
 * A deterministic id generator producing `${prefix}-1`, `${prefix}-2`, ... in
 * call order. Only the drain tests below launch more than one run per test,
 * so the single-id `newId: () => "run-1"` override used elsewhere in this
 * file is not enough — mirrors `runs-orchestrator-queue.test.ts`'s own
 * `createIdSequence` helper.
 */
function createIdSequence(prefix: string): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

/** Yields to the microtask queue so pending `.then`/`.catch` chains settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("createRunOrchestrator — launch: resolveScript failures propagate unchanged", () => {
  test("an invalid (non-kebab-case) script name throws ERR_CONSOLE_BAD_REQUEST before anything else runs", () => {
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log);
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
    const orchestrator = createRunOrchestrator({
      config: buildConfig(),
      registry,
      governor,
      policy,
      audit,
      events,
      spawnExecutor,
      inProcessExecutor,
      logger,
    });

    let thrown: unknown;
    try {
      orchestrator.launch(buildRequest({ body: { scriptName: "Not_Kebab" } }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(log).toEqual([]);
  });

  test("an unknown script name throws ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND before anything else runs", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log);
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
    const orchestrator = createRunOrchestrator({
      config: buildConfig(),
      registry,
      governor,
      policy,
      audit,
      events,
      spawnExecutor,
      inProcessExecutor,
      logger,
    });

    let thrown: unknown;
    try {
      orchestrator.launch(
        buildRequest({ body: { scriptName: "no-such-script" } }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
    expect(log).toEqual([]);
  });
});

describe("createRunOrchestrator — launch: policy denial is audited BEFORE it throws", () => {
  test("a denied launch calls audit.record(run.launch-denied) then throws ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED carrying the verdict's reason", () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log);
    const deniedVerdict: M3LRunPolicyVerdict = {
      kind: "deny",
      reason: "explicit confirmation is required",
    };
    const policy = createFakePolicy(log, deniedVerdict);
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
    const orchestrator = createRunOrchestrator({
      config: buildConfig(),
      registry,
      governor,
      policy,
      audit,
      events,
      spawnExecutor,
      inProcessExecutor,
      logger,
    });

    let thrown: unknown;
    try {
      orchestrator.launch(buildRequest({ body: { confirmed: false } }));
    } catch (error) {
      thrown = error;
    }

    expect(log).toEqual(["policy.evaluate:sqs-etl", "audit:run.launch-denied"]);
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
    );
    expect((thrown as M3LConsoleError).message).toContain(
      "explicit confirmation is required",
    );
    expect(audit.records[0]?.runId).toBeUndefined();
    expect(governor.activeCount).toBe(0);
    expect(governor.queuedCount).toBe(0);
    expect(registry.rows.size).toBe(0);
  });
});

describe("createRunOrchestrator — launch: governor rejection is audited BEFORE it throws", () => {
  test("a rejected launch calls audit.record(run.launch-rejected) then throws ERR_CONSOLE_RUN_CAPACITY_EXCEEDED", () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["reject"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
    const orchestrator = createRunOrchestrator({
      config: buildConfig(),
      registry,
      governor,
      policy,
      audit,
      events,
      spawnExecutor,
      inProcessExecutor,
      logger,
    });

    let thrown: unknown;
    try {
      orchestrator.launch(buildRequest());
    } catch (error) {
      thrown = error;
    }

    expect(log).toEqual([
      "policy.evaluate:sqs-etl",
      "governor.decide:sqs-etl:reject",
      "audit:run.launch-rejected",
    ]);
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_CAPACITY_EXCEEDED",
    );
    expect(registry.rows.size).toBe(0);
  });
});

describe("createRunOrchestrator — launch: unrecognised governor decision", () => {
  test("throws ERR_CONSOLE_INTERNAL for an unrecognised governor decision kind", () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
    // `M3LRunGovernorDecision.kind` is a closed "accept" | "queue" | "reject"
    // union; this fake deliberately returns a value outside it to prove the
    // defensive `default` arm in `admitRun`'s governor-decision switch is
    // live at runtime, not merely a compile-time `never` marker.
    const governor: M3LRunGovernor = {
      decide(): M3LRunGovernorDecision {
        return { kind: "bogus" as unknown as GovernorDecisionKind };
      },
      accept(): void {},
      release(): void {},
      enqueue(): void {},
      dequeue(): void {},
      get activeCount(): number {
        return 0;
      },
      get queuedCount(): number {
        return 0;
      },
    };
    const orchestrator = createRunOrchestrator({
      config: buildConfig(),
      registry,
      governor,
      policy,
      audit,
      events,
      spawnExecutor,
      inProcessExecutor,
      logger,
    });

    let thrown: unknown;
    try {
      orchestrator.launch(buildRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_INTERNAL");
  });
});

describe("createRunOrchestrator — launch: queue path", () => {
  test("a queued launch calls governor.enqueue (never accept), inserts a queued row, publishes run.queued then audits run.launch-allowed, and starts no executor", () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["queue"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    const handle: M3LRunHandle = orchestrator.launch(buildRequest());

    expect(handle).toEqual({
      id: "run-1",
      scriptName: "sqs-etl",
      status: "queued",
      dryRun: false,
      executionMode: "spawn",
    });
    expect(log).toEqual([
      "policy.evaluate:sqs-etl",
      "governor.decide:sqs-etl:queue",
      "governor.enqueue",
      "registry.insertQueued:run-1",
      "event:run.queued",
      "audit:run.launch-allowed",
    ]);
    expect(spawnExecutor.calls).toHaveLength(0);
    expect(inProcessExecutor.calls).toHaveLength(0);
    expect(registry.rows.get("run-1")?.status).toBe("queued");
  });
});

describe("createRunOrchestrator — launch: accept path starts the run immediately", () => {
  test("an accepted spawn-mode launch: governor.accept, insertQueued, run.queued, launch-allowed, claimForStart, run.started, run.started audit, then spawnExecutor.execute (not inProcessExecutor)", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    const handle = orchestrator.launch(buildRequest());
    await flush();

    expect(handle).toEqual({
      id: "run-1",
      scriptName: "sqs-etl",
      status: "running",
      dryRun: false,
      executionMode: "spawn",
    });
    expect(log).toEqual([
      "policy.evaluate:sqs-etl",
      "governor.decide:sqs-etl:accept",
      "governor.accept:sqs-etl",
      "registry.insertQueued:run-1",
      "event:run.queued",
      "audit:run.launch-allowed",
      "registry.claimForStart:run-1",
      "event:run.started",
      "audit:run.started",
      "spawn.execute",
    ]);
    expect(inProcessExecutor.calls).toHaveLength(0);
    expect(spawnExecutor.calls[0]?.options.dryRun).toBe(false);
  });

  test("an accepted in-process-mode launch (hasCommandModule=true) starts inProcessExecutor, not spawnExecutor", async () => {
    mockScriptExists(true);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    const handle = orchestrator.launch(buildRequest());
    await flush();

    expect(handle.executionMode).toBe("in-process");
    expect(spawnExecutor.calls).toHaveLength(0);
    expect(inProcessExecutor.calls).toHaveLength(1);
    expect(registry.rows.get("run-1")?.executionMode).toBe("in-process");
  });
});

describe("createRunOrchestrator — launch: insertQueued failure undoes the governor commitment", () => {
  test("accept path: insertQueued throwing undoes governor.accept via governor.release, and rethrows the original error unchanged", () => {
    mockScriptExists(false);
    const log: string[] = [];
    const originalError = new Error("disk full");
    const registry = createFakeRegistry(log, { insertThrows: originalError });
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    let thrown: unknown;
    try {
      orchestrator.launch(buildRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    expect(log).toEqual([
      "policy.evaluate:sqs-etl",
      "governor.decide:sqs-etl:accept",
      "governor.accept:sqs-etl",
      "registry.insertQueued:run-1",
      "governor.release:sqs-etl",
    ]);
    expect(spawnExecutor.calls).toHaveLength(0);
    expect(inProcessExecutor.calls).toHaveLength(0);
    expect(governor.activeCount).toBe(0);
  });

  test("queue path: insertQueued throwing undoes governor.enqueue via governor.dequeue, and rethrows the original error unchanged", () => {
    mockScriptExists(false);
    const log: string[] = [];
    const originalError = new Error("disk full");
    const registry = createFakeRegistry(log, { insertThrows: originalError });
    const governor = createFakeGovernor(log, { "sqs-etl": ["queue"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    let thrown: unknown;
    try {
      orchestrator.launch(buildRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    expect(log).toEqual([
      "policy.evaluate:sqs-etl",
      "governor.decide:sqs-etl:queue",
      "governor.enqueue",
      "registry.insertQueued:run-1",
      "governor.dequeue",
    ]);
    expect(governor.queuedCount).toBe(0);
  });
});

describe("createRunOrchestrator — starting a run: claimForStart losing the race", () => {
  test("claimForStart returning false starts NO executor, logs a WARNING, and does NOT release the governor slot a second time", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log, { claimForStartResult: false });
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger, handler } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    orchestrator.launch(buildRequest());
    await flush();

    expect(spawnExecutor.calls).toHaveLength(0);
    expect(inProcessExecutor.calls).toHaveLength(0);
    expect(log).not.toContain("governor.release:sqs-etl");
    expect(
      handler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.WARNING,
      ),
    ).toBe(true);
    expect(orchestrator.activeCount).toBe(0);
  });
});

describe("createRunOrchestrator — executor fulfilment is mapped through mapSpawnOutcome", () => {
  test.each<[M3LSpawnExitInfo, Core.M3LRunOutcome]>([
    [{ exitCode: 0, killRequested: false, dryRun: false }, "success"],
    [{ exitCode: 0, killRequested: false, dryRun: true }, "dry-run"],
    [{ exitCode: 1, killRequested: false, dryRun: false }, "failure"],
    [{ exitCode: 0, killRequested: true, dryRun: false }, "interrupted"],
  ])(
    "%o resolves to registry.finish outcome %s, publishes run.ended, audits run.finished, and releases the governor slot",
    async (exit, outcome) => {
      mockScriptExists(false);
      const log: string[] = [];
      const registry = createFakeRegistry(log);
      const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
      const policy = createFakePolicy(log, { kind: "allow" });
      const audit = createFakeAudit(log);
      const events = createFakeEvents(log);
      const spawnExecutor = createImmediateExecutor(log, "spawn", exit);
      const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
        exitCode: 0,
        killRequested: false,
        dryRun: false,
      });
      const { logger } = buildLogger();
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
        { newId: () => "run-1", nowMs: () => 1_000 },
      );

      orchestrator.launch(buildRequest());
      await flush();
      await flush();

      expect(registry.rows.get("run-1")?.outcome).toBe(outcome);
      expect(registry.rows.get("run-1")?.exitCode).toBe(exit.exitCode);
      expect(
        events.published.some(
          (event) => event.event === "run.ended" && event.outcome === outcome,
        ),
      ).toBe(true);
      expect(log).toContain("audit:run.finished");
      expect(log).toContain("governor.release:sqs-etl");
      expect(orchestrator.activeCount).toBe(0);
    },
  );
});

describe("createRunOrchestrator — executor rejection is recorded as failure, never swallowed", () => {
  test("a rejected execute() finishes the run as failure carrying the cause's message, and is not lost", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const cause = new Error("boom");
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      reject: cause,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger, handler } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    orchestrator.launch(buildRequest());
    await flush();
    await flush();

    expect(registry.rows.get("run-1")?.outcome).toBe("failure");
    expect(registry.rows.get("run-1")?.failureMessage).toBe("boom");
    expect(
      handler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ),
    ).toBe(true);
    expect(log).toContain("audit:run.finished");
    expect(log).toContain("governor.release:sqs-etl");
  });
});

describe("createRunOrchestrator — run.line fan-out", () => {
  test("a line reported by the executor's onLine callback is published as a run.line event", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    orchestrator.launch(buildRequest());
    await flush();

    const call = spawnExecutor.calls[0];
    if (call === undefined) throw new Error("spawnExecutor was not called");
    call.options.onLine("hello from the run");

    expect(events.published).toContainEqual({
      event: "run.line",
      runId: "run-1",
      line: "hello from the run",
    });

    call.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
  });
});

describe("createRunOrchestrator — cancel", () => {
  test("cancelling an active run aborts its signal, audits run.cancelled, and returns true", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    orchestrator.launch(buildRequest());
    await flush();
    const call = spawnExecutor.calls[0];
    if (call === undefined) throw new Error("spawnExecutor was not called");

    const cancelled = orchestrator.cancel("run-1");

    expect(cancelled).toBe(true);
    expect(call.options.signal.aborted).toBe(true);
    expect(log).toContain("audit:run.cancelled");

    call.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await flush();
  });

  test("cancelling an unknown id returns false and audits nothing", () => {
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log);
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
    const orchestrator = createRunOrchestrator({
      config: buildConfig(),
      registry,
      governor,
      policy,
      audit,
      events,
      spawnExecutor,
      inProcessExecutor,
      logger,
    });

    const cancelled = orchestrator.cancel("no-such-run");

    expect(cancelled).toBe(false);
    expect(log).not.toContain("audit:run.cancelled");
  });

  test("cancelling a queued (non-active) run returns false — queued cancellation is not supported in this slice", () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["queue"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    orchestrator.launch(buildRequest());
    const cancelled = orchestrator.cancel("run-1");

    expect(cancelled).toBe(false);
    expect(log).not.toContain("audit:run.cancelled");
  });
});

describe("createRunOrchestrator — reconcileOnBoot", () => {
  test("zero orphaned rows: returns 0 and never audits run.reconciled", () => {
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log);
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger, handler } = buildLogger();
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
      { nowMs: () => 5_000 },
    );

    const count = orchestrator.reconcileOnBoot();

    expect(count).toBe(0);
    expect(log).not.toContain("audit:run.reconciled");
    expect(
      handler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.INFO,
      ),
    ).toBe(true);
  });

  test("non-zero orphaned rows: returns the count and audits run.reconciled", () => {
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    registry.rows.set("orphan-1", {
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
    const governor = createFakeGovernor(log);
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
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
      { nowMs: () => 5_000 },
    );

    const count = orchestrator.reconcileOnBoot();

    expect(count).toBe(1);
    expect(log).toContain("audit:run.reconciled");
  });
});

describe("createRunOrchestrator — activeCount", () => {
  test("increments while a run is active and returns to 0 once it settles", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    expect(orchestrator.activeCount).toBe(0);
    orchestrator.launch(buildRequest());
    await flush();
    expect(orchestrator.activeCount).toBe(1);

    const call = spawnExecutor.calls[0];
    if (call === undefined) throw new Error("spawnExecutor was not called");
    call.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();
    await flush();

    expect(orchestrator.activeCount).toBe(0);
  });
});

describe("createRunOrchestrator — drain", () => {
  test("aborts every active run's signal and resolves only once every run has settled", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, { "sqs-etl": ["accept"] });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: () => "run-1", nowMs: () => 1_000 },
    );

    orchestrator.launch(buildRequest());
    await flush();
    const call = spawnExecutor.calls[0];
    if (call === undefined) throw new Error("spawnExecutor was not called");

    let drainResolved = false;
    const drainPromise = orchestrator.drain().then(() => {
      drainResolved = true;
    });
    await flush();

    expect(call.options.signal.aborted).toBe(true);
    expect(drainResolved).toBe(false);

    call.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await drainPromise;

    expect(drainResolved).toBe(true);
    expect(orchestrator.activeCount).toBe(0);
  });

  test("resolves immediately when no run is active", async () => {
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log);
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createImmediateExecutor(log, "spawn", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const inProcessExecutor = createImmediateExecutor(log, "inProcess", {
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    const { logger } = buildLogger();
    const orchestrator = createRunOrchestrator({
      config: buildConfig(),
      registry,
      governor,
      policy,
      audit,
      events,
      spawnExecutor,
      inProcessExecutor,
      logger,
    });

    await expect(orchestrator.drain()).resolves.toBeUndefined();
  });

  // PR #730 must-fix: `drainActive` (src/runs/orchestrator.ts:688) snapshots
  // `ctx.active` exactly once into a fixed array. Each aborted run settles
  // through `finishActiveRun`, whose last statement is `pumpQueue`, which
  // can start a queued run and add it to `ctx.active` — but that new entry
  // is never part of the fixed snapshot `Promise.allSettled` was handed, so
  // `drain()` can resolve while that run is still executing.
  test("[PR#730] a queued run for the same script is never started during drain, and drain resolves only once the active run has settled", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, {
      "sqs-etl": ["accept", "queue"],
    });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
    const orchestrator = createRunOrchestrator(
      {
        config: buildConfig({ maxPerScript: 1 }),
        registry,
        governor,
        policy,
        audit,
        events,
        spawnExecutor,
        inProcessExecutor,
        logger,
      },
      { newId: createIdSequence("run") },
    );

    orchestrator.launch(buildRequest()); // run-1: accepted, starts immediately
    await flush();
    const callA = spawnExecutor.calls[0];
    if (callA === undefined) throw new Error("run-1 did not start");

    const handleB = orchestrator.launch(buildRequest()); // run-2: governor says queue
    expect(handleB.status).toBe("queued");

    let drainResolved = false;
    const drainPromise = orchestrator.drain().then(() => {
      drainResolved = true;
    });
    await flush();
    expect(drainResolved).toBe(false);

    callA.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await drainPromise;

    expect(drainResolved).toBe(true);
    // Only run-1 should ever have reached an executor — run-2 must stay
    // queued for boot reconciliation, never started by drain's own pump.
    expect(spawnExecutor.calls).toHaveLength(1);
    expect(orchestrator.activeCount).toBe(0);
    expect(registry.rows.get(handleB.id)?.status).toBe("queued");
  });

  // The loop-based fix must generalise beyond the `pumpQueue` path: ANY run
  // that enters `ctx.active` after `drainActive`'s first snapshot — not only
  // one started by a pump — must still be awaited. A `launch()` call is used
  // here (rather than a queued run) specifically to isolate that more
  // general guarantee from the `pumpQueue`-specific scenario above. The
  // `launch()` call below happens synchronously, in the same microtask turn
  // as the `drain()` call that precedes it (no `await` sits between them),
  // so it is guaranteed to run AFTER `drainActive` already captured its
  // snapshot of `ctx.active` and BEFORE that snapshot's promises settle.
  test("[PR#730] drain awaits a straggler that enters ctx.active after the initial snapshot was taken", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, {
      "sqs-etl": ["accept"],
      "straggler-script": ["accept"],
    });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: createIdSequence("run") },
    );

    orchestrator.launch(buildRequest());
    await flush();
    const callA = spawnExecutor.calls[0];
    if (callA === undefined) throw new Error("run-1 did not start");

    let drainResolved = false;
    const drainPromise = orchestrator.drain().then(() => {
      drainResolved = true;
    });

    // No `await` above this line: this launch runs in the same synchronous
    // turn as `drain()`, strictly after whatever snapshot `drainActive` took
    // of `ctx.active`, and strictly before run-1 settles.
    orchestrator.launch(
      buildRequest({ body: { scriptName: "straggler-script" } }),
    );
    const callStraggler = spawnExecutor.calls[1];
    if (callStraggler === undefined) {
      throw new Error("straggler run did not start");
    }

    callA.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await flush();

    // The straggler has not settled yet — a correct drain must still be
    // waiting on it, not resolved already.
    expect(drainResolved).toBe(false);

    callStraggler.resolve({
      exitCode: 0,
      killRequested: false,
      dryRun: false,
    });
    await drainPromise;

    expect(drainResolved).toBe(true);
    expect(orchestrator.activeCount).toBe(0);
  });

  // Regression lock: two ordinary active runs with nothing queued — the
  // scenario the pre-fix implementation already handles correctly (mirrors
  // the sibling "no queued run" test above, with a second concurrent active
  // run added). This is expected to already pass against the pre-fix
  // implementation; it exists to prove the drain-loop rewrite required by
  // PR #730 does not regress the already-correct "no straggler" path.
  test("regression: two active runs with nothing queued are both aborted and both awaited before drain resolves", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, {
      "sqs-etl": ["accept"],
      "another-script": ["accept"],
    });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: createIdSequence("run") },
    );

    orchestrator.launch(buildRequest());
    orchestrator.launch(
      buildRequest({ body: { scriptName: "another-script" } }),
    );
    await flush();
    const callA = spawnExecutor.calls[0];
    const callB = spawnExecutor.calls[1];
    if (callA === undefined || callB === undefined) {
      throw new Error("both runs did not start");
    }

    let drainResolved = false;
    const drainPromise = orchestrator.drain().then(() => {
      drainResolved = true;
    });
    await flush();

    expect(callA.options.signal.aborted).toBe(true);
    expect(callB.options.signal.aborted).toBe(true);
    expect(drainResolved).toBe(false);

    callA.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await flush();
    expect(drainResolved).toBe(false);

    callB.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await drainPromise;

    expect(drainResolved).toBe(true);
    expect(orchestrator.activeCount).toBe(0);
  });

  // The `ctx.draining` guard must never be reset — it protects `pumpQueue`
  // permanently, not only for the duration of the initial drain. A second,
  // later `launch()`/finish cycle for an unrelated script (launching after
  // drain is out of scope for this fix — only `pumpQueue` is guarded) must
  // still find the queue closed when ITS finish tries to pump again.
  test("[PR#730] pumpQueue stays closed for a finish that happens after drain has already resolved", async () => {
    mockScriptExists(false);
    const log: string[] = [];
    const registry = createFakeRegistry(log);
    const governor = createFakeGovernor(log, {
      "sqs-etl": ["accept", "queue"],
      "post-drain-script": ["accept"],
    });
    const policy = createFakePolicy(log, { kind: "allow" });
    const audit = createFakeAudit(log);
    const events = createFakeEvents(log);
    const spawnExecutor = createControllableExecutor(log, "spawn");
    const inProcessExecutor = createControllableExecutor(log, "inProcess");
    const { logger } = buildLogger();
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
      { newId: createIdSequence("run") },
    );

    orchestrator.launch(buildRequest()); // run-1: active on "sqs-etl"
    await flush();
    const callA = spawnExecutor.calls[0];
    if (callA === undefined) throw new Error("run-1 did not start");

    const handleB = orchestrator.launch(buildRequest()); // run-2: queued on "sqs-etl"
    expect(handleB.status).toBe("queued");

    const drainPromise = orchestrator.drain();
    callA.resolve({ exitCode: 0, killRequested: true, dryRun: false });
    await drainPromise;

    // Drain has now fully resolved. A run on an unrelated script is still
    // free to launch; when IT finishes, its own `finishActiveRun` calls
    // `pumpQueue` again. That second, post-drain pump attempt must ALSO
    // leave the still-queued run-2 alone.
    const handleD = orchestrator.launch(
      buildRequest({ body: { scriptName: "post-drain-script" } }),
    );
    expect(handleD.status).toBe("running");
    const callD = spawnExecutor.calls[1];
    if (callD === undefined) throw new Error("run-D did not start");

    callD.resolve({ exitCode: 0, killRequested: false, dryRun: false });
    await flush();

    expect(registry.rows.get(handleB.id)?.status).toBe("queued");
    expect(spawnExecutor.calls).toHaveLength(2);
  });
});

describe("M3LRunHandle — type shape", () => {
  test("status is exactly 'queued' | 'running'", () => {
    expectTypeOf<M3LRunHandle["status"]>().toEqualTypeOf<
      "queued" | "running"
    >();
  });
});

describe("M3LRunOrchestratorOptions — type shape", () => {
  test("carries every documented collaborator", () => {
    expectTypeOf<M3LRunOrchestratorOptions>().toExtend<{
      readonly config: M3LConsoleRunsConfig;
      readonly registry: M3LRunRegistry;
      readonly governor: M3LRunGovernor;
      readonly policy: M3LRunPolicy;
      readonly audit: M3LRunAuditSink;
      readonly events: M3LRunEventSink;
      readonly spawnExecutor: M3LRunExecutor;
      readonly inProcessExecutor: M3LRunExecutor;
      readonly logger: Core.M3LLogger;
    }>();
  });
});
