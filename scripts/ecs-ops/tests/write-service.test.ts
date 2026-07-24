import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { writeService } from "../src/steps/write-service.js";
import { createFakeEcsOperations } from "./support/ecsFakes.js";

/**
 * Contract: docs/reference/scripts/ecs-ops.md `write-service` row. Handles
 * `create-service`/`update-service`/`delete-service`. Receives the
 * already-parsed `input` record from `run-ecs-ops` (never touches the
 * filesystem itself) — `create-service` narrows/validates it into
 * `M3LECSCreateServiceInput` (requires `cluster`, `serviceName`,
 * `taskDefinition`), `update-service` narrows into `M3LECSUpdateServiceInput`
 * (requires `cluster`, `service`), and `delete-service` takes `cluster`/
 * `service`/`force` from config. Never touches `destructive-gate`/`prompt`
 * itself (`run-ecs-ops` gates before dispatching here).
 */

const SERVICE_DESCRIPTION: AWS.M3LECSServiceDescription = {
  serviceArn: "arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc",
  serviceName: "my-svc",
  clusterArn: "arn:aws:ecs:us-east-1:123:cluster/my-cluster",
  status: "ACTIVE",
  desiredCount: 2,
  runningCount: 0,
  pendingCount: 2,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeService — create-service", () => {
  test("calls operations.createService with the parsed input's cluster/serviceName/taskDefinition", async () => {
    const createService = vi.fn().mockResolvedValue(SERVICE_DESCRIPTION);
    const operations = createFakeEcsOperations({ createService });
    const input = {
      cluster: "my-cluster",
      serviceName: "my-svc",
      taskDefinition: "my-task:1",
      desiredCount: 2,
    };

    const returned = await writeService({
      operations,
      operation: "create-service",
      input,
      cluster: undefined,
      service: undefined,
      force: false,
    });

    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: "my-cluster",
        serviceName: "my-svc",
        taskDefinition: "my-task:1",
        desiredCount: 2,
      }),
    );
    expect(returned).toEqual(SERVICE_DESCRIPTION);
  });

  test("throws ERR_ECS_OPS_CONFIG when input is undefined, never calling createService", async () => {
    const createService = vi.fn();
    const operations = createFakeEcsOperations({ createService });

    let thrown: unknown;
    try {
      await writeService({
        operations,
        operation: "create-service",
        input: undefined,
        cluster: undefined,
        service: undefined,
        force: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ECS_OPS_CONFIG");
    expect(createService).not.toHaveBeenCalled();
  });

  test.each(["cluster", "serviceName", "taskDefinition"] as const)(
    "throws ERR_ECS_OPS_CONFIG when the parsed input is missing '%s', never calling createService",
    async (missing) => {
      const createService = vi.fn();
      const operations = createFakeEcsOperations({ createService });
      const input: Record<string, unknown> = {
        cluster: "my-cluster",
        serviceName: "my-svc",
        taskDefinition: "my-task:1",
      };
      delete input[missing];

      await expect(
        writeService({
          operations,
          operation: "create-service",
          input,
          cluster: undefined,
          service: undefined,
          force: false,
        }),
      ).rejects.toMatchObject({ code: "ERR_ECS_OPS_CONFIG" });
      expect(createService).not.toHaveBeenCalled();
    },
  );
});

describe("writeService — update-service", () => {
  test("calls operations.updateService with the parsed input's cluster/service", async () => {
    const updateService = vi.fn().mockResolvedValue(SERVICE_DESCRIPTION);
    const operations = createFakeEcsOperations({ updateService });
    const input = {
      cluster: "my-cluster",
      service: "my-svc",
      desiredCount: 5,
      forceNewDeployment: true,
    };

    const returned = await writeService({
      operations,
      operation: "update-service",
      input,
      cluster: undefined,
      service: undefined,
      force: false,
    });

    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: "my-cluster",
        service: "my-svc",
        desiredCount: 5,
        forceNewDeployment: true,
      }),
    );
    expect(returned).toEqual(SERVICE_DESCRIPTION);
  });

  test("throws ERR_ECS_OPS_CONFIG when input is undefined, never calling updateService", async () => {
    const updateService = vi.fn();
    const operations = createFakeEcsOperations({ updateService });

    await expect(
      writeService({
        operations,
        operation: "update-service",
        input: undefined,
        cluster: undefined,
        service: undefined,
        force: false,
      }),
    ).rejects.toMatchObject({ code: "ERR_ECS_OPS_CONFIG" });
    expect(updateService).not.toHaveBeenCalled();
  });

  test.each(["cluster", "service"] as const)(
    "throws ERR_ECS_OPS_CONFIG when the parsed input is missing '%s', never calling updateService",
    async (missing) => {
      const updateService = vi.fn();
      const operations = createFakeEcsOperations({ updateService });
      const input: Record<string, unknown> = {
        cluster: "my-cluster",
        service: "my-svc",
      };
      delete input[missing];

      await expect(
        writeService({
          operations,
          operation: "update-service",
          input,
          cluster: undefined,
          service: undefined,
          force: false,
        }),
      ).rejects.toMatchObject({ code: "ERR_ECS_OPS_CONFIG" });
      expect(updateService).not.toHaveBeenCalled();
    },
  );
});

describe("writeService — delete-service", () => {
  test("calls operations.deleteService(cluster, service, force) from config values, ignoring input", async () => {
    const deleteService = vi.fn().mockResolvedValue(SERVICE_DESCRIPTION);
    const operations = createFakeEcsOperations({ deleteService });

    const returned = await writeService({
      operations,
      operation: "delete-service",
      input: undefined,
      cluster: "my-cluster",
      service: "my-svc",
      force: true,
    });

    expect(deleteService).toHaveBeenCalledWith("my-cluster", "my-svc", true);
    expect(returned).toEqual(SERVICE_DESCRIPTION);
  });
});

describe("type contract", () => {
  test("writeService resolves M3LECSServiceDescription", () => {
    expectTypeOf(
      writeService,
    ).returns.resolves.toEqualTypeOf<AWS.M3LECSServiceDescription>();
  });
});
