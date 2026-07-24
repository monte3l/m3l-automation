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
  readonly operation: WriteOperation;
  readonly input: Record<string, unknown> | undefined;
  readonly cluster: string | undefined;
  readonly service: string | undefined;
  readonly force: boolean;
}

/** Guard-checks `input` present, for `create-service`/`update-service`. */
function requireInput(
  input: Record<string, unknown> | undefined,
  operation: WriteOperation,
): Record<string, unknown> {
  if (input === undefined) {
    throw new Core.M3LError(
      `writeService: 'input' is required for '${operation}'`,
      { code: "ERR_ECS_OPS_CONFIG" },
    );
  }
  return input;
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

/** Reads a required, non-empty string field off an already-parsed `input` object. */
function readRequiredStringField(
  input: Record<string, unknown>,
  fieldName: string,
  operation: WriteOperation,
): string {
  const value = input[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Core.M3LError(
      `writeService: 'input.${fieldName}' must be a non-empty string for '${operation}'`,
      { code: "ERR_ECS_OPS_CONFIG" },
    );
  }
  return value;
}

/** Reads an optional string field off an already-parsed `input` object (`undefined` when absent/wrong type). */
function readOptionalStringField(
  input: Record<string, unknown>,
  fieldName: string,
): string | undefined {
  const value = input[fieldName];
  return typeof value === "string" ? value : undefined;
}

/** Reads an optional number field off an already-parsed `input` object (`undefined` when absent/wrong type). */
function readOptionalNumberField(
  input: Record<string, unknown>,
  fieldName: string,
): number | undefined {
  const value = input[fieldName];
  return typeof value === "number" ? value : undefined;
}

/** Reads an optional boolean field off an already-parsed `input` object (`undefined` when absent/wrong type). */
function readOptionalBooleanField(
  input: Record<string, unknown>,
  fieldName: string,
): boolean | undefined {
  const value = input[fieldName];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Reads the optional `loadBalancers` field off an already-parsed `input`
 * object, trusting each entry's shape as-is (matching
 * `M3LECSOperations.createService`'s own no-pre-flight-validation stance).
 */
function readOptionalLoadBalancers(
  input: Record<string, unknown>,
): readonly AWS.M3LECSLoadBalancer[] | undefined {
  const value = input["loadBalancers"];
  return Array.isArray(value)
    ? (value as readonly AWS.M3LECSLoadBalancer[])
    : undefined;
}

/**
 * Reads the optional `networkConfiguration` field off an already-parsed
 * `input` object, trusting its shape as-is.
 */
function readOptionalNetworkConfiguration(
  input: Record<string, unknown>,
): AWS.M3LECSNetworkConfiguration | undefined {
  const value = input["networkConfiguration"];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as AWS.M3LECSNetworkConfiguration)
    : undefined;
}

/**
 * Narrows an already-parsed `input` record into `M3LECSCreateServiceInput`,
 * guard-checking `cluster`/`serviceName`/`taskDefinition` present and
 * non-empty (the only parts of `input` this module validates; every other
 * field is trusted as-is).
 */
function buildCreateInput(
  input: Record<string, unknown>,
): AWS.M3LECSCreateServiceInput {
  const cluster = readRequiredStringField(input, "cluster", "create-service");
  const serviceName = readRequiredStringField(
    input,
    "serviceName",
    "create-service",
  );
  const taskDefinition = readRequiredStringField(
    input,
    "taskDefinition",
    "create-service",
  );
  const desiredCount = readOptionalNumberField(input, "desiredCount");
  const launchType = readOptionalStringField(input, "launchType");
  const loadBalancers = readOptionalLoadBalancers(input);
  const networkConfiguration = readOptionalNetworkConfiguration(input);

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
  input: Record<string, unknown>,
): AWS.M3LECSUpdateServiceInput {
  const cluster = readRequiredStringField(input, "cluster", "update-service");
  const service = readRequiredStringField(input, "service", "update-service");
  const desiredCount = readOptionalNumberField(input, "desiredCount");
  const taskDefinition = readOptionalStringField(input, "taskDefinition");
  const forceNewDeployment = readOptionalBooleanField(
    input,
    "forceNewDeployment",
  );
  const networkConfiguration = readOptionalNetworkConfiguration(input);

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
 * @param deps - The injected `AWS.M3LECSOperations`, which mutating
 *   operation to run, the already-parsed `input` record (for
 *   `create-service`/`update-service`), and the `cluster`/`service`/`force`
 *   config values (for `delete-service`).
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
 * import { writeService } from "./write-service.js";
 *
 * // `operations` is injected by the caller, e.g.
 * // `new AWS.M3LECSOperations(script.aws.clients.ecs)`.
 * declare const operations: AWS.M3LECSOperations;
 *
 * await writeService({
 *   operations,
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
      const input = requireInput(deps.input, deps.operation);
      return deps.operations.createService(buildCreateInput(input));
    }
    case "update-service": {
      const input = requireInput(deps.input, deps.operation);
      return deps.operations.updateService(buildUpdateInput(input));
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
