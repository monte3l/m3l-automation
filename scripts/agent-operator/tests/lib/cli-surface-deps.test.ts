/**
 * RED-phase tests for GitHub issue #1019: `createAgentCliSurface`
 * (`src/lib/cli-surface.ts`) reads its ten REQUIRED constructor deps with
 * plain dot access. A caller handing it an incomplete bag through a cast
 * (exactly the shape a `steps/*.ts` composition root builds from parsed
 * config) inherits a missing key from `Object.prototype`, and six of the ten
 * keys (`cliTimeoutMs`, `dryRunTimeoutMs`, `flowTimeoutMs`,
 * `dryRunAllowlist`, `presetAllowlist`, `flowAllowlist`) are additionally
 * re-read LIVE off `deps` on every method call rather than snapshotted once
 * at construction — see `src/lib/cli-surface.ts`'s `createAgentCliSurface`
 * (the `ctx` object captures only `entrypoint`/`cwd`/`nodeExecPath`/
 * `maxOutputBytes`/`workspaceRoot`/`signal`/`runProcess`; every method
 * closure below it reads `deps.<key>` directly).
 *
 * Every scenario here goes through the PUBLIC `createAgentCliSurface`
 * factory only — the guard this file proves against is expected to live as
 * module-private helpers inside `cli-surface.ts`, so no new exported symbol
 * is assumed to exist.
 *
 * This file is deliberately separate from `cli-surface.test.ts`
 * (`tests.md`'s per-slice file-naming convention) so a coverage-binding run
 * does not have to import the whole existing suite's barrel to exercise this
 * slice.
 *
 * @packageDocumentation
 */
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { CliRunResult, runCliProcess } from "../../src/lib/cli-process.js";
import {
  createAgentCliSurface,
  type AgentCliSurface,
  type CreateAgentCliSurfaceOptions,
} from "../../src/lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  createFakeRunCliProcess,
  exitedResult,
  makeDoctorPayload,
  makeInspectPayload,
  makeListPayload,
  makeRunEnvelope,
  makeRunEnvelopePayload,
} from "../support/cliFakes.js";
import { createPrototypePollutionHarness } from "../support/prototypePollution.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The ten required key names, in `CreateAgentCliSurfaceOptions` declaration order. */
const REQUIRED_KEYS = [
  "entrypoint",
  "cwd",
  "nodeExecPath",
  "cliTimeoutMs",
  "dryRunTimeoutMs",
  "flowTimeoutMs",
  "maxOutputBytes",
  "dryRunAllowlist",
  "presetAllowlist",
  "flowAllowlist",
] as const;

type RequiredKey = (typeof REQUIRED_KEYS)[number];

const ENTRYPOINT = "/repo/packages/m3l-cli/bin/m3l.mjs";
const CWD = "/repo";
const NODE_EXEC_PATH = "/usr/bin/node";
const CLI_TIMEOUT_MS = 30_000;
const DRY_RUN_TIMEOUT_MS = 120_000;
const FLOW_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const WORKSPACE_ROOT = "/repo";

const SCRIPT_NAME = "widget-export";
const PRESET_NAME = "nightly";
const PRESET_RELATIVE_PATH = "data/config/presets/agent-operator/nightly.json";
// A second, still-`isDeclarablePresetPath`-legal entry (same presets
// directory, different file) — used wherever a scenario needs a path an
// honest operator never declared under the SAME preset name.
const HOSTILE_PRESET_RELATIVE_PATH =
  "data/config/presets/agent-operator/evil.json";
const FLOW_NAME = "nightly-flow";

/** Locally duplicated from `src/lib/cli-surface.ts` — that module does not export it. */
const PRESET_NAME_REJECTION_MESSAGE =
  "the preset name did not pass this tool's allowed-name check";

/**
 * Builds a fully valid, typed `CreateAgentCliSurfaceOptions` — mirrors
 * `cli-surface.test.ts`'s `createDeps` fixture shape, plus an absolute
 * `workspaceRoot` (so `run`/`triageRun` can anchor a preset path in every
 * scenario that needs one) and a non-empty `flowAllowlist` (so `flowRun` has
 * a legal target too).
 */
function createHonestDeps(
  overrides: Partial<CreateAgentCliSurfaceOptions> = {},
): CreateAgentCliSurfaceOptions {
  return {
    entrypoint: ENTRYPOINT,
    cwd: CWD,
    nodeExecPath: NODE_EXEC_PATH,
    cliTimeoutMs: CLI_TIMEOUT_MS,
    dryRunTimeoutMs: DRY_RUN_TIMEOUT_MS,
    flowTimeoutMs: FLOW_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    dryRunAllowlist: new Set([SCRIPT_NAME]),
    presetAllowlist: new Map([[PRESET_NAME, PRESET_RELATIVE_PATH]]),
    flowAllowlist: new Set([FLOW_NAME]),
    workspaceRoot: WORKSPACE_ROOT,
    runProcess: createFakeRunCliProcess().runProcess,
    ...overrides,
  };
}

/**
 * `createHonestDeps()` with one required key deleted as an OWN property —
 * via a `Record<string, unknown>` intermediate and a deliberate cast back to
 * `CreateAgentCliSurfaceOptions`. The cast IS the point: issue #1019 is
 * specifically about a caller reaching this state through one.
 */
function depsWithout(key: RequiredKey): CreateAgentCliSurfaceOptions {
  const bag: Record<string, unknown> = { ...createHonestDeps() };
  Reflect.deleteProperty(bag, key);
  return bag as unknown as CreateAgentCliSurfaceOptions;
}

const requiredDepPollutionHarness =
  createPrototypePollutionHarness<RequiredKey>(REQUIRED_KEYS);

/** One recorded `runProcess` invocation: its argv plus its forwarded timeout. */
interface RecordedInvocation {
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** A `runProcess` seam that records the full options bag, not just `args`. */
interface FullRecordingRunProcess {
  readonly runProcess: typeof runCliProcess;
  readonly invocations: readonly RecordedInvocation[];
  enqueueResult(result: CliRunResult): void;
}

/**
 * Same shape as `cli-surface.test.ts`'s local `createRecordingRunProcess` —
 * duplicated here rather than imported, since that helper is module-private
 * to its own test file and this slice needs `timeoutMs` visibility for the
 * snapshot rows (group C) that the shared `cliFakes.ts` fake does not
 * capture.
 */
function createFullRecordingRunProcess(): FullRecordingRunProcess {
  const invocations: RecordedInvocation[] = [];
  const queue: CliRunResult[] = [];
  const runProcess: typeof runCliProcess = (options) => {
    invocations.push({
      args: [...options.args],
      timeoutMs: options.timeoutMs,
    });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(
          `createFullRecordingRunProcess: no CliRunResult queued for call #${String(invocations.length)}`,
        ),
      );
    }
    return Promise.resolve(next);
  };
  return {
    runProcess,
    invocations,
    enqueueResult(result) {
      queue.push(result);
    },
  };
}

/** Builds a `flow run --json` payload with exactly one step. */
function makeFlowEnvelopePayload(flowName: string): string {
  const stepRun = makeRunEnvelope({ reportPath: null, outcome: "success" });
  return JSON.stringify({
    kind: "m3l.flow.result",
    schemaVersion: 1,
    flow: flowName,
    runId: "flow-run-1",
    definitionHash: "deadbeefcafefeed",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:00:02.000Z",
    durationMs: 2000,
    status: "completed",
    exitCode: 0,
    exitCodeName: "SUCCESS",
    dryRun: false,
    stepExecutionCount: 1,
    haltingStepId: null,
    resumeStepId: null,
    steps: [
      {
        stepId: "step-1",
        script: flowName,
        attempt: 1,
        branch: "continue",
        run: stepRun,
      },
    ],
  });
}

/**
 * Calls the one method whose implementation actually consults `key` — the
 * mapping matches `createAgentCliSurface`'s own method bodies in
 * `src/lib/cli-surface.ts`: `entrypoint`/`cwd`/`nodeExecPath`/
 * `maxOutputBytes`/`cliTimeoutMs` are used by every read-only method
 * (`list` is the cheapest); `dryRunTimeoutMs`/`dryRunAllowlist` gate
 * `dryRun`; `presetAllowlist` gates `run`; `flowTimeoutMs`/`flowAllowlist`
 * gate `flowRun`.
 */
async function invokeRepresentative(
  surface: AgentCliSurface,
  key: RequiredKey,
): Promise<void> {
  switch (key) {
    case "entrypoint":
    case "cwd":
    case "nodeExecPath":
    case "maxOutputBytes":
    case "cliTimeoutMs":
      await surface.list();
      return;
    case "dryRunTimeoutMs":
    case "dryRunAllowlist":
      await surface.dryRun(SCRIPT_NAME);
      return;
    case "presetAllowlist":
      await surface.run(SCRIPT_NAME, PRESET_NAME, { mode: "mutate" });
      return;
    case "flowTimeoutMs":
    case "flowAllowlist":
      await surface.flowRun(FLOW_NAME, { mode: "mutate" });
      return;
    default: {
      const exhaustive: never = key;
      throw new Error(
        `invokeRepresentative: no method mapped for key ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Constructs a surface from `deps` and, if construction itself did not
 * throw, drives `key`'s representative method — returning whichever error
 * (if any) settled the attempt. Written to discriminate the fix regardless
 * of WHEN it validates: an eager, construction-time guard throws before
 * `invokeRepresentative` ever runs; a guard that validated lazily on first
 * use would still be caught by the subsequent method call.
 */
async function attemptConstructAndUse(
  deps: CreateAgentCliSurfaceOptions,
  key: RequiredKey,
): Promise<unknown> {
  try {
    const surface = createAgentCliSurface(deps);
    await invokeRepresentative(surface, key);
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Shared contract assertion for groups A and B: a coded
 * `M3LAgentOperatorCliError`, `ERR_AGENT_OPERATOR_CONFIG`, a non-empty
 * message naming the field, and a `context` carrying the field name.
 *
 * The message/context shape is an ASSUMPTION, not yet fixed by the
 * implementation (it does not exist yet) — see this file's header
 * requirement to pin only a substring containment, never an exact string.
 * If `context`'s actual shape differs once GREEN lands (e.g. a different key
 * than `field`), that is fine to adjust then.
 */
function assertConfigRejection(
  thrown: unknown,
  key: RequiredKey,
  forbiddenValue?: unknown,
): M3LAgentOperatorCliError {
  expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
  const error = thrown as M3LAgentOperatorCliError;
  expect(error.code).toBe("ERR_AGENT_OPERATOR_CONFIG");
  expect(typeof error.message).toBe("string");
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.message).toContain(key);
  if (typeof forbiddenValue === "string" && forbiddenValue.length > 0) {
    expect(error.message).not.toContain(forbiddenValue);
  }
  expect(error.context).toMatchObject({ field: key });
  return error;
}

// ---------------------------------------------------------------------------
// Group A — prototype pollution, one row per required key.
//
// The hostile value for each of the three allowlist/map keys deliberately
// maps/contains the EXACT name this row's representative method requests —
// never a name the request would miss anyway — so a false pass can only come
// from the guard genuinely refusing to consult an inherited container, not
// from an unrelated allowlist-miss.
// ---------------------------------------------------------------------------

const ROW_A_TABLE: readonly (readonly [RequiredKey, unknown])[] = [
  // An inherited `entrypoint` would let the surface spawn an
  // attacker-chosen CLI binary instead of the operator-wired one.
  ["entrypoint", "/evil/inherited/m3l.mjs"],
  // An inherited `cwd` would let the spawned child run from a directory
  // the operator never wired.
  ["cwd", "/evil/inherited/cwd"],
  // An inherited `nodeExecPath` would let the surface spawn an
  // attacker-chosen node executable.
  ["nodeExecPath", "/evil/inherited/node"],
  // An inherited `cliTimeoutMs` would silently override the timeout budget
  // applied to list/doctor/inspect.
  ["cliTimeoutMs", 1],
  // An inherited `dryRunTimeoutMs` would silently override the timeout
  // budget applied to dryRun/run/triageRun.
  ["dryRunTimeoutMs", 1],
  // An inherited `flowTimeoutMs` would silently override the timeout
  // budget applied to flowRun.
  ["flowTimeoutMs", 1],
  // An inherited `maxOutputBytes` would silently override the byte cap
  // enforced on every spawned CLI's stdout/stderr.
  ["maxOutputBytes", 1],
  // An inherited `dryRunAllowlist` would let dryRun() target a script the
  // operator never allow-listed for read-only probing.
  ["dryRunAllowlist", new Set([SCRIPT_NAME])],
  // An inherited `presetAllowlist` would let run() anchor a preset path
  // the operator never declared.
  ["presetAllowlist", new Map([[PRESET_NAME, HOSTILE_PRESET_RELATIVE_PATH]])],
  // An inherited `flowAllowlist` would let flowRun() target a flow the
  // operator never allow-listed.
  ["flowAllowlist", new Set([FLOW_NAME])],
];

describe("createAgentCliSurface — required deps reject an inherited (prototype-polluted) value (group A)", () => {
  afterEach(() => {
    requiredDepPollutionHarness.expectUnpolluted();
  });

  test.each(ROW_A_TABLE)(
    "an inherited '%s' must never be treated as present",
    async (key, hostileValue) => {
      // Control: a CLEAN prototype, key honestly missing. States the
      // baseline contract this row compares against.
      const control = await attemptConstructAndUse(depsWithout(key), key);
      const controlError = assertConfigRejection(control, key);

      await requiredDepPollutionHarness.withInherited(
        key,
        hostileValue,
        async () => {
          const recorder = createFakeRunCliProcess();
          const bag: Record<string, unknown> = {
            ...depsWithout(key),
            runProcess: recorder.runProcess,
          };
          const deps = bag as unknown as CreateAgentCliSurfaceOptions;

          const thrown = await attemptConstructAndUse(deps, key);

          // Finding first: the hostile value reaching a spawn at all is the
          // defect, so it is asserted before anything about the error — a
          // RED failure then reads as "an inherited value was consulted"
          // rather than as an error-shape mismatch.
          expect(recorder.calls).toHaveLength(0);
          const error = assertConfigRejection(
            thrown,
            key,
            typeof hostileValue === "string" ? hostileValue : undefined,
          );
          expect(error.code).toBe(controlError.code);
          expect(error.message).toBe(controlError.message);
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Group B — wrong-type own values, one row per required key.
// ---------------------------------------------------------------------------

const ROW_B_TABLE: readonly (readonly [RequiredKey, unknown])[] = [
  ["entrypoint", ""],
  ["cwd", 0],
  ["nodeExecPath", null],
  ["cliTimeoutMs", 30_000.5],
  ["dryRunTimeoutMs", Number.NaN],
  ["flowTimeoutMs", Number.POSITIVE_INFINITY],
  ["maxOutputBytes", -1],
  // An array, not a `Set` — `.has` happens to exist on neither `Array` nor
  // to behave the same as `Set.prototype.has`, so this row is also a
  // duck-typing probe.
  ["dryRunAllowlist", [SCRIPT_NAME]],
  // A `Set`, not a `Map` — wrong container type; `Set` has no `.get`.
  ["presetAllowlist", new Set()],
  // A duck-typed forgery of `Set`'s interface — load-bearing: proves the
  // eventual guard uses a real identity check (`instanceof Set`, or an
  // `m3l-common` `Core.isSet`-style guard) rather than checking for a
  // `.has` method, since a polluted `Object.prototype` could otherwise
  // forge the duck type too.
  ["flowAllowlist", { has: () => true }],
];

describe("createAgentCliSurface — required deps reject an own, wrong-typed value (group B)", () => {
  test.each(ROW_B_TABLE)(
    "an own but wrong-typed '%s' is rejected before any spawn",
    async (key, wrongValue) => {
      const recorder = createFakeRunCliProcess();
      const bag: Record<string, unknown> = {
        ...createHonestDeps(),
        [key]: wrongValue,
        runProcess: recorder.runProcess,
      };
      const deps = bag as unknown as CreateAgentCliSurfaceOptions;

      const thrown = await attemptConstructAndUse(deps, key);

      expect(recorder.calls).toHaveLength(0);
      assertConfigRejection(
        thrown,
        key,
        typeof wrongValue === "string" ? wrongValue : undefined,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Group C — the snapshot invariant. This is the core of #1019: six of the
// ten required keys are read LIVE off `deps` on every method call today
// (see `src/lib/cli-surface.ts`'s `createAgentCliSurface` — `deps.cliTimeoutMs`,
// `deps.dryRunTimeoutMs`, `deps.flowTimeoutMs`, `deps.dryRunAllowlist`,
// `deps.presetAllowlist`, `deps.flowAllowlist` are all read inside the
// returned method closures rather than captured once into `ctx`).
//
// CONSTRAINT the fix must respect, restated for the test side: `presetAllowlist`
// must be snapshotted by REFERENCE, never copied into a fresh `Map`.
// `cli-surface.test.ts`'s "createAgentCliSurface — run() does not launder an
// unexpected internal error (S4, adjacent)" describe block injects a
// `ThrowingAllowlist extends Map` whose overridden `get()` throws a bare
// `TypeError`, and asserts that `TypeError` propagates unchanged. A fix that
// snapshots via `new Map(deps.presetAllowlist)` (or any other copy) would
// silently defeat that override — the copy's `.get()` would be the ordinary
// `Map.prototype.get`, not the caller's, and that regression test would
// start failing. Confirmed still green after Step 1 (176/176 passed,
// unmodified).
// ---------------------------------------------------------------------------

describe("createAgentCliSurface — the six lazily-read deps are snapshotted once, at construction (group C)", () => {
  test("C1: a presetAllowlist read through a getter is consulted exactly once, across TWO run() calls — never re-read per call", async () => {
    let getterCalls = 0;
    const honestMap = new Map([[PRESET_NAME, PRESET_RELATIVE_PATH]]);
    const evilMap = new Map([[PRESET_NAME, HOSTILE_PRESET_RELATIVE_PATH]]);
    const recorder = createFullRecordingRunProcess();

    const bag: Record<string, unknown> = {
      ...createHonestDeps({ runProcess: recorder.runProcess }),
    };
    Reflect.deleteProperty(bag, "presetAllowlist");
    Object.defineProperty(bag, "presetAllowlist", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        // First read (whenever it happens) returns the HONEST map; every
        // later read returns the EVIL one. A snapshot taken once at
        // construction can only ever observe the honest map.
        return getterCalls === 1 ? honestMap : evilMap;
      },
    });
    const deps = bag as unknown as CreateAgentCliSurfaceOptions;

    const surface = createAgentCliSurface(deps);
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));

    await surface.run(SCRIPT_NAME, PRESET_NAME, { mode: "mutate" });
    await surface.run(SCRIPT_NAME, PRESET_NAME, { mode: "mutate" });

    // A construction-time-only read touches the getter exactly once, no
    // matter how many `run()` calls follow.
    expect(getterCalls).toBe(1);

    const expectedHonestToken = `--preset=${path.join(WORKSPACE_ROOT, PRESET_RELATIVE_PATH)}`;
    const expectedEvilToken = `--preset=${path.join(WORKSPACE_ROOT, HOSTILE_PRESET_RELATIVE_PATH)}`;
    expect(recorder.invocations).toHaveLength(2);
    for (const invocation of recorder.invocations) {
      const presetToken = invocation.args.find((arg) =>
        arg.startsWith("--preset="),
      );
      expect(presetToken).toBe(expectedHonestToken);
      expect(presetToken).not.toBe(expectedEvilToken);
    }
  });

  test("C2: mutating deps after construction never affects an already-constructed surface, across all seven methods", async () => {
    const recorder = createFullRecordingRunProcess();
    const bag: Record<string, unknown> = {
      ...createHonestDeps({ runProcess: recorder.runProcess }),
    };
    const deps = bag as unknown as CreateAgentCliSurfaceOptions;
    const surface = createAgentCliSurface(deps);

    // Reassign every construction-time-snapshotted field on the SAME
    // object `createAgentCliSurface` was given — never a copy — to prove
    // the surface captured a value snapshot, not a live reference back to
    // `deps`.
    bag["cliTimeoutMs"] = 1;
    bag["dryRunTimeoutMs"] = 2;
    bag["flowTimeoutMs"] = 3;
    bag["dryRunAllowlist"] = new Set(["a-different-script"]);
    bag["presetAllowlist"] = new Map([
      [
        "a-different-preset",
        "data/config/presets/agent-operator/different.json",
      ],
    ]);
    bag["flowAllowlist"] = new Set(["a-different-flow"]);

    recorder.enqueueResult(exitedResult({ stdout: makeListPayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeDoctorPayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeInspectPayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(
      exitedResult({ stdout: makeFlowEnvelopePayload(FLOW_NAME) }),
    );

    async function settle(
      label: string,
      fn: () => Promise<unknown>,
    ): Promise<{
      readonly label: string;
      readonly ok: boolean;
      readonly error?: unknown;
    }> {
      try {
        await fn();
        return { label, ok: true };
      } catch (error) {
        return { label, ok: false, error };
      }
    }

    const results = [
      await settle("list", () => surface.list()),
      await settle("doctor", () => surface.doctor()),
      await settle("inspect", () => surface.inspect(SCRIPT_NAME)),
      await settle("dryRun", () => surface.dryRun(SCRIPT_NAME)),
      await settle("run", () =>
        surface.run(SCRIPT_NAME, PRESET_NAME, { mode: "mutate" }),
      ),
      await settle("triageRun", () =>
        surface.triageRun(SCRIPT_NAME, PRESET_NAME, "prod-profile"),
      ),
      await settle("flowRun", () =>
        surface.flowRun(FLOW_NAME, { mode: "mutate" }),
      ),
    ];

    // Every one of the seven calls must still succeed, using the ORIGINAL
    // construction-time snapshot of the mutated fields — never the
    // post-construction values. A call rejecting here (pre-fix, since
    // dryRunAllowlist/presetAllowlist/flowAllowlist are read live off a
    // `deps` object that no longer contains the requested name) is itself
    // part of the finding: it proves the allowlist-membership decision was
    // NOT taken from a construction-time snapshot.
    for (const result of results) {
      expect(
        result.ok,
        `${result.label} should have succeeded using the construction-time snapshot, but: ${String(result.error)}`,
      ).toBe(true);
    }

    expect(recorder.invocations).toHaveLength(7);
    const [
      listCall,
      doctorCall,
      inspectCall,
      dryRunCall,
      runCall,
      triageRunCall,
      flowRunCall,
    ] = recorder.invocations;

    expect(listCall?.timeoutMs).toBe(CLI_TIMEOUT_MS);
    expect(doctorCall?.timeoutMs).toBe(CLI_TIMEOUT_MS);
    expect(inspectCall?.timeoutMs).toBe(CLI_TIMEOUT_MS);
    expect(dryRunCall?.timeoutMs).toBe(DRY_RUN_TIMEOUT_MS);
    expect(runCall?.timeoutMs).toBe(DRY_RUN_TIMEOUT_MS);
    expect(triageRunCall?.timeoutMs).toBe(DRY_RUN_TIMEOUT_MS);
    expect(flowRunCall?.timeoutMs).toBe(FLOW_TIMEOUT_MS);

    // The preset argv token is anchored from the ORIGINAL presetAllowlist
    // entry, never the mutated one.
    const runArgv = runCall?.args ?? [];
    const presetToken = runArgv.find((arg) => arg.startsWith("--preset="));
    expect(presetToken).toBe(
      `--preset=${path.join(WORKSPACE_ROOT, PRESET_RELATIVE_PATH)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Group D — non-regression.
// ---------------------------------------------------------------------------

describe("createAgentCliSurface — the new guard's blast radius (group D, non-regression)", () => {
  test("D1: createHonestDeps() still constructs successfully and every method still works", async () => {
    const recorder = createFullRecordingRunProcess();
    const deps = createHonestDeps({ runProcess: recorder.runProcess });
    const surface = createAgentCliSurface(deps);

    recorder.enqueueResult(exitedResult({ stdout: makeListPayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeDoctorPayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeInspectPayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(exitedResult({ stdout: makeRunEnvelopePayload() }));
    recorder.enqueueResult(
      exitedResult({ stdout: makeFlowEnvelopePayload(FLOW_NAME) }),
    );

    await expect(surface.list()).resolves.toBeDefined();
    await expect(surface.doctor()).resolves.toBeDefined();
    await expect(surface.inspect(SCRIPT_NAME)).resolves.toBeDefined();
    await expect(surface.dryRun(SCRIPT_NAME)).resolves.toBeDefined();
    await expect(
      surface.run(SCRIPT_NAME, PRESET_NAME, { mode: "mutate" }),
    ).resolves.toBeDefined();
    await expect(
      surface.triageRun(SCRIPT_NAME, PRESET_NAME, "prod-profile"),
    ).resolves.toBeDefined();
    await expect(
      surface.flowRun(FLOW_NAME, { mode: "mutate" }),
    ).resolves.toBeDefined();

    expect(recorder.invocations).toHaveLength(7);
  });

  test("D2: omitting the optional workspaceRoot still constructs, and run() rejects with the EXISTING preset-rejection contract — the new guard's scope stops at the ten required keys", async () => {
    const recorder = createFakeRunCliProcess();
    const bag: Record<string, unknown> = {
      ...createHonestDeps({ runProcess: recorder.runProcess }),
    };
    Reflect.deleteProperty(bag, "workspaceRoot");
    const deps = bag as unknown as CreateAgentCliSurfaceOptions;

    const surface = createAgentCliSurface(deps);

    let thrown: unknown;
    try {
      await surface.run(SCRIPT_NAME, PRESET_NAME, { mode: "mutate" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    const error = thrown as M3LAgentOperatorCliError;
    expect(error.code).toBe("ERR_AGENT_OPERATOR_PRESET");
    expect(error.message).toBe(PRESET_NAME_REJECTION_MESSAGE);
    expect(recorder.calls).toHaveLength(0);
  });

  test("D3: an empty (but present, correctly-typed) allowlist is a legal closed declaration and must not be rejected by the new guard", () => {
    const deps = createHonestDeps({
      dryRunAllowlist: new Set<string>(),
      presetAllowlist: new Map<string, string>(),
      flowAllowlist: new Set<string>(),
    });

    expect(() => createAgentCliSurface(deps)).not.toThrow();
  });

  // D4 is not a new test: it is the constraint recorded in group C's own
  // header comment above, re-run (unmodified) rather than duplicated here —
  // `cli-surface.test.ts`'s "run() does not launder an unexpected internal
  // error (S4, adjacent)" describe block's `ThrowingAllowlist` regression
  // test was confirmed green (176/176) after this file's Step 1 harness
  // extraction, with no change to its content.
});
