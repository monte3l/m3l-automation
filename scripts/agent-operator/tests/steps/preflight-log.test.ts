/**
 * Tests for `steps/preflight-log` — the decision-log bootstrap.
 *
 * Written RED, before `steps/preflight-log.ts` existed; the module now exists
 * and these tests pass, so they stand as the regression pin on its contract —
 * except where noted below, where they are RED again for the CONCLUDING-entry
 * requirement: the re-evaluated decision must be recorded too, so the durable
 * audit trail carries the verdict the run actually ended on and not only the
 * bootstrap verdict it started from.
 *
 * The problem it solves: under `requireDecisionLog: true` the FIRST evaluation
 * of a run necessarily has `decisionLogAvailable` absent, so it escalates on
 * `decision-log-unavailable.unobservable` and the agent can never act. The
 * resolution is **not** to seed the observation:
 *
 * 1. Evaluate the bootstrap action honestly against the virgin ledger. It
 *    escalates — truthfully.
 * 2. **Write that decision. The write IS the observation.**
 * 3. `observeDecisionLog(true)`, then re-evaluate against the observed ledger.
 *
 * The contract these tests define:
 *
 * ```ts
 * export interface AgentPreflightOptions {
 *   readonly policy: Core.M3LAgentPolicy;
 *   readonly ledger: AgentRunLedger;
 *   readonly recorder: AgentDecisionRecorder;
 *   readonly action: Core.M3LAgentAction;
 *   readonly now: number;
 * }
 * export interface AgentPreflightResult {
 *   readonly bootstrapDecision: Core.M3LAgentDecision; // phase 1, honest
 *   readonly decision: Core.M3LAgentDecision;          // phase 3, re-evaluated
 *   readonly entry: Core.M3LAgentDecisionLogEntry;      // what phase 2 wrote
 * }
 * export function runDecisionLogPreflight(
 *   options: AgentPreflightOptions,
 * ): Promise<AgentPreflightResult>;
 * ```
 *
 * The evaluator and the entry builder are the real library functions
 * throughout; the only seam faked here is the `AgentDecisionLogWriter` port, so
 * no real file is written.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LAgentOperatorCliError } from "../../src/lib/errors.js";
import {
  AgentDecisionRecorder,
  agentIdentity,
  type AgentDecisionLogWriter,
} from "../../src/steps/decision-recorder.js";
import { runDecisionLogPreflight } from "../../src/steps/preflight-log.js";
import { AgentRunLedger } from "../../src/steps/run-ledger.js";
import {
  budgetPolicy,
  decisionLogPolicy,
  realAgentPolicy,
} from "../support/policyFixtures.js";

/** A fixed, caller-sampled instant. */
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

/** The read-only bootstrap action the preflight judges. */
function bootstrapAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "health-check",
    kind: "read-only",
    parameterNames: ["command"],
  };
}

/** Records every write, and lets a test probe state at the moment of the write. */
class ProbingWriter implements AgentDecisionLogWriter {
  readonly entries: Core.M3LAgentDecisionLogEntry[] = [];

  constructor(private readonly onWrite: () => void = () => undefined) {}

  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    this.onWrite();
    return Promise.resolve();
  }
}

/** Records the attempt, then rejects — the "the log is not writable" seam. */
class FailingWriter implements AgentDecisionLogWriter {
  readonly entries: Core.M3LAgentDecisionLogEntry[] = [];

  constructor(private readonly onWrite: () => void = () => undefined) {}

  write(entry: Core.M3LAgentDecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    this.onWrite();
    return Promise.reject(
      new Core.M3LAgentDecisionLogWriteError("append failed: EACCES"),
    );
  }
}

/**
 * A ledger whose `observeDecisionLog` calls are appended to `calls` and then
 * delegated to the real implementation — the single shared, ordered call list
 * every ordering assertion below reads. Spying on the injected collaborator
 * (never on the code under test) keeps ordering *asserted* rather than
 * inferred from a side effect's final state.
 */
function ledgerRecordingInto(calls: string[]): AgentRunLedger {
  const ledger = new AgentRunLedger();
  const original: (available: boolean) => void =
    ledger.observeDecisionLog.bind(ledger);
  vi.spyOn(ledger, "observeDecisionLog").mockImplementation(
    (available: boolean) => {
      calls.push(`observeDecisionLog:${String(available)}`);
      original(available);
    },
  );
  return ledger;
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

function makeRecorder(writer: AgentDecisionLogWriter): AgentDecisionRecorder {
  return new AgentDecisionRecorder({
    identity: agentIdentity({ name: "agent-operator" }),
    writer,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runDecisionLogPreflight — phase 1 is honest", () => {
  it("escalates on decision-log-unavailable.unobservable against the virgin ledger", async () => {
    const ledger = new AgentRunLedger();
    const writer = new ProbingWriter();

    const result = await runDecisionLogPreflight({
      policy: decisionLogPolicy(),
      ledger,
      recorder: makeRecorder(writer),
      action: bootstrapAction(),
      now: NOW,
    });

    // The truthful first verdict: the discipline is declared, and at this
    // point in the run nothing has proven it satisfied.
    expect(result.bootstrapDecision.verdict).toBe("escalate");
    expect(result.bootstrapDecision.rule).toBe(
      "decision-log-unavailable.unobservable",
    );
    expect(Core.isAgentActionAutoApproved(result.bootstrapDecision)).toBe(
      false,
    );
  });

  it("has NOT seeded decisionLogAvailable at the moment the entry is written", async () => {
    // The defect this guards: seeding `decisionLogAvailable = true` before the
    // write makes phase 1 auto-approve and the whole bootstrap becomes a lie
    // — and every other test in this file would still pass.
    const observedAtWriteTime: boolean[] = [];
    const ledger = new AgentRunLedger();
    const writer = new ProbingWriter(() => {
      observedAtWriteTime.push(
        Object.hasOwn(ledger.snapshot(NOW), "decisionLogAvailable"),
      );
    });

    await runDecisionLogPreflight({
      policy: decisionLogPolicy(),
      ledger,
      recorder: makeRecorder(writer),
      action: bootstrapAction(),
      now: NOW,
    });

    // Intent unchanged, list widened: the FIRST write (the bootstrap entry) is
    // the one that must not see a seeded observation. The second element is
    // the concluding entry, written after `observeDecisionLog(true)` — so
    // `true` there is correct, and pinning the whole list keeps the ordering
    // asserted rather than merely the first element spot-checked.
    expect(observedAtWriteTime).toEqual([false, true]);
  });

  it("writes two entries: the honest bootstrap escalation and the concluding verdict", async () => {
    // Was "writes exactly one entry": the bootstrap decision alone reached the
    // log, so an operator reading the audit trail saw the verdict the run
    // STARTED from and never the one it ended on. Both are recorded now — and
    // "exactly", the original intent, is preserved as an exact length of two,
    // so a duplicate or a dropped write still fails.
    const writer = new ProbingWriter();

    const result = await runDecisionLogPreflight({
      policy: decisionLogPolicy(),
      ledger: new AgentRunLedger(),
      recorder: makeRecorder(writer),
      action: bootstrapAction(),
      now: NOW,
    });

    expect(writer.entries).toHaveLength(2);
    expect(writer.entries[0]).toBe(result.entry);
    expect(result.entry.verdict).toBe("escalate");
    expect(result.entry.rule).toBe("decision-log-unavailable.unobservable");

    // The concluding entry records the re-evaluated decision verbatim — the
    // verdict the caller goes on to act upon.
    const conclusion = writer.entries[1];
    expect(conclusion?.verdict).toBe(result.decision.verdict);
    expect(conclusion?.rule).toBe(result.decision.rule);
    expect(conclusion?.reason).toBe(result.decision.reason);
    // Not a second copy of the bootstrap: under this policy the conclusion is
    // genuinely auto-approved, so the two entries must differ.
    expect(conclusion?.verdict).not.toBe(result.entry.verdict);
  });
});

describe("runDecisionLogPreflight — the write is the observation", () => {
  it("writes first, then observes the log as available", async () => {
    const calls: string[] = [];
    const ledger = ledgerRecordingInto(calls);
    const writer = new ProbingWriter(() => {
      calls.push("write");
    });

    await runDecisionLogPreflight({
      policy: decisionLogPolicy(),
      ledger,
      recorder: makeRecorder(writer),
      action: bootstrapAction(),
      now: NOW,
    });

    // Both arms are reachable in this setup: the ledger really is virgin, so a
    // preflight that observed first would produce the reversed list. The
    // trailing write is the concluding entry — recorded after the
    // re-evaluation, which is the only point at which the concluding verdict
    // exists.
    expect(calls).toEqual(["write", "observeDecisionLog:true", "write"]);
  });

  it("leaves the ledger observing an available log", async () => {
    const ledger = new AgentRunLedger();

    await runDecisionLogPreflight({
      policy: decisionLogPolicy(),
      ledger,
      recorder: makeRecorder(new ProbingWriter()),
      action: bootstrapAction(),
      now: NOW,
    });

    const snapshot = ledger.snapshot(NOW);
    expect(Object.hasOwn(snapshot, "decisionLogAvailable")).toBe(true);
    expect(snapshot.decisionLogAvailable).toBe(true);
  });

  it("clears the decision-log rules on the re-evaluated decision", async () => {
    const result = await runDecisionLogPreflight({
      policy: decisionLogPolicy(),
      ledger: new AgentRunLedger(),
      recorder: makeRecorder(new ProbingWriter()),
      action: bootstrapAction(),
      now: NOW,
    });

    expect(result.decision.rule).not.toBe("decision-log-unavailable");
    expect(result.decision.rule).not.toBe(
      "decision-log-unavailable.unobservable",
    );
    // With no budgets declared, a read-only granted action is now genuinely
    // auto-approved — the bootstrap resolved the only blocking rule.
    expect(Core.isAgentActionAutoApproved(result.decision)).toBe(true);
  });
});

describe("runDecisionLogPreflight — an honest limitation, pinned not hidden", () => {
  it("still escalates under the committed policy, because this slice meters nothing", async () => {
    // `data/input/agent-policy.json` declares all five budgets. This slice has
    // no token/cost metering and no cross-run day counter, so those
    // observations are absent and the corresponding ceilings stay
    // unobservable. The preflight resolves the DECISION-LOG rule only; it does
    // not make the run broadly authorized, and nothing here should read as if
    // it did.
    const result = await runDecisionLogPreflight({
      policy: await realAgentPolicy(),
      ledger: new AgentRunLedger(),
      recorder: makeRecorder(new ProbingWriter()),
      action: bootstrapAction(),
      now: NOW,
    });

    // The decision-log rules HAVE stopped firing — the bootstrap did its one
    // job …
    expect(result.decision.rule).not.toBe("decision-log-unavailable");
    expect(result.decision.rule).not.toBe(
      "decision-log-unavailable.unobservable",
    );
    // … and the run is still not authorized, because a budget the deployment
    // declared remains unobservable. A future "fix" that seeded
    // `decisionLogAvailable = true`, or defaulted a budget observation to 0,
    // would turn this escalation into an auto-approval.
    expect(result.decision.verdict).toBe("escalate");
    expect(result.decision.rule).toMatch(/^budget\..+\.unobservable$/);
    expect(Core.isAgentActionAutoApproved(result.decision)).toBe(false);
    // …and phase 1 is equally honest: budgets (step 3) are judged before the
    // decision-log escalation (step 3b), so under this policy the bootstrap
    // decision names a budget rule, not the log rule. The entry is written
    // regardless — the audit record is of whatever was truly decided.
    expect(result.bootstrapDecision.verdict).toBe("escalate");
    expect(result.bootstrapDecision.rule).toMatch(/\.unobservable$/);
  });

  it.each([
    ["tokensPerRun", { tokensPerRun: 200_000 }, "budget.tokens-per-run"],
    ["costPerRun", { costPerRun: 2 }, "budget.cost-per-run"],
  ])(
    "leaves a declared %s unobservable after a successful preflight",
    async (_label, budgets, ruleStem) => {
      const ledger = new AgentRunLedger();

      const result = await runDecisionLogPreflight({
        policy: budgetPolicy(budgets),
        ledger,
        recorder: makeRecorder(new ProbingWriter()),
        action: bootstrapAction(),
        now: NOW,
      });

      expect(result.decision.rule).toBe(`${ruleStem}.unobservable`);
      // The mechanism, asserted directly: no metering means no observation,
      // and an absent observation must never be reported as 0.
      const snapshot = ledger.snapshot(NOW);
      expect(Object.hasOwn(snapshot, "tokensThisRun")).toBe(false);
      expect(Object.hasOwn(snapshot, "costThisRun")).toBe(false);
    },
  );
});

describe("runDecisionLogPreflight — a failed write aborts the preflight", () => {
  it("propagates the failure instead of continuing with an unobserved log", async () => {
    const calls: string[] = [];
    const ledger = ledgerRecordingInto(calls);
    const writer = new FailingWriter(() => {
      calls.push("write");
    });

    const thrown = await captureRejection(() =>
      runDecisionLogPreflight({
        policy: decisionLogPolicy(),
        ledger,
        recorder: makeRecorder(writer),
        action: bootstrapAction(),
        now: NOW,
      }),
    );

    expect(thrown).toBeInstanceOf(M3LAgentOperatorCliError);
    expect((thrown as M3LAgentOperatorCliError).code).toBe(
      "ERR_AGENT_OPERATOR_DECISION_LOG",
    );
    expect((thrown as M3LAgentOperatorCliError).cause).toBeInstanceOf(
      Core.M3LAgentDecisionLogWriteError,
    );
  });

  it("stops at the write — nothing observes, re-evaluates, or proceeds", async () => {
    const calls: string[] = [];
    const ledger = ledgerRecordingInto(calls);
    const writer = new FailingWriter(() => {
      calls.push("write");
    });

    await captureRejection(() =>
      runDecisionLogPreflight({
        policy: decisionLogPolicy(),
        ledger,
        recorder: makeRecorder(writer),
        action: bootstrapAction(),
        now: NOW,
      }),
    );

    // The abort ordering, read off the one shared call list: the write was
    // attempted and NOTHING ran after it. In a later slice the next step is
    // constructing a Bedrock client, so this list is the guarantee that a
    // run whose audit trail cannot be written never reaches the model.
    expect(calls).toEqual(["write"]);
    expect(writer.entries).toHaveLength(1);
    // The log stays unobserved, so a caller that (correctly) marks it
    // unavailable is recording a state the ledger has not contradicted.
    expect(Object.hasOwn(ledger.snapshot(NOW), "decisionLogAvailable")).toBe(
      false,
    );
  });

  it("lets the caller mark the log unavailable after the failure", async () => {
    const ledger = new AgentRunLedger();
    const writer = new FailingWriter();

    await captureRejection(() =>
      runDecisionLogPreflight({
        policy: decisionLogPolicy(),
        ledger,
        recorder: makeRecorder(writer),
        action: bootstrapAction(),
        now: NOW,
      }),
    );
    ledger.observeDecisionLog(false);

    // Observed-unavailable is a different verdict from unobserved: the hard
    // rule, not the `.unobservable` one.
    const decision = Core.evaluateAgentAction({
      action: bootstrapAction(),
      policy: decisionLogPolicy(),
      run: ledger.snapshot(NOW),
    });
    expect(decision.rule).toBe("decision-log-unavailable");
  });
});
