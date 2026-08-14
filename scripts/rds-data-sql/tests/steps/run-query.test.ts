import { afterEach, describe, expect, test, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runQuery } from "../../src/steps/run-query.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `run-query` row +
 * "Notes and behavior" (paging requires `ORDER BY`; `page.size` reserves
 * `limit`/`offset`) + `parameters.file` validation row.
 *
 * `run-query`'s exact injected-deps shape isn't pre-declared anywhere (only
 * its behavior is documented in prose) — this file defines it as the
 * contract the implementer builds against:
 *
 * ```ts
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
 *     read(): Promise<{ readonly offset?: number }>;
 *     write(checkpoint: { readonly offset: number }): Promise<void>;
 *     delete(): Promise<void>;
 *   };
 *   readonly writer: { append(record: Record<string, unknown>): Promise<void>; close(): Promise<void> };
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

function makeCheckpoint(initial: { readonly offset?: number } = {}) {
  return {
    read: vi.fn().mockResolvedValue(initial),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeWriter() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function baseColumn(name: string): AWS.M3LRDSDataColumn {
  return { name, typeName: "text", label: name };
}

function statementResult(
  rows: readonly AWS.M3LRDSDataRow[],
): AWS.M3LRDSDataStatementResult {
  return {
    rows,
    columns: [baseColumn("id")],
    numberOfRecordsUpdated: 0,
    generatedFields: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runQuery", () => {
  test("paged happy path: wraps the sql, advances offset by page.size, stops on a short page", async () => {
    const executeStatement = vi
      .fn()
      .mockResolvedValueOnce(statementResult([[longValue(1)], [longValue(2)]]))
      .mockResolvedValueOnce(statementResult([[longValue(3)]]));
    const checkpoint = makeCheckpoint();
    const writer = makeWriter();
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
      writer,
      toRecord,
      logger: makeLogger(),
    });

    expect(executeStatement).toHaveBeenCalledTimes(2);

    const firstInput = executeStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataStatementInput;
    expect(firstInput.sql).toBe(
      "SELECT * FROM (SELECT id FROM t ORDER BY id) AS m3l_page LIMIT :limit OFFSET :offset",
    );
    expect(firstInput.parameters).toEqual(
      expect.arrayContaining([
        { name: "limit", value: longValue(2) },
        { name: "offset", value: longValue(0) },
      ]),
    );

    const secondInput = executeStatement.mock
      .calls[1]?.[0] as AWS.M3LRDSDataStatementInput;
    expect(secondInput.parameters).toEqual(
      expect.arrayContaining([{ name: "offset", value: longValue(2) }]),
    );

    // Loop stopped after the second (short) page — no third call.
    expect(result.rowsRead).toBe(3);
    expect(writer.append).toHaveBeenCalledTimes(3);
    expect(checkpoint.delete).toHaveBeenCalledTimes(1);
  });

  test("page.size = 0 issues the caller's statement unpaged, once, with no LIMIT/OFFSET wrap", async () => {
    const executeStatement = vi
      .fn()
      .mockResolvedValue(statementResult([[stringValue("row-1")]]));
    const checkpoint = makeCheckpoint();
    const writer = makeWriter();
    const toRecord = vi.fn(() => ({ value: "row-1" }));

    const result = await runQuery({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "SELECT value FROM t",
      parameters: [{ name: "active", value: { kind: "boolean", value: true } }],
      pageSize: 0,
      checkpoint,
      writer,
      toRecord,
      logger: makeLogger(),
    });

    expect(executeStatement).toHaveBeenCalledTimes(1);
    const input = executeStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataStatementInput;
    expect(input.sql).toBe("SELECT value FROM t");
    expect(input.parameters).toEqual([
      { name: "active", value: { kind: "boolean", value: true } },
    ]);
    expect(result.rowsRead).toBe(1);
  });

  test("resumes from the checkpoint's saved offset rather than starting at 0", async () => {
    const executeStatement = vi
      .fn()
      .mockResolvedValue(statementResult([[longValue(51)]]));
    const checkpoint = makeCheckpoint({ offset: 50 });
    const writer = makeWriter();
    const toRecord = vi.fn(() => ({ id: 51 }));

    await runQuery({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "SELECT id FROM t ORDER BY id",
      parameters: [],
      pageSize: 5,
      checkpoint,
      writer,
      toRecord,
      logger: makeLogger(),
    });

    expect(checkpoint.read).toHaveBeenCalledTimes(1);
    const input = executeStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataStatementInput;
    expect(input.parameters).toEqual(
      expect.arrayContaining([{ name: "offset", value: longValue(50) }]),
    );
  });

  test.each(["limit", "offset"] as const)(
    "throws a coded M3LError, without calling executeStatement, when parameters.file declares '%s' and page.size > 0",
    async (reservedName) => {
      const executeStatement = vi.fn();
      const checkpoint = makeCheckpoint();
      const writer = makeWriter();
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
          writer,
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
    },
  );

  test("propagates M3LRDSDataResultTooLargeError unmodified when a page's encoded result exceeds the cap", async () => {
    const tooLarge = new AWS.M3LRDSDataResultTooLargeError(
      "executeStatement result too large",
    );
    const executeStatement = vi.fn().mockRejectedValue(tooLarge);
    const checkpoint = makeCheckpoint();
    const writer = makeWriter();
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
        writer,
        toRecord,
        logger: makeLogger(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(tooLarge);
    expect(thrown).toBeInstanceOf(AWS.M3LRDSDataResultTooLargeError);
  });
});
