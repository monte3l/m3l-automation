import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import {
  runQuery,
  type RunQueryCheckpoint,
} from "../../src/steps/run-query.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `run-query` row +
 * "Notes and behavior" (paging requires `ORDER BY`; `page.size` reserves
 * `limit`/`offset`) + `parameters.file` validation row, plus the
 * byte-offset resume seam design for `M3LJSONListExporter`/
 * `M3LCSVListExporter` (issue #427/F11,
 * `docs/logs/2026-08-14-rds-data-sql.md`).
 *
 * `run-query`'s exact injected-deps shape isn't pre-declared anywhere (only
 * its behavior is documented in prose) — this file defines it as the
 * contract the implementer builds against:
 *
 * ```ts
 * interface RunQueryCheckpoint {
 *   readonly offset?: number;
 *   readonly outputBytes?: number;
 *   readonly columns?: readonly string[];
 * }
 * interface RunQueryDeps {
 *   readonly rdsData: Pick<AWS.M3LRDSDataOperations, "executeStatement">;
 *   readonly resourceArn: string;
 *   readonly secretArn: string;
 *   readonly database?: string;
 *   readonly schema?: string;
 *   readonly sql: string;
 *   readonly parameters: readonly AWS.M3LRDSDataParameter[];
 *   readonly pageSize: number;
 *   readonly checkpoint: {
 *     read(): Promise<RunQueryCheckpoint>;
 *     write(checkpoint: {
 *       readonly offset: number;
 *       readonly outputBytes: number;
 *       readonly columns?: readonly string[];
 *     }): Promise<void>;
 *     delete(): Promise<void>;
 *   };
 *   readonly createWriter: (args: {
 *     readonly resumeFromByte: number;
 *     readonly columns: readonly string[] | undefined;
 *   }) => { append(record: Record<string, unknown>): Promise<void>; close(): Promise<void>; readonly bytesWritten: number };
 *   readonly toRecord: (
 *     columns: readonly AWS.M3LRDSDataColumn[],
 *     row: readonly AWS.M3LRDSDataValue[],
 *   ) => Record<string, unknown>;
 *   readonly logger: Core.M3LLogger;
 * }
 * function runQuery(deps: RunQueryDeps): Promise<{ readonly rowsRead: number }>;
 * ```
 *
 * The reserved-`limit`/`offset`-parameter-name check is asserted here (not
 * in a `resolve-settings` test) because the contract page ties it to
 * "query's paging wrapper" — this step's own responsibility, only relevant
 * when `page.size > 0`.
 *
 * DISCREPANCY NOTE (flagged for the hub / design owner): the task's "Tests
 * to write" checklist item #2 states a fresh non-CSV run's `createWriter`
 * call should carry `columns: undefined`. That conflicts with the "exact
 * design" prose above it, which says `runQuery` *always* derives
 * `columns = result.columns.map(c => c.name)` from the first response on a
 * fresh run — `RunQueryDeps` has no `outputFormat`/format concept at all, so
 * this step cannot conditionally omit `columns` based on downstream format.
 * The tests below follow the "exact design" prose (columns always populated
 * on a fresh run) since it is the more detailed, explicitly-authoritative
 * section, and note that `build-operation-deps.ts`'s `createWriter` factory
 * is the layer that actually *ignores* `columns` for non-CSV output formats.
 */

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

function longValue(value: number): AWS.M3LRDSDataValue {
  return { kind: "long", value };
}

function stringValue(value: string): AWS.M3LRDSDataValue {
  return { kind: "string", value };
}

function makeCheckpoint(initial: RunQueryCheckpoint = {}) {
  return {
    read: vi.fn().mockResolvedValue(initial),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

/** Builds a writer stub whose `bytesWritten` grows by 10 per `append` call, optionally notifying `onAppend` for cross-mock ordering assertions. */
function makeWriter(options: { readonly onAppend?: () => void } = {}) {
  let bytes = 0;
  const append = vi.fn(async (_record: Record<string, unknown>) => {
    await Promise.resolve();
    bytes += 10;
    options.onAppend?.();
  });
  return {
    append,
    close: vi.fn().mockResolvedValue(undefined),
    get bytesWritten() {
      return bytes;
    },
  };
}

/** Builds a `createWriter` factory mock that always returns `writer`, recording every call's args. */
function makeWriterFactory(
  writer: ReturnType<typeof makeWriter>,
  options: { readonly onCall?: () => void } = {},
) {
  return vi.fn(
    (_args: {
      readonly resumeFromByte: number;
      readonly columns: readonly string[] | undefined;
    }) => {
      options.onCall?.();
      return writer;
    },
  );
}

function baseColumn(name: string): AWS.M3LRDSDataColumn {
  return { name, typeName: "text", label: name };
}

function statementResult(
  rows: readonly AWS.M3LRDSDataRow[],
  columns: readonly AWS.M3LRDSDataColumn[] = [baseColumn("id")],
): AWS.M3LRDSDataStatementResult {
  return {
    rows,
    columns,
    numberOfRecordsUpdated: 0,
    generatedFields: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunQueryCheckpoint", () => {
  test("no longer carries a 'rows' field; the resume seam is offset/outputBytes/columns", () => {
    expectTypeOf<RunQueryCheckpoint>().toEqualTypeOf<{
      readonly offset?: number;
      readonly outputBytes?: number;
      readonly columns?: readonly string[];
    }>();
  });
});

describe("runQuery", () => {
  test("fresh paged run: derives columns from the first page's result before constructing the writer, then checkpoints offset/outputBytes/columns after each continued page", async () => {
    const order: string[] = [];
    const writer = makeWriter({ onAppend: () => order.push("append") });
    const createWriter = makeWriterFactory(writer, {
      onCall: () => order.push("createWriter"),
    });
    const executeStatement = vi
      .fn()
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        order.push("execute:0");
        return statementResult([[longValue(1)], [longValue(2)]]);
      })
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        order.push("execute:2");
        return statementResult([[longValue(3)], [longValue(4)]]);
      })
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        order.push("execute:4");
        return statementResult([[longValue(5)]]);
      });
    const checkpoint = makeCheckpoint();
    const toRecord = vi.fn((_columns: unknown, row: AWS.M3LRDSDataRow) => ({
      id: row[0],
    }));

    const result = await runQuery({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "SELECT id FROM t ORDER BY id",
      parameters: [],
      pageSize: 2,
      checkpoint,
      createWriter,
      toRecord,
      logger: makeLogger(),
    });

    // executeStatement's first call happens BEFORE the writer is
    // constructed — createWriter only runs once column metadata is known.
    expect(order).toEqual([
      "execute:0",
      "createWriter",
      "append",
      "append",
      "execute:2",
      "append",
      "append",
      "execute:4",
      "append",
    ]);

    expect(createWriter).toHaveBeenCalledTimes(1);
    expect(createWriter).toHaveBeenCalledWith({
      resumeFromByte: 0,
      columns: ["id"],
    });

    // Checkpoint writes happen after every continued (full) page, not the
    // final short page, carrying the writer's own bytesWritten and the
    // now-known columns.
    expect(checkpoint.write).toHaveBeenCalledTimes(2);
    expect(checkpoint.write).toHaveBeenNthCalledWith(1, {
      offset: 2,
      outputBytes: 20,
      columns: ["id"],
    });
    expect(checkpoint.write).toHaveBeenNthCalledWith(2, {
      offset: 4,
      outputBytes: 40,
      columns: ["id"],
    });

    expect(result.rowsRead).toBe(5);
    expect(checkpoint.delete).toHaveBeenCalledTimes(1);
  });

  test("fresh paged run (multi-column, CSV-shaped result): createWriter receives columns derived from the first page's result.columns", async () => {
    const csvColumns = [baseColumn("id"), baseColumn("name")];
    const writer = makeWriter();
    const createWriter = makeWriterFactory(writer);
    const executeStatement = vi
      .fn()
      .mockResolvedValueOnce(
        statementResult([[longValue(1), stringValue("a")]], csvColumns),
      );
    const checkpoint = makeCheckpoint();
    const toRecord = vi.fn(() => ({ id: 1, name: "a" }));

    await runQuery({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "SELECT id, name FROM t ORDER BY id",
      parameters: [],
      pageSize: 5,
      checkpoint,
      createWriter,
      toRecord,
      logger: makeLogger(),
    });

    expect(createWriter).toHaveBeenCalledTimes(1);
    expect(createWriter).toHaveBeenCalledWith({
      resumeFromByte: 0,
      columns: ["id", "name"],
    });
  });

  test("unpaged fresh run (page.size = 0): derives columns from the single executeStatement response before any row is appended", async () => {
    const order: string[] = [];
    const csvColumns = [baseColumn("id"), baseColumn("name")];
    const writer = makeWriter({ onAppend: () => order.push("append") });
    const createWriter = makeWriterFactory(writer, {
      onCall: () => order.push("createWriter"),
    });
    const executeStatement = vi.fn(async () => {
      await Promise.resolve();
      order.push("execute");
      return statementResult([[longValue(1), stringValue("a")]], csvColumns);
    });
    const checkpoint = makeCheckpoint();
    const toRecord = vi.fn(() => ({ id: 1, name: "a" }));

    const result = await runQuery({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "SELECT id, name FROM t",
      parameters: [],
      pageSize: 0,
      checkpoint,
      createWriter,
      toRecord,
      logger: makeLogger(),
    });

    expect(order).toEqual(["execute", "createWriter", "append"]);
    expect(createWriter).toHaveBeenCalledWith({
      resumeFromByte: 0,
      columns: ["id", "name"],
    });
    expect(result.rowsRead).toBe(1);
  });

  test("resume: constructs the writer from the checkpoint's saved byte offset/columns before running any query, and does not re-append checkpoint-derived rows", async () => {
    const order: string[] = [];
    const writer = makeWriter({ onAppend: () => order.push("append") });
    const createWriter = makeWriterFactory(writer, {
      onCall: () => order.push("createWriter"),
    });
    const executeStatement = vi.fn(
      async (_input: AWS.M3LRDSDataStatementInput) => {
        await Promise.resolve();
        order.push("execute");
        return statementResult([[longValue(51)]]);
      },
    );
    const checkpoint = makeCheckpoint({
      offset: 50,
      outputBytes: 500,
      columns: ["id"],
    });
    const toRecord = vi.fn(() => ({ id: 51 }));

    const result = await runQuery({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "SELECT id FROM t ORDER BY id",
      parameters: [],
      pageSize: 5,
      checkpoint,
      createWriter,
      toRecord,
      logger: makeLogger(),
    });

    expect(checkpoint.read).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("createWriter");
    expect(order).toContain("execute");
    expect(createWriter).toHaveBeenCalledTimes(1);
    expect(createWriter).toHaveBeenCalledWith({
      resumeFromByte: 500,
      columns: ["id"],
    });

    // Only the newly-fetched row this run is appended — nothing from the
    // checkpoint itself is re-appended (the writer resumes from its own
    // byte offset instead of being truncated-and-replayed).
    expect(writer.append).toHaveBeenCalledTimes(1);
    expect(writer.append).toHaveBeenCalledWith({ id: 51 });

    const input = executeStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataStatementInput;
    expect(input.parameters).toEqual(
      expect.arrayContaining([{ name: "offset", value: longValue(50) }]),
    );
    expect(result.rowsRead).toBe(1);
  });

  test.each(["limit", "offset"] as const)(
    "throws a coded M3LError, without calling executeStatement or createWriter, when parameters.file declares '%s' and page.size > 0",
    async (reservedName) => {
      const executeStatement = vi.fn();
      const writer = makeWriter();
      const createWriter = makeWriterFactory(writer);
      const checkpoint = makeCheckpoint();
      const toRecord = vi.fn();

      let thrown: unknown;
      try {
        await runQuery({
          rdsData: { executeStatement },
          resourceArn: "arn:aws:rds:cluster",
          secretArn: "arn:aws:secretsmanager:secret",
          sql: "SELECT id FROM t ORDER BY id",
          parameters: [{ name: reservedName, value: longValue(1) }],
          pageSize: 10,
          checkpoint,
          createWriter,
          toRecord,
          logger: makeLogger(),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Core.M3LError);
      expect((thrown as Core.M3LError).code).toBe(
        "ERR_RDS_DATA_SQL_RESERVED_PARAMETER",
      );
      expect(executeStatement).not.toHaveBeenCalled();
      expect(createWriter).not.toHaveBeenCalled();
    },
  );

  test("close() failure after an otherwise-successful run throws a coded M3LError chaining the close error, and does not delete the checkpoint", async () => {
    const closeError = new Error("close failed");
    const writer = makeWriter();
    writer.close.mockRejectedValue(closeError);
    const createWriter = makeWriterFactory(writer);
    // A resumed run whose single page is shorter than pageSize — the query
    // itself completes cleanly, so the close() failure below is the only
    // problem in this run.
    const executeStatement = vi
      .fn()
      .mockResolvedValue(statementResult([[longValue(51)]]));
    const checkpoint = makeCheckpoint({
      offset: 50,
      outputBytes: 500,
      columns: ["id"],
    });
    const toRecord = vi.fn(() => ({ id: 51 }));

    let thrown: unknown;
    try {
      await runQuery({
        rdsData: { executeStatement },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        sql: "SELECT id FROM t ORDER BY id",
        parameters: [],
        pageSize: 5,
        checkpoint,
        createWriter,
        toRecord,
        logger: makeLogger(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_RDS_DATA_SQL_OUTPUT_WRITER",
    );
    expect((thrown as Core.M3LError).cause).toBe(closeError);
    expect(checkpoint.delete).not.toHaveBeenCalled();
  });

  // `runQuery` exposes an already-constructed writer to its own `finally`
  // via an `onWriterReady` callback, so `closeWriterAfterRun`'s log-only
  // branch runs on this throw path too — mirrors the two passing tests above.
  test("close() failure while the query itself already failed is only logged — the original query error propagates unmodified", async () => {
    const closeError = new Error("close failed");
    const writer = makeWriter();
    writer.close.mockRejectedValue(closeError);
    const createWriter = makeWriterFactory(writer);
    const queryError = new Error("executeStatement failed");
    const executeStatement = vi.fn().mockRejectedValue(queryError);
    const checkpoint = makeCheckpoint({
      offset: 50,
      outputBytes: 500,
      columns: ["id"],
    });
    const toRecord = vi.fn();
    const logger = makeLogger();
    const errorSpy = vi.spyOn(logger, "error");

    let thrown: unknown;
    try {
      await runQuery({
        rdsData: { executeStatement },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        sql: "SELECT id FROM t ORDER BY id",
        parameters: [],
        pageSize: 5,
        checkpoint,
        createWriter,
        toRecord,
        logger,
      });
    } catch (error) {
      thrown = error;
    }

    // The original query error propagates, not wrapped or replaced by
    // the close() failure.
    expect(thrown).toBe(queryError);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(checkpoint.delete).not.toHaveBeenCalled();
  });

  test("propagates M3LRDSDataResultTooLargeError unmodified, without ever constructing the writer", async () => {
    const tooLarge = new AWS.M3LRDSDataResultTooLargeError(
      "executeStatement result too large",
    );
    const executeStatement = vi.fn().mockRejectedValue(tooLarge);
    const writer = makeWriter();
    const createWriter = makeWriterFactory(writer);
    const checkpoint = makeCheckpoint();
    const toRecord = vi.fn();

    let thrown: unknown;
    try {
      await runQuery({
        rdsData: { executeStatement },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        sql: "SELECT id FROM t",
        parameters: [],
        pageSize: 0,
        checkpoint,
        createWriter,
        toRecord,
        logger: makeLogger(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(tooLarge);
    expect(thrown).toBeInstanceOf(AWS.M3LRDSDataResultTooLargeError);
    expect(createWriter).not.toHaveBeenCalled();
  });
});
