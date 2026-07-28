import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

/** The three mutating operations `writeService` dispatches. */
type WriteOperation = "create-service" | "update-service" | "delete-service";

/**
 * The dependencies `writeService` needs, already resolved by `run-ecs-ops` —
 * `input` arrives as the already-JSON-parsed record for
 * `create-service`/`update-service` (`undefined` for `delete-service`, which
 * reads `cluster`/`service`/`force` from config instead). This step takes no
 * raw `Core.M3LConfig` and never touches `destructive-gate`/`prompt` itself
 * (`run-ecs-ops` gates before ever dispatching here).
 */
interface WriteServiceDeps {
  readonly operations: AWS.M3LECSOperations;
  readonly reader: Core.M3LInputFileReader;
  readonly operation: WriteOperation;
  readonly input: Record<string, unknown> | undefined;
  readonly cluster: string | undefined;
  readonly service: string | undefined;
  readonly force: boolean;
}

/** Guard-checks `value` present, for `delete-service`'s `cluster`/`service` config values. */
function requireString(
  value: string | undefined,
  name: string,
  operation: WriteOperation,
): string {
  if (value === undefined) {
    throw new Core.M3LError(
      `writeService: '${name}' is required for '${operation}'`,
      { code: "ERR_ECS_OPS_CONFIG" },
    );
  }
  return value;
}

/**
 * Narrows an already-parsed `input` record into `M3LECSCreateServiceInput`,
 * guard-checking `cluster`/`serviceName`/`taskDefinition` present and
 * non-empty (the only parts of `input` this module validates; every other
 * field is trusted as-is).
 */
function buildCreateInput(
  reader: Core.M3LInputFileReader,
  input: Record<string, unknown>,
): AWS.M3LECSCreateServiceInput {
  const cluster = reader.requiredStringField(
    input,
    "cluster",
    "create-service",
  );
  const serviceName = reader.requiredStringField(
    input,
    "serviceName",
    "create-service",
  );
  const taskDefinition = reader.requiredStringField(
    input,
    "taskDefinition",
    "create-service",
  );
  const desiredCount = reader.optionalNumberField(input, "desiredCount");
  const launchType = reader.optionalStringField(input, "launchType");
  const loadBalancers = reader.optionalArrayField(input, "loadBalancers") as
    readonly AWS.M3LECSLoadBalancer[] | undefined;
  const networkConfiguration = reader.optionalRecordField(
    input,
    "networkConfiguration",
  ) as AWS.M3LECSNetworkConfiguration | undefined;

  return {
    cluster,
    serviceName,
    taskDefinition,
    ...(desiredCount !== undefined && { desiredCount }),
    ...(launchType !== undefined && { launchType }),
    ...(loadBalancers !== undefined && { loadBalancers }),
    ...(networkConfiguration !== undefined && { networkConfiguration }),
  };
}

/**
 * Narrows an already-parsed `input` record into `M3LECSUpdateServiceInput`,
 * guard-checking `cluster`/`service` present and non-empty (the only parts
 * of `input` this module validates; every other field is trusted as-is).
 */
function buildUpdateInput(
  reader: Core.M3LInputFileReader,
  input: Record<string, unknown>,
): AWS.M3LECSUpdateServiceInput {
  const cluster = reader.requiredStringField(
    input,
    "cluster",
    "update-service",
  );
  const service = reader.requiredStringField(
    input,
    "service",
    "update-service",
  );
  const desiredCount = reader.optionalNumberField(input, "desiredCount");
  const taskDefinition = reader.optionalStringField(input, "taskDefinition");
  const forceNewDeployment = reader.optionalBooleanField(
    input,
    "forceNewDeployment",
  );
  const networkConfiguration = reader.optionalRecordField(
    input,
    "networkConfiguration",
  ) as AWS.M3LECSNetworkConfiguration | undefined;

  return {
    cluster,
    service,
    ...(desiredCount !== undefined && { desiredCount }),
    ...(taskDefinition !== undefined && { taskDefinition }),
    ...(forceNewDeployment !== undefined && { forceNewDeployment }),
    ...(networkConfiguration !== undefined && { networkConfiguration }),
  };
}

/**
 * Runs `ecs-ops`'s three mutating service operations: `create-service`
 * (`operations.createService`), `update-service` (`operations.updateService`),
 * and `delete-service` (`operations.deleteService`). `run-ecs-ops` always
 * routes through `destructive-gate` before dispatching here — this step
 * performs no confirmation of its own.
 *
 * @param deps - The injected `AWS.M3LECSOperations`, the shared
 *   `Core.M3LInputFileReader`, which mutating operation to run, the
 *   already-parsed `input` record (for `create-service`/`update-service`),
 *   and the `cluster`/`service`/`force` config values (for `delete-service`).
 * @returns The updated `M3LECSServiceDescription` for all three operations.
 * @throws {@link Core.M3LError} coded `"ERR_ECS_OPS_CONFIG"` when a required
 *   field for the requested operation is missing: `input` for
 *   `create-service`/`update-service`; within the parsed `input`,
 *   `cluster`/`serviceName`/`taskDefinition` for `create-service` or
 *   `cluster`/`service` for `update-service`; or `cluster`/`service` for
 *   `delete-service`.
 *
 * @example
 * ```typescript
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { Core } from "@m3l-automation/m3l-common";
 * import { writeService } from "./write-service.js";
 *
 * // `operations`/`reader` are injected by the caller, e.g.
 * // `new AWS.M3LECSOperations(script.aws.clients.ecs)`.
 * declare const operations: AWS.M3LECSOperations;
 * declare const reader: Core.M3LInputFileReader;
 *
 * await writeService({
 *   operations,
 *   reader,
 *   operation: "delete-service",
 *   input: undefined,
 *   cluster: "my-cluster",
 *   service: "my-svc",
 *   force: false,
 * });
 * ```
 */
export async function writeService(
  deps: WriteServiceDeps,
): Promise<AWS.M3LECSServiceDescription> {
  switch (deps.operation) {
    case "create-service": {
      const input = deps.reader.requireRecord(
        deps.input,
        "input",
        deps.operation,
      );
      return deps.operations.createService(
        buildCreateInput(deps.reader, input),
      );
    }
    case "update-service": {
      const input = deps.reader.requireRecord(
        deps.input,
        "input",
        deps.operation,
      );
      return deps.operations.updateService(
        buildUpdateInput(deps.reader, input),
      );
    }
    case "delete-service": {
      const cluster = requireString(deps.cluster, "cluster", deps.operation);
      const service = requireString(deps.service, "service", deps.operation);
      return deps.operations.deleteService(cluster, service, deps.force);
    }
    default: {
      const exhaustive: never = deps.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: "ERR_ECS_OPS_CONFIG",
      });
    }
  }
}
