import { Core } from "@m3l-automation/m3l-common";

/**
 * The `operation` parameter's declared operation set (ADR-0055) — the seven
 * verbs `lambda-ops` dispatches over `AWS.M3LLambdaOperations`. Feeds
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
export const LAMBDA_OPERATION_DECLARATIONS = [
  {
    name: "list",
    description: "List the account's Lambda functions, one page per call.",
    requiredParameters: [],
  },
  {
    name: "describe",
    description: "Describe one function's configuration.",
    requiredParameters: ["functionName"],
  },
  {
    name: "invoke",
    description: "Invoke a function, with an optional JSON payload.",
    requiredParameters: ["functionName"],
  },
  {
    name: "create",
    description:
      "Create a function from a zip artifact and a JSON configuration document.",
    requiredParameters: ["functionName", "zipFilePath", "input"],
  },
  {
    name: "update-code",
    description: "Replace a function's code with a zip artifact.",
    requiredParameters: ["functionName", "zipFilePath"],
  },
  {
    name: "update-configuration",
    description:
      "Update a function's configuration from a JSON input document.",
    requiredParameters: ["functionName", "input"],
  },
  {
    name: "delete",
    description: "Delete a function.",
    requiredParameters: ["functionName"],
  },
] as const;

/** The literal union of {@link LAMBDA_OPERATION_DECLARATIONS}' operation names. */
type LambdaOperationName =
  (typeof LAMBDA_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of {@link LAMBDA_OPERATION_DECLARATIONS} — keeps the
 * closed set independently assertable in tests without exercising config
 * resolution, and preserves the literal union that `steps/run-lambda-ops.ts`'s
 * exhaustive dispatch table depends on.
 */
export const LAMBDA_OPERATIONS: readonly [
  LambdaOperationName,
  ...(readonly LambdaOperationName[]),
] = Core.deriveOperationNames(LAMBDA_OPERATION_DECLARATIONS);

/** The `yes` parameter's declared default — the single source of truth `steps/run-lambda-ops.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/** The `yesSensitive` parameter's declared default — the single source of truth `steps/run-lambda-ops.ts` reads at the config-read site too. */
export const YES_SENSITIVE_DEFAULT = false;

/**
 * The declared configuration schema for `lambda-ops` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * presence requirements (e.g. `functionName` for everything but `list`,
 * `zipFilePath` for `create`/`update-code`) are declared on
 * {@link LAMBDA_OPERATION_DECLARATIONS} rather than expressed by a single
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
    operations: LAMBDA_OPERATION_DECLARATIONS,
  }),
  new Core.M3LConfigParameter({
    name: "functionName",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "marker",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "zipFilePath",
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
 * The `lambda-ops` schema-level cross-parameter validators (F1b) — the
 * declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * per-operation "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own.
 *
 * The per-operation requiredness validators are DERIVED from
 * {@link LAMBDA_OPERATION_DECLARATIONS} by
 * {@link Core.deriveOperationValidators} (ADR-0055) rather than hand-written
 * — the derived reason strings are unchanged from the prior hand-written
 * form:
 *
 * - `functionName` is required for every operation EXCEPT `list`.
 * - `zipFilePath` is required for `create`, `update-code`.
 * - `input` is required for `create`, `update-configuration` (deliberately
 *   optional for `invoke` — `dispatchInvoke` in `steps/run-lambda-ops.ts`
 *   treats a missing `input` as "invoke with an empty payload" rather than
 *   an error).
 *
 * These SUPPLEMENT — not replace — the `accessor.requiredFor(...)` guards
 * `steps/run-lambda-ops.ts` still runs at run start: those calls also narrow
 * `string | undefined` into `string` for downstream typed use, which
 * TypeScript needs regardless of when presence is first enforced. Declaring
 * the relationship here moves the *failure* to config-load time (before
 * `steps/run-lambda-ops.ts` ever runs) and unifies the error code under the
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
