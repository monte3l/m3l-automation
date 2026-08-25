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
 * boundary, also mocked. The destructive gate itself
 * (`Core.confirmDestructive`) runs for real: `Core.M3LOperationPipeline`
 * invokes it via an internal relative import that a package-level
 * `vi.mock("@m3l-automation/m3l-common", ...)` override of
 * `Core.confirmDestructive` cannot intercept, so the gate is instead
 * exercised end to end and observed at the one seam it always calls
 * through — a per-test `Core.M3LPrompt` instance's `confirm` method, spied
 * via `vi.spyOn` (the same technique
 * `scripts/s3-objects/tests/steps/run-s3-objects.test.ts` uses for its own
 * destructive gate). This is architecture-agnostic: it observes the gate at
 * the prompt boundary `confirmDestructive` has always called through,
 * regardless of how the pipeline that invokes it is wired.
 */

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const readServicesMock = vi.fn();
const writeServiceMock = vi.fn();
const waitServicesMock = vi.fn();
const readClustersMock = vi.fn();

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

/**
 * The default `awsTarget` fixture used by every test that does not care
 * about target-graded escalation: a profile whose lowercased form does not
 * contain "prod", so it is never classified sensitive by the per-script
 * `(target) => target.profile.toLowerCase().includes("prod")` predicate
 * `run-ecs-ops.ts` wires into the pipeline's `destructive.isSensitiveTarget`.
 */
const NON_SENSITIVE_TARGET: Core.M3LDestructiveTarget = {
  profile: "dev-sandbox",
};

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: {
    readonly operations?: ReturnType<typeof createFakeEcsOperations>;
    readonly prompt?: Core.M3LPrompt;
    readonly awsTarget?: Core.M3LDestructiveTarget;
  },
): Parameters<typeof runEcsOps>[0] {
  return {
    config: buildConfig(configValues),
    paths: PATHS,
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    operations: overrides?.operations ?? createFakeEcsOperations(),
    prompt: overrides?.prompt ?? new Core.M3LPrompt(),
    awsTarget: overrides?.awsTarget ?? NON_SENSITIVE_TARGET,
  };
}

/**
 * Builds a `Core.M3LPrompt` with both `confirm` and `text` spied — the two
 * seams `Core.confirmDestructive` calls through for the ungraded and the
 * escalated typed-echo paths respectively. Every target-graded-escalation
 * test below observes the gate at this boundary, exactly as
 * {@link confirmingPrompt} does for the ungraded gate.
 */
function targetGatePrompt(overrides?: {
  readonly confirmed?: boolean;
  readonly textResponse?: string;
}) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi
    .spyOn(prompt, "confirm")
    .mockResolvedValue(overrides?.confirmed ?? true);
  const text = vi
    .spyOn(prompt, "text")
    .mockResolvedValue(overrides?.textResponse ?? "");
  return { prompt, confirm, text };
}

/**
 * Builds a `Core.M3LPrompt` whose `confirm` method is stubbed to resolve
 * `confirmed`, alongside the spy itself. `Core.confirmDestructive` (invoked
 * internally by `Core.M3LOperationPipeline`) always calls `deps.prompt.confirm`
 * directly on the decline/confirm path — this is the seam every gate test in
 * this file observes instead of a `Core`-barrel override.
 */
function confirmingPrompt(confirmed: boolean) {
  const prompt = new Core.M3LPrompt();
  const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(confirmed);
  return { prompt, confirm };
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (fsp.readFile and
  // prompt.confirm above); it does not clear the plain vi.fn() mocks created
  // inside the top-level vi.mock() factories above, so their call history
  // would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(fsp.readFile).mockReset();
  readServicesMock.mockReset();
  writeServiceMock.mockReset();
  waitServicesMock.mockReset();
  readClustersMock.mockReset();
});

describe("runEcsOps — per-operation config guards (fire before any AWS call or step dispatch)", () => {
  test.each(["describe-service", "delete-service", "wait-services-stable"])(
    "throws ERR_ECS_OPS_CONFIG when operation '%s' is missing 'cluster'",
    async (operation) => {
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps(
        { operation, service: "my-svc", services: "a" },
        { prompt },
      );

      await expect(runEcsOps(deps)).rejects.toMatchObject({
        code: "ERR_ECS_OPS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(readServicesMock).not.toHaveBeenCalled();
      expect(writeServiceMock).not.toHaveBeenCalled();
      expect(waitServicesMock).not.toHaveBeenCalled();
      expect(readClustersMock).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_ECS_OPS_CONFIG when operation 'describe-cluster' is missing 'cluster'", async () => {
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps({ operation: "describe-cluster" }, { prompt });

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_CONFIG",
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(readClustersMock).not.toHaveBeenCalled();
  });

  test.each(["describe-service", "delete-service"])(
    "throws ERR_ECS_OPS_CONFIG when operation '%s' is missing 'service'",
    async (operation) => {
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps({ operation, cluster: "my-cluster" }, { prompt });

      await expect(runEcsOps(deps)).rejects.toMatchObject({
        code: "ERR_ECS_OPS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
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
      const { prompt, confirm } = confirmingPrompt(true);
      const deps = buildDeps({ operation }, { prompt });

      await expect(runEcsOps(deps)).rejects.toMatchObject({
        code: "ERR_ECS_OPS_CONFIG",
      });
      expect(confirm).not.toHaveBeenCalled();
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
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation, cluster: "my-cluster", service: "my-svc" },
      { prompt },
    );

    await runEcsOps(deps);

    expect(confirm).not.toHaveBeenCalled();
  });

  test("never runs destructive-gate for 'wait-services-stable'", async () => {
    waitServicesMock.mockResolvedValue({ state: "SUCCESS" });
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "wait-services-stable",
        cluster: "my-cluster",
        services: "svc-a",
      },
      { prompt },
    );

    await runEcsOps(deps);

    expect(confirm).not.toHaveBeenCalled();
  });

  test("runs the destructive gate before dispatching 'delete-service', reaching the prompt with a 'Confirm: ...?' message built from cluster/service config values", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "delete-service", cluster: "my-cluster", service: "my-svc" },
      { prompt },
    );

    await runEcsOps(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/^Confirm: .*\?$/),
    );
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-cluster"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-svc"));
  });

  test("'yes: true' bypasses the interactive prompt entirely and logs the gate's own bypass warning, still dispatching writeService", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete-service",
        cluster: "my-cluster",
        service: "my-svc",
        yes: true,
      },
      { prompt },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    await runEcsOps(deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalled();
    expect(writeServiceMock).toHaveBeenCalled();
  });

  test("propagates ERR_ECS_OPS_ABORTED when the interactive gate is declined, never dispatching writeService", async () => {
    const { prompt } = confirmingPrompt(false);
    const deps = buildDeps(
      { operation: "delete-service", cluster: "my-cluster", service: "my-svc" },
      { prompt },
    );

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_ABORTED",
    });
    expect(writeServiceMock).not.toHaveBeenCalled();
  });

  test("builds the 'create-service' gate description from the parsed input's serviceName/cluster, reaching the prompt", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    const parsedInput = {
      cluster: "my-cluster",
      serviceName: "my-svc",
      taskDefinition: "my-task:1",
    };
    stubReadFileByPath({ [inputPath]: JSON.stringify(parsedInput) });
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "create-service", input: "create.json" },
      { prompt },
    );

    await runEcsOps(deps);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-cluster"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-svc"));
  });

  test("falls back to a generic '(see input file)' phrase when the parsed input has neither serviceName/service nor cluster", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: JSON.stringify({}) });
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "create-service", input: "create.json" },
      { prompt },
    );

    await runEcsOps(deps);

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("(see input file)"),
    );
  });

  test("builds the 'update-service' gate description using the parsed input's 'service' field (serviceName ?? service fallback), reaching the prompt", async () => {
    const inputPath = PATHS.resolveInput("update.json");
    const parsedInput = { cluster: "my-cluster", service: "my-svc" };
    stubReadFileByPath({ [inputPath]: JSON.stringify(parsedInput) });
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "update-service", input: "update.json" },
      { prompt },
    );

    await runEcsOps(deps);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-cluster"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("my-svc"));
  });
});

/**
 * Contract: ADR-0048's target-graded destructive-confirmation gate (Issue
 * #483, A2b), wired into `ecs-ops`'s existing `delete-service` gate via a
 * per-script `awsTarget: Core.M3LDestructiveTarget` dep and an inline
 * `isSensitiveTarget` predicate,
 * `(target) => target.profile.toLowerCase().includes("prod")`. Only
 * `delete-service` is exercised here — `create-service`/`update-service`
 * share the same `destructive` block and are not re-tested per state.
 */
describe("runEcsOps — destructive-gate target-graded escalation (delete-service)", () => {
  test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm, text } = targetGatePrompt({
      textResponse: "prod",
    });
    const deps = buildDeps(
      { operation: "delete-service", cluster: "my-cluster", service: "my-svc" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await runEcsOps(deps);

    expect(text).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(writeServiceMock).toHaveBeenCalled();
  });

  test("throws ERR_ECS_OPS_ABORTED when the typed-echo input doesn't match the profile", async () => {
    const { prompt } = targetGatePrompt({ textResponse: "not-prod" });
    const deps = buildDeps(
      { operation: "delete-service", cluster: "my-cluster", service: "my-svc" },
      { prompt, awsTarget: { profile: "prod" } },
    );

    await expect(runEcsOps(deps)).rejects.toMatchObject({
      code: "ERR_ECS_OPS_ABORTED",
    });
    expect(writeServiceMock).not.toHaveBeenCalled();
  });

  test("bypasses confirmation with a warning when yes and yesSensitive are both true for a sensitive target", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm, text } = targetGatePrompt({
      textResponse: "prod",
    });
    const deps = buildDeps(
      {
        operation: "delete-service",
        cluster: "my-cluster",
        service: "my-svc",
        yes: true,
        yesSensitive: true,
      },
      { prompt, awsTarget: { profile: "prod" } },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    await runEcsOps(deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("prod"));
    expect(writeServiceMock).toHaveBeenCalled();
  });

  test.each([
    ["absent", undefined],
    ["false", false],
  ])(
    "still escalates when yes:true but yesSensitive is %s, for a sensitive target",
    async (_label, yesSensitiveValue) => {
      writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
      const { prompt, confirm, text } = targetGatePrompt({
        textResponse: "prod",
      });
      const configValues: Record<string, unknown> = {
        operation: "delete-service",
        cluster: "my-cluster",
        service: "my-svc",
        yes: true,
      };
      if (yesSensitiveValue !== undefined) {
        configValues["yesSensitive"] = yesSensitiveValue;
      }
      const deps = buildDeps(configValues, {
        prompt,
        awsTarget: { profile: "prod" },
      });

      await runEcsOps(deps);

      expect(text).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      expect(writeServiceMock).toHaveBeenCalled();
    },
  );

  test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
    writeServiceMock.mockResolvedValue(SERVICE_DESCRIPTION);
    const { prompt, confirm, text } = targetGatePrompt({ confirmed: true });
    const deps = buildDeps(
      { operation: "delete-service", cluster: "my-cluster", service: "my-svc" },
      { prompt, awsTarget: { profile: "dev-sandbox" } },
    );

    await runEcsOps(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(writeServiceMock).toHaveBeenCalled();
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
    // create-service is destructive-gated; a real (unstubbed) M3LPrompt
    // would otherwise block on real stdin here — see confirmingPrompt.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      { operation: "create-service", input: "create.json" },
      { prompt },
    );

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
    // delete-service is destructive-gated; see the create-service test above.
    const { prompt } = confirmingPrompt(true);
    const deps = buildDeps(
      {
        operation: "delete-service",
        cluster: "my-cluster",
        service: "my-svc",
        force: true,
      },
      { prompt },
    );

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

describe("runEcsOps — finalize wait-state assertion (isWaiterResult structural check)", () => {
  test("a non-waiter result (describe-cluster's M3LECSClusterSummary, carrying 'status' not 'state') never triggers ERR_ECS_OPS_WAIT_NOT_STABLE, even with a non-SUCCESS-looking status value", async () => {
    readClustersMock.mockResolvedValue({
      clusterArn: "arn:aws:ecs:us-east-1:123:cluster/my-cluster",
      clusterName: "my-cluster",
      status: "INACTIVE",
    });
    const deps = buildDeps({
      operation: "describe-cluster",
      cluster: "my-cluster",
    });

    await expect(runEcsOps(deps)).resolves.toBeUndefined();
  });
});

describe("runEcsOps — completion-log payload", () => {
  test("logs completion with the re-derived cluster/service/services context matching the configured values", async () => {
    waitServicesMock.mockResolvedValue({ state: "SUCCESS" });
    const deps = buildDeps({
      operation: "wait-services-stable",
      cluster: "my-cluster",
      services: "svc-a,svc-b",
      service: "my-svc",
    });
    const stepSpy = vi.spyOn(deps.logger, "step");

    await runEcsOps(deps);

    expect(stepSpy).toHaveBeenCalledWith(
      "ecs-ops run run-1 complete",
      expect.objectContaining({
        operation: "wait-services-stable",
        cluster: "my-cluster",
        service: "my-svc",
        services: "svc-a,svc-b",
      }),
    );
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

  test("F10: malformed JSON parse failure does not chain the raw SyntaxError as cause", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: "{not json" });
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
    expect((thrown as Core.M3LError).cause).toBeUndefined();
    expect((thrown as Core.M3LError).message).toMatch(
      /must be valid JSON \(\w+Error\)/,
    );
  });

  test("throws ERR_ECS_OPS_CONFIG ('contains an unsafe key') when the parsed input has a top-level __proto__ key", async () => {
    const inputPath = PATHS.resolveInput("create.json");
    stubReadFileByPath({ [inputPath]: '{"__proto__":{"polluted":true}}' });
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
