import { Core } from "@m3l-automation/m3l-common";

const WINDOW_MINUTES_MIN = 1;
const WINDOW_MINUTES_MAX = 1440;
const WINDOW_MINUTES_DEFAULT = 60;
const LIMIT_MIN = 1;
const LIMIT_MAX = 10_000;

/**
 * Milliseconds in one second, mirroring `resolve-settings.ts`'s own
 * `MS_PER_SECOND` — kept as a separate local constant (rather than an import)
 * because `config.ts` must not depend on a `steps/` module (wrong dependency
 * direction for a script package); see {@link configValidators}'s TSDoc for
 * why the two files must truncate identically.
 */
const MS_PER_SECOND = 1000;

/**
 * The declared configuration schema for `cloudwatch-logs-insights` — the
 * script's only input seam. Never read `process.env` directly (the scripts
 * ESLint zone bans it); every input the pipeline needs is declared here so
 * resolution, coercion, validation, and redaction all flow through the
 * library.
 *
 * Mirrors `docs/reference/scripts/cloudwatch-logs-insights.md`'s "Configuration schema"
 * table exactly (10 parameters, in table order). `aws.profile`, `logGroups`,
 * `query`, `start`, `end`, and `output` are `required: true` with
 * `Core.M3LConfigValidators.nonEmpty` — a missing value throws
 * `M3LConfigMissingError` and an empty one throws `M3LConfigValidationError`,
 * both at config-load time, before any step runs. `start < end` is a
 * cross-parameter constraint no per-parameter validator can express —
 * {@link configValidators} guards it, also at config-load time. The
 * ISO-8601 parse of `start`/`end` is a format check `resolve-settings.ts`
 * still guards at run start.
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

/**
 * The declared schema-level (F1b, cross-parameter) validators for
 * `cloudwatch-logs-insights` — wired into `main.ts`'s `Core.M3LScript`
 * construction as `config.validate`.
 *
 * `start` and `end` are declared `STRING` parameters with only a `nonEmpty`
 * per-parameter validator (see {@link configParameters}); a per-parameter
 * `validate` never sees a second parameter's value, so the `start < end`
 * ordering constraint can only be expressed here, at the schema level, per
 * `docs/reference/core/config.md`'s "Cross-parameter validation" section.
 *
 * This validator deliberately does **not** attempt to parse an unparseable
 * ISO-8601 `start`/`end` itself — it reads both raw and skips (returns
 * `true`) whenever either value fails `Date.parse`. That parse failure is
 * still caught, later, by `resolve-settings.ts`'s `parseEpochSeconds` guard,
 * which throws `M3LError` coded `"ERR_LOGS_INSIGHTS_SETTINGS"`. Duplicating
 * that check here would mean the same malformed date fails two different
 * ways depending on which layer runs first, with two different codes
 * (`"ERR_CONFIG_VALIDATION"` here vs. `"ERR_LOGS_INSIGHTS_SETTINGS"` there) —
 * so date-format validity stays the sole responsibility of
 * `resolve-settings.ts`, and this validator only ever adjudicates ordering
 * between two dates it can already parse.
 *
 * **The comparison is at second granularity, not millisecond.** Both parsed
 * timestamps are floored to whole seconds — via the exact same
 * `Math.floor(millis / 1000)` truncation `resolve-settings.ts`'s
 * `parseEpochSeconds` applies before either value is used elsewhere in the
 * pipeline — before being compared. Without this floor, a `start`/`end` pair
 * that differs only by sub-second milliseconds could pass here (raw
 * millisecond comparison sees them as ordered) yet floor to the *same* epoch
 * second downstream, producing an effectively empty or inverted query window
 * that this validator exists to reject.
 */
export const configValidators: readonly Core.M3LConfigSchemaValidator[] = [
  (config: Core.M3LConfig): true | string => {
    const start = config.get("start");
    const end = config.get("end");
    if (typeof start !== "string" || typeof end !== "string") {
      return true;
    }

    const startMillis = Date.parse(start);
    const endMillis = Date.parse(end);
    if (Number.isNaN(startMillis) || Number.isNaN(endMillis)) {
      return true;
    }

    const startSeconds = Math.floor(startMillis / MS_PER_SECOND);
    const endSeconds = Math.floor(endMillis / MS_PER_SECOND);

    return startSeconds < endSeconds
      ? true
      : "'start' must be strictly before 'end'";
  },
];
