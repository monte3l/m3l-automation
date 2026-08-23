import { describe, expect, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  buildAnalysisProcedure,
  CORRELATION_TOKEN,
  INITIAL_VALUES,
} from "../../src/steps/build-procedure.js";
import type {
  AnalysisConclusion,
  AnalysisShape,
  RunbookCase,
} from "../../src/steps/preset.js";
import {
  basePreset,
  fakeGatherer,
  runDeps,
} from "../support/preset-fixture.js";
import type { FakeGatherer } from "../support/preset-fixture.js";

const TRIGGERED_AT = "2026-08-23T14:32:00Z";

/** A known-case row with everything but the fields a test varies. */
function caseRow(
  overrides: Partial<RunbookCase> &
    Pick<RunbookCase, "id" | "priority" | "pattern">,
): RunbookCase {
  return {
    description: `case ${overrides.id}`,
    prose: `prose for ${overrides.id}`,
    level: undefined,
    service: undefined,
    verdict: "known-open-issue",
    ticket: undefined,
    resolution: undefined,
    escalateTo: undefined,
    followUps: [],
    ...overrides,
  };
}

/** Runs a preset's procedure against a gatherer double. */
async function run(
  preset: Parameters<typeof buildAnalysisProcedure>[0],
  gatherer: FakeGatherer,
  overrides: Parameters<typeof runDeps>[2] = {},
): Promise<Core.M3LProcedureOutcome<AnalysisShape>> {
  return buildAnalysisProcedure(preset).run({
    deps: runDeps(preset, gatherer, overrides),
    parameters: { alarm: preset.alarm, triggeredAt: TRIGGERED_AT },
    initialValues: INITIAL_VALUES,
  });
}

/** Narrows an outcome's conclusion, failing the test when the arm has none. */
function conclusionOf(
  outcome: Core.M3LProcedureOutcome<AnalysisShape>,
): AnalysisConclusion {
  if (outcome.status !== "matched" && outcome.status !== "unrecognized") {
    throw new Error(`expected a concluded outcome, got '${outcome.status}'`);
  }
  return outcome.conclusion;
}

describe("the codified step graph", () => {
  it("declares the ten steps in execution order for every preset", () => {
    expect(
      buildAnalysisProcedure(basePreset())
        .describe()
        .steps.map((s) => s.id),
    ).toEqual([
      "resolve-window",
      "widen-severity",
      "gather-entry",
      "check-entry-evidence",
      "gather-authorizer",
      "extract-correlation",
      "decide-trace-depth",
      "gather-trace-level",
      "extract-error-signature",
      "match-known-cases",
    ]);
  });

  it("derives the query window from triggeredAt and the preset offsets", async () => {
    const gatherer = fakeGatherer([{ "@message": "id=abc boom" }]);
    await run(
      basePreset({ window: { leadMinutes: 5, lagMinutes: 15 } }),
      gatherer,
    );
    const trigger = Math.floor(Date.parse(TRIGGERED_AT) / 1000);
    expect(gatherer.requests[0]?.startTime).toBe(trigger - 300);
    expect(gatherer.requests[0]?.endTime).toBe(trigger + 900);
  });

  it("forwards the run's abort signal into every gathered query (ADR-0049)", async () => {
    const gatherer = fakeGatherer([{ "@message": "id=abc boom" }]);
    const preset = basePreset();
    const controller = new AbortController();
    await buildAnalysisProcedure(preset).run({
      deps: runDeps(preset, gatherer),
      parameters: { alarm: preset.alarm, triggeredAt: TRIGGERED_AT },
      initialValues: INITIAL_VALUES,
      signal: controller.signal,
    });
    expect(gatherer.requests[0]?.signal).toBe(controller.signal);
  });

  it("notes a stage the preset does not declare rather than skipping it silently", async () => {
    const outcome = await run(
      basePreset(),
      fakeGatherer([{ "@message": "id=abc" }]),
    );
    const notes = new Map(
      outcome.telemetry.steps.map((step) => [step.id, step.note]),
    );
    expect(notes.get("widen-severity")).toBe("skipped: stage not declared");
    expect(notes.get("gather-authorizer")).toBe("skipped: stage not declared");
    expect(notes.get("decide-trace-depth")).toBe("skipped: stage not declared");
  });
});

describe("the severity ladder", () => {
  const laddered = basePreset({
    severityLadder: ["ERROR", "WARN", "INFO"],
    severityPlaceholder: "%LEVEL%",
  });

  it("retries one rung lower until a rung returns evidence", async () => {
    const gatherer = fakeGatherer([], [{ "@message": "id=abc boom" }]);
    const outcome = await run(laddered, gatherer);
    expect(gatherer.requests.map((request) => request.query)).toEqual([
      "fields @message | filter level = 'ERROR'",
      "fields @message | filter level = 'WARN'",
    ]);
    expect(outcome.status).toBe("unrecognized");
  });

  it("gives up once every rung is exhausted and concludes no-evidence", async () => {
    const gatherer = fakeGatherer();
    const outcome = await run(laddered, gatherer);
    expect(gatherer.requests.map((request) => request.query)).toEqual([
      "fields @message | filter level = 'ERROR'",
      "fields @message | filter level = 'WARN'",
      "fields @message | filter level = 'INFO'",
    ]);
    expect(outcome.status).toBe("matched");
    expect(conclusionOf(outcome).verdict).toBe("no-evidence");
  });

  it("runs the entry query exactly once when no ladder is declared", async () => {
    const gatherer = fakeGatherer();
    await run(basePreset(), gatherer);
    expect(gatherer.requests).toHaveLength(1);
  });
});

describe("the correlation short circuit", () => {
  it("stops and concludes no-correlation-id when the evidence carries no key", async () => {
    const outcome = await run(
      basePreset(),
      fakeGatherer([{ "@message": "boom, but no key here" }]),
    );
    expect(conclusionOf(outcome).verdict).toBe("no-correlation-id");
    expect(outcome.telemetry.steps.at(-1)?.id).toBe("extract-correlation");
  });

  it("stops rather than substituting a key that is not query-safe", async () => {
    const preset = basePreset({
      correlation: {
        field: "@message",
        pattern: "id=(.+)$",
        label: "correlation id",
      },
    });
    const outcome = await run(
      preset,
      fakeGatherer([{ "@message": 'id=a" | fields b' }]),
    );
    expect(conclusionOf(outcome).verdict).toBe("no-correlation-id");
    expect(outcome.telemetry.steps.at(-1)?.note).toContain("not query-safe");
  });

  it("prefers no-correlation-id over no-evidence when rows were found", async () => {
    const outcome = await run(
      basePreset(),
      fakeGatherer([{ "@message": "boom" }]),
    );
    if (outcome.status !== "matched") throw new Error("expected a match");
    expect(outcome.primary.caseId).toBe("no-correlation-id");
  });
});

describe("the authorizer hop", () => {
  const withAuthorizer = basePreset({
    authorizer: {
      logGroups: ["/example/authorizer"],
      query: "fields @message",
      limit: undefined,
      latencyField: "authorizerLatency",
      latencyThresholdMs: 2000,
    },
  });

  it("runs only when the observed latency exceeds the declared threshold", async () => {
    const gatherer = fakeGatherer(
      [{ "@message": "id=abc", authorizerLatency: "4200" }],
      [{ "@message": "authorizer detail" }],
    );
    await run(withAuthorizer, gatherer);
    expect(gatherer.requests).toHaveLength(2);
    expect(gatherer.requests[1]?.logGroups).toEqual(["/example/authorizer"]);
  });

  it("is skipped, with a note, when the latency is within the threshold", async () => {
    const gatherer = fakeGatherer([
      { "@message": "id=abc", authorizerLatency: "120" },
    ]);
    const outcome = await run(withAuthorizer, gatherer);
    expect(gatherer.requests).toHaveLength(1);
    const note = outcome.telemetry.steps.find(
      (step) => step.id === "gather-authorizer",
    )?.note;
    expect(note).toBe("skipped: authorizer latency within threshold");
  });
});

describe("the trace chain", () => {
  const hop = (
    label: string,
  ): {
    label: string;
    logGroups: readonly string[];
    query: string;
    limit: undefined;
    rekeyPattern: string | undefined;
  } => ({
    label,
    logGroups: [`/example/${label}`],
    query: `fields @message | filter @message like /${CORRELATION_TOKEN}/`,
    limit: undefined,
    rekeyPattern: undefined,
  });

  it("walks one hop per execution, substituting the extracted key", async () => {
    const preset = basePreset({ trace: [hop("first"), hop("second")] });
    const gatherer = fakeGatherer(
      [{ "@message": "id=abc boom" }],
      [{ "@message": "first hop" }],
      [{ "@message": "second hop" }],
    );
    await run(preset, gatherer);
    expect(gatherer.requests).toHaveLength(3);
    expect(gatherer.requests[1]?.query).toContain("abc");
    expect(gatherer.requests[2]?.logGroups).toEqual(["/example/second"]);
  });

  it("caps the walk at the configured maxDepth, below the preset's own depth", async () => {
    const preset = basePreset({
      trace: [hop("first"), hop("second"), hop("third")],
    });
    const gatherer = fakeGatherer([{ "@message": "id=abc boom" }]);
    await run(preset, gatherer, { maxDepth: 1 });
    expect(gatherer.requests).toHaveLength(2);
  });

  it("picks up a rewritten key at a hop that declares a rekey pattern", async () => {
    const preset = basePreset({
      trace: [
        { ...hop("first"), rekeyPattern: "trace=([0-9a-f]+)" },
        hop("second"),
      ],
    });
    const gatherer = fakeGatherer(
      [{ "@message": "id=abc boom" }],
      [{ "@message": "trace=deadbeef" }],
      [{ "@message": "second hop" }],
    );
    await run(preset, gatherer);
    expect(gatherer.requests[2]?.query).toContain("deadbeef");
  });
});

describe("case matching", () => {
  const cased = basePreset({
    signature: {
      field: "@message",
      pattern: "([A-Za-z]+(?:Exception|Error))",
      levelField: "level",
      serviceField: undefined,
    },
    cases: [
      caseRow({ id: "broad", priority: 100, pattern: "TimeoutException" }),
      caseRow({
        id: "narrow",
        priority: 500,
        pattern: "TimeoutException",
        level: "ERROR",
        verdict: "transient-downstream",
      }),
    ],
  });

  it("lets the higher-priority, more specific row win regardless of authoring order", async () => {
    const outcome = await run(
      cased,
      fakeGatherer([{ "@message": "id=abc TimeoutException", level: "ERROR" }]),
    );
    if (outcome.status !== "matched") throw new Error("expected a match");
    expect(outcome.primary.caseId).toBe("narrow");
    expect(outcome.alsoMatched.map((match) => match.caseId)).toEqual(["broad"]);
    expect(outcome.conclusion.verdict).toBe("transient-downstream");
  });

  it("falls through to the broad row when the narrow row's pinned level differs", async () => {
    const outcome = await run(
      cased,
      fakeGatherer([{ "@message": "id=abc TimeoutException", level: "WARN" }]),
    );
    if (outcome.status !== "matched") throw new Error("expected a match");
    expect(outcome.primary.caseId).toBe("broad");
  });

  it("carries the runbook's ticket, resolution and follow-ups onto the conclusion", async () => {
    const preset = basePreset({
      signature: {
        field: "@message",
        pattern: undefined,
        levelField: undefined,
        serviceField: undefined,
      },
      followUps: ["preset-wide follow-up"],
      cases: [
        caseRow({
          id: "known",
          priority: 100,
          pattern: "boom",
          ticket: "EXAMPLE-0001",
          resolution: "restart it",
          followUps: ["case-specific follow-up"],
        }),
      ],
    });
    const outcome = await run(
      preset,
      fakeGatherer([{ "@message": "id=abc boom" }]),
    );
    const conclusion = conclusionOf(outcome);
    expect(conclusion.ticket).toBe("EXAMPLE-0001");
    expect(conclusion.resolution).toBe("restart it");
    expect(conclusion.followUps).toEqual([
      "case-specific follow-up",
      "preset-wide follow-up",
    ]);
    expect(conclusion.escalateTo).toBe("example-owning-team");
  });

  it("falls back to unrecognised, carrying every case it investigated", async () => {
    const preset = basePreset({
      cases: [
        caseRow({ id: "known", priority: 100, pattern: "SomethingElse" }),
      ],
    });
    const outcome = await run(
      preset,
      fakeGatherer([{ "@message": "id=abc boom" }]),
    );
    if (outcome.status !== "unrecognized") throw new Error("expected no match");
    expect(outcome.conclusion.verdict).toBe("unrecognised");
    expect(outcome.investigated.map((entry) => entry.caseId)).toContain(
      "known",
    );
    expect(outcome.conclusion.prose).toContain("example-owning-team");
  });
});

describe("an out-of-scope alarm", () => {
  it("stops before any query and concludes unsupported", async () => {
    const gatherer = fakeGatherer();
    const preset = basePreset({
      entry: undefined,
      correlation: undefined,
      signature: undefined,
      unsupported: {
        reason: "the evidence is a metric, not a log group",
        manualSteps: ["open the metric graph"],
      },
    });
    const outcome = await run(preset, gatherer);
    expect(gatherer.requests).toHaveLength(0);
    const conclusion = conclusionOf(outcome);
    expect(conclusion.verdict).toBe("unsupported");
    expect(conclusion.prose).toContain("metric");
    expect(conclusion.followUps).toEqual(["open the metric graph"]);
  });

  it("outranks no-evidence, which also matches on that path", async () => {
    const outcome = await run(
      basePreset({
        entry: undefined,
        correlation: undefined,
        signature: undefined,
        unsupported: { reason: "metric-only alarm", manualSteps: [] },
      }),
      fakeGatherer(),
    );
    if (outcome.status !== "matched") throw new Error("expected a match");
    expect(outcome.primary.caseId).toBe("unsupported");
    expect(outcome.alsoMatched.map((match) => match.caseId)).toEqual([
      "no-evidence",
    ]);
  });
});

describe("build-time validation", () => {
  it("reports a duplicate case id as an M3LProcedureValidationProblem", () => {
    const preset = basePreset({
      cases: [
        caseRow({ id: "same", priority: 100, pattern: "a" }),
        caseRow({ id: "same", priority: 200, pattern: "b" }),
      ],
    });
    expect(() => buildAnalysisProcedure(preset)).toThrow(Core.M3LError);
    try {
      buildAnalysisProcedure(preset);
    } catch (error) {
      const problems = (error as Core.M3LError).context[
        "problems"
      ] as readonly Core.M3LProcedureValidationProblem[];
      expect(problems.map((problem) => problem.code)).toContain(
        "ERR_PROCEDURE_DUPLICATE_CASE_ID",
      );
    }
  });

  it("reports a duplicate case priority, and reports every problem at once", () => {
    const preset = basePreset({
      cases: [
        caseRow({ id: "first", priority: 100, pattern: "a" }),
        caseRow({ id: "second", priority: 100, pattern: "b" }),
        caseRow({ id: "second", priority: 300, pattern: "c" }),
      ],
    });
    try {
      buildAnalysisProcedure(preset);
      throw new Error("expected build() to reject the preset");
    } catch (error) {
      const problems = (error as Core.M3LError).context[
        "problems"
      ] as readonly Core.M3LProcedureValidationProblem[];
      expect(new Set(problems.map((problem) => problem.code))).toEqual(
        new Set([
          "ERR_PROCEDURE_DUPLICATE_CASE_ID",
          "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
        ]),
      );
    }
  });

  it("folds the preset's own content into the digest, so two presets never collide", () => {
    const first = buildAnalysisProcedure(basePreset());
    const second = buildAnalysisProcedure(
      basePreset({
        entry: {
          logGroups: ["/example/other"],
          query: "fields @message",
          limit: undefined,
        },
      }),
    );
    expect(first.digest).not.toBe(second.digest);
  });

  it("produces an identical digest for two byte-identical presets", () => {
    expect(buildAnalysisProcedure(basePreset()).digest).toBe(
      buildAnalysisProcedure(basePreset()).digest,
    );
  });
});
