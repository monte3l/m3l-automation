/**
 * `aws/clients/service-provider` — `AWSServiceProvider`, the single-profile,
 * lazily cached library-owned wrapper-object provider.
 *
 * @packageDocumentation
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { M3LAthenaClient } from "../athena/client.js";
import { M3LCloudFormationOperations } from "../cloudformation/client.js";
import { M3LCloudWatchAlarmsOperations } from "../cloudwatch-alarms/client.js";
import { M3LLogsInsightsClient } from "../cloudwatch-logs-insights/client.js";
import { M3LCloudWatchMetricsOperations } from "../cloudwatch-metrics/client.js";
import { M3LCodePipelineOperations } from "../codepipeline/client.js";
import { M3LAWSCredentialsManager } from "../credentials/manager.js";
import { M3LDynamoDBOperations } from "../dynamodb/client.js";
import { M3LECSOperations } from "../ecs/client.js";
import { M3LEKSOperations } from "../eks/client.js";
import { M3LEventBridgeOperations } from "../eventbridge/client.js";
import { M3LLambdaOperations } from "../lambda/client.js";
import { M3LS3Operations } from "../s3/client.js";
import { M3LSecretsManagerOperations } from "../secrets-manager/client.js";
import { M3LRequestSigner } from "../signing/client.js";
import { M3LSQSOperations } from "../sqs/client.js";

import type { AWSClientProvider } from "./provider.js";

/**
 * For a single profile, `AWSServiceProvider` lazily constructs and caches
 * **library-owned wrapper objects** — the typed `M3L*Operations`/`M3L*Client`
 * classes each AWS submodule exports — over the raw SDK clients an
 * {@link AWSClientProvider} already provides. It is the consistent, single
 * access path every wrapper submodule is reachable through as
 * `provider.services.<name>`, without the caller constructing it by hand.
 *
 * Most getters build a **fresh** wrapper instance, sharing the same
 * underlying, lazily-cached SDK client from `clientProvider` that
 * `clientProvider`'s own raw-client getters use — so accessing a raw client
 * via `clientProvider` and its wrapper via `services` never resolves
 * credentials twice or opens two connections. Two exceptions:
 * `dynamoDBDocument` is a direct passthrough to
 * `clientProvider.dynamoDBDocument` (there is no separate wrapper class for
 * it), and `requestSigner`/`credentials` are built from
 * `clientProvider.profile`/`clientProvider.region` rather than from any SDK
 * client.
 *
 * @example
 * ```ts
 * import { AWSProvider, parseAWSProfile } from "@m3l-automation/m3l-common/aws";
 *
 * const provider = new AWSProvider({
 *   profile: parseAWSProfile("my-profile"),
 * });
 *
 * // Each wrapper is constructed lazily on first access and cached
 * // thereafter, built from the same underlying AWSClientProvider
 * // `provider.clients` uses.
 * const athena = provider.services.athena;
 * const sqsOperations = provider.services.sqsOperations;
 * ```
 */
export class AWSServiceProvider {
  private readonly clientProvider: AWSClientProvider;

  private sqsOperationsWrapper: M3LSQSOperations | undefined;
  private eventBridgeOperationsWrapper: M3LEventBridgeOperations | undefined;
  private athenaWrapper: M3LAthenaClient | undefined;
  private cloudFormationWrapper: M3LCloudFormationOperations | undefined;
  private cloudWatchAlarmsWrapper: M3LCloudWatchAlarmsOperations | undefined;
  private cloudWatchLogsInsightsWrapper: M3LLogsInsightsClient | undefined;
  private cloudWatchMetricsWrapper: M3LCloudWatchMetricsOperations | undefined;
  private codePipelineWrapper: M3LCodePipelineOperations | undefined;
  private ecsWrapper: M3LECSOperations | undefined;
  private eksWrapper: M3LEKSOperations | undefined;
  private lambdaWrapper: M3LLambdaOperations | undefined;
  private secretsManagerWrapper: M3LSecretsManagerOperations | undefined;
  private requestSignerClient: M3LRequestSigner | undefined;
  private credentialsManager: M3LAWSCredentialsManager | undefined;
  private s3OperationsWrapper: M3LS3Operations | undefined;
  private dynamoDBOperationsWrapper: M3LDynamoDBOperations | undefined;

  /**
   * Creates a new `AWSServiceProvider`.
   *
   * Construction performs no I/O — no wrapper object is built and no raw SDK
   * client is requested from `clientProvider` until a getter is first
   * accessed.
   *
   * @param clientProvider - The {@link AWSClientProvider} this provider
   *   pulls raw clients from — and, since a review flagged the earlier
   *   two-parameter constructor as able to authenticate `requestSigner`/
   *   `credentials` under a different identity than every other getter, also
   *   the **sole** source of `profile`/`region` for those two getters (read
   *   via `clientProvider.profile`/`clientProvider.region`). Never construct
   *   a new one here — always pass the same instance the caller already
   *   lazily built, so no client is ever double-constructed.
   */
  constructor(clientProvider: AWSClientProvider) {
    this.clientProvider = clientProvider;
  }

  /**
   * The {@link M3LSQSOperations} wrapper over `clientProvider.sqs`,
   * constructed on first access.
   */
  get sqsOperations(): M3LSQSOperations {
    const cached = this.sqsOperationsWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.sqs; // may throw a typed M3LAWSClientError — let it propagate
    const operations = new M3LSQSOperations(client);
    this.sqsOperationsWrapper = operations;
    return operations;
  }

  /**
   * The {@link M3LEventBridgeOperations} wrapper over
   * `clientProvider.eventBridge`, constructed on first access.
   */
  get eventBridgeOperations(): M3LEventBridgeOperations {
    const cached = this.eventBridgeOperationsWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.eventBridge; // may throw — let it propagate
    const operations = new M3LEventBridgeOperations(client);
    this.eventBridgeOperationsWrapper = operations;
    return operations;
  }

  /**
   * The {@link M3LAthenaClient} wrapper over `clientProvider.athena`,
   * constructed on first access.
   */
  get athena(): M3LAthenaClient {
    const cached = this.athenaWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.athena; // may throw — let it propagate
    const wrapper = new M3LAthenaClient(client);
    this.athenaWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LCloudFormationOperations} wrapper over
   * `clientProvider.cloudFormation`, constructed on first access.
   */
  get cloudFormation(): M3LCloudFormationOperations {
    const cached = this.cloudFormationWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.cloudFormation; // may throw — let it propagate
    const wrapper = new M3LCloudFormationOperations(client);
    this.cloudFormationWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LCloudWatchAlarmsOperations} wrapper over
   * `clientProvider.cloudWatch`, constructed on first access. Shares the
   * same underlying `CloudWatchClient` as `cloudWatchMetrics` — the raw
   * client is constructed exactly once across both getters.
   */
  get cloudWatchAlarms(): M3LCloudWatchAlarmsOperations {
    const cached = this.cloudWatchAlarmsWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.cloudWatch; // may throw — let it propagate
    const wrapper = new M3LCloudWatchAlarmsOperations(client);
    this.cloudWatchAlarmsWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LLogsInsightsClient} wrapper over
   * `clientProvider.cloudWatchLogs`, constructed on first access.
   */
  get cloudWatchLogsInsights(): M3LLogsInsightsClient {
    const cached = this.cloudWatchLogsInsightsWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.cloudWatchLogs; // may throw — let it propagate
    const wrapper = new M3LLogsInsightsClient(client);
    this.cloudWatchLogsInsightsWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LCloudWatchMetricsOperations} wrapper over
   * `clientProvider.cloudWatch`, constructed on first access. Shares the
   * same underlying `CloudWatchClient` as `cloudWatchAlarms` — the raw
   * client is constructed exactly once across both getters.
   */
  get cloudWatchMetrics(): M3LCloudWatchMetricsOperations {
    const cached = this.cloudWatchMetricsWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.cloudWatch; // may throw — let it propagate
    const wrapper = new M3LCloudWatchMetricsOperations(client);
    this.cloudWatchMetricsWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LCodePipelineOperations} wrapper over
   * `clientProvider.codePipeline`, constructed on first access.
   */
  get codePipeline(): M3LCodePipelineOperations {
    const cached = this.codePipelineWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.codePipeline; // may throw — let it propagate
    const wrapper = new M3LCodePipelineOperations(client);
    this.codePipelineWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LECSOperations} wrapper over `clientProvider.ecs`,
   * constructed on first access.
   */
  get ecs(): M3LECSOperations {
    const cached = this.ecsWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.ecs; // may throw — let it propagate
    const wrapper = new M3LECSOperations(client);
    this.ecsWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LEKSOperations} wrapper over `clientProvider.eks`,
   * constructed on first access.
   */
  get eks(): M3LEKSOperations {
    const cached = this.eksWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.eks; // may throw — let it propagate
    const wrapper = new M3LEKSOperations(client);
    this.eksWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LLambdaOperations} wrapper over `clientProvider.lambda`,
   * constructed on first access.
   */
  get lambda(): M3LLambdaOperations {
    const cached = this.lambdaWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.lambda; // may throw — let it propagate
    const wrapper = new M3LLambdaOperations(client);
    this.lambdaWrapper = wrapper;
    return wrapper;
  }

  /**
   * The {@link M3LSecretsManagerOperations} wrapper over
   * `clientProvider.secretsManager`, constructed on first access.
   */
  get secretsManager(): M3LSecretsManagerOperations {
    const cached = this.secretsManagerWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.secretsManager; // may throw — let it propagate
    const wrapper = new M3LSecretsManagerOperations(client);
    this.secretsManagerWrapper = wrapper;
    return wrapper;
  }

  /**
   * The `DynamoDBDocumentClient` for `clientProvider`'s profile — a
   * passthrough to `clientProvider.dynamoDBDocument`. No separate
   * library-owned wrapper class exists for it, so there is nothing new to
   * construct or cache here; it is already memoized on `clientProvider`.
   */
  get dynamoDBDocument(): DynamoDBDocumentClient {
    return this.clientProvider.dynamoDBDocument;
  }

  /**
   * The {@link M3LRequestSigner} for `clientProvider.profile`/
   * `clientProvider.region`, constructed on first access. Not built from a
   * raw `clientProvider` service client, but still reads its `profile`/
   * `region` — the same single source of identity every other getter on
   * this class uses — so it can never authenticate as a different profile
   * than the rest of this provider. It holds no destroyable resource of its
   * own and is cleared — not independently destroyed — by `close()`.
   */
  get requestSigner(): M3LRequestSigner {
    const cached = this.requestSignerClient;
    if (cached !== undefined) return cached;

    const { profile } = this.clientProvider;
    const signer = new M3LRequestSigner({
      region: this.clientProvider.region,
      ...(profile !== undefined && { profile }),
    });
    this.requestSignerClient = signer;
    return signer;
  }

  /**
   * The {@link M3LAWSCredentialsManager} for `clientProvider.profile`/
   * `clientProvider.region`, constructed on first access. Not built from a
   * raw `clientProvider` service client, but still reads its `profile`/
   * `region` — the same single source of identity every other getter on
   * this class uses — so it can never authenticate as a different profile
   * than the rest of this provider. Never touches any AWS SDK client.
   */
  get credentials(): M3LAWSCredentialsManager {
    const cached = this.credentialsManager;
    if (cached !== undefined) return cached;

    const { profile } = this.clientProvider;
    const manager = new M3LAWSCredentialsManager({
      region: this.clientProvider.region,
      ...(profile !== undefined && { profile }),
    });
    this.credentialsManager = manager;
    return manager;
  }

  /**
   * The {@link M3LS3Operations} wrapper over `clientProvider.s3`, constructed
   * on first access.
   */
  get s3Operations(): M3LS3Operations {
    const cached = this.s3OperationsWrapper;
    if (cached !== undefined) return cached;

    const client = this.clientProvider.s3; // may throw — let it propagate
    const operations = new M3LS3Operations(client);
    this.s3OperationsWrapper = operations;
    return operations;
  }

  /**
   * The {@link M3LDynamoDBOperations} wrapper over
   * `clientProvider.dynamoDBDocument`/`clientProvider.dynamoDB`, constructed
   * on first access. Reading `clientProvider.dynamoDBDocument` internally
   * resolves `clientProvider.dynamoDB` too (both already memoized on
   * `clientProvider`), so accessing this getter alongside `dynamoDBDocument`
   * never double-constructs the underlying `DynamoDBClient` or its document
   * wrapper.
   */
  get dynamoDBOperations(): M3LDynamoDBOperations {
    const cached = this.dynamoDBOperationsWrapper;
    if (cached !== undefined) return cached;

    const documentClient = this.clientProvider.dynamoDBDocument; // may throw — let it propagate
    const rawClient = this.clientProvider.dynamoDB;
    const operations = new M3LDynamoDBOperations(documentClient, rawClient);
    this.dynamoDBOperationsWrapper = operations;
    return operations;
  }

  /**
   * Clears every cached wrapper so a later getter access constructs a fresh
   * instance. Unlike `AWSClientProvider.close()`, this **never** calls
   * `.destroy()` on anything and **never** calls `clientProvider.close()`:
   * none of the getters above holds a destroyable resource of its own — each
   * either wraps a client `clientProvider` owns (and destroys), or (for
   * `requestSigner`/`credentials`) holds no destroyable resource at all.
   * `dynamoDBDocument` has no cache of its own to clear, being a passthrough.
   *
   * @example
   * ```ts
   * import { AWSProvider } from "@m3l-automation/m3l-common/aws";
   *
   * const provider = new AWSProvider();
   * void provider.services.athena;
   * provider.services.close();
   * ```
   */
  close(): void {
    this.sqsOperationsWrapper = undefined;
    this.eventBridgeOperationsWrapper = undefined;
    this.athenaWrapper = undefined;
    this.cloudFormationWrapper = undefined;
    this.cloudWatchAlarmsWrapper = undefined;
    this.cloudWatchLogsInsightsWrapper = undefined;
    this.cloudWatchMetricsWrapper = undefined;
    this.codePipelineWrapper = undefined;
    this.ecsWrapper = undefined;
    this.eksWrapper = undefined;
    this.lambdaWrapper = undefined;
    this.secretsManagerWrapper = undefined;
    this.requestSignerClient = undefined;
    this.credentialsManager = undefined;
    this.s3OperationsWrapper = undefined;
    this.dynamoDBOperationsWrapper = undefined;
  }
}
