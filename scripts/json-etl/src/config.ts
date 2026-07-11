import { Core } from "@m3l-automation/m3l-common";

const LIMIT_MIN = 1;
const LIMIT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * The declared configuration schema for `json-etl` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); every input the pipeline needs is declared here so resolution,
 * coercion, validation, and redaction all flow through the library.
 *
 * `input`, `fields`, and `output` are `required: true` with
 * `Core.M3LConfigValidators.nonEmpty` — a missing value throws
 * `M3LConfigMissingError` and an empty one throws `M3LConfigValidationError`,
 * both at config-load time, before `steps/run-json-etl.ts` ever runs.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: "input",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "fields",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "filters",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
    defaultValue: [],
  }),
  new Core.M3LConfigParameter({
    name: "format",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "json",
    validate: Core.M3LConfigValidators.oneOf(["json", "jsonl", "csv", "html"]),
  }),
  new Core.M3LConfigParameter({
    name: "output",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "limit",
    type: Core.M3LConfigParameterType.INT,
    validate: Core.M3LConfigValidators.range(LIMIT_MIN, LIMIT_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "sort",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.regex(/^[^:]+:(asc|desc)$/),
  }),
  new Core.M3LConfigParameter({
    name: "multiValue",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "join",
    validate: Core.M3LConfigValidators.oneOf(["join", "explode"]),
  }),
];
