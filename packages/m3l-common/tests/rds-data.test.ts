/**
 * Tests for aws/rds-data submodule.
 *
 * Contract source: docs/reference/aws/rds-data.md ("Status: this page's ##
 * Public API section is the verified contract" — checked against the
 * installed `@aws-sdk/client-rds-data@3.1105.0` `dist-types` by a
 * `spec-conformance-reviewer` pass, 2026-08-14). The submodule under test
 * (`packages/m3l-common/src/aws/rds-data/*.ts`) is still scaffold-only —
 * every `client.ts` method is a placeholder that immediately rejects with
 * `M3LRDSDataOperationError` without ever calling `client.send()`. Every
 * test below is expected to fail RED against that placeholder until
 * `implementing-submodules` lands the real logic.
 *
 * Exports under test (from `../src/aws/rds-data/index.js`, following the
 * package's `../src/aws/index.js` barrel and the sibling
 * `tests/secrets-manager.test.ts` import convention — submodule tests import
 * from the submodule's own `index.js`, not the `aws` namespace barrel):
 *   M3LRDSDataOperations, M3LRDSDataOperationError,
 *   M3LRDSDataResultTooLargeError, and the plain M3LRDSData-prefixed types.
 *
 * Mocking strategy: `@aws-sdk/client-rds-data` is mocked with a top-level
 * `vi.mock` + `vi.hoisted` bag (this repo's convention — see
 * `tests/secrets-manager.test.ts`), with a `.send()` spy dispatching by
 * command class. Every command class is a plain recorder
 * (`constructor(input)`), so a test asserting on the command shape reads
 * `h.send.mock.calls[0][0].input`.
 *
 * Retry coverage: kept deliberately minimal per this repo's convention (see
 * `tests/secrets-manager.test.ts`'s header) — core/polling owns retry
 * mechanics. One test confirms the module-local `DatabaseResumingException`
 * classifier is wired into `combineClassifiers(...)`; the full backoff loop
 * is not retested here.
 */

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// vi.hoisted: mutable spies referenced by the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();

  class ExecuteStatementCommand {
    constructor(readonly input: unknown) {}
  }
  class BatchExecuteStatementCommand {
    constructor(readonly input: unknown) {}
  }
  class BeginTransactionCommand {
    constructor(readonly input: unknown) {}
  }
  class CommitTransactionCommand {
    constructor(readonly input: unknown) {}
  }
  class RollbackTransactionCommand {
    constructor(readonly input: unknown) {}
  }
  class RDSDataClient {
    readonly config: unknown;
    send = send;
    destroy = destroy;
    constructor(config?: unknown) {
      this.config = config;
    }
  }

  return {
    send,
    destroy,
    RDSDataClient,
    ExecuteStatementCommand,
    BatchExecuteStatementCommand,
    BeginTransactionCommand,
    CommitTransactionCommand,
    RollbackTransactionCommand,
  };
});

vi.mock("@aws-sdk/client-rds-data", () => ({
  RDSDataClient: h.RDSDataClient,
  ExecuteStatementCommand: h.ExecuteStatementCommand,
  BatchExecuteStatementCommand: h.BatchExecuteStatementCommand,
  BeginTransactionCommand: h.BeginTransactionCommand,
  CommitTransactionCommand: h.CommitTransactionCommand,
  RollbackTransactionCommand: h.RollbackTransactionCommand,
}));

import type {
  M3LRDSDataBatchInput,
  M3LRDSDataBatchResult,
  M3LRDSDataBeginTransactionInput,
  M3LRDSDataColumn,
  M3LRDSDataStatementInput,
  M3LRDSDataStatementResult,
  M3LRDSDataTransaction,
  M3LRDSDataValue,
} from "../src/aws/rds-data/index.js";
import {
  M3LRDSDataOperationError,
  M3LRDSDataOperations,
  M3LRDSDataResultTooLargeError,
} from "../src/aws/rds-data/index.js";
import { M3LError } from "../src/core/errors/index.js";

import type { RDSDataClient } from "@aws-sdk/client-rds-data";

/** Casts the hoisted fake `RDSDataClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): RDSDataClient {
  return new h.RDSDataClient() as unknown as RDSDataClient;
}

/** Reads the `input` bag from the Nth recorded `send()` call (0-indexed). */
function commandInput(callIndex = 0): Record<string, unknown> {
  const [command] = h.send.mock.calls[callIndex] as [
    { input: Record<string, unknown> },
  ];
  return command.input;
}

/** A non-retriable, fatal SDK-style error — keeps failure-path tests to exactly one `send()` call. */
function fatalError(message = "denied", name = "AccessDenied"): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * Walks an error's `.cause` chain (bounded to avoid an infinite loop on a
 * pathological cyclic cause) and returns every cause encountered, in order.
 * Used to assert a deeply-chained cause without assuming the exact wrapping
 * depth an implementation chooses.
 */
function causeChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let i = 0; i < 10; i++) {
    if (typeof current !== "object" || current === null) break;
    if (!("cause" in current)) break;
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined) break;
    chain.push(cause);
    current = cause;
  }
  return chain;
}

const RESOURCE_ARN =
  "arn:aws:rds:eu-south-1:123456789012:cluster:example-cluster";
const SECRET_ARN =
  "arn:aws:secretsmanager:eu-south-1:123456789012:secret:example-secret";

/** Sentinel planted in a parameter/row value; must never leak into an error's message or JSON. */
const SENTINEL = "SENTINEL_SECRET_VALUE";

const MINIMAL_STATEMENT_INPUT: M3LRDSDataStatementInput = {
  resourceArn: RESOURCE_ARN,
  secretArn: SECRET_ARN,
  sql: "SELECT name, age FROM users WHERE active = :active",
  parameters: [{ name: "active", value: { kind: "boolean", value: true } }],
};

const FULL_STATEMENT_INPUT: M3LRDSDataStatementInput = {
  resourceArn: RESOURCE_ARN,
  secretArn: SECRET_ARN,
  sql: "SELECT name, age FROM users WHERE active = :active",
  database: "app_db",
  schema: "public",
  parameters: [
    { name: "id", value: { kind: "string", value: "abc" }, typeHint: "UUID" },
    { name: "active", value: { kind: "boolean", value: true } },
  ],
  transactionId: "txn-9",
};

const MINIMAL_BATCH_INPUT: M3LRDSDataBatchInput = {
  resourceArn: RESOURCE_ARN,
  secretArn: SECRET_ARN,
  sql: "INSERT INTO users (name) VALUES (:name)",
  parameterSets: [[{ name: "name", value: { kind: "string", value: "Ada" } }]],
};

const MINIMAL_BEGIN_INPUT: M3LRDSDataBeginTransactionInput = {
  resourceArn: RESOURCE_ARN,
  secretArn: SECRET_ARN,
};

describe("M3LRDSDataOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

  // ===========================================================================
  // executeStatement()
  // ===========================================================================
  describe("executeStatement()", () => {
    test("maps a SELECT response's typed Field values into M3LRDSDataValue rows and columns", async () => {
      h.send.mockResolvedValueOnce({
        records: [
          [{ stringValue: "Ada" }, { longValue: 36 }],
          [{ isNull: true }, { longValue: 41 }],
        ],
        columnMetadata: [
          { name: "name", typeName: "text" },
          { name: "age", typeName: "int4" },
        ],
        numberOfRecordsUpdated: 0,
      });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result: M3LRDSDataStatementResult =
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(result.rows).toEqual([
        [
          { kind: "string", value: "Ada" },
          { kind: "long", value: 36 },
        ],
        [{ kind: "null" }, { kind: "long", value: 41 }],
      ]);
      expect(result.columns).toEqual([
        { name: "name", typeName: "text", label: "" },
        { name: "age", typeName: "int4", label: "" },
      ]);
      expect(result.numberOfRecordsUpdated).toBe(0);
    });

    test("maps generatedFields (RETURNING clause) into M3LRDSDataValue[]", async () => {
      h.send.mockResolvedValueOnce({
        generatedFields: [{ longValue: 7 }],
      });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(result.generatedFields).toEqual([{ kind: "long", value: 7 }]);
    });

    test("defaults rows/columns to [], numberOfRecordsUpdated to 0, generatedFields to [] when the SDK response omits them (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(result).toEqual({
        rows: [],
        columns: [],
        numberOfRecordsUpdated: 0,
        generatedFields: [],
      });
    });

    test("always sends includeResultMetadata: true on the command input, even with a minimal input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(commandInput()["includeResultMetadata"]).toBe(true);
    });

    test("sends resourceArn/secretArn/sql/parameters on the command input (minimal — no database/schema/transactionId)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(h.send).toHaveBeenCalledTimes(1);
      const input = commandInput();
      expect(input["resourceArn"]).toBe(MINIMAL_STATEMENT_INPUT.resourceArn);
      expect(input["secretArn"]).toBe(MINIMAL_STATEMENT_INPUT.secretArn);
      expect(input["sql"]).toBe(MINIMAL_STATEMENT_INPUT.sql);
      expect(Object.hasOwn(input, "database")).toBe(false);
      expect(Object.hasOwn(input, "schema")).toBe(false);
      expect(Object.hasOwn(input, "transactionId")).toBe(false);
    });

    test("sends database/schema/transactionId conditionally when present (full fixture)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.executeStatement(FULL_STATEMENT_INPUT);

      const input = commandInput();
      expect(input["database"]).toBe("app_db");
      expect(input["schema"]).toBe("public");
      expect(input["transactionId"]).toBe("txn-9");
    });

    test("maps M3LRDSDataParameter[] into SqlParameter[] (value + optional typeHint), mirroring the Field mapping in reverse", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.executeStatement(FULL_STATEMENT_INPUT);

      const input = commandInput();
      expect(input["parameters"]).toEqual([
        { name: "id", value: { stringValue: "abc" }, typeHint: "UUID" },
        { name: "active", value: { booleanValue: true } },
      ]);
    });

    test.each([
      [1, true],
      [0, false],
      [2, undefined],
      [undefined, undefined],
    ] as const)(
      "maps ColumnMetadata.nullable=%s to M3LRDSDataColumn.nullable=%s (omitted, never undefined, when not 1/0)",
      async (nullable, expected) => {
        h.send.mockResolvedValueOnce({
          columnMetadata: [
            {
              name: "col",
              typeName: "text",
              ...(nullable !== undefined && { nullable }),
            },
          ],
        });

        const operations = new M3LRDSDataOperations(fakeClient());
        const result = await operations.executeStatement(
          MINIMAL_STATEMENT_INPUT,
        );

        const column = result.columns[0] as M3LRDSDataColumn;
        if (expected === undefined) {
          expect(Object.hasOwn(column, "nullable")).toBe(false);
        } else {
          expect(column.nullable).toBe(expected);
        }
      },
    );

    test("defaults name/typeName/label to '' when ColumnMetadata omits them (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({ columnMetadata: [{}] });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(result.columns).toEqual([{ name: "", typeName: "", label: "" }]);
    });

    test("maps every Field member kind (string/long/double/boolean/blob/null), and isNull:false falls through instead of short-circuiting to null", async () => {
      const blob = new Uint8Array([1, 2, 3]);
      h.send.mockResolvedValueOnce({
        records: [
          [
            { isNull: true },
            { isNull: false, stringValue: "Ada" },
            { longValue: 42 },
            { doubleValue: 3.14 },
            { booleanValue: true },
            { blobValue: blob },
          ],
        ],
      });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(result.rows[0]).toEqual([
        { kind: "null" },
        { kind: "string", value: "Ada" },
        { kind: "long", value: 42 },
        { kind: "double", value: 3.14 },
        { kind: "boolean", value: true },
        { kind: "blob", value: blob },
      ]);
    });

    test("throws M3LRDSDataOperationError naming the row/column index and 'arrayValue' when a Field carries an arrayValue, without leaking a sibling column's value", async () => {
      h.send.mockResolvedValueOnce({
        records: [
          [{ stringValue: SENTINEL }, { arrayValue: { stringValues: ["x"] } }],
        ],
      });

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      const message = (thrown as M3LRDSDataOperationError).message;
      expect(message).toContain("0");
      expect(message).toContain("1");
      expect(message).toContain("arrayValue");
      expect(message).not.toContain(SENTINEL);
    });

    test("throws M3LRDSDataOperationError naming the row/column index and '$unknown' for a forward-compatibility Field member, without leaking a sibling column's value", async () => {
      h.send.mockResolvedValueOnce({
        records: [
          [{ stringValue: SENTINEL }, { $unknown: ["newMember", "raw"] }],
        ],
      });

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      const message = (thrown as M3LRDSDataOperationError).message;
      expect(message).toContain("0");
      expect(message).toContain("1");
      expect(message).toContain("$unknown");
      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain("raw");
    });

    test("maps a SDK rejection with name UnsupportedResultException to M3LRDSDataResultTooLargeError, cause chained", async () => {
      const sdkError = fatalError(
        "result set too large",
        "UnsupportedResultException",
      );
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataResultTooLargeError);
      expect(thrown).not.toBeInstanceOf(M3LRDSDataOperationError);
      expect((thrown as M3LRDSDataResultTooLargeError).cause).toBe(sdkError);
    });

    test("maps every other SDK rejection to plain M3LRDSDataOperationError, cause chained", async () => {
      const sdkError = fatalError("denied");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LRDSDataOperationError).cause).toBe(sdkError);
    });

    test("a failure's message/JSON never contain a sentinel planted in a statement parameter", async () => {
      const sdkError = fatalError("denied");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement({
          ...MINIMAL_STATEMENT_INPUT,
          parameters: [
            { name: "secret", value: { kind: "string", value: SENTINEL } },
          ],
        });
      } catch (error) {
        thrown = error;
      }

      const message = (thrown as M3LRDSDataOperationError).message;
      expect(message).not.toContain(SENTINEL);
      expect(JSON.stringify(thrown)).not.toContain(SENTINEL);
    });

    test("throws M3LRDSDataOperationError before calling send() for a parameter value carrying an unmapped kind, without leaking the value into the error's message", async () => {
      const malformedValue = {
        kind: "not-a-real-kind",
        value: "SENTINEL_MALFORMED_KIND_LEAK",
      } as unknown as M3LRDSDataValue;

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement({
          ...MINIMAL_STATEMENT_INPUT,
          parameters: [{ name: "bogus", value: malformedValue }],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      const message = (thrown as M3LRDSDataOperationError).message;
      expect(message).not.toContain("SENTINEL_MALFORMED_KIND_LEAK");
      expect(h.send).not.toHaveBeenCalled();
    });

    test("does not leak a raw terminal-control sequence from a malformed kind into the unmapped-kind error's message", async () => {
      // A malformed `kind` carrying an embedded terminal escape (clear
      // screen) plus a newline fabricating a fake log line must not reach
      // `.message` unmodified — this module's own documented behavior says
      // the message reaches the script logger and the persisted run report.
      const ESC = "\x1b";
      const malformedValue = {
        kind: `safe${ESC}[2Jinjected\nFAKE LOG LINE`,
        value: "irrelevant",
      } as unknown as M3LRDSDataValue;

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement({
          ...MINIMAL_STATEMENT_INPUT,
          parameters: [{ name: "bogus", value: malformedValue }],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      const message = (thrown as M3LRDSDataOperationError).message;
      expect(message).not.toContain(ESC);
      expect(message).not.toContain("\nFAKE LOG LINE");
    });
  });

  // ===========================================================================
  // batchExecuteStatement()
  // ===========================================================================
  describe("batchExecuteStatement()", () => {
    test("maps updateResults, each with generatedFields mapped to M3LRDSDataValue[]", async () => {
      h.send.mockResolvedValueOnce({
        updateResults: [
          { generatedFields: [{ longValue: 1 }] },
          { generatedFields: [{ stringValue: "gen-2" }] },
        ],
      });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result: M3LRDSDataBatchResult =
        await operations.batchExecuteStatement(MINIMAL_BATCH_INPUT);

      expect(result.updateResults).toEqual([
        { generatedFields: [{ kind: "long", value: 1 }] },
        { generatedFields: [{ kind: "string", value: "gen-2" }] },
      ]);
    });

    test("defaults updateResults to [] when the SDK response omits it (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      const result =
        await operations.batchExecuteStatement(MINIMAL_BATCH_INPUT);

      expect(result).toEqual({ updateResults: [] });
    });

    test("defaults an updateResults entry's generatedFields to [] when it is absent", async () => {
      h.send.mockResolvedValueOnce({ updateResults: [{}] });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result =
        await operations.batchExecuteStatement(MINIMAL_BATCH_INPUT);

      expect(result.updateResults).toEqual([{ generatedFields: [] }]);
    });

    test("sends resourceArn/secretArn/sql/parameterSets on the command input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.batchExecuteStatement(MINIMAL_BATCH_INPUT);

      const input = commandInput();
      expect(input["resourceArn"]).toBe(MINIMAL_BATCH_INPUT.resourceArn);
      expect(input["secretArn"]).toBe(MINIMAL_BATCH_INPUT.secretArn);
      expect(input["sql"]).toBe(MINIMAL_BATCH_INPUT.sql);
      expect(input["parameterSets"]).toEqual([
        [{ name: "name", value: { stringValue: "Ada" } }],
      ]);
    });

    test("sends database/schema/transactionId conditionally when present", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.batchExecuteStatement({
        ...MINIMAL_BATCH_INPUT,
        database: "app_db",
        schema: "public",
        transactionId: "txn-9",
      });

      const input = commandInput();
      expect(input["database"]).toBe("app_db");
      expect(input["schema"]).toBe("public");
      expect(input["transactionId"]).toBe("txn-9");
    });

    test("a rejection named UnsupportedResultException still maps to plain M3LRDSDataOperationError (the TooLarge mapping is executeStatement-only)", async () => {
      const sdkError = fatalError(
        "result set too large",
        "UnsupportedResultException",
      );
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.batchExecuteStatement(MINIMAL_BATCH_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect(thrown).not.toBeInstanceOf(M3LRDSDataResultTooLargeError);
      expect((thrown as M3LRDSDataOperationError).cause).toBe(sdkError);
    });

    test("chains a generic SDK rejection as cause on M3LRDSDataOperationError", async () => {
      const sdkError = fatalError("denied");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.batchExecuteStatement(MINIMAL_BATCH_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect((thrown as M3LRDSDataOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // beginTransaction()
  // ===========================================================================
  describe("beginTransaction()", () => {
    test("resolves with a plain M3LRDSDataTransaction on success", async () => {
      h.send.mockResolvedValueOnce({ transactionId: "txn-1" });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result: M3LRDSDataTransaction =
        await operations.beginTransaction(MINIMAL_BEGIN_INPUT);

      expect(result).toEqual({ transactionId: "txn-1" });
    });

    test("sends resourceArn/secretArn only when database/schema are absent (minimal fixture)", async () => {
      h.send.mockResolvedValueOnce({ transactionId: "txn-1" });

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.beginTransaction(MINIMAL_BEGIN_INPUT);

      const input = commandInput();
      expect(input["resourceArn"]).toBe(RESOURCE_ARN);
      expect(input["secretArn"]).toBe(SECRET_ARN);
      expect(Object.hasOwn(input, "database")).toBe(false);
      expect(Object.hasOwn(input, "schema")).toBe(false);
    });

    test("sends database/schema conditionally when present", async () => {
      h.send.mockResolvedValueOnce({ transactionId: "txn-1" });

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.beginTransaction({
        ...MINIMAL_BEGIN_INPUT,
        database: "app_db",
        schema: "public",
      });

      const input = commandInput();
      expect(input["database"]).toBe("app_db");
      expect(input["schema"]).toBe("public");
    });

    test("throws M3LRDSDataOperationError naming resourceArn when the response carries no transactionId", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.beginTransaction(MINIMAL_BEGIN_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(h.send).toHaveBeenCalledTimes(1);
      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect((thrown as M3LRDSDataOperationError).message).toContain(
        RESOURCE_ARN,
      );
    });

    test("chains the SDK rejection as cause on M3LRDSDataOperationError", async () => {
      const sdkError = fatalError("denied");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.beginTransaction(MINIMAL_BEGIN_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect((thrown as M3LRDSDataOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // commitTransaction() / rollbackTransaction()
  // ===========================================================================
  describe("commitTransaction()", () => {
    test("sends resourceArn/secretArn/transactionId on the command input and resolves void, discarding transactionStatus", async () => {
      h.send.mockResolvedValueOnce({
        transactionStatus: "Transaction Committed",
      });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.commitTransaction(
        RESOURCE_ARN,
        SECRET_ARN,
        { transactionId: "txn-1" },
      );

      expect(result).toBeUndefined();
      expect(commandInput()).toEqual({
        resourceArn: RESOURCE_ARN,
        secretArn: SECRET_ARN,
        transactionId: "txn-1",
      });
    });

    test("chains the SDK rejection as cause on M3LRDSDataOperationError", async () => {
      const sdkError = fatalError("denied");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.commitTransaction(RESOURCE_ARN, SECRET_ARN, {
          transactionId: "txn-1",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect((thrown as M3LRDSDataOperationError).cause).toBe(sdkError);
    });
  });

  describe("rollbackTransaction()", () => {
    test("sends resourceArn/secretArn/transactionId on the command input and resolves void, discarding transactionStatus", async () => {
      h.send.mockResolvedValueOnce({
        transactionStatus: "Rolled Back",
      });

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.rollbackTransaction(
        RESOURCE_ARN,
        SECRET_ARN,
        { transactionId: "txn-1" },
      );

      expect(result).toBeUndefined();
      expect(commandInput()).toEqual({
        resourceArn: RESOURCE_ARN,
        secretArn: SECRET_ARN,
        transactionId: "txn-1",
      });
    });

    test("chains the SDK rejection as cause on M3LRDSDataOperationError", async () => {
      const sdkError = fatalError("denied");
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.rollbackTransaction(RESOURCE_ARN, SECRET_ARN, {
          transactionId: "txn-1",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect((thrown as M3LRDSDataOperationError).cause).toBe(sdkError);
    });
  });

  // ===========================================================================
  // withTransaction()
  // ===========================================================================
  describe("withTransaction()", () => {
    test("begins, runs fn (which itself issues a statement), commits, and resolves fn's return value — exactly 3 send() calls in Begin/statement/Commit order", async () => {
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-1" }) // BeginTransaction
        .mockResolvedValueOnce({}) // the statement inside fn
        .mockResolvedValueOnce({ transactionStatus: "Transaction Committed" }); // CommitTransaction

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.withTransaction(
        MINIMAL_BEGIN_INPUT,
        async (transactionId) => {
          await operations.executeStatement({
            ...MINIMAL_STATEMENT_INPUT,
            transactionId,
          });
          return "done";
        },
      );

      expect(result).toBe("done");
      expect(h.send).toHaveBeenCalledTimes(3);
      expect(h.send.mock.calls[0]?.[0]).toBeInstanceOf(
        h.BeginTransactionCommand,
      );
      expect(h.send.mock.calls[1]?.[0]).toBeInstanceOf(
        h.ExecuteStatementCommand,
      );
      expect(h.send.mock.calls[2]?.[0]).toBeInstanceOf(
        h.CommitTransactionCommand,
      );
    });

    test("passes the begun transaction's id to fn", async () => {
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-specific" })
        .mockResolvedValueOnce({ transactionStatus: "Transaction Committed" });

      const operations = new M3LRDSDataOperations(fakeClient());
      let seenTransactionId: string | undefined;
      await operations.withTransaction(MINIMAL_BEGIN_INPUT, (transactionId) => {
        seenTransactionId = transactionId;
        return Promise.resolve(undefined);
      });

      expect(seenTransactionId).toBe("txn-specific");
    });

    test("rolls back and propagates fn's own error unchanged when the rollback succeeds", async () => {
      const fnError = new Error("statement failed");
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-2" }) // BeginTransaction
        .mockResolvedValueOnce({ transactionStatus: "Rolled Back" }); // RollbackTransaction

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.withTransaction(MINIMAL_BEGIN_INPUT, () =>
          Promise.reject(fnError),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(fnError);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send.mock.calls[1]?.[0]).toBeInstanceOf(
        h.RollbackTransactionCommand,
      );
    });

    test("chains the rollback's own failure onto the surfaced error's cause chain when both fn and rollback fail", async () => {
      const fnError = new Error("statement failed");
      const rollbackError = fatalError("rollback denied");
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-3" }) // BeginTransaction
        .mockRejectedValueOnce(rollbackError); // RollbackTransaction

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.withTransaction(MINIMAL_BEGIN_INPUT, () =>
          Promise.reject(fnError),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect(causeChain(thrown)).toContain(rollbackError);
      // Per the doc contract, a rollback failure is chained onto the error
      // fn's own throw surfaces as — so fn's original error must itself
      // remain reachable from `thrown`'s own identity or cause chain, not
      // just the rollback error. A fix that drops fnError entirely (e.g. by
      // constructing a brand-new error around only rollbackError) must fail
      // this.
      const fnErrorReachable =
        thrown === fnError || causeChain(thrown).includes(fnError);
      expect(fnErrorReachable).toBe(true);
    });

    test("still surfaces the rollback's own failure when fn's error already carries its own unrelated cause", async () => {
      const preExistingCause = new Error("pre-existing cause");
      const fnError = new Error("statement failed", {
        cause: preExistingCause,
      });
      const rollbackError = fatalError("rollback denied");
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-4" }) // BeginTransaction
        .mockRejectedValueOnce(rollbackError); // RollbackTransaction

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.withTransaction(MINIMAL_BEGIN_INPUT, () =>
          Promise.reject(fnError),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      // fn's own original cause must still be reachable...
      expect(causeChain(thrown)).toContain(preExistingCause);
      // ...and so must the rollback's own failure — a fnError that already
      // carries a cause of its own must not cause rollbackError to be
      // silently dropped from the chain.
      expect(causeChain(thrown)).toContain(rollbackError);
    });

    test("still surfaces M3LRDSDataOperationError (not a raw TypeError) when fn's error is frozen and rollback also fails", async () => {
      // Assigning `.cause` on a frozen error throws a TypeError in strict
      // (ESM) mode. This must not let that TypeError escape unhandled in
      // place of the operation's own typed error — and the rollback failure
      // must still end up reachable somewhere in the surfaced error's cause
      // chain, not silently dropped just because the primary attachment path
      // failed.
      const fnError = Object.freeze(new Error("statement failed"));
      const rollbackError = fatalError("rollback denied");
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-5" }) // BeginTransaction
        .mockRejectedValueOnce(rollbackError); // RollbackTransaction

      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.withTransaction(MINIMAL_BEGIN_INPUT, () =>
          Promise.reject(fnError),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LRDSDataOperationError);
      expect(causeChain(thrown)).toContain(rollbackError);
    });
  });

  // ===========================================================================
  // Constructor injection — never self-constructs, never reads client config
  // ===========================================================================
  describe("constructor injection", () => {
    test("never reads client.config and never calls destroy() during construction or an operation", async () => {
      h.send.mockResolvedValueOnce({ transactionId: "txn-1" });

      const target = new h.RDSDataClient();
      const guarded = new Proxy(target, {
        get(obj, prop, receiver): unknown {
          if (prop === "config") {
            throw new Error("must not read client.config");
          }
          return Reflect.get(obj, prop, receiver) as unknown;
        },
      });

      const operations = new M3LRDSDataOperations(
        guarded as unknown as RDSDataClient,
      );
      await operations.beginTransaction(MINIMAL_BEGIN_INPUT);

      expect(h.destroy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Cross-cutting retry behavior — deliberately minimal (core/polling owns
  // retry mechanics); one test confirms the module-local DatabaseResuming-
  // Exception classifier is wired into the combined classifier.
  // ===========================================================================
  describe("retry behavior (awsThrottling + DatabaseResumingException classifier)", () => {
    test("executeStatement() retries once on a DatabaseResumingException then succeeds (send called exactly twice)", async () => {
      vi.useFakeTimers();
      try {
        h.send
          .mockRejectedValueOnce(
            fatalError("cluster paused", "DatabaseResumingException"),
          )
          .mockResolvedValueOnce({});

        const operations = new M3LRDSDataOperations(fakeClient());

        let result: M3LRDSDataStatementResult | undefined;
        let thrown: unknown;
        const run = (async () => {
          try {
            result = await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
          } catch (error) {
            thrown = error;
          }
        })();
        await vi.advanceTimersByTimeAsync(5_000);
        await run;

        expect(thrown).toBeUndefined();
        expect(result).toEqual({
          rows: [],
          columns: [],
          numberOfRecordsUpdated: 0,
          generatedFields: [],
        });
        expect(h.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // M3LRDSDataOperationError / M3LRDSDataResultTooLargeError — identity/shape
  // ===========================================================================
  describe("error identity/shape", () => {
    test("M3LRDSDataOperationError is an instance of both M3LError and Error", async () => {
      h.send.mockRejectedValueOnce(fatalError());
      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as M3LRDSDataOperationError).code).toBe(
        "ERR_RDS_DATA_OPERATION",
      );
    });

    test("M3LRDSDataResultTooLargeError.code is 'ERR_RDS_DATA_RESULT_TOO_LARGE'", async () => {
      h.send.mockRejectedValueOnce(
        fatalError("too large", "UnsupportedResultException"),
      );
      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect((thrown as M3LRDSDataResultTooLargeError).code).toBe(
        "ERR_RDS_DATA_RESULT_TOO_LARGE",
      );
    });

    test("`cause` is preserved verbatim (no normalization) for a non-Error rejection", async () => {
      const original = { weird: "non-error rejection" };
      h.send.mockRejectedValueOnce(original);
      const operations = new M3LRDSDataOperations(fakeClient());

      let thrown: unknown;
      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
      } catch (error) {
        thrown = error;
      }

      expect((thrown as M3LRDSDataOperationError).cause).toBe(original);
    });
  });

  // ===========================================================================
  // Type-level contracts
  // ===========================================================================
  describe("type-level contracts", () => {
    test("M3LRDSDataOperationError extends M3LError; code narrows to the literal", () => {
      expectTypeOf<M3LRDSDataOperationError>().toMatchTypeOf<M3LError>();
      expectTypeOf<
        M3LRDSDataOperationError["code"]
      >().toEqualTypeOf<"ERR_RDS_DATA_OPERATION">();
    });

    test("M3LRDSDataResultTooLargeError extends M3LError; code narrows to the literal", () => {
      expectTypeOf<M3LRDSDataResultTooLargeError>().toMatchTypeOf<M3LError>();
      expectTypeOf<
        M3LRDSDataResultTooLargeError["code"]
      >().toEqualTypeOf<"ERR_RDS_DATA_RESULT_TOO_LARGE">();
    });

    test("M3LRDSDataValue discriminates on kind across every arm", () => {
      expectTypeOf<Extract<M3LRDSDataValue, { kind: "null" }>>().toEqualTypeOf<{
        readonly kind: "null";
      }>();
      expectTypeOf<
        Extract<M3LRDSDataValue, { kind: "string" }>
      >().toEqualTypeOf<{
        readonly kind: "string";
        readonly value: string;
      }>();
      expectTypeOf<Extract<M3LRDSDataValue, { kind: "long" }>>().toEqualTypeOf<{
        readonly kind: "long";
        readonly value: number;
      }>();
      expectTypeOf<
        Extract<M3LRDSDataValue, { kind: "double" }>
      >().toEqualTypeOf<{
        readonly kind: "double";
        readonly value: number;
      }>();
      expectTypeOf<
        Extract<M3LRDSDataValue, { kind: "boolean" }>
      >().toEqualTypeOf<{
        readonly kind: "boolean";
        readonly value: boolean;
      }>();
      expectTypeOf<Extract<M3LRDSDataValue, { kind: "blob" }>>().toEqualTypeOf<{
        readonly kind: "blob";
        readonly value: Uint8Array;
      }>();
    });
  });
});
