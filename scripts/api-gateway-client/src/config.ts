import { Core } from "@m3l-automation/m3l-common";

/** The `command` config parameter's finite set of operation modes. */
const API_GATEWAY_CLIENT_COMMANDS = ["request", "batch"] as const;

/** The `auth` config parameter's finite set of authentication modes. */
const API_GATEWAY_CLIENT_AUTH_MODES = ["none", "api-key", "iam"] as const;

/** The `method` config parameter's finite set of HTTP verbs. */
const API_GATEWAY_CLIENT_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
] as const;

const MAX_IN_FLIGHT_MIN = 1;
const MAX_IN_FLIGHT_MAX = 64;
const MAX_IN_FLIGHT_DEFAULT = 4;

/** The `.env`-only alias `apiKey` resolves under, deriving `API_GATEWAY_API_KEY`. */
const API_KEY_ALIAS = "api-gateway-api-key";

/**
 * The declared configuration schema for `api-gateway-client` — the script's
 * only input seam. Never read `process.env` directly (the scripts ESLint
 * zone bans it); declare a parameter here instead so resolution, coercion,
 * validation, and redaction all flow through the library.
 *
 * Per-mode / per-auth requiredness (e.g. `path` for `request` but not
 * `batch`, `apiKey` for `auth: api-key`) is not expressed here as a
 * declarative `M3LConfigParameter({ required: true })` — a single parameter's
 * `validate:` callback cannot express a cross-parameter constraint. See
 * `configValidators` below, which enforces these at config-load time.
 * Every parameter besides `command`/`auth`/`baseUrl`/`method` is declared
 * optional; the selected step guard-checks presence before any HTTP call.
 * See `docs/reference/scripts/api-gateway-client.md` for the full
 * per-mode/per-auth requirement table.
 *
 * Declaring `aws.profile` (`Core.AWS_PROFILE_PARAM_NAME`) is what enables the
 * `script.aws` dynamic-provisioning seam — it is declared globally optional
 * and guard-required only for `auth: iam` (see `resolve-auth-headers.ts`).
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
  }),
  new Core.M3LConfigParameter({
    name: "command",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.oneOf<string>(
      API_GATEWAY_CLIENT_COMMANDS,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "auth",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.oneOf<string>(
      API_GATEWAY_CLIENT_AUTH_MODES,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "baseUrl",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "method",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.oneOf<string>(
      API_GATEWAY_CLIENT_METHODS,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "path",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "body",
    type: Core.M3LConfigParameterType.STRING,
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
    name: "maxInFlight",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: MAX_IN_FLIGHT_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      MAX_IN_FLIGHT_MIN,
      MAX_IN_FLIGHT_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "apiKey",
    type: Core.M3LConfigParameterType.STRING,
    aliases: [API_KEY_ALIAS],
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
  new Core.M3LConfigParameter({
    name: "yesSensitive",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
];

/**
 * Builds an F1b cross-parameter validator enforcing that `paramName` is set
 * whenever `discriminatorName` resolves to exactly `discriminatorValue`.
 */
function requiredWhenEquals(
  paramName: string,
  discriminatorName: string,
  discriminatorValue: string,
): Core.M3LConfigSchemaValidator {
  return (config: Core.M3LConfig): true | string => {
    if (config.get(discriminatorName) !== discriminatorValue) return true;
    return config.get(paramName) === undefined
      ? `'${paramName}' is required when '${discriminatorName}' is '${discriminatorValue}'`
      : true;
  };
}

/**
 * The `api-gateway-client` schema-level cross-parameter validators (F1b) —
 * the declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN `command`/`auth` and
 * the parameter(s) they conditionally require, which no single
 * `M3LConfigParameter` can express on its own:
 *
 * - `path` is only meaningful for `command: request` (`single-request.ts`).
 * - `input` is only meaningful for `command: batch` (`batch-request.ts`).
 * - `apiKey` is only meaningful for `auth: api-key`, and `aws.profile` for
 *   `auth: iam` (both resolved in `resolve-auth-headers.ts`).
 *
 * This SUPPLEMENTS, rather than replaces, the existing run-start
 * `accessor.requiredString(...)`/inline guard checks in `steps/single-request.ts`,
 * `steps/batch-request.ts`, and `steps/resolve-auth-headers.ts`: those calls
 * also narrow `string | undefined` into `string` for typed downstream use,
 * which TypeScript still needs even though presence is now guaranteed
 * earlier by these validators. See `docs/reference/core/config.md`'s
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
  requiredWhenEquals("path", "command", "request"),
  requiredWhenEquals("input", "command", "batch"),
  requiredWhenEquals("apiKey", "auth", "api-key"),
  requiredWhenEquals(Core.AWS_PROFILE_PARAM_NAME, "auth", "iam"),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
