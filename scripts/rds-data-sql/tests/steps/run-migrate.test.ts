import { afterEach, describe, expect, test, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runMigrate } from "../../src/steps/run-migrate.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `run-migrate` row +
 * "Notes and behavior" ("one transaction per invocation", the
 * `withTransaction` rollback-failure cause-chain) + `migrations.table` row
 * (the verbatim `CREATE TABLE IF NOT EXISTS` statement).
 *
 * `run-migrate`'s injected-deps shape isn't pre-declared, and the ordering
 * SQL run-migrate issues around its own `.sql` files (a "which filenames are
 * already applied" query and a per-file "record this filename" insert)
 * isn't given verbatim in the contract page either — only the `CREATE TABLE`
 * statement is quoted exactly. This file therefore also defines the rest of
 * that ordering contract (query the table, apply each pending file, record
 * it) as the shape the implementer builds against; the CREATE TABLE
 * statement's exact text is load-bearing (copied verbatim from the doc), the
 * SELECT/INSERT shapes are this file's own invented (but documented) design.
 * `resolve-settings` is responsible for reading `migrations.dir`'s files —
 * `run-migrate` receives the already-read `migrations` array and is
 * responsible for lexicographic-by-filename ordering itself.
 *
 * ```ts
 * interface RunMigrateDeps {
 *   readonly rdsData: Pick<AWS.M3LRDSDataOperations, "executeStatement" | "withTransaction">;
 *   readonly resourceArn: string;
 *   readonly secretArn: string;
 *   readonly database?: string;
 *   readonly schema?: string;
 *   readonly migrationsTable: string; // already-qualified/quoted, e.g. `"schema_migrations"`
 *   readonly migrations: readonly { readonly filename: string; readonly sql: string }[];
 *   readonly logger: Core.M3LLogger;
 * }
 * function runMigrate(deps: RunMigrateDeps): Promise<{ readonly applied: readonly string[] }>;
 * ```
 */

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

function genericSuccess(): AWS.M3LRDSDataStatementResult {
  return {
    rows: [],
    columns: [],
    numberOfRecordsUpdated: 1,
    generatedFields: [],
  };
}

/**
 * Builds an `executeStatement` mock that dispatches on the input SQL's
 * shape: the verbatim `CREATE TABLE IF NOT EXISTS` statement, a `SELECT`
 * against `migrationsTable` (returns `alreadyApplied` as string rows), any
 * migration file's own SQL text (matched against `migrations`), or an
 * `INSERT INTO migrationsTable` recording call.
 */
function makeExecuteStatement(options: {
  readonly migrationsTable: string;
  readonly migrations: readonly {
    readonly filename: string;
    readonly sql: string;
  }[];
  readonly alreadyApplied: readonly string[];
  readonly failingSql?: string;
}) {
  return vi.fn(
    async (
      input: AWS.M3LRDSDataStatementInput,
    ): Promise<AWS.M3LRDSDataStatementResult> => {
      await Promise.resolve();
      if (input.sql === options.failingSql) {
        throw new AWS.M3LRDSDataOperationError(
          `statement failed: ${input.sql}`,
        );
      }
      if (input.sql.startsWith("CREATE TABLE IF NOT EXISTS")) {
        return genericSuccess();
      }
      const upper = input.sql.toUpperCase();
      if (
        upper.startsWith("SELECT") &&
        input.sql.includes(options.migrationsTable)
      ) {
        return {
          rows: options.alreadyApplied.map((filename) => [
            { kind: "string", value: filename },
          ]),
          columns: [{ name: "filename", typeName: "text", label: "filename" }],
          numberOfRecordsUpdated: 0,
          generatedFields: [],
        };
      }
      // Either a migration file's own SQL, or the INSERT-INTO-migrationsTable
      // recording call — both resolve as a generic success for these tests.
      return genericSuccess();
    },
  );
}

/** A `withTransaction` mock that simply runs `fn` once. */
function passthroughWithTransaction() {
  return vi.fn(
    async (
      _input: AWS.M3LRDSDataBeginTransactionInput,
      fn: (transactionId: string) => Promise<unknown>,
    ) => fn("txn-1"),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runMigrate", () => {
  test("happy path: applies pending files in lexicographic filename order inside one transaction, recording each", async () => {
    const migrations = [
      { filename: "002_b.sql", sql: "CREATE TABLE b (id int)" },
      { filename: "001_a.sql", sql: "CREATE TABLE a (id int)" },
    ];
    const migrationsTable = '"schema_migrations"';
    const executeStatement = makeExecuteStatement({
      migrationsTable,
      migrations,
      alreadyApplied: [],
    });
    const withTransaction = passthroughWithTransaction();

    const result = await runMigrate({
      rdsData: { executeStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      migrationsTable,
      migrations,
      logger: makeLogger(),
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);

    const calls = executeStatement.mock.calls.map(([input]) => input.sql);
    expect(calls[0]).toBe(
      `CREATE TABLE IF NOT EXISTS ${migrationsTable} (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const aIndex = calls.indexOf("CREATE TABLE a (id int)");
    const bIndex = calls.indexOf("CREATE TABLE b (id int)");
    expect(aIndex).toBeGreaterThan(0);
    expect(bIndex).toBeGreaterThan(aIndex);

    expect(result.applied).toEqual(["001_a.sql", "002_b.sql"]);
  });

  test("filenames already recorded in migrations.table are skipped, not re-applied", async () => {
    const migrations = [
      { filename: "001_a.sql", sql: "CREATE TABLE a (id int)" },
      { filename: "002_b.sql", sql: "CREATE TABLE b (id int)" },
    ];
    const migrationsTable = '"schema_migrations"';
    const executeStatement = makeExecuteStatement({
      migrationsTable,
      migrations,
      alreadyApplied: ["001_a.sql"],
    });
    const withTransaction = passthroughWithTransaction();

    const result = await runMigrate({
      rdsData: { executeStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      migrationsTable,
      migrations,
      logger: makeLogger(),
    });

    const calls = executeStatement.mock.calls.map(([input]) => input.sql);
    expect(calls).not.toContain("CREATE TABLE a (id int)");
    expect(calls).toContain("CREATE TABLE b (id int)");
    expect(result.applied).toEqual(["002_b.sql"]);
  });

  test("a mid-batch failure propagates fn's own error and never applies files after it", async () => {
    const migrations = [
      { filename: "001_a.sql", sql: "CREATE TABLE a (id int)" },
      { filename: "002_b.sql", sql: "CREATE TABLE b (id int)" },
      { filename: "003_c.sql", sql: "CREATE TABLE c (id int)" },
    ];
    const migrationsTable = '"schema_migrations"';
    const executeStatement = makeExecuteStatement({
      migrationsTable,
      migrations,
      alreadyApplied: [],
      failingSql: "CREATE TABLE b (id int)",
    });
    const withTransaction = passthroughWithTransaction();

    let thrown: unknown;
    try {
      await runMigrate({
        rdsData: { executeStatement, withTransaction },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        migrationsTable,
        migrations,
        logger: makeLogger(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AWS.M3LRDSDataOperationError);
    expect(withTransaction).toHaveBeenCalledTimes(1);

    const calls = executeStatement.mock.calls.map(([input]) => input.sql);
    expect(calls).not.toContain("CREATE TABLE c (id int)");
  });

  test("an unterminated block comment is treated as extending to end of file, not counted as hiding a second statement", async () => {
    // Regression/coverage test for stripQuotedAndCommentedSpans's
    // `closing === -1` path: an opened `/*` with no matching `*/` must be
    // treated as consuming the rest of the file, so a `;` inside it is
    // never counted as a top-level statement terminator. The lone real `;`
    // right after the CREATE TABLE clause is fine on its own (a single
    // trailing terminator); if the unterminated comment's own `;` were
    // wrongly counted too, this would trip looksLikeMultipleStatements and
    // throw MIGRATION_INVALID_CODE instead of applying successfully.
    const migrations = [
      {
        filename: "001_a.sql",
        sql: "CREATE TABLE a (id int); /* unterminated comment with a ; inside",
      },
    ];
    const migrationsTable = '"schema_migrations"';
    const executeStatement = makeExecuteStatement({
      migrationsTable,
      migrations,
      alreadyApplied: [],
    });
    const withTransaction = passthroughWithTransaction();

    const result = await runMigrate({
      rdsData: { executeStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      migrationsTable,
      migrations,
      logger: makeLogger(),
    });

    expect(result.applied).toEqual(["001_a.sql"]);
  });

  test("when the rollback also fails, both fn's error and the rollback failure stay reachable via .cause chaining", async () => {
    const rollbackFailure = new AWS.M3LRDSDataOperationError("rollback failed");
    const fnError = new Error("insert failed", { cause: rollbackFailure });
    const thrownError = new AWS.M3LRDSDataOperationError(
      "rds data operation failed and rollback also failed",
      { cause: fnError },
    );
    const withTransaction = vi.fn().mockRejectedValue(thrownError);
    const executeStatement = vi.fn();

    let thrown: unknown;
    try {
      await runMigrate({
        rdsData: { executeStatement, withTransaction },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        migrationsTable: '"schema_migrations"',
        migrations: [{ filename: "001_a.sql", sql: "CREATE TABLE a (id int)" }],
        logger: makeLogger(),
      });
    } catch (error) {
      thrown = error;
    }

    // run-migrate propagates whatever withTransaction rejects with unchanged
    // — it never re-wraps or drops either error in the chain.
    expect(thrown).toBe(thrownError);
    expect((thrown as Error).cause).toBe(fnError);
    expect(fnError.cause).toBe(rollbackFailure);
  });
});
