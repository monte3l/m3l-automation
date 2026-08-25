/**
 * Tests for aws/eks submodule.
 *
 * Contract source: docs/reference/aws/eks.md.
 *
 * Exports under test (from `../src/aws/eks/index.js`, following the
 * package's `../src/aws/index.js` barrel):
 *   M3LEKSOperations, M3LEKSOperationError, and the M3LEKS* plain types.
 *
 * Mocking strategy: `@aws-sdk/client-eks` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/ecs.test.ts`), with a `.send()` spy dispatching by command class
 * plus standalone `waitUntilClusterActive`/`waitUntilClusterDeleted`/
 * `waitUntilNodegroupActive`/`waitUntilNodegroupDeleted` waiter-function
 * spies (EKS's lifecycle waits are package-level waiters, not `Command`s).
 * The factory preserves every other real export (`importOriginal`) so
 * `AMITypes`/`CapacityTypes` — data-only enum objects `createNodegroup`'s
 * validation reads at runtime — pass through unmocked; a plain
 * object-literal `vi.mock` would silently resolve them to `undefined` and
 * break that validation before a single assertion runs.
 *
 * Waiter fixtures below are built from the real `@aws-sdk/client-eks@3.1079.0`
 * generated waiter source (`dist-es/waiters/*.js`) and `@smithy/core`'s
 * `checkExceptions`/`runPolling`, read directly for this pass — NOT from
 * `docs/reference/aws/eks.md`'s prose alone, which conflates the cluster and
 * nodegroup FAILURE-status sets. The doc says both `*Deleted` waiters reach
 * FAILURE on `"ACTIVE"`/`"CREATING"`/`"PENDING"` and both `*Active` waiters on
 * `"DELETING"`/`"FAILED"` (`"CREATE_FAILED"`/`"DELETE_FAILED"` for nodegroup);
 * the real generated source shows this symmetry holds for the **cluster**
 * waiters only — `waitForNodegroupActive`'s `checkState` tests only
 * `"CREATE_FAILED"` (no `"DELETE_FAILED"` branch at all), and
 * `waitForNodegroupDeleted`'s tests only `"DELETE_FAILED"` (no
 * `"ACTIVE"`/`"CREATING"`/`"PENDING"` branch at all). Flagged back to the hub;
 * since every waiter test here mocks the *top-level* waiter function's
 * resolved/rejected value directly (never the internal `checkState`), this
 * discrepancy doesn't change any assertion — only the descriptive comment
 * naming which status triggers FAILURE, which is written against the real
 * source below.
 *
 * SCAFFOLD STATUS: these tests are RED by design — `M3LEKSOperations`'s
 * methods currently reject with `M3LEKSOperationError("... not yet
 * implemented")` (see src/aws/eks/client.ts). `implementing-submodules`
 * turns them GREEN. Coverage: all 16 methods (12 operations + 4 waiters).
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as EksSdkModule from "@aws-sdk/client-eks";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();
  const waitUntilClusterActive = vi.fn();
  const waitUntilClusterDeleted = vi.fn();
  const waitUntilNodegroupActive = vi.fn();
  const waitUntilNodegroupDeleted = vi.fn();

  class ListClustersCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeClusterCommand {
    constructor(readonly input: unknown) {}
  }
  class CreateClusterCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateClusterConfigCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateClusterVersionCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteClusterCommand {
    constructor(readonly input: unknown) {}
  }
  class ListNodegroupsCommand {
    constructor(readonly input: unknown) {}
  }
  class DescribeNodegroupCommand {
    constructor(readonly input: unknown) {}
  }
  class CreateNodegroupCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateNodegroupConfigCommand {
    constructor(readonly input: unknown) {}
  }
  class UpdateNodegroupVersionCommand {
    constructor(readonly input: unknown) {}
  }
  class DeleteNodegroupCommand {
    constructor(readonly input: unknown) {}
  }
  class EKSClient {
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
    waitUntilClusterActive,
    waitUntilClusterDeleted,
    waitUntilNodegroupActive,
    waitUntilNodegroupDeleted,
    EKSClient,
    ListClustersCommand,
    DescribeClusterCommand,
    CreateClusterCommand,
    UpdateClusterConfigCommand,
    UpdateClusterVersionCommand,
    DeleteClusterCommand,
    ListNodegroupsCommand,
    DescribeNodegroupCommand,
    CreateNodegroupCommand,
    UpdateNodegroupConfigCommand,
    UpdateNodegroupVersionCommand,
    DeleteNodegroupCommand,
  };
});

vi.mock("@aws-sdk/client-eks", async (importOriginal) => {
  const actual = await importOriginal<typeof EksSdkModule>();
  return {
    ...actual,
    EKSClient: h.EKSClient,
    ListClustersCommand: h.ListClustersCommand,
    DescribeClusterCommand: h.DescribeClusterCommand,
    CreateClusterCommand: h.CreateClusterCommand,
    UpdateClusterConfigCommand: h.UpdateClusterConfigCommand,
    UpdateClusterVersionCommand: h.UpdateClusterVersionCommand,
    DeleteClusterCommand: h.DeleteClusterCommand,
    ListNodegroupsCommand: h.ListNodegroupsCommand,
    DescribeNodegroupCommand: h.DescribeNodegroupCommand,
    CreateNodegroupCommand: h.CreateNodegroupCommand,
    UpdateNodegroupConfigCommand: h.UpdateNodegroupConfigCommand,
    UpdateNodegroupVersionCommand: h.UpdateNodegroupVersionCommand,
    DeleteNodegroupCommand: h.DeleteNodegroupCommand,
    waitUntilClusterActive: h.waitUntilClusterActive,
    waitUntilClusterDeleted: h.waitUntilClusterDeleted,
    waitUntilNodegroupActive: h.waitUntilNodegroupActive,
    waitUntilNodegroupDeleted: h.waitUntilNodegroupDeleted,
  };
});

import type { EKSClient } from "@aws-sdk/client-eks";

import type {
  M3LEKSClusterSummary,
  M3LEKSCreateClusterInput,
  M3LEKSCreateNodegroupInput,
  M3LEKSListClustersResult,
  M3LEKSListNodegroupsResult,
  M3LEKSNodegroupScalingConfig,
  M3LEKSNodegroupSummary,
  M3LEKSUpdate,
  M3LEKSUpdateClusterConfigInput,
  M3LEKSUpdateClusterVersionInput,
  M3LEKSUpdateNodegroupConfigInput,
  M3LEKSUpdateNodegroupVersionInput,
  M3LEKSVpcConfig,
  M3LEKSWaiterOptions,
  M3LEKSWaiterResult,
} from "../src/aws/eks/index.js";
import {
  M3LEKSOperationError,
  M3LEKSOperations,
} from "../src/aws/eks/index.js";

import { M3LOperationAbortedError } from "../src/core/errors/index.js";

const CLUSTER = "test-cluster";
const NODEGROUP = "test-nodegroup";
const SECRET = "SECRET-ACTIVATION-CODE-DO-NOT-LEAK";

/** Casts the hoisted fake `EKSClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): EKSClient {
  return new h.EKSClient() as unknown as EKSClient;
}

/** Builds an `Error` with the given `.name`, matching the SDK's named-exception classification shape. */
function namedError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe("M3LEKSOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
    h.waitUntilClusterActive.mockReset();
    h.waitUntilClusterDeleted.mockReset();
    h.waitUntilNodegroupActive.mockReset();
    h.waitUntilNodegroupDeleted.mockReset();
  });

  describe("listClusters", () => {
    test("resolves with plain cluster names on a successful ListClusters call", async () => {
      h.send.mockResolvedValueOnce({ clusters: [CLUSTER] });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.listClusters();

      expect(result).toEqual<M3LEKSListClustersResult>({
        clusters: [CLUSTER],
      });
    });

    test("throws M3LEKSOperationError when the underlying ListClusters call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("throttled"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(operations.listClusters()).rejects.toThrow(
        M3LEKSOperationError,
      );
    });

    test("forwards nextToken/maxResults/include onto the constructed ListClustersCommand", async () => {
      h.send.mockResolvedValueOnce({ clusters: [] });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.listClusters({
        nextToken: "caller-token",
        maxResults: 10,
        include: ["all"],
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            nextToken?: string;
            maxResults?: number;
            include?: readonly string[];
          };
        },
      ];
      expect(command.input.nextToken).toBe("caller-token");
      expect(command.input.maxResults).toBe(10);
      expect(command.input.include).toEqual(["all"]);
    });

    test("resolves with nextToken when the SDK response includes one, and omits it entirely otherwise", async () => {
      h.send.mockResolvedValueOnce({
        clusters: [CLUSTER],
        nextToken: "response-token",
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.listClusters();

      expect(result).toEqual<M3LEKSListClustersResult>({
        clusters: [CLUSTER],
        nextToken: "response-token",
      });
    });
  });

  describe("describeCluster", () => {
    test("resolves undefined when the SDK reports ResourceNotFoundException", async () => {
      const notFound = new Error("No cluster found");
      notFound.name = "ResourceNotFoundException";
      h.send.mockRejectedValueOnce(notFound);

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.describeCluster("missing-cluster"),
      ).resolves.toBeUndefined();
    });

    test("throws M3LEKSOperationError for any other DescribeCluster failure", async () => {
      h.send.mockRejectedValueOnce(new Error("internal error"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(operations.describeCluster(CLUSTER)).rejects.toThrow(
        M3LEKSOperationError,
      );
    });

    test.each([
      ["ClientException"],
      ["ServerException"],
      ["ServiceUnavailableException"],
    ])(
      "throws M3LEKSOperationError on %s — never classified as not-found",
      async (exceptionName: string) => {
        h.send.mockRejectedValueOnce(namedError(exceptionName));

        const operations = new M3LEKSOperations(fakeClient());

        await expect(
          operations.describeCluster(CLUSTER),
        ).rejects.toBeInstanceOf(M3LEKSOperationError);
      },
    );

    test("never maps connectorConfig onto the resolved M3LEKSClusterSummary, even when the SDK response carries it (registration-secret regression lock)", async () => {
      h.send.mockResolvedValueOnce({
        cluster: {
          name: CLUSTER,
          arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          version: "1.31",
          resourcesVpcConfig: {
            subnetIds: ["subnet-1", "subnet-2"],
            vpcId: "vpc-1",
          },
          // A live DescribeCluster response includes connectorConfig with
          // one-time registration secrets — this fixture proves the mapper
          // drops it, not just that the type doesn't declare it (a future
          // `{ ...cluster }` mapper regression would type-check but fail
          // this toEqual, since connectorConfig is absent below).
          connectorConfig: {
            activationCode: SECRET,
            activationId: "activation-id-secret",
            provider: "OTHER",
            roleArn: "arn:aws:iam::123456789012:role/connector-role",
          },
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(result).toEqual<M3LEKSClusterSummary>({
        name: CLUSTER,
        arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
        status: "ACTIVE",
        version: "1.31",
        resourcesVpcConfig: {
          subnetIds: ["subnet-1", "subnet-2"],
          vpcId: "vpc-1",
        },
      });
      expect(result).not.toHaveProperty("connectorConfig");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    test("defaults resourcesVpcConfig.subnetIds to [] when the SDK's VpcConfigResponse omits subnetIds", async () => {
      h.send.mockResolvedValueOnce({
        cluster: {
          name: CLUSTER,
          arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          resourcesVpcConfig: { vpcId: "vpc-1" },
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(result?.resourcesVpcConfig?.subnetIds).toEqual([]);
    });

    test("throws M3LEKSOperationError when the rejection is not an Error instance (never misclassified as ResourceNotFoundException)", async () => {
      h.send.mockRejectedValueOnce("a raw string rejection");

      const operations = new M3LEKSOperations(fakeClient());

      await expect(operations.describeCluster(CLUSTER)).rejects.toBeInstanceOf(
        M3LEKSOperationError,
      );
    });

    test("resolves a fully-populated M3LEKSClusterSummary when the SDK response defines every optional field", async () => {
      h.send.mockResolvedValueOnce({
        cluster: {
          name: CLUSTER,
          arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          version: "1.31",
          platformVersion: "eks.5",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          endpoint: "https://example.eks.amazonaws.com",
          roleArn: "arn:aws:iam::123456789012:role/eks-role",
          resourcesVpcConfig: {
            subnetIds: ["subnet-1", "subnet-2"],
            securityGroupIds: ["sg-1"],
            clusterSecurityGroupId: "sg-cluster",
            vpcId: "vpc-1",
            endpointPublicAccess: true,
            endpointPrivateAccess: true,
          },
          certificateAuthority: { data: "base64-ca-data" },
          tags: { env: "test" },
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(result).toEqual<M3LEKSClusterSummary>({
        name: CLUSTER,
        arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
        status: "ACTIVE",
        version: "1.31",
        platformVersion: "eks.5",
        createdAt: "2026-01-01T00:00:00.000Z",
        endpoint: "https://example.eks.amazonaws.com",
        roleArn: "arn:aws:iam::123456789012:role/eks-role",
        resourcesVpcConfig: {
          subnetIds: ["subnet-1", "subnet-2"],
          securityGroupIds: ["sg-1"],
          clusterSecurityGroupId: "sg-cluster",
          vpcId: "vpc-1",
          endpointPublicAccess: true,
          endpointPrivateAccess: true,
        },
        certificateAuthorityData: "base64-ca-data",
        tags: { env: "test" },
      });
    });

    test("resolves a minimal M3LEKSClusterSummary when the SDK response omits every optional field entirely", async () => {
      h.send.mockResolvedValueOnce({
        cluster: {
          name: CLUSTER,
          arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(result).toEqual<M3LEKSClusterSummary>({
        name: CLUSTER,
        arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
        status: "ACTIVE",
      });
      expect(Object.keys(result ?? {})).toEqual(["name", "arn", "status"]);
    });

    test("resolves resourcesVpcConfig as { subnetIds: [] } only when the SDK's VpcConfigResponse is present but defines no other optional field", async () => {
      h.send.mockResolvedValueOnce({
        cluster: {
          name: CLUSTER,
          arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "ACTIVE",
          resourcesVpcConfig: {},
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeCluster(CLUSTER);

      expect(result?.resourcesVpcConfig).toEqual<M3LEKSVpcConfig>({
        subnetIds: [],
      });
    });
  });

  describe("createCluster", () => {
    const input: M3LEKSCreateClusterInput = {
      name: CLUSTER,
      roleArn: "arn:aws:iam::123456789012:role/eks-role",
      resourcesVpcConfig: { subnetIds: ["subnet-1", "subnet-2"] },
    };

    test("resolves with the created cluster's summary", async () => {
      h.send.mockResolvedValueOnce({
        cluster: {
          name: CLUSTER,
          arn: `arn:aws:eks:eu-south-1:123456789012:cluster/${CLUSTER}`,
          status: "CREATING",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.createCluster(input);

      expect(result.name).toBe(CLUSTER);
    });

    test("throws M3LEKSOperationError when the underlying CreateCluster call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("already exists"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(operations.createCluster(input)).rejects.toThrow(
        M3LEKSOperationError,
      );
    });

    test("forwards name/roleArn/resourcesVpcConfig/version/tags onto the constructed CreateClusterCommand", async () => {
      h.send.mockResolvedValueOnce({
        cluster: { name: CLUSTER, arn: "arn", status: "CREATING" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.createCluster({
        ...input,
        version: "1.31",
        tags: { env: "test" },
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            name?: string;
            roleArn?: string;
            version?: string;
            tags?: Record<string, string>;
          };
        },
      ];
      expect(command.input.name).toBe(CLUSTER);
      expect(command.input.roleArn).toBe(input.roleArn);
      expect(command.input.version).toBe("1.31");
      expect(command.input.tags).toEqual({ env: "test" });
    });

    test("omits version/tags from the constructed CreateClusterCommand when the caller doesn't supply them", async () => {
      h.send.mockResolvedValueOnce({
        cluster: { name: CLUSTER, arn: "arn", status: "CREATING" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.createCluster(input);

      const [command] = h.send.mock.calls[0] as [
        { input: { version?: string; tags?: Record<string, string> } },
      ];
      expect(command.input).not.toHaveProperty("version");
      expect(command.input).not.toHaveProperty("tags");
    });

    test("forwards a fully-populated resourcesVpcConfig (subnetIds/securityGroupIds/endpointPublicAccess/endpointPrivateAccess) onto the constructed CreateClusterCommand", async () => {
      h.send.mockResolvedValueOnce({
        cluster: { name: CLUSTER, arn: "arn", status: "CREATING" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.createCluster({
        ...input,
        resourcesVpcConfig: {
          subnetIds: ["subnet-1", "subnet-2"],
          securityGroupIds: ["sg-1"],
          endpointPublicAccess: true,
          endpointPrivateAccess: true,
        },
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            resourcesVpcConfig?: {
              subnetIds?: string[];
              securityGroupIds?: string[];
              endpointPublicAccess?: boolean;
              endpointPrivateAccess?: boolean;
            };
          };
        },
      ];
      expect(command.input.resourcesVpcConfig).toEqual({
        subnetIds: ["subnet-1", "subnet-2"],
        securityGroupIds: ["sg-1"],
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
      });
    });

    test("builds an empty resourcesVpcConfig object when the caller's input supplies none of its optional fields", async () => {
      h.send.mockResolvedValueOnce({
        cluster: { name: CLUSTER, arn: "arn", status: "CREATING" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.createCluster({ ...input, resourcesVpcConfig: {} });

      const [command] = h.send.mock.calls[0] as [
        { input: { resourcesVpcConfig?: Record<string, unknown> } },
      ];
      expect(command.input.resourcesVpcConfig).toEqual({});
    });
  });

  describe("updateClusterConfig", () => {
    const input: M3LEKSUpdateClusterConfigInput = {
      name: CLUSTER,
      resourcesVpcConfig: { endpointPublicAccess: false },
    };

    test("resolves an M3LEKSUpdate tracking object — not the mutated cluster resource", async () => {
      h.send.mockResolvedValueOnce({
        update: {
          id: "update-1",
          status: "InProgress",
          type: "EndpointAccessUpdate",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.updateClusterConfig(input);

      expect(result).toEqual<M3LEKSUpdate>({
        id: "update-1",
        status: "InProgress",
        type: "EndpointAccessUpdate",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(result).not.toHaveProperty("name");
      expect(result).not.toHaveProperty("arn");
    });

    test("throws M3LEKSOperationError when the underlying UpdateClusterConfig call fails", async () => {
      const cause = new Error("conflicting update in progress");
      h.send.mockRejectedValueOnce(cause);

      const operations = new M3LEKSOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.updateClusterConfig(input);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LEKSOperationError);
      expect((thrown as M3LEKSOperationError).cause).toBe(cause);
    });

    test("forwards deletionProtection and omits resourcesVpcConfig from the constructed UpdateClusterConfigCommand when the caller supplies only deletionProtection", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-1", status: "InProgress" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.updateClusterConfig({
        name: CLUSTER,
        deletionProtection: true,
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            resourcesVpcConfig?: unknown;
            deletionProtection?: boolean;
          };
        },
      ];
      expect(command.input.deletionProtection).toBe(true);
      expect(command.input).not.toHaveProperty("resourcesVpcConfig");
    });

    test("omits both resourcesVpcConfig and deletionProtection from the constructed UpdateClusterConfigCommand when the caller supplies neither", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-1", status: "InProgress" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.updateClusterConfig({ name: CLUSTER });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            resourcesVpcConfig?: unknown;
            deletionProtection?: boolean;
          };
        },
      ];
      expect(command.input).not.toHaveProperty("resourcesVpcConfig");
      expect(command.input).not.toHaveProperty("deletionProtection");
    });
  });

  describe("updateClusterVersion", () => {
    const input: M3LEKSUpdateClusterVersionInput = {
      name: CLUSTER,
      version: "1.32",
    };

    test("resolves an M3LEKSUpdate tracking object — not the mutated cluster resource", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-2", status: "InProgress", type: "VersionUpdate" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.updateClusterVersion(input);

      expect(result).toEqual<M3LEKSUpdate>({
        id: "update-2",
        status: "InProgress",
        type: "VersionUpdate",
      });
    });

    test("forwards name/version/force onto the constructed UpdateClusterVersionCommand", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-2", status: "InProgress" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.updateClusterVersion({ ...input, force: true });

      const [command] = h.send.mock.calls[0] as [
        { input: { name?: string; version?: string; force?: boolean } },
      ];
      expect(command.input.name).toBe(CLUSTER);
      expect(command.input.version).toBe("1.32");
      expect(command.input.force).toBe(true);
    });

    test("throws M3LEKSOperationError when the underlying UpdateClusterVersion call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("version not upgradeable"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(operations.updateClusterVersion(input)).rejects.toThrow(
        M3LEKSOperationError,
      );
    });

    test("maps a Failed update's errors array, each entry's errorCode/errorMessage/resourceIds included only when the SDK ErrorDetail defines them", async () => {
      h.send.mockResolvedValueOnce({
        update: {
          id: "update-2",
          status: "Failed",
          errors: [
            {
              errorCode: "InsufficientFreeAddresses",
              errorMessage: "not enough IPs",
              resourceIds: ["subnet-1"],
            },
            {},
          ],
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.updateClusterVersion(input);

      expect(result).toEqual<M3LEKSUpdate>({
        id: "update-2",
        status: "Failed",
        errors: [
          {
            errorCode: "InsufficientFreeAddresses",
            errorMessage: "not enough IPs",
            resourceIds: ["subnet-1"],
          },
          {},
        ],
      });
    });
  });

  describe("deleteCluster", () => {
    test("resolves with the deleted cluster's summary snapshot", async () => {
      h.send.mockResolvedValueOnce({
        cluster: { name: CLUSTER, arn: "arn", status: "DELETING" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.deleteCluster(CLUSTER);

      expect(result.name).toBe(CLUSTER);
      expect(result.status).toBe("DELETING");
    });

    test("throws M3LEKSOperationError when the underlying DeleteCluster call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("cluster has dependencies"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(operations.deleteCluster(CLUSTER)).rejects.toThrow(
        M3LEKSOperationError,
      );
    });
  });

  // -------------------------------------------------------------------
  // Waiters: shared contract exercised identically across all four
  // (waitUntilClusterActive/waitUntilClusterDeleted/waitUntilNodegroupActive/
  // waitUntilNodegroupDeleted) since each mocks the top-level SDK waiter
  // function directly — see the file-header note on the real generated
  // waiter source vs. the doc's prose.
  // -------------------------------------------------------------------

  /**
   * Registers the cooperative-cancellation (ADR-0049) contract for one of the
   * four `waitUntil*` methods: signal forwarding, AbortError+aborted-signal →
   * M3LOperationAbortedError rejection (never resolving ABORTED), adversarial
   * message isolation, and non-aborted-signal success-path unchanged.
   *
   * @param label - Describe-block label (matches the method name).
   * @param waiterMock - The hoisted `vi.fn()` standing in for the SDK's
   *   top-level waiter function.
   * @param invoke - Calls the method under test with the given options.
   */
  function testSignalContract(
    label: string,
    waiterMock: { mockResolvedValueOnce: (v: unknown) => unknown } & {
      mockRejectedValueOnce: (v: unknown) => unknown;
    } & { mock: { calls: unknown[][] } },
    invoke: (
      operations: M3LEKSOperations,
      options?: M3LEKSWaiterOptions,
    ) => Promise<M3LEKSWaiterResult>,
  ): void {
    describe(`${label} (cooperative cancellation)`, () => {
      // A.1 — signal forwarded to the SDK waiter's abortSignal.
      test("forwards options.signal to the SDK waiter's abortSignal (first-argument waiter config)", async () => {
        const controller = new AbortController();
        waiterMock.mockResolvedValueOnce({ state: "SUCCESS" });

        const operations = new M3LEKSOperations(fakeClient());
        await invoke(operations, { signal: controller.signal });

        const [config] = waiterMock.mock.calls[0] as [
          Record<string, unknown>,
          unknown,
        ];
        expect(config["abortSignal"]).toBe(controller.signal);
      });

      // A.4 — no signal → abortSignal key must be absent.
      test("does not set abortSignal on the waiter config when signal is omitted", async () => {
        waiterMock.mockResolvedValueOnce({ state: "SUCCESS" });

        const operations = new M3LEKSOperations(fakeClient());
        await invoke(operations);

        const [config] = waiterMock.mock.calls[0] as [
          Record<string, unknown>,
          unknown,
        ];
        expect(config).not.toHaveProperty("abortSignal");
      });

      // A.2 — AbortError + aborted signal → rejects M3LOperationAbortedError.
      test("rejects with M3LOperationAbortedError (not a resolved ABORTED state) when the caller's signal is aborted and the waiter throws AbortError", async () => {
        const controller = new AbortController();
        controller.abort();
        waiterMock.mockRejectedValueOnce(
          Object.assign(new Error("Request aborted"), { name: "AbortError" }),
        );

        const operations = new M3LEKSOperations(fakeClient());
        await expect(
          invoke(operations, { signal: controller.signal }),
        ).rejects.toBeInstanceOf(M3LOperationAbortedError);
      });

      // A.3 — adversarial: thrown error message does not forward SDK payload.
      test("adversarial: M3LOperationAbortedError message does not contain the SDK AbortError's planted secret, and cause is not chained", async () => {
        const controller = new AbortController();
        controller.abort();
        const secret = "PLANTED-EKS-ABORT-REJECT-SECRET";
        waiterMock.mockRejectedValueOnce(
          Object.assign(
            new Error(
              JSON.stringify({
                cluster: { connectorConfig: { activationCode: secret } },
              }),
            ),
            { name: "AbortError" },
          ),
        );

        const operations = new M3LEKSOperations(fakeClient());
        let thrown: unknown;
        try {
          await invoke(operations, { signal: controller.signal });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
        const err = thrown as M3LOperationAbortedError;
        expect(err.message).not.toContain(secret);
        expect(err.cause).toBeUndefined();
      });

      // A.2 — M3LOperationAbortedError classification.
      test("M3LOperationAbortedError carries ERR_OPERATION_ABORTED code, origin caller, retryable false", async () => {
        const controller = new AbortController();
        controller.abort();
        waiterMock.mockRejectedValueOnce(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );

        const operations = new M3LEKSOperations(fakeClient());
        let thrown: unknown;
        try {
          await invoke(operations, { signal: controller.signal });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(M3LOperationAbortedError);
        const err = thrown as M3LOperationAbortedError;
        expect(err.code).toBe("ERR_OPERATION_ABORTED");
        expect(err.origin).toBe("caller");
        expect(err.retryable).toBe(false);
      });

      // A.5 — non-aborted signal leaves success path unchanged.
      test("non-aborted signal does not interfere with a successful wait", async () => {
        const controller = new AbortController(); // NOT aborted
        waiterMock.mockResolvedValueOnce({ state: "SUCCESS" });

        const operations = new M3LEKSOperations(fakeClient());
        const result = await invoke(operations, { signal: controller.signal });

        expect(result).toEqual<M3LEKSWaiterResult>({ state: "SUCCESS" });
      });
    });
  }

  /**
   * Registers the shared waiter contract (SUCCESS/TIMEOUT/ABORTED/FAILURE +
   * maxWaitTime defaulting) for one of the four `waitUntil*` methods.
   *
   * @param label - Describe-block label (matches the method name).
   * @param waiterMock - The hoisted `vi.fn()` standing in for the SDK's
   *   top-level waiter function.
   * @param invoke - Calls the method under test with the given options.
   * @param failureNote - Describes, against the real generated waiter
   *   source (not the doc's symmetric prose), which resource status this
   *   waiter's FAILURE path actually fires on.
   * @param resourceDescription - The exact `resourceDescription` string this
   *   method's call site builds (e.g. `cluster name=test-cluster`), used to
   *   assert the fresh, library-constructed TIMEOUT/ABORTED `reason` string.
   */
  function testWaiterContract(
    label: string,
    waiterMock: { mockResolvedValueOnce: (v: unknown) => unknown } & {
      mockRejectedValueOnce: (v: unknown) => unknown;
    } & { mock: { calls: unknown[][] } },
    invoke: (
      operations: M3LEKSOperations,
      options?: { readonly maxWaitTime?: number },
    ) => Promise<M3LEKSWaiterResult>,
    failureNote: string,
    resourceDescription: string,
  ): void {
    describe(label, () => {
      test("resolves { state: 'SUCCESS' } with no extra properties, even though the SDK's resolved WaiterResult leaks the full last Describe* response", async () => {
        waiterMock.mockResolvedValueOnce({
          state: "SUCCESS",
          reason: {
            cluster: {
              status: "ACTIVE",
              connectorConfig: { activationCode: SECRET },
            },
          },
          final: { cluster: { status: "ACTIVE" } },
        });

        const operations = new M3LEKSOperations(fakeClient());
        const result = await invoke(operations);

        expect(result).toEqual<M3LEKSWaiterResult>({ state: "SUCCESS" });
        expect(Object.keys(result)).toEqual(["state"]);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      });

      test("resolves { state: 'TIMEOUT' } with a static, library-constructed reason — never the raw SDK waiter error's own message", async () => {
        const timeoutError = new Error(
          JSON.stringify({
            cluster: { connectorConfig: { activationCode: SECRET } },
          }),
        );
        timeoutError.name = "TimeoutError";
        waiterMock.mockRejectedValueOnce(timeoutError);

        const operations = new M3LEKSOperations(fakeClient());
        const result = await invoke(operations, { maxWaitTime: 5 });

        expect(result).toEqual<M3LEKSWaiterResult>({
          state: "TIMEOUT",
          reason: `waiter timed out before ${resourceDescription} reached the expected state`,
        });
      });

      test("resolves { state: 'ABORTED' } with a static, library-constructed reason — never the raw SDK waiter error's own message", async () => {
        const abortError = new Error(
          JSON.stringify({
            cluster: { connectorConfig: { activationCode: SECRET } },
          }),
        );
        abortError.name = "AbortError";
        waiterMock.mockRejectedValueOnce(abortError);

        const operations = new M3LEKSOperations(fakeClient());
        const result = await invoke(operations);

        expect(result).toEqual<M3LEKSWaiterResult>({
          state: "ABORTED",
          reason: `waiter aborted before ${resourceDescription} reached the expected state`,
        });
      });

      test(`throws M3LEKSOperationError without forwarding the raw waiter error's message or chaining it as cause (FAILURE fires on ${failureNote})`, async () => {
        const rawFailure = new Error(
          JSON.stringify({
            state: "FAILURE",
            reason: {
              cluster: {
                status: "DELETING",
                connectorConfig: { activationCode: SECRET },
              },
            },
          }),
        );
        // The SDK's own checkExceptions FAILURE path throws a plain Error
        // with name left at the default "Error" — indistinguishable by
        // identity from a genuine polling-call failure.
        waiterMock.mockRejectedValueOnce(rawFailure);

        const operations = new M3LEKSOperations(fakeClient());

        let thrown: unknown;
        try {
          await invoke(operations);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(M3LEKSOperationError);
        const eksError = thrown as M3LEKSOperationError;
        expect(eksError.message).not.toContain(SECRET);
        expect(eksError.cause).toBeUndefined();
      });

      test("invokes the waiter with a defaulted maxWaitTime (a number, large enough for multiple polls at the documented 30s/120s cadence) when the caller omits options", async () => {
        waiterMock.mockResolvedValueOnce({ state: "SUCCESS" });

        const operations = new M3LEKSOperations(fakeClient());
        await invoke(operations);

        const [params] = waiterMock.mock.calls[0] as [
          { maxWaitTime?: number },
          unknown,
        ];
        expect(typeof params.maxWaitTime).toBe("number");
        expect(params.maxWaitTime as number).toBeGreaterThanOrEqual(90);
      });

      test("invokes the waiter with the caller's own maxWaitTime when supplied", async () => {
        waiterMock.mockResolvedValueOnce({ state: "SUCCESS" });

        const operations = new M3LEKSOperations(fakeClient());
        await invoke(operations, { maxWaitTime: 45 });

        const [params] = waiterMock.mock.calls[0] as [
          { maxWaitTime?: number },
          unknown,
        ];
        expect(params.maxWaitTime).toBe(45);
      });
    });
  }

  testWaiterContract(
    "waitUntilClusterActive",
    h.waitUntilClusterActive,
    (operations, options) =>
      operations.waitUntilClusterActive(CLUSTER, options),
    'cluster status "DELETING" or "FAILED" (waitForClusterActive checkState)',
    `cluster name=${CLUSTER}`,
  );

  testSignalContract(
    "waitUntilClusterActive",
    h.waitUntilClusterActive,
    (operations, options) =>
      operations.waitUntilClusterActive(CLUSTER, options),
  );

  test("waitUntilClusterActive resolves TIMEOUT — not a fast SUCCESS or FAILURE — when the cluster no longer exists, since checkState RETRYs every DescribeCluster exception including ResourceNotFoundException", async () => {
    const timeoutError = new Error("Waiter has timed out");
    timeoutError.name = "TimeoutError";
    h.waitUntilClusterActive.mockRejectedValueOnce(timeoutError);

    const operations = new M3LEKSOperations(fakeClient());
    const result = await operations.waitUntilClusterActive("missing-cluster");

    expect(result.state).toBe("TIMEOUT");
  });

  testWaiterContract(
    "waitUntilClusterDeleted",
    h.waitUntilClusterDeleted,
    (operations, options) =>
      operations.waitUntilClusterDeleted(CLUSTER, options),
    'cluster status "ACTIVE", "CREATING", or "PENDING" (waitForClusterDeleted checkState) — resource unexpectedly still exists',
    `cluster name=${CLUSTER}`,
  );

  testSignalContract(
    "waitUntilClusterDeleted",
    h.waitUntilClusterDeleted,
    (operations, options) =>
      operations.waitUntilClusterDeleted(CLUSTER, options),
  );

  test("waitUntilClusterDeleted resolves SUCCESS specifically when the underlying DescribeCluster call rejects with ResourceNotFoundException (deletion confirmed)", async () => {
    h.waitUntilClusterDeleted.mockResolvedValueOnce({
      state: "SUCCESS",
      reason: namedError("ResourceNotFoundException"),
    });

    const operations = new M3LEKSOperations(fakeClient());
    const result = await operations.waitUntilClusterDeleted(CLUSTER);

    expect(result).toEqual<M3LEKSWaiterResult>({ state: "SUCCESS" });
  });

  testWaiterContract(
    "waitUntilNodegroupActive",
    h.waitUntilNodegroupActive,
    (operations, options) =>
      operations.waitUntilNodegroupActive(CLUSTER, NODEGROUP, options),
    'nodegroup status "CREATE_FAILED" only (waitForNodegroupActive checkState has no DELETE_FAILED branch, unlike the doc\'s symmetric prose)',
    `nodegroup clusterName=${CLUSTER}, nodegroupName=${NODEGROUP}`,
  );

  testSignalContract(
    "waitUntilNodegroupActive",
    h.waitUntilNodegroupActive,
    (operations, options) =>
      operations.waitUntilNodegroupActive(CLUSTER, NODEGROUP, options),
  );

  test("waitUntilNodegroupActive resolves TIMEOUT — not a fast SUCCESS or FAILURE — when the nodegroup no longer exists, since checkState RETRYs every DescribeNodegroup exception including ResourceNotFoundException", async () => {
    const timeoutError = new Error("Waiter has timed out");
    timeoutError.name = "TimeoutError";
    h.waitUntilNodegroupActive.mockRejectedValueOnce(timeoutError);

    const operations = new M3LEKSOperations(fakeClient());
    const result = await operations.waitUntilNodegroupActive(
      CLUSTER,
      "missing-nodegroup",
    );

    expect(result.state).toBe("TIMEOUT");
  });

  testWaiterContract(
    "waitUntilNodegroupDeleted",
    h.waitUntilNodegroupDeleted,
    (operations, options) =>
      operations.waitUntilNodegroupDeleted(CLUSTER, NODEGROUP, options),
    'nodegroup status "DELETE_FAILED" only (waitForNodegroupDeleted checkState has no ACTIVE/CREATING/PENDING branch, unlike the doc\'s symmetric prose)',
    `nodegroup clusterName=${CLUSTER}, nodegroupName=${NODEGROUP}`,
  );

  testSignalContract(
    "waitUntilNodegroupDeleted",
    h.waitUntilNodegroupDeleted,
    (operations, options) =>
      operations.waitUntilNodegroupDeleted(CLUSTER, NODEGROUP, options),
  );

  test("waitUntilNodegroupDeleted resolves SUCCESS specifically when the underlying DescribeNodegroup call rejects with ResourceNotFoundException (deletion confirmed)", async () => {
    h.waitUntilNodegroupDeleted.mockResolvedValueOnce({
      state: "SUCCESS",
      reason: namedError("ResourceNotFoundException"),
    });

    const operations = new M3LEKSOperations(fakeClient());
    const result = await operations.waitUntilNodegroupDeleted(
      CLUSTER,
      NODEGROUP,
    );

    expect(result).toEqual<M3LEKSWaiterResult>({ state: "SUCCESS" });
  });

  describe("listNodegroups", () => {
    test("resolves with plain nodegroup names on a successful ListNodegroups call", async () => {
      h.send.mockResolvedValueOnce({ nodegroups: [NODEGROUP] });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.listNodegroups(CLUSTER);

      expect(result).toEqual<M3LEKSListNodegroupsResult>({
        nodegroups: [NODEGROUP],
      });
    });

    test("throws M3LEKSOperationError (does not resolve an empty page) on ResourceNotFoundException for an unknown clusterName", async () => {
      h.send.mockRejectedValueOnce(namedError("ResourceNotFoundException"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.listNodegroups("unknown-cluster"),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
    });

    test("throws M3LEKSOperationError on a generic ListNodegroups failure", async () => {
      h.send.mockRejectedValueOnce(new Error("throttled"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(operations.listNodegroups(CLUSTER)).rejects.toBeInstanceOf(
        M3LEKSOperationError,
      );
    });

    test("forwards clusterName/nextToken/maxResults onto the constructed ListNodegroupsCommand", async () => {
      h.send.mockResolvedValueOnce({ nodegroups: [] });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.listNodegroups(CLUSTER, {
        nextToken: "caller-token",
        maxResults: 20,
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            clusterName?: string;
            nextToken?: string;
            maxResults?: number;
          };
        },
      ];
      expect(command.input.clusterName).toBe(CLUSTER);
      expect(command.input.nextToken).toBe("caller-token");
      expect(command.input.maxResults).toBe(20);
    });

    test("resolves with nextToken when the SDK response includes one", async () => {
      h.send.mockResolvedValueOnce({
        nodegroups: [NODEGROUP],
        nextToken: "response-token",
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.listNodegroups(CLUSTER);

      expect(result).toEqual<M3LEKSListNodegroupsResult>({
        nodegroups: [NODEGROUP],
        nextToken: "response-token",
      });
    });
  });

  describe("describeNodegroup", () => {
    test("resolves undefined when the SDK reports ResourceNotFoundException", async () => {
      h.send.mockRejectedValueOnce(namedError("ResourceNotFoundException"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.describeNodegroup(CLUSTER, "missing-nodegroup"),
      ).resolves.toBeUndefined();
    });

    test("throws M3LEKSOperationError on InvalidParameterException — a documented other-rejection case distinct from describeCluster's set", async () => {
      h.send.mockRejectedValueOnce(namedError("InvalidParameterException"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.describeNodegroup(CLUSTER, NODEGROUP),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
    });

    test("throws M3LEKSOperationError for any other DescribeNodegroup failure", async () => {
      h.send.mockRejectedValueOnce(new Error("internal error"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.describeNodegroup(CLUSTER, NODEGROUP),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
    });

    test("resolves the mapped nodegroup summary, defaulting scalingConfig-less fields sensibly", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: `arn:aws:eks:eu-south-1:123456789012:nodegroup/${CLUSTER}/${NODEGROUP}`,
          status: "ACTIVE",
          clusterName: CLUSTER,
          amiType: "AL2_x86_64",
          capacityType: "ON_DEMAND",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeNodegroup(CLUSTER, NODEGROUP);

      expect(result).toEqual<M3LEKSNodegroupSummary>({
        nodegroupName: NODEGROUP,
        nodegroupArn: `arn:aws:eks:eu-south-1:123456789012:nodegroup/${CLUSTER}/${NODEGROUP}`,
        status: "ACTIVE",
        clusterName: CLUSTER,
        amiType: "AL2_x86_64",
        capacityType: "ON_DEMAND",
      });
    });

    test("resolves a fully-populated M3LEKSNodegroupSummary when the SDK response defines every optional field", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: `arn:aws:eks:eu-south-1:123456789012:nodegroup/${CLUSTER}/${NODEGROUP}`,
          status: "ACTIVE",
          clusterName: CLUSTER,
          version: "1.31",
          releaseVersion: "1.31.0-20260101",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
          capacityType: "ON_DEMAND",
          scalingConfig: { minSize: 1, maxSize: 5, desiredSize: 2 },
          instanceTypes: ["t3.medium"],
          subnets: ["subnet-1"],
          amiType: "AL2_x86_64",
          nodeRole: "arn:aws:iam::123456789012:role/nodegroup-role",
          labels: { tier: "batch" },
          tags: { env: "test" },
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeNodegroup(CLUSTER, NODEGROUP);

      expect(result).toEqual<M3LEKSNodegroupSummary>({
        nodegroupName: NODEGROUP,
        nodegroupArn: `arn:aws:eks:eu-south-1:123456789012:nodegroup/${CLUSTER}/${NODEGROUP}`,
        status: "ACTIVE",
        clusterName: CLUSTER,
        version: "1.31",
        releaseVersion: "1.31.0-20260101",
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        capacityType: "ON_DEMAND",
        scalingConfig: { minSize: 1, maxSize: 5, desiredSize: 2 },
        instanceTypes: ["t3.medium"],
        subnets: ["subnet-1"],
        amiType: "AL2_x86_64",
        nodeRole: "arn:aws:iam::123456789012:role/nodegroup-role",
        labels: { tier: "batch" },
        tags: { env: "test" },
      });
    });

    test("resolves a minimal M3LEKSNodegroupSummary when the SDK response omits every optional field entirely", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: `arn:aws:eks:eu-south-1:123456789012:nodegroup/${CLUSTER}/${NODEGROUP}`,
          status: "ACTIVE",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeNodegroup(CLUSTER, NODEGROUP);

      expect(result).toEqual<M3LEKSNodegroupSummary>({
        nodegroupName: NODEGROUP,
        nodegroupArn: `arn:aws:eks:eu-south-1:123456789012:nodegroup/${CLUSTER}/${NODEGROUP}`,
        status: "ACTIVE",
      });
      expect(Object.keys(result ?? {})).toEqual([
        "nodegroupName",
        "nodegroupArn",
        "status",
      ]);
    });

    test("resolves scalingConfig as {} when the SDK's NodegroupScalingConfig is present but defines no field", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: "arn",
          status: "ACTIVE",
          scalingConfig: {},
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.describeNodegroup(CLUSTER, NODEGROUP);

      expect(result?.scalingConfig).toEqual({});
    });
  });

  describe("createNodegroup", () => {
    const baseInput: M3LEKSCreateNodegroupInput = {
      clusterName: CLUSTER,
      nodegroupName: NODEGROUP,
      nodeRole: "arn:aws:iam::123456789012:role/nodegroup-role",
      subnets: ["subnet-1", "subnet-2"],
    };

    test("resolves with the created nodegroup's summary", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: "arn",
          status: "CREATING",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.createNodegroup(baseInput);

      expect(result.nodegroupName).toBe(NODEGROUP);
    });

    test("resolves successfully when amiType/capacityType are valid SDK enum members", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: "arn",
          status: "CREATING",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.createNodegroup({
          ...baseInput,
          amiType: "AL2_x86_64",
          capacityType: "ON_DEMAND",
        }),
      ).resolves.toBeDefined();
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    test("throws M3LEKSOperationError before any .send() call when amiType is not a member of the SDK's AMITypes", async () => {
      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.createNodegroup({
          ...baseInput,
          amiType: "NOT_A_REAL_AMI_TYPE",
        }),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("throws M3LEKSOperationError before any .send() call when capacityType is not a member of the SDK's CapacityTypes", async () => {
      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.createNodegroup({
          ...baseInput,
          capacityType: "NOT_A_REAL_CAPACITY_TYPE",
        }),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
      expect(h.send).not.toHaveBeenCalled();
    });

    test("throws M3LEKSOperationError when the underlying CreateNodegroup call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("already exists"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.createNodegroup(baseInput),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
    });

    test("omits every optional field from the constructed CreateNodegroupCommand when the caller supplies only the required fields", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: "arn",
          status: "CREATING",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.createNodegroup(baseInput);

      const [command] = h.send.mock.calls[0] as [{ input: object }];
      expect(command.input).toEqual({
        clusterName: CLUSTER,
        nodegroupName: NODEGROUP,
        nodeRole: baseInput.nodeRole,
        subnets: [...baseInput.subnets],
      });
    });

    test("forwards a fully-populated input (scalingConfig/instanceTypes/amiType/capacityType/diskSize/labels/tags) onto the constructed CreateNodegroupCommand", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: "arn",
          status: "CREATING",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.createNodegroup({
        ...baseInput,
        scalingConfig: { minSize: 1, maxSize: 5, desiredSize: 2 },
        instanceTypes: ["t3.medium"],
        amiType: "AL2_x86_64",
        capacityType: "ON_DEMAND",
        diskSize: 20,
        labels: { tier: "batch" },
        tags: { env: "test" },
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            scalingConfig?: unknown;
            instanceTypes?: string[];
            amiType?: string;
            capacityType?: string;
            diskSize?: number;
            labels?: Record<string, string>;
            tags?: Record<string, string>;
          };
        },
      ];
      expect(command.input.scalingConfig).toEqual({
        minSize: 1,
        maxSize: 5,
        desiredSize: 2,
      });
      expect(command.input.instanceTypes).toEqual(["t3.medium"]);
      expect(command.input.amiType).toBe("AL2_x86_64");
      expect(command.input.capacityType).toBe("ON_DEMAND");
      expect(command.input.diskSize).toBe(20);
      expect(command.input.labels).toEqual({ tier: "batch" });
      expect(command.input.tags).toEqual({ env: "test" });
    });

    test("builds an empty scalingConfig object when the caller's scalingConfig supplies none of minSize/maxSize/desiredSize", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: "arn",
          status: "CREATING",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.createNodegroup({ ...baseInput, scalingConfig: {} });

      const [command] = h.send.mock.calls[0] as [
        { input: { scalingConfig?: Record<string, unknown> } },
      ];
      expect(command.input.scalingConfig).toEqual({});
    });
  });

  describe("updateNodegroupConfig", () => {
    const scalingConfig: M3LEKSNodegroupScalingConfig = {
      minSize: 1,
      maxSize: 5,
      desiredSize: 2,
    };
    const input: M3LEKSUpdateNodegroupConfigInput = {
      clusterName: CLUSTER,
      nodegroupName: NODEGROUP,
      scalingConfig,
      labels: { addOrUpdateLabels: { tier: "batch" } },
    };

    test("resolves an M3LEKSUpdate tracking object — not the mutated nodegroup resource", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-3", status: "InProgress", type: "ConfigUpdate" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.updateNodegroupConfig(input);

      expect(result).toEqual<M3LEKSUpdate>({
        id: "update-3",
        status: "InProgress",
        type: "ConfigUpdate",
      });
      expect(result).not.toHaveProperty("nodegroupName");
    });

    test("throws M3LEKSOperationError when the underlying UpdateNodegroupConfig call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("conflicting update"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.updateNodegroupConfig(input),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
    });

    test("omits scalingConfig and builds a removeLabels-only payload when the caller supplies only removeLabels", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-3", status: "InProgress" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.updateNodegroupConfig({
        clusterName: CLUSTER,
        nodegroupName: NODEGROUP,
        labels: { removeLabels: ["tier"] },
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            scalingConfig?: unknown;
            labels?: { addOrUpdateLabels?: unknown; removeLabels?: string[] };
          };
        },
      ];
      expect(command.input).not.toHaveProperty("scalingConfig");
      expect(command.input.labels).toEqual({ removeLabels: ["tier"] });
    });

    test("omits labels from the constructed UpdateNodegroupConfigCommand when the caller supplies only scalingConfig", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-3", status: "InProgress" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.updateNodegroupConfig({
        clusterName: CLUSTER,
        nodegroupName: NODEGROUP,
        scalingConfig,
      });

      const [command] = h.send.mock.calls[0] as [
        { input: { labels?: unknown } },
      ];
      expect(command.input).not.toHaveProperty("labels");
    });
  });

  describe("updateNodegroupVersion", () => {
    const input: M3LEKSUpdateNodegroupVersionInput = {
      clusterName: CLUSTER,
      nodegroupName: NODEGROUP,
      version: "1.32",
    };

    test("resolves an M3LEKSUpdate tracking object — not the mutated nodegroup resource", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-4", status: "InProgress", type: "VersionUpdate" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.updateNodegroupVersion(input);

      expect(result).toEqual<M3LEKSUpdate>({
        id: "update-4",
        status: "InProgress",
        type: "VersionUpdate",
      });
    });

    test("forwards clusterName/nodegroupName/releaseVersion/force onto the constructed UpdateNodegroupVersionCommand", async () => {
      h.send.mockResolvedValueOnce({
        update: { id: "update-4", status: "InProgress" },
      });

      const operations = new M3LEKSOperations(fakeClient());
      await operations.updateNodegroupVersion({
        ...input,
        releaseVersion: "1.32.0-20260101",
        force: true,
      });

      const [command] = h.send.mock.calls[0] as [
        {
          input: {
            clusterName?: string;
            nodegroupName?: string;
            releaseVersion?: string;
            force?: boolean;
          };
        },
      ];
      expect(command.input.clusterName).toBe(CLUSTER);
      expect(command.input.nodegroupName).toBe(NODEGROUP);
      expect(command.input.releaseVersion).toBe("1.32.0-20260101");
      expect(command.input.force).toBe(true);
    });

    test("throws M3LEKSOperationError when the underlying UpdateNodegroupVersion call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("version not upgradeable"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.updateNodegroupVersion(input),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
    });
  });

  describe("deleteNodegroup", () => {
    test("resolves with the deleted nodegroup's summary snapshot", async () => {
      h.send.mockResolvedValueOnce({
        nodegroup: {
          nodegroupName: NODEGROUP,
          nodegroupArn: "arn",
          status: "DELETING",
        },
      });

      const operations = new M3LEKSOperations(fakeClient());
      const result = await operations.deleteNodegroup(CLUSTER, NODEGROUP);

      expect(result.nodegroupName).toBe(NODEGROUP);
      expect(result.status).toBe("DELETING");
    });

    test("throws M3LEKSOperationError when the underlying DeleteNodegroup call fails", async () => {
      h.send.mockRejectedValueOnce(new Error("nodegroup has dependencies"));

      const operations = new M3LEKSOperations(fakeClient());

      await expect(
        operations.deleteNodegroup(CLUSTER, NODEGROUP),
      ).rejects.toBeInstanceOf(M3LEKSOperationError);
    });
  });

  describe("M3LEKSOperationError", () => {
    test("carries the ERR_EKS_OPERATION code", () => {
      const error = new M3LEKSOperationError("boom");

      expect(error.code).toBe("ERR_EKS_OPERATION");
    });

    test("chains the underlying cause when supplied", () => {
      const cause = new Error("underlying SDK failure");
      const error = new M3LEKSOperationError("boom", { cause });

      expect(error.cause).toBe(cause);
    });
  });

  describe("type contract", () => {
    test("M3LEKSClusterSummary has the documented required/optional field shape", () => {
      expectTypeOf<M3LEKSClusterSummary>().toExtend<{
        readonly name: string;
        readonly arn: string;
        readonly status: string;
        readonly version?: string;
      }>();
    });

    test("M3LEKSClusterSummary never declares a connectorConfig field", () => {
      expectTypeOf<M3LEKSClusterSummary>().not.toHaveProperty(
        "connectorConfig",
      );
    });

    test("M3LEKSNodegroupSummary has the documented required/optional field shape", () => {
      expectTypeOf<M3LEKSNodegroupSummary>().toExtend<{
        readonly nodegroupName: string;
        readonly nodegroupArn: string;
        readonly status: string;
        readonly clusterName?: string;
        readonly amiType?: string;
        readonly capacityType?: string;
      }>();
    });

    test("M3LEKSVpcConfig.subnetIds is a required readonly string[], unlike the SDK's optional VpcConfigResponse.subnetIds", () => {
      expectTypeOf<M3LEKSVpcConfig>().toExtend<{
        readonly subnetIds: readonly string[];
      }>();
    });

    test("M3LEKSUpdate has the documented required/optional field shape", () => {
      expectTypeOf<M3LEKSUpdate>().toEqualTypeOf<{
        readonly id: string;
        readonly status: string;
        readonly type?: string;
        readonly createdAt?: string;
        readonly errors?: readonly {
          readonly errorCode?: string;
          readonly errorMessage?: string;
          readonly resourceIds?: readonly string[];
        }[];
      }>();
    });

    test("M3LEKSWaiterResult is the discriminated { state, reason? } shape", () => {
      expectTypeOf<M3LEKSWaiterResult>().toEqualTypeOf<{
        readonly state: "SUCCESS" | "TIMEOUT" | "ABORTED";
        readonly reason?: string;
      }>();
    });

    test("the four update* methods resolve Promise<M3LEKSUpdate>, not the mutated resource", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["updateClusterConfig"]>>
      >().toEqualTypeOf<M3LEKSUpdate>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["updateClusterVersion"]>>
      >().toEqualTypeOf<M3LEKSUpdate>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["updateNodegroupConfig"]>>
      >().toEqualTypeOf<M3LEKSUpdate>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["updateNodegroupVersion"]>>
      >().toEqualTypeOf<M3LEKSUpdate>();
    });

    test("createCluster/deleteCluster resolve Promise<M3LEKSClusterSummary> (synchronous, unlike update*)", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["createCluster"]>>
      >().toEqualTypeOf<M3LEKSClusterSummary>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["deleteCluster"]>>
      >().toEqualTypeOf<M3LEKSClusterSummary>();
    });

    test("createNodegroup/deleteNodegroup resolve Promise<M3LEKSNodegroupSummary> (synchronous, unlike update*)", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["createNodegroup"]>>
      >().toEqualTypeOf<M3LEKSNodegroupSummary>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["deleteNodegroup"]>>
      >().toEqualTypeOf<M3LEKSNodegroupSummary>();
    });

    test("describeCluster/describeNodegroup resolve their summary type or undefined", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["describeCluster"]>>
      >().toEqualTypeOf<M3LEKSClusterSummary | undefined>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["describeNodegroup"]>>
      >().toEqualTypeOf<M3LEKSNodegroupSummary | undefined>();
    });

    test("listClusters/listNodegroups resolve their paginated result shapes", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["listClusters"]>>
      >().toEqualTypeOf<M3LEKSListClustersResult>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["listNodegroups"]>>
      >().toEqualTypeOf<M3LEKSListNodegroupsResult>();
    });

    test("all four waitUntil* methods resolve Promise<M3LEKSWaiterResult>", () => {
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["waitUntilClusterActive"]>>
      >().toEqualTypeOf<M3LEKSWaiterResult>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["waitUntilClusterDeleted"]>>
      >().toEqualTypeOf<M3LEKSWaiterResult>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["waitUntilNodegroupActive"]>>
      >().toEqualTypeOf<M3LEKSWaiterResult>();
      expectTypeOf<
        Awaited<ReturnType<M3LEKSOperations["waitUntilNodegroupDeleted"]>>
      >().toEqualTypeOf<M3LEKSWaiterResult>();
    });

    test("all four waitUntil* methods' options? parameter is typed as M3LEKSWaiterOptions | undefined", () => {
      expectTypeOf<
        Parameters<M3LEKSOperations["waitUntilClusterActive"]>[1]
      >().toEqualTypeOf<M3LEKSWaiterOptions | undefined>();
      expectTypeOf<
        Parameters<M3LEKSOperations["waitUntilClusterDeleted"]>[1]
      >().toEqualTypeOf<M3LEKSWaiterOptions | undefined>();
      expectTypeOf<
        Parameters<M3LEKSOperations["waitUntilNodegroupActive"]>[2]
      >().toEqualTypeOf<M3LEKSWaiterOptions | undefined>();
      expectTypeOf<
        Parameters<M3LEKSOperations["waitUntilNodegroupDeleted"]>[2]
      >().toEqualTypeOf<M3LEKSWaiterOptions | undefined>();
    });
  });
});
