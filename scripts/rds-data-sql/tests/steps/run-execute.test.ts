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

/** A target whose profile does NOT contain "prod" — never escalated. */
const NON_SENSITIVE_TARGET: Core.M3LDestructiveTarget = {
  profile: "dev-sandbox",
};

/** A target whose profile DOES contain "prod" — always escalated. */
const SENSITIVE_TARGET: Core.M3LDestructiveTarget = { profile: "prod" };

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

/**
 * A fresh, individually-mockable adapter. `M3LPrompt.confirm`/`.text` map
 * directly onto `adapter.confirm`/`adapter.input` (there is no separate
 * `adapter.text` method) — callers that need to assert on the escalated
 * typed-echo prompt spy on `adapter.input`.
 */
function makeAdapter() {
  return {
    input: vi.fn(),
    password: vi.fn(),
    number: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    checkbox: vi.fn(),
    search: vi.fn(),
  };
}

type PromptAdapter = ReturnType<typeof makeAdapter>;

function makePrompt(adapter: PromptAdapter = makeAdapter()): Core.M3LPrompt {
  return new Core.M3LPrompt({ adapter });
}

/**
 * Resolves the REAL (un-mocked) `Core.confirmDestructive` implementation,
 * bypassing this file's module-level `vi.mock`. The escalation-behavior
 * tests below install this as `confirmDestructiveMock`'s implementation so
 * they exercise the actual target-grading logic (states 3-5 of
 * `M3LDestructiveGate`'s contract) rather than asserting on call args alone
 * — `afterEach`'s `confirmDestructiveMock.mockReset()` clears the
 * implementation back to a bare stub before the next test.
 */
async function getActualConfirmDestructive(): Promise<
  typeof Core.confirmDestructive
> {
  const actual = await vi.importActual<typeof M3LCommon>(
    "@m3l-automation/m3l-common",
  );
  return actual.Core.confirmDestructive;
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
      awsTarget: NON_SENSITIVE_TARGET,
      yesSensitive: false,
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
      awsTarget: NON_SENSITIVE_TARGET,
      yesSensitive: false,
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
      awsTarget: NON_SENSITIVE_TARGET,
      yesSensitive: false,
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
        awsTarget: NON_SENSITIVE_TARGET,
        yesSensitive: false,
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
      awsTarget: NON_SENSITIVE_TARGET,
      yesSensitive: false,
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
      awsTarget: NON_SENSITIVE_TARGET,
      yesSensitive: false,
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
      awsTarget: NON_SENSITIVE_TARGET,
      yesSensitive: false,
    });

    expect(confirmDestructiveMock).toHaveBeenCalledTimes(1);
    expect(executeStatement).toHaveBeenCalledTimes(1);
  });
});

/**
 * Contract: ADR-0048's target-graded destructive confirmation, retrofitted
 * onto `run-execute.ts`'s single `Core.confirmDestructive` call site.
 * `deps.awsTarget` (this script's resolved `aws.profile` identity — always
 * defined, since `aws.profile` is declared `required: true` + `nonEmpty`)
 * and `deps.yesSensitive` are forwarded as `target`/`yesSensitive`, alongside
 * an `isSensitiveTarget` predicate matching this retrofit's documented
 * classification: `target.profile.toLowerCase().includes("prod")`.
 *
 * Unlike the `describe("runExecute", ...)` block above, these tests install
 * the REAL `Core.confirmDestructive` implementation (via
 * `getActualConfirmDestructive`) so the escalation/bypass/plain-confirm
 * branching is exercised end-to-end against a controllable prompt adapter,
 * rather than merely asserting on the options object handed to a stub.
 */
describe("runExecute: target-graded destructive confirmation (ADR-0048)", () => {
  test("escalates to the typed-echo prompt when the target's profile contains 'prod'", async () => {
    confirmDestructiveMock.mockImplementation(
      await getActualConfirmDestructive(),
    );
    const executeStatement = vi.fn().mockResolvedValue(statementResult(1));
    const adapter = makeAdapter();
    adapter.input.mockResolvedValue("prod");

    const result = await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "DELETE FROM t",
      parameters: [],
      yes: false,
      prompt: makePrompt(adapter),
      logger: makeLogger(),
      awsTarget: SENSITIVE_TARGET,
      yesSensitive: false,
    });

    expect(adapter.input).toHaveBeenCalledTimes(1);
    expect(adapter.confirm).not.toHaveBeenCalled();
    expect(executeStatement).toHaveBeenCalledTimes(1);
    expect(result.rowsAffected).toBe(1);
  });

  test("throws ERR_RDS_DATA_SQL_ABORTED when the typed-echo input doesn't match the profile", async () => {
    confirmDestructiveMock.mockImplementation(
      await getActualConfirmDestructive(),
    );
    const executeStatement = vi.fn();
    const adapter = makeAdapter();
    adapter.input.mockResolvedValue("not-the-profile");

    let thrown: unknown;
    try {
      await runExecute({
        rdsData: { executeStatement },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        sql: "DELETE FROM t",
        parameters: [],
        yes: false,
        prompt: makePrompt(adapter),
        logger: makeLogger(),
        awsTarget: SENSITIVE_TARGET,
        yesSensitive: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_RDS_DATA_SQL_ABORTED");
    expect(executeStatement).not.toHaveBeenCalled();
  });

  test("bypasses with a warning when yes and yesSensitive are both true for a sensitive target", async () => {
    confirmDestructiveMock.mockImplementation(
      await getActualConfirmDestructive(),
    );
    const executeStatement = vi.fn().mockResolvedValue(statementResult(2));
    const adapter = makeAdapter();
    const logger = makeLogger();
    const warningSpy = vi.spyOn(logger, "warning");

    const result = await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "DELETE FROM t",
      parameters: [],
      yes: true,
      prompt: makePrompt(adapter),
      logger,
      awsTarget: SENSITIVE_TARGET,
      yesSensitive: true,
    });

    expect(adapter.input).not.toHaveBeenCalled();
    expect(adapter.confirm).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0]?.[0]).toContain("prod");
    expect(executeStatement).toHaveBeenCalledTimes(1);
    expect(result.rowsAffected).toBe(2);
  });

  test("still escalates when yes:true but yesSensitive is false, for a sensitive target", async () => {
    confirmDestructiveMock.mockImplementation(
      await getActualConfirmDestructive(),
    );
    const executeStatement = vi.fn().mockResolvedValue(statementResult(1));
    const adapter = makeAdapter();
    adapter.input.mockResolvedValue("prod");

    await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "DELETE FROM t",
      parameters: [],
      yes: true,
      prompt: makePrompt(adapter),
      logger: makeLogger(),
      awsTarget: SENSITIVE_TARGET,
      yesSensitive: false,
    });

    expect(adapter.input).toHaveBeenCalledTimes(1);
    expect(adapter.confirm).not.toHaveBeenCalled();
    expect(executeStatement).toHaveBeenCalledTimes(1);
  });

  test("uses the plain confirm (not escalated) when the target is not sensitive", async () => {
    confirmDestructiveMock.mockImplementation(
      await getActualConfirmDestructive(),
    );
    const executeStatement = vi.fn().mockResolvedValue(statementResult(1));
    const adapter = makeAdapter();
    adapter.confirm.mockResolvedValue(true);

    await runExecute({
      rdsData: { executeStatement },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      sql: "DELETE FROM t",
      parameters: [],
      yes: false,
      prompt: makePrompt(adapter),
      logger: makeLogger(),
      awsTarget: NON_SENSITIVE_TARGET,
      yesSensitive: false,
    });

    expect(adapter.confirm).toHaveBeenCalledTimes(1);
    expect(adapter.input).not.toHaveBeenCalled();
    expect(executeStatement).toHaveBeenCalledTimes(1);
  });
});
