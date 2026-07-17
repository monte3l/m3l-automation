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
 * `batch`, `apiKey` for `auth: api-key`) is not expressed here — the library
 * has no cross-parameter/conditional-required seam yet (F1b, deferred).
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
];
