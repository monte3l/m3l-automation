import { Core } from "@m3l-automation/m3l-common";

/**
 * The eight verbs `ecs-ops` dispatches over `AWS.M3LECSOperations`.
 * Declared as a bare `as const` array (rather than inline in the
 * `M3LConfigParameter`'s `oneOf` call) so the closed set is independently
 * assertable in tests without exercising config resolution — the same
 * "bare `as const` + derived union" idiom `scripts/lambda-ops/src/config.ts`
 * uses for `LAMBDA_OPERATIONS`.
 */
export const ECS_OPERATIONS = [
  "list-services",
  "describe-service",
  "create-service",
  "update-service",
  "delete-service",
  "wait-services-stable",
  "list-clusters",
  "describe-cluster",
] as const;

/** The `force` parameter's declared default — the single source of truth `steps/run-ecs-ops.ts` reads at the config-read site too. */
export const FORCE_DEFAULT = false;

/** The `yes` parameter's declared default — the single source of truth `steps/run-ecs-ops.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/** The `yesSensitive` parameter's declared default — the single source of truth `steps/run-ecs-ops.ts` reads at the config-read site too. */
export const YES_SENSITIVE_DEFAULT = false;

/** The `maxWaitTime` parameter's declared `range()` bounds, in seconds. */
const MAX_WAIT_TIME_MIN_SECONDS = 1;
const MAX_WAIT_TIME_MAX_SECONDS = 3600;

/**
 * The declared configuration schema for `ecs-ops` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * presence requirements (e.g. `cluster`/`service` for `describe-service`,
 * `input` for `create-service`/`update-service`) are not expressible by a
 * single parameter's `validate:` callback — see {@link configValidators}
 * below, which enforces them at config-load time via F1b's
 * `Core.M3LConfigSchema` cross-parameter validation seam.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "operation",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.oneOf<string>(ECS_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: "cluster",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "service",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "services",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "nextToken",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "force",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: FORCE_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "maxWaitTime",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(
      MAX_WAIT_TIME_MIN_SECONDS,
      MAX_WAIT_TIME_MAX_SECONDS,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: YES_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "yesSensitive",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: YES_SENSITIVE_DEFAULT,
  }),
];

/** The operations for which `cluster` is required (docs/reference/scripts/ecs-ops.md § Configuration schema). */
const CLUSTER_REQUIRING_OPERATIONS = [
  "describe-service",
  "delete-service",
  "wait-services-stable",
  "describe-cluster",
] as const;

/** The operations for which `service` is required. */
const SERVICE_REQUIRING_OPERATIONS = [
  "describe-service",
  "delete-service",
] as const;

/** The operations for which `services` is required. */
const SERVICES_REQUIRING_OPERATIONS = ["wait-services-stable"] as const;

/** The operations for which `input` is required. */
const INPUT_REQUIRING_OPERATIONS = [
  "create-service",
  "update-service",
] as const;

/** True when `value` is a string present in `operations` — narrows `unknown` without an `as` assertion. */
function isOneOf(value: unknown, operations: readonly string[]): boolean {
  return typeof value === "string" && operations.includes(value);
}

/**
 * Builds a schema-level validator asserting `paramName` is set whenever
 * `config`'s `operation` is one of `requiringOperations`. The failure reason
 * names only the fixed operation list (a constraint description), never the
 * received `operation`/`paramName` value.
 */
function requiredForOperations(
  paramName: string,
  requiringOperations: readonly string[],
): Core.M3LConfigSchemaValidator {
  return (config: Core.M3LConfig): true | string => {
    const requires =
      isOneOf(config.get("operation"), requiringOperations) &&
      config.get(paramName) === undefined;
    return requires
      ? `'${paramName}' is required for operation(s): ${requiringOperations.join(", ")}`
      : true;
  };
}

/**
 * The `ecs-ops` schema-level cross-parameter validators (F1b) — the declared
 * config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * per-operation "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own:
 *
 * - `cluster` is required for `describe-service`, `delete-service`,
 *   `wait-services-stable`, `describe-cluster`.
 * - `service` is required for `describe-service`, `delete-service`.
 * - `services` is required for `wait-services-stable`.
 * - `input` is required for `create-service`, `update-service`.
 *
 * These SUPPLEMENT — not replace — the `accessor.requiredFor(...)` guards
 * `steps/run-ecs-ops.ts` still runs at run start: those calls also narrow
 * `string | undefined` into `string` for downstream typed use, which
 * TypeScript needs regardless of when presence is first enforced. Declaring
 * the relationship here moves the *failure* to config-load time (before
 * `steps/run-ecs-ops.ts` ever runs) and unifies the error code under the
 * library's `ERR_CONFIG_VALIDATION`. See `docs/reference/core/config.md`'s
 * "Cross-parameter validation" section for the `M3LConfigSchemaValidator`
 * contract these functions satisfy.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { configParameters, configValidators } from "./config.js";
 *
 * const schema = new Core.M3LConfigSchema(configParameters, configValidators);
 * ```
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  requiredForOperations("cluster", CLUSTER_REQUIRING_OPERATIONS),
  requiredForOperations("service", SERVICE_REQUIRING_OPERATIONS),
  requiredForOperations("services", SERVICES_REQUIRING_OPERATIONS),
  requiredForOperations("input", INPUT_REQUIRING_OPERATIONS),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
