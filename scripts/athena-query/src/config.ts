import { Core } from "@m3l-automation/m3l-common";

/**
 * The declared configuration schema for `athena-query` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); every input the pipeline needs is declared here so resolution,
 * coercion, validation, and redaction all flow through the library.
 *
 * Mirrors `docs/reference/scripts/athena-query.md`'s "Configuration schema"
 * table exactly (10 parameters, in table order). `aws.profile`, `queryString`,
 * and `output` are `required: true` with `Core.M3LConfigValidators.nonEmpty`
 * — a missing value throws `M3LConfigMissingError` and an empty one throws
 * `M3LConfigValidationError`, both at config-load time, before any step runs.
 * Unlike `cloudwatch-logs-insights`, `athena-query` issues a single,
 * non-windowed query, so there are no cross-parameter/format checks beyond
 * what the per-parameter validators already express. `steps/resolve-settings.ts`
 * still narrows the resolved `M3LConfig` into a typed `AthenaQuerySettings`
 * (via `resolveAthenaSettings`), throwing `AthenaSettingsError`
 * (`ERR_ATHENA_SETTINGS`) if a declared value resolves to an unexpected type.
 *
 * Declaring `Core.AWS_PROFILE_PARAM_NAME` (`aws.profile`) is the sole
 * trigger for `M3LScript` to provision `script.aws` (stage 5), exposing
 * `script.aws.clients.athena` to `main.ts`.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "queryString",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "database",
    type: Core.M3LConfigParameterType.STRING,
  }),
  new Core.M3LConfigParameter({
    name: "catalog",
    type: Core.M3LConfigParameterType.STRING,
  }),
  new Core.M3LConfigParameter({
    name: "outputLocation",
    type: Core.M3LConfigParameterType.STRING,
  }),
  new Core.M3LConfigParameter({
    name: "workGroup",
    type: Core.M3LConfigParameterType.STRING,
  }),
  new Core.M3LConfigParameter({
    name: "executionParameters",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
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
