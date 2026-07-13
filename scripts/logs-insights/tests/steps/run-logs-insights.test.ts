import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Contract: docs/reference/scripts/logs-insights.md, `run-logs-insights` row
 * + "Resume and failure semantics". The orchestrator composes
 * resolve-settings -> time-range -> per-window
 * `AWS.M3LLogsInsightsClient.startQuery()` + checkpoint (record
 * `inFlightQueryId`) + `awaitResults()` -> accumulate rows -> checkpoint
 * update -> export-results once at the end.
 *
 * `checkpoint.ts` and `export-results.ts` are mocked (per the brief) so this
 * file asserts the ORCHESTRATION contract in isolation: call order,
 * inFlightQueryId checkpointing before the poll, row accumulation, and
 * abort-on-terminal-failure. `resolve-settings.ts`/`time-range.ts` are left
 * real (pure, already contract-tested in their own files) — mocking them too
 * would just re-implement them here.
 */

const mocks = vi.hoisted(() => ({
  readCheckpoint: vi.fn(),
  writeCheckpoint: vi.fn().mockResolvedValue(undefined),
  exportResults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/steps/checkpoint.js", () => ({
  readCheckpoint: mocks.readCheckpoint,
  writeCheckpoint: mocks.writeCheckpoint,
  EMPTY_CHECKPOINT: { completedWindows: 0, rows: [] },
}));

vi.mock("../../src/steps/export-results.js", () => ({
  exportResults: mocks.exportResults,
}));

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runLogsInsights } from "../../src/steps/run-logs-insights.js";

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

const BASE_VALUES: Record<string, unknown> = {
  "aws.profile": "my-profile",
  logGroups: ["/aws/lambda/a"],
  query: "fields @timestamp, @message",
  windowMinutes: 60,
  format: "json",
  output: "results.json",
};

/** A fake `AWS.M3LLogsInsightsClient` — startQuery/awaitResults are the only
 * two methods the orchestrator is allowed to call (never `runQuery`). Each
 * mock is typed against the real method signature (rather than bare
 * `vi.fn()`, whose `Procedure` default resolves to an `any`-returning
 * function) so `.mockImplementation(async () => …)` is recognized as
 * Promise-returning, not accidentally flagged by
 * `@typescript-eslint/no-misused-promises`. */
interface FakeClient {
  readonly startQuery: ReturnType<
    typeof vi.fn<(input: AWS.StartLogsInsightsQueryInput) => Promise<string>>
  >;
  readonly awaitResults: ReturnType<
    typeof vi.fn<
      (
        queryId: string,
        options?: AWS.LogsInsightsAwaitOptions,
      ) => Promise<AWS.LogsInsightsQueryResult>
    >
  >;
  readonly runQuery: ReturnType<typeof vi.fn>;
}

function buildClient(): FakeClient {
  return {
    startQuery:
      vi.fn<(input: AWS.StartLogsInsightsQueryInput) => Promise<string>>(),
    awaitResults:
      vi.fn<
        (
          queryId: string,
          options?: AWS.LogsInsightsAwaitOptions,
        ) => Promise<AWS.LogsInsightsQueryResult>
      >(),
    runQuery: vi.fn(),
  };
}

function asClient(client: FakeClient): AWS.M3LLogsInsightsClient {
  return client as unknown as AWS.M3LLogsInsightsClient;
}

function buildPaths(): Core.M3LPaths {
  const paths = new Core.M3LPaths();
  vi.spyOn(paths, "resolveOutput").mockReturnValue("/data/output/results.json");
  return paths;
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.readCheckpoint.mockReset();
  mocks.writeCheckpoint.mockReset().mockResolvedValue(undefined);
  mocks.exportResults.mockReset().mockResolvedValue(undefined);
});

describe("runLogsInsights — happy path", () => {
  it("composes startQuery + checkpoint(inFlightQueryId) + awaitResults per window, accumulates rows, and exports once at the end", async () => {
    const callOrder: string[] = [];
    const client = buildClient();
    client.startQuery.mockImplementation(() => {
      const id = `query-${String(client.startQuery.mock.calls.length - 1)}`;
      callOrder.push(`startQuery:${id}`);
      return Promise.resolve(id);
    });
    mocks.writeCheckpoint.mockImplementation(
      (options: {
        checkpoint: { completedWindows: number; inFlightQueryId?: string };
      }) => {
        callOrder.push(
          options.checkpoint.inFlightQueryId !== undefined
            ? `writeCheckpoint:inFlight:${options.checkpoint.inFlightQueryId}`
            : `writeCheckpoint:completed:${String(options.checkpoint.completedWindows)}`,
        );
        return Promise.resolve();
      },
    );
    client.awaitResults.mockImplementation((queryId: string) => {
      callOrder.push(`awaitResults:${queryId}`);
      return Promise.resolve({
        queryId,
        status: "Complete",
        rows: [{ "@message": `row-from-${queryId}` }],
      });
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T02:00:00Z", // 2 windows of 60 minutes each
      resume: false,
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    const summary = await runLogsInsights({
      config,
      logger,
      client: asClient(client),
      paths,
    });

    // startQuery + awaitResults decomposition, never runQuery.
    expect(client.runQuery).not.toHaveBeenCalled();
    expect(client.startQuery).toHaveBeenCalledTimes(2);
    expect(client.awaitResults).toHaveBeenCalledTimes(2);

    // Non-resume run never reads the checkpoint.
    expect(mocks.readCheckpoint).not.toHaveBeenCalled();

    // inFlightQueryId is checkpointed BEFORE the poll, for every window.
    expect(callOrder).toEqual([
      "startQuery:query-0",
      "writeCheckpoint:inFlight:query-0",
      "awaitResults:query-0",
      "writeCheckpoint:completed:1",
      "startQuery:query-1",
      "writeCheckpoint:inFlight:query-1",
      "awaitResults:query-1",
      "writeCheckpoint:completed:2",
    ]);

    // export-results is called exactly once, after every window, with the
    // full accumulated row set.
    expect(mocks.exportResults).toHaveBeenCalledTimes(1);
    expect(mocks.exportResults).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          { "@message": "row-from-query-0" },
          { "@message": "row-from-query-1" },
        ],
        format: "json",
        output: "results.json",
      }),
    );

    expect(summary).toEqual({ windowsCompleted: 2, rowsExported: 2 });
  });
});

describe("runLogsInsights — abort on terminal failure", () => {
  it("re-throws a terminal M3LLogsInsightsQueryFailedError and never calls export-results", async () => {
    const client = buildClient();
    let call = 0;
    client.startQuery.mockImplementation(() => {
      const id = `query-${String(call)}`;
      call += 1;
      return Promise.resolve(id);
    });
    client.awaitResults.mockImplementation((queryId: string) => {
      if (queryId === "query-0") {
        return Promise.resolve({
          queryId,
          status: "Complete",
          rows: [{ "@message": "row-from-query-0" }],
        });
      }
      return Promise.reject(
        new AWS.M3LLogsInsightsQueryFailedError(
          "Logs Insights query reached terminal status Failed",
          { queryId, status: "Failed" },
        ),
      );
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T02:00:00Z", // 2 windows; the 2nd fails
      resume: false,
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    let thrown: unknown;
    try {
      await runLogsInsights({
        config,
        logger,
        client: asClient(client),
        paths,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AWS.M3LLogsInsightsQueryFailedError);
    expect(mocks.exportResults).not.toHaveBeenCalled();

    // The checkpoint is updated after each COMPLETED window only — no write
    // ever records the failing window as complete.
    interface WriteCheckpointCallArgs {
      readonly checkpoint: {
        readonly completedWindows: number;
        readonly inFlightQueryId?: string;
      };
    }
    const calls = mocks.writeCheckpoint.mock.calls as [
      WriteCheckpointCallArgs,
    ][];
    for (const [options] of calls) {
      if (options.checkpoint.inFlightQueryId === undefined) {
        expect(options.checkpoint.completedWindows).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("runLogsInsights — abort on startQuery failure", () => {
  it("re-throws a startQuery failure, logs the abort-at-window message, and never calls awaitResults/export-results/checkpoint-write for that window's completion", async () => {
    const client = buildClient();
    const startQueryError = new AWS.M3LLogsInsightsStartQueryError(
      "StartQuery response carried no queryId",
      { logGroupNames: ["/aws/lambda/a"] },
    );
    client.startQuery.mockImplementation(() => {
      return Promise.reject(startQueryError);
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T01:00:00Z", // 1 window; startQuery fails immediately
      resume: false,
    });
    const logger = new Core.M3LLogger([]);
    const loggerErrorSpy = vi.spyOn(logger, "error");
    const paths = buildPaths();

    let thrown: unknown;
    try {
      await runLogsInsights({
        config,
        logger,
        client: asClient(client),
        paths,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(startQueryError);
    expect(client.awaitResults).not.toHaveBeenCalled();
    expect(mocks.exportResults).not.toHaveBeenCalled();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      "logs-insights aborted at window 0 of 1",
    );

    // A startQuery failure happens strictly before the checkpoint write that
    // would record an inFlightQueryId, so no checkpoint write fires at all.
    expect(mocks.writeCheckpoint).not.toHaveBeenCalled();
  });
});

describe("runLogsInsights — resume", () => {
  it("skips already-completed windows and re-attaches to an in-flight query via awaitResults alone (no fresh startQuery)", async () => {
    const client = buildClient();
    let startQueryCalls = 0;
    client.startQuery.mockImplementation(() => {
      startQueryCalls += 1;
      return Promise.resolve(`query-fresh-${String(startQueryCalls)}`);
    });
    client.awaitResults.mockImplementation((queryId: string) => {
      return Promise.resolve({
        queryId,
        status: "Complete",
        rows: [{ "@message": `row-from-${queryId}` }],
      });
    });

    mocks.readCheckpoint.mockResolvedValue({
      completedWindows: 1,
      rows: [{ "@message": "already-fetched" }],
      inFlightQueryId: "query-inflight",
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T03:00:00Z", // 3 windows: [0] done, [1] in-flight, [2] fresh
      resume: true,
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    const summary = await runLogsInsights({
      config,
      logger,
      client: asClient(client),
      paths,
    });

    expect(mocks.readCheckpoint).toHaveBeenCalledTimes(1);

    // Window 1 (the recorded in-flight window) re-attaches directly — one
    // fresh startQuery only, for window 2. `awaitResults`'s optional second
    // argument is not asserted here — only that the in-flight id was used.
    expect(client.startQuery).toHaveBeenCalledTimes(1);
    const awaitedIds = client.awaitResults.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(awaitedIds).toContain("query-inflight");
    expect(client.awaitResults).toHaveBeenCalledTimes(2);

    // Final export carries the checkpoint's carried-over row plus both
    // newly-fetched rows.
    expect(mocks.exportResults).toHaveBeenCalledTimes(1);
    expect(mocks.exportResults).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: expect.arrayContaining([
          { "@message": "already-fetched" },
          { "@message": "row-from-query-inflight" },
          { "@message": "row-from-query-fresh-1" },
        ]) as unknown,
      }),
    );

    expect(summary).toEqual({ windowsCompleted: 3, rowsExported: 3 });
  });
});
