import { describe, expect, it, vi } from "vitest";

import type * as NodeFsPromises from "node:fs/promises";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  CONFIG_CODE,
  runCloudwatchLogsAnalysis,
} from "../../src/steps/run-cloudwatch-logs-analysis.js";
import type { RunAnalysisDeps } from "../../src/steps/run-cloudwatch-logs-analysis.js";

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof NodeFsPromises>("node:fs/promises");
  return { ...actual };
});

const fsp = await import("node:fs/promises");

/**
 * Narrows a `writeFile`/`readFile` mock argument to its string path. The
 * mocked signature admits a `FileHandle`/`Buffer`, so `String(...)` on it
 * would be a `no-base-to-string` hazard rather than an assertion.
 */
function asPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected a string path, got ${typeof value}`);
  }
  return value;
}

const PRESET_RECORD = {
  alarm: "example-alarm",
  title: "Example alarm",
  entry: { logGroups: ["/example/entry"], query: "fields @message" },
  correlation: { field: "@message", pattern: "id=(\\w+)", label: "id" },
  signature: { field: "@message" },
  escalateTo: "example-owning-team",
};

/** Builds the dispatcher's dependency bag over a config record. */
function buildDeps(
  values: Record<string, unknown>,
  client?: AWS.M3LLogsInsightsClient,
): RunAnalysisDeps {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) config.set(key, value);
  return {
    config,
    logger: new Core.M3LLogger([]),
    prompt: new Core.M3LPrompt(),
    paths: new Core.M3LPaths(),
    correlationId: "run-1",
    client,
    signal: undefined,
  };
}

/** A Logs Insights client double that always resolves `rows`. */
function fakeClient(
  rows: readonly Record<string, string>[],
): AWS.M3LLogsInsightsClient {
  return {
    runQuery: vi
      .fn()
      .mockResolvedValue({ queryId: "q", status: "Complete", rows }),
  } as unknown as AWS.M3LLogsInsightsClient;
}

describe("operation dispatch", () => {
  it("rejects an operation outside the declared set under the script's config code", async () => {
    await expect(
      runCloudwatchLogsAnalysis(buildDeps({ operation: "nope" })),
    ).rejects.toThrow(expect.objectContaining({ code: CONFIG_CODE }));
  });

  it("guards explain's required alarm before touching the filesystem", async () => {
    const readFile = vi.spyOn(fsp, "readFile");
    await expect(
      runCloudwatchLogsAnalysis(buildDeps({ operation: "explain" })),
    ).rejects.toThrow(/'alarm' is required for operation 'explain'/u);
    expect(readFile).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("refuses analyze with no provisioned client rather than failing later", async () => {
    await expect(
      runCloudwatchLogsAnalysis(
        buildDeps({
          operation: "analyze",
          alarm: "example-alarm",
          triggeredAt: "2026-08-23T14:32:00Z",
        }),
      ),
    ).rejects.toThrow(/aws\.profile/u);
  });

  it("routes validate through the offline path, with no client at all", async () => {
    vi.spyOn(fsp, "readdir").mockResolvedValue([
      "example-alarm.json",
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(PRESET_RECORD)),
    );
    await expect(
      runCloudwatchLogsAnalysis(buildDeps({ operation: "validate" })),
    ).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("routes explain through the offline path, with no client at all", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(PRESET_RECORD)),
    );
    await expect(
      runCloudwatchLogsAnalysis(
        buildDeps({ operation: "explain", alarm: "example-alarm" }),
      ),
    ).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe("report persistence", () => {
  it("archives the analyze report under a correlation-id-derived name", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(PRESET_RECORD)),
    );
    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    const writeFile = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);

    await runCloudwatchLogsAnalysis(
      buildDeps(
        {
          operation: "analyze",
          alarm: "example-alarm",
          triggeredAt: "2026-08-23T14:32:00Z",
        },
        fakeClient([{ "@message": "id=abc boom" }]),
      ),
    );

    expect(asPath(writeFile.mock.calls[0]?.[0])).toContain(
      "example-alarm-run-1.json",
    );
    vi.restoreAllMocks();
  });

  it("honours an explicit output name over the derived one", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(PRESET_RECORD)),
    );
    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    const writeFile = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);

    await runCloudwatchLogsAnalysis(
      buildDeps(
        {
          operation: "analyze",
          alarm: "example-alarm",
          triggeredAt: "2026-08-23T14:32:00Z",
          output: "chosen.json",
        },
        fakeClient([{ "@message": "id=abc boom" }]),
      ),
    );

    expect(asPath(writeFile.mock.calls[0]?.[0])).toContain("chosen.json");
    vi.restoreAllMocks();
  });

  it("archives nothing for the offline operations", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      Buffer.from(JSON.stringify(PRESET_RECORD)),
    );
    const writeFile = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    await runCloudwatchLogsAnalysis(
      buildDeps({ operation: "explain", alarm: "example-alarm" }),
    );
    expect(writeFile).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
