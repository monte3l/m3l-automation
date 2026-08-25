/**
 * `steps/build-operation-deps` — composes the single per-operation
 * dependency bag `run-rds-data-sql` dispatches into.
 *
 * Business logic lives here — never in `main.ts`. Based on
 * `settings.operation`, builds ONLY the one matching `Run*Deps` bag
 * (`query`/`load`/`execute`/`migrate`), never all four — avoiding an
 * unneeded file read/parse for the three operations not selected this run.
 * See `docs/reference/scripts/rds-data-sql.md`'s per-step rows for the
 * per-operation composition rules this module implements.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Core, type AWS } from "@m3l-automation/m3l-common";

import { qualifyIdentifier } from "../lib/identifiers.js";
import {
  coerceRdsDataValueForOutput,
  type RdsDataSqlOutputFormat,
} from "./export-results.js";
import type { RdsDataSqlSettings } from "./resolve-settings.js";
import type { RunExecuteDeps } from "./run-execute.js";
import type { RunLoadCheckpoint, RunLoadDeps } from "./run-load.js";
import type { RunMigrateDeps, RunMigrateFile } from "./run-migrate.js";
import type { RunQueryCheckpoint, RunQueryDeps } from "./run-query.js";

/**
 * The `Core.M3LError` code {@link buildOperationDeps} throws with on any
 * file-read/parse failure, or when a cross-parameter requirement
 * `resolve-settings.ts`/`config.ts`'s validators don't already enforce
 * (`query`'s `output.file`) is missing.
 */
const BUILD_DEPS_CODE = "ERR_RDS_DATA_SQL_INPUT_FILE";

/** {@link AWS.M3LRDSDataParameter.typeHint}'s declared literal set, mirrored to validate a `parameters.file`-sourced value. */
const TYPE_HINTS: ReadonlySet<string> = new Set([
  "DATE",
  "DECIMAL",
  "JSON",
  "TIME",
  "TIMESTAMP",
  "UUID",
]);

/** Injected dependencies for {@link buildOperationDeps}. */
export interface BuildOperationDepsDeps {
  /** The resolved, typed run settings. */
  readonly settings: RdsDataSqlSettings;
  /** The provisioned RDS Data API operations wrapper. */
  readonly rdsData: AWS.M3LRDSDataOperations;
  /** The prompt facade forwarded to `execute`'s destructive-op gate. */
  readonly prompt: Core.M3LPrompt;
  /** The run's `M3LPaths` instance, resolving `sql.file`/`parameters.file`/`input.file`/`migrations.dir`/`output.file`. */
  readonly paths: Core.M3LPaths;
  /** The run's correlated logger. */
  readonly logger: Core.M3LLogger;
  /**
   * Forwarded into `load`'s deps bag only — `load` is the one operation that
   * absorbs per-row failures rather than throwing, so it's the only one that
   * needs to report them to the run's recovery ledger.
   */
  readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
  /**
   * This run's resolved AWS identity, forwarded to `execute`'s
   * `Core.confirmDestructive` gate as `target` (ADR-0048).
   */
  readonly awsTarget: Core.M3LDestructiveTarget;
}

/**
 * The single per-operation deps bag {@link buildOperationDeps} resolves —
 * exactly one property is ever set, matching `settings.operation`.
 */
export interface RdsDataSqlOperationDeps {
  /** `runQuery`'s deps bag; set only when `settings.operation` is `"query"`. */
  readonly query?: RunQueryDeps;
  /** `runLoad`'s deps bag; set only when `settings.operation` is `"load"`. */
  readonly load?: RunLoadDeps;
  /** `runExecute`'s deps bag; set only when `settings.operation` is `"execute"`. */
  readonly execute?: RunExecuteDeps;
  /** `runMigrate`'s deps bag; set only when `settings.operation` is `"migrate"`. */
  readonly migrate?: RunMigrateDeps;
}

/**
 * Resolves `query`/`execute`'s statement text: `settings.sql` verbatim, or
 * `settings.sqlFile`'s content read via `paths.resolveInput`.
 *
 * @throws {@link Core.M3LError} coded `BUILD_DEPS_CODE` when both are unset
 *   (defensive — `config.ts`'s cross-parameter validator already prevents
 *   this through the normal script lifecycle) or the file cannot be read.
 */
async function resolveSql(
  paths: Core.M3LPaths,
  settings: Pick<RdsDataSqlSettings, "sql" | "sqlFile">,
): Promise<string> {
  if (settings.sql !== undefined) return settings.sql;
  if (settings.sqlFile === undefined) {
    throw new Core.M3LError(
      "'sql'/'sql.file' were both unset when building operation deps",
      { code: BUILD_DEPS_CODE },
    );
  }
  const resolvedPath = paths.resolveInput(settings.sqlFile);
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (cause) {
    throw new Core.M3LError(`failed to read sql.file at '${resolvedPath}'`, {
      code: BUILD_DEPS_CODE,
      cause,
    });
  }
}

/** Narrows a JSON-parsed value to {@link AWS.M3LRDSDataValue}'s discriminated shape. */
function isRdsDataValue(value: unknown): value is AWS.M3LRDSDataValue {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  switch (raw["kind"]) {
    case "null":
      return true;
    case "string":
      return typeof raw["value"] === "string";
    case "long":
    case "double":
      return typeof raw["value"] === "number";
    case "boolean":
      return typeof raw["value"] === "boolean";
    case "blob":
      return raw["value"] instanceof Uint8Array;
    default:
      return false;
  }
}

/** Narrows a JSON-parsed value to {@link AWS.M3LRDSDataParameter}'s shape. */
function isRdsDataParameter(value: unknown): value is AWS.M3LRDSDataParameter {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (!Object.hasOwn(raw, "name") || typeof raw["name"] !== "string") {
    return false;
  }
  if (!Object.hasOwn(raw, "value") || !isRdsDataValue(raw["value"])) {
    return false;
  }
  if (!Object.hasOwn(raw, "typeHint")) return true;
  const typeHint = raw["typeHint"];
  return typeof typeHint === "string" && TYPE_HINTS.has(typeHint);
}

/** Narrows a JSON-parsed value to a `readonly AWS.M3LRDSDataParameter[]`. */
function isRdsDataParameterArray(
  value: unknown,
): value is readonly AWS.M3LRDSDataParameter[] {
  return Array.isArray(value) && value.every(isRdsDataParameter);
}

/**
 * Resolves `query`/`execute`'s named parameter set: `[]` when
 * `parametersFile` is unset, otherwise its JSON content, parsed and
 * validated against {@link AWS.M3LRDSDataParameter}'s shape.
 *
 * @throws {@link Core.M3LError} coded `BUILD_DEPS_CODE` when the file cannot
 *   be read, is not valid JSON, or does not hold an array of named RDS Data
 *   API parameters.
 */
async function resolveParameters(
  paths: Core.M3LPaths,
  parametersFile: string | undefined,
): Promise<readonly AWS.M3LRDSDataParameter[]> {
  if (parametersFile === undefined) return [];
  const resolvedPath = paths.resolveInput(parametersFile);

  let raw: string;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (cause) {
    throw new Core.M3LError(
      `failed to read parameters.file at '${resolvedPath}'`,
      { code: BUILD_DEPS_CODE, cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never chain the raw SyntaxError: parameters.file may hold sensitive
    // bind values, and V8's SyntaxError message can embed a content snippet.
    throw new Core.M3LError(
      `parameters.file at '${resolvedPath}' is not valid JSON`,
      { code: BUILD_DEPS_CODE },
    );
  }

  if (!isRdsDataParameterArray(parsed)) {
    throw new Core.M3LError(
      `parameters.file at '${resolvedPath}' must be an array of named RDS Data API parameters`,
      { code: BUILD_DEPS_CODE },
    );
  }
  return parsed;
}

/** Narrows a value to a `readonly string[]`, or accepts `undefined`. */
function isOptionalStringArray(
  value: unknown,
): value is readonly string[] | undefined {
  if (value === undefined) return true;
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * Whether `candidate[field]` is a safe, non-negative integer, when present —
 * a no-op (`true`) when the field is absent.
 *
 * Every numeric checkpoint field this step validates either gates a byte
 * offset a writer resumes appending from (`outputBytes`/`failedOutputBytes`)
 * or drives a direct numeric comparison against an in-progress run's own
 * counter (`offset`, `chunkIndex`, `recordsProcessed`, `failedCount` — e.g.
 * `run-load.ts`'s `flushChunk`'s `chunkIndex <= resumeFromChunkIndex` and
 * `consumeImportStream`'s `recordsProcessed < resumeFromRecordCount`). A bare
 * `typeof … === "number"` check (the prior shape here) accepts `NaN`,
 * `±Infinity`, non-integers, and negatives — a `NaN` in particular makes
 * every comparison built from it evaluate `false`, silently disabling the
 * resume-skip and reprocessing/duplicating already-handled work with zero
 * error. `Number.isSafeInteger` rejects all of those; `>= 0` additionally
 * rejects a negative offset/index, which can never be a legitimate resume
 * position.
 */
function isOptionalSafeIntegerField(
  candidate: Record<string, unknown>,
  field: string,
): boolean {
  if (!Object.hasOwn(candidate, field)) return true;
  const value = candidate[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `candidate`'s `a` and `b` fields are both present or both absent —
 * never exactly one.
 *
 * A checkpoint that carries a byte-length field's numeric correlate
 * (`outputBytes`/`failedOutputBytes`) without the offset/index field it
 * describes (or vice versa) is malformed: within this version, every
 * checkpoint write always sets both together, so a checkpoint carrying only
 * one is either corrupted or was written by a pre-resume-redesign version of
 * this step (the old shape paired `offset` with `rows`, never `outputBytes`).
 * Accepting it would silently open the resumed writer at byte `0` (truncating
 * the output file) while still advancing the other field forward — the exact
 * data-loss class this step's resume redesign exists to close. Rejecting it
 * here surfaces a loud, typed `M3LCheckpointError` from
 * `Core.M3LCheckpointStore.read()` instead.
 */
function fieldsCoOccur(
  candidate: Record<string, unknown>,
  a: string,
  b: string,
): boolean {
  return Object.hasOwn(candidate, a) === Object.hasOwn(candidate, b);
}

/** Narrows a checkpoint file's parsed content to {@link RunQueryCheckpoint}. */
function isRunQueryCheckpoint(value: unknown): value is RunQueryCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!isOptionalSafeIntegerField(candidate, "offset")) return false;
  if (!isOptionalSafeIntegerField(candidate, "outputBytes")) return false;
  if (!fieldsCoOccur(candidate, "offset", "outputBytes")) return false;
  return isOptionalStringArray(candidate["columns"]);
}

/**
 * Narrows a checkpoint file's parsed content to {@link RunLoadCheckpoint}.
 *
 * Unlike {@link isRunQueryCheckpoint}'s single `offset`⟺`outputBytes` pair,
 * `RunLoadCheckpoint` has THREE fields that all gate resume behavior
 * together: `chunkIndex`, `failedOutputBytes`, AND `recordsProcessed`. All
 * three must co-occur — any one present without the other two is rejected.
 * `fieldsCoOccur` is pairwise, but presence-equality is transitive: chaining
 * `chunkIndex`⟺`failedOutputBytes` with `chunkIndex`⟺`recordsProcessed`
 * forces all three into lockstep without a dedicated 3-way helper. A
 * checkpoint missing just `recordsProcessed` would otherwise pass, and on
 * resume `run-load.ts`'s `resumeFromRecordCount` would silently default to
 * `0`, re-classifying already-handled records and re-inserting already-
 * committed chunks with zero error.
 */
function isRunLoadCheckpoint(value: unknown): value is RunLoadCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!isOptionalSafeIntegerField(candidate, "chunkIndex")) return false;
  if (!isOptionalSafeIntegerField(candidate, "failedOutputBytes")) return false;
  if (!isOptionalSafeIntegerField(candidate, "recordsProcessed")) return false;
  if (!fieldsCoOccur(candidate, "chunkIndex", "failedOutputBytes"))
    return false;
  if (!fieldsCoOccur(candidate, "chunkIndex", "recordsProcessed")) return false;
  return isOptionalSafeIntegerField(candidate, "failedCount");
}

/** The resume-seam args {@link createQueryExporter} threads into the constructed exporter. */
interface QueryExporterResumeArgs {
  /** The byte offset the returned exporter's stream writer should resume appending from (`0` for a fresh export). */
  readonly resumeFromByte: number;
  /** The output column list — forwarded only to the `csv` branch (the `json`/`jsonl` options types have no `columns` field). */
  readonly columns: readonly string[] | undefined;
}

/** Builds the format-selected exporter class for `query`'s `output.format`, forwarding `resume`'s byte offset (and, for CSV, its columns) into the exporter's construction options. */
function createQueryExporter(
  format: RdsDataSqlOutputFormat,
  outputPath: string,
  resume: QueryExporterResumeArgs,
): Core.M3LListExporter<Record<string, unknown>> {
  switch (format) {
    case "json":
      return new Core.M3LJSONListExporter<Record<string, unknown>>({
        filePath: outputPath,
        format: "array",
        resumeFromByte: resume.resumeFromByte,
      });
    case "jsonl":
      return new Core.M3LJSONListExporter<Record<string, unknown>>({
        filePath: outputPath,
        format: "jsonl",
        resumeFromByte: resume.resumeFromByte,
      });
    case "csv":
      return new Core.M3LCSVListExporter<Record<string, unknown>>({
        filePath: outputPath,
        resumeFromByte: resume.resumeFromByte,
        ...(resume.columns !== undefined && { columns: resume.columns }),
      });
    default: {
      const exhaustive: never = format;
      throw new Core.M3LError(
        `unhandled output.format: ${String(exhaustive)}`,
        { code: BUILD_DEPS_CODE },
      );
    }
  }
}

/** Coerces one result row into `query`'s output record, keyed by column name. */
function toOutputRecord(
  columns: readonly AWS.M3LRDSDataColumn[],
  row: readonly AWS.M3LRDSDataValue[],
  format: RdsDataSqlOutputFormat,
): Record<string, unknown> {
  // Null-prototype base: a result column literally named `__proto__` must
  // become a normal own property, not silently vanish into the object's
  // prototype setter. This makes `output.format: json`/`jsonl` round-trip
  // correctly (`JSON.stringify` reads own-enumerable keys, which a
  // null-prototype object still has). `output.format: csv` is NOT covered:
  // `M3LCSVListExporter` re-materializes each row into a plain `{}`
  // internally, so a `__proto__`/`constructor`/`prototype`-named column
  // still loses its value there — a library-level limitation out of this
  // script's control.
  const record: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  columns.forEach((column, index) => {
    const value = row[index];
    if (value !== undefined) {
      record[column.name] = coerceRdsDataValueForOutput(value, format);
    }
  });
  return record;
}

/**
 * Projects a resolved parameter set down to its name/kind/typeHint shape for
 * the checkpoint `definition` — never the bind `value` itself.
 * `docs/reference/core/checkpoint.md` requires a `definition` be free of
 * secrets/credentials because the fingerprint is an unkeyed hash (a
 * low-entropy value is brute-forceable); a bind value is caller-supplied
 * data, not run shape, so it belongs in that same excluded category. The
 * name/kind/typeHint triple still fingerprints a parameter-set shape change
 * (added/removed/retyped parameter) without embedding what was bound.
 */
function projectParameterShape(
  parameters: readonly AWS.M3LRDSDataParameter[],
): readonly Record<string, unknown>[] {
  return parameters.map((parameter) => ({
    name: parameter.name,
    kind: parameter.value.kind,
    ...(parameter.typeHint !== undefined && {
      typeHint: parameter.typeHint,
    }),
  }));
}

/** Builds `query`'s deps bag — split out of {@link buildOperationDeps} to keep its complexity low. */
async function buildQueryDeps(
  deps: BuildOperationDepsDeps,
): Promise<RunQueryDeps> {
  const { settings, rdsData, paths, logger } = deps;
  if (settings.outputFile === undefined) {
    throw new Core.M3LError("'query' requires 'output.file' to be set", {
      code: BUILD_DEPS_CODE,
    });
  }

  const sql = await resolveSql(paths, settings);
  const parameters = await resolveParameters(paths, settings.parametersFile);
  const checkpoint = new Core.M3LCheckpointStore<RunQueryCheckpoint>({
    paths,
    name: "query",
    validate: isRunQueryCheckpoint,
    missing: { kind: "empty", value: {} },
    // Fingerprints the run's shape so a leftover checkpoint from a
    // differently-configured prior run throws ERR_CHECKPOINT_FINGERPRINT_MISMATCH
    // on read() instead of silently being reused. `secretArn` (a rotatable
    // credential locator) is deliberately excluded — the fingerprint is an
    // unkeyed hash, not a secret store. `sql`/`parameters` are the RESOLVED
    // values (already read from `sqlFile`/`parametersFile`), not the raw
    // settings, since a file's on-disk contents can change under a fixed
    // path. `parameters` is further projected to name/kind/typeHint via
    // `projectParameterShape` — the raw bind values are caller-supplied
    // data, not run shape, and would put a low-entropy secret into an
    // unkeyed hash (`docs/reference/core/checkpoint.md`'s definition rule).
    // `pageSize` is excluded as non-meaning-bearing on its own — only
    // its `paged` boolean (whether pagination is active at all) matters.
    // Unlike the other three consumer scripts' definitions, `aws.profile`
    // is deliberately not included here: `resourceArn` already embeds the
    // AWS account id and region, so it strictly dominates the profile as an
    // account binding — a profile resolving to a different account cannot
    // silently reach the same cluster ARN.
    definition: {
      resourceArn: settings.resourceArn,
      database: settings.database,
      ...(settings.schema !== undefined && { schema: settings.schema }),
      sql,
      parameters: projectParameterShape(parameters),
      outputFile: settings.outputFile,
      outputFormat: settings.outputFormat,
      paged: settings.pageSize > 0,
    },
  });
  const outputFormat = settings.outputFormat;
  const outputPath = paths.resolveOutput(settings.outputFile);

  return {
    rdsData,
    resourceArn: settings.resourceArn,
    secretArn: settings.secretArn,
    database: settings.database,
    ...(settings.schema !== undefined && { schema: settings.schema }),
    sql,
    parameters,
    pageSize: settings.pageSize,
    checkpoint,
    // Deferred, not eagerly opened: a CSV resume's `columns` (its header)
    // is only known once the caller has read its own checkpoint, so
    // `runQuery` itself calls this once it has that value in hand.
    createWriter: (args) =>
      createQueryExporter(outputFormat, outputPath, args).exportStream(),
    toRecord: (columns, row) => toOutputRecord(columns, row, outputFormat),
    logger,
  };
}

/** Builds the format-selected importer class for `load`'s `input.format`. */
function createLoadImporter(
  format: RdsDataSqlSettings["inputFormat"],
): Core.M3LListImporter<Record<string, unknown>> {
  switch (format) {
    case "jsonl":
      return new Core.M3LJSONListImporter<Record<string, unknown>>({});
    case "csv":
      return new Core.M3LCSVListImporter<Record<string, unknown>>({});
    default: {
      const exhaustive: never = format;
      throw new Core.M3LError(`unhandled input.format: ${String(exhaustive)}`, {
        code: BUILD_DEPS_CODE,
      });
    }
  }
}

/** Builds `load`'s deps bag — split out of {@link buildOperationDeps} to keep its complexity low. */
function buildLoadDeps(deps: BuildOperationDepsDeps): RunLoadDeps {
  const { settings, rdsData, paths, logger } = deps;
  if (settings.table === undefined || settings.inputFile === undefined) {
    throw new Core.M3LError(
      "'load' requires 'table' and 'input.file' to be set",
      { code: BUILD_DEPS_CODE },
    );
  }

  const importer = createLoadImporter(settings.inputFormat);
  const checkpoint = new Core.M3LCheckpointStore<RunLoadCheckpoint>({
    paths,
    name: "load",
    validate: isRunLoadCheckpoint,
    missing: { kind: "empty", value: {} },
    // Fingerprints the run's shape so a leftover checkpoint from a
    // differently-configured prior run throws ERR_CHECKPOINT_FINGERPRINT_MISMATCH
    // on read() instead of silently being reused. `secretArn` is
    // deliberately excluded (see buildQueryDeps's checkpoint above). `table`
    // is the unqualified settings value (not the already-quoted/qualified
    // identifier below) — qualification is a rendering detail, not a
    // meaning-bearing part of the run's shape. `batchSize` IS
    // meaning-bearing here (unlike query's `pageSize`) — the load
    // checkpoint's `chunkIndex` counts chunks sized by `batchSize`.
    definition: {
      resourceArn: settings.resourceArn,
      database: settings.database,
      ...(settings.schema !== undefined && { schema: settings.schema }),
      table: settings.table,
      ...(settings.columns !== undefined && { columns: settings.columns }),
      inputFile: settings.inputFile,
      inputFormat: settings.inputFormat,
      batchSize: settings.batchSize,
    },
  });
  const failedWriterPath = paths.resolveOutput("failed.jsonl");

  return {
    rdsData,
    resourceArn: settings.resourceArn,
    secretArn: settings.secretArn,
    database: settings.database,
    ...(settings.schema !== undefined && { schema: settings.schema }),
    table: qualifyIdentifier(settings.schema, settings.table),
    ...(settings.columns !== undefined && { columns: settings.columns }),
    importer,
    source: paths.resolveInput(settings.inputFile),
    batchSize: settings.batchSize,
    checkpoint,
    // Deferred, not eagerly opened: its resume byte offset is only known
    // once the caller has read its own checkpoint, so `runLoad` itself
    // calls this once, at the top of the run.
    createFailedWriter: (resumeFromByte) =>
      new Core.M3LJSONListExporter<Record<string, unknown>>({
        filePath: failedWriterPath,
        format: "jsonl",
        resumeFromByte,
      }).exportStream(),
    logger,
    ...(deps.reportRecovery !== undefined && {
      reportRecovery: deps.reportRecovery,
    }),
  };
}

/** Builds `execute`'s deps bag — split out of {@link buildOperationDeps} to keep its complexity low. */
async function buildExecuteDeps(
  deps: BuildOperationDepsDeps,
): Promise<RunExecuteDeps> {
  const { settings, rdsData, prompt, paths, logger, awsTarget } = deps;
  const sql = await resolveSql(paths, settings);
  const parameters = await resolveParameters(paths, settings.parametersFile);

  return {
    rdsData,
    resourceArn: settings.resourceArn,
    secretArn: settings.secretArn,
    database: settings.database,
    ...(settings.schema !== undefined && { schema: settings.schema }),
    sql,
    parameters,
    yes: settings.yes,
    prompt,
    logger,
    awsTarget,
    yesSensitive: settings.yesSensitive,
  };
}

/** Lists `migrationsDir`'s `.sql` files (filesystem order) and reads each one's content. */
async function listMigrationFiles(
  paths: Core.M3LPaths,
  migrationsDir: string,
): Promise<readonly RunMigrateFile[]> {
  const dirPath = paths.resolveInput(migrationsDir);
  let filenames: readonly string[];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    filenames = entries
      .filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"),
      )
      .map((entry) => entry.name);
  } catch (cause) {
    throw new Core.M3LError(`failed to list migrations.dir at '${dirPath}'`, {
      code: BUILD_DEPS_CODE,
      cause,
    });
  }

  const migrations: RunMigrateFile[] = [];
  for (const filename of filenames) {
    const filePath = join(dirPath, filename);
    try {
      migrations.push({ filename, sql: await readFile(filePath, "utf8") });
    } catch (cause) {
      throw new Core.M3LError(
        `failed to read migration file at '${filePath}'`,
        { code: BUILD_DEPS_CODE, cause },
      );
    }
  }
  return migrations;
}

/** Builds `migrate`'s deps bag — split out of {@link buildOperationDeps} to keep its complexity low. */
async function buildMigrateDeps(
  deps: BuildOperationDepsDeps,
): Promise<RunMigrateDeps> {
  const { settings, rdsData, paths, logger } = deps;
  if (settings.migrationsDir === undefined) {
    throw new Core.M3LError("'migrate' requires 'migrations.dir' to be set", {
      code: BUILD_DEPS_CODE,
    });
  }
  const migrations = await listMigrationFiles(paths, settings.migrationsDir);

  return {
    rdsData,
    resourceArn: settings.resourceArn,
    secretArn: settings.secretArn,
    database: settings.database,
    ...(settings.schema !== undefined && { schema: settings.schema }),
    migrationsTable: qualifyIdentifier(
      settings.schema,
      settings.migrationsTable,
    ),
    migrations,
    logger,
  };
}

/**
 * Builds the single per-operation deps bag matching `deps.settings.operation`
 * — never all four, avoiding an unneeded file read/parse for the operations
 * not selected this run.
 *
 * @param deps - See {@link BuildOperationDepsDeps}.
 * @returns The one populated `Run*Deps` bag, matching `deps.settings.operation`.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_INPUT_FILE"` when a
 *   required file cannot be read/parsed, or a cross-parameter requirement is
 *   unmet.
 *
 * @example
 * ```ts
 * import { Core, type AWS } from "@m3l-automation/m3l-common";
 * import { buildOperationDeps } from "./build-operation-deps.js";
 * import { resolveRdsDataSqlSettings } from "./resolve-settings.js";
 *
 * async function run(
 *   config: Core.M3LConfig,
 *   rdsData: AWS.M3LRDSDataOperations,
 *   prompt: Core.M3LPrompt,
 *   logger: Core.M3LLogger,
 *   awsTarget: Core.M3LDestructiveTarget,
 * ): Promise<void> {
 *   const settings = resolveRdsDataSqlSettings(config);
 *   const paths = new Core.M3LPaths();
 *   const operationDeps = await buildOperationDeps({
 *     settings,
 *     rdsData,
 *     prompt,
 *     paths,
 *     logger,
 *     awsTarget,
 *   });
 *   console.log(Object.keys(operationDeps));
 * }
 * ```
 */
export async function buildOperationDeps(
  deps: BuildOperationDepsDeps,
): Promise<RdsDataSqlOperationDeps> {
  switch (deps.settings.operation) {
    case "query":
      return { query: await buildQueryDeps(deps) };
    case "load":
      return { load: buildLoadDeps(deps) };
    case "execute":
      return { execute: await buildExecuteDeps(deps) };
    case "migrate":
      return { migrate: await buildMigrateDeps(deps) };
    default: {
      const exhaustive: never = deps.settings.operation;
      throw new Core.M3LError(`unhandled operation: ${String(exhaustive)}`, {
        code: BUILD_DEPS_CODE,
      });
    }
  }
}
