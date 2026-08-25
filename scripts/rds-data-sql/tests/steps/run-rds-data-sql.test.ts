import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/steps/run-query.js", () => ({ runQuery: vi.fn() }));
vi.mock("../../src/steps/run-load.js", () => ({ runLoad: vi.fn() }));
vi.mock("../../src/steps/run-execute.js", () => ({ runExecute: vi.fn() }));
vi.mock("../../src/steps/run-migrate.js", () => ({ runMigrate: vi.fn() }));
vi.mock("../../src/steps/preflight-secret.js", () => ({
  preflightSecret: vi.fn(),
}));

import { Core } from "@m3l-automation/m3l-common";

import { runQuery } from "../../src/steps/run-query.js";
import { runLoad } from "../../src/steps/run-load.js";
import { runExecute } from "../../src/steps/run-execute.js";
import { runMigrate } from "../../src/steps/run-migrate.js";
import { preflightSecret } from "../../src/steps/preflight-secret.js";
import { runRdsDataSql } from "../../src/steps/run-rds-data-sql.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `run-rds-data-sql` row —
 * "the only module that knows operation dispatch order: preflight →
 * dispatch on `operation` (exhaustive `switch`) → the matching read/write
 * step → emit a run summary"; `load` no longer maps a partial failure to a
 * throw here — `runRdsDataSql` resolves normally when `load`'s summary has
 * `failed > 0`, since the per-row failures are reported via `run-load.ts`'s
 * optional `reportRecovery` callback instead (a separate concern from this
 * file's own dispatch-routing test scope).
 *
 * `resolve-settings` is assumed to have already run upstream (its own
 * dispatch is a separate test-author pass per the task scope) — this file's
 * `runRdsDataSql` receives the resolved per-operation deps bags directly, as
 * an opaque pass-through object per operation (this file only asserts that
 * `run-rds-data-sql` routes to the right step and reacts to its result, not
 * the shape of any one step's own deps — that's each step's own test file).
 *
 * Invented composition-root contract (not otherwise pre-declared):
 *
 * ```ts
 * interface RunRdsDataSqlDeps {
 *   readonly operation: "query" | "load" | "execute" | "migrate";
 *   readonly secretsManager: { describeSecret: (arn: string) => Promise<unknown> };
 *   readonly secretArn: string;
 *   readonly logger: Core.M3LLogger;
 *   readonly query?: Record<string, unknown>;
 *   readonly load?: Record<string, unknown>;
 *   readonly execute?: Record<string, unknown>;
 *   readonly migrate?: Record<string, unknown>;
 * }
 * function runRdsDataSql(deps: RunRdsDataSqlDeps): Promise<void>;
 * ```
 */

const runQueryMock = vi.mocked(runQuery);
const runLoadMock = vi.mocked(runLoad);
const runExecuteMock = vi.mocked(runExecute);
const runMigrateMock = vi.mocked(runMigrate);
const preflightSecretMock = vi.mocked(preflightSecret);

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

function baseDeps(operation: "query" | "load" | "execute" | "migrate") {
  return {
    operation,
    secretsManager: { describeSecret: vi.fn() },
    secretArn: "arn:aws:secretsmanager:secret",
    logger: makeLogger(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  runQueryMock.mockReset();
  runLoadMock.mockReset();
  runExecuteMock.mockReset();
  runMigrateMock.mockReset();
  preflightSecretMock.mockReset();
});

describe("runRdsDataSql — operation dispatch", () => {
  test("'query' routes to runQuery only, with the query deps bag", async () => {
    preflightSecretMock.mockResolvedValue(undefined);
    runQueryMock.mockResolvedValue({ rowsRead: 5 });
    const queryDeps = { marker: "query-deps" };

    await runRdsDataSql({ ...baseDeps("query"), query: queryDeps });

    expect(runQueryMock).toHaveBeenCalledWith(queryDeps);
    expect(runLoadMock).not.toHaveBeenCalled();
    expect(runExecuteMock).not.toHaveBeenCalled();
    expect(runMigrateMock).not.toHaveBeenCalled();
  });

  test("'load' routes to runLoad only, with the load deps bag", async () => {
    preflightSecretMock.mockResolvedValue(undefined);
    runLoadMock.mockResolvedValue({ inserted: 4, failed: 0 });
    const loadDeps = { marker: "load-deps" };

    await runRdsDataSql({ ...baseDeps("load"), load: loadDeps });

    expect(runLoadMock).toHaveBeenCalledWith(loadDeps);
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(runExecuteMock).not.toHaveBeenCalled();
    expect(runMigrateMock).not.toHaveBeenCalled();
  });

  test("'execute' routes to runExecute only, with the execute deps bag", async () => {
    preflightSecretMock.mockResolvedValue(undefined);
    runExecuteMock.mockResolvedValue({ rowsAffected: 1 });
    const executeDeps = { marker: "execute-deps" };

    await runRdsDataSql({ ...baseDeps("execute"), execute: executeDeps });

    expect(runExecuteMock).toHaveBeenCalledWith(executeDeps);
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(runLoadMock).not.toHaveBeenCalled();
    expect(runMigrateMock).not.toHaveBeenCalled();
  });

  test("'migrate' routes to runMigrate only, with the migrate deps bag", async () => {
    preflightSecretMock.mockResolvedValue(undefined);
    runMigrateMock.mockResolvedValue({ applied: ["001_a.sql"] });
    const migrateDeps = { marker: "migrate-deps" };

    await runRdsDataSql({ ...baseDeps("migrate"), migrate: migrateDeps });

    expect(runMigrateMock).toHaveBeenCalledWith(migrateDeps);
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(runLoadMock).not.toHaveBeenCalled();
    expect(runExecuteMock).not.toHaveBeenCalled();
  });
});

describe("runRdsDataSql — preflight", () => {
  test("a preflight-secret failure short-circuits before any operation step runs", async () => {
    const preflightError = new Core.M3LError("preflight failed", {
      code: "ERR_RDS_DATA_SQL_SECRET_PREFLIGHT",
    });
    preflightSecretMock.mockRejectedValue(preflightError);

    let thrown: unknown;
    try {
      await runRdsDataSql({ ...baseDeps("query"), query: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(preflightError);
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(runLoadMock).not.toHaveBeenCalled();
    expect(runExecuteMock).not.toHaveBeenCalled();
    expect(runMigrateMock).not.toHaveBeenCalled();
  });
});

describe("runRdsDataSql — load no longer maps a partial failure to a throw", () => {
  test("resolves without throwing when load's summary has failed > 0 — the partial-failure-to-throw mapping is removed", async () => {
    preflightSecretMock.mockResolvedValue(undefined);
    runLoadMock.mockResolvedValue({ inserted: 3, failed: 2 });

    await expect(
      runRdsDataSql({ ...baseDeps("load"), load: {} }),
    ).resolves.toBeUndefined();
  });

  test("does not throw when load's summary has failed === 0", async () => {
    preflightSecretMock.mockResolvedValue(undefined);
    runLoadMock.mockResolvedValue({ inserted: 5, failed: 0 });

    await expect(
      runRdsDataSql({ ...baseDeps("load"), load: {} }),
    ).resolves.toBeUndefined();
  });
});
