/**
 * Tests for aws/athena submodule.
 *
 * Contract source: docs/reference/aws/athena.md, ADR-0029.
 *
 * Exports under test (from `../src/aws/athena/index.js`, following the
 * package's `../src/aws/index.js` barrel): M3LAthenaClient,
 * M3LAthenaStartQueryError, M3LAthenaQueryFailedError.
 *
 * Mocking strategy: no `@aws-sdk/client-athena` module mock is needed —
 * `M3LAthenaClient` takes an *injected* client, so tests pass a minimal fake
 * `{ send: vi.fn() }` object typed as `AthenaClient` via a cast, mirroring
 * how the consuming `athena-query` script will inject `script.aws.athena`.
 *
 * This is the TDD seam (scaffolding-submodules): these tests are meant to
 * fail red against the placeholder `M3LAthenaClient` bodies, which throw
 * immediately without ever touching the injected client. Every test below
 * asserts on `send` having been invoked so a placeholder that never calls
 * `send` fails for the right reason, not by coincidental error-type overlap
 * with the placeholder's own throw.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";
import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type AthenaClient,
} from "@aws-sdk/client-athena";

import { M3LError } from "../src/core/errors/index.js";
import { M3LBackoff } from "../src/core/polling/index.js";

import {
  M3LAthenaClient,
  M3LAthenaQueryFailedError,
  M3LAthenaStartQueryError,
} from "../src/aws/athena/index.js";
import type { AthenaQueryResult } from "../src/aws/athena/index.js";

function fakeClient(send: (command: unknown) => unknown): AthenaClient {
  return { send } as unknown as AthenaClient;
}

/**
 * Drive a promise to settlement while flushing all pending timers, so
 * retry/poll backoff delays resolve without real wall-clock waits (mirrors
 * `settleWithTimers` in cloudwatch-logs-insights.test.ts / polling.test.ts).
 */
async function settleWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const settledOutcome = Promise.allSettled([promise]).then((results) => {
    settled = true;
    return results[0];
  });
  for (let i = 0; i < 1000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  const outcome = await settledOutcome;
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("M3LAthenaClient.startQuery", () => {
  test("returns the QueryExecutionId from a successful StartQueryExecution call", async () => {
    const send = vi.fn().mockResolvedValue({ QueryExecutionId: "q-123" });
    const client = new M3LAthenaClient(fakeClient(send));

    const queryExecutionId = await settleWithTimers(
      client.startQuery({
        queryString: "SELECT * FROM my_table LIMIT 10",
        database: "my_database",
      }),
    );

    expect(queryExecutionId).toBe("q-123");
    expect(send).toHaveBeenCalledWith(expect.any(StartQueryExecutionCommand));
  });

  test("rejects M3LAthenaStartQueryError with the underlying cause chained when the SDK call fails", async () => {
    const sdkError = new Error("throttled");
    const send = vi.fn().mockRejectedValue(sdkError);
    const client = new M3LAthenaClient(fakeClient(send));

    await expect(
      settleWithTimers(client.startQuery({ queryString: "SELECT 1" })),
    ).rejects.toMatchObject({
      code: "ERR_ATHENA_START_QUERY",
      cause: sdkError,
    });
    expect(send).toHaveBeenCalled();
  });

  test("rejects M3LAthenaStartQueryError with no cause when the response carries no QueryExecutionId", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = new M3LAthenaClient(fakeClient(send));

    const promise = settleWithTimers(
      client.startQuery({ queryString: "SELECT 1" }),
    );

    await expect(promise).rejects.toMatchObject({
      code: "ERR_ATHENA_START_QUERY",
    });
    const thrown = await promise.catch((error: unknown) => error);
    expect((thrown as M3LAthenaStartQueryError).cause).toBeUndefined();
    expect(send).toHaveBeenCalled();
  });

  test("maps every optional StartAthenaQueryInput field onto the StartQueryExecutionCommand input", async () => {
    const send = vi.fn().mockResolvedValue({ QueryExecutionId: "q-full" });
    const client = new M3LAthenaClient(fakeClient(send));

    await settleWithTimers(
      client.startQuery({
        queryString: "SELECT * FROM my_table",
        database: "my_database",
        catalog: "my_catalog",
        outputLocation: "s3://my-bucket/results/",
        workGroup: "my_workgroup",
        executionParameters: ["a", "b"],
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [unknown];
    expect(command).toBeInstanceOf(StartQueryExecutionCommand);
    expect((command as StartQueryExecutionCommand).input).toMatchObject({
      QueryString: "SELECT * FROM my_table",
      QueryExecutionContext: {
        Database: "my_database",
        Catalog: "my_catalog",
      },
      ResultConfiguration: { OutputLocation: "s3://my-bucket/results/" },
      WorkGroup: "my_workgroup",
      ExecutionParameters: ["a", "b"],
    });
  });
});

describe("M3LAthenaClient.awaitResults", () => {
  test("polls GetQueryExecution to SUCCEEDED, then normalizes paginated GetQueryResults rows keyed by column name", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: {
          Rows: [
            { Data: [{ VarCharValue: "id" }, { VarCharValue: "name" }] },
            { Data: [{ VarCharValue: "1" }, { VarCharValue: "alice" }] },
          ],
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: "id", Type: "bigint" },
              { Name: "name", Type: "varchar" },
            ],
          },
        },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-123"));

    expect(result).toMatchObject<Partial<AthenaQueryResult>>({
      queryExecutionId: "q-123",
      status: "SUCCEEDED",
      rows: [{ id: "1", name: "alice" }],
    });
    expect(send).toHaveBeenCalledWith(expect.any(GetQueryExecutionCommand));
    expect(send).toHaveBeenCalledWith(expect.any(GetQueryResultsCommand));
  });

  test("accumulates rows across GetQueryResults pages without dropping the first row of page two", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        NextToken: "next-token",
        ResultSet: {
          Rows: [
            { Data: [{ VarCharValue: "id" }, { VarCharValue: "name" }] },
            { Data: [{ VarCharValue: "1" }, { VarCharValue: "alice" }] },
          ],
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: "id", Type: "bigint" },
              { Name: "name", Type: "varchar" },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        ResultSet: {
          Rows: [{ Data: [{ VarCharValue: "2" }, { VarCharValue: "bob" }] }],
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: "id", Type: "bigint" },
              { Name: "name", Type: "varchar" },
            ],
          },
        },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-page"));

    expect(result.rows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    const [secondPageCommand] = send.mock.calls[2] as [unknown];
    expect(secondPageCommand).toBeInstanceOf(GetQueryResultsCommand);
    expect((secondPageCommand as GetQueryResultsCommand).input.NextToken).toBe(
      "next-token",
    );
  });

  test("continues polling through RUNNING before reaching SUCCEEDED", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "RUNNING" } },
      })
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: { Rows: [], ResultSetMetadata: { ColumnInfo: [] } },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-loop"));

    expect(result.status).toBe("SUCCEEDED");
    expect(send).toHaveBeenCalledTimes(3);
  });

  test("maps ResultSetMetadata.ColumnInfo to result.columns", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: {
          Rows: [{ Data: [{ VarCharValue: "id" }, { VarCharValue: "name" }] }],
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: "id", Type: "bigint" },
              { Name: "name", Type: "varchar" },
            ],
          },
        },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-columns"));

    expect(result.columns).toEqual([
      { name: "id", type: "bigint" },
      { name: "name", type: "varchar" },
    ]);
  });

  test("maps GetQueryExecution Statistics to camelCase result.statistics", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: {
          Status: { State: "SUCCEEDED" },
          Statistics: {
            DataScannedInBytes: 2048,
            TotalExecutionTimeInMillis: 500,
            EngineExecutionTimeInMillis: 400,
          },
        },
      })
      .mockResolvedValueOnce({
        ResultSet: { Rows: [], ResultSetMetadata: { ColumnInfo: [] } },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-stats"));

    expect(result.statistics).toEqual({
      dataScannedInBytes: 2048,
      totalExecutionTimeInMillis: 500,
      engineExecutionTimeInMillis: 400,
    });
  });

  test("leaves result.statistics undefined when GetQueryExecution carries no Statistics", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: { Rows: [], ResultSetMetadata: { ColumnInfo: [] } },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-no-stats"));

    expect(result.statistics).toBeUndefined();
  });

  test("normalizes a Datum with no VarCharValue to an empty string", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: {
          Rows: [
            { Data: [{ VarCharValue: "id" }, { VarCharValue: "name" }] },
            { Data: [{ VarCharValue: "1" }, {}] },
          ],
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: "id", Type: "bigint" },
              { Name: "name", Type: "varchar" },
            ],
          },
        },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-null"));

    expect(result.rows).toEqual([{ id: "1", name: "" }]);
  });

  test("rejects M3LAthenaQueryFailedError when the query reaches a terminal FAILED status", async () => {
    const send = vi.fn().mockResolvedValue({
      QueryExecution: {
        Status: { State: "FAILED", StateChangeReason: "boom" },
      },
    });
    const client = new M3LAthenaClient(fakeClient(send));

    await expect(
      settleWithTimers(client.awaitResults("q-456")),
    ).rejects.toMatchObject({
      code: "ERR_ATHENA_QUERY_FAILED",
    });
    expect(send).toHaveBeenCalled();
  });

  test("rejects M3LAthenaQueryFailedError when the query reaches a terminal CANCELLED status", async () => {
    const send = vi.fn().mockResolvedValue({
      QueryExecution: {
        Status: { State: "CANCELLED", StateChangeReason: "user cancelled" },
      },
    });
    const client = new M3LAthenaClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client.awaitResults("q-cancelled").catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LAthenaQueryFailedError);
    expect((thrown as M3LAthenaQueryFailedError).context).toMatchObject({
      queryExecutionId: "q-cancelled",
      status: "CANCELLED",
    });
    expect((thrown as M3LAthenaQueryFailedError).cause).toBeUndefined();
    expect(send).toHaveBeenCalled();
  });

  test("rejects M3LAthenaQueryFailedError with status UNKNOWN and chained cause when GetQueryExecution's send fails", async () => {
    const sdkError = new Error("network blip");
    const send = vi.fn().mockRejectedValue(sdkError);
    const client = new M3LAthenaClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client.awaitResults("q-send-fail").catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LAthenaQueryFailedError);
    expect((thrown as M3LAthenaQueryFailedError).context).toMatchObject({
      status: "UNKNOWN",
    });
    expect((thrown as M3LAthenaQueryFailedError).cause).toBe(sdkError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("rejects M3LAthenaQueryFailedError with status UNKNOWN and chained cause when GetQueryResults' send fails after GetQueryExecution succeeds", async () => {
    const sdkError = new Error("results fetch blew up");
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockRejectedValue(sdkError);
    const client = new M3LAthenaClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client.awaitResults("q-results-fail").catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LAthenaQueryFailedError);
    expect((thrown as M3LAthenaQueryFailedError).context).toMatchObject({
      status: "UNKNOWN",
    });
    expect((thrown as M3LAthenaQueryFailedError).cause).toBe(sdkError);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("rejects M3LAthenaQueryFailedError with status UNKNOWN and no cause when GetQueryResults returns rows but no column metadata", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: {
          Rows: [
            { Data: [{ VarCharValue: "id" }, { VarCharValue: "name" }] },
            { Data: [{ VarCharValue: "1" }, { VarCharValue: "alice" }] },
          ],
          ResultSetMetadata: { ColumnInfo: [] },
        },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client.awaitResults("q-no-columns").catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LAthenaQueryFailedError);
    expect((thrown as M3LAthenaQueryFailedError).context).toMatchObject({
      queryExecutionId: "q-no-columns",
      status: "UNKNOWN",
    });
    expect((thrown as M3LAthenaQueryFailedError).cause).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("propagates the poller's own ERR_POLL_EXHAUSTED error, narrowed by code (not class), when GetQueryExecution never reaches a terminal status", async () => {
    const send = vi.fn().mockResolvedValue({
      QueryExecution: { Status: { State: "RUNNING" } },
    });
    const client = new M3LAthenaClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client
        .awaitResults("q-slow", {
          pollerOptions: { backoff: M3LBackoff.constant(1), maxAttempts: 2 },
        })
        .catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
    expect(thrown).not.toBeInstanceOf(M3LAthenaQueryFailedError);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("M3LAthenaClient.runQuery", () => {
  test("sends StartQueryExecution, then GetQueryExecution, then GetQueryResults in sequence", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ QueryExecutionId: "q-e2e" })
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: { Rows: [], ResultSetMetadata: { ColumnInfo: [] } },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    const result = await settleWithTimers(
      client.runQuery({ queryString: "SELECT 1" }),
    );

    expect(result.queryExecutionId).toBe("q-e2e");
    expect(send).toHaveBeenCalledTimes(3);
    const [startCommand] = send.mock.calls[0] as [unknown];
    const [getExecCommand] = send.mock.calls[1] as [unknown];
    const [getResultsCommand] = send.mock.calls[2] as [unknown];
    expect(startCommand).toBeInstanceOf(StartQueryExecutionCommand);
    expect(getExecCommand).toBeInstanceOf(GetQueryExecutionCommand);
    expect(getResultsCommand).toBeInstanceOf(GetQueryResultsCommand);
  });
});

describe("M3LAthenaClient types", () => {
  test("startQuery/awaitResults/runQuery are typed per the contract", () => {
    expectTypeOf<M3LAthenaClient["startQuery"]>().returns.toEqualTypeOf<
      Promise<string>
    >();
    expectTypeOf<M3LAthenaClient["awaitResults"]>().returns.toEqualTypeOf<
      Promise<AthenaQueryResult>
    >();
    expectTypeOf<AthenaQueryResult["status"]>().toEqualTypeOf<"SUCCEEDED">();
  });

  test("M3LAthenaStartQueryError and M3LAthenaQueryFailedError are M3LError subclasses", () => {
    expect(
      new M3LAthenaStartQueryError("x", { queryString: "SELECT 1" }),
    ).toBeInstanceOf(M3LError);
    expect(
      new M3LAthenaQueryFailedError("x", {
        queryExecutionId: "q",
        status: "FAILED",
      }),
    ).toBeInstanceOf(M3LError);
  });
});
