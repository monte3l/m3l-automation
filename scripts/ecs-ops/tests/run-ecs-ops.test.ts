import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

/**
 * Contract: docs/reference/scripts/ecs-ops.md `run-ecs-ops` row — the
 * orchestrator/dispatcher. Resolves and guard-checks config per operation
 * (throws `ERR_ECS_OPS_CONFIG` before any AWS call); for `create-service`/
 * `update-service`, reads + JSON-parses `input` here (into a
 * `Record<string, unknown>`, the ONE place either file is ever read); runs
 * `destructive-gate` for every mutating operation
 * (`create-service`/`update-service`/`delete-service`); dynamic-imports and
 * dispatches to the operation-appropriate step; persists the returned
 * result to `output` (via `Core.M3LJSONFileExporter`, BEFORE the next
 * check); for `wait-services-stable`, throws `ERR_ECS_OPS_WAIT_NOT_STABLE`
 * when the resolved `M3LECSWaiterResult.state` is not `"SUCCESS"` —
 * persisting the result first. Step modules are mocked (this file asserts
 * ONLY the orchestrator's guard/gate/dispatch/persist wiring, never a
 * step's internal logic — that is each step's own test file's job);
 * `node:fs/promises` and `Core.M3LJSONFileExporter` are the true I/O
 * boundary, also mocked.
 */

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const destructiveGateMock = vi.fn().mockResolvedValue(undefined);
const readServicesMock = vi.fn();
const writeServiceMock = vi.fn();
const waitServicesMock = vi.fn();
const readClustersMock = vi.fn();

vi.mock("../src/steps/destructive-gate.js", () => ({
  destructiveGate: destructiveGateMock,
}));
vi.mock("../src/steps/read-services.js", () => ({
  readServices: readServicesMock,
}));
vi.mock("../src/steps/write-service.js", () => ({
  writeService: writeServiceMock,
}));
vi.mock("../src/steps/wait-services.js", () => ({
  waitServices: waitServicesMock,
}));
vi.mock("../src/steps/read-clusters.js", () => ({
  readClusters: readClustersMock,
}));

import { Core } from "@m3l-automation/m3l-common";

import { runEcsOps } from "../src/steps/run-ecs-ops.js";
import { buildConfig, createFakeEcsOperations } from "./support/ecsFakes.js";

const PATHS = new Core.M3LPaths();

const SERVICE_DESCRIPTION = {
  serviceArn: "arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc",
  serviceName: "my-svc",
  clusterArn: "arn:aws:ecs:us-east-1:123:cluster/my-cluster",
  status: "ACTIVE",
  desiredCount: 1,
  runningCount: 1,
  pendingCount: 0,
};

/** Stubs `fsp.readFile` keyed by the exact resolved path it is called with. */
function stubReadFileByPath(entries: Record<string, string | Buffer>): void {
  vi.spyOn(fsp, "readFile").mockImplementation(((filePath: unknown) => {
    const key = String(filePath);
    const value = entries[key];
    if (value === undefined) {
      return Promise.reject(
        new Error(`stubReadFileByPath: unexpected path ${key}`),
      );
    }
    return Promise.resolve(
      typeof value === "string" ? Buffer.from(value, "utf8") : value,
    );
  }) as typeof fsp.readFile);
}

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: {
    readonly operations?: ReturnType<typeof createFakeEcsOperations>;
    readonly prompt?: Core.M3LPrompt;
  },
): Parameters<typeof runEcsOps>[0] {
  return {
    config: buildConfig(configValues),
    paths: PATHS,
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    operations: overrides?.operations ?? createFakeEcsOperations(),
    prompt: overrides?.prompt ?? new Core.M3LPrompt(),
  };
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies; it does not clear the
  // plain vi.fn() mocks created inside the top-level vi.mock() factories
  // above, so their call history would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(fsp.readFile).mockReset();
  destructiveGateMock.mockReset().mockResolvedValue(undefined);
  readServicesMock.mockReset();
  writeServiceMock.mockReset();
  waitServicesMock.mockReset();
  readClustersMock.mockReset();
});

describe("runEcsOps — per-operation config guards (fire before any AWS call or step dispatch)", () => {
  test.each(["describe-service", "delete-service", "wait-services-stable"])(
    "throws ERR_ECS_OPS_CONFIG when operation '%s' is missing 'cluster'",
    async (operation) => {
      const deps = buildDeps({ operation, service: "my-svc", services: "a" });

      await expect(runEcsOps(deps)).rejects.toMatchObject({
        code: "ERR_ECS_OPS_CONFIG",
      });
      expect(destructiveGateMock).not.toHaveBeenCalled();
      expect(readServicesMock).not.toHaveBeenCalled();
      expect(writeServiceMock).not.toHaveBeenCalled();
      expect(waitServicesMock).not.toHaveBeenCalled();
      expect(readClustersMock).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_ECS_OPS_CONFIG when operation 'describe-cluster' is missing 'cluster'", async () => {
    const deps = buildDeps({ operation: "describe-cluster" });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_CONFIG",
    });
    expect(readClustersMock).not.toHaveBeenCalled();
  });

  test.each(["describe-service", "delete-service"])(
    "throws ERR_ECS_OPS_CONFIG when operation '%s' is missing 'service'",
    async (operation) => {
      const deps = buildDeps({ operation, cluster: "my-cluster" });

      await expect(runEcsOps(deps)).rejects.toMatchObject({
        code: "ERR_ECS_OPS_CONFIG",
      });
      expect(readServicesMock).not.toHaveBeenCalled();
      expect(writeServiceMock).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_ECS_OPS_CONFIG when operation 'wait-services-stable' is missing 'services'", async () => {
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
    });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_CONFIG",
    });
    expect(waitServicesMock).not.toHaveBeenCalled();
  });

  test.each(["create-service", "update-service"])(
    "throws ERR_ECS_OPS_CONFIG when operation '%s' is missing 'input'",
    async (operation) => {
      const deps = buildDeps({ operation });

      await expect(runEcsOps(deps)).rejects.toMatchObject({
        code: "ERR_ECS_OPS_CONFIG",
      });
      expect(destructiveGateMock).not.toHaveBeenCalled();
      expect(writeServiceMock).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_ECS_OPS_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({ operation: "frobnicate" });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_CONFIG",
    });
    expect(readServicesMock).not.toHaveBeenCalled();
    expect(writeServiceMock).not.toHaveBeenCalled();
    expect(waitServicesMock).not.toHaveBeenCalled();
    expect(readClustersMock).not.toHaveBeenCalled();
  });
});

describe("runEcsOps — 'services' comma-split/trim/drop-empty semantics", () => {
  test("splits on ',', trims each segment, and drops empty segments before dispatching to waitServices", async () => {
    waitServicesMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: " svc-a ,svc-b,, svc-c ",
    });

    await runEcsOps(deps);

    expect(waitServicesMock).toHaveBeenCalledWith(
      expect.objectContaining({ services: ["svc-a", "svc-b", "svc-c"] }),
    );
  });

  test("throws ERR_ECS_OPS_CONFIG when 'services' is empty after split+trim+drop-empty", async () => {
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: " , , ",
    });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_CONFIG",
    });
    expect(waitServicesMock).not.toHaveBeenCalled();
  });
});

describe("runEcsOps — destructive-gate dispatch (create/update/delete-service only)", () => {
  test.each([
    "list-services",
    "describe-service",
    "list-clusters",
    "describe-cluster",
  ])("never runs destructive-gate for '%s'", async (operation) => {
    readServicesMock.mockResolvedValue({ serviceArns: [] });
    readClustersMock.mockResolvedValue({ clusterArns: [] });
    const deps = buildDeps({
      operation,
      cluster: "my-cluster",
      service: "my-svc",
    });

    await runEcsOps(deps);

    expect(destructiveGateMock).not.toHaveBeenCalled();
  });

  test("never runs destructive-gate for 'wait-services-stable'", async () => {
    waitServicesMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: "svc-a",
    });

    await runEcsOps(deps);

    expect(destructiveGateMock).not.toHaveBeenCalled();
  });

  test("runs destructive-gate before dispatching 'delete-service', building description from cluster/service config values", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "delete-service",
      cluster: "my-cluster",
      service: "my-svc",
    });

    await runEcsOps(deps);

    expect(destructiveGateMock).toHaveBeenCalledTimes(1);
    const call = destructiveGateMock.mock.calls[0] as [
      { readonly description: string; readonly yes: boolean },
    ];
    expect(call[0].description).toContain("my-cluster");
    expect(call[0].description).toContain("my-svc");
    expect(call[0].yes).toBe(false);
  });

  test("forwards 'yes' through to destructive-gate", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "delete-service",
      cluster: "my-cluster",
      service: "my-svc",
      yes: true,
    });

    await runEcsOps(deps);

    const call = destructiveGateMock.mock.calls[0] as [
      { readonly yes: boolean },
    ];
    expect(call[0].yes).toBe(true);
  });

  test("propagates ERR_ECS_OPS_ABORTED from destructive-gate, never dispatching writeService", async () => {
    destructiveGateMock.mockRejectedValue(
      new Core.M3LError("aborted", { code: "ERR_ECS_OPS_ABORTED" }),
    );
    const deps = buildDeps({
      operation: "delete-service",
      cluster: "my-cluster",
      service: "my-svc",
    });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_ABORTED",
    });
    expect(writeServiceMock).not.toHaveBeenCalled();
  });

  test("builds the 'create-service' gate description from the parsed input's serviceName/cluster", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    const parsedInput = {
      cluster: "my-cluster",
      serviceName: "my-svc",
      taskDefinition: "my-task:1",
    };
    stubReadFileByPath({ [inputPath]: JSON.stringify(parsedInput) });
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "create-service",
      input: "create.json",
    });

    await runEcsOps(deps);

    const call = destructiveGateMock.mock.calls[0] as [
      { readonly description: string },
    ];
    expect(call[0].description).toContain("my-cluster");
    expect(call[0].description).toContain("my-svc");
  });

  test("falls back to a generic '(see input file)' phrase when the parsed input has neither serviceName/service nor cluster", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify({}) });
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "create-service",
      input: "create.json",
    });

    await runEcsOps(deps);

    const call = destructiveGateMock.mock.calls[0] as [
      { readonly description: string },
    ];
    expect(call[0].description).toContain("(see input file)");
  });

  test("builds the 'update-service' gate description using the parsed input's 'service' field (serviceName ?? service fallback)", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    const parsedInput = { cluster: "my-cluster", service: "my-svc" };
    stubReadFileByPath({ [inputPath]: JSON.stringify(parsedInput) });
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "update-service",
      input: "update.json",
    });

    await runEcsOps(deps);

    const call = destructiveGateMock.mock.calls[0] as [
      { readonly description: string },
    ];
    expect(call[0].description).toContain("my-cluster");
    expect(call[0].description).toContain("my-svc");
  });
});

describe("runEcsOps — operation dispatch routing", () => {
  test("'list-services' dispatches to readServices with the resolved cluster/nextToken", async () => {
    readServicesMock.mockResolvedValue({ serviceArns: [] });
    const deps = buildDeps({
      operation: "list-services",
      cluster: "my-cluster",
      nextToken: "prev-token",
    });

    await runEcsOps(deps);

    expect(readServicesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list-services",
        cluster: "my-cluster",
        nextToken: "prev-token",
        operations: deps.operations,
      }),
    );
  });

  test("'describe-service' dispatches to readServices with cluster/service", async () => {
    readServicesMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "describe-service",
      cluster: "my-cluster",
      service: "my-svc",
    });

    await runEcsOps(deps);

    expect(readServicesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "describe-service",
        cluster: "my-cluster",
        service: "my-svc",
      }),
    );
  });

  test("'create-service' reads + parses input JSON, dispatching the record to writeService", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    const parsedInput = {
      cluster: "my-cluster",
      serviceName: "my-svc",
      taskDefinition: "my-task:1",
    };
    stubReadFileByPath({ [inputPath]: JSON.stringify(parsedInput) });
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "create-service",
      input: "create.json",
    });

    await runEcsOps(deps);

    expect(writeServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create-service",
        input: parsedInput,
      }),
    );
  });

  test("'delete-service' dispatches to writeService with cluster/service/force from config, input undefined", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const deps = buildDeps({
      operation: "delete-service",
      cluster: "my-cluster",
      service: "my-svc",
      force: true,
    });

    await runEcsOps(deps);

    expect(writeServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "delete-service",
        cluster: "my-cluster",
        service: "my-svc",
        force: true,
        input: undefined,
      }),
    );
  });

  test("'wait-services-stable' dispatches to waitServices with cluster/split-services/maxWaitTime", async () => {
    waitServicesMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: "svc-a,svc-b",
      maxWaitTime: 120,
    });

    await runEcsOps(deps);

    expect(waitServicesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: "my-cluster",
        services: ["svc-a", "svc-b"],
        maxWaitTime: 120,
      }),
    );
  });

  test("'list-clusters' dispatches to readClusters with nextToken", async () => {
    readClustersMock.mockResolvedValue({ clusterArns: [] });
    const deps = buildDeps({
      operation: "list-clusters",
      nextToken: "prev-token",
    });

    await runEcsOps(deps);

    expect(readClustersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list-clusters",
        nextToken: "prev-token",
      }),
    );
  });

  test("'describe-cluster' dispatches to readClusters with cluster", async () => {
    readClustersMock.mockResolvedValue({
      clusterArn: "arn:aws:ecs:us-east-1:123:cluster/my-cluster",
      clusterName: "my-cluster",
    });
    const deps = buildDeps({
      operation: "describe-cluster",
      cluster: "my-cluster",
    });

    await runEcsOps(deps);

    expect(readClustersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "describe-cluster",
        cluster: "my-cluster",
      }),
    );
  });
});

describe("runEcsOps — output persistence", () => {
  test("persists the result to 'output' via Core.M3LJSONFileExporter when configured", async () => {
    const result = { serviceArns: [] };
    readServicesMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "list-services",
      output: "result.json",
    });

    await runEcsOps(deps);

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result);
  });

  test("does not persist anything when 'output' is unset", async () => {
    readServicesMock.mockResolvedValue({ serviceArns: [] });
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({ operation: "list-services" });

    await runEcsOps(deps);

    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe("runEcsOps — wait-services-stable: persist-then-throw ordering on non-SUCCESS", () => {
  test("persists the output BEFORE throwing ERR_ECS_OPS_WAIT_NOT_STABLE when 'output' is configured", async () => {
    const result = { state: "TIMEOUT", reason: "took too long" };
    waitServicesMock.mockResolvedValue(result);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: "svc-a",
      output: "result.json",
    });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_WAIT_NOT_STABLE",
    });

    // The persist call having actually happened (rather than being skipped
    // because the throw fired first) is what proves the ordering: if the
    // implementation threw before persisting, exportSpy would never be
    // called at all.
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith(result);
  });

  test("still throws ERR_ECS_OPS_WAIT_NOT_STABLE when 'output' is unset (nothing to persist)", async () => {
    waitServicesMock.mockResolvedValue({ state: "ABORTED" });
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: "svc-a",
    });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_WAIT_NOT_STABLE",
    });
  });

  test("does not throw when 'wait-services-stable' resolves SUCCESS", async () => {
    waitServicesMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: "svc-a",
    });

    await expect(runEcsOps(deps)).resolves.toBeUndefined();
  });
});

describe("runEcsOps — malformed/unreadable input-file failure paths", () => {
  test("wraps an unreadable input file's read failure as ERR_ECS_OPS_CONFIG, chaining the raw cause", async () => {
    const cause = new Error("ENOENT: no such file or directory");
    vi.spyOn(fsp, "readFile").mockRejectedValue(cause);
    const deps = buildDeps({
      operation: "create-service",
      input: "create.json",
    });

    let thrown: unknown;
    try {
      await runEcsOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ECS_OPS_CONFIG");
    expect((thrown as Core.M3LError).cause).toBe(cause);
    expect(writeServiceMock).not.toHaveBeenCalled();
  });

  test("throws ERR_ECS_OPS_CONFIG ('must be valid JSON') when the input file's content is malformed JSON", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    const deps = buildDeps({
      operation: "create-service",
      input: "create.json",
    });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_CONFIG",
    });
    expect(writeServiceMock).not.toHaveBeenCalled();
  });

  test("throws ERR_ECS_OPS_CONFIG ('must decode to a JSON object') when the parsed input is a JSON array", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify([1, 2, 3]) });
    const deps = buildDeps({
      operation: "update-service",
      input: "update.json",
    });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_CONFIG",
    });
    expect(writeServiceMock).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("runEcsOps resolves void", () => {
    expectTypeOf(runEcsOps).returns.toEqualTypeOf<Promise<void>>();
  });
});
