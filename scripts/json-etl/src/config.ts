import { Core } from "@m3l-automation/m3l-common";

import { fieldName } from "./lib/field-spec.js";

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

/** Extracts the field name from an already-validated `"name:asc"`/`"name:desc"` sort value. */
function sortName(value: string): string {
  return value.split(":")[0] ?? value;
}

/**
 * The `json-etl` schema-level cross-parameter validators (F1b) — the
 * declared config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` after every parameter in `configParameters`
 * has resolved. Per-parameter `required`/`validate` checks (see
 * `configParameters` above) already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN values, which no single
 * `M3LConfigParameter` can express on its own:
 *
 * 1. `sort` is only meaningful bounded — an unbounded sort would force
 *    buffering the entire input, so `sort` requires `limit` to be set.
 * 2. `sort`'s name must be one of the output columns declared by `fields` —
 *    a typo'd sort name would otherwise silently no-op the sort instead of
 *    failing fast.
 *
 * Both replace what used to be hand-rolled run-start guards in
 * `steps/run-json-etl.ts`; declaring them here instead moves the failure to
 * config-load time (before `steps/run-json-etl.ts` ever runs) and unifies
 * the error code under the library's `ERR_CONFIG_VALIDATION`. See
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
  (config: Core.M3LConfig): true | string =>
    config.get("sort") === undefined || config.get("limit") !== undefined
      ? true
      : "'sort' requires 'limit' to be set",
  (config: Core.M3LConfig): true | string => {
    const sortRaw = config.get("sort");
    if (typeof sortRaw !== "string") return true;

    const fieldsRaw = config.get("fields");
    if (!Array.isArray(fieldsRaw)) return true;

    const name = sortName(sortRaw);
    const columns = fieldsRaw.map((spec: unknown) => fieldName(String(spec)));
    return columns.includes(name)
      ? true
      : "'sort' name must be one of the 'fields' output columns";
  },
];
