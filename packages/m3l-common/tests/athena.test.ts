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

import {
  M3LError,
  M3LOperationAbortedError,
} from "../src/core/errors/index.js";
import { M3LBackoff } from "../src/core/polling/index.js";
import type { M3LPollerOptions } from "../src/core/polling/M3LPoller.js";

import {
  compileAthenaQueryTemplate,
  M3LAthenaClient,
  M3LAthenaQueryFailedError,
  M3LAthenaStartQueryError,
  M3LAthenaTemplateError,
} from "../src/aws/athena/index.js";
import type {
  AthenaQueryResult,
  M3LAthenaCompiledQuery,
} from "../src/aws/athena/index.js";

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

  // ── Cooperative cancellation (ADR-0049) ─────────────────────────────────

  // C.7 / C.8 — signal reaches M3LPoller; abort abandons the pending backoff
  // delay. Assert WITHOUT advancing past the 300s backoff to prove abandonment.
  test("rejects with M3LOperationAbortedError when the caller's signal is aborted, without waiting out the backoff delay", async () => {
    const controller = new AbortController();
    controller.abort(); // pre-aborted: check happens before any poll
    const send = vi
      .fn()
      .mockResolvedValue({ QueryExecution: { Status: { State: "RUNNING" } } });
    const client = new M3LAthenaClient(fakeClient(send));

    // Use a 300s backoff — the test must NOT advance 300 000ms for this to pass.
    const promise = client.awaitResults("q-preaborted", {
      signal: controller.signal,
      pollerOptions: { backoff: M3LBackoff.constant(300_000), maxAttempts: 3 },
    });

    // Race: if signal abandons the delay, promise rejects well within 100ms of
    // fake time; if not, "no-rejection" sentinel wins and the assertion fails.
    const result = await Promise.race([
      promise.catch((e: unknown) => e),
      vi.advanceTimersByTimeAsync(100).then(() => "no-rejection"),
    ]);

    expect(result).toBeInstanceOf(M3LOperationAbortedError);
  });

  // C.9 — signal forwarded to each GetQueryExecution send() as second arg.
  test("forwards options.signal to the GetQueryExecution send() call as the second argument's abortSignal", async () => {
    const controller = new AbortController();
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: { Rows: [], ResultSetMetadata: { ColumnInfo: [] } },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    await settleWithTimers(
      client.awaitResults("q-signal-send", { signal: controller.signal }),
    );

    // First send is GetQueryExecution — its second arg must carry abortSignal.
    const [, sendOptions] = send.mock.calls[0] as [
      unknown,
      { abortSignal?: AbortSignal } | undefined,
    ];
    expect(sendOptions?.abortSignal).toBe(controller.signal);
  });

  // C.10 — AbortError from send + aborted signal → M3LOperationAbortedError,
  // NOT M3LAthenaQueryFailedError (most likely implementation mistake).
  test("surfaces as M3LOperationAbortedError (not M3LAthenaQueryFailedError) when GetQueryExecution send rejects with AbortError while the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error("aborted by signal"), {
      name: "AbortError",
    });
    const send = vi.fn().mockRejectedValue(abortError);
    const client = new M3LAthenaClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client
        .awaitResults("q-abort-send", { signal: controller.signal })
        .catch((e: unknown) => e),
    );

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
    expect(thrown).not.toBeInstanceOf(M3LAthenaQueryFailedError);
  });

  // C.11 — options.signal wins over a signal smuggled in via a pre-typed
  // pollerOptions variable. Omit<M3LPollerOptions, "signal"> rejects a fresh
  // literal that contains `signal`, but a caller can still pass a pre-typed
  // M3LPollerOptions variable (no excess-property check on non-fresh objects).
  // The runtime implementation must still give precedence to options.signal.
  test("a signal smuggled into pollerOptions through a pre-typed variable is still overridden by the dedicated signal option", async () => {
    const mainController = new AbortController();
    mainController.abort(); // options.signal is aborted
    const pollerController = new AbortController(); // NOT aborted
    const send = vi
      .fn()
      .mockResolvedValue({ QueryExecution: { Status: { State: "RUNNING" } } });
    const client = new M3LAthenaClient(fakeClient(send));

    // Pre-typed as M3LPollerOptions so TypeScript allows `signal` on this
    // variable; when passed as pollerOptions (typed Omit<M3LPollerOptions,
    // "signal">), no excess-property check fires — the runtime object still
    // carries `signal`, exercising the defence-in-depth smuggling path.
    const pollerOpts: M3LPollerOptions = {
      backoff: M3LBackoff.constant(1),
      signal: pollerController.signal,
    };

    const thrown = await settleWithTimers(
      client
        .awaitResults("q-signal-wins", {
          signal: mainController.signal,
          pollerOptions: pollerOpts,
        })
        .catch((e: unknown) => e),
    );

    expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
  });

  // C.12 — omitting signal leaves behavior exactly as today.
  test("omitting signal leaves awaitResults behavior unchanged — no abortSignal on send calls", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      })
      .mockResolvedValueOnce({
        ResultSet: { Rows: [], ResultSetMetadata: { ColumnInfo: [] } },
      });
    const client = new M3LAthenaClient(fakeClient(send));

    await settleWithTimers(client.awaitResults("q-nosig"));

    // No second arg, or second arg without abortSignal.
    const [, secondArg] = send.mock.calls[0] as [
      unknown,
      Record<string, unknown> | undefined,
    ];
    const hasAbortSignal =
      secondArg != null && Object.hasOwn(secondArg, "abortSignal");
    expect(hasAbortSignal).toBe(false);
  });

  // ADR-0049 regression — inner throttle-retry runner must honour the abort
  // signal in its delay, not just forward it to send(). The inner runner is
  // constructed without the caller's signal today, so when a ThrottlingException
  // triggers a ≥200ms exponential backoff the abort fires but the runner sleeps
  // out the full delay before the next send() attempt. The test asserts the
  // promise rejects with M3LOperationAbortedError without advancing fake timers
  // past the 200ms throttling backoff — if it has to wait out the backoff, the
  // race returns the "no-rejection" sentinel instead and the assertion fails.
  test("an abort during the throttle-retry backoff in #fetchQueryExecution rejects immediately instead of sleeping out the delay", async () => {
    const controller = new AbortController();
    const throttlingError = Object.assign(new Error("ThrottlingException"), {
      name: "ThrottlingException",
    });
    // send() always returns a ThrottlingException so the inner retry runner
    // schedules a ≥200ms exponential backoff delay. Aborting here means the
    // signal is already fired when that delay starts; a signal-aware delay
    // abandons it immediately.
    const send = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(throttlingError);
    });
    const client = new M3LAthenaClient(fakeClient(send));

    const promise = client.awaitResults("q-throttle-abort", {
      signal: controller.signal,
    });

    // Advance only 100ms — less than the 200ms minimum awsThrottling backoff.
    // A signal-aware inner runner abandons the delay immediately (0ms) and the
    // race resolves to M3LOperationAbortedError. A signal-unaware runner is
    // still sleeping and the sentinel wins instead.
    const result = await Promise.race([
      promise.catch((e: unknown) => e),
      vi.advanceTimersByTimeAsync(100).then(() => "no-rejection"),
    ]);

    expect(result).toBeInstanceOf(M3LOperationAbortedError);
  });

  // ADR-0049 regression — same gap in #fetchQueryResultsPage (reached after
  // GetQueryExecution succeeds with SUCCEEDED). The inner retry runner there
  // also lacks the signal, so a ThrottlingException on GetQueryResults puts the
  // runner into a ≥200ms backoff the abort cannot interrupt.
  test("an abort during the throttle-retry backoff in #fetchQueryResultsPage rejects immediately instead of sleeping out the delay", async () => {
    const controller = new AbortController();
    const throttlingError = Object.assign(new Error("ThrottlingException"), {
      name: "ThrottlingException",
    });
    let callCount = 0;
    // First send: GetQueryExecution → SUCCEEDED (reaches the results page step).
    // Second send: GetQueryResults → ThrottlingException (triggers inner retry
    // runner with a ≥200ms backoff). Abort fires at that point.
    const send = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          QueryExecution: { Status: { State: "SUCCEEDED" } },
        });
      }
      controller.abort();
      return Promise.reject(throttlingError);
    });
    const client = new M3LAthenaClient(fakeClient(send));

    const promise = client.awaitResults("q-results-throttle-abort", {
      signal: controller.signal,
    });

    const result = await Promise.race([
      promise.catch((e: unknown) => e),
      vi.advanceTimersByTimeAsync(100).then(() => "no-rejection"),
    ]);

    expect(result).toBeInstanceOf(M3LOperationAbortedError);
  });
});

describe("M3LAthenaClient.runQuery", () => {
  // C.7 — signal threads through runQuery → awaitResults.
  test("rejects with M3LOperationAbortedError when the caller's signal is aborted (signal is threaded through to awaitResults)", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn().mockResolvedValue({ QueryExecutionId: "q-run-abort" });
    const client = new M3LAthenaClient(fakeClient(send));

    const promise = client.runQuery(
      { queryString: "SELECT 1" },
      {
        signal: controller.signal,
        pollerOptions: {
          backoff: M3LBackoff.constant(300_000),
          maxAttempts: 3,
        },
      },
    );

    const result = await Promise.race([
      promise.catch((e: unknown) => e),
      vi.advanceTimersByTimeAsync(100).then(() => "no-rejection"),
    ]);

    expect(result).toBeInstanceOf(M3LOperationAbortedError);
  });

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

describe("compileAthenaQueryTemplate", () => {
  test("compiles a single named placeholder into a positional ? with its value in executionParameters", () => {
    const compiled = compileAthenaQueryTemplate(
      "SELECT * FROM t WHERE region = :region",
      { region: "us-east-1" },
    );

    expect(compiled).toEqual({
      queryString: "SELECT * FROM t WHERE region = ?",
      executionParameters: ["us-east-1"],
    });
  });

  test("a placeholder referenced twice compiles to two ?s and two duplicated executionParameters entries, in source order", () => {
    const compiled = compileAthenaQueryTemplate(
      "SELECT * FROM logs WHERE day = :day AND updated = :day",
      { day: "2026-08-11" },
    );

    expect(compiled).toEqual({
      queryString: "SELECT * FROM logs WHERE day = ? AND updated = ?",
      executionParameters: ["2026-08-11", "2026-08-11"],
    });
  });

  test("a placeholder-shaped token inside a single-quoted string literal is left untouched, not replaced or counted", () => {
    const compiled = compileAthenaQueryTemplate(
      "SELECT * FROM t WHERE ts = '12:30:00'",
      {},
    );

    expect(compiled).toEqual({
      queryString: "SELECT * FROM t WHERE ts = '12:30:00'",
      executionParameters: [],
    });
  });

  test("a '' escaped quote inside a literal does not close the string, so a placeholder-shaped token after it stays literal", () => {
    const compiled = compileAthenaQueryTemplate(
      "SELECT * FROM t WHERE note = 'it''s :30'",
      {},
    );

    expect(compiled).toEqual({
      queryString: "SELECT * FROM t WHERE note = 'it''s :30'",
      executionParameters: [],
    });
  });

  test("the :: cast operator is never treated as a placeholder start", () => {
    const compiled = compileAthenaQueryTemplate("SELECT x::date FROM t", {});

    expect(compiled).toEqual({
      queryString: "SELECT x::date FROM t",
      executionParameters: [],
    });
  });

  test("a placeholder-shaped token inside a SQL line comment is NOT recognized as a comment and still throws if unmatched", () => {
    expect(() =>
      compileAthenaQueryTemplate("SELECT 1 -- :region", {}),
    ).toThrowError(M3LAthenaTemplateError);
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate("SELECT 1 -- :region", {});
    } catch (error) {
      thrown = error;
    }
    expect((thrown as M3LAthenaTemplateError).context).toMatchObject({
      missingParameters: ["region"],
    });
  });

  test("a placeholder-shaped token inside a double-quoted identifier gets no literal protection and still throws if unmatched", () => {
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate('SELECT "col:region" FROM t', {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAthenaTemplateError);
    expect((thrown as M3LAthenaTemplateError).context).toMatchObject({
      missingParameters: ["region"],
    });
  });

  test("throws a single M3LAthenaTemplateError carrying both missingParameters and unusedParameters when the mismatch is bidirectional", () => {
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate("SELECT * FROM t WHERE a = :a", { b: "x" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAthenaTemplateError);
    expect((thrown as M3LAthenaTemplateError).context).toMatchObject({
      missingParameters: ["a"],
      unusedParameters: ["b"],
    });
  });

  test("an empty template with no parameters compiles to an empty queryString and no executionParameters", () => {
    const compiled = compileAthenaQueryTemplate("", {});

    expect(compiled).toEqual({ queryString: "", executionParameters: [] });
  });

  test("a parameter referenced ONLY inside a protected literal is not considered referenced, and throws unusedParameters", () => {
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate("SELECT * FROM t WHERE t = ':region'", {
        region: "x",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAthenaTemplateError);
    expect((thrown as M3LAthenaTemplateError).context).toMatchObject({
      unusedParameters: ["region"],
    });
  });

  test("a placeholder named after a prototype property (:constructor) is not silently resolved from Object.prototype", () => {
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate("SELECT * FROM t WHERE a = :constructor", {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAthenaTemplateError);
    expect((thrown as M3LAthenaTemplateError).context).toMatchObject({
      missingParameters: ["constructor"],
    });
  });

  test("M3LAthenaTemplateError is an M3LError subclass with code ERR_ATHENA_TEMPLATE_COMPILE and no cause", () => {
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate("SELECT * FROM t WHERE a = :a", {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect(thrown).toBeInstanceOf(M3LAthenaTemplateError);
    expect((thrown as M3LAthenaTemplateError).code).toBe(
      "ERR_ATHENA_TEMPLATE_COMPILE",
    );
    expect((thrown as M3LAthenaTemplateError).cause).toBeUndefined();
    expectTypeOf<
      M3LAthenaTemplateError["code"]
    >().toEqualTypeOf<"ERR_ATHENA_TEMPLATE_COMPILE">();
  });

  test("a literal ? outside a string literal is rejected with both mismatch context arrays empty", () => {
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate("SELECT * FROM t WHERE a = ?", {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAthenaTemplateError);
    expect((thrown as M3LAthenaTemplateError).context).toMatchObject({
      missingParameters: [],
      unusedParameters: [],
    });
  });

  test("a ? inside a single-quoted literal is inert and does not throw", () => {
    const compiled = compileAthenaQueryTemplate("WHERE q = 'is this ok?'", {});

    expect(compiled).toEqual({
      queryString: "WHERE q = 'is this ok?'",
      executionParameters: [],
    });
  });

  test("a literal ? is rejected even alongside a valid named placeholder that would otherwise validate fine", () => {
    expect(() =>
      compileAthenaQueryTemplate("SELECT * FROM t WHERE a = :a AND b = ?", {
        a: "x",
      }),
    ).toThrowError(M3LAthenaTemplateError);
  });

  test("M3LAthenaTemplateError exposes missingParameters/unusedParameters as direct typed instance fields, not just via context", () => {
    let thrown: unknown;
    try {
      compileAthenaQueryTemplate("SELECT * FROM t WHERE a = :a", { b: "x" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LAthenaTemplateError);
    expect((thrown as M3LAthenaTemplateError).missingParameters).toEqual(["a"]);
    expect((thrown as M3LAthenaTemplateError).unusedParameters).toEqual(["b"]);

    expectTypeOf<M3LAthenaTemplateError["missingParameters"]>().toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf<M3LAthenaTemplateError["unusedParameters"]>().toEqualTypeOf<
      readonly string[]
    >();
  });

  test("M3LAthenaCompiledQuery fields are readonly, and the function returns synchronously (not a Promise)", () => {
    expectTypeOf<M3LAthenaCompiledQuery>().toEqualTypeOf<{
      readonly queryString: string;
      readonly executionParameters: readonly string[];
    }>();
    expectTypeOf(
      compileAthenaQueryTemplate,
    ).returns.toEqualTypeOf<M3LAthenaCompiledQuery>();
  });
});
