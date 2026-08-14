/**
 * `steps/run-migrate` — applies an ordered set of `.sql` files inside one
 * transaction, recording applied filenames in `migrations.table`.
 *
 * Business logic lives here — never in `main.ts`. `resolve-settings` (or the
 * caller composing this step) owns reading `migrations.dir`'s files and
 * qualifying/quoting `migrations.table`; this step receives the already-read
 * `{ filename, sql }` pairs and the already-qualified/quoted table
 * identifier, and owns lexicographic-by-filename ordering, the
 * already-applied filter, and the single transactional apply-and-record
 * pass, per `docs/reference/scripts/rds-data-sql.md`'s `run-migrate` row.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

/** The `Core.M3LError` code thrown when a migration file fails this step's own validation. */
const MIGRATION_INVALID_CODE = "ERR_RDS_DATA_SQL_MIGRATION_INVALID";

/** One `.sql` migration file, already read into memory by the caller. */
export interface RunMigrateFile {
  /** The file's base name, used both for ordering and as the recorded key. */
  readonly filename: string;
  /** The file's full SQL text (exactly one statement). */
  readonly sql: string;
}

/**
 * The slice of {@link AWS.M3LRDSDataOperations} {@link runMigrate} needs.
 * `withTransaction` is declared **non-generic** here (`fn` returns
 * `Promise<unknown>`, not `Promise<T>`) so both the real
 * `M3LRDSDataOperations` instance (whose generic method instantiates
 * cleanly against this narrower shape) and a concrete, non-generic test
 * double stay structurally assignable — a generic
 * `withTransaction<T>(...): Promise<T>` member rejects a concrete mock,
 * since TypeScript requires the assigned value to work for an arbitrary
 * `T`, not just the one instantiation a test constructs.
 * {@link runMigrate} narrows the `unknown` result back to
 * `readonly string[]` itself, since it alone knows `fn`'s real return shape.
 */
interface RunMigrateRdsData {
  /** Runs one SQL statement and returns its typed result set. */
  readonly executeStatement: AWS.M3LRDSDataOperations["executeStatement"];
  /** Runs `fn` inside a begin/commit transaction, rolling back on any throw. */
  readonly withTransaction: (
    input: AWS.M3LRDSDataBeginTransactionInput,
    fn: (transactionId: string) => Promise<unknown>,
  ) => Promise<unknown>;
}

/** Injected dependencies for {@link runMigrate}. */
export interface RunMigrateDeps {
  /** The provisioned RDS Data API operations wrapper (`executeStatement` + `withTransaction`). */
  readonly rdsData: RunMigrateRdsData;
  /** The Aurora cluster/instance ARN. */
  readonly resourceArn: string;
  /** The Secrets Manager ARN holding the database credentials. */
  readonly secretArn: string;
  /** The target database name, when set. */
  readonly database?: string;
  /** The target schema name, when set. */
  readonly schema?: string;
  /** The already-qualified, already-double-quoted migrations-tracking table identifier, e.g. `"schema_migrations"`. */
  readonly migrationsTable: string;
  /** The migration files to consider, in any order (this step sorts them). */
  readonly migrations: readonly RunMigrateFile[];
  /** The logger used to record progress. */
  readonly logger: Core.M3LLogger;
}

/** The outcome of {@link runMigrate}. */
export interface RunMigrateResult {
  /** The filenames applied by this run, in the order they were applied. */
  readonly applied: readonly string[];
}

/**
 * Matches a single-quoted string (`''`-escaped), a double-quoted identifier
 * (`""`-escaped), a `--…`-to-EOL line comment, or a block comment's opening
 * `/*` delimiter — every span that can hide a `;` without it being a real
 * statement terminator. Used by {@link stripQuotedAndCommentedSpans} to
 * strip those spans before {@link looksLikeMultipleStatements} counts
 * top-level semicolons.
 *
 * The block-comment alternative matches only the opening `/*`, not the full
 * `/\*[\s\S]*?\*\/` span: that greedy-content form re-scans quadratically
 * from every unterminated `/*` in adversarial input.
 * {@link stripQuotedAndCommentedSpans} locates the matching `*\/` itself via
 * a plain `indexOf` scan, which stays linear.
 */
const QUOTED_OR_COMMENTED_SPAN =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*/gu;

/**
 * Strips every quoted-string/line-comment/block-comment span from `sql` —
 * split out of {@link looksLikeMultipleStatements} to isolate the
 * block-comment span's linear `indexOf` handling from the otherwise-regex-
 * driven scan.
 *
 * The quoted-string and line-comment alternatives are consumed directly from
 * {@link QUOTED_OR_COMMENTED_SPAN}'s match (both already linear). A matched
 * `/*` opener instead has its closing `*\/` located by `indexOf` from the
 * opener's end; when none is found, the block comment is treated as
 * extending to the end of `sql` (an unterminated `/*` cannot hide a real
 * statement terminator after it, since nothing after it is real SQL either).
 */
function stripQuotedAndCommentedSpans(sql: string): string {
  let result = "";
  let cursor = 0;
  QUOTED_OR_COMMENTED_SPAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTED_OR_COMMENTED_SPAN.exec(sql)) !== null) {
    result += sql.slice(cursor, match.index);
    if (match[0] === "/*") {
      const closing = sql.indexOf("*/", match.index + "/*".length);
      cursor = closing === -1 ? sql.length : closing + "*/".length;
    } else {
      cursor = match.index + match[0].length;
    }
    QUOTED_OR_COMMENTED_SPAN.lastIndex = cursor;
  }
  result += sql.slice(cursor);
  return result;
}

/**
 * Detects an "obvious second statement" in `sql` — a second top-level `;`
 * outside any string literal or comment. Heuristic, not a SQL parser: it
 * strips every quoted string and comment span first (so an embedded `;`
 * never counts as a terminator), then counts the remaining `;` characters.
 * A single trailing `;` (or none) is fine — only a second one trips this.
 *
 * This mirrors `run-execute`'s own convenience-gate posture rather than
 * promising full SQL-dialect coverage.
 *
 * @param sql - One migration file's SQL text.
 * @returns `true` when more than one top-level `;` remains.
 */
function looksLikeMultipleStatements(sql: string): boolean {
  const withoutQuotesOrComments = stripQuotedAndCommentedSpans(sql);
  let semicolons = 0;
  for (const char of withoutQuotesOrComments) {
    if (char === ";") semicolons += 1;
    if (semicolons > 1) return true;
  }
  return false;
}

/**
 * Validates every migration file, throwing on the first one that appears to
 * hold more than one statement — split out of {@link runMigrate} to keep its
 * cyclomatic complexity low.
 */
function validateSingleStatementEach(
  migrations: readonly RunMigrateFile[],
): void {
  for (const migration of migrations) {
    if (looksLikeMultipleStatements(migration.sql)) {
      throw new Core.M3LError(
        `migration file '${migration.filename}' appears to hold more than one statement`,
        { code: MIGRATION_INVALID_CODE },
      );
    }
  }
}

/** Plain lexicographic (code-unit) comparator — never locale-aware. */
function compareFilenames(a: RunMigrateFile, b: RunMigrateFile): number {
  if (a.filename < b.filename) return -1;
  if (a.filename > b.filename) return 1;
  return 0;
}

/**
 * Extracts the recorded filenames from `migrations.table`'s
 * `SELECT filename FROM ...` result set — split out of {@link runMigrate} to
 * keep its cyclomatic complexity low.
 *
 * @param rows - The statement result's rows, each expected to hold exactly
 *   one `"string"`-kind column.
 * @returns The recorded filenames, in result order.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_MIGRATION_INVALID"`
 *   when a row's first column is missing or not a `"string"`-kind value.
 */
function extractAppliedFilenames(
  rows: readonly AWS.M3LRDSDataRow[],
): readonly string[] {
  return rows.map((row) => {
    const value = row[0];
    if (value === undefined || value.kind !== "string") {
      throw new Core.M3LError(
        "migrations table SELECT returned a row whose filename column was not a string",
        { code: MIGRATION_INVALID_CODE },
      );
    }
    return value.value;
  });
}

/**
 * Narrows {@link RunMigrateRdsData.withTransaction}'s `unknown` result back
 * to `readonly string[]` — the shape {@link applyPendingMigrations} (the
 * only `fn` `runMigrate` ever passes) is known to always return.
 *
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_MIGRATION_INVALID"`
 *   when `value` is not an array of strings — defensive: unreachable via
 *   this module's own `fn`, but guards against a future caller.
 */
function assertAppliedFilenames(value: unknown): readonly string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Core.M3LError(
    "runMigrate's withTransaction resolved with an unexpected shape (expected a string array)",
    { code: MIGRATION_INVALID_CODE },
  );
}

/**
 * Runs the transactional body of {@link runMigrate}: ensures
 * `deps.migrationsTable` exists, reads which filenames are already recorded,
 * then applies each remaining file's statement plus its recording `INSERT`,
 * in lexicographic filename order.
 */
async function applyPendingMigrations(
  deps: RunMigrateDeps,
  transactionId: string,
): Promise<readonly string[]> {
  const base = {
    resourceArn: deps.resourceArn,
    secretArn: deps.secretArn,
    ...(deps.database !== undefined && { database: deps.database }),
    ...(deps.schema !== undefined && { schema: deps.schema }),
    transactionId,
  };

  await deps.rdsData.executeStatement({
    ...base,
    sql: `CREATE TABLE IF NOT EXISTS ${deps.migrationsTable} (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  });

  const selectResult = await deps.rdsData.executeStatement({
    ...base,
    sql: `SELECT filename FROM ${deps.migrationsTable}`,
  });
  const alreadyApplied = new Set(extractAppliedFilenames(selectResult.rows));

  const pending = [...deps.migrations]
    .sort(compareFilenames)
    .filter((migration) => !alreadyApplied.has(migration.filename));

  const applied: string[] = [];
  for (const migration of pending) {
    await deps.rdsData.executeStatement({ ...base, sql: migration.sql });
    await deps.rdsData.executeStatement({
      ...base,
      sql: `INSERT INTO ${deps.migrationsTable} (filename) VALUES (:filename)`,
      parameters: [
        {
          name: "filename",
          value: { kind: "string", value: migration.filename },
        },
      ],
    });
    applied.push(migration.filename);
  }

  return applied;
}

/**
 * Ensures `deps.migrationsTable` exists, then applies every pending
 * `deps.migrations` file (lexicographic filename order, skipping filenames
 * already recorded) inside one `withTransaction` scope.
 *
 * @param deps - See {@link RunMigrateDeps}.
 * @returns The filenames applied by this run, in application order.
 * @throws {@link Core.M3LError} coded `"ERR_RDS_DATA_SQL_MIGRATION_INVALID"`
 *   when a migration file appears to hold more than one statement (checked
 *   before any transaction opens), when `migrations.table`'s tracking
 *   `SELECT` returns a malformed filename column, or when
 *   `withTransaction`'s resolved value is not a string array.
 * @throws Whatever `deps.rdsData.withTransaction` rejects with, unchanged —
 *   when `fn` fails and the rollback also succeeds, `fn`'s own error
 *   propagates as-is; when the rollback itself also fails, both errors stay
 *   reachable via `.cause` chaining (see `aws/rds-data`'s
 *   `withTransaction` docs). This step never re-wraps either case.
 *
 * @example
 * ```ts
 * import { Core, type AWS } from "@m3l-automation/m3l-common";
 * import { runMigrate } from "./run-migrate.js";
 *
 * async function run(
 *   rdsData: Pick<AWS.M3LRDSDataOperations, "executeStatement" | "withTransaction">,
 *   logger: Core.M3LLogger,
 * ): Promise<void> {
 *   const { applied } = await runMigrate({
 *     rdsData,
 *     resourceArn: "arn:aws:rds:us-east-1:123456789012:cluster:my-cluster",
 *     secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
 *     migrationsTable: '"schema_migrations"',
 *     migrations: [
 *       { filename: "001_init.sql", sql: "CREATE TABLE t (id int)" },
 *     ],
 *     logger,
 *   });
 *   logger.step(`applied: ${applied.join(", ")}`);
 * }
 * ```
 */
export async function runMigrate(
  deps: RunMigrateDeps,
): Promise<RunMigrateResult> {
  validateSingleStatementEach(deps.migrations);

  const result = await deps.rdsData.withTransaction(
    {
      resourceArn: deps.resourceArn,
      secretArn: deps.secretArn,
      ...(deps.database !== undefined && { database: deps.database }),
      ...(deps.schema !== undefined && { schema: deps.schema }),
    },
    (transactionId) => applyPendingMigrations(deps, transactionId),
  );

  return { applied: assertAppliedFilenames(result) };
}
