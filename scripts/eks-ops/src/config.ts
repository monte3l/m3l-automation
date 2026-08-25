import { Core } from "@m3l-automation/m3l-common";

/**
 * The sixteen operations `eks-ops` dispatches over `AWS.M3LEKSOperations`.
 * Declared as a bare `as const` array (rather than inline in the
 * `M3LConfigParameter`'s `oneOf` call) so the closed set is independently
 * assertable in tests without exercising config resolution — the same "bare
 * `as const` + derived union" idiom `CODEPIPELINE_OPS_OPERATIONS`/
 * `ECS_OPERATIONS` use.
 */
export const EKS_OPS_OPERATIONS = [
  "list-clusters",
  "describe-cluster",
  "create-cluster",
  "update-cluster-config",
  "update-cluster-version",
  "delete-cluster",
  "wait-cluster-active",
  "wait-cluster-deleted",
  "list-nodegroups",
  "describe-nodegroup",
  "create-nodegroup",
  "update-nodegroup-config",
  "update-nodegroup-version",
  "delete-nodegroup",
  "wait-nodegroup-active",
  "wait-nodegroup-deleted",
] as const;

/** The `force` parameter's declared default — passed to `update-cluster-version`/`update-nodegroup-version`. */
export const FORCE_DEFAULT = false;

/** The `maxWaitTime` parameter's declared default, in seconds — the single source of truth `steps/run-eks-ops.ts` reads at the config-read site too. */
export const MAX_WAIT_TIME_DEFAULT = 1200;

/** The `yes` parameter's declared default — bypasses the destructive-operation confirmation prompt when `true`. */
export const YES_DEFAULT = false;

/**
 * The `yesSensitive` parameter's declared default — the sensitive-target
 * bypass companion to {@link YES_DEFAULT} (ADR-0048). Only consulted when the
 * resolved `Core.M3LDestructiveTarget` is classified as sensitive; `yes`
 * alone is insufficient to bypass the escalated typed-echo confirmation for
 * a sensitive target.
 */
export const YES_SENSITIVE_DEFAULT = false;

const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 100;
const MAX_WAIT_TIME_MIN = 1;
const MAX_WAIT_TIME_MAX = 3600;

/**
 * The declared configuration schema for `eks-ops` — the script's only input
 * seam. Never read `process.env` directly (the scripts ESLint zone bans it);
 * declare a parameter here instead so resolution, coercion, validation, and
 * redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * presence requirements (e.g. `cluster` for every operation but
 * `list-clusters`, `input` for the four create/update-config operations) are
 * not expressible by a single parameter's `validate:` callback — see
 * {@link configValidators} below, which enforces them at config-load time
 * via F1b's `Core.M3LConfigSchema` cross-parameter validation seam.
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
    validate: Core.M3LConfigValidators.oneOf<string>(EKS_OPS_OPERATIONS),
  }),
  new Core.M3LConfigParameter({
    name: "cluster",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "nodegroup",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "kubernetesVersion",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "releaseVersion",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "force",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: FORCE_DEFAULT,
  }),
  new Core.M3LConfigParameter({
    name: "maxResults",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(MAX_RESULTS_MIN, MAX_RESULTS_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "nextToken",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "include",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "maxWaitTime",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_WAIT_TIME_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_WAIT_TIME_MIN,
      MAX_WAIT_TIME_MAX,
    ),
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

/** Every operation except `list-clusters` — the operations for which `cluster` is required. */
const CLUSTER_REQUIRING_OPERATIONS = EKS_OPS_OPERATIONS.filter(
  (operation) => operation !== "list-clusters",
);

/** The seven nodegroup-scoped operations for which `nodegroup` is required. */
const NODEGROUP_REQUIRING_OPERATIONS = [
  "describe-nodegroup",
  "create-nodegroup",
  "update-nodegroup-config",
  "update-nodegroup-version",
  "delete-nodegroup",
  "wait-nodegroup-active",
  "wait-nodegroup-deleted",
] as const;

/** The operations for which `input` is required. */
const INPUT_REQUIRING_OPERATIONS = [
  "create-cluster",
  "update-cluster-config",
  "create-nodegroup",
  "update-nodegroup-config",
] as const;

/** The single operation for which `kubernetesVersion` is required. */
const KUBERNETES_VERSION_REQUIRING_OPERATIONS = [
  "update-cluster-version",
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
 * The `eks-ops` schema-level cross-parameter validators (F1b) — the declared
 * config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * per-operation "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own:
 *
 * - `cluster` is required for every operation EXCEPT `list-clusters`.
 * - `nodegroup` is required for `describe-nodegroup`, `create-nodegroup`,
 *   `update-nodegroup-config`, `update-nodegroup-version`,
 *   `delete-nodegroup`, `wait-nodegroup-active`, `wait-nodegroup-deleted`.
 * - `input` is required for `create-cluster`, `update-cluster-config`,
 *   `create-nodegroup`, `update-nodegroup-config`.
 * - `kubernetesVersion` is required for `update-cluster-version` only —
 *   optional for every other operation, including `update-nodegroup-version`,
 *   which may bump `releaseVersion` alone.
 *
 * These SUPPLEMENT — not replace — the `accessor.requiredFor(...)` guards
 * `steps/run-eks-ops.ts` still runs at run start: those calls also narrow
 * `string | undefined` into `string` for downstream typed use, which
 * TypeScript needs regardless of when presence is first enforced. Declaring
 * the relationship here moves the *failure* to config-load time (before
 * `steps/run-eks-ops.ts` ever runs) and unifies the error code under the
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
  requiredForOperations("nodegroup", NODEGROUP_REQUIRING_OPERATIONS),
  requiredForOperations("input", INPUT_REQUIRING_OPERATIONS),
  requiredForOperations(
    "kubernetesVersion",
    KUBERNETES_VERSION_REQUIRING_OPERATIONS,
  ),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
