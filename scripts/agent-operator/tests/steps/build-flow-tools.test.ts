/**
 * Tests for `steps/build-flow-tools` — the single `reconcile_queue`
 * single-phase, MUTATING tool that drives `m3l flow run` through
 * `AgentCliSurface.flowRun`'s fixed `mode: "mutate"` argv shape.
 *
 * Written RED, before `src/steps/build-flow-tools.ts` exists. Mirrors
 * `build-triage-tools.test.ts`'s structure closely — the same pure-boundary
 * `unusedSurface` idiom and the same dual-entry-point rejection helper for
 * the model-supplied-name validator — but this tool's `describeAction`
 * reports `kind: "mutating"`, never `"read-only"`: unlike `triage_logs`,
 * `m3l flow run` really does mutate, which is the whole reason its policy
 * path differs.
 *
 * `VerifiedFlowNames` (nested inside a `VerifiedFlowTarget`) is minted here
 * by calling the real `verifyFlowNames` from
 * `../../src/lib/flow-definitions.js` with an injected `readProvider` /
 * `declaredParameters` stub — never a cast — so this file's `flowAllowlist`
 * fixture is not vacuous about the brand `build-flow-tools.ts` consumes.
 *
 * Two open questions this file resolves against ground truth rather than
 * guessing, both recorded here so a reviewer can re-check them once the
 * module lands:
 *
 * 1. The task surface sketch names the return type
 *    `readonly AWS.M3LBedrockToolSpec[]`, but no such type exists anywhere
 *    in this repository (`packages/m3l-common/src`, `scripts/agent-operator/src`
 *    both grepped, zero hits). `build-triage-tools.ts` — the explicit
 *    precedent this slice mirrors — returns `readonly AgentToolSpec[]` from
 *    `./gate-tool.js`, so this file follows that ground truth instead.
 * 2. `readFlowName`'s exact `M3LAgentOperatorCliError` code is unstated by
 *    the contract for its own shape checks (array/object/hasOwn/string),
 *    and `lib/flow-names.ts`'s `assertAllowedFlowName` — confirmed by
 *    reading that file — throws `ERR_AGENT_OPERATOR_CONFIG` for both the
 *    brand-shape and allowlist-membership failures, a DIFFERENT code family
 *    than `build-triage-tools.ts`'s own `ERR_AGENT_OPERATOR_PRESET` (which
 *    matches because `assertAllowedPresetName` conveniently already throws
 *    that same code). Rather than guess whether `readFlowName` re-wraps that
 *    into a single family the way `lib/flow-definitions.ts`'s own
 *    `assertFlowNameOnAllowlist` explicitly does, every rejection below
 *    asserts only `toBeInstanceOf(M3LAgentOperatorCliError)` and never pins
 *    a `.code` — pinning the wrong family would fail RED for the wrong
 *    reason.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { verifyFlowNames } from "../../src/lib/flow-definitions.js";
import type {
  FlowDefinitionReader,
  VerifiedFlowTarget,
} from "../../src/lib/flow-definitions.js";
import type { AgentOperatorProjectedFlowEnvelope } from "../../src/lib/model-safety.js";
import {
  AGENT_FLOW_TOOL_NAMES,
  RECONCILE_TARGET_COMMAND,
  buildFlowTools,
} from "../../src/steps/build-flow-tools.js";
import type { BuildFlowToolsDeps } from "../../src/steps/build-flow-tools.js";
import {
  AgentDecisionRecorder,
  agentIdentity,
} from "../../src/steps/decision-recorder.js";
import type { AgentToolSpec } from "../../src/steps/gate-tool.js";
import {
  FailingDecisionLogWriter,
  RecordingDecisionLogWriter,
} from "../support/logFakes.js";
import { minimalPolicy } from "../support/policyFixtures.js";

/** The `AWS.M3LBedrockToolContext` every `execute` call in this file uses. */
function toolContext(name: string): AWS.M3LBedrockToolContext {
  return { toolUseId: "tool-use-1", name };
}

/**
 * Captures every event a `Core.M3LLogger` dispatches, in call order. Same
 * idiom as `tests/steps/conclusion-tail.test.ts`'s `RecordingLoggerHandler` —
 * reused here rather than re-invented, since a failed INDETERMINATE
 * decision-log write is logged through this exact same `logger.error` seam.
 */
class RecordingLoggerHandler implements Core.M3LLoggerHandler {
  readonly events: Core.M3LLogEvent[] = [];
  handle(event: Core.M3LLogEvent): void {
    this.events.push(event);
  }
  reset(): void {
    this.events.length = 0;
  }
}

/** Builds a real logger plus the handler that observes what it dispatched. */
function makeLogger(): {
  readonly logger: Core.M3LLogger;
  readonly handler: RecordingLoggerHandler;
} {
  const handler = new RecordingLoggerHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

/** A surface whose every method rejects — for the pure-boundary tests. */
function unusedSurface(): AgentCliSurface {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error("unexpected CLI call"));
  return {
    list: refuse,
    doctor: refuse,
    inspect: refuse,
    dryRun: refuse,
    run: refuse,
    triageRun: refuse,
    flowRun: refuse,
  };
}

/** The one allowlisted flow name every fixture below shares. */
const FLOW_NAME = "dlq-reconcile";
/** The script every fixture's one synthetic step declares. */
const STEP_SCRIPT = "sqs-etl";
/**
 * The refusal-7 policy every {@link mintFlowTarget} call grants: `run` for
 * {@link STEP_SCRIPT} and nothing else — this file's `verifyFlowNames` calls
 * exist to mint a `VerifiedFlowTarget`, not to exercise refusal 7's grammar
 * (that is `flow-definitions.test.ts`'s own subject), so the grant is fixed
 * rather than parameterized.
 */
const FLOW_POLICY = Core.validateAgentPolicy({
  version: 1,
  scripts: [{ script: STEP_SCRIPT, operations: ["run"] }],
});
/** One graded profile a `VerifiedFlowTarget` fixture may agree on. */
const GRADED_PROFILE_A = "ops-profile-a";
/**
 * A DIFFERENT graded profile than {@link GRADED_PROFILE_A}, minted from an
 * independent `VerifiedFlowTarget`. Used to prove `describeAction`'s
 * `target.profile` really is the INJECTED `gradedProfile` for a given
 * `deps` object, and not some other value the test also happens to have
 * lying around — a single-fixture assertion could pass by coincidence if
 * the implementation stamped a constant or the wrong field.
 */
const GRADED_PROFILE_B = "ops-profile-b";

/**
 * Mints a real {@link VerifiedFlowTarget} by calling `verifyFlowNames` with
 * an injected `readProvider` stub — never a cast. The stub answers every
 * name in `flowNames` with one step declaring `script: STEP_SCRIPT` and
 * `aws.profile: gradedProfile`, which clears every one of
 * `verifyFlowNames`'s refusals: a well-formed name, a `steps` array, no
 * `yesSensitive` key, and exactly one distinct declared `aws.profile` value
 * across every step of every flow.
 */
function mintFlowTarget(
  gradedProfile: string,
  flowNames: readonly string[] = [FLOW_NAME],
): Promise<VerifiedFlowTarget> {
  const flowAllowlist = new Set(flowNames);
  const reader: FlowDefinitionReader = {
    rawKeys: (): readonly string[] => ["steps"],
    getRawValue: (key: string): unknown =>
      key === "steps"
        ? [
            {
              script: STEP_SCRIPT,
              parameters: { "aws.profile": gradedProfile },
            },
          ]
        : undefined,
  };
  return verifyFlowNames({
    flowAllowlist,
    workspaceRoot: "/workspace",
    readProvider: () => reader,
    declaredParameters: () => Promise.resolve([]),
    policy: FLOW_POLICY,
  });
}

/** A fixed instant this file's `BuildFlowToolsDeps.now` fixtures use. */
const DECISION_NOW = Date.UTC(2026, 8, 7, 0, 0, 0);

/**
 * A real, evaluator-produced `Core.M3LAgentDecision` — never hand-built:
 * `verdict-types.ts`'s own remarks say no caller constructs one, and a
 * literal fixture could quietly drift from what `evaluateAgentAction`
 * actually returns. The judged action's own shape is irrelevant to every
 * test that uses this: `BuildFlowToolsDeps.decision` is stamped onto the
 * INDETERMINATE entry verbatim, whatever it is.
 */
function fixtureDecision(): Core.M3LAgentDecision {
  return Core.evaluateAgentAction({
    action: {
      script: "agent-operator",
      operation: "explain-policy",
      kind: "read-only",
    },
    policy: minimalPolicy(),
  });
}

/**
 * Builds a fresh `AgentDecisionRecorder` over a fresh, inspectable
 * `RecordingDecisionLogWriter` — one pair per call, so a test asserting on
 * `writer.entries` never shares state with another test's recorder.
 */
function makeDecisionRecorder(): {
  readonly recorder: AgentDecisionRecorder;
  readonly writer: RecordingDecisionLogWriter;
} {
  const writer = new RecordingDecisionLogWriter();
  const recorder = new AgentDecisionRecorder({
    identity: agentIdentity({ name: "agent-operator" }),
    writer,
  });
  return { recorder, writer };
}

/**
 * Builds `BuildFlowToolsDeps`, overriding only what a scenario cares about.
 * Defaults to a single-flow, single-profile `VerifiedFlowTarget` minted
 * through the real `verifyFlowNames` — never a cast. `decisionRecorder` /
 * `decision` / `now` default to fresh, unobserved fixtures for every test
 * that does not itself care about the INDETERMINATE-recording path — a test
 * that does should override `decisionRecorder` with its own
 * {@link makeDecisionRecorder} pair so it can inspect `writer.entries`.
 */
async function buildDeps(
  overrides: Partial<BuildFlowToolsDeps> = {},
): Promise<BuildFlowToolsDeps> {
  const target = await mintFlowTarget(GRADED_PROFILE_A);
  return {
    surface: unusedSurface(),
    flowAllowlist: target.flows,
    gradedProfile: target.gradedProfile,
    decisionRecorder: makeDecisionRecorder().recorder,
    decision: fixtureDecision(),
    now: DECISION_NOW,
    logger: makeLogger().logger,
    reportRecovery: vi.fn(),
    ...overrides,
  };
}

/** Builds the specs over `deps` and returns the one `reconcile_queue` spec. */
function buildReconcileQueueSpec(deps: BuildFlowToolsDeps): AgentToolSpec {
  const specs = buildFlowTools(deps);
  const found = specs.find(
    (candidate: AgentToolSpec) =>
      candidate.name === AGENT_FLOW_TOOL_NAMES.reconcileQueue,
  );
  if (found === undefined) {
    throw new Error(`${AGENT_FLOW_TOOL_NAMES.reconcileQueue} was not built`);
  }
  return found;
}

/** Captures the thrown value from a zero-argument function, or `undefined`. */
function captureThrown(thunk: () => unknown): unknown {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Drives one malformed/rejected `input` through BOTH `describeAction` and
 * `execute`, asserting each throws `M3LAgentOperatorCliError` and that
 * `surface.flowRun` is never called by either — mirrors
 * `build-triage-tools.test.ts`'s `expectPresetRejectionOnBothEntryPoints`.
 * Does not pin `.code` — see the module remarks' open question 2.
 */
async function expectFlowNameRejectionOnBothEntryPoints(
  spec: AgentToolSpec,
  input: unknown,
  flowRun: ReturnType<typeof vi.fn>,
): Promise<void> {
  const describeThrown = captureThrown(() => spec.describeAction(input));
  expect(describeThrown).toBeInstanceOf(M3LAgentOperatorCliError);

  let executeThrown: unknown;
  try {
    await spec.execute(
      input,
      toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
    );
  } catch (error) {
    executeThrown = error;
  }
  expect(executeThrown).toBeInstanceOf(M3LAgentOperatorCliError);
  expect(flowRun).not.toHaveBeenCalled();
}

/**
 * A flow envelope carrying `exitCode`, shaped exactly as
 * `AgentOperatorProjectedFlowEnvelope` declares (minus its type-only,
 * unexported `MODEL_SAFE_BRAND` marker — cast through `unknown`, mirroring
 * `build-triage-tools.test.ts`'s own `runEnvelope` helper for the same
 * reason: the brand symbol is private to `model-safety.ts`).
 */
function flowEnvelope(
  overrides: Partial<{
    readonly exitCode: number;
    readonly status: "completed" | "failed" | "timed-out" | "aborted";
  }> = {},
): AgentOperatorProjectedFlowEnvelope {
  const envelope = {
    flow: FLOW_NAME,
    runId: "run-1",
    definitionHash: "hash-1",
    startedAt: "2026-09-07T00:00:00.000Z",
    finishedAt: "2026-09-07T00:00:02.000Z",
    durationMs: 2000,
    status: "completed",
    exitCode: 0,
    exitCodeName: "SUCCESS",
    dryRun: false,
    stepExecutionCount: 1,
    haltingStepId: null,
    resumeStepId: null,
    steps: [],
    ...overrides,
  };
  return envelope as unknown as AgentOperatorProjectedFlowEnvelope;
}

describe("buildFlowTools — registration", () => {
  it("returns exactly one frozen spec, named reconcile_queue", async () => {
    const specs = buildFlowTools(await buildDeps());

    expect(Object.isFrozen(specs)).toBe(true);
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec).toBeDefined();
    expect(spec?.name).toBe(AGENT_FLOW_TOOL_NAMES.reconcileQueue);
    expect(spec?.name).toBe("reconcile_queue");
  });

  it("declares AGENT_FLOW_TOOL_NAMES.reconcileQueue as the literal type, not a widened string", () => {
    expectTypeOf(
      AGENT_FLOW_TOOL_NAMES.reconcileQueue,
    ).toEqualTypeOf<"reconcile_queue">();
  });

  it("declares an input schema requiring exactly one string flowName", async () => {
    const spec = buildReconcileQueueSpec(await buildDeps());
    const schema = spec.inputSchema as {
      readonly properties?: Record<string, { readonly type?: string }>;
      readonly required?: readonly string[];
    };

    expect(Object.keys(schema.properties ?? {})).toEqual(["flowName"]);
    expect(schema.properties?.["flowName"]?.type).toBe("string");
    expect(schema.required).toEqual(["flowName"]);
  });
});

describe("buildFlowTools — the target-command pin", () => {
  // `RECONCILE_TARGET_COMMAND` is exported precisely so this pin is a named,
  // checkable value rather than a magic string repeated at every call site —
  // mirroring how `build-triage-tools.ts` exports `TRIAGE_TARGET_SCRIPT` for
  // its own build-time refusal. Unlike that module, `BuildFlowToolsDeps`
  // carries no per-call field naming a target family for `buildFlowTools` to
  // compare against (there is no `scriptName`-shaped analogue in the given
  // surface), and the contract's own Gates section lists Unit 1's refusals
  // and Unit 3's no-retry rule as the two things that MUST be mutation-tested
  // — Unit 2's pin is conspicuously absent from that list. Both signals point
  // to this being a fixed, always-"flow" constant rather than a runtime
  // branch with a reachable "otherwise" arm today. This test therefore pins
  // the constant's value and confirms normal construction is unaffected by
  // it, rather than asserting an unreachable throw — flagged in the final
  // report for reconciliation once the real module lands.
  it("pins the target command to 'flow' and builds normally under it", async () => {
    expect(RECONCILE_TARGET_COMMAND).toBe("flow");

    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const specs = buildFlowTools(deps);

    expect(specs).toHaveLength(1);
    expect(flowRun).not.toHaveBeenCalled();
  });
});

describe("buildFlowTools — describeAction's exact action shape", () => {
  it("returns exactly the declared action shape, kind: mutating — NOT read-only", async () => {
    const deps = await buildDeps();
    const spec = buildReconcileQueueSpec(deps);

    const action = spec.describeAction({ flowName: FLOW_NAME });

    expect(action).toEqual({
      script: "m3l",
      operation: "run",
      kind: "mutating",
      target: { profile: deps.gradedProfile },
      parameterNames: ["flowName"],
    });
  });

  it("reports kind: 'mutating' explicitly — the property that differs from triage_logs and drives the whole policy path", async () => {
    const spec = buildReconcileQueueSpec(await buildDeps());

    const action = spec.describeAction({ flowName: FLOW_NAME });

    expect(action.kind).toBe("mutating");
    expect(action.kind).not.toBe("read-only");
  });

  it("declares parameterNames: ['flowName'] and operation: 'run'", async () => {
    const spec = buildReconcileQueueSpec(await buildDeps());

    const action = spec.describeAction({ flowName: FLOW_NAME });

    expect(action.parameterNames).toEqual(["flowName"]);
    expect(action.operation).toBe("run");
  });

  it.each([
    [GRADED_PROFILE_A, GRADED_PROFILE_B],
    [GRADED_PROFILE_B, GRADED_PROFILE_A],
  ])(
    "stamps target.profile with the INJECTED gradedProfile %s, never the other fixture value %s",
    async (injectedProfile, otherProfile) => {
      const target = await mintFlowTarget(injectedProfile);
      const deps: BuildFlowToolsDeps = {
        surface: unusedSurface(),
        flowAllowlist: target.flows,
        gradedProfile: target.gradedProfile,
        decisionRecorder: makeDecisionRecorder().recorder,
        decision: fixtureDecision(),
        now: DECISION_NOW,
        logger: makeLogger().logger,
        reportRecovery: vi.fn(),
      };
      const spec = buildReconcileQueueSpec(deps);

      const action = spec.describeAction({ flowName: FLOW_NAME });

      expect(action.target?.profile).toBe(injectedProfile);
      expect(action.target?.profile).not.toBe(otherProfile);
    },
  );
});

describe("buildFlowTools — execute", () => {
  it("calls surface.flowRun with the flow name and mode 'mutate', and returns outcome.exitCode from the envelope", async () => {
    const envelope = flowEnvelope({ exitCode: 3, status: "failed" });
    const flowRun = vi.fn(() => Promise.resolve(envelope));
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    const result = await spec.execute(
      { flowName: FLOW_NAME },
      toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
    );

    expect(flowRun).toHaveBeenCalledWith(FLOW_NAME, { mode: "mutate" });
    expect(flowRun).toHaveBeenCalledTimes(1);
    expect(result.outcome.exitCode).toBe(3);
  });

  it("mirrors a clean envelope's exitCode 0 onto outcome.exitCode too", async () => {
    const envelope = flowEnvelope({ exitCode: 0, status: "completed" });
    const flowRun = vi.fn(() => Promise.resolve(envelope));
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    const result = await spec.execute(
      { flowName: FLOW_NAME },
      toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
    );

    expect(result.outcome.exitCode).toBe(0);
  });
});

describe("buildFlowTools — readFlowName rejects before anything is authorized", () => {
  // Every case below is a shape/membership-boundary throw, driven through
  // BOTH describeAction and execute (mirroring build-triage-tools.test.ts's
  // dual-entry-point coverage of readPresetName), and never reaching
  // surface.flowRun. `.code` is deliberately not pinned — see the module
  // remarks' open question 2.

  it("rejects an array input (typeof [] === 'object', so it must be rejected before the shape check)", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    await expectFlowNameRejectionOnBothEntryPoints(spec, [FLOW_NAME], flowRun);
  });

  it("rejects null", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    await expectFlowNameRejectionOnBothEntryPoints(spec, null, flowRun);
  });

  it("rejects a non-object, non-null input", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    await expectFlowNameRejectionOnBothEntryPoints(spec, 42, flowRun);
  });

  it("rejects an object with no own flowName", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    await expectFlowNameRejectionOnBothEntryPoints(spec, {}, flowRun);
  });

  it("rejects an inherited flowName — {'__proto__': {flowName: ...}} must not satisfy the own-key read", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);
    // A real JS object literal with a literal `__proto__` key sets the
    // prototype of the created object (spec behaviour, not JSON.parse's own
    // own-property behaviour), so `flowName` really is answered only by the
    // prototype chain here, never by an own property.
    const hostileInput: unknown = { __proto__: { flowName: FLOW_NAME } };
    expect(Object.hasOwn(hostileInput as object, "flowName")).toBe(false);

    await expectFlowNameRejectionOnBothEntryPoints(spec, hostileInput, flowRun);
  });

  it("rejects a non-string flowName", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    await expectFlowNameRejectionOnBothEntryPoints(
      spec,
      { flowName: 123 },
      flowRun,
    );
  });

  it("rejects a flowName failing the brand's shape pattern (a flag-shaped value)", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    await expectFlowNameRejectionOnBothEntryPoints(
      spec,
      { flowName: "--dry-run" },
      flowRun,
    );
  });

  it("rejects a well-formed flowName that is not a member of the verified allowlist", async () => {
    const flowRun = vi.fn();
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    const spec = buildReconcileQueueSpec(deps);

    await expectFlowNameRejectionOnBothEntryPoints(
      spec,
      { flowName: "not-declared-anywhere" },
      flowRun,
    );
  });
});

// Moved here from `run-queue-reconcile.test.ts`: the INDETERMINATE-timeout
// classification and its decision-log recording both live in THIS module's
// `execute` now, not the runner — `AWS.runBedrockToolLoop`'s tool-dispatch
// layer converts any handler rejection into an error toolResult and keeps
// the loop running, and `gate-tool.ts`'s `runApprovedExecution` re-wraps the
// rejection before a runner-level `catch` could ever see it. See this
// module's own remarks, "The INDETERMINATE rule lives HERE, not in the
// runner".
//
// Rewritten against the real `execute`, not carried over from the prior
// (runner-level) test's assertions: reading `execute`'s own `catch` block
// shows it always `throw`s `cause` UNCHANGED after recording — it does NOT
// wrap the rejection into a distinct escalation-shaped error the way the
// old runner-level version of this test asserted. That assertion was wrong
// for this location once the code moved; verified here against the actual
// source rather than carried forward from the report that described the
// move.
describe("buildFlowTools — execute — the INDETERMINATE timeout rule", () => {
  it("records exactly one indeterminate decision-log entry, then rethrows the timeout rejection UNCHANGED", async () => {
    const cliError = new M3LAgentOperatorCliError(
      "the m3l flow run child timed out mid-flight",
      "ERR_AGENT_OPERATOR_CLI_SPAWN",
      { context: { disposition: "timed-out" } },
    );
    const flowRun = vi.fn(() => Promise.reject(cliError));
    const { recorder, writer } = makeDecisionRecorder();
    const deps = await buildDeps({
      surface: { ...unusedSurface(), flowRun },
      decisionRecorder: recorder,
    });
    const spec = buildReconcileQueueSpec(deps);

    let thrown: unknown;
    try {
      await spec.execute(
        { flowName: FLOW_NAME },
        toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
      );
    } catch (error) {
      thrown = error;
    }

    // UNCHANGED, not re-wrapped: the exact same instance `surface.flowRun`
    // rejected with.
    expect(thrown).toBe(cliError);

    expect(writer.entries).toHaveLength(1);
    const [entry] = writer.entries;
    expect(entry).toBeDefined();
    expect(entry?.outcome).toMatchObject({ dryRun: false });
    expect(
      Object.hasOwn(
        (entry?.outcome ?? {}) as Record<string, unknown>,
        "exitCode",
      ),
    ).toBe(false);
  });

  it("reports a failed indeterminate decision-log write through BOTH logger and reportRecovery, but still rethrows the ORIGINAL flowRun rejection — not the audit-write failure", async () => {
    const cliError = new M3LAgentOperatorCliError(
      "the m3l flow run child timed out mid-flight",
      "ERR_AGENT_OPERATOR_CLI_SPAWN",
      { context: { disposition: "timed-out" } },
    );
    const flowRun = vi.fn(() => Promise.reject(cliError));
    // The decision-log write itself now also fails — `decisionRecorder`
    // is built directly over a `FailingDecisionLogWriter` rather than the
    // `makeDecisionRecorder` happy-path helper, so `record()` rejects.
    const recorder = new AgentDecisionRecorder({
      identity: agentIdentity({ name: "agent-operator" }),
      writer: new FailingDecisionLogWriter(),
    });
    const { logger, handler } = makeLogger();
    const reportRecovery = vi.fn();
    const deps = await buildDeps({
      surface: { ...unusedSurface(), flowRun },
      decisionRecorder: recorder,
      logger,
      reportRecovery,
    });
    const spec = buildReconcileQueueSpec(deps);

    let thrown: unknown;
    try {
      await spec.execute(
        { flowName: FLOW_NAME },
        toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
      );
    } catch (error) {
      thrown = error;
    }

    // The ORIGINAL `flowRun` rejection reaches the caller unchanged — not
    // the secondary decision-log write failure that followed it.
    expect(thrown).toBe(cliError);

    // `reportRecovery` saw the absorbed failure exactly once.
    expect(reportRecovery).toHaveBeenCalledTimes(1);
    const [recoveryEntry] = reportRecovery.mock.calls[0] as [
      Core.M3LRunRecoveryEntry,
    ];
    expect(recoveryEntry.item).toBe(
      "reconcile-queue-indeterminate-decision-log",
    );

    // `logger` saw exactly one error event for the failed write —
    // `reportRecovery` here does not itself throw, so the nested
    // "reporting also failed" branch never fires a second one.
    const errorEvents = handler.events.filter(
      (event) => event.category === Core.M3LLogEventCategory.ERROR,
    );
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.message).toContain(
      "the INDETERMINATE decision-log entry",
    );
  });

  // The seven contrast cases moved from `run-queue-reconcile.test.ts`'s own
  // `ORDINARY_CLI_SPAWN_DISPOSITIONS` + prototype case — rewritten against
  // `execute` directly, and against the writer's own `entries`, never a
  // decision-log directory read. The runner-suite versions of these asserted
  // "the runner records nothing indeterminate for ANY input", which is true
  // but tautological now that the runner records nothing indeterminate for
  // ANY input, INCLUDING a real timeout — moving the recording half here,
  // next to the one case that DOES record, is what makes each case a genuine
  // contrast again.
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
    "propagates an ordinary rejection unchanged and leaves the recorder untouched (%s)",
    async (_label, makeRejection) => {
      const rejection = makeRejection();
      const flowRun = vi.fn(() => Promise.reject(rejection));
      const { recorder, writer } = makeDecisionRecorder();
      const deps = await buildDeps({
        surface: { ...unusedSurface(), flowRun },
        decisionRecorder: recorder,
      });
      const spec = buildReconcileQueueSpec(deps);

      let thrown: unknown;
      try {
        await spec.execute(
          { flowName: FLOW_NAME },
          toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
        );
      } catch (error) {
        thrown = error;
      }

      // Propagated UNCHANGED: the exact same instance, not a re-wrap.
      expect(thrown).toBe(rejection);
      expect(writer.entries).toEqual([]);
    },
  );

  it("does not honour a disposition present only on the context object's prototype (Object.hasOwn, never `in`)", async () => {
    const contextPrototype: Record<string, unknown> = {
      disposition: "timed-out",
    };
    const context = Object.create(contextPrototype) as Record<string, unknown>;
    const rejection = new M3LAgentOperatorCliError(
      "the m3l process failed with an inherited-only disposition",
      "ERR_AGENT_OPERATOR_CLI_SPAWN",
      { context },
    );
    const flowRun = vi.fn(() => Promise.reject(rejection));
    const { recorder, writer } = makeDecisionRecorder();
    const deps = await buildDeps({
      surface: { ...unusedSurface(), flowRun },
      decisionRecorder: recorder,
    });
    const spec = buildReconcileQueueSpec(deps);

    let thrown: unknown;
    try {
      await spec.execute(
        { flowName: FLOW_NAME },
        toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(rejection);
    expect(writer.entries).toEqual([]);
  });
});

// The structural no-retry guard: see this module's own remarks, "No retry
// within one run — structurally, not by convention". The guard is a property
// of one `buildFlowTools()` CALL (one `executionGuard` object shared by that
// call's one spec), so both `execute` calls below must run against the SAME
// spec instance built from a single `buildFlowTools()` invocation — a fresh
// `buildDeps()`/`buildReconcileQueueSpec()` pair per call would each mint its
// own guard and could never observe the refusal.
describe("buildFlowTools — execute — no retry within one run", () => {
  it("refuses a second execute call in the same buildFlowTools result without invoking surface.flowRun again", async () => {
    const flowRun = vi.fn(() => Promise.resolve(flowEnvelope()));
    const deps = await buildDeps({ surface: { ...unusedSurface(), flowRun } });
    // ONE buildFlowTools() call — therefore one guard — reused for both
    // `execute` calls below.
    const spec = buildReconcileQueueSpec(deps);

    const first = await spec.execute(
      { flowName: FLOW_NAME },
      toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
    );
    expect(first.outcome.exitCode).toBe(0);
    expect(flowRun).toHaveBeenCalledTimes(1);

    let secondThrown: unknown;
    try {
      await spec.execute(
        { flowName: FLOW_NAME },
        toolContext(AGENT_FLOW_TOOL_NAMES.reconcileQueue),
      );
    } catch (error) {
      secondThrown = error;
    }

    expect(secondThrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((secondThrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_ESCALATED",
    );
    // The point of this test: no SECOND flow spawns. Asserting the call
    // count (still 1, not 2) is what proves that — a throw-only assertion
    // could not distinguish "refused before dispatch" from "dispatched
    // twice, and the second one happened to also fail".
    expect(flowRun).toHaveBeenCalledTimes(1);
  });
});
