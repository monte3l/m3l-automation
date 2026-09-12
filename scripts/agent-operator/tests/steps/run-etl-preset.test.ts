/**
 * Tests for `steps/run-etl-preset` — the `run-preset` workload: the second
 * gated `agent-operator` operation, running the two-phase `run_preset` tool
 * (`steps/build-etl-tools.ts`) through the real Bedrock tool loop.
 *
 * Written RED, before `src/steps/run-etl-preset.ts` exists — mirrors
 * `run-health-check.test.ts`'s offline, fakes-only structure.
 *
 * **Offline, fakes only.** No test here constructs a `BedrockRuntimeClient`
 * or spawns an `m3l` child process. Exactly two seams are faked:
 *
 * - `steps/create-invoker` — the network seam.
 * - `lib/cli-process`'s `runCliProcess` — the spawn seam.
 *
 * Three further seams are **pass-through spies**, not fakes: `prepare-gated-
 * operation.js`'s `prepareGatedOperation`, `build-etl-tools.js`'s
 * `buildEtlTools`, and `build-tool-registry.js`'s `buildAgentToolRegistry`
 * keep their real implementations — every test below still drives the real
 * chain down to the two faked seams — but wrapping each in `vi.fn(actual.*)`
 * makes its call arguments observable, which is what several of the tests
 * below need to pin directly (the exact action submitted for judgement, the
 * exact specs handed to the registry) rather than infer indirectly through
 * what the model was offered.
 *
 * `runtime.scripts[0]` is read here as THE target script `run_preset`
 * operates against: `config.test.ts`'s (peer) declared `requiredParameters`
 * for `run-preset` are `[aws.profile, scripts, presetAllowlist]` — there is
 * no separate `scriptName` parameter, so `scripts` (otherwise the
 * health-check fleet list) is the only candidate source for the one target
 * script this operation names. That derivation is this file's own inference
 * about an undocumented internal, not part of the pinned contract; every
 * assertion below is written to survive a different derivation as long as
 * `surface.inspect` is still called with SOME script name once per run.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AWS, Core } from "@monte3l/m3l-common";

import type * as BuildEtlToolsModule from "../../src/steps/build-etl-tools.js";
import type * as BuildToolRegistryModule from "../../src/steps/build-tool-registry.js";
import type * as MeteringInvokerModule from "../../src/steps/metering-invoker.js";
import type * as PrepareGatedOperationModule from "../../src/steps/prepare-gated-operation.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  exitedResult,
  makeInspectPayload,
  makeParamDescriptor,
} from "../support/cliFakes.js";
import {
  FAKE_MODEL_ID,
  textReply,
  toolUseReply,
} from "../support/healthFakes.js";

// --- the two faked seams ---------------------------------------------------

vi.mock("../../src/steps/create-invoker.js", () => ({
  createInvoker: vi.fn(),
}));
vi.mock("../../src/lib/cli-process.js", () => ({
  runCliProcess: vi.fn(),
}));

// --- pass-through spies: real behaviour, observable call arguments ---------

vi.mock(
  "../../src/steps/prepare-gated-operation.js",
  async (importOriginal) => {
    const actual = await importOriginal<typeof PrepareGatedOperationModule>();
    return {
      ...actual,
      prepareGatedOperation: vi.fn(actual.prepareGatedOperation),
    };
  },
);
vi.mock("../../src/steps/build-etl-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BuildEtlToolsModule>();
  return {
    ...actual,
    buildEtlTools: vi.fn(actual.buildEtlTools),
  };
});
vi.mock("../../src/steps/build-tool-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BuildToolRegistryModule>();
  return {
    ...actual,
    buildAgentToolRegistry: vi.fn(actual.buildAgentToolRegistry),
  };
});
// A FOURTH pass-through spy, added for finding 1's tests below:
// `reconcileMeteredCost` (`steps/metering-invoker.js`) is a stable,
// already-unit-tested pure function (`metering-invoker.test.ts` covers its
// own divergence/agreement/tolerance contract directly). Spying on it here
// — real by default — makes the call THIS module makes to it observable
// (finding 1, test 3) and lets one test substitute a controlled throw to
// prove `runEtlPreset` propagates it rather than swallowing it (test 1).
// `createMeteredInvoker`, from the same module, is left untouched (spread
// from `actual`) since `prepare-gated-operation.js` — not this file's
// subject — is the only caller of it.
vi.mock("../../src/steps/metering-invoker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MeteringInvokerModule>();
  return {
    ...actual,
    reconcileMeteredCost: vi.fn(actual.reconcileMeteredCost),
  };
});

import { createInvoker } from "../../src/steps/create-invoker.js";
import { runCliProcess } from "../../src/lib/cli-process.js";
import { prepareGatedOperation } from "../../src/steps/prepare-gated-operation.js";
import {
  AGENT_ETL_TOOL_NAMES,
  buildEtlTools,
} from "../../src/steps/build-etl-tools.js";
import { buildAgentToolRegistry } from "../../src/steps/build-tool-registry.js";
import { reconcileMeteredCost } from "../../src/steps/metering-invoker.js";
import { runEtlPreset } from "../../src/steps/run-etl-preset.js";
import type { RunEtlPresetDeps } from "../../src/steps/run-etl-preset.js";

const DEFAULT_ENTRYPOINT = "/fake/repo/packages/m3l-cli/bin/m3l.mjs";
const TARGET_SCRIPT = "json-etl";

let inputDir: string;
let dataDir: string;

/** Every `invoke()` the scripted model made, in order. */
let invokeCalls: AWS.M3LBedrockToolInvokeRequest[];
/** Every `runCliProcess` call's `args`, in order. */
let cliCalls: string[][];

beforeEach(async () => {
  inputDir = await mkdtemp(path.join(tmpdir(), "etl-preset-input-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "etl-preset-data-"));
  invokeCalls = [];
  cliCalls = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(createInvoker).mockReset();
  vi.mocked(runCliProcess).mockReset();
  // `mockClear`, never `mockReset`, on the three pass-through spies: they
  // delegate to the REAL implementation, and `mockReset` would strip that
  // delegate, leaving every later test in this file calling `undefined`.
  vi.mocked(prepareGatedOperation).mockClear();
  vi.mocked(buildEtlTools).mockClear();
  vi.mocked(buildAgentToolRegistry).mockClear();
  // Pass-through, like the three above: `mockClear`, never `mockReset` —
  // resetting would strip the real `reconcileMeteredCost` delegate this
  // file's own tests below install via `importOriginal`.
  vi.mocked(reconcileMeteredCost).mockClear();
  await rm(inputDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

/** A real `Core.M3LPaths` over this test's two temp roots. */
function makePaths(): Core.M3LPaths {
  vi.stubEnv("M3L_INPUT_DIR", inputDir);
  vi.stubEnv("M3L_DATA_DIR", dataDir);
  return new Core.M3LPaths();
}

/**
 * Scripts the model's turns, in order, and installs them behind the mocked
 * `createInvoker`. A turn past the end of the script rejects loudly rather
 * than resolving `undefined`, so a forgotten reply fails the test instead of
 * hanging the loop.
 */
function scriptModel(replies: readonly AWS.M3LBedrockInvocationResult[]): void {
  const queue = [...replies];
  vi.mocked(createInvoker).mockReturnValue({
    invoke(request) {
      invokeCalls.push(request);
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(
            `scriptModel: no reply queued for turn #${String(invokeCalls.length)}`,
          ),
        );
      }
      return Promise.resolve(next);
    },
  });
}

/** Scripts the `m3l` CLI's stdout, in call order. */
function scriptCli(payloads: readonly string[]): void {
  const queue = [...payloads];
  vi.mocked(runCliProcess).mockImplementation((options) => {
    cliCalls.push([...options.args]);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(
          `scriptCli: no payload queued for call #${String(cliCalls.length)}`,
        ),
      );
    }
    return Promise.resolve(exitedResult({ stdout: next }));
  });
}

/** Records every log event so a milestone trail can be asserted. */
class RecordingLoggerHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];
  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }
  reset(): void {
    this.events.length = 0;
  }
}

function createLogger(): Core.M3LLogger {
  return new Core.M3LLogger([new RecordingLoggerHandler()]);
}

/** The decision-log directory every run below writes into. */
function logDir(): string {
  return path.join(inputDir, "agent-log");
}

/** Narrows a parsed JSON value to a record without a cast. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

// Name of the append-only manifest sidecar `M3LAgentDecisionLog` writes
// alongside its date-stamped segments. Not importable here: it's defined in
// `@monte3l/m3l-common`'s `src/internal/storage/append-only-manifest.ts`
// (`M3L_APPEND_ONLY_MANIFEST_NAME`), and `internal/` is not part of the
// package's public exports.
const MANIFEST_NAME = "manifest.jsonl";

/**
 * Reads every decision-log entry the real writer appended, in file then
 * line order — mirrors `run-health-check.test.ts`'s own helper of the same
 * name/shape exactly, so both operations' conclusion tests read the same
 * way.
 */
async function readEntries(
  directory: string,
): Promise<readonly Record<string, unknown>[]> {
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries: Record<string, unknown>[] = [];
  for (const name of [...names].sort()) {
    // The manifest sidecar records baseline/seal bookkeeping, not
    // decision-log entries — skip it so this helper answers "which
    // decision-log ENTRIES were written".
    if (name === MANIFEST_NAME) continue;
    const text = await readFile(path.join(directory, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      entries.push(asRecord(JSON.parse(line)));
    }
  }
  return entries;
}

async function writePolicyFixture(
  name: string,
  declaration: unknown,
): Promise<void> {
  await writeFile(
    path.join(inputDir, name),
    JSON.stringify(declaration),
    "utf8",
  );
}

/**
 * A `run-preset` policy granting `agent-operator`'s `run-preset` operation as
 * read-only auto-approved — the OPERATION-level grant this module's own
 * action needs. It deliberately declares no `budgets` (an unobservable
 * declared budget would escalate before anything else in this file could be
 * exercised) and no grant at all for the target script's own `run`
 * operation: no test below drives the tool far enough to reach a per-call
 * gate, so that grant would be dead weight.
 */
function runPresetPolicyDeclaration(): unknown {
  return {
    version: 1,
    scripts: [
      {
        script: "agent-operator",
        operations: ["run-preset"],
        readOnlyOperations: ["run-preset"],
      },
    ],
    requireDecisionLog: true,
  };
}

/** The config every run below starts from. */
function buildConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Core.M3LConfig {
  const config = new Core.M3LConfig();
  config.set(Core.AWS_PROFILE_PARAM_NAME, "sandbox");
  config.set("command", "run-preset");
  config.set("modelId", FAKE_MODEL_ID);
  config.set("cliEntrypoint", DEFAULT_ENTRYPOINT);
  config.set("scripts", [TARGET_SCRIPT]);
  config.set("presetAllowlist", [
    `nightly=data/config/presets/${TARGET_SCRIPT}/nightly.json`,
  ]);
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

/** Writes {@link runPresetPolicyDeclaration} and returns a config wired at it. */
async function presetConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Core.M3LConfig> {
  await writePolicyFixture(
    "run-preset-policy.json",
    runPresetPolicyDeclaration(),
  );
  return buildConfig({
    policyFile: "run-preset-policy.json",
    decisionLogDir: logDir(),
    ...overrides,
  });
}

interface RunOptions {
  readonly config?: Core.M3LConfig;
  readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
  readonly signal?: AbortSignal;
}

/** Runs the workload with this file's standard deps. */
async function run(options: RunOptions = {}): Promise<void> {
  const deps: RunEtlPresetDeps = {
    config: options.config ?? (await presetConfig()),
    logger: createLogger(),
    paths: makePaths(),
    signal: options.signal ?? new AbortController().signal,
    reportRecovery: options.reportRecovery ?? vi.fn(),
    // The real `createInvoker` is mocked out, so nothing reads this.
    aws: undefined,
  };
  await runEtlPreset(deps);
}

/** An `inspect --json` payload declaring NO `aws.profile` parameter. */
function inspectPayloadWithoutAwsProfile(): string {
  return makeInspectPayload([]);
}

/** An `inspect --json` payload declaring an `aws.profile` parameter. */
function inspectPayloadWithAwsProfile(): string {
  return makeInspectPayload([
    makeParamDescriptor({ name: Core.AWS_PROFILE_PARAM_NAME }),
  ]);
}

describe("runEtlPreset — a failed inspect fails closed", () => {
  it("propagates the inspect rejection and never builds or registers the ETL tool", async () => {
    // The load-bearing polarity: falling back to `scriptDeclaresAwsProfile:
    // false` on a swallowed inspect failure is the value that BUILDS the
    // mutating tool — the same fail-open defect class already found and
    // fixed twice in this programme.
    const config = await presetConfig();
    vi.mocked(runCliProcess).mockRejectedValue(
      new Error("m3l inspect failed to spawn"),
    );
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toThrow();

    expect(buildEtlTools).not.toHaveBeenCalled();
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    // The Bedrock loop never started at all.
    expect(invokeCalls).toEqual([]);
  });
});

describe("runEtlPreset — a script that declares its own aws.profile refuses", () => {
  it("surfaces buildEtlTools' build-time refusal instead of continuing", async () => {
    const config = await presetConfig();
    scriptCli([inspectPayloadWithAwsProfile()]);
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
    });

    expect(buildEtlTools).toHaveBeenCalledTimes(1);
    // `buildEtlTools` threw before the registry could ever be built.
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    expect(invokeCalls).toEqual([]);
  });
});

describe("runEtlPreset — the happy path registers exactly one tool", () => {
  it("passes an empty single-phase specs array and ONE two-phase spec, run_preset", async () => {
    const config = await presetConfig();
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("nothing to run")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(buildEtlTools).toHaveBeenCalledTimes(1);
    const [deps] = vi.mocked(buildEtlTools).mock.calls[0] ?? [];
    expect(deps?.scriptDeclaresAwsProfile).toBe(false);

    expect(buildAgentToolRegistry).toHaveBeenCalledTimes(1);
    const registryCall = vi.mocked(buildAgentToolRegistry).mock.calls[0];
    const [specsArg, , twoPhaseArg] = registryCall ?? [];
    expect(specsArg).toEqual([]);
    expect(twoPhaseArg).toHaveLength(1);
    expect(twoPhaseArg?.[0]?.name).toBe(AGENT_ETL_TOOL_NAMES.runPreset);
    expect(twoPhaseArg?.[0]?.phases).toBe("dry-run-then-mutate");

    // And the model was genuinely offered exactly that one tool.
    const first = invokeCalls[0];
    if (first === undefined) throw new Error("no invoke recorded");
    expect((first.tools ?? []).map((tool) => tool.name)).toEqual([
      AGENT_ETL_TOOL_NAMES.runPreset,
    ]);
  });
});

describe("runEtlPreset — the preflight action is read-only", () => {
  it("submits kind: read-only, script: agent-operator, operation: run-preset", async () => {
    // If this were `kind: "mutating"` instead, the preflight would demand a
    // target and dry-run-first, and `assertConclusionAutoApproved` would
    // throw before the operation could ever start — this action describes
    // RUNNING THE AGENT, not the child mutation `run_preset` itself performs
    // (that per-tool action is declared separately by
    // `steps/build-etl-tools.ts`'s `describeAction`).
    const config = await presetConfig();
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("nothing to run")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(prepareGatedOperation).toHaveBeenCalledTimes(1);
    const [deps] = vi.mocked(prepareGatedOperation).mock.calls[0] ?? [];
    expect(deps?.action).toMatchObject({
      script: "agent-operator",
      operation: "run-preset",
      kind: "read-only",
    });
  });
});

describe("runEtlPreset — the cross-run counter", () => {
  it("records the run's invocations even when the loop throws", async () => {
    // The counter write lives in a `finally`: a crash mid-loop must not
    // forget invocations that were already made and already billed.
    const config = await presetConfig();
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    vi.mocked(createInvoker).mockReturnValue({
      invoke(request) {
        invokeCalls.push(request);
        return Promise.reject(
          new AWS.M3LBedrockRuntimeNoModelError("gone", {
            attemptedModels: [FAKE_MODEL_ID],
          }),
        );
      },
    });

    await expect(run({ config })).rejects.toThrow();

    const payload = JSON.parse(
      await readFile(
        path.join(dataDir, "agent-state", "daily-invocations.checkpoint.json"),
        "utf8",
      ),
    ) as { readonly payload: { readonly invocations: number } };
    // No tool call happened before the model went away.
    expect(payload.payload.invocations).toBe(0);
  });
});

describe("runEtlPreset — resolveTargetScript requires exactly one script", () => {
  // The maintainer decision (2026-09): `scripts` is a general-purpose fleet
  // list shared with `health-check`, which legitimately declares many
  // entries. A MUTATING operation's target must never be decided by array
  // ordering, so `run-preset` now requires `scripts` to hold EXACTLY ONE
  // entry — anything else throws `ERR_AGENT_OPERATOR_CONFIG` before
  // `surface.inspect` is ever called and before any tool is built.

  it("targets the sole entry in `scripts`, passed to surface.inspect exactly", async () => {
    const config = await presetConfig({ scripts: [TARGET_SCRIPT] });
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("nothing to run")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(cliCalls[0]).toEqual(["inspect", TARGET_SCRIPT, "--json"]);
  });

  it("still throws ERR_AGENT_OPERATOR_CONFIG when `scripts` is empty", async () => {
    // Pre-existing behaviour — must keep working under the new rule.
    const config = await presetConfig({ scripts: [] });
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
    });
    expect(buildEtlTools).not.toHaveBeenCalled();
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    expect(invokeCalls).toEqual([]);
    expect(cliCalls).toEqual([]);
  });

  it.each([
    ["two entries", ["s3-objects", "json-etl"]],
    ["three entries", ["s3-objects", "json-etl", "healthcheck-x"]],
  ] as const)(
    "throws ERR_AGENT_OPERATOR_CONFIG for %s, before inspect or any tool is built",
    async (_label, scripts) => {
      // THE DISCRIMINATING CASE (two entries): today `resolveTargetScript`
      // silently accepts a multi-entry list and targets `scripts[0]`
      // ("s3-objects") — this run resolves successfully against the wrong
      // target instead of rejecting, so it fails RED here for that reason,
      // not an unrelated one.
      const config = await presetConfig({ scripts: [...scripts] });
      scriptCli([inspectPayloadWithoutAwsProfile()]);
      scriptModel([textReply("never reached")]);

      let thrown: unknown;
      try {
        await run({ config });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ code: "ERR_AGENT_OPERATOR_CONFIG" });
      const message = (thrown as Error).message;
      // The rejection must name the constraint, not echo the offending
      // script names back.
      for (const scriptName of scripts) {
        expect(message).not.toContain(scriptName);
      }

      // The throw happens BEFORE surface.inspect is ever called and before
      // any tool is built — a wrong-target run must not spawn the CLI.
      expect(buildEtlTools).not.toHaveBeenCalled();
      expect(buildAgentToolRegistry).not.toHaveBeenCalled();
      expect(invokeCalls).toEqual([]);
      expect(cliCalls).toEqual([]);
    },
  );
});

describe("runEtlPreset — abort propagation", () => {
  it("propagates an abort instanceof-intact, so Ctrl-C still exits 5", async () => {
    // A widened `instanceof Core.M3LError` catch would swallow this — ADR-0049
    // classifies Ctrl-C as exit 5 only if the real subclass survives.
    const config = await presetConfig();
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    const controller = new AbortController();
    vi.mocked(createInvoker).mockReturnValue({
      invoke: () => {
        controller.abort();
        return Promise.reject(
          new Core.M3LOperationAbortedError("aborted mid-invoke"),
        );
      },
    });

    await expect(
      run({ config, signal: controller.signal }),
    ).rejects.toBeInstanceOf(Core.M3LOperationAbortedError);
  });
});

/**
 * A rate covering `FAKE_MODEL_ID` so the ledger's `costThisRun` is an
 * OBSERVED number rather than `undefined` — mirrors
 * `run-health-check.test.ts`'s `buildConfig`'s own `modelRates` comment:
 * without a declared rate, `sumObservedCost` returns `undefined` and there
 * is nothing for `reconcileMeteredCost` to compare.
 */
const MODEL_RATES_OVERRIDE = {
  modelRates: [`${FAKE_MODEL_ID}=0.003,0.015`],
};

/**
 * V9 finding 1 (2026-09 security review): `run-health-check.ts:408` calls
 * `reconcileMeteredCost({ metered: cost, reported: loop.outcome.cost })`
 * after its loop — `steps/metering-invoker.ts`'s own header documents this
 * as what makes `sumObservedCost`'s local re-implementation of
 * `AWS.computeCost` (ADR-0029 forbids importing it directly) safe: a
 * divergence must throw loudly rather than let a future pricing-formula
 * drift silently understate the ledger's `costThisRun`, which is what the
 * per-call gate reads for `budget.cost-per-run`. `run-etl-preset.ts` never
 * calls it at all.
 *
 * A GENUINE, non-contrived divergence between the ledger's metered cost and
 * the loop's own reported cost cannot arise through the real end-to-end
 * path: `run-etl-preset.ts`'s own `runLoop` passes the SAME `runtime.modelRates`
 * map object to both `createMeteredInvoker` (inside `prepareGatedOperation`)
 * and `AWS.runBedrockToolLoop`'s `rates` option, and the local
 * `sumObservedCost` formula is currently identical to the library's own
 * `computeCost` — by construction, the two sides observe the same iterations
 * through the same formula and agree bit-for-bit (this is documented, not an
 * oversight: `metering-invoker.ts`'s ordering-constraint-3 remarks call this
 * out explicitly). `run-health-check.test.ts` does not attempt a real
 * end-to-end divergence test for the same reason — its own "cost
 * reconciliation is live" describe block only pins the AGREEMENT case, and
 * the actual divergence/tolerance behaviour is unit-tested directly against
 * `reconcileMeteredCost` in `metering-invoker.test.ts`.
 *
 * The three tests below decompose the guarantee instead of forcing a fake
 * formula bug: test 1 proves a throw from `reconcileMeteredCost` propagates
 * out of `runEtlPreset` rather than being swallowed; test 3 proves the call
 * is wired to the REAL, dynamic ledger/loop values (not a hardcoded pair
 * that would vacuously agree regardless of what actually happened); test 2
 * proves the real, unmocked reconciliation does not raise a false positive
 * on an ordinary agreeing run. Together they specify the same contract a
 * genuine forced-divergence test would, without depending on a
 * `AWS.runBedrockToolLoop` formula bug that does not exist in current code.
 */
describe("runEtlPreset — the cost drift guard (reconcileMeteredCost)", () => {
  it("propagates a reconciliation divergence instead of absorbing it", async () => {
    // `reconcileMeteredCost` itself is unit-tested (metering-invoker.test.ts)
    // to throw `M3LAgentOperatorCliError` coded `ERR_AGENT_OPERATOR_CONFIG`
    // on a genuine divergence. Substituting that real, documented failure
    // mode here for ONE call proves `runEtlPreset` does not catch and
    // swallow it — the loud-throw half of the contract.
    const config = await presetConfig(MODEL_RATES_OVERRIDE);
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("nothing to run")]);
    const divergence = new M3LAgentOperatorCliError(
      "metered cost diverges from the loop's own reported cost beyond tolerance",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
    vi.mocked(reconcileMeteredCost).mockImplementationOnce(() => {
      throw divergence;
    });

    await expect(run({ config })).rejects.toBe(divergence);
  });

  it("completes normally when the metered and reported costs agree", async () => {
    // The other arm: a real, unmocked reconciliation on an ordinary run must
    // not be a false positive. `reconcileMeteredCost` runs for real here.
    const config = await presetConfig(MODEL_RATES_OVERRIDE);
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("nothing to run")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(reconcileMeteredCost).toHaveBeenCalledTimes(1);
  });

  it("reconciles the REAL ledger cost against the REAL loop outcome, not a hardcoded pair", async () => {
    // `textReply`'s default usage (10 input / 5 output tokens) against
    // `MODEL_RATES_OVERRIDE`'s rate is a value THIS test derives
    // independently of `run-etl-preset.ts` — (10/1000)*0.003 + (5/1000)*0.015.
    // If the implementation instead called
    // `reconcileMeteredCost({ metered: X, reported: X })` with some single
    // hardcoded/reused figure (the vacuous defect
    // `run-health-check.test.ts`'s own equivalent test warns against), this
    // assertion on the ACTUAL expected magnitude would not hold.
    const expectedCost = (10 / 1000) * 0.003 + (5 / 1000) * 0.015;
    const config = await presetConfig(MODEL_RATES_OVERRIDE);
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("nothing to run")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(reconcileMeteredCost).toHaveBeenCalledTimes(1);
    const [options] = vi.mocked(reconcileMeteredCost).mock.calls[0] ?? [];
    expect(options?.metered).toBeCloseTo(expectedCost, 9);
    expect(options?.reported).toBeCloseTo(expectedCost, 9);
  });
});

/**
 * V9 finding 2 (2026-09 security review): `run-health-check.ts:249`'s
 * `recordConclusion` writes the run's THIRD decision-log entry — the first
 * caller to populate ADR-0061's `tokens`/`cost` fields, per its own remarks
 * ("what did the authorized run cost"). `runEtlPreset` never writes an
 * equivalent entry, so the audit trail for the one operation that can
 * actually mutate ends at the per-call gate records, with no run-level spend
 * attestation and no record of the model's own account of the mutation.
 *
 * Mirrors `run-health-check.test.ts`'s own convention for identifying a
 * conclusion entry: the LAST JSONL entry the run wrote, carrying `verdict`
 * and numeric `tokens`/`cost` fields the bootstrap (preflight) entry never
 * has. No shape difference between the two operations' conclusion records
 * is warranted here: both share `prepareGatedOperation`'s `GatedOperationSetup`
 * (`setup.recorder`, `setup.decision`, `setup.now`), and `run-etl-preset.ts`'s
 * OWN preflight action (`operation: "run-preset"`) is exactly as
 * read-only/auto-approved-shaped as `health-check`'s — there is no
 * documented reason for `run-etl-preset`'s conclusion to carry a field
 * `health-check`'s does not.
 */
describe("runEtlPreset — the concluding decision-log record", () => {
  it("writes a concluding record carrying the run's tokens and cost", async () => {
    const config = await presetConfig(MODEL_RATES_OVERRIDE);
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([textReply("nothing to run")]);

    await expect(run({ config })).resolves.toBeUndefined();

    const entries = await readEntries(logDir());
    // Today only the preflight's own bootstrap entry exists (length 1) —
    // a genuine conclusion record is a SECOND entry, not a re-read of the
    // first. Asserting length alone (rather than only inspecting the last
    // entry's fields) keeps this from vacuously passing against the
    // bootstrap entry, which already carries `operation: "run-preset"` and
    // `verdict: "auto-approved"` but never `tokens`/`cost`.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const conclusion = entries[entries.length - 1];
    expect(Object.hasOwn(conclusion ?? {}, "tokens")).toBe(true);
    expect(Object.hasOwn(conclusion ?? {}, "cost")).toBe(true);
    expect(typeof conclusion?.["tokens"]).toBe("number");
    expect(typeof conclusion?.["cost"]).toBe("number");
  });

  it("still writes the concluding record when a per-call gate refusal occurred mid-loop", async () => {
    // `runPresetPolicyDeclaration()` deliberately grants no per-tool operation
    // for the target script's own `run` operation, so a model-requested
    // `run_preset` call here is REFUSED by `gateTwoPhaseToolSpec` — per
    // `gate-tool.ts`'s own documented contract, "a refusal ... never throws;
    // it returns refusal text so the loop continues" — and the run still
    // reaches a normal terminal reply. The audit trail must not be thinner
    // exactly when something was refused.
    const config = await presetConfig(MODEL_RATES_OVERRIDE);
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([
      toolUseReply(AGENT_ETL_TOOL_NAMES.runPreset, { presetName: "nightly" }),
      textReply("acknowledged the refusal, stopping"),
    ]);

    await expect(run({ config })).resolves.toBeUndefined();

    const entries = await readEntries(logDir());
    const conclusion = entries[entries.length - 1];
    expect(Object.hasOwn(conclusion ?? {}, "tokens")).toBe(true);
    expect(Object.hasOwn(conclusion ?? {}, "cost")).toBe(true);
  });

  it("identifies the concluding record as run-preset's own, not the gated tool call's", async () => {
    // Same refused-tool scenario as above: the tool call's own gate audit
    // entries carry `operation: "run"` / `script: "json-etl"` (`run_preset`'s
    // `describeAction`). The RUN's own conclusion must be identifiable
    // separately from those — `operation: "run-preset"` / `script:
    // "agent-operator"` / `verdict: "auto-approved"`, matching
    // `run-health-check.test.ts`'s own identification convention
    // (`conclusion["verdict"]).toBe("auto-approved")`) exactly.
    const config = await presetConfig(MODEL_RATES_OVERRIDE);
    scriptCli([inspectPayloadWithoutAwsProfile()]);
    scriptModel([
      toolUseReply(AGENT_ETL_TOOL_NAMES.runPreset, { presetName: "nightly" }),
      textReply("acknowledged the refusal, stopping"),
    ]);

    await expect(run({ config })).resolves.toBeUndefined();

    const entries = await readEntries(logDir());
    const conclusion = entries[entries.length - 1];
    expect(conclusion?.["operation"]).toBe("run-preset");
    expect(conclusion?.["script"]).toBe("agent-operator");
    expect(conclusion?.["verdict"]).toBe("auto-approved");
  });
});
