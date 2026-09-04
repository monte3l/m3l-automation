/**
 * End-to-end coverage for X8 slice 3c's `policy.decision` telemetry, driven
 * through the REAL composition chain (`main.ts` -> `subsystems.ts` ->
 * `runs/composition.ts` -> `createRunOrchestrator` -> `admitRun`) against a
 * REAL `:memory:` SQLite store — the harness and rationale of
 * `tests/telemetry-runs-e2e.test.ts` (slice 3a) and
 * `tests/telemetry-sse-e2e.test.ts` (slice 3b), which state it at their own
 * `:7-21`. Slices 2b/3a/3b each ship one of these; this is 3c's.
 *
 * WHY THIS FILE EXISTS, stated as what only it can prove. `telemetry` is
 * optional at every hop of that chain and `createRunOrchestrator` falls back
 * to a no-op recorder when it is absent, so every unit test in
 * `tests/telemetry-policy.test.ts` — which injects the recorder straight
 * into `createRunOrchestrator` — stays green even if a hop drops the option.
 * Beyond that wiring gap, the emitted SAMPLE and the persisted ROW are not
 * the same object: `createStoreTelemetryRecorder` maps one to the other and
 * swallows a repository rejection as a logged `warning` rather than throwing
 * (`src/telemetry-recorder.ts`), so a row the DATABASE refuses is invisible
 * at the port boundary. `console_telemetry_rollup`'s v11 DDL has real teeth
 * here — `(script <> '') = (metric = 'run.finished')` and the
 * `posture <> ''` requirement for this metric — and only a real store can
 * report whether the row survived them.
 *
 * WHY THE ASSERTIONS PIN DIMENSIONS, NOT ROW EXISTENCE. `SQL_UPSERT_COUNTER`
 * (`src/store/telemetry-repository.ts:94`) binds `sum_value`/`min_value`/
 * `max_value` as SQL `NULL` LITERALS and never reads a measure field off the
 * measurement, so no `CHECK` constraint can catch a wrong `posture` or
 * `outcome`: a regression that emitted `posture: "enforce"` would land a row,
 * leave `count()` unchanged, log no warning, and satisfy any "a row exists"
 * assertion. `posture`/`outcome` are also part of this table's PERMANENT
 * primary key, so a wrong value is not a display bug — it splits the rollup
 * bucket and pollutes the store for good. Every assertion below therefore
 * names the exact `posture`/`outcome` pair, the `''` sentinels the DDL
 * requires, and the absent measures. Mutation-verified: changing the
 * `"confirmation"` literal in `src/runs/admission.ts` to `"enforce"` makes
 * the first test fail on the missing `confirmation`/`allow` row.
 *
 * Isolation: `:memory:` only, never a real file — this package has a
 * standing history of tests accidentally opening the real store (see
 * `tests/main-store.test.ts`'s own header), so every store here is opened
 * via `openConsoleStore({ location: ":memory:" })` and closed in `afterEach`.
 * The audit root is a deliberately-nonexistent tmpdir path, same as both
 * siblings.
 *
 * No real script directory and no real child process is touched: `node:fs`'s
 * `existsSync`/`lstatSync` are mocked so `runs/resolver.ts` resolves every
 * requested script to a SPAWN-mode script, and `node:child_process`'s
 * `spawn` is mocked to a fake child that reports `"close"` with a
 * caller-chosen exit code — `tests/runs-composition.test.ts`'s established
 * seam for driving a REAL orchestrator through a REAL launch. Both are
 * collaborator mocks at the OS boundary, not a library-barrel mock: the
 * orchestrator, registry, governor, confirmation policy, telemetry recorder
 * and store are all real.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleRunsConfig } from "../src/config/runs.js";
import { M3LConsoleError } from "../src/errors/console-error.js";
import { createConsoleRuntime } from "../src/main.js";
import type { M3LConsoleRuntime } from "../src/main.js";
import { openConsoleStore } from "../src/store/store.js";
import type {
  M3LConsoleStore,
  M3LConsoleStoreHandle,
} from "../src/store/store.js";
import type {
  M3LTelemetryBucket,
  M3LTelemetryGranularity,
  M3LTelemetryMetric,
} from "../src/store/telemetry-repository.js";

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

/** The three granularity tiers every telemetry sample fans out to. */
const GRANULARITY_TIERS: readonly M3LTelemetryGranularity[] = [
  "minute",
  "hour",
  "day",
];

/**
 * Counts the persisted `console_telemetry_rollup` rows for ONE metric,
 * summed across all three granularity tiers.
 *
 * Metric-SCOPED on purpose: `M3LConsoleTelemetryRepository.count()` totals
 * rows for EVERY metric, so every new telemetry producer shifts the total
 * that every existing test asserts — do NOT change these back to `count()`.
 * The full rationale (and the concrete breakage that prompted it) lives at
 * `tests/telemetry-runs-e2e.test.ts`'s own `countMetricRows`. The `limit` is
 * a generous cap far above the handful of rows expected here, so a runaway
 * fan-out surfaces as a count ABOVE the expectation rather than truncated
 * down to it.
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

/** Reads every persisted `policy.decision` row at `granularity`. */
function policyRowsAt(
  telemetry: M3LConsoleStore["telemetry"],
  granularity: M3LTelemetryGranularity,
): readonly M3LTelemetryBucket[] {
  return telemetry.list({
    granularity,
    metric: "policy.decision",
    limit: 100,
  });
}

/**
 * A `(posture, outcome)` pair, as the persisted row carries it. Declared as
 * a tuple so a fixture list of expected pairs cannot silently widen.
 */
type PostureOutcome = readonly [posture: string, outcome: string];

/** Projects rows to their `(posture, outcome)` pairs, sorted for a stable comparison. */
function postureOutcomePairs(
  rows: readonly M3LTelemetryBucket[],
): readonly string[] {
  return rows.map((row) => `${row.posture}/${row.outcome}`).sort();
}

/** Formats an expected pair the same way {@link postureOutcomePairs} formats an actual one. */
function pairKey([posture, outcome]: PostureOutcome): string {
  return `${posture}/${outcome}`;
}

/**
 * Finds the single row carrying `posture`/`outcome`, or `undefined`. A
 * lookup rather than an index: the row order within one bucket is a
 * `ORDER BY` detail this file has no reason to pin.
 */
function findRow(
  rows: readonly M3LTelemetryBucket[],
  [posture, outcome]: PostureOutcome,
): M3LTelemetryBucket | undefined {
  return rows.find((row) => row.posture === posture && row.outcome === outcome);
}

/**
 * Asserts everything the v11 DDL and the "pure counter" contract require of
 * a `policy.decision` row, beyond its `posture`/`outcome`.
 *
 * `script` must be `''`: `console_telemetry_rollup`'s
 * `(script <> '') = (metric = 'run.finished')` CHECK makes any other value
 * a rejected INSERT, which `createStoreTelemetryRecorder` would swallow as a
 * logged warning — so the row simply would not be here to assert on, and the
 * `''` assertion documents WHY the absence would have been the symptom.
 * `route`/`operation` are the same `''` not-applicable sentinel. The three
 * measures must be absent because this metric is a pure counter
 * (`SQL_UPSERT_COUNTER` binds them as SQL `NULL`, surfaced by
 * `M3LTelemetryBucket` as `undefined`).
 */
function expectCounterRowShape(row: M3LTelemetryBucket): void {
  expect(row.metric).toBe("policy.decision");
  expect(row.script).toBe("");
  expect(row.route).toBe("");
  expect(row.operation).toBe("");
  expect(row.sumValue).toBeUndefined();
  expect(row.minValue).toBeUndefined();
  expect(row.maxValue).toBeUndefined();
}

/**
 * A minimal valid env: only the required operator name plus an audit root
 * that deliberately does not exist — mirrors both sibling e2e files'
 * `buildEnv`. `runsConfig` is always supplied explicitly below, so no
 * `M3L_CONSOLE_RUNS_SCRIPTS_DIR` is needed.
 */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    M3L_CONSOLE_AUDIT_ROOT: path.join(
      tmpdir(),
      "m3l-console-telemetry-policy-e2e-audit-absent",
    ),
  };
}

/** A fully-populated {@link M3LConsoleRunsConfig}, the `runsConfig` seam that skips `loadRunsConfig`. */
function buildRunsConfig(
  overrides: Partial<M3LConsoleRunsConfig> = {},
): M3LConsoleRunsConfig {
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
 * A capturing `Core.M3LLoggerHandler`, the sanctioned test-double pattern
 * for this package — passed through `createConsoleRuntime`'s `handlers`
 * option, which builds a real `Core.M3LLogger` (private fields, so it cannot
 * be duck-typed) over it internally.
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
 * under `SCRIPTS_ROOT` to a SPAWN-mode script (no `dist/command.js`), and
 * stubs `fs.lstatSync` to report a plain (non-symlink) entry — the fictional
 * `SCRIPTS_ROOT` does not exist on the real filesystem and the resolver's
 * symlink-containment guard fails CLOSED on an unstat-able path.
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

/** The narrow shape `createSpawnExecutor`'s `spawn` seam is cast down to. */
interface FakeSpawnedProcess {
  readonly stdout: null;
  readonly stderr: null;
  kill(signal?: string): boolean;
  once(event: string, listener: FakeOnceListener): unknown;
}

/**
 * A fake spawned process that reports itself closed with `exitCode` via
 * `queueMicrotask` (the real `child_process.spawn` never resolves
 * synchronously either).
 */
function createImmediateSpawnedProcess(exitCode: number): FakeSpawnedProcess {
  const child: FakeSpawnedProcess = {
    stdout: null,
    stderr: null,
    kill: vi.fn(() => true),
    once(event: string, listener: FakeOnceListener): unknown {
      if (event === "close") {
        queueMicrotask(() => {
          listener(exitCode, null);
        });
      }
      return child;
    },
  };
  return child;
}

/** Wires the mocked `node:child_process` `spawn` to return `childHandle` for every call. */
function mockSpawnReturns(childHandle: FakeSpawnedProcess): void {
  vi.mocked(childProcess.spawn).mockImplementation(
    (() => childHandle) as unknown as typeof childProcess.spawn,
  );
}

/** Yields to the microtask queue AND one macrotask tick, so a fake close event and its downstream telemetry writes settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Builds a launch request for `scriptName`; confirmed and non-dry-run unless overridden. */
function buildLaunchRequest(
  scriptName: string,
  overrides: Partial<{
    readonly confirmed: boolean;
    readonly dryRun: boolean;
  }> = {},
): {
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
    body: {
      scriptName,
      confirmed: overrides.confirmed ?? true,
      dryRun: overrides.dryRun ?? false,
      parameters: {},
    },
    operator: "ada",
    correlationId: "corr-1",
  };
}

/** Runs `launch`, returning whatever it threw (or `undefined`). */
function captureThrow(launch: () => void): unknown {
  try {
    launch();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("telemetry-policy-e2e — real store, real composed runtime", () => {
  let store: (M3LConsoleStoreHandle & M3LConsoleStore) | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  /** Builds the real runtime, wired exactly as a real caller would wire it. */
  function buildRuntime(
    handler: Core.M3LLoggerHandler,
    runsConfigOverrides: Partial<M3LConsoleRunsConfig> = {},
  ): M3LConsoleRuntime {
    if (store === undefined) throw new Error("store was not opened yet");
    return createConsoleRuntime({
      env: buildEnv(),
      handlers: [handler],
      runs: store.runs,
      runsConfig: buildRunsConfig(runsConfigOverrides),
      telemetry: store.telemetry,
    });
  }

  test("a confirmed non-dry-run launch persists confirmation/allow AND admission/accept policy.decision rows at all three granularities, each a measure-free counter with an empty script", async () => {
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
    // Precondition: the launch really passed BOTH gates, so both rows are
    // genuinely reachable — a launch refused at the confirmation gate would
    // make the admission-row assertions below unfalsifiable rather than true.
    expect(handle.status).toBe("running");

    await flush();

    const CONFIRMATION_ALLOW: PostureOutcome = ["confirmation", "allow"];
    const ADMISSION_ACCEPT: PostureOutcome = ["admission", "accept"];

    // Two distinct dimension combinations, three granularity tiers each.
    expect(countMetricRows(store.telemetry, "policy.decision")).toBe(6);

    for (const granularity of GRANULARITY_TIERS) {
      const rows = policyRowsAt(store.telemetry, granularity);
      // Exactly these two pairs at every tier, and nothing else: an extra
      // row carrying some other posture would fail here, which a
      // `find(...)`-only check could not.
      expect(postureOutcomePairs(rows)).toEqual(
        [pairKey(CONFIRMATION_ALLOW), pairKey(ADMISSION_ACCEPT)].sort(),
      );

      for (const expected of [CONFIRMATION_ALLOW, ADMISSION_ACCEPT]) {
        const row = findRow(rows, expected);
        expect(row).toBeDefined();
        if (row === undefined) continue;
        expect(row.granularity).toBe(granularity);
        expect(row.sampleCount).toBe(1);
        expectCounterRowShape(row);
      }
    }

    // A repository rejection is otherwise invisible — `createStoreTelemetryRecorder`
    // swallows it as a logged warning rather than throwing — so its absence
    // is asserted explicitly, mirroring every sibling e2e file's guard.
    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });

  test("a launch refused at the confirmation gate persists ONLY a confirmation/deny row per tier — no admission-posture row — and still throws ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED", async () => {
    mockScriptResolvable();
    mockSpawnReturns(createImmediateSpawnedProcess(0));
    store = openConsoleStore({ location: ":memory:" });
    const { handler, events } = buildCapturingHandler();
    // maxConcurrency/queueCapacity are left wide open, so the admission
    // governor WOULD accept this launch if the confirmation gate let it
    // through: the "no admission row" claim below is a real ordering
    // guarantee, not an artefact of a governor that could only refuse.
    const runtime = buildRuntime(handler);

    if (runtime.runs === undefined) {
      throw new Error("the run subsystem was not wired onto the runtime");
    }
    const thrown = captureThrow(() => {
      runtime.runs?.orchestrator.launch(
        buildLaunchRequest("sqs-etl", { confirmed: false, dryRun: false }),
      );
    });

    // Precondition: the refusal really happened at the confirmation gate.
    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED",
    );

    await flush();

    const CONFIRMATION_DENY: PostureOutcome = ["confirmation", "deny"];

    // One dimension combination, three tiers.
    expect(countMetricRows(store.telemetry, "policy.decision")).toBe(3);
    // The refused launch never ran, so it contributed no run.finished row
    // either — which is what makes the count above attributable to the
    // confirmation gate alone.
    expect(countMetricRows(store.telemetry, "run.finished")).toBe(0);

    for (const granularity of GRANULARITY_TIERS) {
      const rows = policyRowsAt(store.telemetry, granularity);
      expect(postureOutcomePairs(rows)).toEqual([pairKey(CONFIRMATION_DENY)]);
      const row = findRow(rows, CONFIRMATION_DENY);
      expect(row).toBeDefined();
      if (row === undefined) continue;
      expect(row.granularity).toBe(granularity);
      expect(row.sampleCount).toBe(1);
      expectCounterRowShape(row);
    }

    expect(
      events.some((event) =>
        event.message.includes("telemetry fan-out dropped"),
      ),
    ).toBe(false);
  });
});
