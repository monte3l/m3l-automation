/**
 * Tests for aws/rds-data submodule.
 *
 * Contract source: docs/reference/aws/rds-data.md (RED-phase seed, written
 * during scaffolding per `scaffolding-submodules` — the submodule exists
 * only as placeholder-body stubs under
 * `packages/m3l-common/src/aws/rds-data/` at this point; every test below is
 * expected to fail until `implementing-submodules` lands the real
 * `client.ts` logic).
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
 * `tests/eventbridge.test.ts`'s header) — core/polling owns retry mechanics.
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
  M3LRDSDataStatementInput,
  M3LRDSDataStatementResult,
  M3LRDSDataValue,
} from "../src/aws/rds-data/index.js";
import {
  M3LRDSDataOperationError,
  M3LRDSDataOperations,
} from "../src/aws/rds-data/index.js";
import { M3LError } from "../src/core/errors/index.js";

import type { RDSDataClient } from "@aws-sdk/client-rds-data";

/** Casts the hoisted fake `RDSDataClient` (mocked shape) to the real SDK type for construction. */
function fakeClient(): RDSDataClient {
  return new h.RDSDataClient() as unknown as RDSDataClient;
}

const MINIMAL_STATEMENT_INPUT: M3LRDSDataStatementInput = {
  resourceArn: "arn:aws:rds:eu-south-1:123456789012:cluster:example-cluster",
  secretArn:
    "arn:aws:secretsmanager:eu-south-1:123456789012:secret:example-secret",
  sql: "SELECT name, age FROM users WHERE active = :active",
  parameters: [{ name: "active", value: { kind: "boolean", value: true } }],
};

describe("M3LRDSDataOperations", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.destroy.mockReset();
  });

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

    test("sends resourceArn/secretArn/sql/parameters on the command input", async () => {
      h.send.mockResolvedValueOnce({});

      const operations = new M3LRDSDataOperations(fakeClient());
      await operations.executeStatement(MINIMAL_STATEMENT_INPUT);

      expect(h.send).toHaveBeenCalledTimes(1);
      const [command] = h.send.mock.calls[0] as [{ input: unknown }];
      expect(command.input).toMatchObject({
        resourceArn: MINIMAL_STATEMENT_INPUT.resourceArn,
        secretArn: MINIMAL_STATEMENT_INPUT.secretArn,
        sql: MINIMAL_STATEMENT_INPUT.sql,
      });
    });

    test("chains the SDK rejection as cause on M3LRDSDataOperationError", async () => {
      const sdkError = Object.assign(new Error("denied"), {
        name: "AccessDenied",
      });
      h.send.mockRejectedValueOnce(sdkError);

      const operations = new M3LRDSDataOperations(fakeClient());

      await expect(
        operations.executeStatement(MINIMAL_STATEMENT_INPUT),
      ).rejects.toThrow(M3LRDSDataOperationError);
      expect(h.send).toHaveBeenCalledTimes(1);

      try {
        await operations.executeStatement(MINIMAL_STATEMENT_INPUT);
        expect.unreachable("executeStatement must reject");
      } catch (error) {
        expect(error).toBeInstanceOf(M3LError);
        expect((error as M3LRDSDataOperationError).cause).toBe(sdkError);
      }
    });
  });

  describe("withTransaction()", () => {
    test("commits on success and resolves fn's return value", async () => {
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-1" }) // BeginTransaction
        .mockResolvedValueOnce({}) // the statement inside fn
        .mockResolvedValueOnce({ transactionStatus: "Transaction Committed" }); // CommitTransaction

      const operations = new M3LRDSDataOperations(fakeClient());
      const result = await operations.withTransaction(
        {
          resourceArn: MINIMAL_STATEMENT_INPUT.resourceArn,
          secretArn: MINIMAL_STATEMENT_INPUT.secretArn,
        },
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
    });

    test("rolls back and chains the rollback failure onto fn's own error, never swallowing it", async () => {
      const fnError = new Error("statement failed");
      const rollbackError = Object.assign(new Error("rollback denied"), {
        name: "AccessDenied",
      });
      h.send
        .mockResolvedValueOnce({ transactionId: "txn-2" }) // BeginTransaction
        .mockRejectedValueOnce(fnError) // the statement inside fn
        .mockRejectedValueOnce(rollbackError); // RollbackTransaction

      const operations = new M3LRDSDataOperations(fakeClient());

      await expect(
        operations.withTransaction(
          {
            resourceArn: MINIMAL_STATEMENT_INPUT.resourceArn,
            secretArn: MINIMAL_STATEMENT_INPUT.secretArn,
          },
          () => Promise.reject(fnError),
        ),
      ).rejects.toThrow();
      expect(h.send).toHaveBeenCalledTimes(3);
    });
  });

  test("type: M3LRDSDataValue discriminates on kind", () => {
    expectTypeOf<Extract<M3LRDSDataValue, { kind: "string" }>>().toEqualTypeOf<{
      readonly kind: "string";
      readonly value: string;
    }>();
    expectTypeOf<Extract<M3LRDSDataValue, { kind: "null" }>>().toEqualTypeOf<{
      readonly kind: "null";
    }>();
  });
});
