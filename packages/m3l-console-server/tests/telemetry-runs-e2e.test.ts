/**
 * End-to-end tests for the X8 slice 3a run-telemetry wiring, driven through
 * the REAL composition chain (`main.ts` -> `subsystems.ts` ->
 * `runs/composition.ts` -> `createRunOrchestrator`) against a REAL
 * `:memory:` SQLite store, mirroring `tests/telemetry-http-e2e.test.ts`'s own
 * rationale for slice 2b's HTTP metric.
 *
 * `telemetry` is optional at every one of those hops, and
 * `createRunOrchestrator` silently falls back to a no-op recorder when it is
 * absent (`src/runs/orchestrator.ts`'s own `ctx.telemetry = options.telemetry
 * ?? createNoOpTelemetryRecorder()`). Every unit test in
 * `tests/telemetry-runs.test.ts` injects the recorder directly into
 * `createRunOrchestrator`, so none of them can catch a hop that failed to
 * FORWARD the option it was given — `tsc`, `knip`, and every one of those
 * unit tests would stay green even if `main.ts`/`subsystems.ts`/
 * `runs/composition.ts` dropped `telemetry` on the floor. This file closes
 * that gap: it builds the runtime through `createConsoleRuntime` exactly as
 * a real caller would (`telemetry: store.telemetry`, `runs: store.runs`),
 * launches a real run through `runtime.runs.orchestrator.launch`, and reads
 * the rollup table back through `store.telemetry.list()`, scoped to the
 * `run.finished` metric (see {@link countMetricRows} for why never `count()`).
 *
 * Isolation: `:memory:` only, never a real file — every store here is opened
 * via `openConsoleStore({ location: ":memory:" })` and closed in `afterEach`
 * (mirrors `tests/telemetry-http-e2e.test.ts`'s own header comment). The
 * audit root is pointed at a deliberately-nonexistent tmpdir path, same as
 * that sibling.
 *
 * No real script directory and no real child process is ever touched:
 * `node:fs`'s `existsSync`/`lstatSync` are mocked so `runs/resolver.ts`
 * resolves every requested script to a SPAWN-mode script (no
 * `dist/command.js`), and `node:child_process`'s `spawn` is mocked so the
 * spawn executor's child process is a fake that reports a `"close"` event
 * with a caller-chosen exit code — mirrors
 * `tests/runs-composition.test.ts`'s own `mockScriptResolvable`/
 * `mockSpawnReturns` pattern, which is this package's established seam for
 * driving a REAL orchestrator through a REAL launch without touching the
 * real filesystem or a real process. Both are legitimate collaborator
 * mocks at the OS boundary, not a library-barrel mock: the orchestrator,
 * registry, governor, policy, and telemetry recorder are all real.
 *
 * The fake child's `"close"` listener fires via `queueMicrotask`, not
 * `setImmediate`: it is registered synchronously inside
 * `runs/executor.ts`'s `awaitSpawnedChild` Promise constructor, itself
 * called synchronously from `orchestrator.launch()`. Node drains every
 * queued microtask (the fake close event, the executor's own `.then`
 * continuation, and `recordFinish`'s synchronous telemetry fan-out) before
 * running any macrotask, so a single `await flush()` — a `setImmediate`-based
 * promise, mirroring `tests/telemetry-runs.test.ts`'s own helper — is
 * sufficient to observe the terminal write.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import { createConsoleRuntime } from "../src/main.js";
import type { M3LConsoleRuntime } from "../src/main.js";
import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import { openConsoleStore } from "../src/store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
} from "../src/store/store.js";
import type { M3LTelemetryMetric } from "../src/store/telemetry-repository.js";

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
 * A minimal valid env: only the required operator name plus an audit root
 * that deliberately does not exist — mirrors
 * `tests/telemetry-http-e2e.test.ts`'s own `buildEnv`. `runsConfig` is
 * always supplied explicitly below, so no `M3L_CONSOLE_RUNS_SCRIPTS_DIR` is
 * needed here.
 */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(
      tmpdir(),
      "m3l-console-telemetry-runs-e2e-audit-absent",
    ),
  };
}

/** A fully-populated {@link M3LConsoleRunsConfig}, the `runsConfig` test seam that skips `loadRunsConfig`. */
function buildRunsConfig(): M3LConsoleRunsConfig {
  return {
    scriptsDir: SCRIPTS_ROOT,
    maxPerScript: 4,
    queueCapacity: 16,
    streamRetention: 256,
    killTimeoutMs: 5000,
    maxConcurrency: 4,
    queueTimeoutMs: 30_000,
  };
}

/**
 * A capturing `Core.M3LLoggerHandler`, the sanctioned test-double pattern
 * for this package — passed through `createConsoleRuntime`'s `handlers`
 * option, which builds a real `Core.M3LLogger` (private fields, so it
 * cannot be duck-typed) over it internally. Mirrors
 * `tests/telemetry-http-e2e.test.ts`'s own `buildCapturingHandler`.
 */
function buildCapturingHandler(): {
  readonly handler: Core.M3LLoggerHandler;
  readonly events: Core.M3LLogEvent[];
} {
  const events: Core.M3LLogEvent[] = [];
  const handler: Core.M3LLoggerHandler = {
    handle: (event) => {
      events.push(event);
    },
    reset: () => {
      events.length = 0;
    },
  };
  return { handler, events };
}

/**
 * Configures `fs.existsSync` so `resolveScript` resolves any kebab-case name
 * under `SCRIPTS_ROOT` to a SPAWN-mode script (no `dist/command.js`) —
 * mirrors `tests/runs-composition.test.ts`'s `mockScriptResolvable` /
 * `tests/telemetry-runs.test.ts`'s `mockSpawnModeScripts`. Also stubs
 * `fs.lstatSync` to report a plain (non-symlink) directory entry, since the
 * fictional `SCRIPTS_ROOT` does not exist on the real filesystem and the
 * resolver's symlink-containment guard fails CLOSED on an unstat-able path.
 */
function mockScriptResolvable(): void {
  vi.spyOn(fs, "existsSync").mockImplementation(
    (target: fs.PathLike) => !String(target).endsWith("command.js"),
  );
  vi.spyOn(fs, "lstatSync").mockImplementation((() => ({
    isSymbolicLink: () => false,
  })) as unknown as typeof fs.lstatSync);
}

/** A listener a fake spawned process's `once()` may be given. */
type FakeOnceListener = (...args: readonly unknown[]) => void;

/** The narrow shape `createSpawnExecutor`'s `spawn` seam is cast down to — mirrors `tests/runs-composition.test.ts`'s identical fixture. */
interface FakeSpawnedProcess {
  readonly stdout: null;
  readonly stderr: null;
  kill(signal?: string): boolean;
  once(event: string, listener: FakeOnceListener): unknown;
}

/**
 * A fake spawned process that reports itself closed with `exitCode` almost
 * immediately: the `"close"` listener registration schedules the callback
 * via `queueMicrotask` rather than firing synchronously (the real
 * `child_process.spawn` never resolves synchronously either), which is
 * enough — see this file's header comment on why a single `flush()` still
 * observes the result.
 */
function createImmediateSpawnedProcess(exitCode: number): FakeSpawnedProcess {
  const process: FakeSpawnedProcess = {
    stdout: null,
    stderr: null,
    kill: vi.fn(() => true),
    once(event: string, listener: FakeOnceListener): unknown {
      if (event === "close") {
        queueMicrotask(() => {
          listener(exitCode, null);
        });
      }
      return process;
    },
  };
  return process;
}

/** Wires the mocked `node:child_process` `spawn` to return `childHandle` for every call. */
function mockSpawnReturns(childHandle: FakeSpawnedProcess): void {
  vi.mocked(childProcess.spawn).mockImplementation(
    (() => childHandle) as unknown as typeof childProcess.spawn,
  );
}

/** The three granularity tiers every telemetry sample fans out to. */
const GRANULARITY_TIERS = ["minute", "hour", "day"] as const;

/**
 * Counts the persisted `console_telemetry_rollup` rows for ONE metric,
 * summed across all three granularity tiers.
 *
 * THIS IS THE REPRESENTATIVE SITE for a rule every telemetry e2e file in
 * this package follows — please read it before "simplifying" any of them
 * back to `store.telemetry.count()`.
 *
 * `M3LConsoleTelemetryRepository.count()` totals rows for EVERY metric in
 * the table, which makes a global-total assertion a cross-file coupling
 * rather than a statement about the test's own subject. One launch (or one
 * request) drives several independent telemetry producers, so every new
 * producer shifts the total for every existing test: X8 slice 3c's
 * `policy.decision` emits turned this file's `count()` of 3 into 9, and the
 * failure named a file whose author never touched `policy.decision` at all.
 * Scoping the count to the metric under test keeps it stable as producers
 * are added while still failing if THIS metric's own three-tier fan-out
 * regresses — which is the only thing the assertion was ever about.
 *
 * The `limit` is a generous cap far above the one-row-per-tier this file
 * expects, so a runaway fan-out surfaces as a count ABOVE the expectation
 * rather than being silently truncated to it.
 *
 * @param telemetry - The real store's telemetry repository.
 * @param metric - The single metric to count rows for.
 * @returns The number of rollup rows carrying `metric`, across all tiers.
 */
function countMetricRows(
  telemetry: M3LConsoleStore["telemetry"],
  metric: M3LTelemetryMetric,
): number {
  return GRANULARITY_TIERS.reduce(
    (total, granularity) =>
      total + telemetry.list({ granularity, metric, limit: 100 }).length,
    0,
  );
}

/** Yields to the microtask queue AND one macrotask tick, so a fake close event and its downstream telemetry write both settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Builds a confirmed, non-dry-run launch request for `scriptName`. */
function buildLaunchRequest(scriptName: string): {
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
    body: { scriptName, confirmed: true, dryRun: false, parameters: {} },
    operator: "ada",
    correlationId: "corr-1",
  };
}

describe("telemetry-runs-e2e — real store, real composed runtime", () => {
  let store: (M3LConsoleStoreHandle & M3LConsoleStore) | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  /** Builds the real runtime, wired exactly as a real caller would wire it. */
  function buildRuntime(handler: Core.M3LLoggerHandler): M3LConsoleRuntime {
    if (store === undefined) throw new Error("store was not opened yet");
    return createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      runs: store.runs,
      runsConfig: buildRunsConfig(),
      telemetry: store.telemetry,
    });
  }

  test("a successful run's telemetry.runFinished fans out to all three granularity tiers, with the resolved script name and a duration measure", async () => {
    mockScriptResolvable();
    mockSpawnReturns(createImmediateSpawnedProcess(0));
    store = openConsoleStore({ location: ":memory:" });
    const { handler, events } = buildCapturingHandler();
    const runtime = buildRuntime(handler);

    if (runtime.runs === undefined) {
      throw new Error("the run subsystem was not wired onto the runtime");
    }
    const handle = runtime.runs.orchestrator.launch(
      buildLaunchRequest("sqs-etl"),
    );
    expect(handle.status).toBe("running");

    await flush();

    // Fans out to minute/hour/day, exactly one row per tier — mirrors
    // `tests/telemetry-http-e2e.test.ts`'s identical assertion for the same
    // reason (one metric, one sample, three granularities). Metric-SCOPED,
    // never `store.telemetry.count()` — see `countMetricRows`' own doc.
    expect(countMetricRows(store.telemetry, "run.finished")).toBe(3);

    const buckets = store.telemetry.list({
      granularity: "minute",
      metric: "run.finished",
      limit: 10,
    });
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket?.script).toBe("sqs-etl");
    expect(bucket?.outcome).toBe("success");
    expect(bucket?.sampleCount).toBe(1);
    // Exactly one sample merged in: sum/min/max must all agree, and the
    // measure itself must be a real (non-negative) duration, not a
    // placeholder.
    expect(typeof bucket?.sumValue).toBe("number");
    expect(bucket?.sumValue).toBeGreaterThanOrEqual(0);
    expect(bucket?.minValue).toBe(bucket?.sumValue);
    expect(bucket?.maxValue).toBe(bucket?.sumValue);

    // A rejected/dropped write is otherwise invisible except for the count
    // (`createStoreTelemetryRecorder` swallows a repository failure as a
    // logged warning rather than throwing) — assert its absence explicitly.
    // This is the case that actually proves the wiring: if any hop between
    // `main.ts` and `createRunOrchestrator` failed to forward `telemetry`,
    // the orchestrator would use its no-op default instead, and the count
    // assertion above (not this one) would be the one to fail.
    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });

  test("a failing run's telemetry.runFinished records outcome 'failure', distinct from a successful run", async () => {
    mockScriptResolvable();
    mockSpawnReturns(createImmediateSpawnedProcess(1));
    store = openConsoleStore({ location: ":memory:" });
    const { handler, events } = buildCapturingHandler();
    const runtime = buildRuntime(handler);

    if (runtime.runs === undefined) {
      throw new Error("the run subsystem was not wired onto the runtime");
    }
    const handle = runtime.runs.orchestrator.launch(
      buildLaunchRequest("json-etl"),
    );
    expect(handle.status).toBe("running");

    await flush();

    expect(countMetricRows(store.telemetry, "run.finished")).toBe(3);

    const buckets = store.telemetry.list({
      granularity: "minute",
      metric: "run.finished",
      limit: 10,
    });
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket?.script).toBe("json-etl");
    expect(bucket?.outcome).toBe("failure");
    expect(bucket?.sampleCount).toBe(1);

    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });
});
