/**
 * Tests for src/runs/orchestrator.ts — the audit-trail assertions: the two
 * launch refusals that must record an audit entry BEFORE they throw, and
 * boot reconciliation's `run.reconciled` entry.
 *
 * Split out of `runs-orchestrator.test.ts` (which already sheds its queue
 * scenarios into `runs-orchestrator-queue.test.ts`) to keep each file under
 * the per-file budget and to give X7's human-action audit work a file it can
 * grow into. `vitest.config.ts`'s `perFile: true` coverage binds
 * `orchestrator.ts` to every test file importing from it, so all three files
 * together are what satisfy that module's coverage floor.
 *
 * Fakes are copied locally rather than imported from the sibling test files
 * (this package's established convention — see `runs-events.test.ts`'s own
 * comment on `RecordingHandler`), trimmed to only what these scenarios need.
 * `resolveScript` is exercised for real; only `node:fs`'s `existsSync` is
 * mocked, via the async-factory form.
 */
import * as fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

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
/**
 * Configures `existsSync` so `resolveScript` resolves a script with (or
 * without) a command module. Also stubs `fs.lstatSync` to report a plain
 * (non-symlink) directory entry — `resolveScript`'s symlink containment
 * guard fails CLOSED when a path cannot be stat'd, and the fictional
 * `SCRIPTS_ROOT` used throughout this file does not exist on the real
 * filesystem (mirrors `runs-resolver.test.ts`'s `mockLstatSyncNotSymlink`).
 */
function mockScriptExists(hasCommandModule: boolean): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) =>
      !(String(target).endsWith("command.js") && !hasCommandModule),
  );
  vi.spyOn(fs, "lstatSync").mockImplementation((() => ({
    isSymbolicLink: () => false,
  })) as unknown as typeof fs.lstatSync);
}
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
