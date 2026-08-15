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

/**
 * Mutable state backing the mocked `Core.M3LJSONListExporter`'s streaming
 * writer: `bytesWritten` is seeded from the construction option's
 * `resumeFromByte` (defaulting to `0`) and grows by
 * `JSON.stringify(item).length` on every `append()` — a deterministic stand-in
 * for the real byte-flush accounting, sufficient to assert monotonic growth
 * and exact per-window deltas without depending on the real exporter's wire
 * format. `constructOptions` records every construction call's options object
 * so a test can assert the `resumeFromByte` a given run constructed with.
 */
const jsonExporterState = vi.hoisted(() => ({
  bytesWritten: 0,
  constructOptions: [] as Record<string, unknown>[],
}));

const jsonExporterMocks = vi.hoisted(() => ({
  exportStream: vi.fn(),
  append: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

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
      // Same reasoning: the JSON path (once implemented) constructs
      // `new Core.M3LJSONListExporter(...)` directly (not through
      // `export-results.ts`, which is mocked away above), so it needs its own
      // mocked constructor rather than being covered by `exportResultsMock`.
      M3LJSONListExporter: vi
        .fn()
        .mockImplementation(function mockedJSONExporter(
          options: Record<string, unknown>,
        ) {
          const resumeFromByte =
            typeof options["resumeFromByte"] === "number"
              ? options["resumeFromByte"]
              : 0;
          jsonExporterState.constructOptions.push(options);
          jsonExporterState.bytesWritten = resumeFromByte;
          return {
            exportStream: () => {
              jsonExporterMocks.exportStream();
              return {
                append: async (item: unknown) => {
                  await jsonExporterMocks.append(item);
                  jsonExporterState.bytesWritten += JSON.stringify(item).length;
                },
                close: async () => {
                  await jsonExporterMocks.close();
                },
                get bytesWritten() {
                  return jsonExporterState.bytesWritten;
                },
              };
            },
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
import {
  isLogsInsightsCheckpoint,
  type LogsInsightsCheckpoint,
} from "../../src/steps/checkpoint.js";

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
  jsonExporterState.bytesWritten = 0;
  jsonExporterState.constructOptions.length = 0;
  jsonExporterMocks.exportStream.mockReset();
  jsonExporterMocks.append.mockReset().mockResolvedValue(undefined);
  jsonExporterMocks.close.mockReset().mockResolvedValue(undefined);
  vi.mocked(Core.M3LJSONListExporter).mockClear();
});

describe("runCloudwatchLogsInsights — happy path", () => {
  it("composes startQuery + checkpoint(inFlightQueryId) + awaitResults per window, streaming each row to the JSON writer and closing it at the end", async () => {
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

    // JSON format streams: each fetched row is appended to the writer
    // individually, in order, and the writer is closed once every window
    // completes — the batch export-results step is never invoked.
    expect(jsonExporterMocks.append).toHaveBeenCalledTimes(2);
    expect(jsonExporterMocks.append).toHaveBeenNthCalledWith(1, {
      "@message": "row-from-query-0",
    });
    expect(jsonExporterMocks.append).toHaveBeenNthCalledWith(2, {
      "@message": "row-from-query-1",
    });
    expect(jsonExporterMocks.close).toHaveBeenCalledTimes(1);
    expect(exportResultsMock).not.toHaveBeenCalled();

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

    // A realistic json-format resumed checkpoint: rows stay `[]` (the
    // streaming path never buffers rows in the checkpoint — see
    // `outputBytes`) and `outputBytes` records the writer's byte offset from
    // the prior run.
    checkpointMocks.read.mockResolvedValue({
      completedWindows: 1,
      rows: [],
      outputBytes: 128,
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

    // JSON streaming never carries the checkpoint's `rows` field forward
    // (that field exists only for the CSV accumulation path, and this
    // fixture's `rows` is empty anyway) — only rows fetched THIS run are
    // appended, one per completed window, and the batch export-results step
    // is never invoked.
    expect(exportResultsMock).not.toHaveBeenCalled();
    expect(jsonExporterMocks.append).toHaveBeenCalledTimes(2);
    expect(jsonExporterMocks.append).toHaveBeenNthCalledWith(1, {
      "@message": "row-from-query-inflight",
    });
    expect(jsonExporterMocks.append).toHaveBeenNthCalledWith(2, {
      "@message": "row-from-query-fresh-1",
    });
    expect(jsonExporterMocks.close).toHaveBeenCalledTimes(1);

    // rowsExported is `initial.rowsExported ?? 0` (this fixture omits that
    // field entirely) plus the 2 rows appended this run — not the full
    // 3-row accumulated set the old batch-export contract asserted.
    expect(summary).toEqual({ windowsCompleted: 3, rowsExported: 2 });
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

  it("rejects a json-format checkpoint carrying non-empty rows with no outputBytes (a legacy or format-mismatched checkpoint), before any window runs", async () => {
    const client = buildClient();
    // Non-empty `rows` with no `outputBytes` can only mean a checkpoint from
    // before the streaming rework (or written by a csv-format run) — the
    // streaming path never forwards `rows`, so silently resuming would lose
    // those rows permanently.
    checkpointMocks.read.mockResolvedValue({
      completedWindows: 1,
      rows: [{ "@message": "legacy-row" }],
      inFlightQueryId: "query-inflight",
    });

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

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_LOGS_INSIGHTS_LEGACY_CHECKPOINT",
    );

    // The rejection happens at checkpoint-validation time, strictly before
    // any window is driven.
    expect(client.startQuery).not.toHaveBeenCalled();
    expect(client.awaitResults).not.toHaveBeenCalled();
    expect(exportResultsMock).not.toHaveBeenCalled();
    expect(Core.M3LJSONListExporter).not.toHaveBeenCalled();
  });
});

describe("isLogsInsightsCheckpoint", () => {
  it.each<[string, unknown]>([
    ["a non-object", "not-an-object"],
    ["null", null],
    ["an object with completedWindows missing", { rows: [] }],
    [
      "an object with completedWindows not a number",
      { completedWindows: "0", rows: [] },
    ],
    ["an object with rows missing", { completedWindows: 0 }],
    ["an object with rows not an array", { completedWindows: 0, rows: "nope" }],
    [
      "an object whose inFlightQueryId is present but not a string",
      { completedWindows: 0, rows: [], inFlightQueryId: 123 },
    ],
  ])("rejects %s", (_description, candidate) => {
    expect(isLogsInsightsCheckpoint(candidate)).toBe(false);
  });

  it("accepts an object with no inFlightQueryId (the optional field absent)", () => {
    const candidate: LogsInsightsCheckpoint = { completedWindows: 0, rows: [] };
    expect(isLogsInsightsCheckpoint(candidate)).toBe(true);
  });

  it("accepts a well-formed checkpoint with rows and an inFlightQueryId", () => {
    const candidate: LogsInsightsCheckpoint = {
      completedWindows: 2,
      rows: [{ a: "b" }],
      inFlightQueryId: "q-1",
    };
    expect(isLogsInsightsCheckpoint(candidate)).toBe(true);
  });
});

/**
 * Contract: the JSON-only streaming-resume fix. `format === "json"` opens a
 * `Core.M3LJSONListExporter(...).exportStream()` writer once, before any
 * window runs, appends each window's rows individually (no in-memory
 * accumulation, no row-buffering in the checkpoint — `rows: []` on every
 * write), and closes the writer at the end instead of calling
 * `export-results.ts`'s batch `exportResults()`. `format === "csv"` is
 * explicitly out of scope and must be bit-for-bit unchanged: no writer is
 * ever opened, and the existing full-accumulation + single batch
 * `exportResults()` call behavior is preserved.
 */
describe("runCloudwatchLogsInsights — JSON streaming (fresh run)", () => {
  it("opens the streaming writer once, appends one row per call across every window, and never calls the batch export-results step", async () => {
    const client = buildClient();
    let call = 0;
    client.startQuery.mockImplementation(() => {
      const id = `query-${String(call)}`;
      call += 1;
      return Promise.resolve(id);
    });
    client.awaitResults.mockImplementation((queryId: string) => {
      return Promise.resolve({
        queryId,
        status: "Complete",
        rows: [{ "@message": `row-from-${queryId}` }],
      });
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T02:00:00Z", // 2 windows
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

    // The writer is opened exactly once for the whole run, not per window.
    expect(Core.M3LJSONListExporter).toHaveBeenCalledTimes(1);
    expect(jsonExporterMocks.exportStream).toHaveBeenCalledTimes(1);

    // A fresh (non-resumed) run opens the writer at byte offset 0 — whether
    // via an explicit `resumeFromByte: 0` or by omitting the option.
    const [constructOptions] = jsonExporterState.constructOptions;
    expect(constructOptions?.["resumeFromByte"] ?? 0).toBe(0);

    // Each row is appended individually, in order, across both windows —
    // never batched.
    expect(jsonExporterMocks.append).toHaveBeenCalledTimes(2);
    expect(jsonExporterMocks.append).toHaveBeenNthCalledWith(1, {
      "@message": "row-from-query-0",
    });
    expect(jsonExporterMocks.append).toHaveBeenNthCalledWith(2, {
      "@message": "row-from-query-1",
    });
    expect(jsonExporterMocks.close).toHaveBeenCalledTimes(1);

    // No batch export anywhere — export-results.ts is never invoked for the
    // JSON path.
    expect(exportResultsMock).not.toHaveBeenCalled();

    expect(summary).toEqual({ windowsCompleted: 2, rowsExported: 2 });
  });

  it("checkpoints rows: [] (never accumulating) on every write, with outputBytes tracking the writer's bytesWritten", async () => {
    const client = buildClient();
    let call = 0;
    client.startQuery.mockImplementation(() => {
      const id = `query-${String(call)}`;
      call += 1;
      return Promise.resolve(id);
    });
    client.awaitResults.mockImplementation((queryId: string) => {
      return Promise.resolve({
        queryId,
        status: "Complete",
        rows: [{ "@message": `row-from-${queryId}` }],
      });
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T02:00:00Z", // 2 windows
      resume: false,
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runCloudwatchLogsInsights({
      config,
      logger,
      client: asClient(client),
      paths,
    });

    interface WriteCall {
      readonly completedWindows: number;
      readonly rows: readonly unknown[];
      readonly outputBytes?: number;
      readonly inFlightQueryId?: string;
    }
    const calls = checkpointMocks.write.mock.calls as [WriteCall][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [checkpoint] of calls) {
      expect(checkpoint.rows).toEqual([]);
    }

    const row0 = { "@message": "row-from-query-0" };
    const row1 = { "@message": "row-from-query-1" };
    const bytes0 = JSON.stringify(row0).length;
    const bytes1 = JSON.stringify(row1).length;

    expect(checkpointMocks.write).toHaveBeenNthCalledWith(1, {
      completedWindows: 0,
      rows: [],
      inFlightQueryId: "query-0",
      outputBytes: 0,
    });
    expect(checkpointMocks.write).toHaveBeenNthCalledWith(2, {
      completedWindows: 1,
      rows: [],
      outputBytes: bytes0,
    });
    expect(checkpointMocks.write).toHaveBeenNthCalledWith(3, {
      completedWindows: 1,
      rows: [],
      inFlightQueryId: "query-1",
      outputBytes: bytes0,
    });
    expect(checkpointMocks.write).toHaveBeenNthCalledWith(4, {
      completedWindows: 2,
      rows: [],
      outputBytes: bytes0 + bytes1,
    });
  });
});

describe("runCloudwatchLogsInsights — JSON streaming (resumed run)", () => {
  it("constructs the writer with resumeFromByte from the checkpoint's outputBytes, and every write during resumed windows keeps rows: [] with outputBytes non-decreasing", async () => {
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

    const resumedOutputBytes = 512;
    const resumedRowsExported = 7;
    checkpointMocks.read.mockResolvedValue({
      completedWindows: 1,
      rows: [],
      outputBytes: resumedOutputBytes,
      rowsExported: resumedRowsExported,
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T03:00:00Z", // 3 windows: [0] done, [1]/[2] remaining
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

    const [constructOptions] = jsonExporterState.constructOptions;
    expect(constructOptions?.["resumeFromByte"]).toBe(resumedOutputBytes);

    interface WriteCall {
      readonly completedWindows: number;
      readonly rows: readonly unknown[];
      readonly outputBytes?: number;
    }
    const calls = checkpointMocks.write.mock.calls as [WriteCall][];
    expect(calls.length).toBeGreaterThan(0);

    let previousOutputBytes = -1;
    for (const [checkpoint] of calls) {
      expect(checkpoint.rows).toEqual([]);
      expect(checkpoint.outputBytes).toBeGreaterThanOrEqual(resumedOutputBytes);
      const current = checkpoint.outputBytes ?? -1;
      expect(current).toBeGreaterThanOrEqual(previousOutputBytes);
      previousOutputBytes = current;
    }

    // `rowsExported` for a resumed JSON run is the prior run's checkpointed
    // row count (`rowsExported`) plus this run's newly-appended rows (one
    // per remaining window: windows 1 and 2, since window 0 was already
    // completed at resume time) — closing the design gap flagged in the
    // RED-phase report (see checkpoint.ts's `LogsInsightsCheckpoint.rowsExported`).
    expect(summary.windowsCompleted).toBe(3);
    expect(summary.rowsExported).toBe(resumedRowsExported + 2);
  });
});

describe("runCloudwatchLogsInsights — JSON streaming pre-window checkpoint bytes", () => {
  it("startOrReattachQuery's pre-window checkpoint write reflects bytes flushed by prior windows only, not the window about to start", async () => {
    const client = buildClient();
    let call = 0;
    client.startQuery.mockImplementation(() => {
      const id = `query-${String(call)}`;
      call += 1;
      return Promise.resolve(id);
    });
    client.awaitResults.mockImplementation((queryId: string) => {
      return Promise.resolve({
        queryId,
        status: "Complete",
        rows: [{ "@message": `row-from-${queryId}`, extra: "x".repeat(20) }],
      });
    });

    const config = buildConfig({
      ...BASE_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T03:00:00Z", // 3 windows
      resume: false,
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runCloudwatchLogsInsights({
      config,
      logger,
      client: asClient(client),
      paths,
    });

    interface WriteCall {
      readonly completedWindows: number;
      readonly inFlightQueryId?: string;
      readonly outputBytes?: number;
    }
    const calls = checkpointMocks.write.mock.calls as [WriteCall][];
    const preWindowWrites = calls
      .map(([checkpoint]) => checkpoint)
      .filter((checkpoint) => checkpoint.inFlightQueryId !== undefined);
    expect(preWindowWrites).toHaveLength(3);

    // Pre-window write for window 0: no row has been appended yet anywhere.
    expect(preWindowWrites[0]?.outputBytes).toBe(0);

    const row0 = {
      "@message": "row-from-query-0",
      extra: "x".repeat(20),
    };
    const bytes0 = JSON.stringify(row0).length;
    // Pre-window write for window 1 reflects window 0's bytes only — window
    // 1 itself has not appended anything yet.
    expect(preWindowWrites[1]?.outputBytes).toBe(bytes0);

    const row1 = {
      "@message": "row-from-query-1",
      extra: "x".repeat(20),
    };
    const bytes1 = JSON.stringify(row1).length;
    // Pre-window write for window 2 reflects windows 0+1 combined only.
    expect(preWindowWrites[2]?.outputBytes).toBe(bytes0 + bytes1);
  });
});

describe("runCloudwatchLogsInsights — CSV format (unchanged behavior)", () => {
  it("fresh run: never touches the JSON streaming writer; full row accumulation and a single batch export-results call, exactly as before this fix", async () => {
    const client = buildClient();
    let call = 0;
    client.startQuery.mockImplementation(() => {
      const id = `query-${String(call)}`;
      call += 1;
      return Promise.resolve(id);
    });
    client.awaitResults.mockImplementation((queryId: string) => {
      return Promise.resolve({
        queryId,
        status: "Complete",
        rows: [{ "@message": `row-from-${queryId}` }],
      });
    });

    const config = buildConfig({
      ...BASE_VALUES,
      format: "csv",
      output: "results.csv",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T02:00:00Z",
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

    expect(Core.M3LJSONListExporter).not.toHaveBeenCalled();
    expect(jsonExporterMocks.exportStream).not.toHaveBeenCalled();
    expect(jsonExporterMocks.append).not.toHaveBeenCalled();

    expect(exportResultsMock).toHaveBeenCalledTimes(1);
    expect(exportResultsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          { "@message": "row-from-query-0" },
          { "@message": "row-from-query-1" },
        ],
        format: "csv",
        output: "results.csv",
      }),
    );

    interface WriteCall {
      readonly completedWindows: number;
      readonly rows: readonly unknown[];
      readonly outputBytes?: number;
    }
    const calls = checkpointMocks.write.mock.calls as [WriteCall][];
    for (const [checkpoint] of calls) {
      expect(checkpoint.outputBytes).toBeUndefined();
    }
    const finalWrite = calls.find(
      ([checkpoint]) => checkpoint.completedWindows === 2,
    );
    expect(finalWrite?.[0].rows).toEqual([
      { "@message": "row-from-query-0" },
      { "@message": "row-from-query-1" },
    ]);

    expect(summary).toEqual({ windowsCompleted: 2, rowsExported: 2 });
  });

  it("resumed run: never touches the JSON streaming writer; checkpoint rows keep the full carried-over + fetched set (never emptied)", async () => {
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
      format: "csv",
      output: "results.csv",
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T03:00:00Z",
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

    expect(Core.M3LJSONListExporter).not.toHaveBeenCalled();

    expect(exportResultsMock).toHaveBeenCalledTimes(1);
    expect(exportResultsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: expect.arrayContaining([
          { "@message": "already-fetched" },
          { "@message": "row-from-query-inflight" },
          { "@message": "row-from-query-fresh-1" },
        ]) as unknown,
        format: "csv",
      }),
    );

    expect(summary).toEqual({ windowsCompleted: 3, rowsExported: 3 });
  });
});
