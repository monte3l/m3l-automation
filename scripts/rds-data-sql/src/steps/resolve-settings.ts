/**
 * `steps/resolve-settings` — narrows the resolved `rds-data-sql` config into
 * a typed run-settings object.
 *
 * Business logic lives here — never in `main.ts`. Presence/non-emptiness of
 * every required parameter, and each per-parameter validator (including the
 * identifier-pattern checks on `schema`/`table`/`columns`/`migrations.table`),
 * is already enforced by the declared config schema (`config.ts`) at
 * config-load time when a run goes through `M3LScript.getConfiguration()`.
 * This module still defensively re-validates: it owns the per-field type
 * narrowing `Core.M3LConfig#get` cannot express (it returns `unknown`) and
 * re-checks the identifier pattern, since a caller may hand this function an
 * `M3LConfig` built directly (bypassing `M3LConfigParameter` resolution) —
 * the same defensive posture `scripts/athena-query/src/steps/resolve-settings.ts`
 * takes. This step reads (but does not open) `sql.file`/`migrations.dir` as
 * plain path strings — reading their file contents is a later step's job.
 */

import { Core } from "@m3l-automation/m3l-common";

import {
  BATCH_SIZE_DEFAULT,
  MIGRATIONS_TABLE_DEFAULT,
  PAGE_SIZE_DEFAULT,
} from "../lib/defaults.js";
import { validateIdentifier } from "../lib/identifiers.js";

/** The `Core.M3LError` code every `resolveRdsDataSqlSettings` guard throws with. */
const SETTINGS_CODE = "ERR_RDS_DATA_SQL_SETTINGS";

/** The declared literal set backing `operation`, for `Core.M3LConfigAccessor.oneOf`. */
const OPERATIONS = ["query", "load", "execute", "migrate"] as const;

/** The declared literal set backing `input.format`. */
const INPUT_FORMATS = ["jsonl", "csv"] as const;

/** The declared literal set backing `output.format`. */
const OUTPUT_FORMATS = ["json", "jsonl", "csv"] as const;

/**
 * The typed, run-ready settings `run-query`/`run-load`/`run-execute`/
 * `run-migrate` compose against — one field per non-AWS-provisioning
 * `rds-data-sql` config parameter (`aws.profile`/`aws.region` are consumed
 * directly by the `script.aws` provisioning seam, not threaded through this
 * shape). Unset-able values are optional properties, never `| undefined`
 * fields carrying an explicit `undefined`.
 */
export interface RdsDataSqlSettings {
  /** Which of the four operations this run performs. */
  readonly operation: (typeof OPERATIONS)[number];
  /** The Aurora cluster/instance ARN, passed as `resourceArn` to every `aws/rds-data` call. */
  readonly resourceArn: string;
  /** The Secrets Manager ARN holding the database credentials, passed as `secretArn`. */
  readonly secretArn: string;
  /** The target database name. */
  readonly database: string;
  /** Optional schema qualifier, validated against {@link validateIdentifier} when set. */
  readonly schema?: string;
  /** Inline SQL statement for `query`/`execute`. Mutually exclusive with `sqlFile`. */
  readonly sql?: string;
  /** Path (resolved under `M3L_INPUT_DIR`) to a `.sql` file for `query`/`execute`. */
  readonly sqlFile?: string;
  /** Path (resolved under `M3L_INPUT_DIR`) to a JSON file of named `M3LRDSDataParameter`s. */
  readonly parametersFile?: string;
  /** Source file for `load`, resolved under `M3L_INPUT_DIR`. */
  readonly inputFile?: string;
  /** `load`'s importer selector. */
  readonly inputFormat: (typeof INPUT_FORMATS)[number];
  /** Target table for `load`, validated against {@link validateIdentifier} when set. */
  readonly table?: string;
  /** Optional explicit `INSERT` column list for `load`, each validated against {@link validateIdentifier}. */
  readonly columns?: readonly string[];
  /** Row-chunk size for `load`'s `batchExecuteStatement` calls. */
  readonly batchSize: number;
  /** Row page size for `query`; `0` issues the caller's statement unpaged. */
  readonly pageSize: number;
  /** Destination file for `query` results, resolved under `M3L_OUTPUT_DIR`. */
  readonly outputFile?: string;
  /** `query`'s output encoding. */
  readonly outputFormat: (typeof OUTPUT_FORMATS)[number];
  /** Directory (resolved under `M3L_INPUT_DIR`) of `.sql` files applied by `migrate`. */
  readonly migrationsDir?: string;
  /** Table tracking applied migration filenames, validated against {@link validateIdentifier}. */
  readonly migrationsTable: string;
  /** Bypasses the interactive destructive-op confirmation for `execute`. */
  readonly yes: boolean;
  /** Bypasses the escalated typed-echo confirmation for a sensitive target (requires `yes`). */
  readonly yesSensitive: boolean;
}

/**
 * Reads a string parameter defaulting to `defaultValue` when unset, then
 * restricts it to `allowed` — the accessor-level equivalent of `oneOf` with a
 * default, since {@link Core.M3LConfigAccessor.oneOf} has no default-value
 * overload and a directly-built `Core.M3LConfig` (bypassing
 * `M3LConfigParameter` resolution) never applies a declared `defaultValue`.
 */
function oneOfWithDefault<T extends string>(
  accessor: Core.M3LConfigAccessor,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const raw = accessor.optionalString(name);
  if (raw === undefined) return defaultValue;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new Core.M3LError(`'${name}' must be one of: ${allowed.join(", ")}`, {
      code: SETTINGS_CODE,
    });
  }
  return match;
}

/**
 * Resolves and validates the identifier-pattern-bound fields
 * (`schema`/`table`/`columns`/`migrations.table`) — split out of
 * {@link resolveRdsDataSqlSettings} to keep its cyclomatic complexity low.
 */
function resolveIdentifierFields(accessor: Core.M3LConfigAccessor): {
  readonly schema: string | undefined;
  readonly table: string | undefined;
  readonly columns: readonly string[] | undefined;
  readonly migrationsTable: string;
} {
  const schemaRaw = accessor.optionalString("schema");
  const tableRaw = accessor.optionalString("table");
  const columnsRaw = accessor.optionalStringArray("columns");
  const migrationsTableRaw =
    accessor.optionalString("migrations.table") ?? MIGRATIONS_TABLE_DEFAULT;

  return {
    schema:
      schemaRaw === undefined
        ? undefined
        : validateIdentifier(schemaRaw, "schema", SETTINGS_CODE),
    table:
      tableRaw === undefined
        ? undefined
        : validateIdentifier(tableRaw, "table", SETTINGS_CODE),
    columns:
      columnsRaw === undefined
        ? undefined
        : columnsRaw.map((column) =>
            validateIdentifier(column, "columns", SETTINGS_CODE),
          ),
    migrationsTable: validateIdentifier(
      migrationsTableRaw,
      "migrations.table",
      SETTINGS_CODE,
    ),
  };
}

/**
 * Resolves the per-operation, non-identifier-bound fields (`sql`/`sql.file`/
 * `parameters.file`/`input.file`/`input.format`/`batch.size`/`page.size`/
 * `output.file`/`output.format`/`migrations.dir`) — split out of
 * {@link resolveRdsDataSqlSettings} to keep its cyclomatic/line complexity
 * low.
 */
function resolveOperationFields(accessor: Core.M3LConfigAccessor): {
  readonly sql: string | undefined;
  readonly sqlFile: string | undefined;
  readonly parametersFile: string | undefined;
  readonly inputFile: string | undefined;
  readonly inputFormat: (typeof INPUT_FORMATS)[number];
  readonly batchSize: number;
  readonly pageSize: number;
  readonly outputFile: string | undefined;
  readonly outputFormat: (typeof OUTPUT_FORMATS)[number];
  readonly migrationsDir: string | undefined;
} {
  return {
    sql: accessor.optionalString("sql"),
    sqlFile: accessor.optionalString("sql.file"),
    parametersFile: accessor.optionalString("parameters.file"),
    inputFile: accessor.optionalString("input.file"),
    inputFormat: oneOfWithDefault(
      accessor,
      "input.format",
      INPUT_FORMATS,
      "jsonl",
    ),
    batchSize: accessor.numberWithDefault("batch.size", BATCH_SIZE_DEFAULT),
    pageSize: accessor.numberWithDefault("page.size", PAGE_SIZE_DEFAULT),
    outputFile: accessor.optionalString("output.file"),
    outputFormat: oneOfWithDefault(
      accessor,
      "output.format",
      OUTPUT_FORMATS,
      "json",
    ),
    migrationsDir: accessor.optionalString("migrations.dir"),
  };
}

/**
 * Narrows the resolved `rds-data-sql` config into a typed
 * {@link RdsDataSqlSettings}, re-validating every field's type and the
 * identifier-pattern-bound fields' shape.
 *
 * @param config - The resolved configuration store (after `M3LScript`'s
 *   config-load stage has already enforced presence/non-emptiness of every
 *   required parameter, when reached via the normal script lifecycle).
 * @returns The typed run settings.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_SETTINGS"` when a
 *   declared config value resolves to an unexpected type, or an identifier
 *   (`schema`/`table`/an entry of `columns`/`migrations.table`) fails the
 *   `^[A-Za-z_][A-Za-z0-9_]{0,62}$` pattern.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * import { resolveRdsDataSqlSettings } from "./resolve-settings.js";
 *
 * function run(config: Core.M3LConfig): void {
 *   const settings = resolveRdsDataSqlSettings(config);
 *   console.log(settings.operation, settings.resourceArn);
 * }
 * ```
 */
export function resolveRdsDataSqlSettings(
  config: Core.M3LConfig,
): RdsDataSqlSettings {
  const accessor = new Core.M3LConfigAccessor({
    config,
    code: SETTINGS_CODE,
  });

  const operation = accessor.oneOf("operation", OPERATIONS);
  const resourceArn = accessor.requiredString("cluster.arn", "run");
  const secretArn = accessor.requiredString("secret.arn", "run");
  const database = accessor.requiredString("database", "run");
  const { schema, table, columns, migrationsTable } =
    resolveIdentifierFields(accessor);
  const {
    sql,
    sqlFile,
    parametersFile,
    inputFile,
    inputFormat,
    batchSize,
    pageSize,
    outputFile,
    outputFormat,
    migrationsDir,
  } = resolveOperationFields(accessor);
  const yes = accessor.booleanWithDefault("yes", false);
  const yesSensitive = accessor.booleanWithDefault("yesSensitive", false);

  return {
    operation,
    resourceArn,
    secretArn,
    database,
    ...(schema !== undefined && { schema }),
    ...(sql !== undefined && { sql }),
    ...(sqlFile !== undefined && { sqlFile }),
    ...(parametersFile !== undefined && { parametersFile }),
    ...(inputFile !== undefined && { inputFile }),
    inputFormat,
    ...(table !== undefined && { table }),
    ...(columns !== undefined && { columns }),
    batchSize,
    pageSize,
    ...(outputFile !== undefined && { outputFile }),
    outputFormat,
    ...(migrationsDir !== undefined && { migrationsDir }),
    migrationsTable,
    yes,
    yesSensitive,
  };
}
