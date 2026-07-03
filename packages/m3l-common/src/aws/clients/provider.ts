/**
 * `aws/clients/provider` — `AWSClientProvider`, the single-profile, lazily
 * cached AWS SDK v3 client factory.
 *
 * @packageDocumentation
 */

import { APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CodePipelineClient } from "@aws-sdk/client-codepipeline";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EKSClient } from "@aws-sdk/client-eks";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-provider-ini";

import { M3LAWSClientError } from "./error.js";
import { AWS_REGION } from "./region.js";

/**
 * Constructor options for {@link AWSClientProvider}.
 *
 * Exported for reuse by other `aws/clients` submodule files only (e.g. the
 * `AWSProvider` facade forwards its own options verbatim) — it is not
 * re-exported from the `clients` barrel and is not part of the public API.
 */
export interface AWSClientProviderOptions {
  /**
   * Named AWS profile. When set to a non-empty string, credentials resolve
   * via `fromIni({ profile })`. When omitted or an empty string, the SDK
   * default credential chain is used instead.
   */
  readonly profile?: string;
  /**
   * Region passed to every client this provider constructs. Overrides
   * {@link AWS_REGION} when supplied.
   */
  readonly region?: string;
}

/** Union of every service name this provider caches a client for. */
type AWSServiceName =
  | "s3"
  | "dynamoDB"
  | "sts"
  | "eventBridge"
  | "lambda"
  | "ec2"
  | "ecs"
  | "cloudFormation"
  | "codePipeline"
  | "apiGateway"
  | "eks"
  | "cloudWatch"
  | "ssm"
  | "sqs";

/** The subset of an AWS SDK v3 client's shape this provider relies on. */
interface DestroyableClient {
  destroy(): void;
}

/**
 * Base client config shared by every service getter: a resolved `region`
 * and, only when a profile was supplied, resolved `credentials`.
 */
interface BaseClientConfig {
  readonly region: string;
  readonly credentials?: ReturnType<typeof fromIni>;
}

/**
 * Manages AWS SDK v3 clients for a **single** profile, constructing each
 * service client lazily on first access and caching it for the provider's
 * lifetime.
 *
 * Credential resolution is profile-aware: a non-empty `profile` option
 * resolves credentials via `fromIni` (SSO-aware); otherwise the SDK default
 * credential chain applies. Every service-client package is a hard runtime
 * dependency of this library, so all getters are synchronous — no `await`
 * is needed to obtain a client.
 *
 * @example
 * ```ts
 * import { AWSClientProvider } from "@m3l-automation/m3l-common/aws";
 *
 * const provider = new AWSClientProvider({ profile: "my-profile" });
 *
 * // Each client is created lazily on first access and cached thereafter.
 * const s3 = provider.s3;
 * const dynamo = provider.dynamoDB;
 *
 * // Release all cached clients when done.
 * provider.close();
 * ```
 */
export class AWSClientProvider {
  private readonly profile: string | undefined;
  private readonly region: string;
  private readonly cache = new Map<AWSServiceName, DestroyableClient>();

  /**
   * Creates a new `AWSClientProvider`.
   *
   * Construction performs no I/O — no SDK client is built and no
   * credentials are resolved until a service getter is first accessed.
   *
   * @param options - Optional configuration. `region` defaults to
   *   {@link AWS_REGION}; `profile` defaults to the SDK default credential
   *   chain when omitted or an empty string.
   */
  constructor(options: AWSClientProviderOptions = {}) {
    this.profile = options.profile;
    this.region = options.region ?? AWS_REGION;
  }

  /** The `S3Client` for this provider's profile, constructed on first access. */
  get s3(): S3Client {
    return this.getOrConstruct("s3", (config) => new S3Client(config));
  }

  /** The `DynamoDBClient` for this provider's profile, constructed on first access. */
  get dynamoDB(): DynamoDBClient {
    return this.getOrConstruct(
      "dynamoDB",
      (config) => new DynamoDBClient(config),
    );
  }

  /** The `STSClient` for this provider's profile, constructed on first access. */
  get sts(): STSClient {
    return this.getOrConstruct("sts", (config) => new STSClient(config));
  }

  /** The `EventBridgeClient` for this provider's profile, constructed on first access. */
  get eventBridge(): EventBridgeClient {
    return this.getOrConstruct(
      "eventBridge",
      (config) => new EventBridgeClient(config),
    );
  }

  /** The `LambdaClient` for this provider's profile, constructed on first access. */
  get lambda(): LambdaClient {
    return this.getOrConstruct("lambda", (config) => new LambdaClient(config));
  }

  /** The `EC2Client` for this provider's profile, constructed on first access. */
  get ec2(): EC2Client {
    return this.getOrConstruct("ec2", (config) => new EC2Client(config));
  }

  /** The `ECSClient` for this provider's profile, constructed on first access. */
  get ecs(): ECSClient {
    return this.getOrConstruct("ecs", (config) => new ECSClient(config));
  }

  /** The `CloudFormationClient` for this provider's profile, constructed on first access. */
  get cloudFormation(): CloudFormationClient {
    return this.getOrConstruct(
      "cloudFormation",
      (config) => new CloudFormationClient(config),
    );
  }

  /** The `CodePipelineClient` for this provider's profile, constructed on first access. */
  get codePipeline(): CodePipelineClient {
    return this.getOrConstruct(
      "codePipeline",
      (config) => new CodePipelineClient(config),
    );
  }

  /** The `APIGatewayClient` for this provider's profile, constructed on first access. */
  get apiGateway(): APIGatewayClient {
    return this.getOrConstruct(
      "apiGateway",
      (config) => new APIGatewayClient(config),
    );
  }

  /** The `EKSClient` for this provider's profile, constructed on first access. */
  get eks(): EKSClient {
    return this.getOrConstruct("eks", (config) => new EKSClient(config));
  }

  /** The `CloudWatchClient` for this provider's profile, constructed on first access. */
  get cloudWatch(): CloudWatchClient {
    return this.getOrConstruct(
      "cloudWatch",
      (config) => new CloudWatchClient(config),
    );
  }

  /** The `SSMClient` for this provider's profile, constructed on first access. */
  get ssm(): SSMClient {
    return this.getOrConstruct("ssm", (config) => new SSMClient(config));
  }

  /** The `SQSClient` for this provider's profile, constructed on first access. */
  get sqs(): SQSClient {
    return this.getOrConstruct("sqs", (config) => new SQSClient(config));
  }

  /**
   * Destroys every currently-cached client and clears the cache, so a later
   * getter access constructs a fresh instance. Services that were never
   * accessed are untouched.
   *
   * Best-effort-complete and fail-loud: each cached client's `.destroy()` is
   * attempted independently, so one throwing `.destroy()` does not prevent
   * the others from being attempted. The cache is always cleared once the
   * sweep finishes, regardless of whether any `.destroy()` call failed. If
   * one or more calls failed, a single {@link M3LAWSClientError} is thrown
   * after the sweep completes, naming the failing services; its `cause` is
   * the full `{ service, cause }[]` list of failures, so no individual
   * failure is silently dropped.
   *
   * @example
   * ```ts
   * import { AWSClientProvider } from "@m3l-automation/m3l-common/aws";
   *
   * const provider = new AWSClientProvider();
   * void provider.s3;
   * provider.close();
   * ```
   */
  close(): void {
    const failures: { service: AWSServiceName; cause: unknown }[] = [];

    for (const [service, client] of this.cache.entries()) {
      try {
        client.destroy();
      } catch (cause) {
        failures.push({ service, cause });
      }
    }

    this.cache.clear();

    if (failures.length > 0) {
      const services = failures.map((failure) => failure.service).join(", ");
      throw new M3LAWSClientError(
        `failed to destroy AWS SDK client(s) for service(s): ${services}`,
        { cause: failures },
      );
    }
  }

  /**
   * Returns the cached client for `service`, constructing and caching one
   * via `build` on first access. Wraps the entire construct-plus-credential
   * -resolution step in a single typed catch so neither a raw SDK
   * constructor throw nor a `fromIni` failure ever leaks to the caller.
   */
  private getOrConstruct<T extends DestroyableClient>(
    service: AWSServiceName,
    build: (config: BaseClientConfig) => T,
  ): T {
    const cached = this.cache.get(service);
    if (cached !== undefined) {
      return cached as T;
    }

    try {
      const config = this.resolveConfig();
      const client = build(config);
      this.cache.set(service, client);
      return client;
    } catch (cause) {
      throw new M3LAWSClientError(
        `failed to construct AWS SDK client for service '${service}'`,
        { cause },
      );
    }
  }

  /**
   * Resolves the shared client config: `region` always, `credentials` only
   * when a non-empty `profile` was supplied (via `fromIni`). Uses a
   * conditional spread so an empty/undefined profile never passes a
   * `credentials: undefined` key under `exactOptionalPropertyTypes` — it
   * omits the key entirely, letting the SDK default credential chain apply.
   */
  private resolveConfig(): BaseClientConfig {
    const { profile } = this;
    return {
      region: this.region,
      ...(profile !== undefined &&
        profile !== "" && { credentials: fromIni({ profile }) }),
    };
  }
}
