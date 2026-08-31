/**
 * Tests for `steps/metering-invoker` — the `AWS.M3LBedrockToolLoopInvoker`
 * decorator that observes every Bedrock turn's usage/cost onto an
 * `AgentRunLedger` (V8 final slice, contract § B).
 *
 * Written RED, before `steps/metering-invoker.ts` exists: these tests define
 * the contract, not a description of work already done.
 *
 * The contract these tests pin:
 *
 * ```ts
 * export interface CreateMeteredInvokerOptions {
 *   readonly inner: AWS.M3LBedrockToolLoopInvoker;
 *   readonly ledger: AgentRunLedger;
 *   readonly rates: ReadonlyMap<string, AWS.M3LBedrockModelRate>;
 * }
 * export interface MeteredInvoker {
 *   readonly invoker: AWS.M3LBedrockToolLoopInvoker;
 *   observedIterations(): readonly AWS.M3LBedrockToolLoopIteration[];
 * }
 * export function createMeteredInvoker(
 *   options: CreateMeteredInvokerOptions,
 * ): MeteredInvoker;
 * ```
 *
 * Two structural guarantees drive nearly every assertion below:
 *
 * 1. **Zero spend must be an OBSERVED fact, not an assumption.** Constructing
 *    `createMeteredInvoker` immediately seeds the ledger with
 *    `{ tokensThisRun: 0, loopIterations: 0, costThisRun: ... }` — before any
 *    turn runs — which is what makes a budget-declaring policy observable
 *    (rather than escalating on `.unobservable`) from the moment the loop is
 *    wired up.
 * 2. **Cost is all-or-nothing over the WHOLE served run, never a partial
 *    sum.** The moment any served `modelId` lacks a `rates` entry,
 *    `costThisRun` goes unobservable for every subsequent snapshot — not just
 *    for that one turn.
 *
 * `Core.evaluateAgentAction` is exercised for real (never faked) via
 * `tests/support/policyFixtures.ts`'s `budgetPolicy`, so the assertion is on
 * `decision.rule` — the rule id is the contract, the snapshot is only the
 * mechanism.
 */

import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import {
  createFakeBedrockToolLoopInvoker,
  makeBedrockInvocationResult,
  makeBedrockModelRate,
  makeBedrockToolInvokeRequest,
  makeBedrockTokenUsage,
} from "../support/bedrockFakes.js";
import { budgetPolicy } from "../support/policyFixtures.js";

// The module under test does not exist yet (RED); this import is expected to
// fail to resolve until `code-implementer` adds it.
import {
  createMeteredInvoker,
  reconcileMeteredCost,
} from "../../src/steps/metering-invoker.js";
import type {
  CreateMeteredInvokerOptions,
  MeteredInvoker,
} from "../../src/steps/metering-invoker.js";

/** A fixed, caller-sampled instant — the ledger and evaluator never read a clock. */
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

/** The health-check action, granted by {@link budgetPolicy}'s script grant. */
function healthCheckAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "health-check",
    kind: "read-only",
    parameterNames: [],
  };
}

/** Builds a {@link CreateMeteredInvokerOptions} with sane defaults. */
function buildOptions(
  overrides: Partial<CreateMeteredInvokerOptions> = {},
): CreateMeteredInvokerOptions {
  return {
    inner: createFakeBedrockToolLoopInvoker().invoker,
    ledger: new AgentRunLedger(),
    rates: new Map<string, AWS.M3LBedrockModelRate>(),
    ...overrides,
  };
}

describe("createMeteredInvoker — seeding makes zero spend an observed fact", () => {
  it("seeds tokensThisRun and loopIterations at 0, and costThisRun at 0, the moment it is constructed — before any invoke() call", () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();
    const rates = new Map([["model-a", makeBedrockModelRate()]]);

    createMeteredInvoker({ inner: fake.invoker, ledger, rates });

    expect(fake.calls).toHaveLength(0);
    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "tokensThisRun")).toBe(true);
    expect(snapshot.tokensThisRun).toBe(0);
    expect(Object.hasOwn(snapshot, "loopIterations")).toBe(true);
    expect(snapshot.loopIterations).toBe(0);
    expect(Object.hasOwn(snapshot, "costThisRun")).toBe(true);
    expect(snapshot.costThisRun).toBe(0);
  });

  // computeCost([], rates) is 0 for ANY defined rates map, empty or not,
  // because the loop over zero iterations never reaches a missing-rate
  // check — only a served modelId with no matching rate can make cost
  // unobservable, and there is no served modelId yet at construction time.
  it("seeds costThisRun at 0, not unobservable, even when the rates map is empty", () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();

    createMeteredInvoker({
      inner: fake.invoker,
      ledger,
      rates: new Map<string, AWS.M3LBedrockModelRate>(),
    });

    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "costThisRun")).toBe(true);
    expect(snapshot.costThisRun).toBe(0);
  });

  it("the seeded zero spend auto-approves a policy declaring the same three budgets", () => {
    const ledger = new AgentRunLedger();
    ledger.observeDecisionLog(true);
    const fake = createFakeBedrockToolLoopInvoker();
    const rates = new Map([["model-a", makeBedrockModelRate()]]);

    createMeteredInvoker({ inner: fake.invoker, ledger, rates });

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: budgetPolicy({
        tokensPerRun: 1000,
        costPerRun: 5,
        loopIterations: 10,
      }),
      run: ledger.snapshot(NOW),
    });

    expect(Core.isAgentActionAutoApproved(decision)).toBe(true);
  });
});

describe("createMeteredInvoker — invoke() delegates unchanged", () => {
  it("passes the exact request and options through to inner.invoke", async () => {
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(makeBedrockInvocationResult());
    const meteredInvoker: MeteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker }),
    );
    const request = makeBedrockToolInvokeRequest({
      system: "a distinguishing marker",
    });
    const signal = new AbortController().signal;

    await meteredInvoker.invoker.invoke(request, { signal });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.request).toBe(request);
    expect(fake.calls[0]?.options).toEqual({ signal });
  });

  it("passes through an omitted options argument as undefined, not a fabricated bag", async () => {
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(makeBedrockInvocationResult());
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    expect(fake.calls[0]?.options).toBeUndefined();
  });

  it("resolves with the exact result inner.invoke resolved with", async () => {
    const fake = createFakeBedrockToolLoopInvoker();
    const result = makeBedrockInvocationResult({ modelId: "model-marker" });
    fake.enqueueResult(result);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker }),
    );

    await expect(
      meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest()),
    ).resolves.toBe(result);
  });
});

describe("createMeteredInvoker — synthesized iteration ledger", () => {
  it("appends a 1-based iteration per resolved invoke(), with toolExecutions always empty", async () => {
    const fake = createFakeBedrockToolLoopInvoker();
    const first = makeBedrockInvocationResult({
      modelId: "model-a",
      stopReason: "tool_use",
      usage: makeBedrockTokenUsage({ inputTokens: 10, outputTokens: 5 }),
    });
    const second = makeBedrockInvocationResult({
      modelId: "model-a",
      stopReason: "end_turn",
      usage: makeBedrockTokenUsage({ inputTokens: 20, outputTokens: 8 }),
    });
    fake.enqueueResult(first);
    fake.enqueueResult(second);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());
    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    const iterations = meteredInvoker.observedIterations();
    expect(iterations).toHaveLength(2);
    expect(iterations[0]).toEqual({
      index: 1,
      modelId: "model-a",
      stopReason: "tool_use",
      usage: first.usage,
      toolExecutions: [],
    });
    expect(iterations[1]).toEqual({
      index: 2,
      modelId: "model-a",
      stopReason: "end_turn",
      usage: second.usage,
      toolExecutions: [],
    });
  });

  it("returns a frozen array from observedIterations()", async () => {
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(makeBedrockInvocationResult());
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    expect(Object.isFrozen(meteredInvoker.observedIterations())).toBe(true);
  });
});

describe("createMeteredInvoker — recomputed totals", () => {
  it("sums tokensThisRun as usage.totalTokens across every turn, and sets loopIterations to the turn count", async () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(
      makeBedrockInvocationResult({
        usage: makeBedrockTokenUsage({ inputTokens: 10, outputTokens: 5 }),
      }),
    );
    fake.enqueueResult(
      makeBedrockInvocationResult({
        usage: makeBedrockTokenUsage({ inputTokens: 20, outputTokens: 8 }),
      }),
    );
    fake.enqueueResult(
      makeBedrockInvocationResult({
        usage: makeBedrockTokenUsage({ inputTokens: 3, outputTokens: 1 }),
      }),
    );
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker, ledger }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());
    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());
    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    const snapshot = ledger.snapshot(NOW);
    expect(snapshot.tokensThisRun).toBe(15 + 28 + 4);
    expect(snapshot.loopIterations).toBe(3);
  });

  it("computes costThisRun using each served model's own rate, matching the per-1k-token formula", async () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();
    // inputPer1kTokens: 3, outputPer1kTokens: 15 (the fixture default).
    // (100/1000)*3 + (50/1000)*15 = 0.3 + 0.75 = 1.05 per turn.
    fake.enqueueResult(
      makeBedrockInvocationResult({
        modelId: "model-a",
        usage: makeBedrockTokenUsage({ inputTokens: 100, outputTokens: 50 }),
      }),
    );
    fake.enqueueResult(
      makeBedrockInvocationResult({
        modelId: "model-a",
        usage: makeBedrockTokenUsage({ inputTokens: 100, outputTokens: 50 }),
      }),
    );
    const rates = new Map([["model-a", makeBedrockModelRate()]]);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker, ledger, rates }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());
    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    expect(ledger.snapshot(NOW).costThisRun).toBeCloseTo(2.1, 10);
  });

  it("[unobservable cost] an empty rates map yields costThisRun omitted after a real turn, escalating on budget.cost-per-run.unobservable — not a silent pass at cost 0", async () => {
    const ledger = new AgentRunLedger();
    ledger.observeDecisionLog(true);
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(makeBedrockInvocationResult({ modelId: "model-a" }));
    const meteredInvoker = createMeteredInvoker(
      buildOptions({
        inner: fake.invoker,
        ledger,
        rates: new Map<string, AWS.M3LBedrockModelRate>(),
      }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "costThisRun")).toBe(false);

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: budgetPolicy({ costPerRun: 5 }),
      run: snapshot,
    });
    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("budget.cost-per-run.unobservable");
  });

  it("[unobservable cost — no partial sum] a rates map missing ONE served modelId yields cost omitted, even though the OTHER model has a rate", async () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(
      makeBedrockInvocationResult({ modelId: "model-with-rate" }),
    );
    fake.enqueueResult(
      makeBedrockInvocationResult({ modelId: "model-without-rate" }),
    );
    const rates = new Map([["model-with-rate", makeBedrockModelRate()]]);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker, ledger, rates }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());
    // Cost is observable after the first (priced) turn alone.
    expect(Object.hasOwn(ledger.snapshot(NOW), "costThisRun")).toBe(true);

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    // The moment the second (unpriced) model is served, cost across the
    // WHOLE run — including the already-priced first turn — goes
    // unobservable. A partial sum over just the priced turn would be a
    // silent under-count.
    expect(Object.hasOwn(ledger.snapshot(NOW), "costThisRun")).toBe(false);
  });

  it("a served modelId missing from rates yields costThisRun omitted, and the real evaluator escalates on budget.cost-per-run.unobservable", async () => {
    const ledger = new AgentRunLedger();
    ledger.observeDecisionLog(true);
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(
      makeBedrockInvocationResult({ modelId: "model-with-rate" }),
    );
    fake.enqueueResult(
      makeBedrockInvocationResult({ modelId: "model-without-rate" }),
    );
    const rates = new Map([["model-with-rate", makeBedrockModelRate()]]);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker, ledger, rates }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());
    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "costThisRun")).toBe(false);

    const decision = Core.evaluateAgentAction({
      action: healthCheckAction(),
      policy: budgetPolicy({ costPerRun: 5 }),
      run: snapshot,
    });
    expect(decision.verdict).toBe("escalate");
    expect(decision.rule).toBe("budget.cost-per-run.unobservable");
  });

  // [BLENDED-RATE GUARD] The specific bug this guards: averaging the two
  // models' rates and applying the average to combined totals would yield a
  // DIFFERENT (wrong) number than pricing each turn with its own served
  // model's rate. Equal rates across turns cannot distinguish the two
  // formulas, so this test deliberately uses unequal rates.
  it("[blended-rate guard] prices a two-turn run that changed modelId mid-way using EACH turn's own rate, not a blended average", async () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueResult(
      makeBedrockInvocationResult({
        modelId: "model-cheap",
        usage: makeBedrockTokenUsage({ inputTokens: 1000, outputTokens: 0 }),
      }),
    );
    fake.enqueueResult(
      makeBedrockInvocationResult({
        modelId: "model-expensive",
        usage: makeBedrockTokenUsage({ inputTokens: 0, outputTokens: 1000 }),
      }),
    );
    const rates = new Map([
      [
        "model-cheap",
        makeBedrockModelRate({ inputPer1kTokens: 2, outputPer1kTokens: 10 }),
      ],
      [
        "model-expensive",
        makeBedrockModelRate({ inputPer1kTokens: 6, outputPer1kTokens: 30 }),
      ],
    ]);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker, ledger, rates }),
    );

    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());
    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    // Correct (own-rate-per-turn): (1000/1000)*2 + (1000/1000)*30 = 32.
    // A blended-rate bug would instead average the two rates (4 input,
    // 20 output) and apply them to the combined 1000/1000 totals:
    // (1000/1000)*4 + (1000/1000)*20 = 24 — a different, wrong number.
    expect(ledger.snapshot(NOW).costThisRun).toBe(32);
  });
});

describe("createMeteredInvoker — a rejected invoke() is never metered", () => {
  it("rethrows the exact rejection reason, unmodified", async () => {
    const fake = createFakeBedrockToolLoopInvoker();
    const failure = new Error("bedrock unavailable");
    fake.enqueueRejection(failure);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker }),
    );

    await expect(
      meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest()),
    ).rejects.toBe(failure);
  });

  it("records nothing on rejection: observedIterations stays empty and the ledger keeps its seeded zero totals", async () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueRejection(new Error("bedrock unavailable"));
    const rates = new Map([["model-a", makeBedrockModelRate()]]);
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker, ledger, rates }),
    );

    await expect(
      meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest()),
    ).rejects.toThrow("bedrock unavailable");

    expect(meteredInvoker.observedIterations()).toHaveLength(0);
    const snapshot = ledger.snapshot(NOW);
    expect(snapshot.tokensThisRun).toBe(0);
    expect(snapshot.loopIterations).toBe(0);
    expect(snapshot.costThisRun).toBe(0);
  });

  it("still meters a later successful invoke() after an earlier rejection", async () => {
    const ledger = new AgentRunLedger();
    const fake = createFakeBedrockToolLoopInvoker();
    fake.enqueueRejection(new Error("transient failure"));
    fake.enqueueResult(
      makeBedrockInvocationResult({
        usage: makeBedrockTokenUsage({ inputTokens: 10, outputTokens: 5 }),
      }),
    );
    const meteredInvoker = createMeteredInvoker(
      buildOptions({ inner: fake.invoker, ledger }),
    );

    await expect(
      meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest()),
    ).rejects.toThrow("transient failure");
    await meteredInvoker.invoker.invoke(makeBedrockToolInvokeRequest());

    expect(meteredInvoker.observedIterations()).toHaveLength(1);
    expect(ledger.snapshot(NOW).loopIterations).toBe(1);
  });
});

describe("reconcileMeteredCost — the loop's own outcome.cost is the oracle", () => {
  it("agrees when both metered and reported are undefined (cost unobservable on both sides)", () => {
    expect(() => {
      reconcileMeteredCost({ metered: undefined, reported: undefined });
    }).not.toThrow();
  });

  it("throws when metered is a number but reported is undefined (one-sided divergence)", () => {
    let thrown: unknown;
    try {
      reconcileMeteredCost({ metered: 1.5, reported: undefined });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it("throws when reported is a number but metered is undefined (the other one-sided direction)", () => {
    let thrown: unknown;
    try {
      reconcileMeteredCost({ metered: undefined, reported: 1.5 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });

  it("agrees when both are numbers within the 1e-9 tolerance", () => {
    expect(() => {
      reconcileMeteredCost({ metered: 1.234567891, reported: 1.23456789 });
    }).not.toThrow();
  });

  it("throws when both are numbers but diverge beyond the tolerance", () => {
    let thrown: unknown;
    try {
      reconcileMeteredCost({ metered: 1, reported: 1.1 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  });
});
