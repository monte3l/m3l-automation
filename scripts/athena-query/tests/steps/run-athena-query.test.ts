import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

/**
 * Contract: docs/reference/scripts/athena-query.md, `run-athena-query` row +
 * "Resume and failure semantics". The orchestrator builds a
 * `StartAthenaQueryInput` from config, checkpoints-or-reattaches
 * (`Core.M3LCheckpointStore` + `AWS.M3LAthenaClient.startQuery()`, recording
 * `queryExecutionId`, or reattaching to a checkpointed one), calls
 * `awaitResults()`, calls `export-results` once, then deletes the
 * checkpoint. A terminal query failure aborts the run with the checkpoint
 * left intact.
 *
 * `Core.M3LCheckpointStore` and `export-results.ts` are mocked (per the
 * brief) so this file asserts the ORCHESTRATION contract in isolation: call
 * order, queryExecutionId checkpointing before the poll, and abort-on-
 * terminal-failure. `Core.M3LCheckpointStore` is a stable library class
 * (constructed directly by the source, not a locally dynamic-imported step),
 * so it is intercepted via a package-level
 * `vi.mock("@m3l-automation/m3l-common", ...)` factory that spreads the real
 * module and overrides only `Core.M3LCheckpointStore` with a mocked
 * constructor — matching `scripts/lambda-ops/tests/run-lambda-ops.test.ts`'s
 * pattern for `Core.confirmDestructive`. There is a `resolve-settings` step
 * (`resolveAthenaSettings`), but unlike `cloudwatch-logs-insights`'s it is
 * simpler — just per-field narrowing of the resolved config into
 * `StartAthenaQueryInput`, no cross-parameter or ISO-8601 checks — so it is
 * exercised directly here rather than mocked.
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

import {
  isAthenaCheckpoint,
  runAthenaQuery,
  type AthenaCheckpoint,
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
  checkpointMocks.read.mockReset();
  checkpointMocks.write.mockReset().mockResolvedValue(undefined);
  checkpointMocks.delete.mockReset().mockResolvedValue(undefined);
  exportResultsMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(Core.M3LCheckpointStore).mockClear();
});

describe("runAthenaQuery — happy path (fresh run)", () => {
  it("builds StartAthenaQueryInput from config, starts the query, checkpoints queryExecutionId, awaits results, exports once, then deletes the checkpoint", async () => {
    const callOrder: string[] = [];
    const client = buildClient();
    client.startQuery.mockImplementation(() => {
      callOrder.push("startQuery");
      return Promise.resolve("query-123");
    });
    checkpointMocks.write.mockImplementation(
      (checkpoint: { queryExecutionId?: string }) => {
        callOrder.push(
          `writeCheckpoint:${checkpoint.queryExecutionId ?? "none"}`,
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
    exportResultsMock.mockImplementation(() => {
      callOrder.push("exportResults");
      return Promise.resolve();
    });
    checkpointMocks.delete.mockImplementation(() => {
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
    expect(checkpointMocks.read).not.toHaveBeenCalled();

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

    expect(exportResultsMock).toHaveBeenCalledTimes(1);
    expect(exportResultsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          { id: "1", name: "alice" },
          { id: "2", name: "bob" },
        ],
        format: "json",
        output: "results.json",
      }),
    );

    expect(checkpointMocks.delete).toHaveBeenCalledTimes(1);

    expect(summary).toEqual({
      rowsExported: 2,
      queryExecutionId: "query-123",
    });
  });

  it("threads deps.signal through to awaitResults as { signal } when supplied", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-789");
    client.awaitResults.mockResolvedValue(buildResult("query-789", []));

    const config = buildConfig({ ...BASE_VALUES });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();
    const controller = new AbortController();

    await runAthenaQuery({
      config,
      logger,
      client: asClient(client),
      paths,
      signal: controller.signal,
    });

    expect(client.awaitResults).toHaveBeenCalledTimes(1);
    expect(client.awaitResults).toHaveBeenCalledWith("query-789", {
      signal: controller.signal,
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
    checkpointMocks.read.mockResolvedValue({
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

    expect(checkpointMocks.read).toHaveBeenCalledTimes(1);
    expect(client.startQuery).not.toHaveBeenCalled();
    expect(client.awaitResults).toHaveBeenCalledWith("query-inflight");
    expect(exportResultsMock).toHaveBeenCalledTimes(1);
    expect(checkpointMocks.delete).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      rowsExported: 1,
      queryExecutionId: "query-inflight",
    });
  });

  it("with resume true but an empty checkpoint (no prior queryExecutionId), starts a fresh query", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-fresh");
    client.awaitResults.mockResolvedValue(buildResult("query-fresh", []));
    checkpointMocks.read.mockResolvedValue({});

    const config = buildConfig({ ...BASE_VALUES, resume: true });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    expect(checkpointMocks.read).toHaveBeenCalledTimes(1);
    expect(client.startQuery).toHaveBeenCalledTimes(1);
    expect(client.awaitResults).toHaveBeenCalledWith("query-fresh");
  });

  it("propagates ERR_CHECKPOINT_MISSING when resuming with no checkpoint file, never calling startQuery", async () => {
    const client = buildClient();
    checkpointMocks.read.mockRejectedValue(
      new Core.M3LCheckpointError("no checkpoint file found", {
        code: "ERR_CHECKPOINT_MISSING",
      }),
    );

    const config = buildConfig({ ...BASE_VALUES, resume: true });
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

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_MISSING",
    );
    expect(client.startQuery).not.toHaveBeenCalled();
    expect(exportResultsMock).not.toHaveBeenCalled();
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
    expect(exportResultsMock).not.toHaveBeenCalled();
    expect(checkpointMocks.delete).not.toHaveBeenCalled();

    // The checkpoint WAS written with the in-flight id before the poll, so a
    // future resume can reattach — only the delete-on-success step is
    // skipped.
    expect(checkpointMocks.write).toHaveBeenCalledWith({
      queryExecutionId: "query-abort",
    });
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
    expect(exportResultsMock).not.toHaveBeenCalled();
    expect(checkpointMocks.delete).not.toHaveBeenCalled();

    // A startQuery failure happens strictly before the checkpoint write that
    // would record a queryExecutionId, so no checkpoint write fires at all.
    expect(checkpointMocks.write).not.toHaveBeenCalled();
  });
});

describe("runAthenaQuery — checkpoint definition (issue #497 A4b)", () => {
  /**
   * Contract: `Core.M3LCheckpointStore` is constructed with a `definition`
   * option built as an explicit projection of `settings.startInput` —
   * `queryString`, `database`, `catalog`, `workGroup`, `executionParameters`,
   * `outputLocation` — plus `awsProfile` (resolved from the `aws.profile`
   * config parameter, `Core.AWS_PROFILE_PARAM_NAME`) — excluding `output`
   * (already the checkpoint's `name`), `format`, and `resume`.
   *
   * Both `outputLocation` and `awsProfile` are part of "what a checkpointed
   * `queryExecutionId` means": `outputLocation` becomes
   * `ResultConfiguration.OutputLocation` on `StartQueryExecution`, and
   * `awsProfile` selects the AWS account/region the execution id was minted
   * under — a `--resume` after switching profiles must fail loud with
   * `ERR_CHECKPOINT_FINGERPRINT_MISMATCH` rather than silently reattaching
   * to an execution id from a different account (issue #497 review round 2).
   */
  function getCheckpointStoreOptions(
    callIndex: number,
  ): Core.M3LCheckpointStoreOptions<AthenaCheckpoint> {
    const call = vi.mocked(Core.M3LCheckpointStore).mock.calls[callIndex];
    if (call === undefined) {
      throw new Error(
        `Core.M3LCheckpointStore was not called at index ${String(callIndex)}`,
      );
    }
    return call[0];
  }

  it("passes a definition projected from startInput (queryString, database, catalog, workGroup, executionParameters, outputLocation) plus awsProfile on a fresh run", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-def-1");
    client.awaitResults.mockResolvedValue(buildResult("query-def-1", []));

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

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    const options = getCheckpointStoreOptions(0);
    expect(options.definition).toEqual({
      queryString: "SELECT * FROM my_table",
      database: "my_db",
      catalog: "my_catalog",
      workGroup: "primary",
      executionParameters: ["param-1"],
      outputLocation: "s3://bucket/",
      awsProfile: "my-profile",
    });
  });

  it("includes awsProfile in the definition, resolved from the aws.profile config parameter (not hardcoded)", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-def-profile");
    client.awaitResults.mockResolvedValue(buildResult("query-def-profile", []));

    const config = buildConfig({
      ...BASE_VALUES,
      "aws.profile": "distinct-custom-profile",
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    const options = getCheckpointStoreOptions(0);
    const definitionArg = options.definition as Record<string, unknown>;
    expect(definitionArg["awsProfile"]).toBe("distinct-custom-profile");
  });

  it("omits unset optional fields (including outputLocation) from the definition rather than passing them as undefined", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-def-2");
    client.awaitResults.mockResolvedValue(buildResult("query-def-2", []));

    const config = buildConfig({ ...BASE_VALUES });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    const options = getCheckpointStoreOptions(0);
    const definitionArg = options.definition as Record<string, unknown>;
    expect(definitionArg["queryString"]).toBe("SELECT * FROM my_table");
    // awsProfile is a required config parameter, so it's always present —
    // unlike the optional startInput fields below, it is never omitted.
    expect(definitionArg["awsProfile"]).toBe("my-profile");
    expect(Object.hasOwn(definitionArg, "database")).toBe(false);
    expect(Object.hasOwn(definitionArg, "catalog")).toBe(false);
    expect(Object.hasOwn(definitionArg, "workGroup")).toBe(false);
    expect(Object.hasOwn(definitionArg, "executionParameters")).toBe(false);
    expect(Object.hasOwn(definitionArg, "outputLocation")).toBe(false);
  });

  it("includes outputLocation in the definition when startInput.outputLocation is set", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-def-outloc");
    client.awaitResults.mockResolvedValue(buildResult("query-def-outloc", []));

    const config = buildConfig({
      ...BASE_VALUES,
      outputLocation: "s3://bucket/results/",
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    const options = getCheckpointStoreOptions(0);
    const definitionArg = options.definition as Record<string, unknown>;
    expect(definitionArg["outputLocation"]).toBe("s3://bucket/results/");
  });

  it("never includes output, format, or resume in the definition", async () => {
    const client = buildClient();
    client.startQuery.mockResolvedValue("query-def-3");
    client.awaitResults.mockResolvedValue(buildResult("query-def-3", []));

    const config = buildConfig({
      ...BASE_VALUES,
      outputLocation: "s3://bucket/",
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    const options = getCheckpointStoreOptions(0);
    const definitionArg = options.definition as Record<string, unknown>;
    expect(Object.hasOwn(definitionArg, "output")).toBe(false);
    expect(Object.hasOwn(definitionArg, "format")).toBe(false);
    expect(Object.hasOwn(definitionArg, "resume")).toBe(false);
    // outputLocation IS part of what a checkpointed queryExecutionId means
    // (issue #497 review round 2), so it is expected to be present here.
    expect(Object.hasOwn(definitionArg, "outputLocation")).toBe(true);
  });

  it("passes the same definition shape on the --resume path", async () => {
    const client = buildClient();
    client.awaitResults.mockResolvedValue(
      buildResult("query-inflight-def", [{ id: "1", name: "alice" }]),
    );
    checkpointMocks.read.mockResolvedValue({
      queryExecutionId: "query-inflight-def",
    });

    const config = buildConfig({
      ...BASE_VALUES,
      resume: true,
      database: "my_db",
      catalog: "my_catalog",
      outputLocation: "s3://bucket/",
      workGroup: "primary",
      executionParameters: ["param-1"],
    });
    const logger = new Core.M3LLogger([]);
    const paths = buildPaths();

    await runAthenaQuery({ config, logger, client: asClient(client), paths });

    const options = getCheckpointStoreOptions(0);
    expect(options.definition).toEqual({
      queryString: "SELECT * FROM my_table",
      database: "my_db",
      catalog: "my_catalog",
      workGroup: "primary",
      executionParameters: ["param-1"],
      outputLocation: "s3://bucket/",
      awsProfile: "my-profile",
    });
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

describe("isAthenaCheckpoint", () => {
  it.each<[string, unknown]>([
    ["a non-object", "not-an-object"],
    ["null", null],
    ["an array", []],
    [
      "an object whose queryExecutionId is present but not a string",
      { queryExecutionId: 123 },
    ],
  ])("rejects %s", (_description, candidate) => {
    expect(isAthenaCheckpoint(candidate)).toBe(false);
  });

  it("accepts an object with no queryExecutionId (the optional field absent)", () => {
    const candidate: AthenaCheckpoint = {};
    expect(isAthenaCheckpoint(candidate)).toBe(true);
  });

  it("accepts a well-formed checkpoint with a string queryExecutionId", () => {
    const candidate: AthenaCheckpoint = { queryExecutionId: "q-123" };
    expect(isAthenaCheckpoint(candidate)).toBe(true);
  });
});
