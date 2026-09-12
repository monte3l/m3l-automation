import { describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";

import {
  explainRunbook,
  presetPathFor,
} from "../../src/steps/explain-runbook.js";
import { PRESET_CODE } from "../../src/steps/load-runbook.js";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");
const paths = new Core.M3LPaths();

const PRESET = {
  alarm: "example-alarm",
  title: "Example alarm",
  entry: { logGroups: ["/example/entry"], query: "fields @message" },
  correlation: { field: "@message", pattern: "id=(\\w+)", label: "id" },
  signature: { field: "@message" },
  escalateTo: "example-owning-team",
  cases: [
    {
      id: "boom",
      description: "it went bang",
      prose: "p",
      priority: 100,
      pattern: "BoomError",
      verdict: "known-open-issue",
    },
  ],
};

/** Runs `explainRunbook` against a stubbed preset file, capturing its output. */
async function explain(): Promise<{
  readonly summary: Core.M3LProcedureSummary;
  readonly printed: string;
}> {
  vi.spyOn(fsp, "readFile").mockResolvedValue(
    Buffer.from(JSON.stringify(PRESET)),
  );
  const logger = new Core.M3LLogger([]);
  const lines: string[] = [];
  for (const method of ["text", "section", "info"] as const) {
    vi.spyOn(logger, method).mockImplementation((message) => {
      lines.push(message);
    });
  }
  const summary = await explainRunbook({
    reader: new Core.M3LInputFileReader({ paths, code: PRESET_CODE }),
    logger,
    runbookDir: "runbooks",
    alarm: "example-alarm",
  });
  vi.restoreAllMocks();
  return { summary, printed: lines.join("\n") };
}

describe("presetPathFor", () => {
  it("resolves an alarm name to its .json file inside the runbook directory", () => {
    expect(presetPathFor("runbooks", "example-alarm")).toBe(
      "runbooks/example-alarm.json",
    );
  });
});

describe("explainRunbook", () => {
  it("returns the built procedure's summary", async () => {
    const { summary } = await explain();
    expect(summary.name).toBe("cloudwatch-logs-analysis:example-alarm");
    expect(summary.steps).toHaveLength(10);
  });

  it("prints the definition digest, which is what makes two runs comparable", async () => {
    const { printed } = await explain();
    expect(printed).toMatch(/digest: [0-9a-f]{64}/u);
  });

  it("prints every step with its kind, jump targets and loop bound", async () => {
    const { printed } = await explain();
    expect(printed).toContain("- resolve-window (transform)");
    expect(printed).toContain(
      "- check-entry-evidence (check) -> widen-severity",
    );
    expect(printed).toContain(
      "- gather-trace-level (gather) -> gather-trace-level",
    );
  });

  it("prints every case in priority order, preset rows above the terminal ones", async () => {
    const { printed } = await explain();
    const order = printed
      .split("\n")
      .filter((line) => /^- \d+ /u.test(line))
      .map((line) => line.split(" ")[2]);
    expect(order).toEqual([
      "boom:",
      "unsupported:",
      "no-correlation-id:",
      "no-evidence:",
    ]);
  });

  it("prints the mandatory fallback", async () => {
    expect((await explain()).printed).toContain("- fallback:");
  });

  it("reads no log group and reaches no AWS client at all", async () => {
    const { summary } = await explain();
    expect(summary.parameters).toEqual(["alarm", "triggeredAt"]);
  });
});
