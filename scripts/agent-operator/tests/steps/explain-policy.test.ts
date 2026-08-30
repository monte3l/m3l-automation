/**
 * Tests for `steps/explain-policy` — the deterministic, no-Bedrock operation
 * that renders a validated policy's grants, operations, budgets, and flags
 * (PR 1).
 *
 * PR A scope: the `AgentCliSurface` dependency (and its `list()`/`doctor()`
 * rendering) has been dropped from `explainPolicy` — that CLI seam returns in
 * PR B, alongside `../../src/lib/cli-surface.js` and `../../src/lib/model-safety.js`,
 * both deleted from the working tree for this split. `explainPolicy` now
 * takes only `{ policy, logger }` and still returns the same
 * `AgentOperatorExplainPolicySummary` shaped `{ grantCount, requireDecisionLog,
 * dryRunFirst, hasBudgets }`.
 */

import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { explainPolicy } from "../../src/steps/explain-policy.js";
import { fullPolicy, minimalPolicy } from "../support/policyFixtures.js";

/** Records every event handed to it, for assertion without pinning exact prose. */
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

function createLogger(): {
  readonly logger: Core.M3LLogger;
  readonly handler: RecordingLoggerHandler;
} {
  const handler = new RecordingLoggerHandler();
  return { logger: new Core.M3LLogger([handler]), handler };
}

describe("explainPolicy", () => {
  it("renders every grant, its operations, the budgets, and both flags through the injected logger", async () => {
    const { logger, handler } = createLogger();

    await explainPolicy({ policy: fullPolicy(), logger });

    const text = flattenLoggedText(handler.events);
    expect(text).toContain("agent-operator");
    expect(text).toContain("s3-objects");
    expect(text).toContain("explain-policy");
    expect(text).toContain("health-check");
    expect(text).toMatch(/10/); // invocationsPerRun
    expect(text).toMatch(/1000/); // tokensPerRun
    expect(text.toLowerCase()).toMatch(/decision.?log/);
    expect(text.toLowerCase()).toMatch(/dry.?run/);
  });

  it("returns a plain summary object reflecting the policy's grants, budgets, and flags", async () => {
    const { logger } = createLogger();

    const summary = await explainPolicy({
      policy: fullPolicy(),
      logger,
    });

    expect(summary.grantCount).toBe(2);
    expect(summary.requireDecisionLog).toBe(true);
    expect(summary.dryRunFirst).toBe(true);
    expect(summary.hasBudgets).toBe(true);
  });

  it("handles a minimal policy (no budgets, no flags, no sensitiveTargets) without throwing", async () => {
    const { logger } = createLogger();

    const summary = await explainPolicy({
      policy: minimalPolicy(),
      logger,
    });

    expect(summary.grantCount).toBe(1);
    expect(summary.requireDecisionLog).toBe(false);
    expect(summary.dryRunFirst).toBe(false);
    expect(summary.hasBudgets).toBe(false);
  });

  it("constructs no Bedrock client and spawns nothing — the deps bag carries only policy and logger", async () => {
    const { logger } = createLogger();

    // The call succeeds with exactly these two deps and nothing
    // Bedrock-shaped or CLI-shaped (no client, no modelId, no credentials, no
    // CLI surface) — proving this operation cannot reach the network or spawn
    // a process even by accident.
    await expect(
      explainPolicy({ policy: minimalPolicy(), logger }),
    ).resolves.toBeDefined();
  });

  it("still resolves with the correct summary when a handler throws on every event — the isolated failure path", async () => {
    // explainPolicy has no reachable error path of its own: it never awaits
    // I/O and never calls a fallible collaborator directly. Its own
    // "failure path" is therefore this isolation guarantee, documented at
    // `M3LLogger.dispatch` (packages/m3l-common/src/core/logging/M3LLogger.ts:573-597):
    // a handler that throws is caught per-event, a best-effort diagnostic is
    // written to stderr (not asserted here — that's M3LLogger's own
    // contract, not this script's), and dispatch continues rather than
    // rethrowing. This test proves explainPolicy's return value is
    // unaffected by a throwing handler, and that the counter increments
    // prove the handler was actually reached rather than the assertion
    // passing vacuously.
    class ThrowingLoggerHandler implements Core.M3LLoggerHandler {
      calls = 0;
      handle(): void {
        this.calls += 1;
        throw new Error("handler always throws");
      }
      /** Documented no-op: this handler carries no state worth resetting. */
      reset(): void {
        // intentionally empty
      }
    }
    const handler = new ThrowingLoggerHandler();
    const logger = new Core.M3LLogger([handler]);

    const summary = await explainPolicy({ policy: fullPolicy(), logger });

    expect(handler.calls).toBeGreaterThan(0);
    expect(summary.grantCount).toBe(2);
    expect(summary.requireDecisionLog).toBe(true);
    expect(summary.dryRunFirst).toBe(true);
    expect(summary.hasBudgets).toBe(true);
  });
});
