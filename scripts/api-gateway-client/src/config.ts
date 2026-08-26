import { Core } from "@m3l-automation/m3l-common";

/**
 * The `command` parameter's declared operation set (ADR-0055) — the two
 * modes `api-gateway-client` dispatches over. Feeds {@link configParameters}'
 * `command` declaration, which auto-composes the membership validator,
 * replacing the prior hand-written `oneOf`, and — unlike the sibling
 * declare-only scripts in this cluster — is also consumed by
 * {@link configValidators} via `Core.deriveOperationValidators`: this script
 * already enforced `path`/`input` requiredness at config-load time before
 * this change (`requiredWhenEquals("path", "command", "request")` /
 * `requiredWhenEquals("input", "command", "batch")`), so deriving the same
 * two validators from this declaration instead does not move the failure
 * earlier — it is a like-for-like replacement, not an opt-in.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies Core.M3LOperationDeclarationList` — because a
 * `satisfies` clause on this literal fails `tsc --isolatedDeclarations`
 * (the mode each script's `tsconfig.build.json` builds under). The shape is
 * still fully compile-time-checked at its use site without it: passing this
 * value to `operations:` in `configParameters` checks it against
 * `Core.M3LOperationDeclarationList` — do not re-add `satisfies` here.
 */
const API_GATEWAY_CLIENT_COMMAND_DECLARATIONS = [
  {
    name: "request",
    description:
      "Send one HTTP request against the configured base URL, optionally writing the response to a file.",
    requiredParameters: ["path"],
  },
  {
    name: "batch",
    description:
      "Fan a JSONL file of request-parameter records through a shared request template with bounded concurrency, writing responses and per-request failures to output files.",
    requiredParameters: ["input"],
  },
] as const;

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
 * `configValidators` below, which enforces these at config-load time: the
 * per-`command` pair (`path`/`input`) is derived from
 * {@link API_GATEWAY_CLIENT_COMMAND_DECLARATIONS} via
 * `Core.deriveOperationValidators`, and the per-`auth` pair
 * (`apiKey`/`aws.profile`) stays hand-written via `requiredWhenEquals`, since
 * `auth` is a plain enum, not an ADR-0055 operation selector.
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
    operations: API_GATEWAY_CLIENT_COMMAND_DECLARATIONS,
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
 *
 * Reserved for the `auth`-keyed pairs (`apiKey`⇒`auth: api-key`,
 * `aws.profile`⇒`auth: iam`) — `auth` is a plain enum, not an ADR-0055
 * operation selector, so it has no declaration list for
 * `Core.deriveOperationValidators` to derive from. The `command`-keyed pairs
 * this function previously built (`path`⇒`command: request`,
 * `input`⇒`command: batch`) are now derived instead, from
 * {@link API_GATEWAY_CLIENT_COMMAND_DECLARATIONS}'s `requiredParameters` —
 * do not reintroduce a `requiredWhenEquals("path"|"input", "command", ...)`
 * call, which would duplicate that derived validator.
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
 * - `path` is only meaningful for `command: request` (`single-request.ts`),
 *   and `input` only for `command: batch` (`batch-request.ts`) — both
 *   DERIVED from {@link API_GATEWAY_CLIENT_COMMAND_DECLARATIONS} via
 *   `Core.deriveOperationValidators` (ADR-0055) rather than hand-written; the
 *   derived reason strings read `'path' is required for operation(s): request`
 *   rather than the prior hand-written
 *   `'path' is required when 'command' is 'request'`.
 * - `apiKey` is only meaningful for `auth: api-key`, and `aws.profile` for
 *   `auth: iam` (both resolved in `resolve-auth-headers.ts`) — these stay
 *   hand-written via `requiredWhenEquals`, since `auth` is a plain enum with
 *   no ADR-0055 declaration list to derive from.
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
  ...Core.deriveOperationValidators(configParameters),
  requiredWhenEquals("apiKey", "auth", "api-key"),
  requiredWhenEquals(Core.AWS_PROFILE_PARAM_NAME, "auth", "iam"),
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
