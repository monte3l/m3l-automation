import { Core } from "@m3l-automation/m3l-common";

const WINDOW_MINUTES_MIN = 1;
const WINDOW_MINUTES_MAX = 1440;
const WINDOW_MINUTES_DEFAULT = 60;
const LIMIT_MIN = 1;
const LIMIT_MAX = 10_000;

/**
 * The declared configuration schema for `logs-insights` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); every input the pipeline needs is declared here so resolution,
 * coercion, validation, and redaction all flow through the library.
 *
 * Mirrors `docs/reference/scripts/logs-insights.md`'s "Configuration schema"
 * table exactly (10 parameters, in table order). `aws.profile`, `logGroups`,
 * `query`, `start`, `end`, and `output` are `required: true` with
 * `Core.M3LConfigValidators.nonEmpty` — a missing value throws
 * `M3LConfigMissingError` and an empty one throws `M3LConfigValidationError`,
 * both at config-load time, before any step runs. `start < end` and the
 * ISO-8601 parse of `start`/`end` are cross-parameter/format checks the
 * per-parameter validators cannot express — `resolve-settings.ts` guards
 * those at run start.
 *
 * Declaring `Core.AWS_PROFILE_PARAM_NAME` (`aws.profile`) is the sole
 * trigger for `M3LScript` to provision `script.aws` (stage 5), exposing
 * `script.aws.clients.cloudWatchLogs` to `main.ts`.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "logGroups",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "query",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "start",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "end",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "windowMinutes",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: WINDOW_MINUTES_DEFAULT,
    validate: Core.M3LConfigValidators.range(
      WINDOW_MINUTES_MIN,
      WINDOW_MINUTES_MAX,
    ),
  }),
  new Core.M3LConfigParameter({
    name: "limit",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(LIMIT_MIN, LIMIT_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "format",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "json",
    validate: Core.M3LConfigValidators.oneOf(["json", "csv"]),
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "resume",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
];
