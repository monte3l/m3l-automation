import { describe, expect, it } from "vitest";

import {
  BODY_EXCERPT_LIMIT,
  buildTriageReport,
  logTriageReport,
} from "../src/steps/report.js";
import type { MessageOutcome } from "../src/steps/triage-queue.js";
import { createRecordingLogger } from "./support/aws-fakes.js";
import {
  baseTriageQueueResult,
  buildFailedOutcome,
  buildMatchedOutcome,
} from "./support/preset-fixtures.js";

/**
 * Contract: `docs/reference/scripts/sqs-dead-letter-triage.md`'s
 * `buildTriageReport`/`logTriageReport` (`src/steps/report.ts`).
 *
 * The PR 3a spec gives `buildTriageReport`'s RETURN shape (`TriageReport`)
 * precisely but not its INPUT parameter shape — unlike `drainQueue`'s and
 * `createDynamoDBLookup`'s deps, which the spec spells out as literal
 * interfaces. `MessageOutcome` (this slice's per-message result) carries no
 * message `body`, and `TriageQueueResult` carries no raw messages either, so
 * something must join a report row back to its message's raw body for
 * `bodyExcerpt`/`bodyLength`. This file calls `buildTriageReport` with an
 * inline object literal carrying `result` (a `TriageQueueResult`-shaped
 * value), `queueUrl`, `messages` (`{messageId, body}` pairs to join
 * against), `escalateTo`/`followUps` (preset-level), and `generatedAt` —
 * TypeScript checks this literal structurally against whatever the real
 * parameter type turns out to be once `code-implementer` lands it. Flagged
 * for the hub to confirm or correct this shape before/at GREEN.
 */

const GENERATED_AT = "2026-08-23T12:00:00.000Z";

const DEFAULT_OUTCOMES: readonly MessageOutcome[] = [
  buildMatchedOutcome("msg-1", {
    conclusion: {
      verdict: "remove",
      caseId: "c1",
      description: "d1",
      prose: "p1",
      ticket: "TICK-1",
      followUps: ["fu1"],
    },
  }),
  buildFailedOutcome("msg-2", { failure: "DynamoDB throttled" }),
];

function buildInput(
  overrides: {
    readonly outcomes?: readonly MessageOutcome[];
    readonly messages?: readonly {
      readonly messageId: string;
      readonly body: string;
    }[];
  } = {},
) {
  return {
    result: baseTriageQueueResult({
      outcomes: overrides.outcomes ?? DEFAULT_OUTCOMES,
    }),
    queueUrl: "https://sqs.example/orders-dlq",
    messages: overrides.messages ?? [
      { messageId: "msg-1", body: "x".repeat(300) },
      { messageId: "msg-2", body: "short body" },
    ],
    escalateTo: "orders-team",
    followUps: ["preset-followup"],
    generatedAt: GENERATED_AT,
  };
}

describe("buildTriageReport — body excerpt truncation", () => {
  it("truncates a body longer than BODY_EXCERPT_LIMIT and reports the true untruncated length", () => {
    const report = buildTriageReport(buildInput());

    const row1 = report.rows.find((row) => row.messageId === "msg-1");
    expect(row1).toBeDefined();
    expect(row1?.bodyExcerpt.length).toBe(BODY_EXCERPT_LIMIT);
    expect(row1?.bodyExcerpt).toBe("x".repeat(BODY_EXCERPT_LIMIT));
    expect(row1?.bodyLength).toBe(300);
  });

  it("does not truncate a body shorter than BODY_EXCERPT_LIMIT", () => {
    const report = buildTriageReport(buildInput());

    const row2 = report.rows.find((row) => row.messageId === "msg-2");
    expect(row2?.bodyExcerpt).toBe("short body");
    expect(row2?.bodyLength).toBe("short body".length);
  });
});

describe("buildTriageReport — happy path row projection", () => {
  it("projects a matched outcome's conclusion onto its row", () => {
    const report = buildTriageReport(buildInput());

    const row1 = report.rows.find((row) => row.messageId === "msg-1");
    expect(row1?.verdict).toBe("remove");
    expect(row1?.caseId).toBe("c1");
    expect(row1?.description).toBe("d1");
    expect(row1?.ticket).toBe("TICK-1");
    expect(row1?.followUps).toEqual(["fu1"]);
    expect(row1?.status).toBe("matched");
    expect(row1?.failure).toBeUndefined();
  });

  it("projects a failed outcome with no conclusion and the '(none)' verdict sentinel", () => {
    const report = buildTriageReport(buildInput());

    const row2 = report.rows.find((row) => row.messageId === "msg-2");
    expect(row2?.verdict).toBe("(none)");
    expect(row2?.caseId).toBeUndefined();
    expect(row2?.status).toBe("failed");
    expect(row2?.failure).toBe("DynamoDB throttled");
  });
});

describe("buildTriageReport — verdict counts", () => {
  it("sums to the row count across every distinct verdict, tallying the DEFAULT_OUTCOMES failed outcome under 'failed'", () => {
    const report = buildTriageReport(buildInput());

    const total = Object.values(report.verdictCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(total).toBe(report.rows.length);
    expect(report.verdictCounts.remove).toBe(1);
    expect(report.verdictCounts.failed).toBe(1);
  });

  it("tallies a 'failed' and an 'aborted' outcome into distinct buckets — the whole point of dropping the merged '(none)' tally", () => {
    const report = buildTriageReport(
      buildInput({
        outcomes: [
          buildFailedOutcome("msg-2", { status: "failed" }),
          buildFailedOutcome("msg-3", { status: "aborted" }),
        ],
        messages: [
          { messageId: "msg-2", body: "b2" },
          { messageId: "msg-3", body: "b3" },
        ],
      }),
    );

    expect(report.verdictCounts.failed).toBe(1);
    expect(report.verdictCounts.aborted).toBe(1);
  });
});

describe("buildTriageReport — top-level metadata", () => {
  it("carries the queue/title/depth/archivePath/drained straight through, plus dedup'd follow-ups", () => {
    const report = buildTriageReport(buildInput());

    expect(report.queue).toBe("orders-dlq");
    expect(report.title).toBe("Orders DLQ triage");
    expect(report.queueUrl).toBe("https://sqs.example/orders-dlq");
    expect(report.depth).toBe(2);
    expect(report.drained).toBe(2);
    expect(report.archivePath).toBe(
      "orders-dlq/drain-2026-08-23T12-00-00.000Z.json",
    );
    expect(report.generatedAt).toBe(GENERATED_AT);
    expect(report.escalateTo).toBe("orders-team");
    // Preset-level follow-ups deduplicated, plus the matched row's own.
    expect(new Set(report.followUps).size).toBe(report.followUps.length);
    expect(report.followUps).toContain("preset-followup");
  });
});

describe("logTriageReport — never emits the body excerpt", () => {
  it("logs counts and per-verdict grouping without any row's bodyExcerpt content", () => {
    const marker = `EXCERPT-MARKER-${"y".repeat(240)}`;
    const report = buildTriageReport(
      buildInput({
        messages: [
          { messageId: "msg-1", body: marker },
          { messageId: "msg-2", body: "short body" },
        ],
      }),
    );
    const { logger, events } = createRecordingLogger();

    logTriageReport(logger, report);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.message).not.toContain("EXCERPT-MARKER-");
      expect(JSON.stringify(event.data ?? {})).not.toContain("EXCERPT-MARKER-");
    }
  });
});

describe("BODY_EXCERPT_LIMIT", () => {
  it("is exported as the documented literal", () => {
    expect(BODY_EXCERPT_LIMIT).toBe(256);
  });
});
