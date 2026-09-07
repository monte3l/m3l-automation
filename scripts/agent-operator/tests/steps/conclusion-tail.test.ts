/**
 * Tests for `steps/conclusion-tail` — the extracted "conclusion tail" shared
 * by `run-health-check.ts`, `run-etl-preset.ts`, and `run-log-triage.ts`:
 * summarizing a metered run, persisting the daily invocation counter, and
 * writing the concluding decision-log entry.
 *
 * Covers `summarizeMeteredRun`, `recordConsumption`, `recordConclusion`, and
 * `concludeGatedOperation` — pinning the behavior of the three previously
 * duplicated copies this module replaces, plus one new hardening (case 4
 * below): a `reportRecovery` throw inside `recordConsumption`'s catch block
 * must not escape a bare `finally` and replace whatever the loop itself was
 * throwing. That is a defect in *shape*, not a reachable failure today (see
 * the module's own contract doc for why `M3LLogger.error` cannot throw and
 * `reportRecovery` cannot throw for a literal-built entry) — this file still
 * proves the guard exists, because it is what keeps the tail's own
 * hardening honest.
 *
 * Fixture idiom mirrors `tests/steps/metering-invoker.test.ts`: real
 * collaborators wherever the type is nominal (`AgentRunLedger`,
 * `AgentDecisionRecorder`, `Core.M3LLogger`), plain object literals wherever
 * the type is a structural interface (`AgentDailyInvocationCounter`,
 * `ConclusionTailPorts`, the `metered` field of `ConclusionTailSetup`). No
 * casts are needed to build any of those fixtures — the one cast in this
 * file (below, narrowing a caught `unknown`) is the standard idiom for
 * reading a thrown value's fields, not a fixture-construction workaround.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AgentDecisionRecorder,
  agentIdentity,
} from "../../src/steps/decision-recorder.js";
import type { AgentDailyInvocationCounter } from "../../src/steps/daily-counter.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import { RecordingDecisionLogWriter } from "../support/logFakes.js";
import { minimalPolicy } from "../support/policyFixtures.js";

import {
  concludeGatedOperation,
  recordConclusion,
  recordConsumption,
  summarizeMeteredRun,
} from "../../src/steps/conclusion-tail.js";
import type {
  ConclusionTailPorts,
  ConclusionTailSetup,
  MeteredRunSummary,
} from "../../src/steps/conclusion-tail.js";

/** A fixed, caller-sampled instant — mirrors the real callers' own `now`. */
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

/** Captures every event a `Core.M3LLogger` dispatches, in call order. */
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

/** The `ERROR`-category events a logger's handler observed, in call order. */
function errorEvents(
  handler: RecordingLoggerHandler,
): readonly Core.M3LLogEvent[] {
  return handler.events.filter(
    (event) => event.category === Core.M3LLogEventCategory.ERROR,
  );
}

/** Builds a `ConclusionTailPorts` fixture plus its logger's observing handle. */
function makePorts(
  reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void = vi.fn(),
): {
  readonly ports: ConclusionTailPorts;
  readonly handler: RecordingLoggerHandler;
} {
  const { logger, handler } = makeLogger();
  return { ports: { logger, reportRecovery }, handler };
}

/** A plain-literal `AgentDailyInvocationCounter` — a structural interface. */
function makeCounter(
  record: (invocations: number) => Promise<void>,
): AgentDailyInvocationCounter {
  return {
    priorToday: 0,
    seed: () => undefined,
    record,
  };
}

/** One synthesized loop iteration carrying exactly `totalTokens` tokens. */
function makeIteration(totalTokens: number): AWS.M3LBedrockToolLoopIteration {
  return {
    index: 1,
    modelId: "model-a",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: totalTokens, totalTokens },
    toolExecutions: [],
  };
}

/** A real, library-validated decision — content is irrelevant to the tail. */
function realDecision(): Core.M3LAgentDecision {
  const ledger = new AgentRunLedger();
  return Core.evaluateAgentAction({
    action: {
      script: "agent-operator",
      operation: "explain-policy",
      kind: "read-only",
    },
    policy: minimalPolicy(),
    run: ledger.snapshot(NOW),
  });
}

/** A real `AgentDecisionRecorder` plus the writer it appends entries to. */
function makeRecorder(): {
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

/** A minimal, valid `M3LBedrockToolLoopOutcome` — `cost` omitted unless given. */
function makeOutcome(
  overrides: Partial<AWS.M3LBedrockToolLoopOutcome> = {},
): AWS.M3LBedrockToolLoopOutcome {
  return {
    conversation: AWS.createBedrockConversation(),
    message: { role: "assistant", content: [] },
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    iterations: [],
    ...overrides,
  };
}

/** A `ConclusionTailSetup` fixture — a plain literal, structurally typed. */
function makeSetup(overrides: {
  readonly iterations?: readonly AWS.M3LBedrockToolLoopIteration[];
  readonly ledger?: AgentRunLedger;
  readonly recorder?: AgentDecisionRecorder;
  readonly decision?: Core.M3LAgentDecision;
  readonly now?: number;
}): ConclusionTailSetup {
  return {
    metered: { observedIterations: () => overrides.iterations ?? [] },
    ledger: overrides.ledger ?? new AgentRunLedger(),
    recorder: overrides.recorder ?? makeRecorder().recorder,
    decision: overrides.decision ?? realDecision(),
    now: overrides.now ?? NOW,
  };
}

describe("summarizeMeteredRun", () => {
  it("sums usage.totalTokens across every observed iteration", () => {
    const ledger = new AgentRunLedger();
    const setup = makeSetup({
      ledger,
      iterations: [makeIteration(10), makeIteration(25)],
    });

    const summary: MeteredRunSummary = summarizeMeteredRun(setup);

    expect(summary.tokens).toBe(35);
  });

  it("returns cost 0 for zero iterations, and reads cost from the ledger's own snapshot, never from an iteration's own figures", () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend({
      tokensThisRun: 0,
      loopIterations: 0,
      costThisRun: 4.25,
    });
    const setup = makeSetup({ ledger, iterations: [] });

    const summary = summarizeMeteredRun(setup);

    expect(summary.tokens).toBe(0);
    expect(summary.cost).toBe(4.25);
  });

  it("returns cost: undefined when the ledger's snapshot omits costThisRun (spend never observed)", () => {
    const ledger = new AgentRunLedger();
    const setup = makeSetup({ ledger, iterations: [makeIteration(5)] });

    // Confirms the fixture actually produces the unobservable state, not
    // merely a coincidental zero.
    expect(Object.hasOwn(ledger.snapshot(NOW), "costThisRun")).toBe(false);

    const summary = summarizeMeteredRun(setup);

    expect(summary.cost).toBeUndefined();
  });

  it("types cost as number | undefined — the discriminant this contract exists for", () => {
    expectTypeOf<MeteredRunSummary["cost"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<MeteredRunSummary["tokens"]>().toEqualTypeOf<number>();
  });
});

describe("recordConsumption", () => {
  it("records ledger.invocationCount via counter.record on the happy path", async () => {
    const ledger = new AgentRunLedger();
    ledger.recordInvocation();
    ledger.recordInvocation();
    ledger.recordInvocation();
    const record = vi.fn().mockResolvedValue(undefined);
    const counter = makeCounter(record);
    const { ports } = makePorts();

    await recordConsumption(counter, ledger, ports, NOW);

    expect(record).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("never calls reportRecovery or logs an error on the happy path", async () => {
    const ledger = new AgentRunLedger();
    const counter = makeCounter(vi.fn().mockResolvedValue(undefined));
    const reportRecovery = vi.fn();
    const { ports, handler } = makePorts(reportRecovery);

    await recordConsumption(counter, ledger, ports, NOW);

    expect(reportRecovery).not.toHaveBeenCalled();
    expect(errorEvents(handler)).toHaveLength(0);
  });

  it("logs the existing message and reports the recovery entry once, then still resolves, when counter.record rejects", async () => {
    const ledger = new AgentRunLedger();
    ledger.recordInvocation();
    ledger.recordInvocation();
    const cause = new Error("write failed: EACCES");
    const counter = makeCounter(vi.fn().mockRejectedValue(cause));
    const reportRecovery = vi.fn();
    const { ports, handler } = makePorts(reportRecovery);

    await expect(
      recordConsumption(counter, ledger, ports, NOW),
    ).resolves.toBeUndefined();

    const errors = errorEvents(handler);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(
      "the cross-run daily invocation counter could not be updated; today's recorded spend is now behind by this run's invocations",
    );
    expect(errors[0]?.data).toEqual({ invocations: 2 });

    expect(reportRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        item: "daily-invocation-counter",
        recordedAt: new Date(NOW).toISOString(),
      }),
    );
  });

  it("[new guard] still resolves and logs a second error, rather than letting reportRecovery's throw escape, when BOTH counter.record rejects AND reportRecovery throws", async () => {
    const ledger = new AgentRunLedger();
    const counter = makeCounter(
      vi.fn().mockRejectedValue(new Error("write failed: EACCES")),
    );
    const reportRecovery = vi.fn(() => {
      throw new Error("reportRecovery blew up");
    });
    const { ports, handler } = makePorts(reportRecovery);

    // The proof this case exists for: without the new inner `try`, this
    // `await` would reject with reportRecovery's thrown error instead of
    // resolving — silently replacing whatever a real caller's loop had
    // already thrown, from inside its own `finally`.
    await expect(
      recordConsumption(counter, ledger, ports, NOW),
    ).resolves.toBeUndefined();

    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(errorEvents(handler)).toHaveLength(2);
  });
});

describe("recordConclusion", () => {
  it("passes outcome: { dryRun: false, exitCode: 0 } and spreads cost when defined", async () => {
    const { recorder, writer } = makeRecorder();
    const decision = realDecision();

    await recordConclusion(recorder, decision, NOW, { tokens: 42, cost: 1.5 });

    expect(writer.entries).toHaveLength(1);
    const entry = writer.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("expected one written entry");
    expect(Object.hasOwn(entry, "cost")).toBe(true);
    expect(entry.cost).toBe(1.5);
    expect(entry.tokens).toBe(42);
    expect(entry.outcome).toEqual({ dryRun: false, exitCode: 0 });
  });

  it("omits the cost key entirely — never present holding undefined — when cost is undefined", async () => {
    const { recorder, writer } = makeRecorder();
    const decision = realDecision();

    await recordConclusion(recorder, decision, NOW, {
      tokens: 7,
      cost: undefined,
    });

    expect(writer.entries).toHaveLength(1);
    const entry = writer.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("expected one written entry");
    // Never `not.toHaveProperty` — it falls back to the `in` operator and
    // walks the prototype chain, so it can never fail.
    expect(Object.hasOwn(entry, "cost")).toBe(false);
    expect(entry.tokens).toBe(7);
    expect(entry.outcome).toEqual({ dryRun: false, exitCode: 0 });
  });
});

describe("concludeGatedOperation", () => {
  it("reconciles the metered cost against the outcome's own cost and records the summarized tokens/cost", async () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend({
      tokensThisRun: 30,
      loopIterations: 1,
      costThisRun: 2.5,
    });
    const { recorder, writer } = makeRecorder();
    const decision = realDecision();
    const setup = makeSetup({
      ledger,
      recorder,
      decision,
      iterations: [makeIteration(30)],
    });
    const outcome = makeOutcome({ cost: 2.5 });

    await concludeGatedOperation(setup, outcome);

    expect(writer.entries).toHaveLength(1);
    const entry = writer.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("expected one written entry");
    expect(entry.tokens).toBe(30);
    expect(entry.cost).toBe(2.5);
  });

  it("propagates reconcileMeteredCost's mismatch failure and never reaches recordConclusion", async () => {
    const ledger = new AgentRunLedger();
    ledger.observeSpend({
      tokensThisRun: 30,
      loopIterations: 1,
      costThisRun: 2.5,
    });
    const { recorder, writer } = makeRecorder();
    const setup = makeSetup({
      ledger,
      recorder,
      iterations: [makeIteration(30)],
    });
    // Diverges from the ledger's 2.5 by far more than the reconciliation
    // tolerance — the library's figure is treated as the oracle.
    const outcome = makeOutcome({ cost: 99 });

    let thrown: unknown;
    try {
      await concludeGatedOperation(setup, outcome);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
    expect(writer.entries).toHaveLength(0);
  });
});
