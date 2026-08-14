import { EventEmitter } from "node:events";
import type { Dirent, WriteStream } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { AWS } from "@m3l-automation/m3l-common";
import { Core } from "@m3l-automation/m3l-common";

/**
 * Contract: `scripts/rds-data-sql/src/steps/build-operation-deps.ts` itself
 * (no dedicated doc row — it's the composition step referenced generically
 * by the `run-query`/`run-load`/`run-execute`/`run-migrate` rows of
 * `docs/reference/scripts/rds-data-sql.md`) plus `resolve-settings.ts`'s
 * `RdsDataSqlSettings` shape and each `run-*` step's own `Run*Deps` shape.
 *
 * `buildOperationDeps` builds exactly ONE of `{query, load, execute,
 * migrate}`, based on `settings.operation`, doing real file I/O
 * (`node:fs/promises` `readFile`/`readdir`) along the way. Both
 * `buildQueryDeps` and `buildLoadDeps` also eagerly call an exporter's
 * `exportStream()`, which opens a real `fs.WriteStream`
 * (`node:fs`'s `createWriteStream`, synchronously) — so `node:fs` is mocked
 * here too, not just `node:fs/promises`, to keep every test filesystem-free.
 */

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual, readFile: vi.fn(), readdir: vi.fn() };
});

import { buildOperationDeps } from "../../src/steps/build-operation-deps.js";
import type { RdsDataSqlSettings } from "../../src/steps/resolve-settings.js";

const BUILD_DEPS_CODE = "ERR_RDS_DATA_SQL_INPUT_FILE";

/** The settings fields every operation shares, minus operation-specific ones. */
const BASE_SETTINGS: RdsDataSqlSettings = {
  operation: "query",
  resourceArn: "arn:aws:rds:us-east-1:123456789012:cluster:test-cluster",
  secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret",
  database: "testdb",
  inputFormat: "jsonl",
  batchSize: 100,
  pageSize: 1_000,
  outputFormat: "json",
  migrationsTable: "schema_migrations",
  yes: false,
};

function makeSettings(
  overrides: Partial<RdsDataSqlSettings>,
): RdsDataSqlSettings {
  return { ...BASE_SETTINGS, ...overrides };
}

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

/**
 * Installs a fake `fs.createWriteStream` so `buildQueryDeps`/`buildLoadDeps`'s
 * eager `exportStream()` call never touches the real filesystem. The fake
 * stream is never written to in these tests — `buildOperationDeps` only
 * constructs the writer, it never calls `append`/`close` itself.
 */
function stubWriteStream(): void {
  vi.spyOn(fs, "createWriteStream").mockReturnValue(
    new EventEmitter() as unknown as WriteStream,
  );
}

/** One `Dirent`-shaped `readdir({ withFileTypes: true })` entry. */
function dirent(name: string, isFile: boolean): Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
  } as Dirent;
}

/** Builds the full `BuildOperationDepsDeps` bag, only `settings` varies per test. */
function buildDeps(settings: RdsDataSqlSettings) {
  return {
    settings,
    rdsData: {} as unknown as AWS.M3LRDSDataOperations,
    secretsManager: {} as unknown as AWS.M3LSecretsManagerOperations,
    prompt: new Core.M3LPrompt(),
    paths: new Core.M3LPaths(),
    logger: makeLogger(),
  };
}

/** Captures a thrown value from an async call without a bare `try`/`catch` per test. */
async function captureThrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsp.readFile).mockReset();
  vi.mocked(fsp.readdir).mockReset();
});

describe("buildOperationDeps: per-operation isolation", () => {
  test("'query' populates only 'query'", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1",
          outputFile: "out.json",
        }),
      ),
    );

    expect(result.query).toBeDefined();
    expect(result.load).toBeUndefined();
    expect(result.execute).toBeUndefined();
    expect(result.migrate).toBeUndefined();
  });

  test("'load' populates only 'load'", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          table: "users",
          inputFile: "users.jsonl",
        }),
      ),
    );

    expect(result.load).toBeDefined();
    expect(result.query).toBeUndefined();
    expect(result.execute).toBeUndefined();
    expect(result.migrate).toBeUndefined();
  });

  test("'execute' populates only 'execute'", async () => {
    const result = await buildOperationDeps(
      buildDeps(makeSettings({ operation: "execute", sql: "SELECT 1" })),
    );

    expect(result.execute).toBeDefined();
    expect(result.query).toBeUndefined();
    expect(result.load).toBeUndefined();
    expect(result.migrate).toBeUndefined();
  });

  test("'migrate' populates only 'migrate'", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({ operation: "migrate", migrationsDir: "migrations" }),
      ),
    );

    expect(result.migrate).toBeDefined();
    expect(result.query).toBeUndefined();
    expect(result.load).toBeUndefined();
    expect(result.execute).toBeUndefined();
  });
});

describe("buildOperationDeps: query", () => {
  test("throws a coded error before any file I/O when 'output.file' is unset", async () => {
    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(makeSettings({ operation: "query", sql: "SELECT 1" })),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(BUILD_DEPS_CODE);
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("uses inline 'sql' verbatim and never reads 'sql.file'", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1 FROM inline",
          outputFile: "out.json",
        }),
      ),
    );

    expect(result.query?.sql).toBe("SELECT 1 FROM inline");
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("reads 'sql.file' via readFile when 'sql' is unset, becoming RunQueryDeps.sql", async () => {
    stubWriteStream();
    vi.mocked(fsp.readFile).mockResolvedValue("SELECT 1 FROM file");

    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sqlFile: "query.sql",
          outputFile: "out.json",
        }),
      ),
    );

    expect(result.query?.sql).toBe("SELECT 1 FROM file");
    expect(fsp.readFile).toHaveBeenCalledTimes(1);
  });

  test("reads and JSON-parses 'parameters.file' into RunQueryDeps.parameters", async () => {
    stubWriteStream();
    const parameters: readonly AWS.M3LRDSDataParameter[] = [
      { name: "id", value: { kind: "long", value: 1 } },
    ];
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(parameters));

    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1",
          outputFile: "out.json",
          parametersFile: "params.json",
        }),
      ),
    );

    expect(result.query?.parameters).toEqual(parameters);
  });

  test("a malformed-JSON 'parameters.file' throws a coded error without the raw content or the SyntaxError chained", async () => {
    stubWriteStream();
    const rawContent = "{not valid json, super-secret-bind-value";
    vi.mocked(fsp.readFile).mockResolvedValue(rawContent);

    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({
            operation: "query",
            sql: "SELECT 1",
            outputFile: "out.json",
            parametersFile: "params.json",
          }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(BUILD_DEPS_CODE);
    expect(error.message).not.toContain(rawContent);
    expect(error.message).not.toContain("super-secret-bind-value");
    expect(error.cause).toBeUndefined();
  });

  test("a 'parameters.file' JSON value that isn't an array of named RDS Data parameters throws a coded error", async () => {
    stubWriteStream();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify([{ notName: "x" }]),
    );

    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({
            operation: "query",
            sql: "SELECT 1",
            outputFile: "out.json",
            parametersFile: "params.json",
          }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(BUILD_DEPS_CODE);
  });
});

describe("buildOperationDeps: query toRecord", () => {
  test("a result column literally named '__proto__' becomes a normal own property, and the record's own prototype stays null", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1",
          outputFile: "out.json",
        }),
      ),
    );

    const columns: readonly AWS.M3LRDSDataColumn[] = [
      { name: "__proto__", typeName: "text", label: "__proto__" },
      { name: "id", typeName: "int8", label: "id" },
    ];
    const row: readonly AWS.M3LRDSDataValue[] = [
      { kind: "string", value: "polluted" },
      { kind: "long", value: 1 },
    ];

    const record = result.query?.toRecord(columns, row);

    expect(record).toBeDefined();
    const populated = record as Record<string, unknown>;
    expect(Object.hasOwn(populated, "__proto__")).toBe(true);
    expect(populated["__proto__"]).toBe("polluted");
    expect(Object.getPrototypeOf(populated)).toBeNull();
    expect(populated["id"]).toBe(1);
  });
});

describe("buildOperationDeps: load", () => {
  test("throws a coded error when 'table' is unset", async () => {
    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({ operation: "load", inputFile: "users.jsonl" }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(BUILD_DEPS_CODE);
  });

  test("throws a coded error when 'input.file' is unset", async () => {
    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(makeSettings({ operation: "load", table: "users" })),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(BUILD_DEPS_CODE);
  });

  test("qualifies and double-quotes 'table' with 'schema' when set", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          schema: "public",
          table: "users",
          inputFile: "users.jsonl",
        }),
      ),
    );

    expect(result.load?.table).toBe('"public"."users"');
  });

  test("double-quotes 'table' alone when 'schema' is unset", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          table: "users",
          inputFile: "users.jsonl",
        }),
      ),
    );

    expect(result.load?.table).toBe('"users"');
  });

  test("'input.format' \"csv\" selects the CSV importer", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          table: "users",
          inputFile: "users.csv",
          inputFormat: "csv",
        }),
      ),
    );

    expect(result.load?.importer).toBeInstanceOf(Core.M3LCSVListImporter);
  });

  test("'input.format' \"jsonl\" (the default) selects the JSON importer", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          table: "users",
          inputFile: "users.jsonl",
          inputFormat: "jsonl",
        }),
      ),
    );

    expect(result.load?.importer).toBeInstanceOf(Core.M3LJSONListImporter);
  });

  test("throws a coded error on an unhandled 'input.format' value, never constructing the checkpoint store", async () => {
    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({
            operation: "load",
            table: "users",
            inputFile: "users.jsonl",
            // Deliberately outside the declared "jsonl" | "csv" union to
            // exercise createLoadImporter's exhaustiveness `never` guard at
            // runtime (e.g. a bypassed config validator). Cast is required
            // to construct an otherwise-unreachable input for the
            // type-narrowed parameter — mirrors
            // scripts/athena-query/tests/steps/export-results.test.ts's
            // same-shaped exhaustive-default-branch test.
            inputFormat: "xml" as unknown as "jsonl",
          }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(BUILD_DEPS_CODE);
  });
});

describe("buildOperationDeps: checkpoint validation", () => {
  test("query's checkpoint validator rejects a 'rows' array containing a non-plain-object entry", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1",
          outputFile: "out.json",
        }),
      ),
    );
    const queryDeps = result.query;
    if (queryDeps === undefined) {
      throw new Error("expected buildOperationDeps to populate 'query'");
    }

    // A bare (non-enveloped, "legacy format") checkpoint file whose 'rows'
    // field is present but holds a non-plain-object entry — isOptionalRecordArray
    // must reject it, and M3LCheckpointStore treats a validate() failure
    // identically to malformed JSON.
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ rows: ["not-a-record"] }),
    );

    const thrown = await captureThrown(() => queryDeps.checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("load's checkpoint validator rejects a 'failedRecords' array containing a non-plain-object entry", async () => {
    stubWriteStream();
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          table: "users",
          inputFile: "users.jsonl",
        }),
      ),
    );
    const loadDeps = result.load;
    if (loadDeps === undefined) {
      throw new Error("expected buildOperationDeps to populate 'load'");
    }

    // A malformed 'failedRecords' entry — here `null`, which fails
    // isPlainRecord's `value !== null` check — must be rejected the same
    // way an unparseable file would be.
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ failedRecords: [null] }),
    );

    const thrown = await captureThrown(() => loadDeps.checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });
});

describe("buildOperationDeps: execute", () => {
  test("does not require 'output.file' to be set", async () => {
    const result = await buildOperationDeps(
      buildDeps(makeSettings({ operation: "execute", sql: "SELECT 1" })),
    );

    expect(result.execute).toBeDefined();
  });

  test("uses inline 'sql' verbatim and never reads 'sql.file'", async () => {
    const result = await buildOperationDeps(
      buildDeps(makeSettings({ operation: "execute", sql: "DELETE FROM t" })),
    );

    expect(result.execute?.sql).toBe("DELETE FROM t");
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("reads 'sql.file' via readFile when 'sql' is unset", async () => {
    vi.mocked(fsp.readFile).mockResolvedValue("DELETE FROM t2");

    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({ operation: "execute", sqlFile: "statement.sql" }),
      ),
    );

    expect(result.execute?.sql).toBe("DELETE FROM t2");
  });

  test("reads and JSON-parses 'parameters.file' into RunExecuteDeps.parameters", async () => {
    const parameters: readonly AWS.M3LRDSDataParameter[] = [
      { name: "id", value: { kind: "string", value: "abc" } },
    ];
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(parameters));

    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "execute",
          sql: "DELETE FROM t WHERE id = :id",
          parametersFile: "params.json",
        }),
      ),
    );

    expect(result.execute?.parameters).toEqual(parameters);
  });

  test("a malformed-JSON 'parameters.file' throws a coded error without the raw content or a chained cause", async () => {
    const rawContent = "not json at all, secret-bind-value";
    vi.mocked(fsp.readFile).mockResolvedValue(rawContent);

    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({
            operation: "execute",
            sql: "DELETE FROM t",
            parametersFile: "params.json",
          }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(BUILD_DEPS_CODE);
    expect(error.message).not.toContain(rawContent);
    expect(error.message).not.toContain("secret-bind-value");
    expect(error.cause).toBeUndefined();
  });
});

describe("buildOperationDeps: migrate", () => {
  test("throws a coded error when 'migrations.dir' is unset", async () => {
    const thrown = await captureThrown(() =>
      buildOperationDeps(buildDeps(makeSettings({ operation: "migrate" }))),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(BUILD_DEPS_CODE);
    expect(fsp.readdir).not.toHaveBeenCalled();
  });

  test("only reads '.sql' files (case-insensitive), skipping other files and nested directories", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      dirent("002_b.sql", true),
      dirent("readme.txt", true),
      dirent("nested", false),
      dirent("001_A.SQL", true),
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);
    vi.mocked(fsp.readFile).mockImplementation(async (path) => {
      await Promise.resolve();
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- test fixture only ever receives a string/Buffer path, never a bare FileHandle
      const label = typeof path === "string" ? path : path.toString();
      return `-- contents of ${label}`;
    });

    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({ operation: "migrate", migrationsDir: "migrations" }),
      ),
    );

    expect(fsp.readFile).toHaveBeenCalledTimes(2);
    expect(result.migrate?.migrations.map((m) => m.filename)).toEqual([
      "002_b.sql",
      "001_A.SQL",
    ]);
  });

  test("qualifies and double-quotes 'migrationsTable' with 'schema' when set", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "migrate",
          schema: "public",
          migrationsDir: "migrations",
          migrationsTable: "schema_migrations",
        }),
      ),
    );

    expect(result.migrate?.migrationsTable).toBe(
      '"public"."schema_migrations"',
    );
  });

  test("double-quotes 'migrationsTable' alone when 'schema' is unset", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "migrate",
          migrationsDir: "migrations",
          migrationsTable: "schema_migrations",
        }),
      ),
    );

    expect(result.migrate?.migrationsTable).toBe('"schema_migrations"');
  });
});

describe("buildOperationDeps: file-read failure propagation", () => {
  test("a rejected readFile for 'sql.file' surfaces as a coded M3LError chaining the underlying cause", async () => {
    const readFailure = new Error("EACCES: permission denied");
    vi.mocked(fsp.readFile).mockRejectedValue(readFailure);

    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({ operation: "execute", sqlFile: "statement.sql" }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(BUILD_DEPS_CODE);
    expect(error.cause).toBe(readFailure);
  });

  test("a rejected readFile for 'parameters.file' surfaces as a coded M3LError chaining the underlying cause", async () => {
    const readFailure = new Error("EACCES: permission denied");
    vi.mocked(fsp.readFile).mockRejectedValue(readFailure);

    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({
            operation: "execute",
            sql: "DELETE FROM t",
            parametersFile: "params.json",
          }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(BUILD_DEPS_CODE);
    expect(error.cause).toBe(readFailure);
  });

  test("a rejected readdir for 'migrations.dir' surfaces as a coded M3LError chaining the underlying cause", async () => {
    const readdirFailure = new Error("ENOENT: no such directory");
    vi.mocked(fsp.readdir).mockRejectedValue(readdirFailure);

    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({ operation: "migrate", migrationsDir: "migrations" }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(BUILD_DEPS_CODE);
    expect(error.cause).toBe(readdirFailure);
  });

  test("a rejected readFile for one listed migration file surfaces as a coded M3LError chaining the underlying cause", async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      dirent("001_a.sql", true),
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);
    const readFailure = new Error("EACCES: permission denied");
    vi.mocked(fsp.readFile).mockRejectedValue(readFailure);

    const thrown = await captureThrown(() =>
      buildOperationDeps(
        buildDeps(
          makeSettings({ operation: "migrate", migrationsDir: "migrations" }),
        ),
      ),
    );

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe(BUILD_DEPS_CODE);
    expect(error.cause).toBe(readFailure);
  });
});
