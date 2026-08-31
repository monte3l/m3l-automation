/**
 * Tests for `steps/gate-tool` — the security core of V8: the single door
 * through which every model-facing Bedrock tool handler must pass.
 *
 * The contract (see the wave 1 contract doc, section C):
 *
 * ```ts
 * export interface AgentToolExecution {
 *   readonly content: readonly AWS.M3LBedrockToolResultContent[];
 *   readonly outcome: Core.M3LAgentDecisionOutcome;
 * }
 * export interface AgentToolSpec {
 *   readonly name: string;
 *   readonly description: string;
 *   readonly inputSchema: Readonly<Record<string, unknown>>;
 *   describeAction(input: unknown): Core.M3LAgentAction;
 *   execute(
 *     input: unknown,
 *     context: AWS.M3LBedrockToolContext,
 *   ): Promise<AgentToolExecution>;
 * }
 * export interface GateToolDeps {
 *   readonly policy: Core.M3LAgentPolicy;
 *   readonly ledger: AgentRunLedger;
 *   readonly recorder: AgentDecisionRecorder;
 *   readonly now: () => number;
 *   readonly logger: Core.M3LLogger;
 *   readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
 * }
 * export function gateToolSpec(
 *   spec: AgentToolSpec,
 *   deps: GateToolDeps,
 * ): AWS.M3LBedrockToolRegistration;
 * export const AGENT_TOOL_REFUSAL_MESSAGES = {
 *   notAuthorized: "...",
 *   malformedInput: "...",
 *   auditUnavailable: "...",
 *   executionFailed: "...",
 * } as const;
 * ```
 *
 * The evaluator (`Core.evaluateAgentAction`) and validator-produced policies
 * (`tests/support/policyFixtures.ts`) are real throughout — never a
 * hand-built/cast decision. The one seam faked here is the
 * `AgentDecisionLogWriter` port (`tests/support/logFakes.ts`), so no real
 * file is written.
 *
 * Written RED, before `steps/gate-tool.ts` exists.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AgentDecisionRecorder,
  agentIdentity,
  type AgentDecisionLogWriter,
} from "../../src/steps/decision-recorder.js";
import {
  AGENT_TOOL_REFUSAL_MESSAGES,
  gateToolSpec,
  type AgentToolExecution,
  type AgentToolSpec,
  type GateToolDeps,
} from "../../src/steps/gate-tool.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import {
  FailingDecisionLogWriter,
  RecordingDecisionLogWriter,
  ScriptedDecisionLogWriter,
} from "../support/logFakes.js";
import { decisionLogPolicy, minimalPolicy } from "../support/policyFixtures.js";

/** A fixed, caller-sampled instant. */
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

/** Distinctive strings planted in a thrown error to prove no leak reaches the model. */
const SECRET_TOKEN = "token=abc123";
const SECRET_PATH = "/home/u/secret";

/** The `AWS.M3LBedrockToolContext` every handler call in this file uses. */
function toolContext(name: string): AWS.M3LBedrockToolContext {
  return { toolUseId: "tool-use-1", name };
}

/** A granted, allowlisted read-only action under {@link minimalPolicy}. */
function grantedReadOnlyAction(
  overrides: Partial<Core.M3LAgentAction> = {},
): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "explain-policy",
    kind: "read-only",
    ...overrides,
  };
}

/** An action whose operation `minimalPolicy` never granted — denied at step 2. */
function ungrantedAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "health-check",
    kind: "read-only",
  };
}

/** Builds an `AgentDecisionRecorder` over `writer`. */
function makeRecorder(writer: AgentDecisionLogWriter): AgentDecisionRecorder {
  return new AgentDecisionRecorder({
    identity: agentIdentity({ name: "agent-operator" }),
    writer,
  });
}

/**
 * Records every event handed to it, for assertion without pinning exact
 * prose — the same shape `tests/steps/explain-policy.test.ts` uses.
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

/** Flattens every recorded event's message + structured data into one searchable string. */
function flattenLoggedText(events: readonly Core.M3LLogEvent[]): string {
  return events
    .map((event) => `${event.message} ${JSON.stringify(event.data ?? {})}`)
    .join("\n");
}

/**
 * Builds a real `Core.M3LLogger` over a `RecordingLoggerHandler`, so a
 * refusal/failure path's "log the detail" half is observable.
 */
function createLogger(): {
  readonly logger: Core.M3LLogger;
  readonly handler: RecordingLoggerHandler;
} {
  const handler = new RecordingLoggerHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

/**
 * Wraps `ledger`'s `recordInvocation`/`observeDecisionLog` with spies that
 * push a labelled entry into the shared `calls` list and then delegate to
 * the real implementation — the same "spy on the injected collaborator,
 * keep ordering asserted rather than inferred" pattern
 * `tests/steps/preflight-log.test.ts` uses.
 */
function trackLedgerCalls(ledger: AgentRunLedger, calls: string[]): void {
  const originalRecordInvocation: () => void =
    ledger.recordInvocation.bind(ledger);
  vi.spyOn(ledger, "recordInvocation").mockImplementation(() => {
    calls.push("recordInvocation");
    originalRecordInvocation();
  });
  const originalObserve: (available: boolean) => void =
    ledger.observeDecisionLog.bind(ledger);
  vi.spyOn(ledger, "observeDecisionLog").mockImplementation(
    (available: boolean) => {
      calls.push(`observeDecisionLog:${String(available)}`);
      originalObserve(available);
    },
  );
}

/** Successful default execution: text content, a clean non-dry-run outcome. */
function okExecution(): AgentToolExecution {
  return {
    content: [{ type: "text", text: "ok" }],
    outcome: { dryRun: false, exitCode: 0 },
  };
}

interface TrackedSpecOptions {
  /** The shared ordering list `execute`/`describeAction` push onto. */
  readonly calls: string[];
  /** The fixed action `describeAction` returns, ignoring `input` — the
   * module's one trust boundary: `kind` never derives from model input. */
  readonly action: Core.M3LAgentAction;
  /** Overrides the default `describeAction`; used to exercise a throw. */
  readonly describeAction?: (input: unknown) => Core.M3LAgentAction;
  /** Overrides the default successful `execute`; used to exercise a throw. */
  readonly execute?: (
    input: unknown,
    context: AWS.M3LBedrockToolContext,
  ) => Promise<AgentToolExecution>;
}

/** Builds an `AgentToolSpec` whose `describeAction`/`execute` push onto `options.calls`. */
function trackedSpec(options: TrackedSpecOptions): AgentToolSpec {
  return {
    name: "sample_tool",
    description: "A sample gated tool, for tests only.",
    inputSchema: {},
    describeAction(input: unknown): Core.M3LAgentAction {
      if (options.describeAction !== undefined) {
        return options.describeAction(input);
      }
      return options.action;
    },
    async execute(
      input: unknown,
      context: AWS.M3LBedrockToolContext,
    ): Promise<AgentToolExecution> {
      options.calls.push("execute");
      if (options.execute !== undefined) {
        return options.execute(input, context);
      }
      return okExecution();
    },
  };
}

interface MakeDepsOptions {
  readonly policy: Core.M3LAgentPolicy;
  readonly ledger: AgentRunLedger;
  readonly writer: AgentDecisionLogWriter;
  readonly logger?: Core.M3LLogger;
  readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
}

/** Builds a `GateToolDeps` bag over a fixed clock reading `NOW`. */
function makeDeps(options: MakeDepsOptions): GateToolDeps {
  return {
    policy: options.policy,
    ledger: options.ledger,
    recorder: makeRecorder(options.writer),
    now: () => NOW,
    logger: options.logger ?? new Core.M3LLogger([]),
    reportRecovery: options.reportRecovery ?? vi.fn(),
  };
}

/** Runs `body` and returns whatever it threw, or `undefined` if it did not. */
async function captureRejection(
  body: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await body();
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateToolSpec — the gate-ordering matrix (one shared `calls` list)", () => {
  it("case 1: auto-approved records pre, counts the invocation, executes, then records post — in that exact order", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const spec = trackedSpec({ calls, action: grantedReadOnlyAction() });
    const deps = makeDeps({ policy: minimalPolicy(), ledger, writer });
    const registration = gateToolSpec(spec, deps);

    const content = await registration.handler(
      undefined,
      toolContext(spec.name),
    );

    expect(calls).toEqual(["record", "recordInvocation", "execute", "record"]);
    expect(writer.entries).toHaveLength(2);
    expect(writer.entries[0]?.verdict).toBe("auto-approved");
    expect(writer.entries[1]?.verdict).toBe("auto-approved");
    // The post-execution entry carries the outcome execute reported.
    expect(writer.entries[1]?.outcome).toEqual({ dryRun: false, exitCode: 0 });
    expect(content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("case 2: escalate records once, never invokes, never executes, and refuses with notAuthorized", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const reportRecovery = vi.fn();
    const { logger, handler: loggerHandler } = createLogger();
    // A fresh ledger has no `decisionLogAvailable` observation, so under a
    // policy that requires the audit log this escalates at step 3b —
    // without needing any budget to be declared.
    const spec = trackedSpec({
      calls,
      action: grantedReadOnlyAction({ operation: "health-check" }),
    });
    const deps = makeDeps({
      policy: decisionLogPolicy(),
      ledger,
      writer,
      logger,
      reportRecovery,
    });
    const registration = gateToolSpec(spec, deps);

    const content = await registration.handler(
      undefined,
      toolContext(spec.name),
    );

    expect(calls).toEqual(["record", "observeDecisionLog:true"]);
    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0]?.verdict).toBe("escalate");
    expect(writer.entries[0]?.rule).toBe(
      "decision-log-unavailable.unobservable",
    );
    expect(content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized },
    ]);
    // Every refusal demotes the run to "partial" — invisible to a scheduler
    // reading only `recoveryTotal` if this call is skipped.
    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(
      loggerHandler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ),
    ).toBe(true);
  });

  it("case 3: denied records once (the real verdict), never invokes, never executes", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const reportRecovery = vi.fn();
    const { logger, handler: loggerHandler } = createLogger();
    const spec = trackedSpec({ calls, action: ungrantedAction() });
    const deps = makeDeps({
      policy: minimalPolicy(),
      ledger,
      writer,
      logger,
      reportRecovery,
    });
    const registration = gateToolSpec(spec, deps);

    const content = await registration.handler(
      undefined,
      toolContext(spec.name),
    );

    expect(calls).toEqual(["record", "observeDecisionLog:true"]);
    expect(writer.entries).toHaveLength(1);
    // Same refusal text as escalate — but the LOG shows the real verdict.
    expect(writer.entries[0]?.verdict).toBe("denied");
    expect(writer.entries[0]?.rule).toBe("operation-not-allowlisted");
    expect(content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized },
    ]);
    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(
      loggerHandler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ),
    ).toBe(true);
  });

  it("case 4: a pre-record write failure refuses, never executes, and observes the log as unavailable — a second pass then reports decision-log-unavailable (the hard rule), not the unobservable one", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const failingWriter = new FailingDecisionLogWriter(
      new Core.M3LAgentDecisionLogWriteError(`append failed: ${SECRET_PATH}`),
      () => calls.push("record"),
    );
    const action = grantedReadOnlyAction({ operation: "health-check" });
    const spec = trackedSpec({ calls, action });
    const reportRecovery = vi.fn();
    const { logger, handler: loggerHandler } = createLogger();
    const deps = makeDeps({
      policy: decisionLogPolicy(),
      ledger,
      writer: failingWriter,
      logger,
      reportRecovery,
    });
    const registration = gateToolSpec(spec, deps);

    const content = await registration.handler(
      undefined,
      toolContext(spec.name),
    );

    // The write is attempted and observed as unavailable — never seeded,
    // never skipped — and NOTHING executes.
    expect(calls).toEqual(["record", "observeDecisionLog:false"]);
    expect(failingWriter.entries).toHaveLength(1);
    expect(content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.auditUnavailable },
    ]);
    // No writer-internal detail (a path in this case) reaches the model...
    const text = (content[0] as { text: string }).text;
    expect(text).not.toContain(SECRET_PATH);
    // ...but the LOGGER does receive it, and the refusal is reported as
    // recovered so a scheduler sees it without parsing the artifact.
    expect(flattenLoggedText(loggerHandler.events)).toContain(SECRET_PATH);
    expect(reportRecovery).toHaveBeenCalledTimes(1);

    // A genuine second pass, through the SAME gated handler and the SAME
    // ledger (now observing the log unavailable) but a writer that actually
    // works — proving the EVALUATED rule really changed, not merely that the
    // ledger flag flipped.
    const secondWriter = new RecordingDecisionLogWriter();
    const secondDeps = makeDeps({
      policy: decisionLogPolicy(),
      ledger,
      writer: secondWriter,
    });
    const secondRegistration = gateToolSpec(spec, secondDeps);

    const secondContent = await secondRegistration.handler(
      undefined,
      toolContext(spec.name),
    );

    expect(secondWriter.entries).toHaveLength(1);
    expect(secondWriter.entries[0]?.verdict).toBe("escalate");
    // The hard rule, never the unobservable one — a failed write is not the
    // same fact as never having looked.
    expect(secondWriter.entries[0]?.rule).toBe("decision-log-unavailable");
    expect(secondContent).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized },
    ]);
  });

  it("case 5: execute throwing writes an outcome record with exitCode omitted, then rethrows a vocabulary-only message", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const reportRecovery = vi.fn();
    const { logger, handler: loggerHandler } = createLogger();
    const secretError = new Error(`${SECRET_TOKEN} ${SECRET_PATH}`);
    const spec = trackedSpec({
      calls,
      action: grantedReadOnlyAction(),
      execute: () => Promise.reject(secretError),
    });
    const deps = makeDeps({
      policy: minimalPolicy(),
      ledger,
      writer,
      logger,
      reportRecovery,
    });
    const registration = gateToolSpec(spec, deps);

    const thrown = await captureRejection(() =>
      registration.handler(undefined, toolContext(spec.name)),
    );

    expect(calls).toEqual(["record", "recordInvocation", "execute", "record"]);
    expect(writer.entries).toHaveLength(2);
    const postEntry = writer.entries[1];
    expect(postEntry).toBeDefined();
    expect(Object.hasOwn(postEntry ?? {}, "outcome")).toBe(true);
    const outcome = postEntry?.outcome;
    expect(outcome).toBeDefined();
    expect(typeof outcome?.dryRun).toBe("boolean");
    // No exit code exists for a crashed action — never fabricate one.
    expect(Object.hasOwn(outcome ?? {}, "exitCode")).toBe(false);

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(Object.values(AGENT_TOOL_REFUSAL_MESSAGES)).toContain(message);
    // The split the whole security boundary rests on: the MODEL gets the
    // fixed vocabulary only...
    expect(message).not.toContain(SECRET_TOKEN);
    expect(message).not.toContain(SECRET_PATH);
    // ...while the LOGGER is defence in depth, not a bypass: the logging
    // layer's own `redactSensitiveLogText` redacts the token independently
    // of this module, so a path (legitimate diagnostic detail) survives
    // while the token does not — proving redaction fired, not merely that
    // the token happened to be absent.
    const loggedText = flattenLoggedText(loggerHandler.events);
    expect(loggedText).toContain(SECRET_PATH);
    expect(loggedText).not.toContain(SECRET_TOKEN);
    expect(loggedText).toContain("[REDACTED]");
    expect(reportRecovery).toHaveBeenCalledTimes(1);
  });

  it("case 6: a post-record write failure rethrows, because the action already ran", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const postFailure = new Core.M3LAgentDecisionLogWriteError(
      "append failed: ENOSPC",
    );
    const writer = new ScriptedDecisionLogWriter(["ok", postFailure], () =>
      calls.push("record"),
    );
    const reportRecovery = vi.fn();
    const spec = trackedSpec({ calls, action: grantedReadOnlyAction() });
    const deps = makeDeps({
      policy: minimalPolicy(),
      ledger,
      writer,
      reportRecovery,
    });
    const registration = gateToolSpec(spec, deps);

    const thrown = await captureRejection(() =>
      registration.handler(undefined, toolContext(spec.name)),
    );

    // The pre-record write succeeded, so the invocation and the execute both
    // ran — the failure surfaces only on the SECOND (post) write, and
    // nothing after it runs.
    expect(calls).toEqual([
      "record",
      "recordInvocation",
      "execute",
      "record",
      "observeDecisionLog:false",
    ]);
    expect(writer.entries).toHaveLength(2);
    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
    expect((thrown as M3LAgentOperatorCliError).cause).toBe(postFailure);
    expect(reportRecovery).toHaveBeenCalledTimes(1);
  });
});

describe("gateToolSpec — deps.now() is sampled once per pass", () => {
  it("reads the clock exactly once and reuses that instant for the evaluation and BOTH record() calls", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const spec = trackedSpec({ calls, action: grantedReadOnlyAction() });
    let nowCallCount = 0;
    const instant = NOW;
    const now = (): number => {
      nowCallCount += 1;
      return instant;
    };
    const deps: GateToolDeps = {
      policy: minimalPolicy(),
      ledger,
      recorder: makeRecorder(writer),
      now,
      logger: new Core.M3LLogger([]),
      reportRecovery: vi.fn(),
    };
    const registration = gateToolSpec(spec, deps);

    await registration.handler(undefined, toolContext(spec.name));

    // A second clock read would let a pass straddle a UTC-day boundary and
    // evaluate against one instant while logging another.
    expect(nowCallCount).toBe(1);
    expect(writer.entries).toHaveLength(2);
    const expectedTimestamp = new Date(instant).toISOString();
    expect(writer.entries[0]?.timestamp).toBe(expectedTimestamp);
    expect(writer.entries[1]?.timestamp).toBe(expectedTimestamp);
  });
});

describe("gateToolSpec — describeAction is the one trust boundary", () => {
  it("a throwing describeAction records nothing, never executes, and refuses with malformedInput", async () => {
    const calls: string[] = [];
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const reportRecovery = vi.fn();
    const { logger, handler: loggerHandler } = createLogger();
    const spec = trackedSpec({
      calls,
      action: grantedReadOnlyAction(),
      describeAction: () => {
        throw new Error(`malformed: ${SECRET_TOKEN}`);
      },
    });
    const deps = makeDeps({
      policy: minimalPolicy(),
      ledger: new AgentRunLedger(),
      writer,
      logger,
      reportRecovery,
    });
    const registration = gateToolSpec(spec, deps);

    const content = await registration.handler(
      { bad: "input" },
      toolContext(spec.name),
    );

    expect(calls).toEqual([]);
    expect(writer.entries).toHaveLength(0);
    expect(content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.malformedInput },
    ]);
    const text = (content[0] as { text: string }).text;
    expect(text).not.toContain(SECRET_TOKEN);
    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(
      loggerHandler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ),
    ).toBe(true);
  });
});

describe("gateToolSpec — Core.M3LOperationAbortedError is never converted", () => {
  it("passes the exact instance through, instanceof-intact, rather than a vocabulary message", async () => {
    const calls: string[] = [];
    const abort = new Core.M3LOperationAbortedError();
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const spec = trackedSpec({
      calls,
      action: grantedReadOnlyAction(),
      execute: () => Promise.reject(abort),
    });
    const deps = makeDeps({
      policy: minimalPolicy(),
      ledger: new AgentRunLedger(),
      writer,
    });
    const registration = gateToolSpec(spec, deps);

    const thrown = await captureRejection(() =>
      registration.handler(undefined, toolContext(spec.name)),
    );

    // Every ADR-0049 in-process caller narrows on `instanceof`, never on a
    // locally-invented code — a wrapped/replaced error here would make
    // Ctrl-C exit the wrong code on this one path.
    expect(thrown).toBe(abort);
    expect(thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
    // The outcome record for the crashed action was still written.
    expect(writer.entries).toHaveLength(2);
  });
});

describe("gateToolSpec — dry-run-first bookkeeping", () => {
  it("records the decision's own shapeKey as a completed dry-run shape only after a successful execute", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    const shapeKeySpy = vi.spyOn(ledger, "recordDryRunShape");
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const action = grantedReadOnlyAction({ dryRun: true });
    const spec = trackedSpec({ calls, action });
    const deps = makeDeps({ policy: minimalPolicy(), ledger, writer });
    const registration = gateToolSpec(spec, deps);

    await registration.handler(undefined, toolContext(spec.name));

    const expectedShapeKey = Core.agentActionShapeKey(action);
    expect(shapeKeySpy).toHaveBeenCalledTimes(1);
    expect(shapeKeySpy).toHaveBeenCalledWith(expectedShapeKey);
    expect(ledger.snapshot(NOW).dryRunCompletedShapes).toContain(
      expectedShapeKey,
    );
  });

  it("never records a shape when the action is refused", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    const shapeKeySpy = vi.spyOn(ledger, "recordDryRunShape");
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const action = ungrantedAction();
    const spec = trackedSpec({ calls, action: { ...action, dryRun: true } });
    const deps = makeDeps({ policy: minimalPolicy(), ledger, writer });
    const registration = gateToolSpec(spec, deps);

    await registration.handler(undefined, toolContext(spec.name));

    expect(shapeKeySpy).not.toHaveBeenCalled();
  });
});

describe("AGENT_TOOL_REFUSAL_MESSAGES — a closed, exhaustively-reachable vocabulary", () => {
  it("declares exactly the four documented keys", () => {
    // A drift guard: a fifth channel silently added here would ship a
    // refusal path this test file's enumeration below does not cover.
    expect(Object.keys(AGENT_TOOL_REFUSAL_MESSAGES).sort()).toEqual([
      "auditUnavailable",
      "executionFailed",
      "malformedInput",
      "notAuthorized",
    ]);
  });

  it("every value is a distinct, non-blank string", () => {
    const values: string[] = Object.values(AGENT_TOOL_REFUSAL_MESSAGES);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
