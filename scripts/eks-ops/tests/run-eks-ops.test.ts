import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

/**
 * Contract: `scripts/eks-ops/src/steps/run-eks-ops.ts` — the dispatcher for
 * all 16 `EKS_OPS_OPERATIONS`. Resolves + guard-checks config per operation
 * (throws `ERR_EKS_OPS_CONFIG`); for the 4 `input`-bearing operations, reads
 * + JSON-parses `input` here; runs `Core.confirmDestructive` for every one
 * of the 8 mutating operations only; converts a `describe-cluster`/
 * `describe-nodegroup` `undefined` result into `ERR_EKS_OPS_NOT_FOUND`
 * BEFORE any persist attempt; persists the returned result to `output` when
 * configured (via `Core.M3LJSONFileExporter`) BEFORE the next check; throws
 * `ERR_EKS_OPS_UPDATE_FAILED` when an `update-*` result's
 * `M3LEKSUpdate.status === "Failed"`, and `ERR_EKS_OPS_WAIT_NOT_COMPLETE`
 * when a `wait-*` result's `state !== "SUCCESS"` — both AFTER persisting;
 * logs a run summary built only from `state`/`reason`/`status`, never a raw
 * waiter error or the full `M3LEKSUpdate`/`M3LEKSWaiterResult` verbatim (see
 * `docs/reference/scripts/eks-ops.md` § Security note). Step modules are
 * mocked (this file asserts ONLY the orchestrator's guard/gate/dispatch/
 * persist wiring, never a step's internal logic — that is each step's own
 * test file's job); `node:fs/promises` and `Core.M3LJSONFileExporter` are the
 * true I/O boundary, also mocked. `Core.confirmDestructive` is intercepted
 * via a package-level `vi.mock("@m3l-automation/m3l-common", ...)` factory
 * that spreads the real module and overrides only `Core.confirmDestructive`.
 */

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// vi.hoisted() for every mock referenced inside a vi.mock(...) factory below:
// @m3l-automation/m3l-common is imported statically further down, so its
// factory runs eagerly at module-eval time — before a plain top-level const
// would have initialized. The six step-module mocks are hoisted defensively
// too, since it is not yet known (the implementation doesn't exist) whether
// run-eks-ops.ts will reach them via a static or a dynamic import() — see
// `.claude/rules/tests.md`'s note on this exact hazard.
const destructiveGateMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const readClustersMock = vi.hoisted(() => vi.fn());
const writeClusterMock = vi.hoisted(() => vi.fn());
const waitClusterMock = vi.hoisted(() => vi.fn());
const readNodegroupsMock = vi.hoisted(() => vi.fn());
const writeNodegroupMock = vi.hoisted(() => vi.fn());
const waitNodegroupMock = vi.hoisted(() => vi.fn());

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    Core: { ...actual.Core, confirmDestructive: destructiveGateMock },
  };
});
vi.mock("../src/steps/read-clusters.js", () => ({
  readClusters: readClustersMock,
}));
vi.mock("../src/steps/write-cluster.js", () => ({
  writeCluster: writeClusterMock,
}));
vi.mock("../src/steps/wait-cluster.js", () => ({
  waitCluster: waitClusterMock,
}));
vi.mock("../src/steps/read-nodegroups.js", () => ({
  readNodegroups: readNodegroupsMock,
}));
vi.mock("../src/steps/write-nodegroup.js", () => ({
  writeNodegroup: writeNodegroupMock,
}));
vi.mock("../src/steps/wait-nodegroup.js", () => ({
  waitNodegroup: waitNodegroupMock,
}));

import { Core } from "@m3l-automation/m3l-common";

import { runEksOps } from "../src/steps/run-eks-ops.js";
import { buildConfig, createFakeEKSOperations } from "./support/eksFakes.js";

const PATHS = new Core.M3LPaths();

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
    readonly operations?: ReturnType<typeof createFakeEKSOperations>;
    readonly prompt?: Core.M3LPrompt;
    readonly logger?: Core.M3LLogger;
  },
): Parameters<typeof runEksOps>[0] {
  return {
    config: buildConfig(configValues),
    paths: PATHS,
    logger: overrides?.logger ?? new Core.M3LLogger([]),
    operations: overrides?.operations ?? createFakeEKSOperations(),
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
  readClustersMock.mockReset();
  writeClusterMock.mockReset();
  waitClusterMock.mockReset();
  readNodegroupsMock.mockReset();
  writeNodegroupMock.mockReset();
  waitNodegroupMock.mockReset();
});

const CLUSTER_REQUIRED_OPERATIONS = [
  "describe-cluster",
  "create-cluster",
  "update-cluster-config",
  "update-cluster-version",
  "delete-cluster",
  "wait-cluster-active",
  "wait-cluster-deleted",
  "list-nodegroups",
  "describe-nodegroup",
  "create-nodegroup",
  "update-nodegroup-config",
  "update-nodegroup-version",
  "delete-nodegroup",
  "wait-nodegroup-active",
  "wait-nodegroup-deleted",
] as const;

const NODEGROUP_REQUIRED_OPERATIONS = [
  "describe-nodegroup",
  "create-nodegroup",
  "update-nodegroup-config",
  "update-nodegroup-version",
  "delete-nodegroup",
  "wait-nodegroup-active",
  "wait-nodegroup-deleted",
] as const;

const INPUT_REQUIRED_OPERATIONS = [
  "create-cluster",
  "update-cluster-config",
  "create-nodegroup",
  "update-nodegroup-config",
] as const;

const MUTATING_OPERATIONS = [
  "create-cluster",
  "update-cluster-config",
  "update-cluster-version",
  "delete-cluster",
  "create-nodegroup",
  "update-nodegroup-config",
  "update-nodegroup-version",
  "delete-nodegroup",
] as const;

const NON_MUTATING_OPERATIONS = [
  "list-clusters",
  "describe-cluster",
  "wait-cluster-active",
  "wait-cluster-deleted",
  "list-nodegroups",
  "describe-nodegroup",
  "wait-nodegroup-active",
  "wait-nodegroup-deleted",
] as const;

const ALL_MOCKS = () => [
  readClustersMock,
  writeClusterMock,
  waitClusterMock,
  readNodegroupsMock,
  writeNodegroupMock,
  waitNodegroupMock,
];

function expectNoStepCalled(): void {
  for (const mock of ALL_MOCKS()) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe("runEksOps — per-operation config guards (fire before any AWS call or step dispatch)", () => {
  test.each(CLUSTER_REQUIRED_OPERATIONS)(
    "throws ERR_EKS_OPS_CONFIG when operation '%s' is missing 'cluster'",
    async (operation) => {
      const deps = buildDeps({
        operation,
        nodegroup: "my-nodegroup",
        input: "payload.json",
        kubernetesVersion: "1.30",
      });

      await expect(runEksOps(deps)).rejects.toMatchObject({
        code: "ERR_EKS_OPS_CONFIG",
      });
      expect(destructiveGateMock).not.toHaveBeenCalled();
      expectNoStepCalled();
    },
  );

  test.each(NODEGROUP_REQUIRED_OPERATIONS)(
    "throws ERR_EKS_OPS_CONFIG when operation '%s' is missing 'nodegroup'",
    async (operation) => {
      const deps = buildDeps({
        operation,
        cluster: "my-cluster",
        input: "payload.json",
        kubernetesVersion: "1.30",
      });

      await expect(runEksOps(deps)).rejects.toMatchObject({
        code: "ERR_EKS_OPS_CONFIG",
      });
      expectNoStepCalled();
    },
  );

  test.each(INPUT_REQUIRED_OPERATIONS)(
    "throws ERR_EKS_OPS_CONFIG when operation '%s' is missing 'input'",
    async (operation) => {
      const deps = buildDeps({
        operation,
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
      });

      await expect(runEksOps(deps)).rejects.toMatchObject({
        code: "ERR_EKS_OPS_CONFIG",
      });
      expect(destructiveGateMock).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
      expectNoStepCalled();
    },
  );

  test("throws ERR_EKS_OPS_CONFIG when 'update-cluster-version' is missing 'kubernetesVersion' (required there)", async () => {
    const deps = buildDeps({
      operation: "update-cluster-version",
      cluster: "my-cluster",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(destructiveGateMock).not.toHaveBeenCalled();
    expectNoStepCalled();
  });

  test("'update-nodegroup-version' does NOT require 'kubernetesVersion' (optional there — releaseVersion alone suffices)", async () => {
    writeNodegroupMock.mockResolvedValue({ id: "u1", status: "InProgress" });
    const deps = buildDeps({
      operation: "update-nodegroup-version",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      releaseVersion: "1.30.0-x",
      yes: true,
    });

    await expect(runEksOps(deps)).resolves.toBeUndefined();
    expect(writeNodegroupMock).toHaveBeenCalledTimes(1);
  });

  test("throws ERR_EKS_OPS_CONFIG ('must be valid JSON') when the input file's content is malformed JSON", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("F10: malformed JSON parse failure does not chain the raw SyntaxError as cause", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    let thrown: unknown;
    try {
      await runEksOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).cause).toBeUndefined();
    expect((thrown as Core.M3LError).message).toMatch(
      /must be valid JSON \(\w+Error\)/,
    );
  });

  test("throws ERR_EKS_OPS_CONFIG ('contains an unsafe key') when the parsed input has a top-level __proto__ key", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: '{"__proto__":{"polluted":true}}',
    });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG ('must decode to a JSON object') when the parsed input is a JSON array", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify([1, 2, 3]) });
    const deps = buildDeps({
      operation: "update-cluster-config",
      cluster: "my-cluster",
      input: "update.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("wraps an unreadable input file's read failure as ERR_EKS_OPS_CONFIG, chaining the raw cause", async () => {
    const cause = new Error("ENOENT: no such file or directory");
    vi.spyOn(fsp, "readFile").mockRejectedValue(cause);
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    let thrown: unknown;
    try {
      await runEksOps(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_EKS_OPS_CONFIG");
    expect((thrown as Core.M3LError).cause).toBe(cause);
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({ operation: "frobnicate" });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expectNoStepCalled();
    expect(destructiveGateMock).not.toHaveBeenCalled();
  });
});

describe("runEksOps — destructive-gate dispatch (mutating operations only)", () => {
  test.each(NON_MUTATING_OPERATIONS)(
    "never runs destructive-gate for '%s'",
    async (operation) => {
      readClustersMock.mockResolvedValue({ clusters: [] });
      readNodegroupsMock.mockResolvedValue({ nodegroups: [] });
      waitClusterMock.mockResolvedValue({ state: "SUCCESS" });
      waitNodegroupMock.mockResolvedValue({ state: "SUCCESS" });
      const deps = buildDeps({
        operation,
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
      });

      await runEksOps(deps);

      expect(destructiveGateMock).not.toHaveBeenCalled();
    },
  );

  test("runs destructive-gate exactly once before dispatching 'delete-cluster', building description from the cluster config value", async () => {
    writeClusterMock.mockResolvedValue({
      name: "my-cluster",
      arn: "arn:aws:eks:us-east-1:123:cluster/my-cluster",
      status: "DELETING",
    });
    const deps = buildDeps({
      operation: "delete-cluster",
      cluster: "my-cluster",
    });

    await runEksOps(deps);

    expect(destructiveGateMock).toHaveBeenCalledTimes(1);
    const call = destructiveGateMock.mock.calls[0] as [
      { readonly description: string; readonly yes: boolean },
    ];
    expect(call[0].description).toContain("my-cluster");
    expect(call[0].yes).toBe(false);
  });

  test("runs destructive-gate exactly once before dispatching 'create-nodegroup'", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        nodeRole: "arn:aws:iam::123:role/node",
        subnets: ["subnet-1"],
      }),
    });
    writeNodegroupMock.mockResolvedValue({
      nodegroupName: "my-nodegroup",
      nodegroupArn: "arn",
      status: "CREATING",
    });
    const deps = buildDeps({
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: "create-ng.json",
    });

    await runEksOps(deps);

    expect(destructiveGateMock).toHaveBeenCalledTimes(1);
  });

  test("forwards 'yes' through to destructive-gate", async () => {
    writeClusterMock.mockResolvedValue({
      name: "my-cluster",
      arn: "arn",
      status: "DELETING",
    });
    const deps = buildDeps({
      operation: "delete-cluster",
      cluster: "my-cluster",
      yes: true,
    });

    await runEksOps(deps);

    const call = destructiveGateMock.mock.calls[0] as [
      { readonly yes: boolean },
    ];
    expect(call[0].yes).toBe(true);
  });

  test("propagates ERR_EKS_OPS_ABORTED from destructive-gate when 'delete-cluster' is declined, never dispatching writeCluster", async () => {
    destructiveGateMock.mockRejectedValue(
      new Core.M3LError("aborted", { code: "ERR_EKS_OPS_ABORTED" }),
    );
    const deps = buildDeps({
      operation: "delete-cluster",
      cluster: "my-cluster",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_ABORTED",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("propagates ERR_EKS_OPS_ABORTED from destructive-gate when 'create-nodegroup' is declined, never dispatching writeNodegroup", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        nodeRole: "arn:aws:iam::123:role/node",
        subnets: ["subnet-1"],
      }),
    });
    destructiveGateMock.mockRejectedValue(
      new Core.M3LError("aborted", { code: "ERR_EKS_OPS_ABORTED" }),
    );
    const deps = buildDeps({
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: "create-ng.json",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_ABORTED",
    });
    expect(writeNodegroupMock).not.toHaveBeenCalled();
  });

  test.each(MUTATING_OPERATIONS)(
    "runs destructive-gate exactly once for mutating operation '%s'",
    async (operation) => {
      writeClusterMock.mockResolvedValue({ id: "u1", status: "InProgress" });
      writeNodegroupMock.mockResolvedValue({ id: "u1", status: "InProgress" });
      const inputPath1 = PATHS.resolveInput("create.json");
      const inputPath2 = PATHS.resolveInput("update.json");
      stubReadFileByPath({
        [inputPath1]: JSON.stringify({
          roleArn: "arn:aws:iam::123:role/eks",
          resourcesVpcConfig: { subnetIds: ["s1", "s2"] },
          nodeRole: "arn:aws:iam::123:role/node",
          subnets: ["s1"],
        }),
        [inputPath2]: JSON.stringify({ deletionProtection: true }),
      });
      const deps = buildDeps({
        operation,
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
        input: operation.includes("create") ? "create.json" : "update.json",
        kubernetesVersion: "1.30",
      });

      await runEksOps(deps);

      expect(destructiveGateMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe("runEksOps — ERR_EKS_OPS_NOT_FOUND (fires before any persist attempt)", () => {
  test("throws ERR_EKS_OPS_NOT_FOUND when describe-cluster resolves undefined, never attempting persist", async () => {
    readClustersMock.mockResolvedValue(undefined);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "describe-cluster",
      cluster: "missing-cluster",
      output: "result.json",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_NOT_FOUND",
    });
    expect(exportSpy).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_NOT_FOUND when describe-nodegroup resolves undefined, never attempting persist", async () => {
    readNodegroupsMock.mockResolvedValue(undefined);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "describe-nodegroup",
      cluster: "my-cluster",
      nodegroup: "missing-nodegroup",
      output: "result.json",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_NOT_FOUND",
    });
    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe("runEksOps — ERR_EKS_OPS_UPDATE_FAILED (persist-then-throw)", () => {
  // Per docs/reference/scripts/eks-ops.md's "Required for" column, `input` is
  // required for `update-cluster-config` (never `kubernetesVersion`, which
  // only applies to `update-cluster-version`) — each operation gets exactly
  // the config field its own per-operation guard needs, not a field shared
  // across both members of the old combined test.each.
  test.each([
    ["update-cluster-config", { input: "update.json" }],
    ["update-cluster-version", { kubernetesVersion: "1.30" }],
  ] as const)(
    "throws ERR_EKS_OPS_UPDATE_FAILED for '%s' when status is 'Failed', AFTER persisting the update (with errors[])",
    async (operation, extraConfig) => {
      const failedUpdate = {
        id: "update-1",
        status: "Failed",
        errors: [{ errorCode: "Ec2SubnetInvalidConfiguration" }],
      };
      writeClusterMock.mockResolvedValue(failedUpdate);
      if (operation === "update-cluster-config") {
        const inputPath = PATHS.resolveInput("update.json");
        stubReadFileByPath({
          [inputPath]: JSON.stringify({ deletionProtection: true }),
        });
      }
      const exportSpy = vi
        .spyOn(Core.M3LJSONFileExporter.prototype, "export")
        .mockResolvedValue(undefined);
      const deps = buildDeps({
        operation,
        cluster: "my-cluster",
        yes: true,
        output: "result.json",
        ...extraConfig,
      });

      await expect(runEksOps(deps)).rejects.toMatchObject({
        code: "ERR_EKS_OPS_UPDATE_FAILED",
      });
      expect(exportSpy).toHaveBeenCalledTimes(1);
      expect(exportSpy).toHaveBeenCalledWith(failedUpdate);
    },
  );

  test.each([
    ["update-nodegroup-config", { input: "update-ng.json" }],
    ["update-nodegroup-version", { kubernetesVersion: "1.30" }],
  ] as const)(
    "throws ERR_EKS_OPS_UPDATE_FAILED for '%s' when status is 'Failed', AFTER persisting the update",
    async (operation, extraConfig) => {
      const failedUpdate = { id: "update-2", status: "Failed" };
      writeNodegroupMock.mockResolvedValue(failedUpdate);
      if (operation === "update-nodegroup-config") {
        const inputPath = PATHS.resolveInput("update-ng.json");
        stubReadFileByPath({
          [inputPath]: JSON.stringify({
            scalingConfig: { minSize: 1, maxSize: 2, desiredSize: 1 },
          }),
        });
      }
      const exportSpy = vi
        .spyOn(Core.M3LJSONFileExporter.prototype, "export")
        .mockResolvedValue(undefined);
      const deps = buildDeps({
        operation,
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
        yes: true,
        output: "result.json",
        ...extraConfig,
      });

      await expect(runEksOps(deps)).rejects.toMatchObject({
        code: "ERR_EKS_OPS_UPDATE_FAILED",
      });
      expect(exportSpy).toHaveBeenCalledTimes(1);
      expect(exportSpy).toHaveBeenCalledWith(failedUpdate);
    },
  );

  test.each(["InProgress", "Successful"] as const)(
    "does NOT throw for update-cluster-version status '%s'",
    async (status) => {
      writeClusterMock.mockResolvedValue({ id: "update-3", status });
      const deps = buildDeps({
        operation: "update-cluster-version",
        cluster: "my-cluster",
        kubernetesVersion: "1.30",
        yes: true,
      });

      await expect(runEksOps(deps)).resolves.toBeUndefined();
    },
  );

  test("still throws ERR_EKS_OPS_UPDATE_FAILED when 'output' is unset (nothing to persist)", async () => {
    writeClusterMock.mockResolvedValue({ id: "update-4", status: "Failed" });
    const deps = buildDeps({
      operation: "update-cluster-version",
      cluster: "my-cluster",
      kubernetesVersion: "1.30",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_UPDATE_FAILED",
    });
  });
});

describe("runEksOps — ERR_EKS_OPS_WAIT_NOT_COMPLETE (persist-then-throw)", () => {
  test.each(["TIMEOUT", "ABORTED"] as const)(
    "throws ERR_EKS_OPS_WAIT_NOT_COMPLETE for wait-cluster-active when state is '%s', AFTER persisting",
    async (state) => {
      const waiterResult = { state, reason: `waiter ${state.toLowerCase()}` };
      waitClusterMock.mockResolvedValue(waiterResult);
      const exportSpy = vi
        .spyOn(Core.M3LJSONFileExporter.prototype, "export")
        .mockResolvedValue(undefined);
      const deps = buildDeps({
        operation: "wait-cluster-active",
        cluster: "my-cluster",
        output: "result.json",
      });

      await expect(runEksOps(deps)).rejects.toMatchObject({
        code: "ERR_EKS_OPS_WAIT_NOT_COMPLETE",
      });
      expect(exportSpy).toHaveBeenCalledTimes(1);
      expect(exportSpy).toHaveBeenCalledWith(waiterResult);
    },
  );

  test.each(["TIMEOUT", "ABORTED"] as const)(
    "throws ERR_EKS_OPS_WAIT_NOT_COMPLETE for wait-nodegroup-deleted when state is '%s', AFTER persisting",
    async (state) => {
      const waiterResult = { state, reason: `waiter ${state.toLowerCase()}` };
      waitNodegroupMock.mockResolvedValue(waiterResult);
      const exportSpy = vi
        .spyOn(Core.M3LJSONFileExporter.prototype, "export")
        .mockResolvedValue(undefined);
      const deps = buildDeps({
        operation: "wait-nodegroup-deleted",
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
        output: "result.json",
      });

      await expect(runEksOps(deps)).rejects.toMatchObject({
        code: "ERR_EKS_OPS_WAIT_NOT_COMPLETE",
      });
      expect(exportSpy).toHaveBeenCalledTimes(1);
      expect(exportSpy).toHaveBeenCalledWith(waiterResult);
    },
  );

  test("does NOT throw when wait-cluster-active resolves state 'SUCCESS'", async () => {
    waitClusterMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-cluster-active",
      cluster: "my-cluster",
    });

    await expect(runEksOps(deps)).resolves.toBeUndefined();
  });

  test("still throws ERR_EKS_OPS_WAIT_NOT_COMPLETE when 'output' is unset (nothing to persist)", async () => {
    waitClusterMock.mockResolvedValue({ state: "TIMEOUT", reason: "x" });
    const deps = buildDeps({
      operation: "wait-cluster-active",
      cluster: "my-cluster",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_WAIT_NOT_COMPLETE",
    });
  });
});

describe("runEksOps — output persistence", () => {
  test.each(NON_MUTATING_OPERATIONS)(
    "persists the '%s' result to 'output' via Core.M3LJSONFileExporter when configured",
    async (operation) => {
      const result = { marker: `result-for-${operation}` };
      readClustersMock.mockResolvedValue(result);
      readNodegroupsMock.mockResolvedValue(result);
      waitClusterMock.mockResolvedValue({ state: "SUCCESS", ...result });
      waitNodegroupMock.mockResolvedValue({ state: "SUCCESS", ...result });
      const exportSpy = vi
        .spyOn(Core.M3LJSONFileExporter.prototype, "export")
        .mockResolvedValue(undefined);
      const deps = buildDeps({
        operation,
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
        output: "result.json",
      });

      await runEksOps(deps);

      expect(exportSpy).toHaveBeenCalledTimes(1);
    },
  );

  test("does not persist anything when 'output' is unset", async () => {
    readClustersMock.mockResolvedValue({ clusters: [] });
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({ operation: "list-clusters" });

    await runEksOps(deps);

    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe("runEksOps — the persisted 'output' file never leaks beyond the safe field set", () => {
  // Security-review finding: the *log* line already goes through
  // buildSafeSummaryFields's {state, reason}/{status, errors} allowlist, but
  // persistOutput writes the raw dispatched result verbatim. Per
  // docs/reference/scripts/eks-ops.md's Security note, the persisted file must
  // never carry more than that same scrubbed shape for a waiter/update result.
  test("wait-cluster-active's persisted output carries only {state, reason}, never an extra leaked field", async () => {
    const leakyWaiterResult = {
      state: "SUCCESS",
      reason: "ok",
      final: {
        cluster: {
          connectorConfig: { activationCode: "SECRET-LEAK-MARKER" },
        },
      },
    };
    waitClusterMock.mockResolvedValue(leakyWaiterResult);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "wait-cluster-active",
      cluster: "my-cluster",
      output: "result.json",
    });

    await expect(runEksOps(deps)).resolves.toBeUndefined();

    expect(exportSpy).toHaveBeenCalledTimes(1);
    const persisted: unknown = exportSpy.mock.calls[0]?.[0];
    expect(JSON.stringify(persisted)).not.toContain("SECRET-LEAK-MARKER");
    expect(persisted).toEqual({ state: "SUCCESS", reason: "ok" });
  });

  test("update-cluster-version's persisted output carries only {status, errors}, never an extra leaked field", async () => {
    const leakyUpdate = {
      id: "u1",
      status: "InProgress",
      extra: { activationCode: "SECRET-LEAK-MARKER-2" },
    };
    writeClusterMock.mockResolvedValue(leakyUpdate);
    const exportSpy = vi
      .spyOn(Core.M3LJSONFileExporter.prototype, "export")
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      operation: "update-cluster-version",
      cluster: "my-cluster",
      kubernetesVersion: "1.30",
      yes: true,
      output: "result.json",
    });

    await expect(runEksOps(deps)).resolves.toBeUndefined();

    expect(exportSpy).toHaveBeenCalledTimes(1);
    const persisted: unknown = exportSpy.mock.calls[0]?.[0];
    expect(JSON.stringify(persisted)).not.toContain("SECRET-LEAK-MARKER-2");
    // M3LEKSUpdate's own declared fields (id/status/type/createdAt/errors,
    // see packages/m3l-common/src/aws/eks/types.ts) are not the leak surface —
    // `id` is an opaque correlation ID, not a secret. Only an undeclared extra
    // field (like `extra` here) must be stripped.
    expect(persisted).toEqual({ id: "u1", status: "InProgress" });
    expect(persisted).not.toHaveProperty("extra");
  });
});

describe("runEksOps — required-input-field validation on create (fires before any AWS call)", () => {
  // Security-review finding: create-cluster/create-nodegroup let a malformed
  // `input` (missing the fields the SDK call actually needs) flow straight
  // through to the AWS operations wrapper today, rather than failing fast
  // with the documented ERR_EKS_OPS_CONFIG contract.
  test("throws ERR_EKS_OPS_CONFIG when create-cluster's input is missing 'roleArn'", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        resourcesVpcConfig: { subnetIds: ["s1"] },
      }),
    });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-cluster's input is missing 'resourcesVpcConfig'", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        roleArn: "arn:aws:iam::123:role/eks",
      }),
    });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-nodegroup's input is missing 'nodeRole'", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({ subnets: ["s1"] }),
    });
    const deps = buildDeps({
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: "create-ng.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeNodegroupMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-nodegroup's input is missing 'subnets'", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        nodeRole: "arn:aws:iam::123:role/node",
      }),
    });
    const deps = buildDeps({
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: "create-ng.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeNodegroupMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-cluster's 'roleArn' is present but an empty string", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        roleArn: "",
        resourcesVpcConfig: { subnetIds: ["s1"] },
      }),
    });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-cluster's 'resourcesVpcConfig' is present but the wrong type (a string)", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        roleArn: "arn:aws:iam::123:role/eks",
        resourcesVpcConfig: "not-an-object",
      }),
    });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-cluster's 'resourcesVpcConfig.subnetIds' is present but the wrong type (not an array)", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        roleArn: "arn:aws:iam::123:role/eks",
        resourcesVpcConfig: { subnetIds: "not-an-array" },
      }),
    });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeClusterMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-nodegroup's 'nodeRole' is present but an empty string", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({ nodeRole: "", subnets: ["s1"] }),
    });
    const deps = buildDeps({
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: "create-ng.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeNodegroupMock).not.toHaveBeenCalled();
  });

  test("throws ERR_EKS_OPS_CONFIG when create-nodegroup's 'subnets' is present but the wrong type (not an array)", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        nodeRole: "arn:aws:iam::123:role/node",
        subnets: "not-an-array",
      }),
    });
    const deps = buildDeps({
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: "create-ng.json",
      yes: true,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
    expect(writeNodegroupMock).not.toHaveBeenCalled();
  });

  test("a complete create-cluster input (roleArn + resourcesVpcConfig) still dispatches normally", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        roleArn: "arn:aws:iam::123:role/eks",
        resourcesVpcConfig: { subnetIds: ["s1", "s2"] },
      }),
    });
    writeClusterMock.mockResolvedValue({
      name: "my-cluster",
      arn: "arn",
      status: "CREATING",
    });
    const deps = buildDeps({
      operation: "create-cluster",
      cluster: "my-cluster",
      input: "create.json",
      yes: true,
    });

    await expect(runEksOps(deps)).resolves.toBeUndefined();
    expect(writeClusterMock).toHaveBeenCalledTimes(1);
  });

  test("a complete create-nodegroup input (nodeRole + subnets) still dispatches normally", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        nodeRole: "arn:aws:iam::123:role/node",
        subnets: ["s1"],
      }),
    });
    writeNodegroupMock.mockResolvedValue({
      nodegroupName: "my-nodegroup",
      nodegroupArn: "arn",
      status: "CREATING",
    });
    const deps = buildDeps({
      operation: "create-nodegroup",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      input: "create-ng.json",
      yes: true,
    });

    await expect(runEksOps(deps)).resolves.toBeUndefined();
    expect(writeNodegroupMock).toHaveBeenCalledTimes(1);
  });
});

describe("runEksOps — M3LConfigAccessor type-mismatch guards", () => {
  // Coverage gap (code-reviewer finding): Core.M3LConfigAccessor's "must be a
  // ${typeName}" throw and its `optionalStringArray`'s "must be a string
  // array" throw were never exercised by any test that builds a
  // Core.M3LConfig directly with a wrong-typed raw value.
  test("throws ERR_EKS_OPS_CONFIG when 'cluster' (STRING) is stored as a number", async () => {
    const deps = buildDeps({
      operation: "describe-cluster",
      cluster: 42,
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
  });

  test("throws ERR_EKS_OPS_CONFIG when 'maxResults' (INT) is stored as a string", async () => {
    const deps = buildDeps({
      operation: "list-clusters",
      maxResults: "10",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
  });

  test("throws ERR_EKS_OPS_CONFIG when 'force' (BOOL) is stored as a string", async () => {
    const deps = buildDeps({
      operation: "update-cluster-version",
      cluster: "my-cluster",
      kubernetesVersion: "1.30",
      force: "yes-please",
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
  });

  test("throws ERR_EKS_OPS_CONFIG when 'include' (STRING_ARRAY) is stored as a non-string-array value", async () => {
    const deps = buildDeps({
      operation: "list-clusters",
      include: [1, 2, 3],
    });

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_CONFIG",
    });
  });
});

describe("runEksOps — the run summary log never leaks a raw waiter/update result verbatim", () => {
  test("wait-cluster-active's log entries never surface a field beyond the safe M3LEKSWaiterResult shape", async () => {
    const leakyWaiterResult = {
      state: "TIMEOUT",
      reason:
        "waiter timed out before cluster name=my-cluster reached the expected state",
      // Simulates a raw SDK/waiter error object accidentally attached
      // downstream — run-eks-ops must never read/log this field.
      message: "connectorConfig.activationCode=LEAKED-SECRET-ACTIVATION-CODE",
    };
    waitClusterMock.mockResolvedValue(leakyWaiterResult);
    const logger = new Core.M3LLogger([]);
    const stepSpy = vi.spyOn(logger, "step");
    const deps = buildDeps(
      { operation: "wait-cluster-active", cluster: "my-cluster" },
      { logger },
    );

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_WAIT_NOT_COMPLETE",
    });

    const loggedText = JSON.stringify(stepSpy.mock.calls);
    expect(loggedText).not.toContain("LEAKED-SECRET-ACTIVATION-CODE");
    expect(loggedText).not.toContain("activationCode");
  });

  test("update-cluster-version's log entries never surface a raw attached SDK response field", async () => {
    const leakyUpdate = {
      id: "update-1",
      status: "Failed",
      errors: [{ errorCode: "X", errorMessage: "safe, scrubbed message" }],
      // Simulates a raw SDK Update response accidentally attached
      // downstream — run-eks-ops must never JSON.stringify this verbatim.
      rawSdkResponse: {
        connectorConfig: { activationCode: "LEAKED-SECRET-CODE-2" },
      },
    };
    writeClusterMock.mockResolvedValue(leakyUpdate);
    const logger = new Core.M3LLogger([]);
    const stepSpy = vi.spyOn(logger, "step");
    const deps = buildDeps(
      {
        operation: "update-cluster-version",
        cluster: "my-cluster",
        kubernetesVersion: "1.30",
        yes: true,
      },
      { logger },
    );

    await expect(runEksOps(deps)).rejects.toMatchObject({
      code: "ERR_EKS_OPS_UPDATE_FAILED",
    });

    const loggedText = JSON.stringify(stepSpy.mock.calls);
    expect(loggedText).not.toContain("LEAKED-SECRET-CODE-2");
    expect(loggedText).not.toContain("rawSdkResponse");
  });
});

describe("runEksOps — exhaustive operation-narrowing chain (all 16 operations reach a step)", () => {
  test("'list-clusters' reaches readClusters", async () => {
    readClustersMock.mockResolvedValue({ clusters: [] });
    await expect(
      runEksOps(buildDeps({ operation: "list-clusters" })),
    ).resolves.toBeUndefined();
    expect(readClustersMock).toHaveBeenCalledTimes(1);
  });

  test("'describe-cluster' reaches readClusters", async () => {
    readClustersMock.mockResolvedValue({
      name: "my-cluster",
      arn: "arn",
      status: "ACTIVE",
    });
    await expect(
      runEksOps(
        buildDeps({ operation: "describe-cluster", cluster: "my-cluster" }),
      ),
    ).resolves.toBeUndefined();
    expect(readClustersMock).toHaveBeenCalledTimes(1);
  });

  test("'create-cluster' reaches writeCluster", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        roleArn: "arn:aws:iam::123:role/eks",
        resourcesVpcConfig: { subnetIds: ["s1", "s2"] },
      }),
    });
    writeClusterMock.mockResolvedValue({
      name: "my-cluster",
      arn: "arn",
      status: "CREATING",
    });
    await expect(
      runEksOps(
        buildDeps({
          operation: "create-cluster",
          cluster: "my-cluster",
          input: "create.json",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeClusterMock).toHaveBeenCalledTimes(1);
  });

  test("'update-cluster-config' reaches writeCluster", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({ deletionProtection: true }),
    });
    writeClusterMock.mockResolvedValue({ id: "u1", status: "InProgress" });
    await expect(
      runEksOps(
        buildDeps({
          operation: "update-cluster-config",
          cluster: "my-cluster",
          input: "update.json",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeClusterMock).toHaveBeenCalledTimes(1);
  });

  test("'update-cluster-version' reaches writeCluster", async () => {
    writeClusterMock.mockResolvedValue({ id: "u2", status: "InProgress" });
    await expect(
      runEksOps(
        buildDeps({
          operation: "update-cluster-version",
          cluster: "my-cluster",
          kubernetesVersion: "1.30",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeClusterMock).toHaveBeenCalledTimes(1);
  });

  test("'delete-cluster' reaches writeCluster", async () => {
    writeClusterMock.mockResolvedValue({
      name: "my-cluster",
      arn: "arn",
      status: "DELETING",
    });
    await expect(
      runEksOps(
        buildDeps({
          operation: "delete-cluster",
          cluster: "my-cluster",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeClusterMock).toHaveBeenCalledTimes(1);
  });

  test("'wait-cluster-active' reaches waitCluster", async () => {
    waitClusterMock.mockResolvedValue({ state: "SUCCESS" });
    await expect(
      runEksOps(
        buildDeps({ operation: "wait-cluster-active", cluster: "my-cluster" }),
      ),
    ).resolves.toBeUndefined();
    expect(waitClusterMock).toHaveBeenCalledTimes(1);
  });

  test("'wait-cluster-deleted' reaches waitCluster", async () => {
    waitClusterMock.mockResolvedValue({ state: "SUCCESS" });
    await expect(
      runEksOps(
        buildDeps({
          operation: "wait-cluster-deleted",
          cluster: "my-cluster",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(waitClusterMock).toHaveBeenCalledTimes(1);
  });

  test("'list-nodegroups' reaches readNodegroups", async () => {
    readNodegroupsMock.mockResolvedValue({ nodegroups: [] });
    await expect(
      runEksOps(
        buildDeps({ operation: "list-nodegroups", cluster: "my-cluster" }),
      ),
    ).resolves.toBeUndefined();
    expect(readNodegroupsMock).toHaveBeenCalledTimes(1);
  });

  test("'describe-nodegroup' reaches readNodegroups", async () => {
    readNodegroupsMock.mockResolvedValue({
      nodegroupName: "my-nodegroup",
      nodegroupArn: "arn",
      status: "ACTIVE",
    });
    await expect(
      runEksOps(
        buildDeps({
          operation: "describe-nodegroup",
          cluster: "my-cluster",
          nodegroup: "my-nodegroup",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(readNodegroupsMock).toHaveBeenCalledTimes(1);
  });

  test("'create-nodegroup' reaches writeNodegroup", async () => {
    const inputPath = PATHS.resolveInput("create-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        nodeRole: "arn:aws:iam::123:role/node",
        subnets: ["s1"],
      }),
    });
    writeNodegroupMock.mockResolvedValue({
      nodegroupName: "my-nodegroup",
      nodegroupArn: "arn",
      status: "CREATING",
    });
    await expect(
      runEksOps(
        buildDeps({
          operation: "create-nodegroup",
          cluster: "my-cluster",
          nodegroup: "my-nodegroup",
          input: "create-ng.json",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeNodegroupMock).toHaveBeenCalledTimes(1);
  });

  test("'update-nodegroup-config' reaches writeNodegroup", async () => {
    const inputPath = PATHS.resolveInput("update-ng.json");
    stubReadFileByPath({
      [inputPath]: JSON.stringify({
        scalingConfig: { minSize: 1, maxSize: 2, desiredSize: 1 },
      }),
    });
    writeNodegroupMock.mockResolvedValue({ id: "u3", status: "InProgress" });
    await expect(
      runEksOps(
        buildDeps({
          operation: "update-nodegroup-config",
          cluster: "my-cluster",
          nodegroup: "my-nodegroup",
          input: "update-ng.json",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeNodegroupMock).toHaveBeenCalledTimes(1);
  });

  test("'update-nodegroup-version' reaches writeNodegroup", async () => {
    writeNodegroupMock.mockResolvedValue({ id: "u4", status: "InProgress" });
    await expect(
      runEksOps(
        buildDeps({
          operation: "update-nodegroup-version",
          cluster: "my-cluster",
          nodegroup: "my-nodegroup",
          kubernetesVersion: "1.30",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeNodegroupMock).toHaveBeenCalledTimes(1);
  });

  test("'delete-nodegroup' reaches writeNodegroup", async () => {
    writeNodegroupMock.mockResolvedValue({
      nodegroupName: "my-nodegroup",
      nodegroupArn: "arn",
      status: "DELETING",
    });
    await expect(
      runEksOps(
        buildDeps({
          operation: "delete-nodegroup",
          cluster: "my-cluster",
          nodegroup: "my-nodegroup",
          yes: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(writeNodegroupMock).toHaveBeenCalledTimes(1);
  });

  test("'wait-nodegroup-active' reaches waitNodegroup", async () => {
    waitNodegroupMock.mockResolvedValue({ state: "SUCCESS" });
    await expect(
      runEksOps(
        buildDeps({
          operation: "wait-nodegroup-active",
          cluster: "my-cluster",
          nodegroup: "my-nodegroup",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(waitNodegroupMock).toHaveBeenCalledTimes(1);
  });

  test("'wait-nodegroup-deleted' reaches waitNodegroup", async () => {
    waitNodegroupMock.mockResolvedValue({ state: "SUCCESS" });
    await expect(
      runEksOps(
        buildDeps({
          operation: "wait-nodegroup-deleted",
          cluster: "my-cluster",
          nodegroup: "my-nodegroup",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(waitNodegroupMock).toHaveBeenCalledTimes(1);
  });
});

describe("runEksOps — dispatch argument shapes (one representative per family)", () => {
  test("'list-clusters' dispatches with nextToken/maxResults/include", async () => {
    readClustersMock.mockResolvedValue({ clusters: [] });
    const deps = buildDeps({
      operation: "list-clusters",
      maxResults: 10,
      nextToken: "tok",
      include: "all,connector",
    });

    await runEksOps(deps);

    expect(readClustersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "list-clusters",
        maxResults: 10,
        nextToken: "tok",
        operations: deps.operations,
      }),
    );
  });

  test("'wait-nodegroup-active' dispatches with cluster/nodegroup/maxWaitTime", async () => {
    waitNodegroupMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-nodegroup-active",
      cluster: "my-cluster",
      nodegroup: "my-nodegroup",
      maxWaitTime: 300,
    });

    await runEksOps(deps);

    expect(waitNodegroupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: "my-cluster",
        nodegroup: "my-nodegroup",
        maxWaitTime: 300,
      }),
    );
  });
});

describe("type contract", () => {
  test("runEksOps resolves void", () => {
    expectTypeOf(runEksOps).returns.toEqualTypeOf<Promise<void>>();
  });
});
