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
  yesSensitive: false,
};

/** The resolved AWS identity forwarded through every `buildDeps()` bag. */
const AWS_TARGET: Core.M3LDestructiveTarget = { profile: "dev-sandbox" };

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
    awsTarget: AWS_TARGET,
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

/**
 * Spies on `Core.M3LCheckpointStore`'s constructor so a test can inspect the
 * exact options object (in particular `definition`) passed by
 * `buildOperationDeps` — while still constructing a REAL store underneath
 * (`mockImplementation` delegates to the captured original class), so every
 * other test in this file that relies on the real store's `read()`/`write()`
 * behavior (parse errors, co-occurrence checks, safe-integer checks) is
 * unaffected. A plain `function` expression is required for the
 * implementation (not an arrow) so `new Core.M3LCheckpointStore(...)`'s call
 * site still works when the mock's implementation itself constructs the real
 * class and returns it — `new` on a function that returns an object uses
 * that returned object, mirroring `athena-query`'s
 * `run-athena-query.test.ts` "mockedStore" pattern but delegating to the real
 * implementation instead of a stub. Restored by the file's existing
 * `afterEach(() => vi.restoreAllMocks())`.
 */
function spyOnCheckpointStoreCtor(): ReturnType<
  typeof vi.spyOn<typeof Core, "M3LCheckpointStore">
> {
  const OriginalCheckpointStore = Core.M3LCheckpointStore;
  return vi
    .spyOn(Core, "M3LCheckpointStore")
    .mockImplementation(function mockedStore(
      this: unknown,
      options: Core.M3LCheckpointStoreOptions<Record<string, unknown>>,
    ) {
      return new OriginalCheckpointStore(options);
    } as unknown as typeof Core.M3LCheckpointStore);
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
  test("query's checkpoint validator rejects a 'columns' array containing a non-string entry", async () => {
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

    // A checkpoint file whose 'columns' field is present but holds a
    // non-string entry (rows is gone; columns is the new resume-seam field
    // for CSV output) must be rejected the same way an unparseable file
    // would be — M3LCheckpointStore treats a validate() failure identically
    // to malformed JSON.
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ columns: [123] }),
    );

    const thrown = await captureThrown(() => queryDeps.checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("query's checkpoint validator rejects an 'outputBytes' that isn't a number", async () => {
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

    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ outputBytes: "not-a-number" }),
    );

    const thrown = await captureThrown(() => queryDeps.checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("load's checkpoint validator rejects a 'failedOutputBytes' that isn't a number", async () => {
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

    // `failedRecords` is gone — a malformed `failedOutputBytes` (the new
    // resume-seam field) must be rejected the same way an unparseable file
    // would be.
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ failedOutputBytes: "not-a-number" }),
    );

    const thrown = await captureThrown(() => loadDeps.checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("load's checkpoint validator rejects a 'failedCount' that isn't a number", async () => {
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

    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ failedCount: "not-a-number" }),
    );

    const thrown = await captureThrown(() => loadDeps.checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });
});

/** Builds a fresh 'query' operation's checkpoint port, mirroring the "checkpoint validation" describe block's setup. */
async function getQueryCheckpoint(): Promise<{
  read(): Promise<unknown>;
}> {
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
  return queryDeps.checkpoint;
}

/** Builds a fresh 'load' operation's checkpoint port, mirroring the "checkpoint validation" describe block's setup. */
async function getLoadCheckpoint(): Promise<{
  read(): Promise<unknown>;
}> {
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
  return loadDeps.checkpoint;
}

describe("buildOperationDeps: checkpoint co-occurrence validation (offset<->outputBytes, chunkIndex<->failedOutputBytes<->recordsProcessed)", () => {
  test("query's checkpoint validator rejects 'offset' present without 'outputBytes'", async () => {
    const checkpoint = await getQueryCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ offset: 5 }));

    const thrown = await captureThrown(() => checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("query's checkpoint validator rejects 'outputBytes' present without 'offset'", async () => {
    const checkpoint = await getQueryCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ outputBytes: 5 }),
    );

    const thrown = await captureThrown(() => checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("query's checkpoint validator accepts 'offset' and 'outputBytes' present together", async () => {
    const checkpoint = await getQueryCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ offset: 5, outputBytes: 100 }),
    );

    await expect(checkpoint.read()).resolves.toEqual({
      offset: 5,
      outputBytes: 100,
    });
  });

  test("query's checkpoint validator accepts neither 'offset' nor 'outputBytes' present (a fresh, not-yet-progressed checkpoint)", async () => {
    const checkpoint = await getQueryCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({}));

    await expect(checkpoint.read()).resolves.toEqual({});
  });

  test("load's checkpoint validator rejects 'chunkIndex' present without 'failedOutputBytes'", async () => {
    const checkpoint = await getLoadCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ chunkIndex: 5 }),
    );

    const thrown = await captureThrown(() => checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("load's checkpoint validator rejects 'failedOutputBytes' present without 'chunkIndex'", async () => {
    const checkpoint = await getLoadCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ failedOutputBytes: 5 }),
    );

    const thrown = await captureThrown(() => checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("load's checkpoint validator rejects 'recordsProcessed' present without 'chunkIndex' or 'failedOutputBytes'", async () => {
    const checkpoint = await getLoadCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ recordsProcessed: 30 }),
    );

    const thrown = await captureThrown(() => checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("load's checkpoint validator rejects 'chunkIndex' and 'failedOutputBytes' present without 'recordsProcessed'", async () => {
    const checkpoint = await getLoadCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ chunkIndex: 5, failedOutputBytes: 100 }),
    );

    const thrown = await captureThrown(() => checkpoint.read());

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_PARSE",
    );
  });

  test("load's checkpoint validator accepts 'chunkIndex', 'failedOutputBytes', and 'recordsProcessed' present together", async () => {
    const checkpoint = await getLoadCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({
        chunkIndex: 5,
        failedOutputBytes: 100,
        recordsProcessed: 30,
      }),
    );

    await expect(checkpoint.read()).resolves.toEqual({
      chunkIndex: 5,
      failedOutputBytes: 100,
      recordsProcessed: 30,
    });
  });

  test("load's checkpoint validator accepts neither 'chunkIndex', 'failedOutputBytes', nor 'recordsProcessed' present (a fresh, not-yet-progressed checkpoint)", async () => {
    const checkpoint = await getLoadCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({}));

    await expect(checkpoint.read()).resolves.toEqual({});
  });
});

describe("buildOperationDeps: checkpoint safe-integer validation", () => {
  /**
   * Every numeric checkpoint field this step validates, paired with the
   * companion field(s) that must also be present to satisfy the
   * co-occurrence check exercised in the describe block above — so each
   * case below isolates the safe-integer check alone.
   */
  const FIELD_CASES = [
    ["query", "offset", { outputBytes: 100 }] as const,
    ["query", "outputBytes", { offset: 5 }] as const,
    ["load", "chunkIndex", { failedOutputBytes: 100 }] as const,
    ["load", "failedOutputBytes", { chunkIndex: 5 }] as const,
    ["load", "failedCount", {}] as const,
    ["load", "recordsProcessed", {}] as const,
  ];

  /**
   * `NaN` cannot appear in valid JSON text (`JSON.parse` rejects the bare
   * `NaN` token as a syntax error), so it's produced by stubbing
   * `JSON.parse`'s return value directly instead of via `readFile`'s
   * string content — mirroring what a corrupted-in-place checkpoint file's
   * already-decoded value would look like to `M3LCheckpointStore.read()`'s
   * `validate()` step.
   */
  const BAD_VALUES = [
    ["NaN", Number.NaN] as const,
    ["-1", -1] as const,
    ["1.5 (non-integer)", 1.5] as const,
  ];

  const SAFE_INTEGER_CASES = FIELD_CASES.flatMap(
    ([operation, field, companion]) =>
      BAD_VALUES.map(
        ([label, value]) =>
          [operation, field, label, value, companion] as const,
      ),
  );

  test.each(SAFE_INTEGER_CASES)(
    "%s's checkpoint validator rejects a non-safe-integer '%s' value of %s",
    async (operation, field, _label, value, companion) => {
      const checkpoint =
        operation === "query"
          ? await getQueryCheckpoint()
          : await getLoadCheckpoint();
      vi.mocked(fsp.readFile).mockResolvedValue("{}");
      vi.spyOn(JSON, "parse").mockReturnValueOnce({
        ...companion,
        [field]: value,
      });

      const thrown = await captureThrown(() => checkpoint.read());

      expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
      expect((thrown as Core.M3LCheckpointError).code).toBe(
        "ERR_CHECKPOINT_PARSE",
      );
    },
  );

  test("a well-formed checkpoint with every field a valid safe non-negative integer is accepted", async () => {
    const queryCheckpoint = await getQueryCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ offset: 5, outputBytes: 100, columns: ["id"] }),
    );

    await expect(queryCheckpoint.read()).resolves.toEqual({
      offset: 5,
      outputBytes: 100,
      columns: ["id"],
    });

    const loadCheckpoint = await getLoadCheckpoint();
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({
        chunkIndex: 3,
        failedOutputBytes: 200,
        failedCount: 4,
        recordsProcessed: 40,
      }),
    );

    await expect(loadCheckpoint.read()).resolves.toEqual({
      chunkIndex: 3,
      failedOutputBytes: 200,
      failedCount: 4,
      recordsProcessed: 40,
    });
  });
});

describe("buildOperationDeps: query createWriter", () => {
  test("returns a createWriter factory (not a pre-built writer), deferring the exporter's fs.createWriteStream call until it is invoked", async () => {
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

    // No fs.createWriteStream call has happened yet — buildQueryDeps no
    // longer eagerly opens the output file, since resumeFromByte/columns
    // (needed by a CSV resume) are only known once the caller has read its
    // own checkpoint.
    expect(fs.createWriteStream).not.toHaveBeenCalled();
    expect(result.query?.createWriter).toBeTypeOf("function");
    expect(
      (result.query as unknown as { writer?: unknown }).writer,
    ).toBeUndefined();

    result.query?.createWriter({ resumeFromByte: 0, columns: undefined });
    expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
    expect(fs.createWriteStream).toHaveBeenCalledWith(
      expect.stringContaining("out.json"),
    );
  });

  test("forwards a nonzero resumeFromByte into the underlying exporter's fs.createWriteStream call ({ flags: 'r+', start })", async () => {
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1",
          outputFile: "out.jsonl",
          outputFormat: "jsonl",
        }),
      ),
    );
    stubWriteStream();

    result.query?.createWriter({ resumeFromByte: 250, columns: undefined });

    expect(fs.createWriteStream).toHaveBeenCalledWith(
      expect.stringContaining("out.jsonl"),
      { flags: "r+", start: 250 },
    );
  });

  test("for CSV output, forwards 'columns' into the exporter — proven by the exporter's own resume-requires-columns validation firing when columns is omitted", async () => {
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1",
          outputFile: "out.csv",
          outputFormat: "csv",
        }),
      ),
    );
    stubWriteStream();

    // M3LCSVListExporter itself throws ERR_CSV_EXPORT when resumeFromByte>0
    // and columns is empty/unset — this only fires if buildQueryDeps's
    // createWriter factory actually threads the caller's columns argument
    // through to the exporter's construction options.
    let thrown: unknown;
    try {
      result.query?.createWriter({ resumeFromByte: 100, columns: undefined });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_CSV_EXPORT");

    // Supplying columns avoids that same validation error.
    expect(() =>
      result.query?.createWriter({
        resumeFromByte: 100,
        columns: ["id", "name"],
      }),
    ).not.toThrow();
  });

  test("for json/jsonl output, a nonzero resumeFromByte with no columns does not throw (columns is CSV-only)", async () => {
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1",
          outputFile: "out.json",
          outputFormat: "json",
        }),
      ),
    );
    stubWriteStream();

    expect(() =>
      result.query?.createWriter({ resumeFromByte: 100, columns: undefined }),
    ).not.toThrow();
  });
});

describe("buildOperationDeps: load createFailedWriter", () => {
  test("returns a createFailedWriter factory (not a pre-built failedWriter), deferring the exporter's fs.createWriteStream call until it is invoked", async () => {
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

    expect(fs.createWriteStream).not.toHaveBeenCalled();
    expect(result.load?.createFailedWriter).toBeTypeOf("function");
    expect(
      (result.load as unknown as { failedWriter?: unknown }).failedWriter,
    ).toBeUndefined();

    result.load?.createFailedWriter(0);
    expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
    expect(fs.createWriteStream).toHaveBeenCalledWith(
      expect.stringContaining("failed.jsonl"),
    );
  });

  test("forwards a nonzero resumeFromByte into the underlying exporter's fs.createWriteStream call ({ flags: 'r+', start })", async () => {
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          table: "users",
          inputFile: "users.jsonl",
        }),
      ),
    );
    stubWriteStream();

    result.load?.createFailedWriter(750);

    expect(fs.createWriteStream).toHaveBeenCalledWith(
      expect.stringContaining("failed.jsonl"),
      { flags: "r+", start: 750 },
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

  test("forwards 'awsTarget' and 'settings.yesSensitive' into RunExecuteDeps", async () => {
    const result = await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "execute",
          sql: "DELETE FROM t",
          yes: true,
          yesSensitive: true,
        }),
      ),
    );

    expect(result.execute?.awsTarget).toEqual(AWS_TARGET);
    expect(result.execute?.yesSensitive).toBe(true);
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

/**
 * Issue #497 (A4b): retrofits `buildQueryDeps`/`buildLoadDeps`'s
 * `Core.M3LCheckpointStore` construction with a `definition` option, so a
 * leftover checkpoint from a differently-configured prior run now throws
 * `ERR_CHECKPOINT_FINGERPRINT_MISMATCH` on `read()` instead of silently
 * being reused (both stores' `read()` calls are unconditional in
 * `run-query.ts`/`run-load.ts` — not gated behind `--resume`).
 *
 * Per docs/reference/core/checkpoint.md, `secretArn` (a rotatable
 * credential locator) must never appear in a `definition` — the fingerprint
 * is an unkeyed hash, so a low-entropy definition is brute-forceable but a
 * secret trivially isn't meant to be recoverable at all. The same rule
 * covers a resolved SQL bind `parameter`'s raw `value` (caller-supplied
 * data, not run shape) — `buildQueryDeps` projects each parameter down to
 * `name`/`kind`/optional `typeHint` via `projectParameterShape` before it
 * ever reaches the `definition`.
 */
describe("buildOperationDeps: query checkpoint definition (issue #497 A4b)", () => {
  test("constructs the query checkpoint store with a definition projecting resourceArn/database/schema/resolved-sql/resolved-parameters/outputFile/outputFormat/paged, excluding secretArn/raw pageSize/load-only fields", async () => {
    stubWriteStream();
    const ctorSpy = spyOnCheckpointStoreCtor();
    const parameters: readonly AWS.M3LRDSDataParameter[] = [
      { name: "id", value: { kind: "long", value: 1 } },
    ];
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(parameters));

    await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          schema: "public",
          sql: "SELECT 1 FROM t",
          parametersFile: "params.json",
          outputFile: "out.json",
          outputFormat: "csv",
          pageSize: 50,
        }),
      ),
    );

    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const [options] = ctorSpy.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    const definition = options["definition"];
    expect(definition).toBeDefined();
    const def = definition as Record<string, unknown>;

    expect(def["resourceArn"]).toBe(BASE_SETTINGS.resourceArn);
    expect(def["database"]).toBe("testdb");
    expect(def["schema"]).toBe("public");
    // The RESOLVED sql text (buildQueryDeps's local `sql` variable, already
    // read from `sql.file` when set) — not `settings.sql`/`settings.sqlFile`,
    // since a `sqlFile`'s on-disk contents can change under a fixed path.
    expect(def["sql"]).toBe("SELECT 1 FROM t");
    // The RESOLVED parameters, PROJECTED to name/kind/typeHint (never the raw
    // bind value — docs/reference/core/checkpoint.md forbids a secret/credential
    // in a definition, and a bind value is caller-supplied data, not run shape).
    expect(def["parameters"]).toEqual([{ name: "id", kind: "long" }]);
    expect(def["outputFile"]).toBe("out.json");
    expect(def["outputFormat"]).toBe("csv");
    expect(def["paged"]).toBe(true);

    expect(Object.hasOwn(def, "secretArn")).toBe(false);
    expect(Object.hasOwn(def, "pageSize")).toBe(false);
    expect(Object.hasOwn(def, "batchSize")).toBe(false);
    expect(Object.hasOwn(def, "table")).toBe(false);
    expect(Object.hasOwn(def, "columns")).toBe(false);
    expect(Object.hasOwn(def, "inputFile")).toBe(false);
    expect(Object.hasOwn(def, "inputFormat")).toBe(false);
  });

  test("never fingerprints a SQL bind parameter's raw value", async () => {
    stubWriteStream();
    const ctorSpy = spyOnCheckpointStoreCtor();
    // A distinguishing, greppable literal standing in for a real secret bind
    // value (e.g. a PII column or credential passed as a query parameter) —
    // if `buildQueryDeps` ever regressed to fingerprinting the raw `value`
    // instead of the projected name/kind/typeHint shape, this literal would
    // show up verbatim in the definition passed to `M3LCheckpointStore`.
    const parameters: readonly AWS.M3LRDSDataParameter[] = [
      {
        name: "ssn",
        value: { kind: "string", value: "planted-secret-bind-value" },
      },
      // A `typeHint` is metadata describing HOW the value is sent, not the
      // value itself — it's expected to survive the projection.
      {
        name: "amount",
        value: { kind: "double", value: 42 },
        typeHint: "DECIMAL",
      },
    ];
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(parameters));

    await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "query",
          sql: "SELECT 1 FROM t",
          parametersFile: "params.json",
          outputFile: "out.json",
        }),
      ),
    );

    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const [options] = ctorSpy.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    const def = options["definition"] as Record<string, unknown>;

    expect(def["parameters"]).toEqual([
      { name: "ssn", kind: "string" },
      { name: "amount", kind: "double", typeHint: "DECIMAL" },
    ]);
    // Belt-and-suspenders: the planted literal cannot leak through any other
    // path in the definition object either.
    expect(JSON.stringify(def).includes("planted-secret-bind-value")).toBe(
      false,
    );
  });

  test.each([
    [0, false],
    [50, true],
  ])(
    "derives 'paged' from settings.pageSize > 0 (pageSize=%s -> paged=%s)",
    async (pageSize, expectedPaged) => {
      stubWriteStream();
      const ctorSpy = spyOnCheckpointStoreCtor();

      await buildOperationDeps(
        buildDeps(
          makeSettings({
            operation: "query",
            sql: "SELECT 1",
            outputFile: "out.json",
            pageSize,
          }),
        ),
      );

      expect(ctorSpy).toHaveBeenCalledTimes(1);
      const [options] = ctorSpy.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ];
      const def = options["definition"] as Record<string, unknown>;
      expect(def["paged"]).toBe(expectedPaged);
    },
  );
});

describe("buildOperationDeps: load checkpoint definition (issue #497 A4b)", () => {
  test("constructs the load checkpoint store with a definition projecting resourceArn/database/schema/table/columns/inputFile/inputFormat/batchSize (meaning-bearing here), excluding secretArn/pageSize/outputFile/outputFormat/yes", async () => {
    stubWriteStream();
    const ctorSpy = spyOnCheckpointStoreCtor();

    await buildOperationDeps(
      buildDeps(
        makeSettings({
          operation: "load",
          schema: "public",
          table: "users",
          columns: ["id", "name"],
          inputFile: "users.jsonl",
          inputFormat: "csv",
          batchSize: 250,
        }),
      ),
    );

    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const [options] = ctorSpy.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    const definition = options["definition"];
    expect(definition).toBeDefined();
    const def = definition as Record<string, unknown>;

    expect(def["resourceArn"]).toBe(BASE_SETTINGS.resourceArn);
    expect(def["database"]).toBe("testdb");
    expect(def["schema"]).toBe("public");
    expect(def["table"]).toBe("users");
    expect(def["columns"]).toEqual(["id", "name"]);
    expect(def["inputFile"]).toBe("users.jsonl");
    expect(def["inputFormat"]).toBe("csv");
    // Unlike the query store's page size, batchSize IS meaning-bearing here
    // — the load checkpoint's chunkIndex counts chunks sized by batchSize.
    expect(def["batchSize"]).toBe(250);

    expect(Object.hasOwn(def, "secretArn")).toBe(false);
    expect(Object.hasOwn(def, "pageSize")).toBe(false);
    expect(Object.hasOwn(def, "outputFile")).toBe(false);
    expect(Object.hasOwn(def, "outputFormat")).toBe(false);
    expect(Object.hasOwn(def, "yes")).toBe(false);
  });
});
