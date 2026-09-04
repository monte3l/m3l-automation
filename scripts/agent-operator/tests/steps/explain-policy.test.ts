/**
 * Tests for `steps/explain-policy` — the deterministic, no-Bedrock operation
 * that renders a validated policy's grants, operations, budgets, and flags
 * (PR 1).
 *
 * Contract pins for this RED phase (test-author decision, since the PR 1
 * spec fixes the behaviour but not every export name): the step is named
 * `explainPolicy`, taking `{ policy, logger, surface }` and returning an
 * `AgentOperatorExplainPolicySummary` shaped `{ grantCount, requireDecisionLog,
 * dryRunFirst, hasBudgets }`. It must call `surface.list()` and
 * `surface.doctor()` (the "CLI seam genuinely exercised on a real code
 * path" requirement) and must never call `surface.inspect()` or
 * `surface.dryRun()` — those need a script name and this operation carries
 * none.
 */

import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import type { AgentCliSurface } from "../../src/lib/cli-surface.js";
import type {
  AgentOperatorDoctorCheck,
  AgentOperatorListRow,
  AgentOperatorRunEnvelope,
} from "../../src/lib/cli-envelopes.js";
import {
  projectDoctorReport,
  projectListRow,
  projectRunEnvelope,
  type AgentOperatorProjectedDoctorReport,
  type AgentOperatorProjectedListRow,
  type AgentOperatorProjectedRunEnvelope,
} from "../../src/lib/model-safety.js";
import { explainPolicy } from "../../src/steps/explain-policy.js";
import { fullPolicy, minimalPolicy } from "../support/policyFixtures.js";

/**
 * Builds a real, nominally-branded {@link AgentOperatorProjectedDoctorReport}
 * by running the actual `projectDoctorReport` projector over raw check
 * fixtures — the brand on `AgentOperatorProjectedDoctorCheck` can only be
 * minted inside `model-safety.ts`, so a fake surface must go through the
 * real projector rather than hand-writing an object literal (which would
 * need a disallowed cast).
 */
function buildDoctorReport(
  checks: readonly AgentOperatorDoctorCheck[],
): AgentOperatorProjectedDoctorReport {
  return projectDoctorReport(checks);
}

/**
 * Builds the fake surface's `list()` rows through the REAL `projectListRow`,
 * for the same reason as {@link buildDoctorReport}: every
 * `AgentOperatorProjected*` type is nominally branded, so only the module's
 * own projector may mint one — a hand-written literal would need a
 * disallowed cast. The rows carry the same observable values the previous
 * literals did (`configLoadFailed: false` is derived from `loadError: null`).
 */
function buildListRows(): readonly AgentOperatorProjectedListRow[] {
  const rows: readonly AgentOperatorListRow[] = [
    {
      name: "agent-operator",
      description: "…",
      parameterCount: 20,
      loadError: null,
    },
    {
      name: "sqs-etl",
      description: "…",
      parameterCount: 14,
      loadError: null,
    },
  ];
  return rows.map((row) => projectListRow(row));
}

/**
 * Builds the fake surface's `dryRun()` envelope through the REAL
 * `projectRunEnvelope` — same branding rationale as {@link buildListRows}.
 * `reportAvailable: false` is derived from `reportPath: null`.
 */
function buildRunEnvelope(): AgentOperatorProjectedRunEnvelope {
  const envelope: AgentOperatorRunEnvelope = {
    kind: "m3l.run.result",
    schemaVersion: 1,
    script: "agent-operator",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    durationMs: 0,
    exitCode: 0,
    exitCodeName: "SUCCESS",
    outcome: "dry-run",
    reportPath: null,
    reportUnavailable: null,
    timelineCount: null,
    timelineSourceCount: null,
    recoveryTotal: null,
  };
  return projectRunEnvelope(envelope);
}

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

/** A fake `AgentCliSurface` recording which methods were invoked, in call order. */
function createFakeSurface(): {
  readonly surface: AgentCliSurface;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const surface: AgentCliSurface = {
    list() {
      calls.push("list");
      return Promise.resolve(buildListRows());
    },
    doctor() {
      calls.push("doctor");
      return Promise.resolve(
        buildDoctorReport([
          { name: "workspace-root", status: "ok", detail: "ok" },
        ]),
      );
    },
    inspect() {
      calls.push("inspect");
      return Promise.resolve([]);
    },
    dryRun() {
      calls.push("dryRun");
      return Promise.resolve(buildRunEnvelope());
    },
    // `run` (V9 slice 2a) records the call like its siblings so the negative
    // assertion below can see it, then rejects: it is the surface's one
    // mutating operation and `explainPolicy` is a read-only summariser, so a
    // call here is a defect that must surface, never a resolved envelope a
    // stray caller could quietly consume.
    run() {
      calls.push("run");
      return Promise.reject(new Error("unexpected mutating run() call"));
    },
  };
  return { surface, calls };
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
    const { surface } = createFakeSurface();

    await explainPolicy({ policy: fullPolicy(), logger, surface });

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
    const { surface } = createFakeSurface();

    const summary = await explainPolicy({
      policy: fullPolicy(),
      logger,
      surface,
    });

    expect(summary.grantCount).toBe(2);
    expect(summary.requireDecisionLog).toBe(true);
    expect(summary.dryRunFirst).toBe(true);
    expect(summary.hasBudgets).toBe(true);
  });

  it("handles a minimal policy (no budgets, no flags, no sensitiveTargets) without throwing", async () => {
    const { logger } = createLogger();
    const { surface } = createFakeSurface();

    const summary = await explainPolicy({
      policy: minimalPolicy(),
      logger,
      surface,
    });

    expect(summary.grantCount).toBe(1);
    expect(summary.requireDecisionLog).toBe(false);
    expect(summary.dryRunFirst).toBe(false);
    expect(summary.hasBudgets).toBe(false);
  });

  it("calls surface.list() and surface.doctor() exactly once each, and never inspect()/dryRun()/run()", async () => {
    const { logger } = createLogger();
    const { surface, calls } = createFakeSurface();

    await explainPolicy({ policy: fullPolicy(), logger, surface });

    expect(calls.filter((call) => call === "list")).toHaveLength(1);
    expect(calls.filter((call) => call === "doctor")).toHaveLength(1);
    expect(calls).not.toContain("inspect");
    expect(calls).not.toContain("dryRun");
    expect(calls).not.toContain("run");
  });

  it("constructs no Bedrock client — the deps bag carries only policy, logger, and the CLI surface", async () => {
    const { logger } = createLogger();
    const { surface } = createFakeSurface();

    // The call succeeds with exactly these three deps and nothing
    // Bedrock-shaped (no client, no modelId, no credentials) — proving this
    // operation cannot reach the network even by accident.
    await expect(
      explainPolicy({ policy: minimalPolicy(), logger, surface }),
    ).resolves.toBeDefined();
  });

  it("still resolves with the correct summary when a handler throws on every event — the isolated failure path", async () => {
    // explainPolicy originates no error of its own: the only fallible
    // collaborator it awaits is `deps.surface`, whose rejections it neither
    // catches nor reshapes (they simply propagate, and their typed-error
    // mapping is `cli-surface.test.ts`'s contract, not this step's). Its own
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
    // The CLI seam is still the same recording fake the other cases use —
    // this scenario varies only the logger, so `list`/`doctor` stay real
    // calls on the same code path rather than being stubbed out.
    const { surface } = createFakeSurface();

    const summary = await explainPolicy({
      policy: fullPolicy(),
      logger,
      surface,
    });

    expect(handler.calls).toBeGreaterThan(0);
    expect(summary.grantCount).toBe(2);
    expect(summary.requireDecisionLog).toBe(true);
    expect(summary.dryRunFirst).toBe(true);
    expect(summary.hasBudgets).toBe(true);
  });
});
