/**
 * Tests for `steps/run-health-check` — the fleet health-check workload.
 *
 * **Offline, fakes only.** No test here constructs a `BedrockRuntimeClient`
 * or spawns an `m3l` child process. Exactly **two** seams are faked:
 *
 * - `steps/create-invoker` — the network seam. Replaced with a scripted
 *   `M3LBedrockToolLoopInvoker` (`tests/support/bedrockFakes.ts`).
 * - `lib/cli-process`'s `runCliProcess` — the spawn seam. Replaced with the
 *   FIFO fake `tests/support/cliFakes.ts` already established.
 *
 * Everything else runs for real: `AWS.runBedrockToolLoop`, `gateToolSpec`,
 * `buildAgentToolRegistry`, `Core.evaluateAgentAction`,
 * `createMeteredInvoker`, `openDailyInvocationCounter`, every
 * `lib/model-safety` projection, and the real `Core.M3LAgentDecisionLog`
 * writing into a temp directory. A wider fake would let a wiring bug — a
 * dropped `rates` map, a preflight built before the metered invoker, a
 * registry assembled without the gate — hide behind it, and those are
 * precisely the bugs this file exists to catch.
 */

import { readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import type * as CliSurfaceModule from "../../src/lib/cli-surface.js";
import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { runHealthCheck } from "../../src/steps/run-health-check.js";
import {
  exitedResult,
  makeDoctorCheck,
  makeDoctorPayload,
  makeListPayload,
  makeListRow,
  makeListRowFailed,
  makeRunEnvelopePayload,
} from "../support/cliFakes.js";
import {
  budgetPolicyDeclaration,
  realAgentPolicyDeclaration,
} from "../support/policyFixtures.js";
import {
  FAKE_MODEL_ID,
  emptyReply,
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

// NOT a third fake: a PASS-THROUGH spy. `createAgentCliSurface` keeps its
// real implementation (every test below still drives the real surface down
// to the faked `runCliProcess`); the spy exists only so the options bag this
// workload constructs the surface from is observable. `runHealthCheck` builds
// the surface internally rather than taking it as a `deps` field, so there is
// no injected seam to inspect instead.
vi.mock("../../src/lib/cli-surface.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CliSurfaceModule>();
  return {
    ...actual,
    createAgentCliSurface: vi.fn(actual.createAgentCliSurface),
  };
});

import { createInvoker } from "../../src/steps/create-invoker.js";
import { runCliProcess } from "../../src/lib/cli-process.js";
import { createAgentCliSurface } from "../../src/lib/cli-surface.js";

const DEFAULT_ENTRYPOINT = "/fake/repo/packages/m3l-cli/bin/m3l.mjs";

let inputDir: string;
let dataDir: string;
let outputDir: string;

/** Every `invoke()` the scripted model made, in order. */
let invokeCalls: AWS.M3LBedrockToolInvokeRequest[];
/** Every `runCliProcess` call's `args`, in order. */
let cliCalls: string[][];

beforeEach(async () => {
  inputDir = await mkdtemp(path.join(tmpdir(), "health-input-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "health-data-"));
  outputDir = await mkdtemp(path.join(tmpdir(), "health-output-"));
  invokeCalls = [];
  cliCalls = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(createInvoker).mockReset();
  vi.mocked(runCliProcess).mockReset();
  // `mockClear`, never `mockReset`: this one is a pass-through spy, and
  // resetting it would strip the real `createAgentCliSurface` it delegates
  // to, leaving every later test in this file with an `undefined` surface.
  vi.mocked(createAgentCliSurface).mockClear();
  await rm(inputDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
});

/** A real `Core.M3LPaths` over this test's three temp roots. */
function makePaths(): Core.M3LPaths {
  vi.stubEnv("M3L_INPUT_DIR", inputDir);
  vi.stubEnv("M3L_DATA_DIR", dataDir);
  vi.stubEnv("M3L_OUTPUT_DIR", outputDir);
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

function createLogger(): {
  readonly logger: Core.M3LLogger;
  readonly handler: RecordingLoggerHandler;
} {
  const handler = new RecordingLoggerHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

/** The ordered milestone `step` values the run logged. */
function stepTrail(events: readonly Core.M3LLogEvent[]): readonly string[] {
  const trail: string[] = [];
  for (const event of events) {
    const step = event.data?.["step"];
    if (typeof step === "string") trail.push(step);
  }
  return trail;
}

/** The config every run below starts from. */
function buildConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Core.M3LConfig {
  const config = new Core.M3LConfig();
  config.set(Core.AWS_PROFILE_PARAM_NAME, "sandbox");
  config.set("command", "health-check");
  config.set("modelId", FAKE_MODEL_ID);
  config.set("cliEntrypoint", DEFAULT_ENTRYPOINT);
  // A declared rate for the served model. Ordering constraint 2: without it
  // `sumObservedCost` returns `undefined`, `costThisRun` goes absent, and
  // every gated call after turn 0 escalates on
  // `budget.cost-per-run.unobservable`.
  config.set("modelRates", [`${FAKE_MODEL_ID}=0.003,0.015`]);
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

interface RunOptions {
  readonly config?: Core.M3LConfig;
  readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
  readonly signal?: AbortSignal;
  readonly logger?: Core.M3LLogger;
}

/** Runs the workload with this file's standard deps. */
async function run(options: RunOptions = {}): Promise<void> {
  await runHealthCheck({
    config: options.config ?? buildConfig(),
    logger: options.logger ?? createLogger().logger,
    paths: makePaths(),
    signal: options.signal ?? new AbortController().signal,
    reportRecovery: options.reportRecovery ?? vi.fn(),
    // The real `createInvoker` is mocked out, so nothing reads this.
    aws: undefined,
  });
}

/** Narrows a parsed JSON value to a record without a cast. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Reads the written health-check artifact. */
async function readReport(): Promise<Record<string, unknown>> {
  const names = await readdir(outputDir);
  const name = names[0];
  if (name === undefined) throw new Error("no artifact was written");
  return asRecord(
    JSON.parse(await readFile(path.join(outputDir, name), "utf8")),
  );
}

/** Reads every decision-log entry the real writer appended. */
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

/**
 * An `AgentCliSurface` whose every method rejects — for the two tests that
 * exercise `describeAction`/`inputSchema` directly and must never execute.
 * `run` is refused on the same terms as its four siblings: no test here may
 * reach the mutating method.
 */
function unusedSurface(): AgentCliSurface {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error("unexpected CLI call"));
  return {
    list: refuse,
    doctor: refuse,
    inspect: refuse,
    dryRun: refuse,
    run: refuse,
  };
}

/** The decision-log directory every run below writes into. */
function logDir(): string {
  return path.join(inputDir, "agent-log");
}

/**
 * A `health-check` policy granting the four tool operations, plus a per-tool
 * grant for `s3-objects`. Budget-free unless `budgets` is supplied — a
 * declared budget the run cannot observe escalates *before* the
 * decision-log rule and would mask everything else.
 */
function fleetPolicyDeclaration(
  budgets?: Readonly<Record<string, number>>,
): unknown {
  return {
    version: 1,
    ...(budgets === undefined ? {} : { budgets }),
    scripts: [
      {
        script: "agent-operator",
        operations: ["health-check", "list", "doctor"],
        readOnlyOperations: ["health-check", "list", "doctor"],
      },
      {
        script: "s3-objects",
        operations: ["inspect", "dry-run"],
        readOnlyOperations: ["inspect", "dry-run"],
      },
    ],
    requireDecisionLog: true,
  };
}

/** Writes `fleetPolicyDeclaration` and returns a config wired at it. */
async function fleetConfig(
  overrides: Readonly<Record<string, unknown>> = {},
  budgets?: Readonly<Record<string, number>>,
): Promise<Core.M3LConfig> {
  await writePolicyFixture(
    "fleet-policy.json",
    fleetPolicyDeclaration(budgets),
  );
  return buildConfig({
    policyFile: "fleet-policy.json",
    decisionLogDir: logDir(),
    ...overrides,
  });
}

describe("runHealthCheck — the happy path", () => {
  it("drives the gated tools through the real loop and writes the artifact", async () => {
    const config = await fleetConfig();
    scriptCli([makeDoctorPayload(), makeListPayload()]);
    scriptModel([
      toolUseReply("fleet_doctor"),
      toolUseReply("fleet_list", {}),
      textReply("The fleet looks healthy."),
    ]);
    const { logger, handler } = createLogger();

    await run({ config, logger });

    // The CLI seam was genuinely driven — real argv, through the real
    // surface, from a real gated handler.
    expect(cliCalls).toEqual([
      ["doctor", "--json"],
      ["list", "--json"],
    ]);
    expect(stepTrail(handler.events)).toEqual([
      "policy-loaded",
      "daily-counter-loaded",
      "preflight-complete",
      "report-written",
    ]);

    const report = await readReport();
    expect(report["kind"]).toBe("m3l.agent-operator.health-check");
    expect(report["schemaVersion"]).toBe(1);
    expect(report["blocking"]).toBe(false);
    expect(report["anomalies"]).toEqual([]);
    expect(asRecord(report["model"])["summary"]).toBe(
      "The fleet looks healthy.",
    );
    expect(asRecord(report["observed"])["doctorChecks"]).toBe(1);
    expect(asRecord(report["observed"])["fleetSize"]).toBe(1);
  });

  it("writes THREE decision-log entries: bootstrap, conclusion, and the cost record", async () => {
    const config = await fleetConfig();
    scriptCli([makeDoctorPayload()]);
    scriptModel([toolUseReply("fleet_doctor"), textReply("Healthy.")]);

    await run({ config });

    const entries = await readEntries(logDir());
    // Two from the preflight, one per gated tool call (pre + post), and the
    // concluding cost record. The gate writes twice per approved call.
    expect(entries.length).toBeGreaterThanOrEqual(3);

    // The LAST entry is the concluding cost record — the first caller ever to
    // populate ADR-0061's `tokens`/`cost` fields.
    const conclusion = asRecord(entries[entries.length - 1]);
    expect(conclusion["verdict"]).toBe("auto-approved");
    expect(typeof conclusion["tokens"]).toBe("number");
    expect(typeof conclusion["cost"]).toBe("number");
  });

  it("shares ONE recorder identity across the preflight and every gated call", async () => {
    // Two recorder instances would split the audit trail across two
    // identities, and an operator reconstructing a run from the log would see
    // two agents where there was one.
    const config = await fleetConfig({ agentName: "one-identity" });
    scriptCli([makeDoctorPayload()]);
    scriptModel([toolUseReply("fleet_doctor"), textReply("Healthy.")]);

    await run({ config });

    const names = (await readEntries(logDir())).map(
      (entry) => asRecord(entry["identity"])["name"],
    );
    expect(new Set(names)).toEqual(new Set(["one-identity"]));
  });
});

/**
 * V9 slice 2b — the second of the two `createAgentCliSurface` construction
 * sites. `resolve-runtime` parses `presetAllowlist` into
 * `settings.presetAllowlist`, but a site that never forwards it leaves the
 * config parameter inert: the surface's `run` would reject every call on an
 * empty lookup while the operator's declared grant sat in config, apparently
 * honoured. Only a pin on the forwarded value catches that.
 */
describe("runHealthCheck — the CLI surface is built from the resolved runtime", () => {
  const PRESET_NAME = "nightly-report";
  const PRESET_RELATIVE_PATH = "data/config/presets/nightly-report.yaml";

  it("hands createAgentCliSurface the parsed presetAllowlist, entry included", async () => {
    const config = await fleetConfig({
      presetAllowlist: [`${PRESET_NAME}=${PRESET_RELATIVE_PATH}`],
    });
    scriptModel([textReply("Healthy.")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(createAgentCliSurface).toHaveBeenCalledTimes(1);
    expect(createAgentCliSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        // The exact one-entry map the resolved runtime carries. Deliberately
        // not `expect.any(Map)` and not an empty map: either would be
        // satisfied by a site passing `new Map()`, which is the defect.
        presetAllowlist: new Map([[PRESET_NAME, PRESET_RELATIVE_PATH]]),
      }),
    );
  });
});

describe("runHealthCheck — ordering constraint 1: the metered invoker precedes the preflight", () => {
  it("clears budget.tokens-per-run at the preflight, because zero spend was OBSERVED before it ran", async () => {
    // The single sharpest ordering test in this file. `createMeteredInvoker`
    // seeds `observeSpend({tokens: 0, loopIterations: 0, cost: 0})` at
    // CONSTRUCTION. Move that construction below `runDecisionLogPreflight`
    // and this run dies on `budget.tokens-per-run.unobservable` before a
    // single tool exists.
    await writePolicyFixture(
      "token-budget.json",
      budgetPolicyDeclaration({ tokensPerRun: 200_000, costPerRun: 2 }),
    );
    const config = buildConfig({
      policyFile: "token-budget.json",
      decisionLogDir: logDir(),
    });
    scriptModel([textReply("Nothing to report.")]);

    await expect(run({ config })).resolves.toBeUndefined();

    const entries = await readEntries(logDir());
    const conclusion = asRecord(entries[1]);
    expect(conclusion["verdict"]).toBe("auto-approved");
    expect(conclusion["rule"]).not.toBe("budget.tokens-per-run.unobservable");
  });

  it("constructs the Bedrock client before the preflight, and that costs nothing", async () => {
    // Construction makes no network call — the SDK defers every connection to
    // the first command — which is what makes constraint 1 safe. A run the
    // preflight then REFUSES must still have made no `invoke()` call.
    await writePolicyFixture("declining.json", {
      version: 1,
      // No `agent-operator` grant at all, so the run's own action is
      // ungranted and the preflight's conclusion escalates.
      scripts: [{ script: "s3-objects", allOperations: true }],
    });
    const config = buildConfig({
      policyFile: "declining.json",
      decisionLogDir: logDir(),
    });
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_ESCALATED",
    });

    expect(createInvoker).toHaveBeenCalledTimes(1);
    expect(invokeCalls).toEqual([]);
  });
});

describe("runHealthCheck — the cost reconciliation is live", () => {
  it("compares THIS script's metered cost against the library's, not against itself", async () => {
    // `steps/metering-invoker` re-implements `AWS.computeCost` locally
    // (ADR-0029 forbids importing it) and documents the duplication as "made
    // safe by `reconcileMeteredCost`". That guard is only safe if the two
    // sides come from DIFFERENT computations: `metered` from the ledger,
    // which is where `sumObservedCost` pushed our figure, and `reported`
    // from the loop's own outcome.
    //
    // Passing `loop.outcome.cost` as both sides — which is what this code did
    // before review — makes the check vacuous: it can never diverge, and a
    // drift in the local pricing formula would pass silently while the
    // ledger's budget figures went wrong.
    //
    // This test pins the wiring by asserting the two figures AGREE on a real
    // run. Drift the local formula (change `TOKENS_PER_RATE_UNIT`) and the
    // happy-path runs in this file start throwing on the divergence —
    // verified by mutation. With the vacuous version they stayed green.
    const config = await fleetConfig();
    scriptCli([makeDoctorPayload()]);
    scriptModel([toolUseReply("fleet_doctor"), textReply("healthy")]);

    await expect(run({ config })).resolves.toBeUndefined();

    // Both sides priced the run, and the artifact carries the metered figure.
    const cost = asRecord((await readReport())["loop"])["cost"];
    expect(typeof cost).toBe("number");
    expect(cost).toBeGreaterThan(0);
  });

  it("reports cost as null when no rate covered the served model, on BOTH sides", async () => {
    // The other arm of `reconcileMeteredCost`: both sides unobservable is
    // agreement, not divergence, so the run must not throw.
    const config = await fleetConfig({ modelRates: [] });
    scriptCli([makeDoctorPayload()]);
    scriptModel([toolUseReply("fleet_doctor"), textReply("healthy")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(asRecord((await readReport())["loop"])["cost"]).toBeNull();
  });
});

describe("runHealthCheck — ordering constraint 2: modelRates must cover every served model", () => {
  it("refuses EVERY gated call when the served model has no declared rate", async () => {
    // The seeded `0` covers the PREFLIGHT and nothing more — `sumObservedCost`
    // over an empty iteration list is `0` for any rates map, which is what
    // lets the preflight pass. The moment a rate-less model actually serves a
    // turn, `sumObservedCost` returns `undefined`, `snapshot()` omits
    // `costThisRun`, and every gated call escalates on
    // `budget.cost-per-run.unobservable`.
    //
    // The first tool call already arrives AFTER turn 1, so the very first
    // gated call is refused — the fleet is never touched at all. That is the
    // sharp edge behind ordering constraint 2: an operator who declares
    // `costPerRun` but forgets a rate for one fallback model gets a run that
    // spends tokens and learns nothing.
    const config = await fleetConfig(
      // Deliberately EMPTY: no rate for the model that serves every turn.
      { modelRates: [] },
      { costPerRun: 2 },
    );
    scriptCli([makeDoctorPayload()]);
    scriptModel([
      toolUseReply("fleet_doctor"),
      toolUseReply("fleet_list"),
      textReply("done"),
    ]);
    const reportRecovery = vi.fn();

    await run({ config, reportRecovery });

    // Nothing reached the CLI: every gated call was refused before execution.
    expect(cliCalls).toEqual([]);
    // And the refusal is visible to a scheduler, not silent.
    expect(reportRecovery).toHaveBeenCalled();
    const detail = String(
      (reportRecovery.mock.calls[0]?.[0] as Core.M3LRunRecoveryEntry).error[0]
        ?.message,
    );
    expect(detail).toContain("budget.cost-per-run.unobservable");
  });
});

describe("runHealthCheck — the tool surface", () => {
  it("declares at most one input property per tool, across the whole surface", async () => {
    // Mechanised form of the invariant the whole model-safety boundary rests
    // on: "the model supplies exactly one value across the whole tool
    // surface — a script name." Adding a second field to any tool fails this.
    const { buildHealthTools } =
      await import("../../src/steps/build-health-tools.js");
    const { AgentHealthObservations } =
      await import("../../src/steps/health-observations.js");
    const specs = buildHealthTools({
      surface: unusedSurface(),
      observations: new AgentHealthObservations(),
      includeDryRunProbe: true,
    });

    expect(specs).toHaveLength(4);
    for (const spec of specs) {
      const properties = asRecord(spec.inputSchema)["properties"];
      expect(Object.keys(asRecord(properties)).length).toBeLessThanOrEqual(1);
    }
  });

  it("reads scriptName with Object.hasOwn, so a prototype-chain value is refused", async () => {
    // A model can literally send `{"__proto__": {"scriptName": "…"}}`. A
    // bracket read answers from the prototype chain; `Object.hasOwn` refuses.
    //
    // Asserted against `describeAction` directly, NOT through the loop: the
    // library declines to transmit a `toolUse` input that cannot round-trip
    // through the Converse document type, so a prototype-only object never
    // reaches this boundary from a real model. The boundary must still hold
    // — the same input CAN arrive from any other future dispatcher.
    const { buildHealthTools } =
      await import("../../src/steps/build-health-tools.js");
    const { AgentHealthObservations } =
      await import("../../src/steps/health-observations.js");
    const inspect = buildHealthTools({
      surface: unusedSurface(),
      observations: new AgentHealthObservations(),
      includeDryRunProbe: false,
    }).find((spec) => spec.name === "script_inspect");
    if (inspect === undefined) throw new Error("script_inspect not built");

    // An own property is accepted...
    expect(inspect.describeAction({ scriptName: "s3-objects" }).script).toBe(
      "s3-objects",
    );
    // ...the identical value on the prototype is not.
    expect(() =>
      inspect.describeAction(Object.create({ scriptName: "s3-objects" })),
    ).toThrow(M3LAgentOperatorCliError);
  });

  it("refuses an oversized script name before anything is recorded", async () => {
    // Without the allowlist's length cap, a hostile 5,000-character name
    // builds an entry that breaches the decision log's line ceiling; the gate
    // reads that as a WRITE failure, calls `observeDecisionLog(false)`, and
    // every subsequent action escalates on `decision-log-unavailable`. That
    // is a model-triggerable self-DOS.
    const config = await fleetConfig();
    scriptCli([makeDoctorPayload()]);
    scriptModel([
      toolUseReply("script_inspect", { scriptName: "a".repeat(5000) }),
      toolUseReply("fleet_doctor"),
      textReply("done"),
    ]);

    await run({ config });

    // The refusal cost nothing and poisoned nothing: the NEXT gated call
    // still ran, which it could not have done had the log been marked
    // unavailable.
    expect(cliCalls).toEqual([["doctor", "--json"]]);
  });

  it("does not offer script_dry_run unless probes are armed AND the allowlist is non-empty", async () => {
    // Layer one of the two fail-closed layers: the spec is not built, so the
    // tool is not in the registry and is never even declared to the model.
    const config = await fleetConfig();
    scriptModel([textReply("nothing to do")]);

    await run({ config });

    const first = invokeCalls[0];
    if (first === undefined) throw new Error("no invoke recorded");
    const offered = (first.tools ?? []).map((tool) => tool.name);
    expect(offered).toEqual(["fleet_list", "fleet_doctor", "script_inspect"]);
    expect(offered).not.toContain("script_dry_run");
  });

  it("builds script_dry_run when both the flag and a non-empty allowlist are present", async () => {
    const config = await fleetConfig({
      includeDryRunProbes: true,
      dryRunAllowlist: ["s3-objects"],
    });
    scriptCli([makeRunEnvelopePayload({ script: "s3-objects" })]);
    scriptModel([
      toolUseReply("script_dry_run", { scriptName: "s3-objects" }),
      textReply("probe clean"),
    ]);

    await run({ config });

    expect(cliCalls).toEqual([
      ["run", "s3-objects", "--json", "--", "--dry-run"],
    ]);
    expect(asRecord((await readReport())["observed"])["dryRunProbes"]).toBe(1);
  });
});

describe("runHealthCheck — the report is built from observations, never the model's message", () => {
  it("derives a doctor failure the model never mentioned", async () => {
    const config = await fleetConfig();
    scriptCli([
      makeDoctorPayload([
        makeDoctorCheck({
          name: "node-version",
          status: "fail",
          detail: "too old",
        }),
      ]),
    ]);
    scriptModel([
      toolUseReply("fleet_doctor"),
      // The model claims everything is fine. The report must disagree.
      textReply("Everything is fine, no problems at all."),
    ]);

    await run({ config });

    const report = await readReport();
    expect(report["blocking"]).toBe(true);
    expect(report["anomalies"]).toEqual([
      {
        kind: "doctor-check-failed",
        subject: "node-version",
        detail: "too old",
      },
    ]);
  });

  it("derives a config-load failure from the fleet roster", async () => {
    const config = await fleetConfig();
    scriptCli([makeListPayload([makeListRow(), makeListRowFailed()])]);
    scriptModel([toolUseReply("fleet_list"), textReply("ok")]);

    await run({ config });

    const report = await readReport();
    expect(report["blocking"]).toBe(true);
    expect(asRecord((report["anomalies"] as unknown[])[0])["kind"]).toBe(
      "script-config-load-failed",
    );
  });

  it("puts the model's text at model.summary and NOWHERE else", async () => {
    // Plant a distinctive marker and assert it occurs exactly once in the
    // serialized artifact. A second occurrence means the model's words leaked
    // into a second field.
    const marker = "zzUNTRUSTEDMARKERzz";
    const config = await fleetConfig();
    scriptCli([makeDoctorPayload()]);
    scriptModel([
      toolUseReply("fleet_doctor"),
      textReply(`All good ${marker} indeed.`),
    ]);

    await run({ config });

    const serialized = JSON.stringify(await readReport());
    expect(serialized.split(marker)).toHaveLength(2);
  });

  it("sanitizes the model's summary through the same sanitizer used outbound", async () => {
    const config = await fleetConfig();
    scriptCli([makeDoctorPayload()]);
    scriptModel([
      toolUseReply("fleet_doctor"),
      // A C1 control and a secret-shaped assignment: both must be neutralised
      // before this reaches an artifact a human will `cat`.
      textReply("token=supersecret and a  control"),
    ]);

    await run({ config });

    const summary = asRecord((await readReport())["model"])["summary"];
    expect(String(summary)).not.toContain("supersecret");
    expect(String(summary)).not.toContain("");
  });

  it("reports null, never an empty string, when the model produced no text", async () => {
    const config = await fleetConfig();
    scriptModel([emptyReply()]);

    await run({ config });

    expect(asRecord((await readReport())["model"])["summary"]).toBeNull();
  });
});

describe("runHealthCheck — outcome and ordering after the loop", () => {
  it("reports every anomaly as an absorbed failure, so the run demotes to partial", async () => {
    const config = await fleetConfig();
    scriptCli([
      makeDoctorPayload([
        makeDoctorCheck({ name: "a", status: "fail", detail: "broken" }),
        makeDoctorCheck({ name: "b", status: "warn", detail: "degraded" }),
      ]),
    ]);
    scriptModel([toolUseReply("fleet_doctor"), textReply("bad")]);
    const reportRecovery = vi.fn();

    await run({ config, reportRecovery });

    const items = reportRecovery.mock.calls.map(
      (call) => (call[0] as Core.M3LRunRecoveryEntry).item,
    );
    expect(items).toContain("a");
    expect(items).toContain("b");
  });

  it("writes the artifact BEFORE reportRecovery fires", async () => {
    // The unhealthy path is the path this artifact exists for, so no later
    // branch may cost the deliverable.
    const config = await fleetConfig();
    scriptCli([
      makeDoctorPayload([
        makeDoctorCheck({ name: "a", status: "fail", detail: "broken" }),
      ]),
    ]);
    scriptModel([toolUseReply("fleet_doctor"), textReply("bad")]);

    let artifactsAtFirstRecovery = -1;
    const reportRecovery = (): void => {
      if (artifactsAtFirstRecovery !== -1) return;
      // Probe the OUTPUT DIRECTORY, synchronously, from inside the callback.
      // Setting a flag here would prove only that `reportRecovery` was called
      // at all — moving `writeHealthReport` after `reportAnomalies` would keep
      // such a test green while breaking the very property it names.
      artifactsAtFirstRecovery = readdirSync(outputDir).length;
    };

    await run({ config, reportRecovery });

    expect(artifactsAtFirstRecovery).toBe(1);
    expect(await readdir(outputDir)).toHaveLength(1);
  });

  it("absorbs a loop-ceiling breach into an anomaly rather than losing the findings", async () => {
    // Destroying already-collected fleet findings because the model was
    // chatty is the wrong trade.
    const config = await fleetConfig({ maxIterations: 1 });
    scriptCli([makeDoctorPayload()]);
    scriptModel([toolUseReply("fleet_doctor"), toolUseReply("fleet_list")]);
    const reportRecovery = vi.fn();

    await run({ config, reportRecovery });

    const report = await readReport();
    // The doctor result IS still in the artifact.
    expect(asRecord(report["observed"])["doctorChecks"]).toBe(1);
    expect(asRecord(report["loop"])["stopReason"]).toBeNull();
    const items = reportRecovery.mock.calls.map(
      (call) => (call[0] as Core.M3LRunRecoveryEntry).item,
    );
    expect(items).toContain("agent-loop");
  });

  it("does NOT absorb model unavailability — a scheduler must tell 6 from 3", async () => {
    const config = await fleetConfig();
    vi.mocked(createInvoker).mockReturnValue({
      invoke: () =>
        Promise.reject(
          new AWS.M3LBedrockRuntimeNoModelError("every model exhausted", {
            attemptedModels: [FAKE_MODEL_ID],
          }),
        ),
    });

    await expect(run({ config })).rejects.toBeInstanceOf(
      AWS.M3LBedrockRuntimeNoModelError,
    );
  });

  it("propagates an abort instanceof-intact, so Ctrl-C still exits 5", async () => {
    // A widened `instanceof Core.M3LError` catch would swallow this.
    const config = await fleetConfig();
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

describe("runHealthCheck — the cross-run counter", () => {
  it("records the run's invocations even when the loop throws", async () => {
    // The counter write lives in a `finally`: a crash mid-loop must not
    // forget invocations that were already made and already billed.
    const config = await fleetConfig();
    scriptCli([makeDoctorPayload()]);
    let turn = 0;
    vi.mocked(createInvoker).mockReturnValue({
      invoke(request) {
        invokeCalls.push(request);
        turn += 1;
        if (turn === 1) {
          return Promise.resolve(toolUseReply("fleet_doctor"));
        }
        return Promise.reject(
          new AWS.M3LBedrockRuntimeNoModelError("gone", {
            attemptedModels: [FAKE_MODEL_ID],
          }),
        );
      },
    });

    await expect(run({ config })).rejects.toThrow();

    const payload = asRecord(
      asRecord(
        JSON.parse(
          await readFile(
            path.join(
              dataDir,
              "agent-state",
              "daily-invocations.checkpoint.json",
            ),
            "utf8",
          ),
        ),
      )["payload"],
    );
    // One approved tool call happened before the model went away.
    expect(payload["invocations"]).toBe(1);
  });
});

describe("runHealthCheck — against the REAL committed policy", () => {
  // The canary. `data/input/agent-policy.json` declares all five budgets, so
  // this run only reaches an auto-approved conclusion if BOTH metering seams
  // are wired: the daily invocation counter (which makes `invocationsPerDay`
  // observable) and the metered invoker constructed before the preflight
  // (which makes `tokensPerRun`/`costPerRun`/`loopIterations` observable).
  // If either is missing this is the one test in the package that fails, and
  // it fails naming the exact rule.
  it("reaches an auto-approved conclusion and completes cleanly", async () => {
    await writePolicyFixture(
      "agent-policy.json",
      await realAgentPolicyDeclaration(),
    );
    const config = buildConfig({
      policyFile: "agent-policy.json",
      decisionLogDir: logDir(),
    });
    scriptCli([makeDoctorPayload()]);
    scriptModel([toolUseReply("fleet_doctor"), textReply("Fleet healthy.")]);

    await expect(run({ config })).resolves.toBeUndefined();

    const entries = await readEntries(logDir());
    expect(asRecord(entries[1])["verdict"]).toBe("auto-approved");
    expect((await readReport())["blocking"]).toBe(false);
  });
});

describe("runHealthCheck — failure paths leave no artefact behind", () => {
  it("aborts before any decision-log write when the policy cannot be loaded", async () => {
    const config = buildConfig({
      policyFile: "no-such-policy.json",
      decisionLogDir: logDir(),
    });

    await expect(run({ config })).rejects.toBeInstanceOf(
      M3LAgentOperatorCliError,
    );
    expect(await readEntries(logDir())).toEqual([]);
    expect(await readdir(outputDir)).toEqual([]);
  });

  it("never invokes the model when the preflight escalates", async () => {
    await writePolicyFixture(
      "no-grant.json",
      // No `agent-operator` grant at all, so the action is ungranted.
      { version: 1, scripts: [{ script: "s3-objects", allOperations: true }] },
    );
    const config = buildConfig({
      policyFile: "no-grant.json",
      decisionLogDir: logDir(),
    });
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_ESCALATED",
    });
    expect(invokeCalls).toEqual([]);
    expect(await readdir(outputDir)).toEqual([]);
  });
});

describe("runHealthCheck — the prompt", () => {
  it("sends a script-authored system prompt that tells the model it has no machine-readable channel", async () => {
    const config = await fleetConfig();
    scriptModel([textReply("ok")]);

    await run({ config });

    const first = invokeCalls[0];
    if (first === undefined) throw new Error("no invoke recorded");
    expect(first.system).toMatch(/machine-readable report is assembled/i);
    expect(first.system).toMatch(/prose only/i);
  });

  it("does not advertise the dry-run tool when it was never registered", async () => {
    const config = await fleetConfig();
    scriptModel([textReply("ok")]);

    await run({ config });

    const first = invokeCalls[0];
    if (first === undefined) throw new Error("no invoke recorded");
    const userText = JSON.stringify(first.messages);
    expect(userText).toMatch(/No dry-run probe tool is available/);
  });
});

describe("runHealthCheck — exit-code parity through the real mapper", () => {
  // Every arm through the REAL `deriveCommandOutcome` ->
  // `mapCommandOutcomeToExitCode`, so the table in this module's own doc is
  // pinned rather than described.
  /**
   * The structural subset `deriveCommandOutcome` reads. Declared rather than
   * cast so a widening of `M3LCommandRunState` fails here.
   */
  type FakeRunState = Parameters<typeof Core.deriveCommandOutcome>[0];
  const entry: Core.M3LRunRecoveryEntry = {
    item: "x",
    error: [{ name: "E", message: "m" }],
    recordedAt: "2026-09-01T00:00:00.000Z",
  };

  it.each([
    ["clean run", { recovery: [], recoveryTotal: 0 }, [], 0],
    ["one anomaly", { recovery: [entry], recoveryTotal: 1 }, [], 6],
    [
      "an abort",
      { recovery: [], recoveryTotal: 0 },
      [new Core.M3LOperationAbortedError("stop")],
      5,
    ],
    [
      // `ERR_BEDROCK_RUNTIME_OPERATION` is catalogued `origin: "external"`.
      "a Bedrock transport failure",
      { recovery: [], recoveryTotal: 0 },
      [new AWS.M3LBedrockRuntimeOperationError("transport blew up")],
      3,
    ],
    [
      // `ERR_BEDROCK_RUNTIME_NO_MODEL` is catalogued `origin: "caller"` — the
      // library treats "every declared model is unavailable" as the caller's
      // model list being wrong, not as an external fault. Exit 2, NOT 3.
      // Pinned because the distinction is easy to assume the other way.
      "every declared model exhausted",
      { recovery: [], recoveryTotal: 0 },
      [
        new AWS.M3LBedrockRuntimeNoModelError("gone", {
          attemptedModels: [FAKE_MODEL_ID],
        }),
      ],
      2,
    ],
  ] as ReadonlyArray<
    readonly [
      label: string,
      run: FakeRunState,
      failures: readonly unknown[],
      exit: number,
    ]
  >)("%s exits %i", (_label, runState, failures, exit) => {
    const outcome = Core.deriveCommandOutcome(runState, failures, false);
    expect(Core.mapCommandOutcomeToExitCode(outcome)).toBe(exit);
  });
});
