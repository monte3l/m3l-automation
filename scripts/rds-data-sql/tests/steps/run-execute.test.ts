import { afterEach, describe, expect, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return { ...actual, Core: { ...actual.Core, confirmDestructive: vi.fn() } };
});

import { Core } from "@m3l-automation/m3l-common";

import type { AWS } from "@m3l-automation/m3l-common";

import { runExecute } from "../../src/steps/run-execute.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `run-execute` row —
 * normalization (`leading whitespace stripped, then leading --…/ /*…*\/
 * comments stripped, repeated`), the first-keyword-token `SELECT` check
 * (case-insensitive), and the `Core.confirmDestructive` gate (`yes`,
 * `code: "ERR_RDS_DATA_SQL_ABORTED"`) for anything else.
 *
 * `run-execute`'s injected-deps shape isn't pre-declared — this file defines
 * it as the contract the implementer builds against:
 *
 * ```ts
 * interface RunExecuteDeps {
 *   readonly rdsData: Pick<AWS.M3LRDSDataOperations, "executeStatement">;
 *   readonly resourceArn: string;
 *   readonly secretArn: string;
 *   readonly database?: string;
 *   readonly schema?: string;
 *   readonly sql: string;
 *   readonly parameters: readonly AWS.M3LRDSDataParameter[];
 *   readonly yes: boolean;
 *   readonly prompt: Core.M3LPrompt;
 *   readonly logger: Core.M3LLogger;
 * }
 * function runExecute(deps: RunExecuteDeps): Promise<{ readonly rowsAffected: number }>;
 * ```
 */

const confirmDestructiveMock = vi.mocked(Core.confirmDestructive);

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

function makePrompt(): Core.M3LPrompt {
  const adapter = {
    input: vi.fn(),
    password: vi.fn(),
    number: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    checkbox: vi.fn(),
    search: vi.fn(),
  };
  return new Core.M3LPrompt({ adapter });
}

function statementResult(
  numberOfRecordsUpdated: number,
): AWS.M3LRDSDataStatementResult {
  return { rows: [], columns: [], numberOfRecordsUpdated, generatedFields: [] };
}

afterEach(() => {
  vi.restoreAllMocks();
  confirmDestructiveMock.mockReset();
});

describe("runExecute", () => {
  test("a plain SELECT runs directly, never invoking the destructive-confirmation gate", async () => {
    const executeStatement = vi.fn().mockResolvedValue(statementResult(0));

    const result = await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "SELECT * FROM t",
      parameters: [],
      yes: false,
      prompt: makePrompt(),
      logger: makeLogger(),
    });

    expect(confirmDestructiveMock).not.toHaveBeenCalled();
    expect(executeStatement).toHaveBeenCalledTimes(1);
    expect(result.rowsAffected).toBe(0);
  });

  test("a non-SELECT statement is gated behind confirmDestructive before running", async () => {
    confirmDestructiveMock.mockResolvedValue(undefined);
    const executeStatement = vi.fn().mockResolvedValue(statementResult(3));

    const result = await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "UPDATE t SET x = 1",
      parameters: [],
      yes: false,
      prompt: makePrompt(),
      logger: makeLogger(),
    });

    expect(confirmDestructiveMock).toHaveBeenCalledTimes(1);
    const [options] = confirmDestructiveMock.mock.calls[0] as [
      Core.M3LConfirmDestructiveOptions,
    ];
    expect(options.yes).toBe(false);
    expect(options.code).toBe("ERR_RDS_DATA_SQL_ABORTED");
    expect(executeStatement).toHaveBeenCalledTimes(1);
    expect(result.rowsAffected).toBe(3);
  });

  test("yes: true is forwarded to confirmDestructive as the bypass flag, and execution still proceeds", async () => {
    confirmDestructiveMock.mockResolvedValue(undefined);
    const executeStatement = vi.fn().mockResolvedValue(statementResult(1));

    await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "DELETE FROM t WHERE id = :id",
      parameters: [{ name: "id", value: { kind: "long", value: 1 } }],
      yes: true,
      prompt: makePrompt(),
      logger: makeLogger(),
    });

    const [options] = confirmDestructiveMock.mock.calls[0] as [
      Core.M3LConfirmDestructiveOptions,
    ];
    expect(options.yes).toBe(true);
    expect(executeStatement).toHaveBeenCalledTimes(1);
  });

  test("declining confirmation throws Core.M3LError coded ERR_RDS_DATA_SQL_ABORTED and never runs the statement", async () => {
    const aborted = new Core.M3LError("aborted: run DELETE FROM t", {
      code: "ERR_RDS_DATA_SQL_ABORTED",
    });
    confirmDestructiveMock.mockRejectedValue(aborted);
    const executeStatement = vi.fn();

    let thrown: unknown;
    try {
      await runExecute({
        rdsData: { executeStatement },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        sql: "DELETE FROM t",
        parameters: [],
        yes: false,
        prompt: makePrompt(),
        logger: makeLogger(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_RDS_DATA_SQL_ABORTED");
    expect(executeStatement).not.toHaveBeenCalled();
  });

  test("a statement prefixed by a leading '--' line comment before SELECT is still treated as SELECT", async () => {
    const executeStatement = vi.fn().mockResolvedValue(statementResult(0));

    await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "-- fetch active rows\nSELECT * FROM t WHERE active = true",
      parameters: [],
      yes: false,
      prompt: makePrompt(),
      logger: makeLogger(),
    });

    expect(confirmDestructiveMock).not.toHaveBeenCalled();
    expect(executeStatement).toHaveBeenCalledTimes(1);
  });

  test("the confirmDestructive description never embeds the statement's literal text/values, but stays informative", async () => {
    confirmDestructiveMock.mockResolvedValue(undefined);
    const executeStatement = vi.fn().mockResolvedValue(statementResult(0));
    const secretSql = "ALTER ROLE app_user WITH PASSWORD 'hunter2-secret'";

    await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: secretSql,
      parameters: [],
      yes: false,
      prompt: makePrompt(),
      logger: makeLogger(),
    });

    expect(confirmDestructiveMock).toHaveBeenCalledTimes(1);
    const [options] = confirmDestructiveMock.mock.calls[0] as [
      Core.M3LConfirmDestructiveOptions,
    ];
    expect(options.description).not.toContain("hunter2-secret");
    expect(options.description).not.toContain(secretSql);
    expect(options.description).toContain("ALTER");
    expect(options.description).toContain(String(secretSql.length));
  });

  test("a 'WITH x AS (...) SELECT ...' CTE is NOT treated as SELECT and is gated", async () => {
    confirmDestructiveMock.mockResolvedValue(undefined);
    const executeStatement = vi.fn().mockResolvedValue(statementResult(0));

    await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "WITH x AS (SELECT 1) SELECT * FROM x",
      parameters: [],
      yes: false,
      prompt: makePrompt(),
      logger: makeLogger(),
    });

    expect(confirmDestructiveMock).toHaveBeenCalledTimes(1);
    expect(executeStatement).toHaveBeenCalledTimes(1);
  });
});
