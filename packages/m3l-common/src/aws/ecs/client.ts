/**
 * `aws/ecs/client` — {@link M3LECSOperations}, a typed wrapper over a raw
 * `ECSClient` so callers never import `@aws-sdk/client-ecs` command classes
 * directly. Scoped to the ECS **service** control-plane resource plus the
 * read-only cluster context a service operation needs — no cluster mutation,
 * task-definition registration, or task run/stop (see
 * `docs/reference/aws/ecs.md`).
 *
 * @packageDocumentation
 */

import type {
  AwsVpcConfiguration,
  Cluster,
  ECSClient,
  LaunchType,
  LoadBalancer,
  NetworkConfiguration,
  Service,
} from "@aws-sdk/client-ecs";
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  ListClustersCommand,
  ListServicesCommand,
  UpdateServiceCommand,
  waitUntilServicesStable,
} from "@aws-sdk/client-ecs";

import { M3LECSOperationError } from "./error.js";
import type {
  M3LECSClusterSummary,
  M3LECSCreateServiceInput,
  M3LECSListClustersResult,
  M3LECSListServicesResult,
  M3LECSLoadBalancer,
  M3LECSNetworkConfiguration,
  M3LECSServiceDescription,
  M3LECSUpdateServiceInput,
  M3LECSWaiterResult,
} from "./types.js";

/**
 * Default `maxWaitTime` (in seconds) passed to the SDK's
 * `waitUntilServicesStable` waiter when the caller omits `options.maxWaitTime`
 * — matches the AWS CLI's own default ECS `services-stable` wait budget: 40
 * attempts at a 15-second poll delay.
 */
const DEFAULT_MAX_WAIT_TIME_SECONDS = 600;

/**
 * Translates an SDK `LoadBalancer`-shaped object into the plain
 * {@link M3LECSLoadBalancer}, each field included only when the SDK response
 * defines it (`exactOptionalPropertyTypes`-safe).
 *
 * @param loadBalancer - The SDK's `LoadBalancer`-shaped object.
 * @returns The plain, library-owned load-balancer shape.
 */
function mapLoadBalancer(loadBalancer: LoadBalancer): M3LECSLoadBalancer {
  return {
    ...(loadBalancer.targetGroupArn !== undefined && {
      targetGroupArn: loadBalancer.targetGroupArn,
    }),
    ...(loadBalancer.loadBalancerName !== undefined && {
      loadBalancerName: loadBalancer.loadBalancerName,
    }),
    ...(loadBalancer.containerName !== undefined && {
      containerName: loadBalancer.containerName,
    }),
    ...(loadBalancer.containerPort !== undefined && {
      containerPort: loadBalancer.containerPort,
    }),
  };
}

/**
 * Translates an SDK `AwsVpcConfiguration`-shaped object into the plain
 * {@link M3LECSNetworkConfiguration}. `subnets` defaults to `[]` when the SDK
 * omits it; `securityGroups`/`assignPublicIp` are included only when the SDK
 * response defines them — `assignPublicIp` is translated from the SDK's
 * `"ENABLED"`/`"DISABLED"` string enum to a plain boolean.
 *
 * @param awsvpcConfiguration - The SDK's `AwsVpcConfiguration`-shaped object.
 * @returns The plain, library-owned network-configuration shape.
 */
function mapNetworkConfiguration(
  awsvpcConfiguration: AwsVpcConfiguration,
): M3LECSNetworkConfiguration {
  return {
    subnets: awsvpcConfiguration.subnets ?? [],
    ...(awsvpcConfiguration.securityGroups !== undefined && {
      securityGroups: awsvpcConfiguration.securityGroups,
    }),
    ...(awsvpcConfiguration.assignPublicIp !== undefined && {
      assignPublicIp: awsvpcConfiguration.assignPublicIp === "ENABLED",
    }),
  };
}

/**
 * The `taskDefinition`/`launchType`/`roleArn`/`createdAt`/`loadBalancers`/
 * `networkConfiguration` subset of {@link M3LECSServiceDescription}, each
 * included only when the SDK response defines the corresponding field
 * (`exactOptionalPropertyTypes`-safe). Split out of {@link mapServiceDescription}
 * to keep that function's cyclomatic complexity within the lint budget.
 *
 * @param service - The SDK's `Service`-shaped object.
 * @returns The optional-field subset of the plain service-description shape.
 */
function mapOptionalServiceFields(
  service: Service,
): Pick<
  M3LECSServiceDescription,
  | "taskDefinition"
  | "launchType"
  | "roleArn"
  | "createdAt"
  | "loadBalancers"
  | "networkConfiguration"
> {
  const awsvpcConfiguration = service.networkConfiguration?.awsvpcConfiguration;

  return {
    ...(service.taskDefinition !== undefined && {
      taskDefinition: service.taskDefinition,
    }),
    ...(service.launchType !== undefined && {
      launchType: service.launchType,
    }),
    ...(service.roleArn !== undefined && { roleArn: service.roleArn }),
    ...(service.createdAt !== undefined && {
      createdAt: service.createdAt.toISOString(),
    }),
    ...(service.loadBalancers !== undefined && {
      loadBalancers: service.loadBalancers.map(mapLoadBalancer),
    }),
    ...(awsvpcConfiguration !== undefined && {
      networkConfiguration: mapNetworkConfiguration(awsvpcConfiguration),
    }),
  };
}

/**
 * Translates an SDK `Service`-shaped object (returned by `DescribeServices`
 * under `.services[]`, and returned flat by
 * `CreateService`/`UpdateService`/`DeleteService`) into the plain
 * {@link M3LECSServiceDescription}. `serviceArn`/`serviceName`/`clusterArn`/
 * `status` default to `""` and the count fields default to `0` when the SDK
 * omits them; every other field is included only when the SDK response
 * defines it (`exactOptionalPropertyTypes`-safe).
 *
 * @param service - The SDK's `Service`-shaped object.
 * @returns The plain, library-owned service-description shape.
 */
function mapServiceDescription(service: Service): M3LECSServiceDescription {
  return {
    serviceArn: service.serviceArn ?? "",
    serviceName: service.serviceName ?? "",
    clusterArn: service.clusterArn ?? "",
    status: service.status ?? "",
    desiredCount: service.desiredCount ?? 0,
    runningCount: service.runningCount ?? 0,
    pendingCount: service.pendingCount ?? 0,
    ...mapOptionalServiceFields(service),
  };
}

/**
 * Translates an SDK `Cluster`-shaped object into the plain
 * {@link M3LECSClusterSummary}. `clusterArn`/`clusterName` default to `""`
 * when the SDK omits them; every other field is included only when the SDK
 * response defines it (`exactOptionalPropertyTypes`-safe).
 *
 * @param cluster - The SDK's `Cluster`-shaped object.
 * @returns The plain, library-owned cluster-summary shape.
 */
function mapClusterSummary(cluster: Cluster): M3LECSClusterSummary {
  return {
    clusterArn: cluster.clusterArn ?? "",
    clusterName: cluster.clusterName ?? "",
    ...(cluster.status !== undefined && { status: cluster.status }),
    ...(cluster.activeServicesCount !== undefined && {
      activeServicesCount: cluster.activeServicesCount,
    }),
    ...(cluster.runningTasksCount !== undefined && {
      runningTasksCount: cluster.runningTasksCount,
    }),
    ...(cluster.pendingTasksCount !== undefined && {
      pendingTasksCount: cluster.pendingTasksCount,
    }),
  };
}

/**
 * Builds an SDK `LoadBalancer`-shaped object from the plain
 * {@link M3LECSLoadBalancer}, each field included only when the caller
 * supplied it (`exactOptionalPropertyTypes`-safe).
 *
 * @param loadBalancer - The caller's plain load-balancer shape.
 * @returns The SDK command-input `LoadBalancer` shape.
 */
function buildLoadBalancer(loadBalancer: M3LECSLoadBalancer): LoadBalancer {
  return {
    ...(loadBalancer.targetGroupArn !== undefined && {
      targetGroupArn: loadBalancer.targetGroupArn,
    }),
    ...(loadBalancer.loadBalancerName !== undefined && {
      loadBalancerName: loadBalancer.loadBalancerName,
    }),
    ...(loadBalancer.containerName !== undefined && {
      containerName: loadBalancer.containerName,
    }),
    ...(loadBalancer.containerPort !== undefined && {
      containerPort: loadBalancer.containerPort,
    }),
  };
}

/**
 * Builds an SDK `NetworkConfiguration`-shaped object from the plain
 * {@link M3LECSNetworkConfiguration}, translating `assignPublicIp` from a
 * plain boolean back into the SDK's `"ENABLED"`/`"DISABLED"` string enum
 * (`exactOptionalPropertyTypes`-safe).
 *
 * @param networkConfiguration - The caller's plain network-configuration shape.
 * @returns The SDK command-input `NetworkConfiguration` shape.
 */
function buildNetworkConfiguration(
  networkConfiguration: M3LECSNetworkConfiguration,
): NetworkConfiguration {
  return {
    awsvpcConfiguration: {
      subnets: [...networkConfiguration.subnets],
      ...(networkConfiguration.securityGroups !== undefined && {
        securityGroups: [...networkConfiguration.securityGroups],
      }),
      ...(networkConfiguration.assignPublicIp !== undefined && {
        assignPublicIp: networkConfiguration.assignPublicIp
          ? "ENABLED"
          : "DISABLED",
      }),
    },
  };
}

/**
 * Typed operations wrapper over a raw `ECSClient`, covering the ECS
 * **service** control-plane verb set `scripts/ecs-ops` needs
 * (list/describe/create/update/delete + a stabilization wait), plus the
 * read-only cluster context a service operation needs — without any caller
 * ever importing an `@aws-sdk/client-ecs` command class directly (ADR-0029 —
 * scripts depend only on `@m3l-automation/m3l-common`).
 *
 * @example
 * ```ts
 * import { AWS } from "@m3l-automation/m3l-common";
 *
 * const ecsOperations = new AWS.M3LECSOperations(script.aws.clients.ecs);
 * const { serviceArns } = await ecsOperations.listServices({ cluster: "my-cluster" });
 * ```
 */
export class M3LECSOperations {
  /**
   * Creates a new `M3LECSOperations`.
   *
   * @param client - The raw `ECSClient` this wrapper issues commands through
   *   (e.g. `script.aws.clients.ecs`).
   */
  constructor(private readonly client: ECSClient) {}

  /**
   * Lists service ARNs in a cluster, one page at a time. `ListServices`
   * returns ARNs only — call {@link describeService} for detail on a
   * specific service.
   *
   * @param options - `cluster` scopes the listing (default cluster if
   *   omitted); `nextToken` continues a previous page.
   * @throws {@link M3LECSOperationError} if the underlying `ListServices` call fails.
   */
  async listServices(options?: {
    readonly cluster?: string;
    readonly nextToken?: string;
  }): Promise<M3LECSListServicesResult> {
    let response;
    try {
      response = await this.client.send(
        new ListServicesCommand({
          ...(options?.cluster !== undefined && { cluster: options.cluster }),
          ...(options?.nextToken !== undefined && {
            nextToken: options.nextToken,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LECSOperationError(
        "M3LECSOperations.listServices: ListServices failed",
        { cause },
      );
    }

    return {
      serviceArns: response.serviceArns ?? [],
      ...(response.nextToken !== undefined && {
        nextToken: response.nextToken,
      }),
    };
  }

  /**
   * Retrieves a single service's full description.
   *
   * @param cluster - The cluster hosting the service (short name or ARN).
   * @param service - The service name or ARN.
   * @throws {@link M3LECSOperationError} if the underlying `DescribeServices` call fails.
   */
  async describeService(
    cluster: string,
    service: string,
  ): Promise<M3LECSServiceDescription> {
    let response;
    try {
      response = await this.client.send(
        new DescribeServicesCommand({ cluster, services: [service] }),
      );
    } catch (cause) {
      throw new M3LECSOperationError(
        `M3LECSOperations.describeService: DescribeServices failed for cluster=${cluster}, service=${service}`,
        { cause },
      );
    }

    return mapServiceDescription(response.services?.[0] ?? {});
  }

  /**
   * Creates a new service from an existing task definition.
   *
   * @param input - The new service's definition.
   * @throws {@link M3LECSOperationError} if the underlying `CreateService` call fails.
   */
  async createService(
    input: M3LECSCreateServiceInput,
  ): Promise<M3LECSServiceDescription> {
    let response;
    try {
      response = await this.client.send(
        new CreateServiceCommand({
          cluster: input.cluster,
          serviceName: input.serviceName,
          taskDefinition: input.taskDefinition,
          ...(input.desiredCount !== undefined && {
            desiredCount: input.desiredCount,
          }),
          ...(input.launchType !== undefined && {
            launchType: input.launchType as LaunchType,
          }),
          ...(input.loadBalancers !== undefined && {
            loadBalancers: input.loadBalancers.map(buildLoadBalancer),
          }),
          ...(input.networkConfiguration !== undefined && {
            networkConfiguration: buildNetworkConfiguration(
              input.networkConfiguration,
            ),
          }),
        }),
      );
    } catch (cause) {
      throw new M3LECSOperationError(
        `M3LECSOperations.createService: CreateService failed for serviceName=${input.serviceName}`,
        { cause },
      );
    }

    if (response.service === undefined) {
      throw new M3LECSOperationError(
        "M3LECSOperations.createService: CreateService succeeded but returned no service",
      );
    }

    return mapServiceDescription(response.service);
  }

  /**
   * Updates an existing service (desired count, task definition, forced
   * redeployment, or networking).
   *
   * @param input - The target service and the fields to change.
   * @throws {@link M3LECSOperationError} if the underlying `UpdateService` call fails.
   */
  async updateService(
    input: M3LECSUpdateServiceInput,
  ): Promise<M3LECSServiceDescription> {
    let response;
    try {
      response = await this.client.send(
        new UpdateServiceCommand({
          cluster: input.cluster,
          service: input.service,
          ...(input.desiredCount !== undefined && {
            desiredCount: input.desiredCount,
          }),
          ...(input.taskDefinition !== undefined && {
            taskDefinition: input.taskDefinition,
          }),
          ...(input.forceNewDeployment !== undefined && {
            forceNewDeployment: input.forceNewDeployment,
          }),
          ...(input.networkConfiguration !== undefined && {
            networkConfiguration: buildNetworkConfiguration(
              input.networkConfiguration,
            ),
          }),
        }),
      );
    } catch (cause) {
      throw new M3LECSOperationError(
        `M3LECSOperations.updateService: UpdateService failed for service=${input.service}`,
        { cause },
      );
    }

    if (response.service === undefined) {
      throw new M3LECSOperationError(
        "M3LECSOperations.updateService: UpdateService succeeded but returned no service",
      );
    }

    return mapServiceDescription(response.service);
  }

  /**
   * Deletes a service. Destructive — the caller (`scripts/ecs-ops`) is
   * responsible for its own confirmation gate; this wrapper performs no
   * guard of its own.
   *
   * @param cluster - The cluster hosting the service (short name or ARN).
   * @param service - The service name or ARN.
   * @param force - When `true`, deletes even if the service has not been
   *   scaled to zero first (mirrors the SDK's own `force` field).
   * @throws {@link M3LECSOperationError} if the underlying `DeleteService` call fails.
   */
  async deleteService(
    cluster: string,
    service: string,
    force?: boolean,
  ): Promise<M3LECSServiceDescription> {
    let response;
    try {
      response = await this.client.send(
        new DeleteServiceCommand({
          cluster,
          service,
          ...(force !== undefined && { force }),
        }),
      );
    } catch (cause) {
      throw new M3LECSOperationError(
        `M3LECSOperations.deleteService: DeleteService failed for cluster=${cluster}, service=${service}, force=${String(force)}`,
        { cause },
      );
    }

    if (response.service === undefined) {
      throw new M3LECSOperationError(
        "M3LECSOperations.deleteService: DeleteService succeeded but returned no service",
      );
    }

    return mapServiceDescription(response.service);
  }

  /**
   * Waits for one or more services to reach a stable state, wrapping the
   * SDK's own `waitUntilServicesStable` waiter (which throws on a non-`SUCCESS`
   * terminal state) in a `try`/`catch` that resolves the two states the SDK
   * identifies by a distinct error name instead.
   *
   * @param cluster - The cluster hosting the services (short name or ARN).
   * @param services - The service names or ARNs to wait on (up to 10, the
   *   `DescribeServices` limit).
   * @param options - `maxWaitTime` bounds the wait, in seconds; defaults to
   *   `600` (matches the AWS CLI's own default ECS `services-stable` wait
   *   budget: 40 attempts at a 15-second poll delay).
   * @throws {@link M3LECSOperationError} for any rejection other than the
   *   waiter's own `TimeoutError`/`AbortError` — including the SDK's
   *   `FAILURE` terminal waiter state, which surfaces as a plain, unnamed
   *   `Error` indistinguishable by identity from a genuine `DescribeServices`
   *   call failure, so it is treated as a fault rather than resolved as data
   *   (see `docs/reference/aws/ecs.md`'s waiter section for the full
   *   rationale). A `TimeoutError` resolves with `state: "TIMEOUT"` and an
   *   `AbortError` resolves with `state: "ABORTED"` instead.
   */
  async waitUntilServicesStable(
    cluster: string,
    services: readonly string[],
    options?: { readonly maxWaitTime?: number },
  ): Promise<M3LECSWaiterResult> {
    try {
      await waitUntilServicesStable(
        {
          client: this.client,
          maxWaitTime: options?.maxWaitTime ?? DEFAULT_MAX_WAIT_TIME_SECONDS,
        },
        { cluster, services: [...services] },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { state: "TIMEOUT", reason: error.message };
      }
      if (error instanceof Error && error.name === "AbortError") {
        return { state: "ABORTED", reason: error.message };
      }
      throw new M3LECSOperationError(
        "M3LECSOperations.waitUntilServicesStable: DescribeServices polling failed",
        { cause: error },
      );
    }

    return { state: "SUCCESS" };
  }

  /**
   * Lists cluster ARNs, one page at a time. Read-only context for scoping
   * service operations — no cluster mutation in this v1 (see
   * `docs/reference/aws/ecs.md`).
   *
   * @param options - `nextToken` continues a previous page.
   * @throws {@link M3LECSOperationError} if the underlying `ListClusters` call fails.
   */
  async listClusters(options?: {
    readonly nextToken?: string;
  }): Promise<M3LECSListClustersResult> {
    let response;
    try {
      response = await this.client.send(
        new ListClustersCommand({
          ...(options?.nextToken !== undefined && {
            nextToken: options.nextToken,
          }),
        }),
      );
    } catch (cause) {
      throw new M3LECSOperationError(
        "M3LECSOperations.listClusters: ListClusters failed",
        { cause },
      );
    }

    return {
      clusterArns: response.clusterArns ?? [],
      ...(response.nextToken !== undefined && {
        nextToken: response.nextToken,
      }),
    };
  }

  /**
   * Retrieves a single cluster's summary. Read-only context — see
   * {@link listClusters}.
   *
   * @param cluster - The cluster name or ARN.
   * @throws {@link M3LECSOperationError} if the underlying `DescribeClusters` call fails.
   */
  async describeCluster(cluster: string): Promise<M3LECSClusterSummary> {
    let response;
    try {
      response = await this.client.send(
        new DescribeClustersCommand({ clusters: [cluster] }),
      );
    } catch (cause) {
      throw new M3LECSOperationError(
        `M3LECSOperations.describeCluster: DescribeClusters failed for cluster=${cluster}`,
        { cause },
      );
    }

    return mapClusterSummary(response.clusters?.[0] ?? {});
  }
}
