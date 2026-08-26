import { Core } from "@m3l-automation/m3l-common";

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the
 * sixteen operations `eks-ops` dispatches over `AWS.M3LEKSOperations`. Feeds
 * {@link configParameters}' `operation` declaration (which auto-composes the
 * membership validator) and {@link Core.deriveOperationValidators}'s
 * per-operation `requiredParameters` derivation below.
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
export const EKS_OPS_OPERATION_DECLARATIONS = [
  {
    name: "list-clusters",
    description: "List the EKS clusters in the account, one page per call.",
    requiredParameters: [],
  },
  {
    name: "describe-cluster",
    description: "Describe one cluster.",
    requiredParameters: ["cluster"],
  },
  {
    name: "create-cluster",
    description: "Create a cluster from a JSON input document.",
    requiredParameters: ["cluster", "input"],
  },
  {
    name: "update-cluster-config",
    description: "Update a cluster's configuration from a JSON input document.",
    requiredParameters: ["cluster", "input"],
  },
  {
    name: "update-cluster-version",
    description: "Upgrade a cluster to a target Kubernetes version.",
    requiredParameters: ["cluster", "kubernetesVersion"],
  },
  {
    name: "delete-cluster",
    description: "Delete a cluster.",
    requiredParameters: ["cluster"],
  },
  {
    name: "wait-cluster-active",
    description: "Wait until a cluster becomes ACTIVE.",
    requiredParameters: ["cluster"],
  },
  {
    name: "wait-cluster-deleted",
    description: "Wait until a cluster is fully deleted.",
    requiredParameters: ["cluster"],
  },
  {
    name: "list-nodegroups",
    description: "List a cluster's managed node groups, one page per call.",
    requiredParameters: ["cluster"],
  },
  {
    name: "describe-nodegroup",
    description: "Describe one managed node group.",
    requiredParameters: ["cluster", "nodegroup"],
  },
  {
    name: "create-nodegroup",
    description: "Create a managed node group from a JSON input document.",
    requiredParameters: ["cluster", "nodegroup", "input"],
  },
  {
    name: "update-nodegroup-config",
    description:
      "Update a node group's configuration from a JSON input document.",
    requiredParameters: ["cluster", "nodegroup", "input"],
  },
  {
    name: "update-nodegroup-version",
    description: "Upgrade a node group's Kubernetes or AMI release version.",
    requiredParameters: ["cluster", "nodegroup"],
  },
  {
    name: "delete-nodegroup",
    description: "Delete a managed node group.",
    requiredParameters: ["cluster", "nodegroup"],
  },
  {
    name: "wait-nodegroup-active",
    description: "Wait until a node group becomes ACTIVE.",
    requiredParameters: ["cluster", "nodegroup"],
  },
  {
    name: "wait-nodegroup-deleted",
    description: "Wait until a node group is fully deleted.",
    requiredParameters: ["cluster", "nodegroup"],
  },
] as const;

/** The literal union of {@link EKS_OPS_OPERATION_DECLARATIONS}' operation names. */
type EksOpsOperationName =
  (typeof EKS_OPS_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of {@link EKS_OPS_OPERATION_DECLARATIONS} — keeps the
 * closed set independently assertable in tests without exercising config
 * resolution, and preserves the literal union that `steps/run-eks-ops.ts`'s
 * exhaustive dispatch table depends on.
 */
export const EKS_OPS_OPERATIONS: readonly [
  EksOpsOperationName,
  ...(readonly EksOpsOperationName[]),
] = Core.deriveOperationNames(EKS_OPS_OPERATION_DECLARATIONS);

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
 * declared on {@link EKS_OPS_OPERATION_DECLARATIONS} rather than expressed by
 * a single parameter's `validate:` callback — see {@link configValidators}
 * below, which derives and enforces them at config-load time via F1b's
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
    operations: EKS_OPS_OPERATION_DECLARATIONS,
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

/**
 * The `eks-ops` schema-level cross-parameter validators (F1b) — the declared
 * config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * per-operation "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own.
 *
 * The per-operation requiredness validators are DERIVED from
 * {@link EKS_OPS_OPERATION_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055) rather than hand-written
 * — the derived reason strings are unchanged from the prior hand-written
 * form:
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
