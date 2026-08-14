import { Core } from "@m3l-automation/m3l-common";

import {
  BATCH_SIZE_DEFAULT,
  MIGRATIONS_TABLE_DEFAULT,
  PAGE_SIZE_DEFAULT,
} from "./lib/defaults.js";
import { IDENTIFIER_PATTERN } from "./lib/identifiers.js";

/** Row-chunk size bounds for `load`'s `batchExecuteStatement` calls. */
const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 10_000;

/** Row page size bounds for `query`. `0` issues the statement unpaged. */
const PAGE_SIZE_MIN = 0;
const PAGE_SIZE_MAX = 10_000;

/**
 * The declared configuration schema for `rds-data-sql` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); every input the pipeline needs is declared here so resolution,
 * coercion, validation, and redaction all flow through the library.
 *
 * Mirrors `docs/reference/scripts/rds-data-sql.md`'s "Configuration schema"
 * table exactly (21 parameters, in table order). `aws.profile`, `operation`,
 * `cluster.arn`, `secret.arn`, and `database` are `required: true`, so
 * presence is enforced by the library at config-load time. Declaring
 * `Core.AWS_PROFILE_PARAM_NAME` (`aws.profile`) is the sole trigger for
 * `M3LScript` to provision `script.aws` (stage 5), exposing
 * `script.aws.services.rdsDataOperations`/`script.aws.services.secretsManager`
 * to `main.ts`.
 *
 * The remaining per-operation requirements are cross-parameter constraints a
 * single parameter's `validate:` callback cannot express, so — following the
 * `json-etl` precedent, not `dynamodb-crud`'s run-start guards — they are
 * declared as the ordered, fail-fast {@link configValidators} list below.
 */
export const configParameters: readonly Core.M3LConfigParameter[] = [
  new Core.M3LConfigParameter({
    name: Core.AWS_PROFILE_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: Core.AWS_REGION_PARAM_NAME,
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "operation",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.oneOf([
      "query",
      "load",
      "execute",
      "migrate",
    ]),
  }),
  new Core.M3LConfigParameter({
    name: "cluster.arn",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "secret.arn",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "database",
    type: Core.M3LConfigParameterType.STRING,
    required: true,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "schema",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.regex(IDENTIFIER_PATTERN),
  }),
  new Core.M3LConfigParameter({
    name: "sql",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "sql.file",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "parameters.file",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input.file",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "input.format",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "jsonl",
    validate: Core.M3LConfigValidators.oneOf(["jsonl", "csv"]),
  }),
  new Core.M3LConfigParameter({
    name: "table",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.regex(IDENTIFIER_PATTERN),
  }),
  new Core.M3LConfigParameter({
    name: "columns",
    type: Core.M3LConfigParameterType.STRING_ARRAY,
  }),
  new Core.M3LConfigParameter({
    name: "batch.size",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: BATCH_SIZE_DEFAULT,
    validate: Core.M3LConfigValidators.range(BATCH_SIZE_MIN, BATCH_SIZE_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "page.size",
    type: Core.M3LConfigParameterType.INT,
    defaultValue: PAGE_SIZE_DEFAULT,
    validate: Core.M3LConfigValidators.range(PAGE_SIZE_MIN, PAGE_SIZE_MAX),
  }),
  new Core.M3LConfigParameter({
    name: "output.file",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "output.format",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: "json",
    validate: Core.M3LConfigValidators.oneOf(["json", "jsonl", "csv"]),
  }),
  new Core.M3LConfigParameter({
    name: "migrations.dir",
    type: Core.M3LConfigParameterType.STRING,
    validate: Core.M3LConfigValidators.nonEmpty,
  }),
  new Core.M3LConfigParameter({
    name: "migrations.table",
    type: Core.M3LConfigParameterType.STRING,
    defaultValue: MIGRATIONS_TABLE_DEFAULT,
    validate: Core.M3LConfigValidators.regex(IDENTIFIER_PATTERN),
  }),
  new Core.M3LConfigParameter({
    name: "yes",
    type: Core.M3LConfigParameterType.BOOL,
    defaultValue: false,
  }),
];

/**
 * The `rds-data-sql` schema-level cross-parameter validators — the declared
 * config schema's second validation layer, run once by
 * `Core.M3LConfigSchema.validate` in declaration order (fail-fast) after
 * every parameter in {@link configParameters} has resolved. Per-parameter
 * `required`/`validate` checks already guard each value in isolation; what
 * these validators guard is the relationship BETWEEN values, which no single
 * `M3LConfigParameter` can express on its own. Failure reason strings are
 * quoted verbatim in `docs/reference/scripts/rds-data-sql.md`'s
 * "Configuration schema" section — keep them in sync.
 *
 * 1. `'query'`/`'execute'` require exactly one of `sql`/`sql.file` — a
 *    `sql`/`sql.file` value supplied for `load`/`migrate` is silently
 *    ignored, not an error.
 * 2. `'load'` requires `table` and `input.file` to both be set.
 * 3. `'migrate'` requires `migrations.dir` to be set.
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
  (config: Core.M3LConfig): true | string => {
    const operation = config.get("operation");
    if (operation !== "query" && operation !== "execute") return true;
    const sqlSet = config.get("sql") !== undefined;
    const sqlFileSet = config.get("sql.file") !== undefined;
    return sqlSet !== sqlFileSet
      ? true
      : "'query'/'execute' require exactly one of 'sql' or 'sql.file' to be set";
  },
  (config: Core.M3LConfig): true | string => {
    if (config.get("operation") !== "load") return true;
    const tableSet = config.get("table") !== undefined;
    const inputFileSet = config.get("input.file") !== undefined;
    return tableSet && inputFileSet
      ? true
      : "'load' requires 'table' and 'input.file' to be set";
  },
  (config: Core.M3LConfig): true | string => {
    if (config.get("operation") !== "migrate") return true;
    return config.get("migrations.dir") !== undefined
      ? true
      : "'migrate' requires 'migrations.dir' to be set";
  },
];
