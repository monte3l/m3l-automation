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
  gateTwoPhaseToolSpec,
  type AgentToolExecution,
  type AgentToolSpec,
  type GateToolDeps,
} from "../../src/steps/gate-tool.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import {
  FailingDecisionLogWriter,
  RecordingDecisionLogWriter,
  ScriptedDecisionLogWriter,
  type DecisionLogWriteOutcome,
} from "../support/logFakes.js";
import { decisionLogPolicy, minimalPolicy } from "../support/policyFixtures.js";

/** A fixed, caller-sampled instant. */
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

/** Distinctive strings planted in a thrown error to prove no leak reaches the model. */
const SECRET_TOKEN = "token=abc123";
const SECRET_PATH = "/home/u/secret";

/**
 * The `AWS.M3LBedrockToolContext` every handler call in this file uses.
 *
 * `signal` is genuinely ABSENT unless one is supplied — never assigned
 * `undefined` — matching the library's "presence, not value" contract for the
 * optional field (`M3LBedrockToolContext.signal` is omitted when the caller
 * supplied none).
 */
function toolContext(
  name: string,
  signal?: AbortSignal,
): AWS.M3LBedrockToolContext {
  if (signal === undefined) return { toolUseId: "tool-use-1", name };
  return { toolUseId: "tool-use-1", name, signal };
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
 * The ERROR event `logDryRunCreditWithheld` writes, found by the one phrase
 * every withheld-credit line carries.
 *
 * Throws rather than returning `undefined`: a row that asserts WHICH reason
 * the withhold names must fail loudly when no such line was written at all,
 * never pass a negative assertion against a missing event.
 */
function withheldCreditEvent(
  events: readonly Core.M3LLogEvent[],
): Core.M3LLogEvent {
  const event = events.find(
    (candidate) =>
      candidate.category === Core.M3LLogEventCategory.ERROR &&
      candidate.message.includes("dry-run-first credit"),
  );
  if (event === undefined) {
    throw new Error(
      "no ERROR event reporting a withheld dry-run-first credit was logged",
    );
  }
  return event;
}

/**
 * The structured data an event MUST carry, asserted present rather than
 * defaulted — a `?? {}` fallback would let a blanked detail pass every
 * `Object.hasOwn` row below.
 */
function eventData(event: Core.M3LLogEvent): Record<string, unknown> {
  const data = event.data;
  if (data === undefined) {
    throw new Error("the log event carried no structured data to assert on");
  }
  return data;
}

/**
 * The detail string a recovery entry carries, asserted present rather than
 * defaulted, for the same reason as {@link eventData}.
 */
function recoveryDetail(entry: Core.M3LRunRecoveryEntry): string {
  const level = entry.error[0];
  if (level === undefined) {
    throw new Error("the recovery entry carried no serialized error chain");
  }
  return level.message;
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

/**
 * Successful DRY-RUN execution: text content, and an outcome that honestly
 * reports what a dry run did — `dryRun: true` on a clean exit.
 *
 * Kept separate from {@link okExecution} rather than changing that default:
 * every other spec in this file drives a NON-dry-run action, for which
 * `dryRun: false` is the honest self-report. A dry-run-shape credit is minted
 * only from an outcome that reports BOTH halves, so a dry-run action paired
 * with `okExecution` is a self-contradictory fixture (the action declares a
 * plan, the producer denies making one) and correctly earns no credit.
 */
function okDryRunExecution(): AgentToolExecution {
  return {
    content: [{ type: "text", text: "ok" }],
    outcome: { dryRun: true, exitCode: 0 },
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

describe("gateToolSpec — a double failure: execute() throws AND the post-execution audit write also fails", () => {
  // Regression guard for a defect found in PR #787 review:
  // `recordExecutionFailure` used to await `deps.recorder.record(...)` with
  // no try/catch, unlike its sibling `recordSuccessOutcome`. When that
  // post-execution write ALSO fails, the recorder's own wrapped error would
  // propagate out of the `catch` block in `runApprovedExecution` uncaught —
  // discarding the original `execute()` failure (the one whose
  // classification drives the exit code per ADR-0049), skipping
  // `logFailure` (so `reportRecovery`/`logger.error` never fired for the
  // execute failure), and skipping `ledger.observeDecisionLog(false)`.
  //
  // The invariant these two tests protect: the execute failure is primary
  // and must be what gets thrown/passed-through; the audit-write failure
  // must be reported loudly (logger + reportRecovery +
  // observeDecisionLog(false)) but must never become the thrown value.

  it("an abort during execute() survives a failing post-execution write and still surfaces as M3LOperationAbortedError", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const abort = new Core.M3LOperationAbortedError();
    const postFailure = new Core.M3LAgentDecisionLogWriteError(
      "append failed: ENOSPC",
    );
    // Pre-execution write succeeds ("ok"), so execute() is reached; the
    // post-execution write then fails.
    const writer = new ScriptedDecisionLogWriter(["ok", postFailure], () =>
      calls.push("record"),
    );
    const reportRecovery = vi.fn();
    const { logger, handler: loggerHandler } = createLogger();
    const spec = trackedSpec({
      calls,
      action: grantedReadOnlyAction(),
      execute: () => Promise.reject(abort),
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

    // The abort must pass through instanceof-intact — ADR-0049 classifies it
    // by instanceof, so surfacing the recorder's own error here would
    // misclassify a Ctrl-C as an ordinary failure (exit code 1 instead of 5).
    expect(thrown).toBe(abort);
    expect(thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
    expect(thrown).not.toBeInstanceOf(M3LAgentOperatorCliError);

    // The audit-write failure is reported loudly through all three channels,
    // even though it never becomes the thrown value.
    expect(reportRecovery).toHaveBeenCalled();
    expect(calls).toContain("observeDecisionLog:false");
    expect(flattenLoggedText(loggerHandler.events)).toContain("ENOSPC");
    expect(
      loggerHandler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ),
    ).toBe(true);
  });

  it("an ordinary execute() failure survives a failing post-execution write and still surfaces as ERR_AGENT_TOOL_EXECUTION with the original cause", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const executeError = new Error("boom");
    const postFailure = new Core.M3LAgentDecisionLogWriteError(
      "append failed: ENOSPC",
    );
    const writer = new ScriptedDecisionLogWriter(["ok", postFailure], () =>
      calls.push("record"),
    );
    const reportRecovery = vi.fn();
    const { logger } = createLogger();
    const spec = trackedSpec({
      calls,
      action: grantedReadOnlyAction(),
      execute: () => Promise.reject(executeError),
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

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const thrownError = thrown as Core.M3LError;
    expect(thrownError.message).toBe(
      AGENT_TOOL_REFUSAL_MESSAGES.executionFailed,
    );
    expect(thrownError.code).toBe("ERR_AGENT_TOOL_EXECUTION");
    // The original execute() failure is the one reachable via `cause` — NOT
    // the recorder's own decision-log error.
    expect(thrownError.cause).toBe(executeError);
    expect(thrownError.cause).not.toBe(postFailure);

    expect(reportRecovery).toHaveBeenCalled();
    expect(calls).toContain("observeDecisionLog:false");
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
    // An HONEST dry-run producer: the action declares a dry run and the
    // outcome reports one. The credit is minted from what the producer says
    // it DID, so the default `okExecution` (`dryRun: false`) would contradict
    // the action and correctly withhold the credit — see the sibling row
    // below, which pins exactly that.
    const spec = trackedSpec({
      calls,
      action,
      execute: () => Promise.resolve(okDryRunExecution()),
    });
    const deps = makeDeps({ policy: minimalPolicy(), ledger, writer });
    const registration = gateToolSpec(spec, deps);

    await registration.handler(undefined, toolContext(spec.name));

    const expectedShapeKey = Core.agentActionShapeKey(action);
    expect(calls).toContain("execute");
    expect(shapeKeySpy).toHaveBeenCalledTimes(1);
    expect(shapeKeySpy).toHaveBeenCalledWith(expectedShapeKey);
    expect(ledger.snapshot(NOW).dryRunCompletedShapes).toContain(
      expectedShapeKey,
    );
  });

  it("withholds the credit when the action declares a dry run but the outcome reports dryRun:false on a clean exit — and reports the withheld credit", async () => {
    // The exact fixture that used to pass silently: a `dryRun: true` action
    // whose producer reports `{ dryRun: false, exitCode: 0 }`. `exitCode`
    // alone cannot tell that apart from a real dry run, and the credit it
    // would mint is what satisfies a later `dryRunFirst` precondition — so a
    // real run would authorize the next real run. The single-phase twin of
    // "case H" on the two-phase path.
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    const shapeKeySpy = vi.spyOn(ledger, "recordDryRunShape");
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const { logger, handler: loggerHandler } = createLogger();
    const action = grantedReadOnlyAction({ dryRun: true });
    const spec = trackedSpec({
      calls,
      action,
      execute: () => Promise.resolve(okExecution()),
    });
    const deps = makeDeps({
      policy: minimalPolicy(),
      ledger,
      writer,
      logger,
    });
    const registration = gateToolSpec(spec, deps);

    const content = await registration.handler(
      undefined,
      toolContext(spec.name),
    );

    // Vacuous-pass protection: the credit was withheld by the OUTCOME check,
    // not by never reaching the execution at all.
    expect(calls).toContain("execute");
    expect(shapeKeySpy).not.toHaveBeenCalled();
    expect(ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      Core.agentActionShapeKey(action),
    );
    // Withholding the credit is not a failure: the call still resolves with
    // the spec's content and still writes the post-execution audit record.
    expect(content).toEqual([{ type: "text", text: "ok" }]);
    expect(writer.entries).toHaveLength(2);
    expect(writer.entries[1]?.outcome).toEqual({ dryRun: false, exitCode: 0 });
    // ...and the withheld credit is reported, so an operator can correlate a
    // later dry-run-first escalation with the run that failed to earn it.
    expect(flattenLoggedText(loggerHandler.events)).toContain(
      "dry-run-first credit",
    );
    expect(
      loggerHandler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ),
    ).toBe(true);
    // WHICH of the two withhold reasons — the substring above is satisfied by
    // either, so collapsing both messages into one string passes it. This
    // producer reported `dryRun: false`, so the reason is the mislabelling,
    // NOT the exit code (which was a clean 0).
    const withheld = withheldCreditEvent(loggerHandler.events);
    expect(withheld.message).toContain("did not report a dry run");
    expect(withheld.message).not.toContain("did not prove a clean exit");
    // The reported detail carries the two judged fields themselves, so an
    // operator can tell an absent field from a present-but-wrong one — a
    // blanked detail would leave only the headline.
    const withheldData = eventData(withheld);
    expect(Object.hasOwn(withheldData, "dryRun")).toBe(true);
    expect(Object.hasOwn(withheldData, "exitCode")).toBe(true);
    expect(withheldData["dryRun"]).toBe(false);
    expect(withheldData["exitCode"]).toBe(0);
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

describe("gateToolSpec — dry-run shape recording requires a clean exit (fail closed)", () => {
  // Pins the fix for a defect where `runApprovedExecution` recorded the
  // dry-run shape whenever `spec.execute` merely RESOLVED, regardless of the
  // reported outcome — so a dry run that resolved with `exitCode: 1` (or any
  // non-zero code, or no exit code at all) still satisfied the policy's
  // `dryRunFirst` precondition. The shape must be recorded only when
  // `outcome.exitCode` is an OWN property equal to `0`; every other resolved
  // outcome must withhold the credit WITHOUT turning the call into a
  // failure — the handler still resolves, still returns content, and still
  // writes the post-execution audit record.

  /**
   * Runs a granted, read-only, dry-run action through the gate — read-only
   * so it is auto-approved without ADR-0048 target grading, isolating the
   * recording condition from policy grading — with `outcome` as exactly
   * what `execute` reports, and returns everything a row needs to assert
   * against.
   */
  async function runDryRunAction(
    outcome: Core.M3LAgentDecisionOutcome,
  ): Promise<{
    readonly ledger: AgentRunLedger;
    readonly expectedShapeKey: string;
    readonly calls: string[];
    readonly writer: RecordingDecisionLogWriter;
    readonly content: readonly AWS.M3LBedrockToolResultContent[];
  }> {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const action = grantedReadOnlyAction({ dryRun: true });
    const spec = trackedSpec({
      calls,
      action,
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          outcome,
        }),
    });
    const deps = makeDeps({ policy: minimalPolicy(), ledger, writer });
    const registration = gateToolSpec(spec, deps);

    const content = await registration.handler(
      undefined,
      toolContext(spec.name),
    );

    return {
      ledger,
      expectedShapeKey: Core.agentActionShapeKey(action),
      calls,
      writer,
      content,
    };
  }

  it("row 1: exitCode 0 records the shape — regression lock on the good path (must pass before and after the fix)", async () => {
    const { ledger, expectedShapeKey } = await runDryRunAction({
      dryRun: true,
      exitCode: 0,
    });

    expect(ledger.snapshot(NOW).dryRunCompletedShapes).toContain(
      expectedShapeKey,
    );
  });

  it("row 2: exitCode 1 does NOT record the shape — a failed dry run must never satisfy dryRunFirst", async () => {
    const { ledger, expectedShapeKey } = await runDryRunAction({
      dryRun: true,
      exitCode: 1,
    });

    expect(ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      expectedShapeKey,
    );
  });

  it("row 3: exitCode 42 does NOT record the shape", async () => {
    const { ledger, expectedShapeKey } = await runDryRunAction({
      dryRun: true,
      exitCode: 42,
    });

    expect(ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      expectedShapeKey,
    );
  });

  it("row 4: an outcome that OMITS exitCode entirely does NOT record the shape — fail closed on an absent optional field", async () => {
    // `exitCode` is declared optional on `M3LAgentDecisionOutcome`. Built so
    // the key is genuinely absent — never assigned `undefined` — to match
    // the library-wide "presence, not value" contract for optional fields.
    const outcome: Core.M3LAgentDecisionOutcome = { dryRun: true };
    expect(Object.hasOwn(outcome, "exitCode")).toBe(false);

    const { ledger, expectedShapeKey, calls } = await runDryRunAction(outcome);

    // Vacuous-pass protection: without this, a future change that stopped
    // reaching `spec.execute` at all would still pass this row on the
    // absence of a shape alone.
    expect(calls).toContain("execute");
    expect(ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      expectedShapeKey,
    );
  });

  it("row 5: exitCode 1 still resolves, still returns the spec's content, and still writes the post-execution audit record — withholding the shape credit never breaks the call", async () => {
    const { ledger, expectedShapeKey, calls, writer, content } =
      await runDryRunAction({
        dryRun: true,
        exitCode: 1,
      });

    expect(calls).toEqual(["record", "recordInvocation", "execute", "record"]);
    expect(writer.entries).toHaveLength(2);
    expect(writer.entries[1]?.outcome).toEqual({ dryRun: true, exitCode: 1 });
    expect(content).toEqual([{ type: "text", text: "ok" }]);
    // Distinguishing withheld from granted: the assertions above only show
    // the call resolved cleanly, not that the shape credit was withheld.
    expect(ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      expectedShapeKey,
    );
  });

  it("row 6: an inherited Object.prototype.exitCode must not count as own — pins Object.hasOwn, not `in`/property-access", async () => {
    const priorDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "exitCode",
    );
    // Poison every plain object's prototype chain with a clean-exit-shaped
    // `exitCode` — anything that reads `outcome.exitCode` or uses `in`
    // instead of `Object.hasOwn` would see `0` here even though `outcome`
    // itself never declared the key.
    Object.defineProperty(Object.prototype, "exitCode", {
      value: 0,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      const outcome: Core.M3LAgentDecisionOutcome = { dryRun: true };
      // Sanity check that the poison is actually live and `outcome` itself
      // still has no own `exitCode` — otherwise this test would prove
      // nothing about `Object.hasOwn` vs. plain property access.
      expect((outcome as { exitCode?: number }).exitCode).toBe(0);
      expect(Object.hasOwn(outcome, "exitCode")).toBe(false);

      const { ledger, expectedShapeKey, calls } =
        await runDryRunAction(outcome);

      // Vacuous-pass protection: proves the poisoned prototype didn't also
      // short-circuit the call before reaching `spec.execute`.
      expect(calls).toContain("execute");
      expect(ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
        expectedShapeKey,
      );
    } finally {
      if (priorDescriptor === undefined) {
        delete (Object.prototype as { exitCode?: number }).exitCode;
      } else {
        Object.defineProperty(Object.prototype, "exitCode", priorDescriptor);
      }
    }
  });

  it("row 7: an action without dryRun true is never recorded, even with exitCode 0 — regression lock", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    const shapeKeySpy = vi.spyOn(ledger, "recordDryRunShape");
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const action = grantedReadOnlyAction();
    const spec = trackedSpec({
      calls,
      action,
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          outcome: { dryRun: false, exitCode: 0 },
        }),
    });
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

/*
 * ---------------------------------------------------------------------------
 * V9 slice 2b — the two-phase gate.
 *
 * Written RED, before `GatedPassResult` and `gateTwoPhaseToolSpec` exist in
 * `src/steps/gate-tool.ts`. The contract under test:
 *
 * - The internal gated pass returns a DISCRIMINATED result (refused vs.
 *   passed) so a two-phase caller can stop after a refused phase 1. The
 *   public `gateToolSpec` behaviour is unchanged — its handler still returns
 *   model-facing content either way (pinned below as a regression guard).
 * - `gateTwoPhaseToolSpec(spec, deps)` calls `spec.describeAction(input)`
 *   ONCE, derives phase 1 as `{ ...action, dryRun: true }` and phase 2 as
 *   `{ ...action, dryRun: false }` — identical shape keys by construction,
 *   never two independent descriptions — and calls
 *   `spec.execute(input, context, { dryRun })` once per phase, each behind a
 *   full gated pass. A refused phase 1 stops the run.
 * ---------------------------------------------------------------------------
 */

/**
 * The per-phase flag the two-phase wrapper hands `execute` as its third
 * argument.
 */
interface TwoPhaseExecuteFlag {
  /** `true` for phase 1 (the dry run), `false` for phase 2 (the mutation). */
  readonly dryRun: boolean;
}

/**
 * The spec shape `gateTwoPhaseToolSpec` accepts, declared here STRUCTURALLY
 * rather than imported by name.
 *
 * The maintainer fixed the shape — an `AgentToolSpec` whose `execute` takes
 * the phase flag as a third argument — but not the interface's name, so
 * pinning a name here would force one. Structural assignability is what the
 * call site actually needs, and it keeps the implementer free to name (or
 * derive) the interface however the module reads best.
 */
interface TwoPhaseToolSpecShape {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  describeAction(input: unknown): Core.M3LAgentAction;
  execute(
    input: unknown,
    context: AWS.M3LBedrockToolContext,
    phase: TwoPhaseExecuteFlag,
  ): Promise<AgentToolExecution>;
}

/** The name every two-phase run in this file registers under. */
const TWO_PHASE_TOOL_NAME = "sample_two_phase_tool";

/** Distinct per-phase content, so the RETURNED content names its own phase. */
const DRY_RUN_TEXT = "dry-run ok";
const MUTATION_TEXT = "mutation applied";

/**
 * A granted, ADR-0048-graded, NON-sensitive mutating action — the only shape
 * that can reach step 7's `graded-mutation-auto-approved`, and therefore the
 * only shape whose phase 2 can be gated by step 6's `dry-run-first`. Carries
 * no `dryRun` of its own: the wrapper derives both phases from it.
 */
function gradedMutatingAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "put-item",
    kind: "mutating",
    target: { profile: "sandbox", region: "eu-central-1" },
    parameterNames: ["table"],
  };
}

/**
 * A validator-produced policy that allowlists {@link gradedMutatingAction}
 * and grades `prod` sensitive (so the `sandbox` target grades down), with
 * `dryRunFirst` opted in or out.
 *
 * Deliberately declares NO budgets and NO `requireDecisionLog`: both sit
 * above step 6 in the evaluator and every arm is terminal, so either one
 * would escalate a fresh ledger on its own `.unobservable` rule and the
 * dry-run-first arm this file exists to exercise would never be reached.
 */
function twoPhasePolicy(dryRunFirst: boolean): Core.M3LAgentPolicy {
  return Core.validateAgentPolicy({
    version: 1,
    scripts: [{ script: "agent-operator", operations: ["put-item"] }],
    sensitiveTargets: { profiles: ["prod"] },
    ...(dryRunFirst ? { dryRunFirst: true } : {}),
  });
}

/** The default per-phase execution: distinct content, a clean reported exit. */
function twoPhaseExecution(phase: TwoPhaseExecuteFlag): AgentToolExecution {
  return {
    content: [
      { type: "text", text: phase.dryRun ? DRY_RUN_TEXT : MUTATION_TEXT },
    ],
    outcome: { dryRun: phase.dryRun, exitCode: 0 },
  };
}

/** Everything a two-phase case asserts against. */
interface TwoPhaseRunResult {
  /** The real ledger both phases shared. */
  readonly ledger: AgentRunLedger;
  /** Every decision-log entry written, in order. */
  readonly entries: readonly Core.M3LAgentDecisionLogEntry[];
  /** The shared ordering list (`record`/`recordInvocation`/`execute`/...). */
  readonly calls: string[];
  /** The phase flag handed to `execute`, once per actual call. */
  readonly executePhases: TwoPhaseExecuteFlag[];
  /** One entry per `describeAction` call — length is the call count. */
  readonly describeActionInputs: unknown[];
  /**
   * Whatever the wrapper's handler returned to the model — an EMPTY array
   * when the handler rejected instead (see {@link TwoPhaseRunResult.thrown}).
   */
  readonly content: readonly AWS.M3LBedrockToolResultContent[];
  /**
   * Whatever the handler rejected with, or `undefined` when it resolved. The
   * wrapper is allowed to reject (an abort between the phases, an `execute`
   * that rejected), and a rejection must be assertable rather than failing
   * the driver itself.
   */
  readonly thrown: unknown;
  /**
   * The recording handler behind the injected `Core.M3LLogger` — the ONLY
   * channel a withheld dry-run-first credit is reported on
   * (`logDryRunCreditWithheld` deliberately never calls `reportRecovery`),
   * so without this the credit decision is unobservable.
   */
  readonly loggerHandler: RecordingLoggerHandler;
  /** Every entry handed to the injected `reportRecovery`, in call order. */
  readonly recoveryEntries: readonly Core.M3LRunRecoveryEntry[];
}

/**
 * Drives one two-phase gated call through the injected deps the rest of this
 * file already uses (real ledger, real evaluator, real validator-produced
 * policy; only the decision-log writer is faked).
 */
async function runTwoPhaseTool(options: {
  readonly policy: Core.M3LAgentPolicy;
  /** FIFO write outcomes; an empty queue resolves every write. */
  readonly writeOutcomes?: readonly DecisionLogWriteOutcome[];
  /**
   * Per-phase execution. May return a REJECTED promise, so the wrapper's own
   * execute-failure paths are drivable through this one harness.
   */
  readonly execute?: (
    phase: TwoPhaseExecuteFlag,
  ) => AgentToolExecution | Promise<AgentToolExecution>;
  /** Overrides the default `describeAction`; used to exercise a throw. */
  readonly describeAction?: (input: unknown) => Core.M3LAgentAction;
  /**
   * Called after each decision-log write lands. Lets a row flip a fixture at
   * an OBSERVABLE point in the run — write 1 and 2 are phase 1's pre/post
   * records, write 3 is phase 2's pre-decision entry — rather than after a
   * guessed number of property reads, which would pin how often the current
   * implementation happens to read a field.
   */
  readonly onWrite?: () => void;
  /**
   * Instruments/seeds the real ledger before either phase runs — e.g. filling
   * it to the library's per-run dry-run-shape ceiling so the credit attempt
   * throws for real.
   */
  readonly prepareLedger?: (ledger: AgentRunLedger) => void;
  /** Forwarded onto the tool context the wrapper hands both phases. */
  readonly signal?: AbortSignal;
}): Promise<TwoPhaseRunResult> {
  const calls: string[] = [];
  const executePhases: TwoPhaseExecuteFlag[] = [];
  const describeActionInputs: unknown[] = [];
  const ledger = new AgentRunLedger();
  trackLedgerCalls(ledger, calls);
  options.prepareLedger?.(ledger);
  const writer = new ScriptedDecisionLogWriter(
    options.writeOutcomes ?? [],
    () => {
      calls.push("record");
      options.onWrite?.();
    },
  );
  const action = gradedMutatingAction();
  const spec: TwoPhaseToolSpecShape = {
    name: TWO_PHASE_TOOL_NAME,
    description: "A sample two-phase gated tool, for tests only.",
    inputSchema: {},
    describeAction(input: unknown): Core.M3LAgentAction {
      describeActionInputs.push(input);
      if (options.describeAction !== undefined) {
        return options.describeAction(input);
      }
      return action;
    },
    execute(
      _input: unknown,
      _context: AWS.M3LBedrockToolContext,
      phase: TwoPhaseExecuteFlag,
    ): Promise<AgentToolExecution> {
      calls.push("execute");
      executePhases.push(phase);
      return Promise.resolve((options.execute ?? twoPhaseExecution)(phase));
    },
  };
  // A real logger over a recording handler and a real recovery sink: the two
  // channels every refusal/withheld-credit decision reports on. Injected on
  // EVERY two-phase run, not only the cases that assert on them, so no
  // scenario can quietly become unobservable.
  const { logger, handler: loggerHandler } = createLogger();
  const recoveryEntries: Core.M3LRunRecoveryEntry[] = [];
  const deps = makeDeps({
    policy: options.policy,
    ledger,
    writer,
    logger,
    reportRecovery: (entry: Core.M3LRunRecoveryEntry) => {
      recoveryEntries.push(entry);
    },
  });
  const registration = gateTwoPhaseToolSpec(spec, deps);

  let content: readonly AWS.M3LBedrockToolResultContent[] = [];
  let thrown: unknown;
  try {
    content = await registration.handler(
      undefined,
      toolContext(spec.name, options.signal),
    );
  } catch (error) {
    thrown = error;
  }

  return {
    ledger,
    entries: writer.entries,
    calls,
    executePhases,
    describeActionInputs,
    content,
    thrown,
    loggerHandler,
    recoveryEntries,
  };
}

/**
 * Phase 1's pre-decision entry's `shapeKey`, asserted present rather than
 * defaulted.
 *
 * A `?? ""` fallback lets a `not.toContain(shapeKey)` row pass on a MISSING
 * entry — the empty string is in no ledger — which is the opposite of what
 * those rows claim to prove. Throwing here fails the row loudly instead.
 */
function phaseOneShapeKey(result: TwoPhaseRunResult): string {
  const shapeKey = result.entries[0]?.shapeKey;
  if (typeof shapeKey !== "string" || shapeKey.length === 0) {
    throw new Error(
      "phase 1 wrote no decision-log entry carrying a shapeKey to assert against",
    );
  }
  return shapeKey;
}

/** The `text` of the single content block a refusal hands the model. */
function soleContentText(
  content: readonly AWS.M3LBedrockToolResultContent[],
): string {
  expect(content).toHaveLength(1);
  return (content[0] as { text: string }).text;
}

describe("gateToolSpec — the public handler shape survives the GatedPassResult refactor", () => {
  // A REGRESSION LOCK, not a proof: both assertions already hold today, since
  // `runGatedTool` returns content for a refusal and a success alike. Slice
  // 2b makes that internal pass return a discriminated result so a two-phase
  // caller can tell the two apart — this pins that the DISCRIMINANT stays
  // internal and the public handler keeps handing the model plain content
  // blocks. Once slice 2b lands, confirm it still discriminates: leaking the
  // result envelope out of `handler` must fail this test.

  it("still returns model-facing content blocks — never a result envelope — for BOTH a refused and an approved pass", async () => {
    const calls: string[] = [];
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const approved = await gateToolSpec(
      trackedSpec({ calls, action: grantedReadOnlyAction() }),
      makeDeps({
        policy: minimalPolicy(),
        ledger: new AgentRunLedger(),
        writer,
      }),
    ).handler(undefined, toolContext("sample_tool"));

    const refusalWriter = new RecordingDecisionLogWriter();
    const refused = await gateToolSpec(
      trackedSpec({ calls, action: ungrantedAction() }),
      makeDeps({
        policy: minimalPolicy(),
        ledger: new AgentRunLedger(),
        writer: refusalWriter,
      }),
    ).handler(undefined, toolContext("sample_tool"));

    expect(approved).toEqual([{ type: "text", text: "ok" }]);
    expect(refused).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized },
    ]);
    // A result envelope would be a single object, not an array of blocks, and
    // would carry the pass's own discriminant. That discriminant is `kind`
    // (`{ kind: "refused", content: [...] }`) — an earlier form of this
    // assertion probed a `"refused"` KEY, which the leak it names does not
    // have, so it passed against exactly the shape it claimed to catch.
    expect(Array.isArray(refused)).toBe(true);
    expect(Object.hasOwn(refused, "kind")).toBe(false);
    expect(Object.hasOwn(refused, "content")).toBe(false);

    // In-band discrimination proof: the exact envelope a leak would produce
    // trips the repaired predicates, and slips past the one they replace.
    const leakedEnvelope: {
      readonly kind: string;
      readonly content: readonly AWS.M3LBedrockToolResultContent[];
    } = { kind: "refused", content: refused };
    expect(Array.isArray(leakedEnvelope)).toBe(false);
    expect(Object.hasOwn(leakedEnvelope, "kind")).toBe(true);
    expect(Object.hasOwn(leakedEnvelope, "content")).toBe(true);
    // ...while the assertion this repairs could never have caught it.
    expect(Object.hasOwn(leakedEnvelope, "refused")).toBe(false);
  });
});

describe("gateTwoPhaseToolSpec — phase ordering and the phase-1 stop", () => {
  it("case A: a refused phase 1 never executes and never starts phase 2", async () => {
    // The refusal is a FAILING FIRST decision-log write (auditUnavailable),
    // chosen because it discriminates: a policy refusal would refuse phase 2
    // identically, so a wrapper that wrongly ran both phases would still show
    // zero executions and pass vacuously. Here the queue fails only the FIRST
    // write — so if phase 2 wrongly ran, its own pre-record write would
    // succeed, the action would be auto-approved, `execute` would fire once
    // and THREE entries would exist. One entry and zero executions is
    // therefore a real stop.
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      writeOutcomes: [
        new Core.M3LAgentDecisionLogWriteError("append failed: EACCES"),
      ],
    });

    expect(result.executePhases).toEqual([]);
    expect(result.calls).not.toContain("execute");
    expect(result.entries).toHaveLength(1);
    expect(result.describeActionInputs).toHaveLength(1);
    expect(result.content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.auditUnavailable },
    ]);
  });

  it("case B: a passing phase 1 executes twice — dryRun true, then dryRun false", async () => {
    const result = await runTwoPhaseTool({ policy: twoPhasePolicy(false) });

    expect(result.executePhases).toEqual([{ dryRun: true }, { dryRun: false }]);
    // Each phase is a FULL gated pass, not a bare execute: pre-record,
    // invocation, execute, post-record — twice, in that order.
    expect(result.calls).toEqual([
      "record",
      "recordInvocation",
      "execute",
      "record",
      "record",
      "recordInvocation",
      "execute",
      "record",
    ]);
    expect(result.entries).toHaveLength(4);
    // Phase 2's content is what the model gets back.
    expect(result.content).toEqual([{ type: "text", text: MUTATION_TEXT }]);
  });

  it("describes the action exactly once — both phases derive from that one description", async () => {
    const result = await runTwoPhaseTool({ policy: twoPhasePolicy(false) });

    // Describing each phase separately would make the two shape keys a
    // coincidence rather than a guarantee; one description is what makes
    // "identical shape keys" structural.
    expect(result.describeActionInputs).toHaveLength(1);
    expect(result.executePhases).toHaveLength(2);
  });

  it("case C: both phases record the SAME shapeKey in the decision log", async () => {
    const result = await runTwoPhaseTool({ policy: twoPhasePolicy(false) });

    // Read off the LOG, never recomputed here from the same inputs — a
    // re-derivation would agree with itself no matter what the wrapper did.
    const phaseOnePre = result.entries[0];
    const phaseTwoPre = result.entries[2];
    expect(phaseOnePre).toBeDefined();
    expect(phaseTwoPre).toBeDefined();
    // Anchors the indices to the phases they claim to be, so the equality
    // below cannot be comparing one phase's two entries with each other.
    expect(result.entries[1]?.outcome?.dryRun).toBe(true);
    expect(result.entries[3]?.outcome?.dryRun).toBe(false);
    expect(phaseOnePre?.shapeKey).toEqual(expect.any(String));
    expect((phaseOnePre?.shapeKey ?? "").length).toBeGreaterThan(0);
    expect(phaseTwoPre?.shapeKey).toBe(phaseOnePre?.shapeKey);
  });
});

describe("gateTwoPhaseToolSpec — the dry-run-first credit, end to end", () => {
  it("case D: a clean phase-1 dry run credits the shape and phase 2 is auto-approved as graded-mutation-auto-approved", async () => {
    const result = await runTwoPhaseTool({ policy: twoPhasePolicy(true) });

    expect(result.executePhases).toEqual([{ dryRun: true }, { dryRun: false }]);
    expect(result.entries).toHaveLength(4);
    const shapeKey = phaseOneShapeKey(result);
    // The credit the whole two-phase design exists to mint — read off the
    // ledger, keyed by what the LOG says phase 1 judged.
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).toContain(
      shapeKey,
    );
    // ...and spent: phase 2 clears step 6 and lands on step 7's arm.
    expect(result.entries[2]?.verdict).toBe("auto-approved");
    expect(result.entries[2]?.rule).toBe("graded-mutation-auto-approved");
    expect(result.content).toEqual([{ type: "text", text: MUTATION_TEXT }]);
  });

  it("case E: a non-zero phase-1 exit withholds the credit; phase 2 is still evaluated and RECORDED as a dry-run-first escalation, but never executed", async () => {
    // The negative of case D, and the #1027 guard: identical setup except
    // phase 1 reports a FAILED dry run.
    //
    // The wrapper's own stop deliberately does NOT pre-empt phase 2's
    // evaluation: `refuse()` writes no decision-log entry, so stopping before
    // phase 2 was judged would silently drop the audit record a `dryRunFirst`
    // deployment writes today. Phase 2 is therefore evaluated and recorded —
    // the escalation is visible to an auditor — and only then refused, before
    // anything runs.
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(true),
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
        phase.dryRun
          ? {
              content: [{ type: "text", text: DRY_RUN_TEXT }],
              outcome: { dryRun: true, exitCode: 1 },
            }
          : twoPhaseExecution(phase),
    });

    // Phase 1 ran; phase 2's execute never did.
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    // Phase 1's pre + post, then phase 2's pre — and no phase-2 post, because
    // phase 2 never executed.
    expect(result.entries).toHaveLength(3);
    const shapeKey = phaseOneShapeKey(result);
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      shapeKey,
    );
    expect(result.entries[2]?.verdict).toBe("escalate");
    expect(result.entries[2]?.rule).toBe("dry-run-first");
    // The failed dry run's own shape key is what phase 2 was judged against.
    expect(result.entries[2]?.shapeKey).toBe(shapeKey);
    // The model gets a fixed-vocabulary refusal, never phase 2's content.
    expect(result.content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized },
    ]);
    expect(result.content).not.toContainEqual({
      type: "text",
      text: MUTATION_TEXT,
    });
    // Both report channels: `logDryRunCreditWithheld` names the withheld
    // credit on the logger, and the refusal itself demotes the run through
    // `reportRecovery` — invisible to a scheduler reading only
    // `recoveryTotal` if either is skipped.
    expect(flattenLoggedText(result.loggerHandler.events)).toContain(
      "dry-run-first credit",
    );
    expect(result.recoveryEntries.length).toBeGreaterThanOrEqual(1);
    // WHICH reason: this dry run DID report a dry run, so the distinguishing
    // half is the non-zero exit code. Without this pair the two withhold
    // messages are interchangeable to the suite.
    const withheld = withheldCreditEvent(result.loggerHandler.events);
    expect(withheld.message).toContain("did not prove a clean exit");
    expect(withheld.message).not.toContain("did not report a dry run");
    // ...and the detail carries the exit code itself, not just a headline.
    const withheldData = eventData(withheld);
    expect(Object.hasOwn(withheldData, "exitCode")).toBe(true);
    expect(withheldData["exitCode"]).toBe(1);
    expect(withheldData["dryRun"]).toBe(true);
  });

  it("case F: phase 1 runs as a dry run and its audit record reports dryRun true", async () => {
    const result = await runTwoPhaseTool({ policy: twoPhasePolicy(true) });

    // Producer-side guard: a phase-1 outcome reporting `dryRun: false` would
    // mislabel the audit trail AND (under a stricter later rule) misreport
    // what the credit was minted from.
    expect(result.executePhases[0]).toEqual({ dryRun: true });
    const phaseOnePost = result.entries[1];
    expect(Object.hasOwn(phaseOnePost ?? {}, "outcome")).toBe(true);
    expect(phaseOnePost?.outcome).toEqual({ dryRun: true, exitCode: 0 });
    // The pair, so this cannot pass by every outcome being stamped `true`.
    expect(result.entries[3]?.outcome).toEqual({ dryRun: false, exitCode: 0 });
  });
});

/*
 * ---------------------------------------------------------------------------
 * V9 slice 2b — the review-fix round.
 *
 * Written RED against guards three reviewers found MISSING from
 * `runTwoPhaseGatedTool`. Each `describe` below states, in its own comment,
 * why the case fails on the current implementation rather than on a harness
 * mistake — the whole point of a guard test is that the guard, not the
 * scaffolding, is what is absent.
 * ---------------------------------------------------------------------------
 */

describe("gateTwoPhaseToolSpec — the signal is re-checked BETWEEN the phases", () => {
  // WHY THIS IS RED TODAY: `runTwoPhaseGatedTool` reads `context` only to
  // forward it into `spec.execute`; nothing between `if (dryRun.kind ===
  // "refused")` and the phase-2 `runGatedPass` consults `context.signal`. So
  // an abort raised while phase 1 was running is invisible and phase 2 is
  // dispatched anyway. The harness itself is proven by "case B", which runs
  // the identical setup minus the abort and passes.

  it("case G: an abort raised DURING phase 1 stops the run — phase 2 is never dispatched and the abort surfaces instanceof-intact", async () => {
    const controller = new AbortController();

    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      signal: controller.signal,
      // Phase 1 aborts and then RESOLVES CLEANLY. An `execute` that THREW the
      // abort would already pass through `runApprovedExecution`'s existing
      // abort branch (pinned elsewhere in this file), so a clean resolution
      // after an abort is the only arrangement that isolates the wrapper's
      // own between-phase re-check.
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution => {
        if (phase.dryRun) controller.abort();
        return twoPhaseExecution(phase);
      },
    });

    // Phase 1 ran to completion; phase 2 never started.
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    // Nothing of phase 2 happened at all — not its evaluation, not even its
    // pre-decision audit record. Phase 1's own two entries remain.
    expect(result.entries).toHaveLength(2);
    // ADR-0049 classifies an abort by `instanceof`, so it must surface as the
    // abort itself, never wrapped into ERR_AGENT_TOOL_EXECUTION.
    expect(result.thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
    expect(result.thrown).not.toBeInstanceOf(M3LAgentOperatorCliError);
    // ...and phase 2's content is definitively not what the caller received.
    expect(result.content).not.toContainEqual({
      type: "text",
      text: MUTATION_TEXT,
    });
  });
});

describe("gateTwoPhaseToolSpec — the credit requires the outcome to REPORT a dry run", () => {
  // WHY THIS IS RED TODAY: `applyDryRunCredit` gates only on `isCleanExit`,
  // which reads `outcome.exitCode` and nothing else — `outcome.dryRun` is
  // never consulted on the crediting path. A phase-1 `execute` that reports
  // `{ dryRun: false, exitCode: 0 }` therefore mints exactly the credit that
  // satisfies the policy's `dryRunFirst` precondition for phase 2, even
  // though the producer just said it did NOT dry-run. "Case D" (the same
  // policy, an honestly-reported dry run) proves the harness reaches the
  // crediting path at all.

  it("case H: a phase-1 outcome reporting dryRun:false never mints the credit, even on a clean exit — and the withheld credit is reported on the logger", async () => {
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(true),
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
        phase.dryRun
          ? {
              content: [{ type: "text", text: DRY_RUN_TEXT }],
              // A clean exit that does NOT report a dry run. `isCleanExit`
              // alone cannot tell this apart from a real dry run, and the
              // credit it mints is what authorizes a real mutation.
              outcome: { dryRun: false, exitCode: 0 },
            }
          : twoPhaseExecution(phase),
    });

    const shapeKey = phaseOneShapeKey(result);
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      shapeKey,
    );
    // Phase 2 therefore still owes a clean dry run: it must not be
    // auto-approved, and it must not run. Deliberately NOT pinned to a rule
    // id — whether the wrapper stops before phase 2 or lets the evaluator
    // escalate it is the implementer's call; either way phase 2 must not
    // execute and the model must not get phase 2's content.
    expect(result.entries[2]?.verdict).not.toBe("auto-approved");
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    expect(result.content).not.toContainEqual({
      type: "text",
      text: MUTATION_TEXT,
    });
    expect(Object.values(AGENT_TOOL_REFUSAL_MESSAGES)).toContain(
      soleContentText(result.content),
    );
    // Observability of the withheld credit: `logDryRunCreditWithheld` is the
    // one channel that names it (it deliberately never calls
    // `reportRecovery`), and the injected logger here is a real
    // `Core.M3LLogger` over a recording handler — not a swallowing port — so
    // a missing report is a real, detectable drop.
    expect(flattenLoggedText(result.loggerHandler.events)).toContain(
      "dry-run-first credit",
    );
    expect(
      result.loggerHandler.events.some(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ),
    ).toBe(true);
    // WHICH reason: the exit code was a clean 0 here, so the ONLY thing that
    // withheld the credit is the producer denying it dry-ran. The negative
    // half is what stops the two reasons from collapsing into one string.
    const withheld = withheldCreditEvent(result.loggerHandler.events);
    expect(withheld.message).toContain("did not report a dry run");
    expect(withheld.message).not.toContain("did not prove a clean exit");
    const withheldData = eventData(withheld);
    expect(Object.hasOwn(withheldData, "dryRun")).toBe(true);
    expect(Object.hasOwn(withheldData, "exitCode")).toBe(true);
    expect(withheldData["dryRun"]).toBe(false);
    expect(withheldData["exitCode"]).toBe(0);
  });
});

describe("gateTwoPhaseToolSpec — a phase-1 dry run that RAN and FAILED stops the run", () => {
  // WHY THIS IS RED TODAY: the wrapper's only stop is
  // `if (dryRun.kind === "refused")`, which tests phase 1's GATE VERDICT.
  // `runApprovedExecution` returns `result.content` and discards
  // `result.outcome`, so a dry run that was approved, ran, and reported a
  // non-zero exit is indistinguishable from a clean one at the wrapper. With
  // `dryRunFirst` OMITTED (it is a strict opt-in — `decide.ts` reaches the
  // dry-run-first arm only when the policy declares it), nothing in the
  // POLICY can stop phase 2 either, so today phase 2 mutates on the back of
  // a failed plan. "Case B" (identical policy, a clean phase 1) proves the
  // harness otherwise runs both phases.

  it("case I: with dryRunFirst absent from the policy, a phase-1 exitCode 1 still stops phase 2 and refuses from the fixed vocabulary", async () => {
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
        phase.dryRun
          ? {
              content: [{ type: "text", text: DRY_RUN_TEXT }],
              outcome: { dryRun: true, exitCode: 1 },
            }
          : twoPhaseExecution(phase),
    });

    // Phase 1 ran; phase 2's execute never did.
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    expect(result.content).not.toContainEqual({
      type: "text",
      text: MUTATION_TEXT,
    });
    // The policy-independence proof, and why this case is not a duplicate of
    // case E: with `dryRunFirst` omitted, the evaluator has no reference to
    // phase 1 at all, so phase 2 IS judged and IS recorded as auto-approved —
    // the gate would have let the mutation run. The wrapper refused anyway.
    expect(result.entries).toHaveLength(3);
    expect(result.entries[2]?.verdict).toBe("auto-approved");
    expect(result.entries[2]?.rule).toBe("graded-mutation-auto-approved");
    // Every model-facing string this module can produce is a member of the
    // closed vocabulary — WHICH member is the implementer's call.
    expect(Object.values(AGENT_TOOL_REFUSAL_MESSAGES)).toContain(
      soleContentText(result.content),
    );
    // A refusal the model is told about must also reach `reportRecovery`, or
    // the run's outcome never shows the mutation was skipped.
    expect(result.recoveryEntries.length).toBeGreaterThanOrEqual(1);
    // The failed dry run must not have left a credit behind either.
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      phaseOneShapeKey(result),
    );
    // ...and the withheld credit is reported, so an operator can correlate the
    // stop with the dry run that caused it.
    expect(flattenLoggedText(result.loggerHandler.events)).toContain(
      "dry-run-first credit",
    );
    // WHICH reason: this producer DID report a dry run, so the exit code is
    // the distinguishing half — and the detail carries the code itself.
    const withheld = withheldCreditEvent(result.loggerHandler.events);
    expect(withheld.message).toContain("did not prove a clean exit");
    expect(withheld.message).not.toContain("did not report a dry run");
    const withheldData = eventData(withheld);
    expect(Object.hasOwn(withheldData, "exitCode")).toBe(true);
    expect(withheldData["exitCode"]).toBe(1);

    // The RECOVERY entry's CONTENTS, not just its count: this is the channel a
    // scheduler reads, so an entry naming the wrong tool or carrying a blank
    // detail is the failure mode that matters. Asserted on the blocked-
    // mutation path — the very channel the wrapper's guard reports on.
    const blocked = result.recoveryEntries.find(
      (entry) => entry.item === TWO_PHASE_TOOL_NAME,
    );
    expect(blocked).toBeDefined();
    if (blocked === undefined) throw new Error("unreachable");
    expect(blocked.recordedAt).toBe(new Date(NOW).toISOString());
    const detail = recoveryDetail(blocked);
    // Names the reason AND the judged field — the punctuation of the rendering
    // is the implementer's call, the presence of the exit code is not.
    expect(detail).toContain("did not prove a clean exit");
    expect(detail).toContain("exitCode");
    expect(detail).toContain("1");
    expect(detail.length).toBeGreaterThan(0);
  });
});

describe("gateTwoPhaseToolSpec — the wrapper's own failure paths", () => {
  // These three are CHARACTERIZATION rows, not guard proofs: they pin
  // wrapper-level failure behaviour that no existing test covers (every
  // describeAction-throws / execute-rejects case in this file drives the
  // SINGLE-phase `gateToolSpec`). They are expected to hold on the current
  // implementation, which shares `describeActionOrRefuse` and
  // `runApprovedExecution` between both entry points — that sharing is
  // exactly what they lock, so a future two-phase-only copy of either
  // boundary cannot diverge unnoticed.

  it("case J: a throwing describeAction refuses with malformedInput before phase 1 — nothing is evaluated, recorded, or executed", async () => {
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      describeAction: (): Core.M3LAgentAction => {
        throw new Error(`malformed: ${SECRET_TOKEN}`);
      },
    });

    expect(result.calls).toEqual([]);
    expect(result.entries).toHaveLength(0);
    expect(result.executePhases).toEqual([]);
    expect(result.thrown).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.malformedInput },
    ]);
    // The trust boundary is crossed once, and the caught detail never
    // reaches the model.
    expect(result.describeActionInputs).toHaveLength(1);
    expect(soleContentText(result.content)).not.toContain(SECRET_TOKEN);
    expect(result.recoveryEntries).toHaveLength(1);
  });

  it("case K: a REJECTING phase-1 execute wraps as ERR_AGENT_TOOL_EXECUTION, still writes the failure audit record, and never starts phase 2", async () => {
    const executeError = new Error(`boom ${SECRET_PATH}`);
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      execute: (
        phase: TwoPhaseExecuteFlag,
      ): AgentToolExecution | Promise<AgentToolExecution> =>
        phase.dryRun ? Promise.reject(executeError) : twoPhaseExecution(phase),
    });

    expect(result.executePhases).toEqual([{ dryRun: true }]);
    expect(result.thrown).toBeInstanceOf(Core.M3LError);
    const thrown = result.thrown as Core.M3LError;
    expect(thrown.message).toBe(AGENT_TOOL_REFUSAL_MESSAGES.executionFailed);
    expect(thrown.code).toBe("ERR_AGENT_TOOL_EXECUTION");
    expect(thrown.cause).toBe(executeError);
    // The crashed phase still produced BOTH audit records, and the outcome
    // record fabricates no exit code for an action that never completed.
    expect(result.entries).toHaveLength(2);
    const post = result.entries[1];
    expect(Object.hasOwn(post ?? {}, "outcome")).toBe(true);
    expect(post?.outcome?.dryRun).toBe(true);
    expect(Object.hasOwn(post?.outcome ?? {}, "exitCode")).toBe(false);
    expect(result.recoveryEntries).not.toHaveLength(0);
    expect(flattenLoggedText(result.loggerHandler.events)).toContain(
      SECRET_PATH,
    );
  });

  it("case L: a REJECTING phase-2 execute wraps the same way after a clean phase 1, with phase 2's failure audit record written", async () => {
    const executeError = new Error("boom in phase 2");
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      execute: (
        phase: TwoPhaseExecuteFlag,
      ): AgentToolExecution | Promise<AgentToolExecution> =>
        phase.dryRun ? twoPhaseExecution(phase) : Promise.reject(executeError),
    });

    expect(result.executePhases).toEqual([{ dryRun: true }, { dryRun: false }]);
    expect(result.thrown).toBeInstanceOf(Core.M3LError);
    const thrown = result.thrown as Core.M3LError;
    expect(thrown.code).toBe("ERR_AGENT_TOOL_EXECUTION");
    // The ORIGINAL execute failure is the chained cause, never a
    // wrapper-invented substitute.
    expect(thrown.cause).toBe(executeError);
    // Phase 1's two records plus phase 2's pre + failure records.
    expect(result.entries).toHaveLength(4);
    const post = result.entries[3];
    expect(Object.hasOwn(post ?? {}, "outcome")).toBe(true);
    expect(post?.outcome?.dryRun).toBe(false);
    expect(Object.hasOwn(post?.outcome ?? {}, "exitCode")).toBe(false);
    expect(result.recoveryEntries).not.toHaveLength(0);
  });
});

describe("gateToolSpec — the policy's own dry-run-first arm, on the single-phase path", () => {
  // The dry-run-first escalation is a load-bearing part of the authorization
  // model and it is reachable from BOTH entry points. Pinned here at the
  // single-phase level so it stays covered independently of how the two-phase
  // wrapper's own stop is placed: a mutating tool the model calls directly,
  // under a policy that opted into `dryRunFirst`, with no dry-run credit
  // recorded for its shape, must escalate on `rule=dry-run-first` and never
  // execute.

  it("escalates a mutating action on rule=dry-run-first when no clean dry run for its shape was recorded, and never executes", async () => {
    const calls: string[] = [];
    const ledger = new AgentRunLedger();
    trackLedgerCalls(ledger, calls);
    const writer = new RecordingDecisionLogWriter(() => calls.push("record"));
    const reportRecovery = vi.fn();
    const action: Core.M3LAgentAction = {
      ...gradedMutatingAction(),
      dryRun: false,
    };
    const spec = trackedSpec({ calls, action });
    const deps = makeDeps({
      policy: twoPhasePolicy(true),
      ledger,
      writer,
      reportRecovery,
    });
    const registration = gateToolSpec(spec, deps);

    // Precondition, not decoration: the escalation must come from an EMPTY
    // credit set, so a future change that pre-credited the shape would make
    // this row prove nothing.
    expect(ledger.snapshot(NOW).dryRunCompletedShapes).toHaveLength(0);

    const content = await registration.handler(
      undefined,
      toolContext(spec.name),
    );

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0]?.verdict).toBe("escalate");
    expect(writer.entries[0]?.rule).toBe("dry-run-first");
    expect(calls).not.toContain("execute");
    expect(content).toEqual([
      { type: "text", text: AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized },
    ]);
    expect(reportRecovery).toHaveBeenCalledTimes(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * V9 slice 2b — the confirmation re-review round.
 *
 * Two REAL defects (cases M/N and case O) plus the rows that make four
 * surviving source mutations fail. Each `describe` states whether it is RED
 * against the current implementation or a mutant-killer that must pass today
 * and fail under a named mutation.
 * ---------------------------------------------------------------------------
 */

describe("gateTwoPhaseToolSpec — phase 1's reported outcome is judged ONCE, not re-read per decision", () => {
  // WHY THESE ARE RED TODAY: `applyDryRunCredit`, `recordSuccessOutcome`, and
  // `stopBeforeMutation` each re-read the producer's `outcome` OBJECT rather
  // than a value snapshotted when `execute` resolved. An accessor-backed
  // `dryRun`/`exitCode` therefore answers the CREDIT decision and the MUTATION
  // guard differently: the credit is withheld (so the shape never becomes
  // spendable) while the mutation runs anyway — precisely the split
  // `isCleanDryRunOutcome` exists to make impossible ("were they two, the
  // credit could be withheld while the mutation still ran").
  //
  // The policy deliberately OMITS `dryRunFirst`, so the evaluator has no
  // opinion about phase 1 and the wrapper's own guard is the only stop under
  // test. The flip is driven by an OBSERVABLE event — the third decision-log
  // write, phase 2's pre-decision entry, which lands after the credit was
  // decided and before the guard is consulted — never by a read counter, so
  // the row does not pin how many times a field happens to be read.

  it("case M: a phase-1 `dryRun` that reads false while the credit is decided and true afterwards must never both withhold the credit AND let the mutation run", async () => {
    let phaseTwoReached = false;
    let writes = 0;
    const outcome: Core.M3LAgentDecisionOutcome = {
      get dryRun(): boolean {
        return phaseTwoReached;
      },
      exitCode: 0,
    };

    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      onWrite: () => {
        writes += 1;
        if (writes >= 3) phaseTwoReached = true;
      },
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
        phase.dryRun
          ? { content: [{ type: "text", text: DRY_RUN_TEXT }], outcome }
          : twoPhaseExecution(phase),
    });

    // Vacuity guard: phase 1 really ran, and the accessor really did change
    // its answer inside this call.
    expect(result.executePhases[0]).toEqual({ dryRun: true });
    expect(phaseTwoReached).toBe(true);

    // The credit was WITHHELD — the shape never became spendable...
    const shapeKey = phaseOneShapeKey(result);
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      shapeKey,
    );
    expect(flattenLoggedText(result.loggerHandler.events)).toContain(
      "dry-run-first credit",
    );
    // ...so the mutation that credit would have justified must not have run.
    // This is the invariant, not the wording: one outcome, one decision.
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    expect(result.content).not.toContainEqual({
      type: "text",
      text: MUTATION_TEXT,
    });
    expect(Object.values(AGENT_TOOL_REFUSAL_MESSAGES)).toContain(
      soleContentText(result.content),
    );
  });

  it("case N: the same split through an `exitCode` that reads 1 while the credit is decided and 0 afterwards", async () => {
    let phaseTwoReached = false;
    let writes = 0;
    const outcome: Core.M3LAgentDecisionOutcome = {
      dryRun: true,
      get exitCode(): number {
        return phaseTwoReached ? 0 : 1;
      },
    };

    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      onWrite: () => {
        writes += 1;
        if (writes >= 3) phaseTwoReached = true;
      },
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
        phase.dryRun
          ? { content: [{ type: "text", text: DRY_RUN_TEXT }], outcome }
          : twoPhaseExecution(phase),
    });

    expect(result.executePhases[0]).toEqual({ dryRun: true });
    expect(phaseTwoReached).toBe(true);

    const shapeKey = phaseOneShapeKey(result);
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      shapeKey,
    );
    expect(flattenLoggedText(result.loggerHandler.events)).toContain(
      "dry-run-first credit",
    );
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    expect(result.content).not.toContainEqual({
      type: "text",
      text: MUTATION_TEXT,
    });
    expect(Object.values(AGENT_TOOL_REFUSAL_MESSAGES)).toContain(
      soleContentText(result.content),
    );
  });
});

describe("gateTwoPhaseToolSpec — the blocked-mutation refusal survives a failing serialization", () => {
  // WHY THIS IS RED TODAY: `stopBeforeMutation` builds its detail string as an
  // ARGUMENT to `refuse(...)` — `${uncleanDryRunReason(outcome)} (${JSON
  // .stringify(uncleanDryRunFields(outcome))})`. If that `JSON.stringify`
  // throws, `refuse` is never entered: no logger line, no `reportRecovery`
  // entry, and a raw `TypeError` escapes the handler into the Bedrock dispatch
  // layer, which relays a thrown handler message to the model verbatim —
  // breaking the module's closed-vocabulary rule on the single path that
  // matters most, a mutation being blocked.
  //
  // TRIGGER, and why this one. A STATIC hostile VALUE cannot reach the call:
  // phase 1's post-execution audit record runs first, and the library's
  // `projectOutcome` validates the outcome there — `dryRun` must be an own
  // boolean and `exitCode` an own integer — so a BigInt exit code (or any
  // value carrying a throwing `toJSON`) is rejected at phase 1 and the run
  // dies long before the guard. A poisoned `Number.prototype.toJSON` does not
  // work either: `JSON.stringify` consults `toJSON` only for Objects and
  // BigInts, never for a primitive number. What DOES reach it is a poisoned
  // `Object.prototype.toJSON` — the detail's own `{ dryRun, exitCode }`
  // wrapper object is what gets serialized — installed once phase 2's
  // pre-decision entry (the third write, and the last serialization on this
  // path) is already on disk. The outcome itself stays a perfectly ordinary
  // `{ dryRun: true, exitCode: 1 }`, so this row keeps discriminating after
  // the outcome-snapshot fix for cases M/N: nothing about the VALUES is
  // hostile, only the serialization of the wrapper the detail builds.

  it("case O: a phase-1 outcome whose detail cannot be serialized still refuses from the fixed vocabulary and still reports on BOTH channels", async () => {
    const priorToJSON = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    let writes = 0;
    let poisonProven = false;
    let result: TwoPhaseRunResult;
    try {
      result = await runTwoPhaseTool({
        policy: twoPhasePolicy(false),
        onWrite: () => {
          writes += 1;
          if (writes === 3) {
            Object.defineProperty(Object.prototype, "toJSON", {
              value: (): never => {
                throw new TypeError("refusing to serialize this object");
              },
              configurable: true,
              enumerable: false,
              writable: true,
            });
            // In-band proof that the trigger is LIVE at the exact instant
            // before the guard runs — without it a future refactor could make
            // this row pass while never exercising a failing serialization.
            try {
              JSON.stringify({ probe: 1 });
            } catch {
              poisonProven = true;
            }
          }
        },
        execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
          phase.dryRun
            ? {
                content: [{ type: "text", text: DRY_RUN_TEXT }],
                outcome: { dryRun: true, exitCode: 1 },
              }
            : twoPhaseExecution(phase),
      });
    } finally {
      if (priorToJSON === undefined) {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      } else {
        Object.defineProperty(Object.prototype, "toJSON", priorToJSON);
      }
    }

    // Vacuity guard: the trigger really was live inside this run, after the
    // audit records that legitimately serialize an entry.
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(poisonProven).toBe(true);
    expect(result.entries).toHaveLength(3);

    // Nothing raw escapes the handler...
    expect(result.thrown).toBeUndefined();
    // ...the model gets a member of the closed vocabulary...
    expect(Object.values(AGENT_TOOL_REFUSAL_MESSAGES)).toContain(
      soleContentText(result.content),
    );
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    // ...and both report channels still fire: the withheld-credit line from
    // phase 1 plus the guard's own refusal line, and a recovery entry naming
    // the tool, so a scheduler still learns the mutation was skipped.
    expect(
      result.loggerHandler.events.filter(
        (event) => event.category === Core.M3LLogEventCategory.ERROR,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    const blocked = result.recoveryEntries.find(
      (entry) => entry.item === TWO_PHASE_TOOL_NAME,
    );
    expect(blocked).toBeDefined();
    if (blocked === undefined) throw new Error("unreachable");
    expect(recoveryDetail(blocked).length).toBeGreaterThan(0);
  });
});

describe("gateTwoPhaseToolSpec — the guard's dry-run half, with the policy silent", () => {
  // MUTANT-KILLER, expected GREEN today. The missing matrix row: a policy
  // WITHOUT `dryRunFirst` (so the evaluator has no opinion and the WRAPPER's
  // guard is the only possible stop) whose phase 1 reports `{ dryRun: false,
  // exitCode: 0 }`. Case H drives the same outcome but under
  // `dryRunFirst: true`, where the EVALUATOR stops phase 2 — so the guard's
  // own `reportsDryRun` half is never exercised there; case I varies only the
  // exit code. Both of these source mutations pass without this row:
  //   - `stopBeforeMutation` -> `if (isCleanExit(outcome)) return undefined;`
  //   - `reportsDryRun`      -> `"dryRun" in outcome`

  it("case P: with dryRunFirst absent, a phase-1 outcome reporting dryRun:false on a CLEAN exit is still blocked — by the wrapper, not the policy", async () => {
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
        phase.dryRun
          ? {
              content: [{ type: "text", text: DRY_RUN_TEXT }],
              outcome: { dryRun: false, exitCode: 0 },
            }
          : twoPhaseExecution(phase),
    });

    // Phase 1 ran; phase 2's execute never did.
    expect(result.executePhases).toEqual([{ dryRun: true }]);
    expect(result.content).not.toContainEqual({
      type: "text",
      text: MUTATION_TEXT,
    });
    // The policy-silence proof: phase 2 was judged, recorded, and
    // AUTO-APPROVED — the gate would have let the mutation run. Only the
    // wrapper's guard stopped it, and it stopped it on the `dryRun` half
    // alone, since the exit code was a clean 0.
    expect(result.entries).toHaveLength(3);
    expect(result.entries[2]?.verdict).toBe("auto-approved");
    expect(result.entries[2]?.rule).toBe("graded-mutation-auto-approved");
    expect(Object.values(AGENT_TOOL_REFUSAL_MESSAGES)).toContain(
      soleContentText(result.content),
    );
    // Both channels report the stop.
    expect(result.recoveryEntries.length).toBeGreaterThanOrEqual(1);
    const withheld = withheldCreditEvent(result.loggerHandler.events);
    expect(withheld.message).toContain("did not report a dry run");
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      phaseOneShapeKey(result),
    );
  });

  it("case Q: a `dryRun` reachable only through the PROTOTYPE never satisfies the outcome check — the credit is withheld and the mutation never runs", async () => {
    // Both a LAYERING proof and a genuine mutant-killer. The layering half:
    // an outcome with no OWN `dryRun` is rejected by the library's own
    // `projectOutcome` when phase 1's post-execution record is built, so the
    // snapshot never manufactures a credit and `stopBeforeMutation` is never
    // consulted. The mutant-killer half: mutating `reportsDryRun` from
    // `Object.hasOwn(outcome, "dryRun")` to `"dryRun" in outcome` would let
    // the inherited `dryRun: true` satisfy the guard and mint a credit —
    // the "no credit, no mutation" assertions below would then FAIL, so this
    // row distinguishes the correct implementation from that mutant.
    const priorDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "dryRun",
    );
    Object.defineProperty(Object.prototype, "dryRun", {
      value: true,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      const outcome = {
        exitCode: 0,
      } as unknown as Core.M3LAgentDecisionOutcome;
      // The poison is live and the outcome itself still declares nothing.
      expect((outcome as { dryRun?: boolean }).dryRun).toBe(true);
      expect(Object.hasOwn(outcome, "dryRun")).toBe(false);

      const result = await runTwoPhaseTool({
        policy: twoPhasePolicy(false),
        execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution =>
          phase.dryRun
            ? { content: [{ type: "text", text: DRY_RUN_TEXT }], outcome }
            : twoPhaseExecution(phase),
      });

      // Vacuity guard: phase 1 really executed, so the absence below is not
      // "the call stopped earlier".
      expect(result.executePhases[0]).toEqual({ dryRun: true });
      // No credit, and above all no mutation.
      expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
        phaseOneShapeKey(result),
      );
      expect(result.executePhases).toEqual([{ dryRun: true }]);
      expect(result.content).not.toContainEqual({
        type: "text",
        text: MUTATION_TEXT,
      });
    } finally {
      if (priorDescriptor === undefined) {
        delete (Object.prototype as { dryRun?: boolean }).dryRun;
      } else {
        Object.defineProperty(Object.prototype, "dryRun", priorDescriptor);
      }
    }
  });
});

describe("gateTwoPhaseToolSpec — both phases are derived from ONE snapshot of the described action", () => {
  // MUTANT-KILLERS, expected GREEN today. `deriveTwoPhaseActions` documents
  // two invariants that no existing row pins, so each of these source
  // mutations passes the suite untouched:
  //   - dropping the `[...base.parameterNames]` copy (the phases then ALIAS
  //     the spec's own array, which `evaluateAgentAction` re-reads per phase)
  //   - `mutation: { ...action, dryRun: false }` — deriving phase 2 from the
  //     SOURCE instead of from phase 1's spread, so an accessor answers the
  //     two phases differently
  // Both break the same thing: the dry-run shape key phase 1 credits must be
  // exactly the key phase 2 asks about.

  it("case R: a spec that MUTATES its own parameterNames array during phase 1 still yields one identical shapeKey across all four decision-log entries", async () => {
    const parameterNames: string[] = ["table"];
    const action: Core.M3LAgentAction = {
      ...gradedMutatingAction(),
      parameterNames,
    };

    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(true),
      describeAction: (): Core.M3LAgentAction => action,
      execute: (phase: TwoPhaseExecuteFlag): AgentToolExecution => {
        // Phase 1's real work mutates the array the spec handed over — which
        // is exactly when a shared reference diverges: phase 2 is evaluated
        // AFTER this.
        if (phase.dryRun) parameterNames.push("smuggled");
        return twoPhaseExecution(phase);
      },
    });

    // Vacuity guard: the mutation really happened, and both phases ran.
    expect(parameterNames).toEqual(["table", "smuggled"]);
    expect(result.executePhases).toEqual([{ dryRun: true }, { dryRun: false }]);

    // Four entries means phase 2 was auto-approved and executed — i.e. the
    // credit phase 1 minted was spendable, which it only is when both phases
    // hashed the same shape.
    expect(result.entries).toHaveLength(4);
    const shapeKey = phaseOneShapeKey(result);
    for (const entry of result.entries) {
      expect(entry.shapeKey).toBe(shapeKey);
    }
    // ...and phase 2 was judged on the SNAPSHOT, not on the mutated array.
    expect(result.entries[2]?.parameterNames).toEqual(["table"]);
    expect(result.entries[2]?.rule).toBe("graded-mutation-auto-approved");
    expect(result.content).toEqual([{ type: "text", text: MUTATION_TEXT }]);
  });

  it("case S: an action whose `operation` is a GETTER is read exactly once, and both phases are judged on that one reading", async () => {
    let operationReads = 0;
    const action: Core.M3LAgentAction = {
      script: "agent-operator",
      get operation(): string {
        operationReads += 1;
        // A source read a second time answers differently — the shape the
        // whole two-phase guarantee is built on would then differ per phase.
        return operationReads === 1 ? "put-item" : "delete-item";
      },
      kind: "mutating",
      target: { profile: "sandbox", region: "eu-central-1" },
      parameterNames: ["table"],
    };

    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(true),
      describeAction: (): Core.M3LAgentAction => action,
    });

    // The documented invariant: "The source is read exactly ONCE, into
    // `base`." A second read is what a per-phase derivation from `action`
    // costs.
    expect(operationReads).toBe(1);
    expect(result.executePhases).toEqual([{ dryRun: true }, { dryRun: false }]);
    expect(result.entries).toHaveLength(4);
    const shapeKey = phaseOneShapeKey(result);
    for (const entry of result.entries) {
      expect(entry.operation).toBe("put-item");
      expect(entry.shapeKey).toBe(shapeKey);
    }
    expect(result.content).toEqual([{ type: "text", text: MUTATION_TEXT }]);
  });
});

describe("gateTwoPhaseToolSpec — the ledger's dry-run-shape ceiling is absorbed, not thrown", () => {
  // MUTANT-KILLER, expected GREEN today. `applyDryRunCredit` wraps
  // `deps.ledger.recordDryRunShape(...)` in a try/catch precisely because the
  // library's per-run shape ceiling throws — and emptying that catch passes
  // the whole suite, because no row ever fills the ceiling. Left unhandled the
  // throw would skip the post-execution audit record for an action that ALREADY
  // RAN and escape into the dispatch layer.
  //
  // The ceiling is reached for real (256 distinct filler shapes through the
  // real `AgentRunLedger`), never by mocking the method — so the caught value
  // is the library's own error, not a test's stand-in.

  it("case T: a phase-1 credit refused by the ceiling still resolves, still writes the post-execution record, and reports the withheld credit", async () => {
    const result = await runTwoPhaseTool({
      policy: twoPhasePolicy(false),
      prepareLedger: (ledger: AgentRunLedger): void => {
        for (
          let index = 0;
          index < Core.M3L_AGENT_MAX_DRY_RUN_SHAPES;
          index += 1
        ) {
          ledger.recordDryRunShape(`filler-shape-${String(index)}`);
        }
      },
    });

    // The call is not turned into a failure...
    expect(result.thrown).toBeUndefined();
    // ...phase 1's post-execution audit record is still written, carrying the
    // outcome `execute` actually reported...
    expect(result.entries).toHaveLength(4);
    expect(result.entries[1]?.outcome).toEqual({ dryRun: true, exitCode: 0 });
    // ...the credit is genuinely absent (the ceiling refused it, and this is
    // not a run that simply never tried)...
    expect(result.ledger.snapshot(NOW).dryRunCompletedShapes).not.toContain(
      phaseOneShapeKey(result),
    );
    // ...and the withheld credit is reported, naming the ceiling rather than
    // one of the two outcome reasons.
    const withheld = withheldCreditEvent(result.loggerHandler.events);
    expect(withheld.message).toContain("ceiling was already reached");
    const withheldData = eventData(withheld);
    expect(Object.hasOwn(withheldData, "detail")).toBe(true);
    expect(String(withheldData["detail"])).toContain("per-run shape ceiling");
  });
});
