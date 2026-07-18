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
