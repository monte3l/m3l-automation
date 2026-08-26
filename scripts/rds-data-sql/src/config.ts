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
 * The four operations `rds-data-sql` dispatches, declared as data
 * (ADR-0055). Feeds {@link configParameters}' `operation` declaration (which
 * auto-composes the membership validator) and
 * {@link Core.deriveOperationValidators}'s per-operation `requiredParameters`
 * derivation below.
 *
 * `query`/`execute` declare an EMPTY `requiredParameters`: their real
 * constraint is "exactly one of `sql` or `sql.file`" — an XOR, which
 * `requiredParameters` (a plain presence list) cannot express. That
 * constraint stays a hand-written validator in {@link configValidators}.
 *
 * Deliberately declared with a bare `as const` — NOT
 * `as const satisfies Core.M3LOperationDeclarationList` — because a
 * `satisfies` clause on this literal fails `tsc --isolatedDeclarations`
 * (the mode each script's `tsconfig.build.json` builds under). The shape is
 * still fully compile-time-checked at both use sites without it: passing
 * this value to `Core.deriveOperationNames` below and to `operations:` in
 * `configParameters` each independently check it against
 * `Core.M3LOperationDeclarationList` — do not re-add `satisfies` here.
 */
export const RDS_DATA_SQL_OPERATION_DECLARATIONS = [
  {
    name: "query",
    description:
      "Run a SQL statement, optionally paginated, streaming rows to output.file.",
    requiredParameters: [],
  },
  {
    name: "load",
    description:
      "Import rows from input.file into table via batchExecuteStatement.",
    requiredParameters: ["table", "input.file"],
  },
  {
    name: "execute",
    description:
      "Run a single SQL statement once, gated behind confirmation unless it is a SELECT.",
    requiredParameters: [],
  },
  {
    name: "migrate",
    description:
      "Apply pending .sql files from migrations.dir inside one transaction.",
    requiredParameters: ["migrations.dir"],
  },
] as const;

/** The literal union of {@link RDS_DATA_SQL_OPERATION_DECLARATIONS}' operation names. */
type RdsDataSqlOperationName =
  (typeof RDS_DATA_SQL_OPERATION_DECLARATIONS)[number]["name"];

/**
 * Name-only projection of {@link RDS_DATA_SQL_OPERATION_DECLARATIONS} —
 * keeps the closed set independently assertable in tests without exercising
 * config resolution, and is the single source `steps/resolve-settings.ts`
 * imports for its `Core.M3LConfigAccessor.oneOf` call rather than
 * redeclaring the same four literals.
 */
export const RDS_DATA_SQL_OPERATIONS: readonly [
  RdsDataSqlOperationName,
  ...(readonly RdsDataSqlOperationName[]),
] = Core.deriveOperationNames(RDS_DATA_SQL_OPERATION_DECLARATIONS);

/**
 * The declared configuration schema for `rds-data-sql` — the script's only
 * input seam. Never read `process.env` directly (the scripts ESLint zone bans
 * it); every input the pipeline needs is declared here so resolution,
 * coercion, validation, and redaction all flow through the library.
 *
 * Mirrors `docs/reference/scripts/rds-data-sql.md`'s "Configuration schema"
 * table exactly (22 parameters, in table order). `aws.profile`, `operation`,
 * `cluster.arn`, `secret.arn`, and `database` are `required: true`, so
 * presence is enforced by the library at config-load time. Declaring
 * `Core.AWS_PROFILE_PARAM_NAME` (`aws.profile`) is the sole trigger for
 * `M3LScript` to provision `script.aws` (stage 5), exposing
 * `script.aws.services.rdsDataOperations`/`script.aws.services.secretsManager`
 * to `main.ts`.
 *
 * The remaining per-operation requirements are cross-parameter constraints a
 * single parameter's `validate:` callback cannot express. `load`'s
 * `table`/`input.file` and `migrate`'s `migrations.dir` are declared on
 * {@link RDS_DATA_SQL_OPERATION_DECLARATIONS} and derived by
 * {@link Core.deriveOperationValidators} (ADR-0055); `query`/`execute`'s
 * "exactly one of `sql`/`sql.file`" XOR cannot be expressed that way (it is
 * not a presence list) and stays hand-written — see
 * {@link configValidators} below.
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
    operations: RDS_DATA_SQL_OPERATION_DECLARATIONS,
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
  new Core.M3LConfigParameter({
    name: "yesSensitive",
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
 *    ignored, not an error. Hand-written: this is an XOR, not a presence
 *    list, so {@link Core.deriveOperationValidators} cannot express it.
 * 2. `'table'`/`'input.file'` are each required for `load` — DERIVED from
 *    {@link RDS_DATA_SQL_OPERATION_DECLARATIONS} by
 *    {@link Core.deriveOperationValidators}, emitted as two independent
 *    validators (one per required parameter) rather than the prior single
 *    combined check.
 * 3. `'migrations.dir'` is required for `migrate` — likewise DERIVED.
 * 4. `'yesSensitive'` requires `yes` to also be set — hand-written (a
 *    genuinely cross-parameter constraint between two independently
 *    defaulted `BOOL` parameters, not per-operation requiredness).
 *
 * The derived and hand-written validators never both apply to the same
 * operation (`query`/`execute` carry no `requiredParameters`; `load`/
 * `migrate` never reach the XOR check), so relative order between them is
 * not observable.
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
  (config: Core.M3LConfig): true | string => {
    const operation = config.get("operation");
    if (operation !== "query" && operation !== "execute") return true;
    const sqlSet = config.get("sql") !== undefined;
    const sqlFileSet = config.get("sql.file") !== undefined;
    return sqlSet !== sqlFileSet
      ? true
      : "'query'/'execute' require exactly one of 'sql' or 'sql.file' to be set";
  },
  // requires() would be a no-op here since both yesSensitive and yes carry
  // declared defaults — compare resolved values instead.
  (config: Core.M3LConfig): true | string =>
    config.get("yesSensitive") !== true || config.get("yes") === true
      ? true
      : "'yesSensitive' requires 'yes' to be set",
];
