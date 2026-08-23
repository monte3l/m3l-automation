import { describe, expect, it, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  createLogsInsightsGatherer,
  MAX_LOG_GROUPS,
} from "../../src/steps/gather-logs.js";
import type { AnalysisQueryRequest } from "../../src/steps/preset.js";

/** A `M3LLogsInsightsClient` double: only `runQuery` is ever reached. */
function fakeClient(rows: readonly Record<string, string>[] = []): {
  readonly client: AWS.M3LLogsInsightsClient;
  readonly runQuery: ReturnType<typeof vi.fn>;
} {
  const runQuery = vi.fn().mockResolvedValue({
    queryId: "q-1",
    status: "Complete",
    rows,
  });
  return {
    client: { runQuery } as unknown as AWS.M3LLogsInsightsClient,
    runQuery,
  };
}

/** A request with every field the gatherer reads. */
function request(
  overrides: Partial<AnalysisQueryRequest> = {},
): AnalysisQueryRequest {
  return {
    logGroups: ["/example/entry"],
    query: "fields @message",
    startTime: 1_700_000_000,
    endTime: 1_700_003_600,
    limit: undefined,
    signal: undefined,
    ...overrides,
  };
}

describe("createLogsInsightsGatherer", () => {
  it("maps a stage request onto the typed wrapper and returns its rows", async () => {
    const { client, runQuery } = fakeClient([{ "@message": "boom" }]);
    const gatherer = createLogsInsightsGatherer({
      client,
      logger: new Core.M3LLogger([]),
    });
    await expect(gatherer.query(request({ limit: 25 }))).resolves.toEqual([
      { "@message": "boom" },
    ]);
    expect(runQuery).toHaveBeenCalledWith({
      logGroupNames: ["/example/entry"],
      queryString: "fields @message",
      startTime: 1_700_000_000,
      endTime: 1_700_003_600,
      limit: 25,
    });
  });

  it("omits limit entirely when the stage declares none", async () => {
    const { client, runQuery } = fakeClient();
    await createLogsInsightsGatherer({
      client,
      logger: new Core.M3LLogger([]),
    }).query(request());
    expect(runQuery.mock.calls[0]?.[0]).not.toHaveProperty("limit");
  });

  it("forwards an abort signal so a pending poll is cancellable (ADR-0049)", async () => {
    const { client, runQuery } = fakeClient();
    const controller = new AbortController();
    await createLogsInsightsGatherer({
      client,
      logger: new Core.M3LLogger([]),
    }).query(request({ signal: controller.signal }));
    expect(runQuery.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("passes no options object at all when there is no signal to forward", async () => {
    const { client, runQuery } = fakeClient();
    await createLogsInsightsGatherer({
      client,
      logger: new Core.M3LLogger([]),
    }).query(request());
    expect(runQuery.mock.calls[0]).toHaveLength(1);
  });

  it("rejects a stage that declares no log groups, before reaching AWS", async () => {
    const { client, runQuery } = fakeClient();
    await expect(
      createLogsInsightsGatherer({
        client,
        logger: new Core.M3LLogger([]),
      }).query(request({ logGroups: [] })),
    ).rejects.toThrow(/declared no log groups/u);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects a stage above the AWS log-group ceiling, naming the limit", async () => {
    const { client } = fakeClient();
    const tooMany = Array.from(
      { length: MAX_LOG_GROUPS + 1 },
      (_unused, index) => `/example/${String(index)}`,
    );
    await expect(
      createLogsInsightsGatherer({
        client,
        logger: new Core.M3LLogger([]),
      }).query(request({ logGroups: tooMany })),
    ).rejects.toThrow(new RegExp(String(MAX_LOG_GROUPS), "u"));
  });

  it("rejects an empty or inverted window rather than querying it", async () => {
    const { client, runQuery } = fakeClient();
    await expect(
      createLogsInsightsGatherer({
        client,
        logger: new Core.M3LLogger([]),
      }).query(request({ startTime: 100, endTime: 100 })),
    ).rejects.toThrow(Core.M3LError);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("logs query metadata only — never the log groups' names or row content", async () => {
    const { client } = fakeClient([{ "@message": "a secret log line" }]);
    const logger = new Core.M3LLogger([]);
    const info = vi.spyOn(logger, "info");
    await createLogsInsightsGatherer({ client, logger }).query(request());
    expect(info).toHaveBeenCalledWith(
      "querying log groups for alarm evidence",
      {
        logGroups: 1,
        startTime: 1_700_000_000,
        endTime: 1_700_003_600,
      },
    );
  });
});
