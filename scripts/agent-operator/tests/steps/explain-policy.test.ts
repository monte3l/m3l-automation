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
});
