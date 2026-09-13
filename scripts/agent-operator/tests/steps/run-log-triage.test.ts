/**
 * Tests for `steps/run-log-triage` — the `triage-logs` workload: the third
 * policy-gated `agent-operator` operation, running the single-phase
 * `triage_logs` tool (`steps/build-triage-tools.ts`) through the real
 * Bedrock tool loop against exactly one fixed target script,
 * `cloudwatch-logs-analysis`.
 *
 * Written RED, before `src/steps/run-log-triage.ts` — AND its two new
 * siblings `src/steps/build-triage-tools.ts` and `src/lib/triage-presets.ts`
 * — exist. Those two siblings are each some OTHER spoke's own test file's
 * subject (`tests/steps/build-triage-tools.test.ts`,
 * `tests/lib/triage-presets.test.ts`); this file mocks both at their module
 * boundary rather than depending on their real implementations landing
 * first, so the reasons this file starts RED are exactly the missing
 * modules the contract names for this slice, not a wiring accident.
 *
 * **Mirrors `run-etl-preset.test.ts`'s structure and idiom exactly** — see
 * that file's own header for the full mocking rationale. The differences
 * this file's mocking strategy makes on top of it:
 *
 * - `lib/triage-presets.js`'s `verifyTriagePresets` is a FOURTH **fully
 *   faked** seam (own `vi.fn()`, not a pass-through spy on a real
 *   implementation) — its real refusal grammar (empty allowlist, `extends`,
 *   `aws.profile`, disallowed `operation`) is `triage-presets.test.ts`'s own
 *   subject; this file only needs direct, deterministic control over
 *   whether it resolves or rejects, to prove the ONE thing that belongs
 *   here: `runLogTriage` calls it before building anything, wires it real
 *   `presetAllowlist`/`workspaceRoot` values, and never catches its
 *   rejection.
 * - `steps/build-triage-tools.js`'s `buildTriageTools` is a pass-through spy,
 *   exactly like `run-etl-preset.test.ts`'s own `buildEtlTools` spy — this
 *   file never needs to fake it because it takes only frozen, this-file-
 *   controlled inputs (the REAL `VerifiedTriagePresets` minted by
 *   {@link mintVerifiedPresets} below via the real `verifyTriagePresets`,
 *   never a cast).
 *
 * `Core.M3LExecutionEnvironment.detect()` memoizes at module scope (invoked
 * indirectly by every `new Core.M3LPaths()` this file's `makePaths()`
 * builds) — `resolve-runtime.test.ts` already found that without a
 * `resetForTesting()` in `beforeEach`, whichever test constructs an
 * `M3LPaths` first permanently caches that test's deployment mode and every
 * later `vi.stubEnv("M3L_DEPLOYMENT_MODE", …)` becomes a silent no-op. This
 * file's own "workspaceRoot === undefined" describe block depends on that
 * reset firing for every test, not only its own.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AWS, Core } from "@monte3l/m3l-common";

import type * as BuildToolRegistryModule from "../../src/steps/build-tool-registry.js";
import type * as BuildTriageToolsModule from "../../src/steps/build-triage-tools.js";
import type * as MeteringInvokerModule from "../../src/steps/metering-invoker.js";
import type * as PrepareGatedOperationModule from "../../src/steps/prepare-gated-operation.js";
import type * as TriagePresetsModule from "../../src/lib/triage-presets.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import type { VerifiedTriagePresets } from "../../src/lib/triage-presets.js";
import { exitedResult, makeRunEnvelopePayload } from "../support/cliFakes.js";
import {
  FAKE_MODEL_ID,
  textReply,
  toolUseReply,
} from "../support/healthFakes.js";

// --- the faked seams --------------------------------------------------------

vi.mock("../../src/steps/create-invoker.js", () => ({
  createInvoker: vi.fn(),
}));
vi.mock("../../src/lib/cli-process.js", () => ({
  runCliProcess: vi.fn(),
}));
// Fully faked, not a pass-through spy — see the module header. This file
// needs direct control over resolve/reject to prove ordering; the real
// refusal grammar is `tests/lib/triage-presets.test.ts`'s own subject.
vi.mock("../../src/lib/triage-presets.js", () => ({
  verifyTriagePresets: vi.fn(),
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
vi.mock("../../src/steps/build-triage-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BuildTriageToolsModule>();
  return {
    ...actual,
    buildTriageTools: vi.fn(actual.buildTriageTools),
  };
});
vi.mock("../../src/steps/build-tool-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BuildToolRegistryModule>();
  return {
    ...actual,
    buildAgentToolRegistry: vi.fn(actual.buildAgentToolRegistry),
  };
});
vi.mock("../../src/steps/metering-invoker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MeteringInvokerModule>();
  return {
    ...actual,
    reconcileMeteredCost: vi.fn(actual.reconcileMeteredCost),
  };
});

import { createInvoker } from "../../src/steps/create-invoker.js";
import { runCliProcess } from "../../src/lib/cli-process.js";
import { verifyTriagePresets } from "../../src/lib/triage-presets.js";
import { prepareGatedOperation } from "../../src/steps/prepare-gated-operation.js";
import {
  AGENT_TRIAGE_TOOL_NAMES,
  buildTriageTools,
} from "../../src/steps/build-triage-tools.js";
import { buildAgentToolRegistry } from "../../src/steps/build-tool-registry.js";
import { reconcileMeteredCost } from "../../src/steps/metering-invoker.js";
import { runLogTriage } from "../../src/steps/run-log-triage.js";
import type { RunLogTriageDeps } from "../../src/steps/run-log-triage.js";

const DEFAULT_ENTRYPOINT = "/fake/repo/packages/m3l-cli/bin/m3l.mjs";
const TARGET_SCRIPT = "cloudwatch-logs-analysis";
const PRESET_NAME = "checkout-5xx";
const PRESET_PATH = `data/config/presets/triage-${PRESET_NAME}.yaml`;

let inputDir: string;
let dataDir: string;

/** Every `invoke()` the scripted model made, in order. */
let invokeCalls: AWS.M3LBedrockToolInvokeRequest[];
/** Every `runCliProcess` call's `args`, in order. */
let cliCalls: string[][];

beforeEach(async () => {
  // See the module header: without this, whichever test in this FILE
  // constructs an `M3LPaths` first permanently caches that deployment mode.
  Core.M3LExecutionEnvironment.resetForTesting();
  inputDir = await mkdtemp(path.join(tmpdir(), "log-triage-input-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "log-triage-data-"));
  invokeCalls = [];
  cliCalls = [];
  // The default happy-path resolution: a single-entry verified allowlist
  // matching this file's own default `presetAllowlist` config entry. Tests
  // that need a different resolution (a rejection, or a differently-shaped
  // map) override with `mockResolvedValueOnce`/`mockRejectedValueOnce`.
  vi.mocked(verifyTriagePresets).mockResolvedValue(await mintVerifiedPresets());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(createInvoker).mockReset();
  vi.mocked(runCliProcess).mockReset();
  vi.mocked(verifyTriagePresets).mockReset();
  // `mockClear`, never `mockReset`, on the pass-through spies: they delegate
  // to the REAL implementation, and `mockReset` would strip that delegate,
  // leaving every later test in this file calling `undefined`.
  vi.mocked(prepareGatedOperation).mockClear();
  vi.mocked(buildTriageTools).mockClear();
  vi.mocked(buildAgentToolRegistry).mockClear();
  vi.mocked(reconcileMeteredCost).mockClear();
  await rm(inputDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * Mints a real `VerifiedTriagePresets` by calling the REAL
 * `verifyTriagePresets` (via `vi.importActual`, bypassing this file's own
 * full mock of `lib/triage-presets.js`) with an injected `readProvider`
 * stub — never a cast. Mirrors `tests/steps/build-triage-tools.test.ts`'s
 * own `mintVerifiedPresets` helper exactly: the stub ignores the
 * `absolutePath` it's called with and answers every lookup with
 * `{ operation: "analyze" }`, which has no `extends` key, no `aws.profile`
 * key, and a documented `TRIAGE_READ_ONLY_OPERATIONS` member — clearing
 * every one of `verifyTriagePresets`'s four ordered checks for every entry.
 *
 * `verifyTriagePresets` itself is FULLY mocked in this file (see the module
 * header) so this file's own tests can directly control resolve/reject for
 * the ordering guarantee — but a cast onto the brand here would make every
 * OTHER test in this file (the happy-path ones exercising the tool loop)
 * vacuous about the one seam this slice adds: the brand's whole value is
 * that `verifyTriagePresets` is its only minting site.
 */
async function mintVerifiedPresets(
  entries: ReadonlyMap<string, string> = new Map([[PRESET_NAME, PRESET_PATH]]),
): Promise<VerifiedTriagePresets> {
  const actual = await vi.importActual<typeof TriagePresetsModule>(
    "../../src/lib/triage-presets.js",
  );
  const raw: Readonly<Record<string, unknown>> = Object.freeze({
    operation: "analyze",
  });
  return actual.verifyTriagePresets({
    presetAllowlist: entries,
    workspaceRoot: "/workspace",
    readProvider: () => ({
      rawKeys: (): readonly string[] => Object.keys(raw),
      getRawValue: (key: string): unknown => raw[key],
    }),
  });
}

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

/**
 * Reads every decision-log entry the real writer appended, in file then
 * line order — mirrors `run-etl-preset.test.ts`'s own helper of the same
 * name/shape exactly.
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
 * A `triage-logs` policy granting `agent-operator`'s `triage-logs` operation
 * as read-only auto-approved — the OPERATION-level grant this module's own
 * action needs — plus `cloudwatch-logs-analysis`'s `run` operation (also
 * read-only), needed only by the tests below that actually drive the
 * `triage_logs` tool far enough to reach the per-call gate. No `budgets`
 * declared: an unobservable declared budget would escalate before anything
 * else in this file could be exercised.
 */
function triageLogsPolicyDeclaration(): unknown {
  return {
    version: 1,
    scripts: [
      {
        script: "agent-operator",
        operations: ["triage-logs"],
        readOnlyOperations: ["triage-logs"],
      },
      {
        script: TARGET_SCRIPT,
        operations: ["run"],
        readOnlyOperations: ["run"],
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
  config.set("command", "triage-logs");
  config.set("modelId", FAKE_MODEL_ID);
  config.set("cliEntrypoint", DEFAULT_ENTRYPOINT);
  config.set("scripts", [TARGET_SCRIPT]);
  config.set("presetAllowlist", [`${PRESET_NAME}=${PRESET_PATH}`]);
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

/** Writes {@link triageLogsPolicyDeclaration} and returns a config wired at it. */
async function triageConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Core.M3LConfig> {
  await writePolicyFixture(
    "triage-logs-policy.json",
    triageLogsPolicyDeclaration(),
  );
  return buildConfig({
    policyFile: "triage-logs-policy.json",
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
  const deps: RunLogTriageDeps = {
    config: options.config ?? (await triageConfig()),
    logger: new Core.M3LLogger([]),
    paths: makePaths(),
    signal: options.signal ?? new AbortController().signal,
    reportRecovery: options.reportRecovery ?? vi.fn(),
    // The real `createInvoker` is mocked out, so nothing reads this.
    aws: undefined,
  };
  await runLogTriage(deps);
}

describe("runLogTriage — the preflight action is read-only, triage-logs", () => {
  it("submits kind: read-only, script: agent-operator, operation: triage-logs", async () => {
    // If this were `kind: "mutating"` instead, the preflight would demand a
    // target and dry-run-first semantics this run-level action does not
    // carry, and `assertConclusionAutoApproved` would throw before the
    // operation could ever start. This action describes RUNNING THE AGENT,
    // not the child work `triage_logs` itself performs.
    const config = await triageConfig();
    scriptModel([textReply("nothing to triage")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(prepareGatedOperation).toHaveBeenCalledTimes(1);
    const [deps] = vi.mocked(prepareGatedOperation).mock.calls[0] ?? [];
    expect(deps?.action).toMatchObject({
      script: "agent-operator",
      operation: "triage-logs",
      kind: "read-only",
    });
  });
});

describe("runLogTriage — resolveTargetScript requires exactly one script, naming cloudwatch-logs-analysis", () => {
  it.each([
    ["zero entries", []],
    ["two entries", ["cloudwatch-logs-analysis", "json-etl"]],
  ] as const)(
    "throws ERR_AGENT_OPERATOR_CONFIG for %s, before verifyTriagePresets or any tool is built",
    async (_label, scripts) => {
      const config = await triageConfig({ scripts: [...scripts] });
      scriptModel([textReply("never reached")]);

      await expect(run({ config })).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_CONFIG",
      });

      expect(verifyTriagePresets).not.toHaveBeenCalled();
      expect(buildTriageTools).not.toHaveBeenCalled();
      expect(buildAgentToolRegistry).not.toHaveBeenCalled();
      expect(invokeCalls).toEqual([]);
      expect(cliCalls).toEqual([]);
    },
  );

  it("throws ERR_AGENT_OPERATOR_CONFIG when the sole entry is not cloudwatch-logs-analysis", async () => {
    // A read-only claim is only sound for the ONE script whose read-only
    // verb set `build-triage-tools.ts` knows — `json-etl` legitimately
    // exists as a fleet target for OTHER operations, so the wrong-target
    // guard has to actually discriminate it, not merely reject an absent
    // value.
    const config = await triageConfig({ scripts: ["json-etl"] });
    scriptModel([textReply("never reached")]);

    let thrown: unknown;
    try {
      await run({ config });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "ERR_AGENT_OPERATOR_CONFIG" });
    // The rejection must name the constraint, not echo the offending script.
    expect((thrown as Error).message).not.toContain("json-etl");

    expect(verifyTriagePresets).not.toHaveBeenCalled();
    expect(buildTriageTools).not.toHaveBeenCalled();
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    expect(invokeCalls).toEqual([]);
    expect(cliCalls).toEqual([]);
  });
});

describe("runLogTriage — workspaceRoot === undefined refuses", () => {
  it("throws ERR_AGENT_OPERATOR_CONFIG in standalone mode, before verifyTriagePresets runs", async () => {
    // `deriveWorkspaceRoot` (`prepare-gated-operation.ts`) degrades to
    // `undefined` only in standalone mode — forced here via
    // `M3L_DEPLOYMENT_MODE`, the documented override. Without a workspace
    // root there is no anchor to resolve preset paths against, so the
    // operation must refuse rather than hand `verifyTriagePresets` an
    // unusable input.
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
    const config = await triageConfig();
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
    });

    expect(verifyTriagePresets).not.toHaveBeenCalled();
    expect(buildTriageTools).not.toHaveBeenCalled();
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    expect(invokeCalls).toEqual([]);
    expect(cliCalls).toEqual([]);
  });
});

describe("runLogTriage — verifyTriagePresets runs before the registry is built", () => {
  it("propagates a verification rejection and never builds or registers the triage tool", async () => {
    // THE ORDERING GUARANTEE: forcing `verifyTriagePresets` to reject must
    // observably stop the run before the registry — a real effect
    // (nothing built, nothing spawned), not merely a call-order spy.
    const config = await triageConfig();
    const rejection = new M3LAgentOperatorCliError(
      "a triage preset is not a leaf: 'extends' is not permitted",
      "ERR_AGENT_OPERATOR_PRESET",
    );
    vi.mocked(verifyTriagePresets).mockReset();
    vi.mocked(verifyTriagePresets).mockRejectedValue(rejection);
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toBe(rejection);

    expect(buildTriageTools).not.toHaveBeenCalled();
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    // The Bedrock loop never started, and no CLI process was ever spawned.
    expect(invokeCalls).toEqual([]);
    expect(cliCalls).toEqual([]);
  });

  it("calls verifyTriagePresets with the resolved runtime's presetAllowlist and the derived workspaceRoot", async () => {
    // Proves the call is wired to the REAL, dynamic values `prepareGated-
    // Operation` produced for THIS run, not a hardcoded/vacuous pair a
    // trivial "was it called" assertion would miss.
    const config = await triageConfig();
    scriptModel([textReply("nothing to triage")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(verifyTriagePresets).toHaveBeenCalledTimes(1);
    const setup = await (vi.mocked(prepareGatedOperation).mock.results[0]
      ?.value as ReturnType<typeof prepareGatedOperation>);
    const [verifyArgs] = vi.mocked(verifyTriagePresets).mock.calls[0] ?? [];
    expect(verifyArgs?.presetAllowlist).toBe(setup.runtime.presetAllowlist);
    expect(verifyArgs?.workspaceRoot).toBe(setup.workspaceRoot);
    expect(typeof verifyArgs?.workspaceRoot).toBe("string");
  });
});

describe("runLogTriage — no surface.inspect call, only surface.run", () => {
  it("never spawns 'inspect', even across a real triage_logs tool call", async () => {
    // Unlike `run-preset`, this operation does not probe the target
    // script's `aws.profile` declaration — `cloudwatch-logs-analysis`
    // legitimately declares one, and `verifyTriagePresets` is what replaces
    // that check. Proven across a genuine tool call, not just an untouched
    // happy path where no CLI call happens at all either way.
    const config = await triageConfig();
    scriptModel([
      toolUseReply(AGENT_TRIAGE_TOOL_NAMES.triageLogs, {
        presetName: PRESET_NAME,
      }),
      textReply("triage complete"),
    ]);
    scriptCli([makeRunEnvelopePayload({ script: TARGET_SCRIPT })]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(cliCalls.some((call) => call[0] === "inspect")).toBe(false);
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]?.[0]).toBe("run");
    expect(cliCalls[0]).toContain(TARGET_SCRIPT);
    // `mode: "mutate"` means "omit the trailing --dry-run token".
    expect(cliCalls[0]).not.toContain("--dry-run");

    // And the model was genuinely offered exactly the one tool.
    const first = invokeCalls[0];
    if (first === undefined) throw new Error("no invoke recorded");
    expect((first.tools ?? []).map((tool) => tool.name)).toEqual([
      AGENT_TRIAGE_TOOL_NAMES.triageLogs,
    ]);
  });
});

/**
 * A rate covering `FAKE_MODEL_ID` so the ledger's `costThisRun` is an
 * OBSERVED number rather than `undefined` — mirrors
 * `run-etl-preset.test.ts`'s own `MODEL_RATES_OVERRIDE` comment: without a
 * declared rate, `sumObservedCost` returns `undefined` and there is nothing
 * for `reconcileMeteredCost` to compare.
 */
const MODEL_RATES_OVERRIDE = {
  modelRates: [`${FAKE_MODEL_ID}=0.003,0.015`],
};

describe("runLogTriage — the concluding decision-log record", () => {
  it("writes a concluding record carrying tokens and cost when the run is priceable", async () => {
    const config = await triageConfig(MODEL_RATES_OVERRIDE);
    scriptModel([textReply("nothing to triage")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(reconcileMeteredCost).toHaveBeenCalledTimes(1);
    const entries = await readEntries(logDir());
    // Today only the preflight's own bootstrap entry exists (length 1) — a
    // genuine conclusion record is a SECOND entry.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const conclusion = entries[entries.length - 1];
    expect(conclusion?.["operation"]).toBe("triage-logs");
    expect(conclusion?.["script"]).toBe("agent-operator");
    expect(conclusion?.["verdict"]).toBe("auto-approved");
    expect(Object.hasOwn(conclusion ?? {}, "tokens")).toBe(true);
    expect(typeof conclusion?.["tokens"]).toBe("number");
    expect(Object.hasOwn(conclusion ?? {}, "cost")).toBe(true);
    expect(typeof conclusion?.["cost"]).toBe("number");
  });

  it("leaves cost ABSENT — not present holding undefined — on an unpriceable run", async () => {
    // No `modelRates` entry covers `FAKE_MODEL_ID` here (the default
    // `triageConfig()`, unlike the test above, declares none), so both the
    // ledger's own metered figure and the loop's own reported figure are
    // genuinely unobservable and agree trivially at `undefined` —
    // `reconcileMeteredCost` must not throw on that agreement, and
    // `recordConclusion` must OMIT the key rather than spread `cost:
    // undefined` into the written JSON line.
    const config = await triageConfig();
    scriptModel([textReply("nothing to triage")]);

    await expect(run({ config })).resolves.toBeUndefined();

    const entries = await readEntries(logDir());
    const conclusion = entries[entries.length - 1];
    expect(Object.hasOwn(conclusion ?? {}, "tokens")).toBe(true);
    expect(Object.hasOwn(conclusion ?? {}, "cost")).toBe(false);
  });
});

describe("runLogTriage — recordConsumption runs from a finally", () => {
  it("records the run's invocations even when the loop throws", async () => {
    // The counter write lives in a `finally`: a crash mid-loop must not
    // forget invocations that were already made and already billed.
    const config = await triageConfig();
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

  it("logs and reports a counter write failure without replacing the loop's own success", async () => {
    // A failure to persist the daily counter must be absorbed — logged and
    // reported via `reportRecovery` — rather than escaping the `finally`
    // and REPLACING whatever the loop already produced (here, a clean
    // completion). `openDailyInvocationCounter` (`src/steps/daily-counter.ts`)
    // returns `Object.freeze({...})`, so `vi.spyOn(setup.counter, "record")`
    // cannot redefine the frozen, non-configurable `record` property — the
    // write failure is driven through the REAL counter and the REAL
    // filesystem instead, with no mock anywhere in this test.
    //
    // `M3LCheckpointStore.write()` resolves its target file at
    // `<dataDir>/agent-state/daily-invocations.checkpoint.json` and persists
    // via `writeFileAtomic`: write a temp sibling file, then
    // `fsp.rename(tempPath, targetPath)`. Pre-creating a DIRECTORY at that
    // exact `targetPath` makes that rename fail deterministically (a file
    // cannot be renamed onto an existing directory) — the underlying OS
    // errno propagates as `M3LCheckpointError` ("ERR_CHECKPOINT_IO"), then
    // as this script's own `M3LAgentOperatorCliError`
    // ("ERR_AGENT_OPERATOR_BUDGET_STATE"), which `recordConsumption`'s
    // `catch` absorbs.
    //
    // The blocking directory can only be created AFTER `prepareGatedOperation`
    // has already opened and READ the counter (which must see a genuinely
    // absent file, so it seeds `0` rather than failing outright at open
    // time) and BEFORE the run's `finally` calls `counter.record()`. The
    // scripted model's single `invoke()` call lands exactly there — it runs
    // mid-loop, strictly between those two.
    const config = await triageConfig();
    const checkpointPath = path.join(
      dataDir,
      "agent-state",
      "daily-invocations.checkpoint.json",
    );
    vi.mocked(createInvoker).mockReturnValue({
      invoke(request) {
        invokeCalls.push(request);
        return mkdir(checkpointPath, { recursive: true }).then(() =>
          textReply("nothing to triage"),
        );
      },
    });
    const reportRecovery = vi.fn();

    await expect(run({ config, reportRecovery })).resolves.toBeUndefined();

    expect(reportRecovery).toHaveBeenCalledTimes(1);
    const entry = reportRecovery.mock.calls[0]?.[0] as
      Core.M3LRunRecoveryEntry | undefined;
    expect(entry).toMatchObject({ item: "daily-invocation-counter" });
    expect(typeof entry?.recordedAt).toBe("string");
  });
});
