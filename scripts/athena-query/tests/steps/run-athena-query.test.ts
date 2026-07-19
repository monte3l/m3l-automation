import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

/**
 * Contract: docs/reference/scripts/athena-query.md, `run-athena-query` row +
 * "Resume and failure semantics". The orchestrator builds a
 * `StartAthenaQueryInput` from config, checkpoints-or-reattaches
 * (`checkpoint` + `AWS.M3LAthenaClient.startQuery()`, recording
 * `queryExecutionId`, or reattaching to a checkpointed one), calls
 * `awaitResults()`, calls `export-results` once, then deletes the
 * checkpoint. A terminal query failure aborts the run with the checkpoint
 * left intact.
 *
 * `checkpoint.ts` and `export-results.ts` are mocked (per the brief) so this
 * file asserts the ORCHESTRATION contract in isolation: call order,
 * queryExecutionId checkpointing before the poll, and abort-on-terminal-
 * failure. There is a `resolve-settings` step (`resolveAthenaSettings`), but
 * unlike `cloudwatch-logs-insights`'s it is simpler — just per-field
 * narrowing of the resolved config into `StartAthenaQueryInput`, no
 * cross-parameter or ISO-8601 checks — so it is exercised directly here
 * rather than mocked.
 */

const mocks = vi.hoisted(() => ({
  readCheckpoint: vi.fn(),
  writeCheckpoint: vi.fn().mockResolvedValue(undefined),
  deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
  exportResults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/steps/checkpoint.js", () => ({
  readCheckpoint: mocks.readCheckpoint,
  writeCheckpoint: mocks.writeCheckpoint,
  deleteCheckpoint: mocks.deleteCheckpoint,
}));

vi.mock("../../src/steps/export-results.js", () => ({
  exportResults: mocks.exportResults,
}));

import { AWS, Core } from "@m3l-automation/m3l-common";

import {
  runAthenaQuery,
  type AthenaRunSummary,
} from "../../src/steps/run-athena-query.js";

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

const BASE_VALUES: Record<string, unknown> = {
  "aws.profile": "my-profile",
  queryString: "SELECT * FROM my_table",
  format: "json",
  output: "results.json",
  resume: false,
};

/** A fake `AWS.M3LAthenaClient` — startQuery/awaitResults are the only two
 * methods the orchestrator is allowed to call (never `runQuery`). Each mock
 * is typed against the real method signature (rather than bare `vi.fn()`,
 * whose `Procedure` default resolves to an `any`-returning function) so
 * `.mockImplementation(async () => …)` is recognized as Promise-returning,
 * not accidentally flagged by `@typescript-eslint/no-misused-promises`. */
interface FakeClient {
  readonly startQuery: ReturnType<
    typeof vi.fn<(input: AWS.StartAthenaQueryInput) => Promise<string>>
  >;
  readonly awaitResults: ReturnType<
    typeof vi.fn<
      (
        queryExecutionId: string,
        options?: AWS.AthenaAwaitOptions,
      ) => Promise<AWS.AthenaQueryResult>
    >
  >;
  readonly runQuery: ReturnType<typeof vi.fn>;
}

function buildClient(): FakeClient {
  return {
    startQuery: vi.fn<(input: AWS.StartAthenaQueryInput) => Promise<string>>(),
    awaitResults:
      vi.fn<
        (
          queryExecutionId: string,
          options?: AWS.AthenaAwaitOptions,
        ) => Promise<AWS.AthenaQueryResult>
      >(),
    runQuery: vi.fn(),
  };
}

function asClient(client: FakeClient): AWS.M3LAthenaClient {
  return client as unknown as AWS.M3LAthenaClient;
}

function buildPaths(): Core.M3LPaths {
  const paths = new Core.M3LPaths();
  vi.spyOn(paths, "resolveOutput").mockReturnValue("/data/output/results.json");
  return paths;
}

function buildResult(
  queryExecutionId: string,
  rows: readonly Record<string, string>[],
): AWS.AthenaQueryResult {
  return {
    queryExecutionId,
    status: "SUCCEEDED",
    columns: [],
    rows,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.readCheckpoint.mockReset();
  mocks.writeCheckpoint.mockReset().mockResolvedValue(undefined);
  mocks.deleteCheckpoint.mockReset().mockResolvedValue(undefined);
  mocks.exportResults.mockReset().mockResolvedValue(undefined);
});

describe("runAthenaQuery — happy path (fresh run)", () => {
  it("builds StartAthenaQueryInput from config, starts the query, checkpoints queryExecutionId, awaits results, exports once, then deletes the checkpoint", async () => {
    const callOrder: string[] = [];
    const client = buildClient();
    client.startQuery.mockImplementation(() => {
      callOrder.push("startQuery");
      return Promise.resolve("query-123");
    });
    mocks.writeCheckpoint.mockImplementation(
      (options: { checkpoint: { queryExecutionId?: string } }) => {
        callOrder.push(
          `writeCheckpoint:${options.checkpoint.queryExecutionId ?? "none"}`,
        );
        return Promise.resolve();
      },
    );
    client.awaitResults.mockImplementation((queryExecutionId: string) => {
      callOrder.push(`awaitResults:${queryExecutionId}`);
      return Promise.resolve(
        buildResult(queryExecutionId, [
          { id: "1", name: "alice" },
          { id: "2", name: "bob" },
        ]),
      );
    });
    mocks.exportResults.mockImplementation(() => {
      callOrder.push("exportResults");
      return Promise.resolve();
    });
    mocks.deleteCheckpoint.mockImplementation(() => {
      callOrder.push("deleteCheckpoint");
      return Promise.resolve();
    });

    const config = buildConfig({
      ...BASE_VALUES,
      database: "my_db",
      catalog: "my_catalog",
      outputLocation: "s3://bucket/",
      workGroup: "primary",
      executionParameters: ["param-1"],
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    const summary = await runAthenaQuery({
      config,
      logger,
      client: asClient(client),
      paths,
    });

    // Non-resume run never reads the checkpoint.
    expect(mocks.readCheckpoint).not.toHaveBeenCalled();

    // startQuery + awaitResults decomposition, never runQuery.
    expect(client.runQuery).not.toHaveBeenCalled();
    expect(client.startQuery).toHaveBeenCalledTimes(1);
    expect(client.startQuery).toHaveBeenCalledWith({
      queryString: "SELECT * FROM my_table",
      database: "my_db",
      catalog: "my_catalog",
      outputLocation: "s3://bucket/",
      workGroup: "primary",
      executionParameters: ["param-1"],
    });
    expect(client.awaitResults).toHaveBeenCalledTimes(1);
    expect(client.awaitResults).toHaveBeenCalledWith("query-123");

    // queryExecutionId is checkpointed BEFORE the poll.
    expect(callOrder).toEqual([
      "startQuery",
      "writeCheckpoint:query-123",
      "awaitResults:query-123",
      "exportResults",
      "deleteCheckpoint",
    ]);

    expect(mocks.exportResults).toHaveBeenCalledTimes(1);
    expect(mocks.exportResults).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          { id: "1", name: "alice" },
          { id: "2", name: "bob" },
        ],
        format: "json",
        output: "results.json",
      }),
    );

    expect(mocks.deleteCheckpoint).toHaveBeenCalledTimes(1);

    expect(summary).toEqual({
      rowsExported: 2,
      queryExecutionId: "query-123",
    });
  });

  it("omits unset optional fields from StartAthenaQueryInput rather than passing them as undefined", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-456");
    client.awaitResults.mockResolvedValue(buildResult("query-456", []));

    const config = buildConfig({ ...BASE_VALUES });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    expect(client.startQuery).toHaveBeenCalledWith({
      queryString: "SELECT * FROM my_table",
    });
  });
});

describe("runAthenaQuery — resume", () => {
  it("with an existing checkpointed queryExecutionId, skips startQuery and reattaches via awaitResults alone", async () => {
    const client = buildClient();
    client.awaitResults.mockResolvedValue(
      buildResult("query-inflight", [{ id: "1", name: "alice" }]),
    );
    mocks.readCheckpoint.mockResolvedValue({
      queryExecutionId: "query-inflight",
    });

    const config = buildConfig({ ...BASE_VALUES, resume: true });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    const summary = await runAthenaQuery({
      config,
      logger,
      client: asClient(client),
      paths,
    });

    expect(mocks.readCheckpoint).toHaveBeenCalledTimes(1);
    expect(client.startQuery).not.toHaveBeenCalled();
    expect(client.awaitResults).toHaveBeenCalledWith("query-inflight");
    expect(mocks.exportResults).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCheckpoint).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      rowsExported: 1,
      queryExecutionId: "query-inflight",
    });
  });

  it("with resume true but an empty checkpoint (no prior queryExecutionId), starts a fresh query", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-fresh");
    client.awaitResults.mockResolvedValue(buildResult("query-fresh", []));
    mocks.readCheckpoint.mockResolvedValue({});

    const config = buildConfig({ ...BASE_VALUES, resume: true });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    expect(mocks.readCheckpoint).toHaveBeenCalledTimes(1);
    expect(client.startQuery).toHaveBeenCalledTimes(1);
    expect(client.awaitResults).toHaveBeenCalledWith("query-fresh");
  });
});

describe("runAthenaQuery — abort on terminal query failure", () => {
  it("re-throws a terminal M3LAthenaQueryFailedError, never calls export-results, and leaves the checkpoint intact (not deleted)", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-abort");
    const failure = new AWS.M3LAthenaQueryFailedError(
      "Athena query reached terminal status FAILED",
      { queryExecutionId: "query-abort", status: "FAILED" },
    );
    client.awaitResults.mockRejectedValue(failure);

    const config = buildConfig({ ...BASE_VALUES });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    let thrown: unknown;
    try {
      await runAthenaQuery({
        config,
        logger,
        client: asClient(client),
        paths,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AWS.M3LAthenaQueryFailedError);
    expect(thrown).toBe(failure);
    expect(mocks.exportResults).not.toHaveBeenCalled();
    expect(mocks.deleteCheckpoint).not.toHaveBeenCalled();

    // The checkpoint WAS written with the in-flight id before the poll, so a
    // future resume can reattach — only the delete-on-success step is
    // skipped.
    expect(mocks.writeCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: { queryExecutionId: "query-abort" },
      }),
    );
  });

  it("re-throws a startQuery failure and never calls awaitResults/export-results/deleteCheckpoint", async () => {
    const client = buildClient();
    const startFailure = new AWS.M3LAthenaStartQueryError(
      "StartQueryExecution response carried no QueryExecutionId",
      { queryString: "SELECT * FROM my_table" },
    );
    client.startQuery.mockRejectedValue(startFailure);

    const config = buildConfig({ ...BASE_VALUES });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    let thrown: unknown;
    try {
      await runAthenaQuery({
        config,
        logger,
        client: asClient(client),
        paths,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(startFailure);
    expect(client.awaitResults).not.toHaveBeenCalled();
    expect(mocks.exportResults).not.toHaveBeenCalled();
    expect(mocks.deleteCheckpoint).not.toHaveBeenCalled();

    // A startQuery failure happens strictly before the checkpoint write that
    // would record a queryExecutionId, so no checkpoint write fires at all.
    expect(mocks.writeCheckpoint).not.toHaveBeenCalled();
  });
});

describe("runAthenaQuery — run summary type", () => {
  it("the run summary is a plain object of rowsExported (number) and queryExecutionId (string)", () => {
    expectTypeOf<AthenaRunSummary>().toEqualTypeOf<{
      readonly rowsExported: number;
      readonly queryExecutionId: string;
    }>();
  });
});
