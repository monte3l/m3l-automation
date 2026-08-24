import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  buildExecutePlan,
  EXECUTE_CODE,
  logExecutePlan,
  resolveSourceQueueUrl,
} from "../src/steps/execute-plan.js";
import type {
  ExecutePlan,
  PlannedAction,
  TriageAction,
} from "../src/steps/execute-plan.js";
import { createRecordingLogger } from "./support/aws-fakes.js";
import {
  ALL_TRIAGE_VERDICTS,
  baseReportRow,
  baseTriageReport,
  basePreset,
} from "./support/preset-fixtures.js";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * `execute-plan.ts` (PR 3b spec, STEP 2's planning half) — `buildExecutePlan`
 * (deciding WHAT to do with an already-triaged `TriageReport`) and
 * `logExecutePlan` (the `--operation=execute` printed-plan surface). Pure,
 * no AWS — the I/O half (`applyActions`) is covered separately in
 * `execute-actions.test.ts`, which imports only from `../src/steps/execute-actions.js`
 * (plus type-only imports from this module) so `perFile` v8 coverage keeps
 * each source file bound to the test file that actually exercises it.
 *
 * A `PlannedAction`'s `messageId` (not present in the STEP 2 pseudocode
 * interface, which only shows `verdict`/`action`/`reason`) is assumed to
 * exist, since `applyActions` cannot otherwise re-correlate a planned action
 * back to a re-received message — flagged for GREEN-time confirmation.
 */

describe("buildExecutePlan — verdict-to-action mapping (all eleven TriageVerdict members)", () => {
  test.each(ALL_TRIAGE_VERDICTS)(
    "maps verdict '%s' to its documented action",
    (verdict) => {
      const report = baseTriageReport({
        rows: [baseReportRow({ messageId: "msg-1", verdict })],
      });

      const plan = buildExecutePlan(report);

      expect(plan.actions).toHaveLength(1);
      const planned = plan.actions[0] as PlannedAction;
      expect(planned.messageId).toBe("msg-1");
      expect(planned.verdict).toBe(verdict);

      // The expected `TriageAction` per the verdict-to-action table on
      // `buildExecutePlan`'s TSDoc: `remove` → drop, `reinsert` → move
      // (carrying the report's excerpt as the entry body), every other
      // verdict → retry (leave untouched).
      let expectedAction: TriageAction;
      if (verdict === "remove") {
        expectedAction = { action: "drop" };
      } else if (verdict === "reinsert") {
        expectedAction = {
          action: "move",
          entry: { id: "msg-1", body: expect.any(String) as string },
        };
      } else {
        expectedAction = { action: "retry" };
      }
      expect(planned.action).toEqual(expectedAction);
      expect(planned.reason.length).toBeGreaterThan(0);
    },
  );
});

describe("buildExecutePlan — rows with no conclusion ('(none)') are never planned", () => {
  test("a failed/aborted outcome's row is excluded from the plan entirely", () => {
    const report = baseTriageReport({
      rows: [
        baseReportRow({ messageId: "msg-ok", verdict: "remove" }),
        baseReportRow({
          messageId: "msg-failed",
          verdict: "(none)",
          status: "failed",
          failure: "DynamoDB throttled",
          caseId: undefined,
        }),
      ],
    });

    const plan = buildExecutePlan(report);

    expect(
      plan.actions.map((action: PlannedAction) => action.messageId),
    ).toEqual(["msg-ok"]);
  });
});

describe("buildExecutePlan — prohibitions always win (ADR-0077's most safety-critical guarantee)", () => {
  // Under the normal pipeline, `cases.ts`'s `downgradeForProhibitions`
  // already downgrades a blocked verdict to 'hold' before it ever reaches a
  // TriageConclusion/TriageReportRow — so a row carrying BOTH a non-undefined
  // `prohibited` AND a 'remove'/'reinsert' verdict should never occur in
  // practice. This test constructs exactly that otherwise-unreachable,
  // adversarial combination to prove `buildExecutePlan` does not blindly
  // trust the upstream downgrade and re-checks the invariant itself.
  test.each(["remove", "reinsert"] as const)(
    "throws EXECUTE_CODE rather than planning a drop/move for a prohibited '%s' verdict",
    (verdict) => {
      const report = baseTriageReport({
        rows: [
          baseReportRow({
            messageId: "msg-1",
            verdict,
            prohibited: "would have concluded, but a prohibition blocks it",
          }),
        ],
      });

      let thrown: unknown;
      try {
        buildExecutePlan(report);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(EXECUTE_CODE);
    },
  );

  test("a legitimately downgraded 'hold' verdict carrying 'prohibited' plans a retry, not a throw", () => {
    const report = baseTriageReport({
      rows: [
        baseReportRow({
          messageId: "msg-1",
          verdict: "hold",
          prohibited:
            "would have concluded 'remove', but a prohibition blocks it",
        }),
      ],
    });

    const plan = buildExecutePlan(report);

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ action: { action: "retry" } });
  });
});

describe("buildExecutePlan — needsSourceQueue / counts", () => {
  test("needsSourceQueue is false when no 'reinsert' is planned", () => {
    const report = baseTriageReport({
      rows: [
        baseReportRow({ messageId: "msg-1", verdict: "remove" }),
        baseReportRow({ messageId: "msg-2", verdict: "hold" }),
      ],
    });

    const plan = buildExecutePlan(report);

    expect(plan.needsSourceQueue).toBe(false);
  });

  test("needsSourceQueue is true when at least one 'reinsert' is planned", () => {
    const report = baseTriageReport({
      rows: [
        baseReportRow({ messageId: "msg-1", verdict: "remove" }),
        baseReportRow({ messageId: "msg-2", verdict: "reinsert" }),
      ],
    });

    const plan = buildExecutePlan(report);

    expect(plan.needsSourceQueue).toBe(true);
  });

  test("removeCount/reinsertCount/leaveCount tally the planned actions", () => {
    const report = baseTriageReport({
      rows: [
        baseReportRow({ messageId: "msg-1", verdict: "remove" }),
        baseReportRow({ messageId: "msg-2", verdict: "reinsert" }),
        baseReportRow({ messageId: "msg-3", verdict: "hold" }),
        baseReportRow({ messageId: "msg-4", verdict: "escalate" }),
      ],
    });

    const plan = buildExecutePlan(report);

    expect(plan.removeCount).toBe(1);
    expect(plan.reinsertCount).toBe(1);
    expect(plan.leaveCount).toBe(2);
    expect(plan.actions).toHaveLength(4);
  });
});

describe("logExecutePlan", () => {
  test("logs every planned action's messageId without throwing", () => {
    const report = baseTriageReport({
      rows: [
        baseReportRow({ messageId: "msg-1", verdict: "remove" }),
        baseReportRow({ messageId: "msg-2", verdict: "reinsert" }),
      ],
    });
    const plan = buildExecutePlan(report);
    const { logger, events } = createRecordingLogger();

    expect(() => {
      logExecutePlan(logger, plan);
    }).not.toThrow();

    expect(events.length).toBeGreaterThan(0);
    const rendered = events.map((event) => event.message).join("\n");
    expect(rendered).toContain("msg-1");
    expect(rendered).toContain("msg-2");
  });
});

/**
 * `resolveSourceQueueUrl` (claude-pr-review Must-fix on PR #629): before
 * this describe block, the only reachable case in the whole test tree was
 * `run-sqs-dead-letter-triage.test.ts`'s `[vacuous]` dispatcher test, whose
 * plan has no `reinsert` at all and returns at the very first
 * `needsSourceQueue` check — none of the three checks documented on
 * `resolveSourceQueueUrl` ever ran, and nothing imported the symbol by
 * name. This is the direct unit-level happy path plus a deliberate exercise
 * of the early-exit branch; the four documented failure paths (missing
 * `sourceQueueUrl`, no declared `preset.sourceQueue`, a mismatched queue
 * name, a mismatched account/region) are already covered end-to-end via
 * `run-sqs-dead-letter-triage.test.ts`'s "sourceQueueUrl guard" describe
 * block.
 */
describe("resolveSourceQueueUrl — the sourceQueueUrl guard (review round 2, MUST-FIX 10)", () => {
  const DLQ_URL = "https://sqs.us-east-1.amazonaws.com/111111111111/orders-dlq";
  const SOURCE_URL =
    "https://sqs.us-east-1.amazonaws.com/111111111111/orders-inbound";

  function reinsertPlan(): ExecutePlan {
    return {
      actions: [],
      removeCount: 0,
      reinsertCount: 1,
      leaveCount: 0,
      needsSourceQueue: true,
    };
  }

  function noReinsertPlan(): ExecutePlan {
    return {
      actions: [],
      removeCount: 1,
      reinsertCount: 0,
      leaveCount: 0,
      needsSourceQueue: false,
    };
  }

  test("returns the supplied sourceQueueUrl unchanged when it names preset.sourceQueue and shares the dead-letter queue's account and region", () => {
    const preset = basePreset({ sourceQueue: "orders-inbound" });

    const resolved = resolveSourceQueueUrl(
      reinsertPlan(),
      preset,
      SOURCE_URL,
      DLQ_URL,
    );

    expect(resolved).toBe(SOURCE_URL);
  });

  test("a plan with needsSourceQueue: false passes a supplied sourceQueueUrl through unvalidated", () => {
    // Deliberately a value that would fail every one of the three checks
    // (no declared sourceQueue on this preset, wrong queue name, wrong
    // account) — proving this is the untouched early exit, not a
    // coincidentally-passing validation.
    const preset = basePreset({ sourceQueue: undefined });
    const mismatchedUrl =
      "https://sqs.eu-west-1.amazonaws.com/222222222222/unrelated-queue";

    const resolved = resolveSourceQueueUrl(
      noReinsertPlan(),
      preset,
      mismatchedUrl,
      DLQ_URL,
    );

    expect(resolved).toBe(mismatchedUrl);
  });

  test("a plan with needsSourceQueue: false returns undefined through unchanged when none was supplied", () => {
    const preset = basePreset({ sourceQueue: undefined });

    const resolved = resolveSourceQueueUrl(
      noReinsertPlan(),
      preset,
      undefined,
      DLQ_URL,
    );

    expect(resolved).toBeUndefined();
  });
});
