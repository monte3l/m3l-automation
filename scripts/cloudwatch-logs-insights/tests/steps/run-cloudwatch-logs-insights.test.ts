import { afterEach, describe, expect, it, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

/**
 * Contract: docs/reference/scripts/cloudwatch-logs-insights.md,
 * `run-cloudwatch-logs-insights` row + "Resume and failure semantics". The
 * orchestrator composes
 * resolve-settings -> time-range -> per-window
 * `AWS.M3LLogsInsightsClient.startQuery()` + checkpoint (record
 * `inFlightQueryId`) + `awaitResults()` -> accumulate rows -> checkpoint
 * update -> export-results once at the end.
 *
 * `Core.M3LCheckpointStore` and `export-results.ts` are mocked (per the
 * brief) so this file asserts the ORCHESTRATION contract in isolation: call
 * order, inFlightQueryId checkpointing before the poll, row accumulation,
 * and abort-on-terminal-failure. `Core.M3LCheckpointStore` is a stable
 * library class constructed directly by the source, so it is intercepted
 * via a package-level `vi.mock("@m3l-automation/m3l-common", ...)` factory
 * that spreads the real module and overrides only `Core.M3LCheckpointStore`
 * with a mocked constructor (same pattern as
 * `scripts/athena-query/tests/steps/run-athena-query.test.ts`).
 * `resolve-settings.ts`/`time-range.ts` are left real (pure, already
 * contract-tested in their own files) — mocking them too would just
 * re-implement them here.
 */

// vi.hoisted() is required here: @m3l-automation/m3l-common is imported
// statically below, so its vi.mock factory runs eagerly at module-eval time
// when that import is resolved — before a plain top-level `const` would have
// initialized.
const checkpointMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
}));

const exportResultsMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    Core: {
      ...actual.Core,
      // A plain arrow function cannot be invoked with `new` — the source
      // constructs `new Core.M3LCheckpointStore(...)`, so the mocked
      // implementation must be an ordinary function expression.
      M3LCheckpointStore: vi.fn().mockImplementation(function mockedStore() {
        return {
          read: checkpointMocks.read,
          write: checkpointMocks.write,
          delete: checkpointMocks.delete,
        };
      }),
    },
  };
});

vi.mock("../../src/steps/export-results.js", () => ({
  exportResults: exportResultsMock,
}));

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runCloudwatchLogsInsights } from "../../src/steps/run-cloudwatch-logs-insights.js";

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
  checkpointMocks.read.mockReset();
  checkpointMocks.write.mockReset().mockResolvedValue(undefined);
  checkpointMocks.delete.mockReset().mockResolvedValue(undefined);
  exportResultsMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(Core.M3LCheckpointStore).mockClear();
});

describe("runCloudwatchLogsInsights — happy path", () => {
  it("composes startQuery + checkpoint(inFlightQueryId) + awaitResults per window, accumulates rows, and exports once at the end", async () => {
    const callOrder: string[] = [];
    const client = buildClient();
    client.startQuery.mockImplementation(() => {
      const id = `query-${String(client.startQuery.mock.calls.length - 1)}`;
      callOrder.push(`startQuery:${id}`);
      return Promise.resolve(id);
    });
    checkpointMocks.write.mockImplementation(
      (checkpoint: { completedWindows: number; inFlightQueryId?: string }) => {
        callOrder.push(
          checkpoint.inFlightQueryId !== undefined
            ? `writeCheckpoint:inFlight:${checkpoint.inFlightQueryId}`
            : `writeCheckpoint:completed:${String(checkpoint.completedWindows)}`,
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

    const summary = await runCloudwatchLogsInsights({
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
    expect(checkpointMocks.read).not.toHaveBeenCalled();

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
    expect(exportResultsMock).toHaveBeenCalledTimes(1);
    expect(exportResultsMock).toHaveBeenCalledWith(
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

describe("runCloudwatchLogsInsights — abort on terminal failure", () => {
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
      await runCloudwatchLogsInsights({
        config,
        logger,
        client: asClient(client),
        paths,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AWS.M3LLogsInsightsQueryFailedError);
    expect(exportResultsMock).not.toHaveBeenCalled();

    // The checkpoint is updated after each COMPLETED window only — no write
    // ever records the failing window as complete.
    interface WriteCheckpointCallArgs {
      readonly completedWindows: number;
      readonly inFlightQueryId?: string;
    }
    const calls = checkpointMocks.write.mock.calls as [
      WriteCheckpointCallArgs,
    ][];
    for (const [checkpoint] of calls) {
      if (checkpoint.inFlightQueryId === undefined) {
        expect(checkpoint.completedWindows).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("runCloudwatchLogsInsights — abort on startQuery failure", () => {
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
      await runCloudwatchLogsInsights({
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
    expect(exportResultsMock).not.toHaveBeenCalled();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      "cloudwatch-logs-insights aborted at window 0 of 1",
    );

    // A startQuery failure happens strictly before the checkpoint write that
    // would record an inFlightQueryId, so no checkpoint write fires at all.
    expect(checkpointMocks.write).not.toHaveBeenCalled();
  });
});

describe("runCloudwatchLogsInsights — resume", () => {
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

    checkpointMocks.read.mockResolvedValue({
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

    const summary = await runCloudwatchLogsInsights({
      config,
      logger,
      client: asClient(client),
      paths,
    });

    expect(checkpointMocks.read).toHaveBeenCalledTimes(1);

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
    expect(exportResultsMock).toHaveBeenCalledTimes(1);
    expect(exportResultsMock).toHaveBeenCalledWith(
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

  it("propagates ERR_CHECKPOINT_MISSING when resuming with no checkpoint file, never calling any window's startQuery", async () => {
    const client = buildClient();
    checkpointMocks.read.mockRejectedValue(
      new Core.M3LCheckpointError("no checkpoint file found", {
        code: "ERR_CHECKPOINT_MISSING",
      }),
    );

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T02:00:00Z",
      resume: true,
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    let thrown: unknown;
    try {
      await runCloudwatchLogsInsights({
        config,
        logger,
        client: asClient(client),
        paths,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_MISSING",
    );
    expect(client.startQuery).not.toHaveBeenCalled();
    expect(exportResultsMock).not.toHaveBeenCalled();
  });
});
