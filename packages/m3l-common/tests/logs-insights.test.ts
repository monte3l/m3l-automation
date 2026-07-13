/**
 * Tests for aws/logs-insights submodule.
 *
 * Contract source: docs/reference/aws/logs-insights.md, ADR-0027.
 *
 * Exports under test (from `../src/aws/logs-insights/index.js`, following
 * the package's `../src/aws/index.js` barrel): M3LLogsInsightsClient,
 * M3LLogsInsightsStartQueryError, M3LLogsInsightsQueryFailedError.
 *
 * Mocking strategy: no `@aws-sdk/client-cloudwatch-logs` module mock is
 * needed — `M3LLogsInsightsClient` takes an *injected* client, so tests pass
 * a minimal fake `{ send: vi.fn() }` object typed as `CloudWatchLogsClient`
 * via a cast, mirroring how the consuming script will inject
 * `script.aws.cloudWatchLogs`.
 *
 * This is the TDD seam (scaffolding-submodules): these tests are meant to
 * fail red against the placeholder `M3LLogsInsightsClient` bodies, which
 * throw immediately without ever touching the injected client. Every test
 * below asserts on `send` having been invoked so a placeholder that never
 * calls `send` fails for the right reason, not by coincidental error-type
 * overlap with the placeholder's own throw.
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
  StartQueryCommand,
  type CloudWatchLogsClient,
} from "@aws-sdk/client-cloudwatch-logs";

import { M3LError } from "../src/core/errors/index.js";
import { M3LBackoff } from "../src/core/polling/index.js";

import {
  M3LLogsInsightsClient,
  M3LLogsInsightsQueryFailedError,
  M3LLogsInsightsStartQueryError,
} from "../src/aws/logs-insights/index.js";
import type { LogsInsightsQueryResult } from "../src/aws/logs-insights/index.js";

function fakeClient(send: (command: unknown) => unknown): CloudWatchLogsClient {
  return { send } as unknown as CloudWatchLogsClient;
}

/**
 * Drive a promise to settlement while flushing all pending timers, so
 * retry/poll backoff delays resolve without real wall-clock waits (mirrors
 * `settleWithTimers` in `polling.test.ts`).
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

describe("M3LLogsInsightsClient.startQuery", () => {
  test("resolves the queryId from a successful StartQuery response", async () => {
    const send = vi.fn().mockResolvedValue({ queryId: "q-1" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const queryId = await client.startQuery({
      logGroupNames: ["/aws/lambda/example"],
      queryString: "fields @timestamp, @message",
      startTime: 1_700_000_000,
      endTime: 1_700_003_600,
    });

    expect(queryId).toBe("q-1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("throws M3LLogsInsightsStartQueryError when the response carries no queryId", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = new M3LLogsInsightsClient(fakeClient(send));

    await expect(
      client.startQuery({
        logGroupNames: ["/aws/lambda/example"],
        queryString: "fields @timestamp, @message",
        startTime: 1_700_000_000,
        endTime: 1_700_003_600,
      }),
    ).rejects.toBeInstanceOf(M3LLogsInsightsStartQueryError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("retries a throttled StartQuery call and resolves on the second attempt", async () => {
    const throttled = Object.assign(new Error("throttled"), {
      name: "ThrottlingException",
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce({ queryId: "q-retry" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const queryId = await settleWithTimers(
      client.startQuery({
        logGroupNames: ["/aws/lambda/example"],
        queryString: "fields @timestamp, @message",
        startTime: 1_700_000_000,
        endTime: 1_700_003_600,
      }),
    );

    expect(queryId).toBe("q-retry");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("rethrows an unclassified StartQuery send failure as M3LLogsInsightsStartQueryError with cause (unknownDecision: fatal)", async () => {
    const unclassified = new Error("some non-throttling, non-network failure");
    const send = vi.fn().mockRejectedValue(unclassified);
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client
        .startQuery({
          logGroupNames: ["/aws/lambda/example"],
          queryString: "fields @timestamp, @message",
          startTime: 1_700_000_000,
          endTime: 1_700_003_600,
        })
        .catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LLogsInsightsStartQueryError);
    expect((thrown as M3LLogsInsightsStartQueryError).cause).toBe(unclassified);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("omits limit from the constructed StartQueryCommand input when not provided", async () => {
    const send = vi.fn().mockResolvedValue({ queryId: "q-1" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    await client.startQuery({
      logGroupNames: ["/aws/lambda/example"],
      queryString: "fields @timestamp, @message",
      startTime: 1_700_000_000,
      endTime: 1_700_003_600,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [unknown];
    expect(command).toBeInstanceOf(StartQueryCommand);
    expect(
      Object.hasOwn((command as StartQueryCommand).input as object, "limit"),
    ).toBe(false);
  });

  test("forwards limit into the constructed StartQueryCommand input when provided", async () => {
    const send = vi.fn().mockResolvedValue({ queryId: "q-1" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    await client.startQuery({
      logGroupNames: ["/aws/lambda/example"],
      queryString: "fields @timestamp, @message",
      startTime: 1_700_000_000,
      endTime: 1_700_003_600,
      limit: 1000,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [unknown];
    expect(command).toBeInstanceOf(StartQueryCommand);
    expect((command as StartQueryCommand).input.limit).toBe(1000);
  });
});

describe("M3LLogsInsightsClient.awaitResults", () => {
  test("resolves normalized rows once the query reaches Complete", async () => {
    const send = vi.fn().mockResolvedValue({
      status: "Complete",
      results: [
        [
          { field: "@timestamp", value: "2026-07-12T00:00:00Z" },
          { field: "@message", value: "hello" },
        ],
      ],
      statistics: { recordsMatched: 1, recordsScanned: 10, bytesScanned: 2048 },
    });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const result: LogsInsightsQueryResult = await client.awaitResults("q-1");

    expect(result.status).toBe("Complete");
    expect(result.rows).toEqual([
      { "@timestamp": "2026-07-12T00:00:00Z", "@message": "hello" },
    ]);
    expect(result.statistics).toEqual({
      recordsMatched: 1,
      recordsScanned: 10,
      bytesScanned: 2048,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("throws M3LLogsInsightsQueryFailedError carrying queryId and status on terminal failure", async () => {
    const send = vi.fn().mockResolvedValue({ status: "Failed" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const thrown = await client
      .awaitResults("q-failed")
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(M3LLogsInsightsQueryFailedError);
    expect((thrown as M3LLogsInsightsQueryFailedError).context).toMatchObject({
      queryId: "q-failed",
      status: "Failed",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("throws M3LLogsInsightsQueryFailedError carrying queryId and status on a Cancelled terminal status", async () => {
    const send = vi.fn().mockResolvedValue({ status: "Cancelled" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const thrown = await client
      .awaitResults("q-cancelled")
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(M3LLogsInsightsQueryFailedError);
    expect((thrown as M3LLogsInsightsQueryFailedError).context).toMatchObject({
      queryId: "q-cancelled",
      status: "Cancelled",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("falls back to status 'Unknown' when the response carries no status at all", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const thrown = await client
      .awaitResults("q-nostatus")
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(M3LLogsInsightsQueryFailedError);
    expect((thrown as M3LLogsInsightsQueryFailedError).context).toMatchObject({
      queryId: "q-nostatus",
      status: "Unknown",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("rethrows a fatal GetQueryResults send failure as M3LLogsInsightsQueryFailedError with status Unknown and cause", async () => {
    const unclassified = new Error("some non-throttling, non-network failure");
    const send = vi.fn().mockRejectedValue(unclassified);
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client.awaitResults("q-send-fail").catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LLogsInsightsQueryFailedError);
    expect((thrown as M3LLogsInsightsQueryFailedError).context).toMatchObject({
      queryId: "q-send-fail",
      status: "Unknown",
    });
    expect((thrown as M3LLogsInsightsQueryFailedError).cause).toBe(
      unclassified,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("retries a throttled GetQueryResults call and resolves on the second attempt", async () => {
    const throttled = Object.assign(new Error("throttled"), {
      name: "ThrottlingException",
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce({ status: "Complete", results: [] });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-throttled"));

    expect(result.status).toBe("Complete");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("continues polling on a Scheduled status", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: "Scheduled" })
      .mockResolvedValueOnce({ status: "Complete", results: [] });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const result = await settleWithTimers(client.awaitResults("q-scheduled"));

    expect(result.status).toBe("Complete");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("propagates the poller's own ERR_POLL_EXHAUSTED error, narrowed by code (not class)", async () => {
    const send = vi.fn().mockResolvedValue({ status: "Running" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const thrown = await settleWithTimers(
      client
        .awaitResults("q-slow", {
          pollerOptions: { backoff: M3LBackoff.constant(1), maxAttempts: 2 },
        })
        .catch((error: unknown) => error),
    );

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_POLL_EXHAUSTED");
    expect(thrown).not.toBeInstanceOf(M3LLogsInsightsQueryFailedError);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("defaults rows to an empty array when a Complete response carries no results field", async () => {
    const send = vi.fn().mockResolvedValue({ status: "Complete" });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const result = await client.awaitResults("q-empty");

    expect(result.rows).toEqual([]);
  });

  test("normalizes rows: undefined value becomes '' and a field-less entry is skipped", async () => {
    const send = vi.fn().mockResolvedValue({
      status: "Complete",
      results: [
        [
          { field: "@ptr", value: undefined },
          { value: "orphan-value-no-field" },
          { field: "count" },
        ],
      ],
    });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const result = await client.awaitResults("q-norm");

    expect(result.rows).toEqual([{ "@ptr": "", count: "" }]);
  });

  test("omits the statistics key entirely when the AWS response carries none", async () => {
    const send = vi.fn().mockResolvedValue({ status: "Complete", results: [] });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const result = await client.awaitResults("q-no-stats");

    expect(Object.hasOwn(result, "statistics")).toBe(false);
  });
});

describe("M3LLogsInsightsClient.runQuery", () => {
  test("composes startQuery + awaitResults into one call", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: "q-run" })
      .mockResolvedValueOnce({ status: "Complete", results: [] });
    const client = new M3LLogsInsightsClient(fakeClient(send));

    const result = await client.runQuery({
      logGroupNames: ["/aws/lambda/example"],
      queryString: "fields @timestamp",
      startTime: 0,
      endTime: 60,
    });

    expect(result.queryId).toBe("q-run");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("M3LLogsInsightsClient types", () => {
  test("startQuery/awaitResults/runQuery are typed per the contract", () => {
    expectTypeOf<M3LLogsInsightsClient["startQuery"]>().returns.toEqualTypeOf<
      Promise<string>
    >();
    expectTypeOf<M3LLogsInsightsClient["awaitResults"]>().returns.toEqualTypeOf<
      Promise<LogsInsightsQueryResult>
    >();
    expectTypeOf<
      LogsInsightsQueryResult["status"]
    >().toEqualTypeOf<"Complete">();
  });
});
