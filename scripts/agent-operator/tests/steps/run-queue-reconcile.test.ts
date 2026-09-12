/**
 * Tests for `steps/run-queue-reconcile` — the `queue-reconcile` workload:
 * the fourth policy-gated `agent-operator` operation, verifying an
 * operator-declared `flowAllowlist` (`lib/flow-definitions.js`'s
 * `verifyFlowNames`) and then offering the model exactly one tool,
 * `reconcile_queue` (`steps/build-flow-tools.js`), through the real Bedrock
 * tool loop.
 *
 * Written RED, before `src/steps/run-queue-reconcile.ts` exists. Mirrors
 * `run-log-triage.test.ts`'s own harness shape (same 7 mocked seams), with
 * the preset-verification/single-phase-tool-building pair substituted for
 * their flow-shaped twins: `lib/flow-definitions.js`'s `verifyFlowNames`
 * (fully faked — the real refusal grammar is `flow-definitions.test.ts`'s
 * own subject) in place of `lib/triage-presets.js`'s `verifyTriagePresets`,
 * and `steps/build-flow-tools.js`'s `buildFlowTools` (pass-through spy) in
 * place of `steps/build-triage-tools.js`'s `buildTriageTools`.
 *
 * SCOPE OF THIS DISPATCH (part 1 of 2): the harness, the three setup
 * refusals, and the happy path. The INDETERMINATE/timeout cases are a
 * second dispatch's job — nothing here references them, and this file is
 * written to stay cleanly appendable (new `describe` blocks only).
 *
 * ## Guesses made without a `docs/reference` contract to read against
 *
 * `run-queue-reconcile.ts` is a brand-new operation with no prior slice, so
 * several details below are this file's own inference rather than a pinned
 * contract — flagged here rather than silently assumed:
 *
 * 1. **The exported names** are guessed as `runQueueReconcile` /
 *    `RunQueueReconcileDeps`, mirroring every sibling `run-*.ts` module's
 *    naming convention exactly.
 * 2. **The "flow family" refusal** is guessed to compare `runtime.scripts`'s
 *    sole entry against `steps/build-flow-tools.js`'s already-exported
 *    `RECONCILE_TARGET_COMMAND` (`"flow"`) — reusing that real, existing
 *    constant rather than inventing a new one, on the theory that this
 *    operation targets the `m3l flow` subcommand family rather than a
 *    specific fleet script the way `triage-logs`/`run-preset` do.
 * 3. **`config.ts` has no `"queue-reconcile"` `command` value yet** (this
 *    module is that operation's first slice), so `buildConfig` below sets
 *    `command: "run-preset"` purely to satisfy that parameter's membership
 *    validator — `resolve-runtime.ts` never reads `command` at all (grepped:
 *    zero references), so this has no bearing on `runQueueReconcile`'s own
 *    behaviour. The hub will need a companion `config.ts` change (a
 *    `"queue-reconcile"` `AGENT_OPERATOR_COMMAND_DECLARATIONS` entry
 *    requiring `flowAllowlist`) before this suite can go GREEN.
 * 4. **The outer preflight action** is guessed as `kind: "read-only"`,
 *    `operation: "queue-reconcile"` — mirroring `run-etl-preset.ts`'s own
 *    `runPresetAction`: the ACTION describes running the agent, not the
 *    child `reconcile_queue` tool's own `kind: "mutating"` action
 *    (`build-flow-tools.ts`'s `describeAction`), exactly as documented on
 *    that module's own remarks.
 * 5. **No `flowAllowlist` raw config key is set** anywhere below: since
 *    `verifyFlowNames` is fully faked in this file, nothing reads it for
 *    real, and `resolve-runtime.ts`/`config.ts` do not yet declare it as a
 *    parameter (grepped: no hits) — setting an undeclared key could throw at
 *    `Core.M3LConfig.set()` time for reasons unrelated to this module.
 *
 * **Offline, fakes only.** No test constructs a `BedrockRuntimeClient` or
 * spawns an `m3l` child process — `steps/create-invoker.js` and
 * `lib/cli-process.js`'s `runCliProcess` are the two faked seams (plus
 * `verifyFlowNames`, fully faked for the reason above). Every happy-path
 * test below scripts the model to reply with plain text on turn one, so the
 * loop never actually reaches `reconcile_queue`'s `execute` — meaning
 * `runCliProcess` is never invoked at all in this file.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { AGENT_OPERATOR_COMMAND_DECLARATIONS } from "../../src/config.js";
import type * as BuildFlowToolsModule from "../../src/steps/build-flow-tools.js";
import type * as BuildToolRegistryModule from "../../src/steps/build-tool-registry.js";
import type * as FlowDefinitionsModule from "../../src/lib/flow-definitions.js";
import type * as MeteringInvokerModule from "../../src/steps/metering-invoker.js";
import type * as PrepareGatedOperationModule from "../../src/steps/prepare-gated-operation.js";
import type {
  FlowDefinitionReader,
  VerifiedFlowTarget,
  VerifyFlowNamesDeps,
} from "../../src/lib/flow-definitions.js";
import { FAKE_MODEL_ID, textReply } from "../support/healthFakes.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";

// --- the two faked seams ---------------------------------------------------

vi.mock("../../src/steps/create-invoker.js", () => ({
  createInvoker: vi.fn(),
}));
vi.mock("../../src/lib/cli-process.js", () => ({
  runCliProcess: vi.fn(),
}));

// Fully faked, not a pass-through spy: this file needs direct control over
// resolve/reject to prove ordering. The real refusal grammar is
// `flow-definitions.test.ts`'s own subject.
vi.mock("../../src/lib/flow-definitions.js", () => ({
  verifyFlowNames: vi.fn(),
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
vi.mock("../../src/steps/build-flow-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BuildFlowToolsModule>();
  return {
    ...actual,
    buildFlowTools: vi.fn(actual.buildFlowTools),
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
import { verifyFlowNames } from "../../src/lib/flow-definitions.js";
import { prepareGatedOperation } from "../../src/steps/prepare-gated-operation.js";
import {
  AGENT_FLOW_TOOL_NAMES,
  buildFlowTools,
  RECONCILE_TARGET_COMMAND,
} from "../../src/steps/build-flow-tools.js";
import { buildAgentToolRegistry } from "../../src/steps/build-tool-registry.js";
import { reconcileMeteredCost } from "../../src/steps/metering-invoker.js";
// GUESS (see module remarks, point 1): the module under test does not exist
// yet — this is the whole reason this suite is RED.
import { runQueueReconcile } from "../../src/steps/run-queue-reconcile.js";
import type { RunQueueReconcileDeps } from "../../src/steps/run-queue-reconcile.js";

const DEFAULT_ENTRYPOINT = "/fake/repo/packages/m3l-cli/bin/m3l.mjs";
const VALID_FLOW_NAME = "dlq-reconcile";
const NON_FLOW_TARGET = "cloudwatch-logs-analysis";

/**
 * The `reconcile-queue` command's declaration, located by its distinguishing
 * `flowAllowlist` requirement rather than by re-typing its `name` — the
 * declaration in `src/config.ts` is the ONE independent source of truth for
 * what string the runner's judged action must carry as its `operation`.
 *
 * This is deliberately NOT a hardcoded string literal matching this test's
 * own policy fixture below: a fixture whose granted `operations` entry and
 * whose expected `operation` value both come from one literal proves only
 * that the fixture agrees with itself (this file previously did exactly
 * that, with both sides reading `"queue-reconcile"` — the wrong name — while
 * the real policy and the real config command name both use
 * `"reconcile-queue"`, so the mismatch went unnoticed). Pinning against
 * `config.ts`'s own declaration instead means: if someone changes the
 * action's `operation` string in `run-queue-reconcile.ts` without changing
 * the declared command name here, the assertion below (see "ties the
 * runner's judged operation to the declared command name") fails.
 */
const RECONCILE_QUEUE_COMMAND = AGENT_OPERATOR_COMMAND_DECLARATIONS.find(
  (declaration) =>
    (declaration.requiredParameters as readonly string[]).includes(
      "flowAllowlist",
    ),
);
if (RECONCILE_QUEUE_COMMAND === undefined) {
  throw new Error(
    "config.ts no longer declares a command requiring flowAllowlist — update this fixture's lookup",
  );
}

let inputDir: string;
let dataDir: string;

/** Every `invoke()` the scripted model made, in order. */
let invokeCalls: AWS.M3LBedrockToolInvokeRequest[];

beforeEach(async () => {
  // `M3LExecutionEnvironment.detect()` memoizes at module scope, so whichever
  // test in this FILE constructs an `M3LPaths` first would otherwise pin the
  // deployment mode for every later test — silently turning their own
  // `vi.stubEnv("M3L_DEPLOYMENT_MODE", ...)` into a no-op.
  Core.M3LExecutionEnvironment.resetForTesting();
  inputDir = await mkdtemp(path.join(tmpdir(), "queue-reconcile-input-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "queue-reconcile-data-"));
  invokeCalls = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(createInvoker).mockReset();
  vi.mocked(runCliProcess).mockReset();
  vi.mocked(verifyFlowNames).mockReset();
  // `mockClear`, never `mockReset`, on the four pass-through spies: they
  // delegate to the REAL implementation, and `mockReset` would strip that
  // delegate, leaving every later test in this file calling `undefined`.
  vi.mocked(prepareGatedOperation).mockClear();
  vi.mocked(buildFlowTools).mockClear();
  vi.mocked(buildAgentToolRegistry).mockClear();
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
 * Scripts the model's turns, in order, behind the mocked `createInvoker`. A
 * turn past the end of the script rejects loudly rather than resolving
 * `undefined`, so a forgotten reply fails the test instead of hanging.
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

/**
 * Reads every decision-log entry the real writer appended, in file then line
 * order — mirrors `run-etl-preset.test.ts`'s/`run-health-check.test.ts`'s own
 * helper of the same name/shape.
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
 * A `queue-reconcile` policy granting the operation as read-only
 * auto-approved (GUESS 4: the outer preflight action's `kind`). No `budgets`
 * declared (an unobservable budget would escalate before anything here could
 * be exercised), and no per-tool grant for `reconcile_queue` itself: no test
 * below drives the tool far enough to reach a per-call gate.
 */
function queueReconcilePolicyDeclaration(): unknown {
  return {
    version: 1,
    scripts: [
      {
        script: "agent-operator",
        // The real committed policy (`data/input/agent-policy.json`) and
        // `config.ts`'s `AGENT_OPERATOR_COMMAND_DECLARATIONS` both grant/
        // declare this operation as `"reconcile-queue"` — NOT
        // `"queue-reconcile"`, which this fixture previously used on both
        // sides of the grant, masking the real mismatch (see
        // `RECONCILE_QUEUE_COMMAND` above).
        operations: ["reconcile-queue"],
        readOnlyOperations: ["reconcile-queue"],
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
  // GUESS 3 (see module remarks): "run-preset" only to satisfy `command`'s
  // membership validator until config.ts declares "queue-reconcile".
  config.set("command", "run-preset");
  config.set("modelId", FAKE_MODEL_ID);
  config.set("cliEntrypoint", DEFAULT_ENTRYPOINT);
  // GUESS 2 (see module remarks): the "flow family" target, reusing the
  // real, already-exported `RECONCILE_TARGET_COMMAND`.
  config.set("scripts", [RECONCILE_TARGET_COMMAND]);
  config.set("presetAllowlist", [
    "nightly=data/config/presets/json-etl/nightly.json",
  ]);
  config.set("modelRates", [`${FAKE_MODEL_ID}=0.003,0.015`]);
  for (const [name, value] of Object.entries(overrides)) {
    config.set(name, value);
  }
  return config;
}

/** Writes {@link queueReconcilePolicyDeclaration} and returns a config wired at it. */
async function queueReconcileConfig(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Core.M3LConfig> {
  await writePolicyFixture(
    "queue-reconcile-policy.json",
    queueReconcilePolicyDeclaration(),
  );
  return buildConfig({
    policyFile: "queue-reconcile-policy.json",
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
  const deps: RunQueueReconcileDeps = {
    config: options.config ?? (await queueReconcileConfig()),
    logger: createLogger(),
    paths: makePaths(),
    signal: options.signal ?? new AbortController().signal,
    reportRecovery: options.reportRecovery ?? vi.fn(),
    // The real `createInvoker` is mocked out, so nothing reads this.
    aws: undefined,
  };
  await runQueueReconcile(deps);
}

/**
 * The refusal-7 policy {@link mintVerifiedFlows} grants by default: `run` for
 * the `sqs-etl` script its fixture step names. This file's `verifyFlowNames`
 * calls exist to mint a `VerifiedFlowTarget` for the runner's OWN refusals,
 * not to exercise refusal 7's grammar (`flow-definitions.test.ts`'s own
 * subject), so a scenario needing a different grant passes its own `policy`
 * override.
 */
function defaultFlowPolicy(): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy({
    version: 1,
    scripts: [{ script: "sqs-etl", operations: ["run"] }],
  });
}

/**
 * Builds a {@link VerifiedFlowTarget} by calling the REAL `verifyFlowNames`
 * (bypassing this file's own mock via `vi.importActual`) against injected
 * fakes — never a cast of a plain `Set` onto the branded type. Mirrors
 * `run-log-triage.test.ts`'s own `mintVerifiedPresets()` helper.
 */
async function mintVerifiedFlows(
  overrides: Partial<VerifyFlowNamesDeps> = {},
): Promise<VerifiedFlowTarget> {
  const actual = await vi.importActual<typeof FlowDefinitionsModule>(
    "../../src/lib/flow-definitions.js",
  );
  const readProvider = (_absolutePath: string): FlowDefinitionReader => ({
    rawKeys: () => ["steps"],
    getRawValue: (key: string) =>
      key === "steps"
        ? [{ script: "sqs-etl", parameters: { "aws.profile": "prod" } }]
        : undefined,
  });
  return actual.verifyFlowNames({
    flowAllowlist: new Set([VALID_FLOW_NAME]),
    workspaceRoot: "/workspace/m3l-automation",
    readProvider,
    declaredParameters: () => Promise.resolve(["aws.profile"]),
    policy: defaultFlowPolicy(),
    ...overrides,
  });
}

describe("runQueueReconcile — the three setup refusals", () => {
  it.each([[[]], [["flow", "other-flow"]]])(
    "throws ERR_AGENT_OPERATOR_CONFIG when scripts does not declare exactly one entry (%j)",
    async (scripts) => {
      const config = await queueReconcileConfig({ scripts });

      await expect(run({ config })).rejects.toMatchObject({
        code: "ERR_AGENT_OPERATOR_CONFIG",
      });

      expect(verifyFlowNames).not.toHaveBeenCalled();
      expect(buildAgentToolRegistry).not.toHaveBeenCalled();
      expect(invokeCalls).toEqual([]);
    },
  );

  it("throws ERR_AGENT_OPERATOR_CONFIG when the declared target is not the flow family", async () => {
    const config = await queueReconcileConfig({ scripts: [NON_FLOW_TARGET] });

    await expect(run({ config })).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
    });

    expect(verifyFlowNames).not.toHaveBeenCalled();
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    expect(invokeCalls).toEqual([]);
  });

  it("throws ERR_AGENT_OPERATOR_CONFIG when no workspace root can be resolved (standalone mode)", async () => {
    // Forces `Core.M3LPaths.getProjectRoot()` to throw
    // `M3LPathResolutionError`, which `prepare-gated-operation.ts`'s
    // `deriveWorkspaceRoot` catches and degrades to `setup.workspaceRoot
    // === undefined` — the documented standalone-mode signal.
    vi.stubEnv("M3L_DEPLOYMENT_MODE", "standalone");
    const config = await queueReconcileConfig();

    await expect(run({ config })).rejects.toMatchObject({
      code: "ERR_AGENT_OPERATOR_CONFIG",
    });

    expect(verifyFlowNames).not.toHaveBeenCalled();
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    expect(invokeCalls).toEqual([]);
  });
});

describe("runQueueReconcile — verifyFlowNames must run before the registry is built, and may reject", () => {
  it("propagates a verifyFlowNames rejection and never builds the registry", async () => {
    const config = await queueReconcileConfig();
    const rejection = new Error("flow allowlist has no entries");
    vi.mocked(verifyFlowNames).mockRejectedValueOnce(rejection);
    scriptModel([textReply("never reached")]);

    await expect(run({ config })).rejects.toThrow();

    // The load-bearing assertion: ORDERING, not merely the throw. A verifier
    // that ran AFTER the registry was built would leave a tool existing for
    // an unverified flow — a throw-only assertion cannot tell the two apart.
    expect(buildAgentToolRegistry).not.toHaveBeenCalled();
    expect(buildFlowTools).not.toHaveBeenCalled();
    expect(invokeCalls).toEqual([]);
  });
});

describe("runQueueReconcile — the happy path", () => {
  it("builds the registry from verifyFlowNames' own returned brand and gradedProfile", async () => {
    const config = await queueReconcileConfig();
    const target = await mintVerifiedFlows();
    vi.mocked(verifyFlowNames).mockResolvedValueOnce(target);
    scriptModel([textReply("nothing to reconcile")]);

    await expect(run({ config })).resolves.toBeUndefined();

    expect(buildFlowTools).toHaveBeenCalledTimes(1);
    const [deps] = vi.mocked(buildFlowTools).mock.calls[0] ?? [];
    // Identity, not a re-derived equivalent value: a caller re-deriving
    // `flowAllowlist`/`gradedProfile` from the raw allowlist a second time
    // is exactly the defect class `flow-definitions.ts`'s own module remarks
    // warn against.
    expect(deps?.flowAllowlist).toBe(target.flows);
    expect(deps?.gradedProfile).toBe(target.gradedProfile);

    expect(buildAgentToolRegistry).toHaveBeenCalledTimes(1);

    // And the model was genuinely offered exactly the one tool.
    const first = invokeCalls[0];
    if (first === undefined) throw new Error("no invoke recorded");
    expect((first.tools ?? []).map((tool) => tool.name)).toEqual([
      AGENT_FLOW_TOOL_NAMES.reconcileQueue,
    ]);
  });

  it("concludes through the shared conclusion tail, writing a concluding decision-log entry", async () => {
    const config = await queueReconcileConfig();
    const target = await mintVerifiedFlows();
    vi.mocked(verifyFlowNames).mockResolvedValueOnce(target);
    scriptModel([textReply("nothing to reconcile")]);

    await expect(run({ config })).resolves.toBeUndefined();

    const entries = await readEntries(logDir());
    // Length asserted (not just the last entry's fields) so this cannot
    // vacuously pass against the preflight's own bootstrap entry, which
    // already carries `operation`/`verdict` but never `tokens`/`cost`.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const conclusion = entries[entries.length - 1];
    expect(Object.hasOwn(conclusion ?? {}, "tokens")).toBe(true);
    expect(Object.hasOwn(conclusion ?? {}, "cost")).toBe(true);
    expect(typeof conclusion?.["tokens"]).toBe("number");
    expect(typeof conclusion?.["cost"]).toBe("number");
    // Ties the runner's judged `operation` to `config.ts`'s declared command
    // name — an INDEPENDENT source the runner does not control, unlike this
    // file's own policy fixture above. If `run-queue-reconcile.ts`'s action
    // ever declares a different `operation` string than the one `config.ts`
    // declares for this command (the exact defect a review found: the
    // runner declared `"queue-reconcile"` while both the config command name
    // and the real policy grant use `"reconcile-queue"`), this fails even
    // though the fixture above is internally consistent.
    expect(conclusion?.["operation"]).toBe(RECONCILE_QUEUE_COMMAND.name);
    expect(conclusion?.["script"]).toBe("agent-operator");
    expect(conclusion?.["verdict"]).toBe("auto-approved");
  });
});

// Part 2 of this dispatch: the ORDINARY (non-indeterminate) rejection path.
//
// The INDETERMINATE-timeout classification and its decision-log recording
// used to be tested here, but both now live in `build-flow-tools.ts`'s own
// `execute` — not in this runner — so that case moved to
// `build-flow-tools.test.ts`'s own "the INDETERMINATE timeout rule" describe
// block, rewritten against `execute` directly. See
// `steps/build-flow-tools.ts`'s module remarks, "The INDETERMINATE rule
// lives HERE, not in the runner": `AWS.runBedrockToolLoop`'s tool-dispatch
// layer converts a handler rejection into an error toolResult and keeps the
// loop running, and `gate-tool.ts`'s `runApprovedExecution` re-wraps it
// before this runner's own `catch` could ever see it — so a classifier
// placed at this runner's `catch` was dead code no execution path could
// reach, which is exactly why the rule moved.
//
// What's still worth proving at THIS layer: an ordinary rejection reaching
// `runQueueReconcile`'s own `catch` (a declared ceiling, model
// unavailability, an abort, or any tool-level failure the loop itself
// surfaces) propagates completely UNCHANGED — the runner does no
// re-wrapping and no recording of its own. Every case below rejects the
// mocked `createInvoker`'s own `invoke()` directly rather than driving a
// real `reconcile_queue` tool call, on the inference (stated in the module's
// own remarks) that every such failure reaches this runner's `catch`
// identically regardless of its origin.
//
// The `outcome`/decision-log half of these cases — "leaves the recorder
// untouched" — moved to `build-flow-tools.test.ts` alongside the one case
// (`disposition: "timed-out"`) that DOES record: this runner suite can no
// longer observe any recording at all (the runner never calls the recorder
// itself), so an assertion here that "the runner recorded nothing" would be
// tautologically true for every input, including a real timeout, and would
// no longer discriminate the bug it was written for.
describe("runQueueReconcile — ordinary rejections propagate unchanged", () => {
  const ORDINARY_CLI_SPAWN_DISPOSITIONS: readonly [string, () => Error][] = [
    [
      "disposition: spawn-failed",
      () =>
        new M3LAgentOperatorCliError(
          "the m3l process could not be spawned",
          "ERR_AGENT_OPERATOR_CLI_SPAWN",
          { context: { disposition: "spawn-failed" } },
        ),
    ],
    [
      "disposition: output-truncated",
      () =>
        new M3LAgentOperatorCliError(
          "the m3l process output exceeded the byte cap",
          "ERR_AGENT_OPERATOR_CLI_SPAWN",
          { context: { disposition: "output-truncated" } },
        ),
    ],
    [
      "disposition: signalled",
      () =>
        new M3LAgentOperatorCliError(
          "the m3l process was killed by a signal",
          "ERR_AGENT_OPERATOR_CLI_SPAWN",
          { context: { disposition: "signalled" } },
        ),
    ],
    [
      "no context at all",
      () =>
        new M3LAgentOperatorCliError(
          "the m3l process failed with no diagnostic context",
          "ERR_AGENT_OPERATOR_CLI_SPAWN",
        ),
    ],
    [
      "context present but with no disposition key",
      () =>
        new M3LAgentOperatorCliError(
          "the m3l process failed with unrelated context",
          "ERR_AGENT_OPERATOR_CLI_SPAWN",
          { context: { unrelatedField: "x" } },
        ),
    ],
    ["a plain non-coded Error", () => new Error("boom")],
  ];

  it.each(ORDINARY_CLI_SPAWN_DISPOSITIONS)(
    "propagates an ordinary rejection unchanged (%s)",
    async (_label, makeRejection) => {
      const config = await queueReconcileConfig();
      const target = await mintVerifiedFlows();
      vi.mocked(verifyFlowNames).mockResolvedValueOnce(target);
      const rejection = makeRejection();
      vi.mocked(createInvoker).mockReturnValue({
        invoke: () => Promise.reject(rejection),
      });

      let thrown: unknown;
      try {
        await run({ config });
      } catch (error) {
        thrown = error;
      }

      // Propagated UNCHANGED: the exact same instance, not a re-wrap. Still
      // meaningful at this layer — the runner really does pass an ordinary
      // rejection through unchanged. The "never records an indeterminate
      // entry" half of this case moved to `build-flow-tools.test.ts` (see
      // the describe block's own remarks above): this runner never calls the
      // recorder itself, so asserting "no entry was recorded" here would
      // pass identically whether or not `build-flow-tools.ts`'s `execute`
      // recorded anything at all, for ANY input including a real timeout —
      // it no longer discriminates the bug it was written for.
      expect(thrown).toBe(rejection);
    },
  );

  it("does not honour a disposition present only on the context object's prototype (Object.hasOwn, never `in`)", async () => {
    const config = await queueReconcileConfig();
    const target = await mintVerifiedFlows();
    vi.mocked(verifyFlowNames).mockResolvedValueOnce(target);
    const contextPrototype: Record<string, unknown> = {
      disposition: "timed-out",
    };
    const context = Object.create(contextPrototype) as Record<string, unknown>;
    const rejection = new M3LAgentOperatorCliError(
      "the m3l process failed with an inherited-only disposition",
      "ERR_AGENT_OPERATOR_CLI_SPAWN",
      { context },
    );
    vi.mocked(createInvoker).mockReturnValue({
      invoke: () => Promise.reject(rejection),
    });

    let thrown: unknown;
    try {
      await run({ config });
    } catch (error) {
      thrown = error;
    }

    // Same reasoning as the parameterized cases above: the recording half of
    // this case now lives in `build-flow-tools.test.ts`.
    expect(thrown).toBe(rejection);
  });
});
