import { describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  buildAnalysisProcedure,
  INITIAL_VALUES,
} from "../../src/steps/build-procedure.js";
import {
  buildReport,
  logReport,
  MAX_REPORTED_ROWS,
} from "../../src/steps/report.js";
import { createEvidence } from "../../src/steps/preset.js";
import type { AnalysisShape, RunbookPreset } from "../../src/steps/preset.js";
import {
  basePreset,
  fakeGatherer,
  runDeps,
} from "../support/preset-fixture.js";
import type { FakeGatherer } from "../support/preset-fixture.js";

const TRIGGERED_AT = "2026-08-23T14:32:00Z";

/** Runs a preset and builds its report, returning both halves. */
async function reportFor(
  preset: RunbookPreset,
  gatherer: FakeGatherer,
): Promise<ReturnType<typeof buildReport>> {
  const deps = runDeps(preset, gatherer);
  const outcome = await buildAnalysisProcedure(preset).run({
    deps,
    parameters: { alarm: preset.alarm, triggeredAt: TRIGGERED_AT },
    initialValues: INITIAL_VALUES,
  });
  return buildReport({
    preset,
    outcome,
    evidence: deps.evidence,
    triggeredAt: TRIGGERED_AT,
  });
}

const MATCHING = basePreset({
  severityLadder: ["ERROR", "WARN"],
  severityPlaceholder: "%LEVEL%",
  followUps: ["check the metric graph"],
  cases: [
    {
      id: "boom",
      description: "it went bang",
      prose: "The known bang.",
      priority: 100,
      pattern: "BoomError",
      level: undefined,
      service: undefined,
      verdict: "known-open-issue",
      ticket: "EXAMPLE-1",
      resolution: "restart it",
      escalateTo: undefined,
      followUps: [],
    },
  ],
});

describe("buildReport", () => {
  it("carries the winning case's verdict, prose, ticket and resolution", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc BoomError" }]),
    );
    expect(report.status).toBe("matched");
    expect(report.verdict).toBe("known-open-issue");
    expect(report.caseId).toBe("boom");
    expect(report.prose).toBe("The known bang.");
    expect(report.ticket).toBe("EXAMPLE-1");
    expect(report.resolution).toBe("restart it");
  });

  it("records the severity rung the evidence was finally found at", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([], [{ "@message": "id=abc BoomError" }]),
    );
    expect(report.severityRung).toBe("WARN");
  });

  it("reports the evidence stages that ran, with their true row counts", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([
        { "@message": "id=abc BoomError" },
        { "@message": "id=abc again" },
      ]),
    );
    expect(report.evidence).toEqual([
      {
        label: "entry",
        rowCount: 2,
        rows: [
          { "@message": "id=abc BoomError" },
          { "@message": "id=abc again" },
        ],
      },
    ]);
  });

  it("truncates a stage's persisted rows while keeping its true count", async () => {
    const rows = Array.from({ length: MAX_REPORTED_ROWS + 10 }, () => ({
      "@message": "id=abc BoomError",
    }));
    const report = await reportFor(MATCHING, fakeGatherer(rows));
    expect(report.evidence[0]?.rowCount).toBe(MAX_REPORTED_ROWS + 10);
    expect(report.evidence[0]?.rows).toHaveLength(MAX_REPORTED_ROWS);
  });

  it("lists the winner and the cases that also matched on a matched outcome", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc BoomError" }]),
    );
    expect(report.casesChecked.map((entry) => entry.caseId)).toEqual(["boom"]);
    expect(report.alsoMatched).toEqual([]);
  });

  it("lists every investigated case on an unrecognized outcome", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc SomethingElse" }]),
    );
    expect(report.status).toBe("unrecognized");
    expect(report.verdict).toBe("unrecognised");
    expect(report.casesChecked.map((entry) => entry.caseId)).toEqual(
      expect.arrayContaining(["boom", "no-evidence", "no-correlation-id"]),
    );
    expect(report.casesChecked.every((entry) => !entry.satisfied)).toBe(true);
  });

  it("carries the follow-ups the runbook prescribes but the script does not run", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc BoomError" }]),
    );
    expect(report.followUps).toEqual(["check the metric graph"]);
  });

  it("carries both digests and the step telemetry the run produced", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc BoomError" }]),
    );
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.parametersDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.iterations).toBeGreaterThan(0);
    expect(report.steps[0]?.id).toBe("resolve-window");
  });

  it("describes an aborted run rather than claiming a verdict", () => {
    const outcome = {
      status: "aborted",
      alsoMatched: [],
      abortedAt: "gather-entry",
      error: new Core.M3LError("aborted", { code: "ERR_OPERATION_ABORTED" }),
      digest: "d",
      parametersDigest: "p",
      trace: [],
      telemetry: {
        steps: [],
        iterations: 0,
        stepsSkipped: 0,
        resolveChecks: 0,
        recovered: [],
        recoveredTotal: 0,
        startedAt: "",
        durationMs: 0,
        terminatedAt: undefined,
        earlyResolved: false,
      },
    } as unknown as Core.M3LProcedureOutcome<AnalysisShape>;
    const report = buildReport({
      preset: MATCHING,
      outcome,
      evidence: createEvidence(),
      triggeredAt: TRIGGERED_AT,
    });
    expect(report.verdict).toBeUndefined();
    expect(report.prose).toContain("cancelled");
    expect(report.escalateTo).toBe("example-owning-team");
  });
});

describe("logReport", () => {
  it("prints the verdict prose, the evidence counts and the follow-ups", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc BoomError" }]),
    );
    const logger = new Core.M3LLogger([]);
    const text = vi.spyOn(logger, "text");
    logReport(logger, report);
    const printed = text.mock.calls.map(([message]) => message);
    expect(printed).toContain("The known bang.");
    expect(printed).toContain("evidence: entry=1 (severity ERROR)");
    expect(printed).toContain("- check the metric graph");
  });

  it("prints each rejected case with its priority", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc SomethingElse" }]),
    );
    const logger = new Core.M3LLogger([]);
    const text = vi.spyOn(logger, "text");
    logReport(logger, report);
    expect(
      text.mock.calls.some(([message]) =>
        message.startsWith("rejected boom (priority 100)"),
      ),
    ).toBe(true);
  });

  it("never prints a gathered row's content to the console", async () => {
    const report = await reportFor(
      MATCHING,
      fakeGatherer([{ "@message": "id=abc BoomError sensitive-payload" }]),
    );
    const logger = new Core.M3LLogger([]);
    const calls: string[] = [];
    for (const method of ["text", "info", "section"] as const) {
      vi.spyOn(logger, method).mockImplementation((message) => {
        calls.push(message);
      });
    }
    logReport(logger, report);
    expect(calls.join("\n")).not.toContain("sensitive-payload");
  });
});
