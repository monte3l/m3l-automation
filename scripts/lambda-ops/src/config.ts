import { Core } from "@m3l-automation/m3l-common";

/**
 * The seven verbs `lambda-ops` dispatches over `AWS.M3LLambdaOperations`.
 * Declared as a bare `as const` array (rather than inline in the
 * `M3LConfigParameter`'s `oneOf` call) so the closed set is independently
 * assertable in tests without exercising config resolution — the same
 * "bare `as const` + derived union" idiom `scripts/dynamodb-crud/src/config.ts`
 * uses for `DYNAMO_OPERATIONS`.
 */
export const LAMBDA_OPERATIONS = [
  "list",
  "describe",
  "invoke",
  "create",
  "update-code",
  "update-configuration",
  "delete",
] as const;

/** The `yes` parameter's declared default — the single source of truth `steps/run-lambda-ops.ts` reads at the config-read site too. */
export const YES_DEFAULT = false;

/**
 * The declared configuration schema for `lambda-ops` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); declare a parameter here instead so resolution, coercion, validation,
 * and redaction all flow through the library.
 *
 * Only `aws.profile` and `operation` are `required: true`: per-operation
 * presence requirements (e.g. `functionName` for everything but `list`,
 * `zipFilePath` for `create`/`update-code`) are not expressible by a single
 * parameter's `validate:` callback — see {@link configValidators} below,
 * which enforces them at config-load time via F1b's `Core.M3LConfigSchema`
 * cross-parameter validation seam.
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
    validate: Core.M3LConfigValidators.oneOf<string>(LAMBDA_OPERATIONS),
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
];

/** Every operation except `list` — the operations for which `functionName` is required. */
const FUNCTION_NAME_REQUIRING_OPERATIONS = LAMBDA_OPERATIONS.filter(
  (operation) => operation !== "list",
);

/** The operations for which `zipFilePath` is required. */
const ZIP_FILE_PATH_REQUIRING_OPERATIONS = ["create", "update-code"] as const;

/**
 * The operations for which `input` is required. `invoke` deliberately does
 * NOT require `input` — `dispatchInvoke` in `steps/run-lambda-ops.ts` treats
 * a missing `input` as "invoke with an empty payload" rather than an error.
 */
const INPUT_REQUIRING_OPERATIONS = ["create", "update-configuration"] as const;

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
 * The `lambda-ops` schema-level cross-parameter validators (F1b) — the
 * declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `operation` and the
 * per-operation "Required for" parameters, which no single
 * `M3LConfigParameter` can express on its own:
 *
 * - `functionName` is required for every operation EXCEPT `list`.
 * - `zipFilePath` is required for `create`, `update-code`.
 * - `input` is required for `create`, `update-configuration` (optional for
 *   `invoke` — see {@link INPUT_REQUIRING_OPERATIONS}).
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
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { configParameters, configValidators } from "./config.js";
 *
 * const schema = new Core.M3LConfigSchema(configParameters, configValidators);
 * ```
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  requiredForOperations("functionName", FUNCTION_NAME_REQUIRING_OPERATIONS),
  requiredForOperations("zipFilePath", ZIP_FILE_PATH_REQUIRING_OPERATIONS),
  requiredForOperations("input", INPUT_REQUIRING_OPERATIONS),
];
