/**
 * Tests for aws/ecs submodule.
 *
 * Contract source: docs/reference/aws/ecs.md.
 *
 * Exports under test (from `../src/aws/ecs/index.js`, following the
 * package's `../src/aws/index.js` barrel):
 *   M3LECSOperations, M3LECSOperationError, and the M3LECS* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-ecs` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/lambda.test.ts`), with a `.send()` spy dispatching by command class
 * plus a standalone `waitUntilServicesStable` waiter-function spy (ECS's
 * stabilization wait is a package-level waiter, not a `Command`).
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LECSOperations`'s
 * methods currently throw `M3LECSOperationError("... not yet implemented")`
 * (see src/aws/ecs/client.ts). `implementing-submodules` turns them GREEN.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();
  const waitUntilServicesStable = vi.fn();

  class ListServicesCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeServicesCommand {
    constructor(readonly input: unknown) {}
  }
  class CreateServiceCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateServiceCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteServiceCommand {
    constructor(readonly input: unknown) {}
  }
  class ListClustersCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeClustersCommand {
    constructor(readonly input: unknown) {}
  }
  class ECSClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    waitUntilServicesStable,
    ECSClient,
    ListServicesCommand,
    DescribeServicesCommand,
    CreateServiceCommand,
    UpdateServiceCommand,
    DeleteServiceCommand,
    ListClustersCommand,
    DescribeClustersCommand,
  };
});

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: h.ECSClient,
  ListServicesCommand: h.ListServicesCommand,
  DescribeServicesCommand: h.DescribeServicesCommand,
  CreateServiceCommand: h.CreateServiceCommand,
  UpdateServiceCommand: h.UpdateServiceCommand,
  DeleteServiceCommand: h.DeleteServiceCommand,
  ListClustersCommand: h.ListClustersCommand,
  DescribeClustersCommand: h.DescribeClustersCommand,
  waitUntilServicesStable: h.waitUntilServicesStable,
}));

import type {
  M3LECSCreateServiceInput,
  M3LECSListClustersResult,
  M3LECSListServicesResult,
  M3LECSUpdateServiceInput,
  M3LECSWaiterResult,
} from "../src/aws/ecs/index.js";
import {
  M3LECSOperationError,
  M3LECSOperations,
} from "../src/aws/ecs/index.js";

import type { ECSClient } from "@aws-sdk/client-ecs";

const CLUSTER = "test-cluster";
const SERVICE = "test-service";
const SERVICE_ARN = `arn:aws:ecs:eu-south-1:123456789012:service/${CLUSTER}/${SERVICE}`;

/** Casts the hoisted fake `ECSClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): ECSClient {
  return new h.ECSClient() as unknown as ECSClient;
}

describe("M3LECSOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
    h.waitUntilServicesStable.mockReset();
  });

  describe("listServices", () => {
    test("resolves with plain serviceArns on a successful ListServices call", async () => {
      h.send.mockResolvedValueOnce({ serviceArns: [SERVICE_ARN] });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listServices({ cluster: CLUSTER });

      expect(result).toEqual<M3LECSListServicesResult>({
        serviceArns: [SERVICE_ARN],
      });
    });

    test("omits nextToken from the resolved result when the SDK response doesn't include one", async () => {
      h.send.mockResolvedValueOnce({ serviceArns: [SERVICE_ARN] });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listServices({ cluster: CLUSTER });

      expect(result).not.toHaveProperty("nextToken");
    });

    test("throws M3LECSOperationError when the underlying ListServices call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("throttled"));

      const operations = new M3LECSOperations(fakeClient());

      await expect(
        operations.listServices({ cluster: CLUSTER }),
      ).rejects.toThrow(M3LECSOperationError);
    });

    test("forwards the caller's nextToken onto the constructed ListServicesCommand", async () => {
      h.send.mockResolvedValueOnce({ serviceArns: [SERVICE_ARN] });

      const operations = new M3LECSOperations(fakeClient());
      await operations.listServices({
        cluster: CLUSTER,
        nextToken: "page-2-token",
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { nextToken?: string } },
      ];
      expect(command.input.nextToken).toBe("page-2-token");
    });

    test("resolves with the SDK response's nextToken when present", async () => {
      h.send.mockResolvedValueOnce({
        serviceArns: [SERVICE_ARN],
        nextToken: "next-page-token",
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listServices({ cluster: CLUSTER });

      expect(result.nextToken).toBe("next-page-token");
    });

    test("resolves with an empty serviceArns array when the SDK response omits it", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listServices({ cluster: CLUSTER });

      expect(result.serviceArns).toEqual([]);
    });
  });

  describe("describeService", () => {
    test("resolves with a plain M3LECSServiceDescription on a successful DescribeServices call", async () => {
      h.send.mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: SERVICE,
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            status: "ACTIVE",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeService(CLUSTER, SERVICE);

      expect(result).toMatchObject({
        serviceName: SERVICE,
        status: "ACTIVE",
        desiredCount: 2,
      });
    });

    test("throws M3LECSOperationError when the underlying DescribeServices call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("not found"));

      const operations = new M3LECSOperations(fakeClient());

      await expect(
        operations.describeService(CLUSTER, SERVICE),
      ).rejects.toThrow(M3LECSOperationError);
    });

    test("resolves a defaulted description (rather than throwing) when DescribeServices returns an empty services array", async () => {
      h.send.mockResolvedValueOnce({ services: [] });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeService(CLUSTER, SERVICE);

      expect(typeof result.serviceArn).toBe("string");
      expect(typeof result.serviceName).toBe("string");
      expect(typeof result.clusterArn).toBe("string");
      expect(typeof result.status).toBe("string");
      expect(typeof result.desiredCount).toBe("number");
      expect(typeof result.runningCount).toBe("number");
      expect(typeof result.pendingCount).toBe("number");
    });

    test("maps the SDK response's Date createdAt to an ISO-8601 string", async () => {
      const createdAt = new Date("2026-07-01T12:00:00.000Z");
      h.send.mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: SERVICE,
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            status: "ACTIVE",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            createdAt,
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeService(CLUSTER, SERVICE);

      expect(result.createdAt).toBe(createdAt.toISOString());
    });

    test("resolves networkConfiguration.assignPublicIp as a boolean when the SDK response's awsvpcConfiguration.assignPublicIp is ENABLED", async () => {
      h.send.mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: SERVICE,
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            status: "ACTIVE",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: ["subnet-1"],
                assignPublicIp: "ENABLED",
              },
            },
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeService(CLUSTER, SERVICE);

      expect(result.networkConfiguration).toEqual({
        subnets: ["subnet-1"],
        assignPublicIp: true,
      });
    });

    test("resolves loadBalancers (targetGroupArn/containerName/containerPort variant), taskDefinition, launchType, and roleArn when the SDK response defines them", async () => {
      h.send.mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: SERVICE,
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            status: "ACTIVE",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            taskDefinition: "my-task:3",
            launchType: "FARGATE",
            roleArn: "arn:aws:iam::123456789012:role/ecsServiceRole",
            loadBalancers: [
              {
                targetGroupArn:
                  "arn:aws:elasticloadbalancing:eu-south-1:123456789012:targetgroup/app/abc123",
                containerName: "app",
                containerPort: 8080,
              },
            ],
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeService(CLUSTER, SERVICE);

      expect(result).toMatchObject({
        taskDefinition: "my-task:3",
        launchType: "FARGATE",
        roleArn: "arn:aws:iam::123456789012:role/ecsServiceRole",
        loadBalancers: [
          {
            targetGroupArn:
              "arn:aws:elasticloadbalancing:eu-south-1:123456789012:targetgroup/app/abc123",
            containerName: "app",
            containerPort: 8080,
          },
        ],
      });
    });

    test("resolves a loadBalancers entry carrying only loadBalancerName when the SDK response omits targetGroupArn/containerName/containerPort", async () => {
      h.send.mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: SERVICE,
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            status: "ACTIVE",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            loadBalancers: [{ loadBalancerName: "classic-lb" }],
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeService(CLUSTER, SERVICE);

      expect(result.loadBalancers).toEqual([
        { loadBalancerName: "classic-lb" },
      ]);
    });

    test("resolves networkConfiguration.securityGroups and defaults subnets to an empty array when the SDK response's awsvpcConfiguration omits subnets", async () => {
      h.send.mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            serviceName: SERVICE,
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            status: "ACTIVE",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            networkConfiguration: {
              awsvpcConfiguration: { securityGroups: ["sg-1", "sg-2"] },
            },
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeService(CLUSTER, SERVICE);

      expect(result.networkConfiguration).toEqual({
        subnets: [],
        securityGroups: ["sg-1", "sg-2"],
      });
    });
  });

  describe("createService", () => {
    const input: M3LECSCreateServiceInput = {
      cluster: CLUSTER,
      serviceName: SERVICE,
      taskDefinition: "my-task:1",
    };

    test("resolves with a plain M3LECSServiceDescription on a successful CreateService call", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 1,
          runningCount: 0,
          pendingCount: 1,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.createService(input);

      expect(result).toMatchObject({ serviceName: SERVICE });
    });

    test("throws M3LECSOperationError when the underlying CreateService call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("invalid parameter"));

      const operations = new M3LECSOperations(fakeClient());

      await expect(operations.createService(input)).rejects.toThrow(
        M3LECSOperationError,
      );
    });

    test.each([
      [true, "ENABLED"],
      [false, "DISABLED"],
    ] as const)(
      "translates networkConfiguration.assignPublicIp=%s into the SDK's %s string under networkConfiguration.awsvpcConfiguration",
      async (assignPublicIp, sdkValue) => {
        h.send.mockResolvedValueOnce({
          service: {
            serviceArn: SERVICE_ARN,
            serviceName: SERVICE,
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            status: "ACTIVE",
            desiredCount: 1,
            runningCount: 0,
            pendingCount: 1,
          },
        });

        const operations = new M3LECSOperations(fakeClient());
        await operations.createService({
          ...input,
          networkConfiguration: { subnets: ["subnet-1"], assignPublicIp },
        });

        const [command] = h.send.mock.calls[0] as [
          {
            input: {
              networkConfiguration?: {
                awsvpcConfiguration?: { assignPublicIp?: string };
              };
            };
          },
        ];
        expect(
          command.input.networkConfiguration?.awsvpcConfiguration
            ?.assignPublicIp,
        ).toBe(sdkValue);
      },
    );

    test("translates input.desiredCount and input.launchType onto the constructed CreateServiceCommand", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 3,
          runningCount: 0,
          pendingCount: 3,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      await operations.createService({
        ...input,
        desiredCount: 3,
        launchType: "FARGATE",
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { desiredCount?: number; launchType?: string } },
      ];
      expect(command.input.desiredCount).toBe(3);
      expect(command.input.launchType).toBe("FARGATE");
    });

    test("translates a loadBalancers entry with targetGroupArn/containerName/containerPort onto the constructed CreateServiceCommand", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 1,
          runningCount: 0,
          pendingCount: 1,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      await operations.createService({
        ...input,
        loadBalancers: [
          {
            targetGroupArn:
              "arn:aws:elasticloadbalancing:eu-south-1:123456789012:targetgroup/app/def456",
            containerName: "app",
            containerPort: 8080,
          },
        ],
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            loadBalancers?: readonly {
              targetGroupArn?: string;
              loadBalancerName?: string;
              containerName?: string;
              containerPort?: number;
            }[];
          };
        },
      ];
      expect(command.input.loadBalancers).toEqual([
        {
          targetGroupArn:
            "arn:aws:elasticloadbalancing:eu-south-1:123456789012:targetgroup/app/def456",
          containerName: "app",
          containerPort: 8080,
        },
      ]);
    });

    test("translates a loadBalancers entry carrying only loadBalancerName onto the constructed CreateServiceCommand", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 1,
          runningCount: 0,
          pendingCount: 1,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      await operations.createService({
        ...input,
        loadBalancers: [{ loadBalancerName: "classic-lb" }],
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            loadBalancers?: readonly {
              targetGroupArn?: string;
              loadBalancerName?: string;
              containerName?: string;
              containerPort?: number;
            }[];
          };
        },
      ];
      expect(command.input.loadBalancers).toEqual([
        { loadBalancerName: "classic-lb" },
      ]);
    });

    test("throws M3LECSOperationError when CreateService response omits service", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LECSOperations(fakeClient());

      await expect(operations.createService(input)).rejects.toThrow(
        M3LECSOperationError,
      );
    });
  });

  describe("updateService", () => {
    const input: M3LECSUpdateServiceInput = {
      cluster: CLUSTER,
      service: SERVICE,
      desiredCount: 3,
    };

    test("resolves with a plain M3LECSServiceDescription on a successful UpdateService call", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 3,
          runningCount: 2,
          pendingCount: 1,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.updateService(input);

      expect(result).toMatchObject({ desiredCount: 3 });
    });

    test("throws M3LECSOperationError when the underlying UpdateService call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("service not active"));

      const operations = new M3LECSOperations(fakeClient());

      await expect(operations.updateService(input)).rejects.toThrow(
        M3LECSOperationError,
      );
    });

    test("translates networkConfiguration.assignPublicIp=true into the SDK's ENABLED string under networkConfiguration.awsvpcConfiguration", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 3,
          runningCount: 2,
          pendingCount: 1,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      await operations.updateService({
        ...input,
        networkConfiguration: { subnets: ["subnet-1"], assignPublicIp: true },
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            networkConfiguration?: {
              awsvpcConfiguration?: { assignPublicIp?: string };
            };
          };
        },
      ];
      expect(
        command.input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp,
      ).toBe("ENABLED");
    });

    test("translates input.taskDefinition and input.forceNewDeployment onto the constructed UpdateServiceCommand", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 3,
          runningCount: 2,
          pendingCount: 1,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      await operations.updateService({
        ...input,
        taskDefinition: "my-task:4",
        forceNewDeployment: true,
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { taskDefinition?: string; forceNewDeployment?: boolean } },
      ];
      expect(command.input.taskDefinition).toBe("my-task:4");
      expect(command.input.forceNewDeployment).toBe(true);
    });

    test("translates networkConfiguration.securityGroups onto the constructed UpdateServiceCommand", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          desiredCount: 3,
          runningCount: 2,
          pendingCount: 1,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      await operations.updateService({
        ...input,
        networkConfiguration: {
          subnets: ["subnet-1"],
          securityGroups: ["sg-1", "sg-2"],
        },
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            networkConfiguration?: {
              awsvpcConfiguration?: { securityGroups?: readonly string[] };
            };
          };
        },
      ];
      expect(
        command.input.networkConfiguration?.awsvpcConfiguration?.securityGroups,
      ).toEqual(["sg-1", "sg-2"]);
    });

    test("throws M3LECSOperationError when UpdateService response omits service", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LECSOperations(fakeClient());

      await expect(operations.updateService(input)).rejects.toThrow(
        M3LECSOperationError,
      );
    });
  });

  describe("deleteService", () => {
    test("resolves with the deleted service's plain M3LECSServiceDescription on a successful DeleteService call", async () => {
      h.send.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: SERVICE,
          clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "DRAINING",
          desiredCount: 0,
          runningCount: 0,
          pendingCount: 0,
        },
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.deleteService(CLUSTER, SERVICE);

      expect(result).toMatchObject({ status: "DRAINING" });
    });

    test("throws M3LECSOperationError when the underlying DeleteService call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("dependency violation"));

      const operations = new M3LECSOperations(fakeClient());

      await expect(
        operations.deleteService(CLUSTER, SERVICE, true),
      ).rejects.toThrow(M3LECSOperationError);
    });

    test("throws M3LECSOperationError when DeleteService response omits service", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LECSOperations(fakeClient());

      await expect(operations.deleteService(CLUSTER, SERVICE)).rejects.toThrow(
        M3LECSOperationError,
      );
    });
  });

  describe("waitUntilServicesStable", () => {
    // The SDK's waitUntilServicesStable waiter THROWS on any non-SUCCESS
    // terminal state (via its internal checkExceptions) rather than
    // resolving with one — only a stable outcome resolves normally. This
    // wrapper's whole job is translating a caught TimeoutError/AbortError
    // back into a resolved M3LECSWaiterResult; every other rejection
    // (including the SDK's unnamed FAILURE terminal state) throws
    // M3LECSOperationError instead (docs/reference/aws/ecs.md).
    test("resolves with state SUCCESS when the waiter resolves normally", async () => {
      h.waitUntilServicesStable.mockResolvedValueOnce({ state: "SUCCESS" });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.waitUntilServicesStable(CLUSTER, [
        SERVICE,
      ]);

      expect(result).toEqual<M3LECSWaiterResult>({ state: "SUCCESS" });
    });

    test("resolves with state TIMEOUT (rather than throwing) when the waiter rejects with a TimeoutError", async () => {
      const timeoutError = new Error("Waiter has timed out");
      timeoutError.name = "TimeoutError";
      h.waitUntilServicesStable.mockRejectedValueOnce(timeoutError);

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.waitUntilServicesStable(
        CLUSTER,
        [SERVICE],
        { maxWaitTime: 5 },
      );

      expect(result).toEqual<M3LECSWaiterResult>({
        state: "TIMEOUT",
        reason: timeoutError.message,
      });
    });

    test("resolves with state ABORTED (rather than throwing) when the waiter rejects with an AbortError", async () => {
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      h.waitUntilServicesStable.mockRejectedValueOnce(abortError);

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.waitUntilServicesStable(CLUSTER, [
        SERVICE,
      ]);

      expect(result).toEqual<M3LECSWaiterResult>({
        state: "ABORTED",
        reason: abortError.message,
      });
    });

    test("throws M3LECSOperationError, chaining the cause, when the waiter rejects with an unclassified error (e.g. the SDK's FAILURE terminal state, or a genuine polling call failure)", async () => {
      const unclassifiedError = new Error("Service stability check failed");
      h.waitUntilServicesStable.mockRejectedValueOnce(unclassifiedError);

      const operations = new M3LECSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.waitUntilServicesStable(CLUSTER, [SERVICE]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LECSOperationError);
      expect((thrown as M3LECSOperationError).cause).toBe(unclassifiedError);
    });

    test("invokes the waiter with maxWaitTime defaulted to 600 when the caller omits options", async () => {
      h.waitUntilServicesStable.mockResolvedValueOnce({ state: "SUCCESS" });

      const operations = new M3LECSOperations(fakeClient());
      await operations.waitUntilServicesStable(CLUSTER, [SERVICE]);

      const [params] = h.waitUntilServicesStable.mock.calls[0] as [
        { maxWaitTime?: number },
        unknown,
      ];
      expect(params.maxWaitTime).toBe(600);
    });

    test("invokes the waiter with the caller's own maxWaitTime when supplied", async () => {
      h.waitUntilServicesStable.mockResolvedValueOnce({ state: "SUCCESS" });

      const operations = new M3LECSOperations(fakeClient());
      await operations.waitUntilServicesStable(CLUSTER, [SERVICE], {
        maxWaitTime: 120,
      });

      const [params] = h.waitUntilServicesStable.mock.calls[0] as [
        { maxWaitTime?: number },
        unknown,
      ];
      expect(params.maxWaitTime).toBe(120);
    });
  });

  describe("listClusters", () => {
    test("resolves with plain clusterArns on a successful ListClusters call", async () => {
      h.send.mockResolvedValueOnce({
        clusterArns: [`arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listClusters();

      expect(result).toEqual<M3LECSListClustersResult>({
        clusterArns: [`arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`],
      });
    });

    test("omits nextToken from the resolved result when the SDK response doesn't include one", async () => {
      h.send.mockResolvedValueOnce({
        clusterArns: [`arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listClusters();

      expect(result).not.toHaveProperty("nextToken");
    });

    test("throws M3LECSOperationError when the underlying ListClusters call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("throttled"));

      const operations = new M3LECSOperations(fakeClient());

      await expect(operations.listClusters()).rejects.toThrow(
        M3LECSOperationError,
      );
    });

    test("forwards the caller's nextToken onto the constructed ListClustersCommand", async () => {
      h.send.mockResolvedValueOnce({
        clusterArns: [`arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`],
      });

      const operations = new M3LECSOperations(fakeClient());
      await operations.listClusters({ nextToken: "page-2-token" });

      const [command] = h.send.mock.calls[0] as [
        { input: { nextToken?: string } },
      ];
      expect(command.input.nextToken).toBe("page-2-token");
    });

    test("resolves with the SDK response's nextToken when present", async () => {
      h.send.mockResolvedValueOnce({
        clusterArns: [`arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`],
        nextToken: "next-page-token",
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listClusters();

      expect(result.nextToken).toBe("next-page-token");
    });

    test("resolves with an empty clusterArns array when the SDK response omits it", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.listClusters();

      expect(result.clusterArns).toEqual([]);
    });
  });

  describe("describeCluster", () => {
    test("resolves with a plain M3LECSClusterSummary on a successful DescribeClusters call", async () => {
      h.send.mockResolvedValueOnce({
        clusters: [
          {
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            clusterName: CLUSTER,
            status: "ACTIVE",
            activeServicesCount: 1,
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(result).toMatchObject({
        clusterName: CLUSTER,
        status: "ACTIVE",
      });
    });

    test("throws M3LECSOperationError when the underlying DescribeClusters call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("cluster not found"));

      const operations = new M3LECSOperations(fakeClient());

      await expect(operations.describeCluster(CLUSTER)).rejects.toThrow(
        M3LECSOperationError,
      );
    });

    test("resolves a defaulted summary (rather than throwing) when DescribeClusters returns an empty clusters array", async () => {
      h.send.mockResolvedValueOnce({ clusters: [] });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(typeof result.clusterArn).toBe("string");
      expect(typeof result.clusterName).toBe("string");
    });

    test("resolves runningTasksCount and pendingTasksCount when the SDK response defines them", async () => {
      h.send.mockResolvedValueOnce({
        clusters: [
          {
            clusterArn: `arn:aws:ecs:eu-south-1:123456789012:cluster/${CLUSTER}`,
            clusterName: CLUSTER,
            status: "ACTIVE",
            runningTasksCount: 4,
            pendingTasksCount: 1,
          },
        ],
      });

      const operations = new M3LECSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(result).toMatchObject({
        runningTasksCount: 4,
        pendingTasksCount: 1,
      });
    });
  });

  test("type: M3LECSWaiterResult.state is the closed union of terminal states", () => {
    expectTypeOf<M3LECSWaiterResult["state"]>().toEqualTypeOf<
      "SUCCESS" | "ABORTED" | "TIMEOUT"
    >();
  });

  test("type: listServices() resolves to M3LECSListServicesResult", () => {
    // Pure type-level assertion — deliberately does NOT invoke
    // operations.listServices() at runtime. The stub currently rejects
    // unconditionally, and an un-awaited rejected promise here would
    // surface as an unhandled rejection (see .claude/rules/tests.md's
    // expectTypeOf runtime-invocation gotcha) even though the type itself
    // is correct.
    expectTypeOf<
      Awaited<ReturnType<M3LECSOperations["listServices"]>>
    >().toEqualTypeOf<M3LECSListServicesResult>();
  });
});
