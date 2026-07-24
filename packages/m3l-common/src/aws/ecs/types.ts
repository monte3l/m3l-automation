/**
 * `aws/ecs/types` — plain, library-owned shapes {@link M3LECSOperations}
 * returns and accepts, translated from the raw `@aws-sdk/client-ecs`
 * request/response shapes so callers never see SDK types directly.
 *
 * Scoped to the ECS **service** control-plane resource plus the read-only
 * cluster context a service operation needs (see `docs/reference/aws/ecs.md`).
 * Cluster mutation, task-definition registration, and task run/stop are
 * deliberately out of this v1 surface.
 *
 * @packageDocumentation
 */

/** A load-balancer target attached to a service. */
export interface M3LECSLoadBalancer {
  readonly targetGroupArn?: string;
  readonly loadBalancerName?: string;
  readonly containerName?: string;
  readonly containerPort?: number;
}

/**
 * VPC networking for an `awsvpc`-mode service (Fargate, or `awsvpc`-network-mode
 * EC2 tasks).
 */
export interface M3LECSNetworkConfiguration {
  readonly subnets: readonly string[];
  readonly securityGroups?: readonly string[];
  readonly assignPublicIp?: boolean;
}

/**
 * One page of {@link M3LECSOperations.listServices} results. `ListServices`
 * returns ARNs only — call {@link M3LECSOperations.describeService} for detail
 * on a specific service.
 */
export interface M3LECSListServicesResult {
  readonly serviceArns: readonly string[];
  /** Present when another page is available; pass back as `nextToken` to continue. */
  readonly nextToken?: string;
}

/**
 * Full service detail returned by {@link M3LECSOperations.describeService},
 * `createService`, `updateService`, and `deleteService`.
 */
export interface M3LECSServiceDescription {
  readonly serviceArn: string;
  readonly serviceName: string;
  readonly clusterArn: string;
  readonly status: string;
  readonly desiredCount: number;
  readonly runningCount: number;
  readonly pendingCount: number;
  readonly taskDefinition?: string;
  readonly launchType?: string;
  readonly roleArn?: string;
  /** ISO-8601, present when the SDK response includes a creation timestamp. */
  readonly createdAt?: string;
  readonly loadBalancers?: readonly M3LECSLoadBalancer[];
  readonly networkConfiguration?: M3LECSNetworkConfiguration;
}

/** Input to {@link M3LECSOperations.createService}. */
export interface M3LECSCreateServiceInput {
  readonly cluster: string;
  readonly serviceName: string;
  /** Family:revision or full ARN of an existing task definition. */
  readonly taskDefinition: string;
  readonly desiredCount?: number;
  readonly launchType?: string;
  readonly loadBalancers?: readonly M3LECSLoadBalancer[];
  readonly networkConfiguration?: M3LECSNetworkConfiguration;
}

/** Input to {@link M3LECSOperations.updateService}. */
export interface M3LECSUpdateServiceInput {
  readonly cluster: string;
  readonly service: string;
  readonly desiredCount?: number;
  /** Family:revision or full ARN of the task definition to roll the service to. */
  readonly taskDefinition?: string;
  readonly forceNewDeployment?: boolean;
  readonly networkConfiguration?: M3LECSNetworkConfiguration;
}

/** Result of {@link M3LECSOperations.waitUntilServicesStable}. */
export interface M3LECSWaiterResult {
  readonly state: "SUCCESS" | "ABORTED" | "TIMEOUT";
  readonly reason?: string;
}

/** Read-only cluster summary ({@link M3LECSOperations.listClusters}/`describeCluster` context). */
export interface M3LECSClusterSummary {
  readonly clusterArn: string;
  readonly clusterName: string;
  readonly status?: string;
  readonly activeServicesCount?: number;
  readonly runningTasksCount?: number;
  readonly pendingTasksCount?: number;
}

/** One page of {@link M3LECSOperations.listClusters} results. */
export interface M3LECSListClustersResult {
  readonly clusterArns: readonly string[];
  /** Present when another page is available; pass back as `nextToken` to continue. */
  readonly nextToken?: string;
}
