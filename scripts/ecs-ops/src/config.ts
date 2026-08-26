import { Core } from "@m3l-automation/m3l-common";

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the eight
 * verbs `ecs-ops` dispatches over `AWS.M3LECSOperations`. Feeds
 * {@link configParameters}' `operation` declaration (which auto-composes the
 * membership validator) and {@link Core.deriveOperationValidators}'s per-operation
 * `requiredParameters` derivation below.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies Core.M3LOperationDeclarationList` — because a
 * `satisfies` clause on this literal fails `tsc --isolatedDeclarations`
 * (the mode each script's `tsconfig.build.json` builds under). The shape is
 * still fully compile-time-checked at both use sites without it: passing
 * this value to `Core.deriveOperationNames` below and to `operations:` in
 * `configParameters` each independently check it against
 * `Core.M3LOperationDeclarationList` — do not re-add `satisfies` here.
 */
export const ECS_OPERATION_DECLARATIONS = [
  {
    name: "list-services",
    description: "List a cluster's services, one page per call.",
    requiredParameters: [],
  },
  {
    name: "describe-service",
    description: "Describe one service in a cluster.",
    requiredParameters: ["cluster", "service"],
  },
  {
    name: "create-service",
    description: "Create a service from a JSON input document.",
    requiredParameters: ["input"],
  },
  {
    name: "update-service",
    description: "Update an existing service from a JSON input document.",
    requiredParameters: ["input"],
  },
  {
    name: "delete-service",
    description:
      "Delete a service, optionally forcing deletion without scaling to zero first.",
    requiredParameters: ["cluster", "service"],
  },
  {
    name: "wait-services-stable",
    description: "Wait until the named services reach a stable state.",
    requiredParameters: ["cluster", "services"],
  },
  {
    name: "list-clusters",
    description: "List the account's ECS clusters, one page per call.",
    requiredParameters: [],
  },
  {
    name: "describe-cluster",
    description: "Describe one cluster.",
    requiredParameters: ["cluster"],
  },
] as const;

/** The literal union of {@link ECS_OPERATION_DECLARATIONS}' operation names. */
type EcsOperationName = (typeof ECS_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of {@link ECS_OPERATION_DECLARATIONS} — keeps the
 * closed set independently assertable in tests without exercising config
 * resolution, and preserves the literal union that `steps/run-ecs-ops.ts`'s
 * exhaustive dispatch table depends on.
 */
export const ECS_OPERATIONS: readonly [
  EcsOperationName,
  ...(readonly EcsOperationName[]),
] = Core.deriveOperationNames(ECS_OPERATION_DECLARATIONS);

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
 * `input` for `create-service`/`update-service`) are declared on
 * {@link ECS_OPERATION_DECLARATIONS} rather than expressed by a single
 * parameter's `validate:` callback — see {@link configValidators} below,
 * which derives and enforces them at config-load time via F1b's
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
    operations: ECS_OPERATION_DECLARATIONS,
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

/**
 * The `ecs-ops` schema-level cross-parameter validators (F1b) — the declared
 * config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * per-operation "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own.
 *
 * The per-operation requiredness validators are DERIVED from
 * {@link ECS_OPERATION_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055) rather than hand-written
 * — the derived reason strings are unchanged from the prior hand-written
 * form:
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
 * The `yesSensitive`⇒`yes` validator stays hand-written: it is not
 * per-operation requiredness, but a genuinely cross-parameter constraint
 * between two independently-defaulted BOOL parameters (ADR-0048).
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
  ...Core.deriveOperationValidators(configParameters),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
