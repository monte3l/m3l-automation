import { Core } from "@m3l-automation/m3l-common";

/**
 * The nine operations `cloudformation-stacks` dispatches over
 * `AWS.M3LCloudFormationOperations`, declared as data (ADR-0055). Feeds
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
export const CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS = [
  {
    name: "list-stacks",
    description: "List stacks in the account, one page per call.",
    requiredParameters: [],
  },
  {
    name: "describe-stack",
    description: "Describe one stack by name or ID.",
    requiredParameters: ["stackName"],
  },
  {
    name: "describe-stack-events",
    description: "List a stack's events, one page per call.",
    requiredParameters: ["stackName"],
  },
  {
    name: "create-stack",
    description: "Create a stack from a JSON input document.",
    requiredParameters: ["input"],
  },
  {
    name: "update-stack",
    description: "Update an existing stack from a JSON input document.",
    requiredParameters: ["input"],
  },
  {
    name: "delete-stack",
    description: "Delete a stack, optionally retaining named resources.",
    requiredParameters: ["stackName"],
  },
  {
    name: "wait-stack-create-complete",
    description: "Wait until a stack finishes creating.",
    requiredParameters: ["stackName"],
  },
  {
    name: "wait-stack-update-complete",
    description: "Wait until a stack finishes updating.",
    requiredParameters: ["stackName"],
  },
  {
    name: "wait-stack-delete-complete",
    description: "Wait until a stack finishes deleting.",
    requiredParameters: ["stackName"],
  },
] as const;

/**
 * The literal union of
 * {@link CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS}' operation names.
 */
type CloudformationStacksOperationName =
  (typeof CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of
 * {@link CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS} — keeps the closed
 * set independently assertable in tests without exercising config
 * resolution.
 */
export const CLOUDFORMATION_STACKS_OPERATIONS: readonly [
  CloudformationStacksOperationName,
  ...(readonly CloudformationStacksOperationName[]),
] = Core.deriveOperationNames(CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS);

/** The `yes` parameter's declared default — the single source of truth `steps/run-cloudformation-stacks.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/** The `yesSensitive` parameter's declared default — the single source of truth `steps/run-cloudformation-stacks.ts` reads at the config-read site too. */
export const YES_SENSITIVE_DEFAULT = false;

/** The `maxWaitTime` parameter's declared `range()` bounds, in seconds. */
const MAX_WAIT_TIME_MIN_SECONDS = 1;
const MAX_WAIT_TIME_MAX_SECONDS = 3600;

/**
 * The declared configuration schema for `cloudformation-stacks` — the
 * script's only input seam. Never read `process.env` directly (the scripts
 * ESLint zone bans it); declare a parameter here instead so resolution,
 * coercion, validation, and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * presence requirements (e.g. `stackName` for `describe-stack`, `input` for
 * `create-stack`/`update-stack`) are declared on
 * {@link CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS} rather than expressed
 * by a single parameter's `validate:` callback — see {@link configValidators}
 * below, which derives and enforces them at config-load time. The separate
 * `template`-vs-`input`-record `templateBody`/`templateUrl` conflict check
 * (`steps/run-cloudformation-stacks.ts`'s `resolveTemplateText`) is a
 * different class of guard — it compares a config parameter against a
 * *parsed input file's contents*, not another config parameter, so
 * `configValidators` (a config-only seam with no filesystem access)
 * structurally cannot express it and it stays a permanent run-start guard.
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
    operations: CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS,
  }),
  new Core.M3LConfigParameter({
    name: "stackName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "template",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "stackStatusFilter",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "retainResources",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "roleArn",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "nextToken",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
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
 * The `cloudformation-stacks` schema-level cross-parameter validators
 * (F1b) — the declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * parameter(s) it conditionally requires, which no single
 * `M3LConfigParameter` can express on its own — the "Required for" column of
 * `docs/reference/scripts/cloudformation-stacks.md`'s configuration table.
 *
 * The per-operation requiredness validators are DERIVED from
 * {@link CLOUDFORMATION_STACKS_OPERATION_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055):
 *
 * - `stackName` is required for `describe-stack`, `describe-stack-events`,
 *   `delete-stack`, and the three `wait-stack-*-complete` operations.
 * - `input` is required for `create-stack`, `update-stack`.
 *
 * This SUPPLEMENTS, rather than replaces, the existing run-start
 * `accessor.requiredFor(...)` guards in `steps/run-cloudformation-stacks.ts`:
 * those calls also narrow `string | undefined` into `string` for typed
 * downstream use, which TypeScript still needs even though presence is now
 * guaranteed earlier by these validators. The separate `template`-vs-
 * `input`-record `templateBody`/`templateUrl` conflict check
 * (`resolveTemplateText`) is deliberately **not** covered here — see the
 * `configParameters` TSDoc above for why. See
 * `docs/reference/core/config.md`'s "Cross-parameter validation" section for
 * the `M3LConfigSchemaValidator` contract these functions satisfy.
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
