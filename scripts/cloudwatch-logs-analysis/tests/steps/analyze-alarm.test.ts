import { describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  analyzeAlarm,
  ANALYZE_CODE,
  applyRunOverrides,
} from "../../src/steps/analyze-alarm.js";
import { PRESET_CODE } from "../../src/steps/load-runbook.js";
import { basePreset } from "../support/preset-fixture.js";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");
const paths = new Core.M3LPaths();
const TRIGGERED_AT = "2026-08-23T14:32:00Z";

const PRESET_RECORD = {
  alarm: "example-alarm",
  title: "Example alarm",
  window: { leadMinutes: 5, lagMinutes: 15 },
  entry: { logGroups: ["/example/entry"], query: "fields @message" },
  correlation: { field: "@message", pattern: "id=(\\w+)", label: "id" },
  signature: { field: "@message" },
  escalateTo: "example-owning-team",
  cases: [
    {
      id: "boom",
      description: "it went bang",
      prose: "The known bang.",
      priority: 100,
      pattern: "BoomError",
      verdict: "known-open-issue",
    },
  ],
};

/** Runs `analyzeAlarm` against a stubbed preset file and a client double. */
async function analyze(
  rows: readonly Record<string, string>[],
  overrides: Partial<Parameters<typeof analyzeAlarm>[0]> = {},
): Promise<Awaited<ReturnType<typeof analyzeAlarm>>> {
  vi.spyOn(fsp, "readFile").mockResolvedValue(
    Buffer.from(JSON.stringify(PRESET_RECORD)),
  );
  const runQuery = vi
    .fn()
    .mockResolvedValue({ queryId: "q", status: "Complete", rows });
  const report = await analyzeAlarm({
    reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
    logger: new Core.M3LLogger([]),
    prompt: new Core.M3LPrompt(),
    client: { runQuery } as unknown as AWS.M3LLogsInsightsClient,
    runbookDir: "runbooks",
    alarm: "example-alarm",
    triggeredAt: TRIGGERED_AT,
    overrides: {
      leadMinutes: undefined,
      lagMinutes: undefined,
      severityLadder: undefined,
    },
    maxDepth: 4,
    interactive: false,
    signal: undefined,
    ...overrides,
  });
  vi.restoreAllMocks();
  return report;
}

describe("applyRunOverrides", () => {
  it("leaves the preset's authored values alone when no override is supplied", () => {
    const preset = basePreset({ severityLadder: ["ERROR"] });
    expect(
      applyRunOverrides(preset, {
        leadMinutes: undefined,
        lagMinutes: undefined,
        severityLadder: undefined,
      }),
    ).toEqual(preset);
  });

  it("rejects an override rung that is not safe to substitute into the query", () => {
    expect(() =>
      applyRunOverrides(basePreset(), {
        leadMinutes: undefined,
        lagMinutes: undefined,
        severityLadder: ["X' | fields @message"],
      }),
    ).toThrow(expect.objectContaining({ code: ANALYZE_CODE }));
  });

  it("accepts an ordinary override ladder", () => {
    expect(
      applyRunOverrides(basePreset(), {
        leadMinutes: undefined,
        lagMinutes: undefined,
        severityLadder: ["FATAL", "ERROR"],
      }).severityLadder,
    ).toEqual(["FATAL", "ERROR"]);
  });

  it("applies each supplied override independently of the others", () => {
    const applied = applyRunOverrides(basePreset(), {
      leadMinutes: 60,
      lagMinutes: undefined,
      severityLadder: ["FATAL"],
    });
    expect(applied.window).toEqual({ leadMinutes: 60, lagMinutes: 15 });
    expect(applied.severityLadder).toEqual(["FATAL"]);
  });
});

describe("analyzeAlarm", () => {
  it("loads the preset, runs the procedure and reports the matched verdict", async () => {
    const report = await analyze([{ "@message": "id=abc BoomError" }]);
    expect(report.alarm).toBe("example-alarm");
    expect(report.verdict).toBe("known-open-issue");
    expect(report.caseId).toBe("boom");
  });

  it("reports the no-evidence terminal verdict when the query returns nothing", async () => {
    expect((await analyze([])).verdict).toBe("no-evidence");
  });

  it("applies a window override before compiling the procedure", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(PRESET_RECORD)),
    );
    const runQuery = vi
      .fn()
      .mockResolvedValue({ queryId: "q", status: "Complete", rows: [] });
    await analyzeAlarm({
      reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
      logger: new Core.M3LLogger([]),
      prompt: new Core.M3LPrompt(),
      client: { runQuery } as unknown as AWS.M3LLogsInsightsClient,
      runbookDir: "runbooks",
      alarm: "example-alarm",
      triggeredAt: TRIGGERED_AT,
      overrides: {
        leadMinutes: 60,
        lagMinutes: undefined,
        severityLadder: undefined,
      },
      maxDepth: 4,
      interactive: false,
      signal: undefined,
    });
    const trigger = Math.floor(Date.parse(TRIGGERED_AT) / 1000);
    const sent = runQuery.mock.calls[0]?.[0] as { readonly startTime: number };
    expect(sent.startTime).toBe(trigger - 3600);
    vi.restoreAllMocks();
  });

  it("logs the report before throwing when the run failed mid-step", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(PRESET_RECORD)),
    );
    const runQuery = vi.fn().mockRejectedValue(new Error("AWS is down"));
    const logger = new Core.M3LLogger([]);
    const section = vi.spyOn(logger, "section");
    await expect(
      analyzeAlarm({
        reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
        logger,
        prompt: new Core.M3LPrompt(),
        client: { runQuery } as unknown as AWS.M3LLogsInsightsClient,
        runbookDir: "runbooks",
        alarm: "example-alarm",
        triggeredAt: TRIGGERED_AT,
        overrides: {
          leadMinutes: undefined,
          lagMinutes: undefined,
          severityLadder: undefined,
        },
        maxDepth: 4,
        interactive: false,
        signal: undefined,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: ANALYZE_CODE }));
    expect(section).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("rejects a triggeredAt the procedure cannot parse", async () => {
    await expect(
      analyze([{ "@message": "id=abc BoomError" }], {
        triggeredAt: "yesterday",
      }),
    ).rejects.toThrow(Core.M3LError);
  });
});
