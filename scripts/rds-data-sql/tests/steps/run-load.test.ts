import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runLoad, type RunLoadCheckpoint } from "../../src/steps/run-load.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `run-load` row + the
 * `columns` config-parameter row (explicit vs. inferred, identifier
 * validation, heterogeneous-row rejection) + `batch.size` row, plus the
 * byte-offset resume seam design for `M3LJSONListExporter` (issue #427/F11,
 * `docs/logs/2026-08-14-rds-data-sql.md`).
 *
 * `run-load`'s injected-deps shape isn't pre-declared — this file defines
 * it as the contract the implementer builds against:
 *
 * ```ts
 * interface RunLoadCheckpoint {
 *   readonly chunkIndex?: number;
 *   readonly failedOutputBytes?: number;
 *   readonly failedCount?: number;
 *   readonly recordsProcessed?: number;
 * }
 * interface RunLoadDeps {
 *   readonly rdsData: Pick<AWS.M3LRDSDataOperations, "batchExecuteStatement" | "withTransaction">;
 *   readonly resourceArn: string;
 *   readonly secretArn: string;
 *   readonly database?: string;
 *   readonly schema?: string;
 *   readonly table: string; // already-qualified/quoted, e.g. `"public"."users"`
 *   readonly columns?: readonly string[];
 *   readonly importer: Core.M3LListImporter<Record<string, unknown>>;
 *   readonly source?: string;
 *   readonly batchSize: number;
 *   readonly checkpoint: {
 *     read(): Promise<RunLoadCheckpoint>;
 *     write(checkpoint: RunLoadCheckpoint & { readonly chunkIndex: number }): Promise<void>;
 *     delete(): Promise<void>;
 *   };
 *   readonly createFailedWriter: (resumeFromByte: number) => {
 *     append(record: Record<string, unknown>): Promise<void>;
 *     close(): Promise<void>;
 *     readonly bytesWritten: number;
 *   };
 *   readonly logger: Core.M3LLogger;
 * }
 * function runLoad(deps: RunLoadDeps): Promise<{ readonly inserted: number; readonly failed: number }>;
 * ```
 *
 * `runLoad` itself never throws on a partial failure — it returns a summary
 * with a nonzero `failed` count; `run-rds-data-sql` no longer maps a partial
 * failure to a throw at all (covered in its own test file) — it resolves
 * normally, since `run-load.ts`'s `reportRecovery` callback (optional on
 * `RunLoadDeps`) already reports each rejected row.
 *
 * DISCREPANCY NOTE (flagged for the hub / design owner): the task's "exact
 * design" section gives `RunLoadCheckpoint` as exactly `{ chunkIndex?,
 * failedOutputBytes?, failedCount? }` — three fields, dropping
 * `recordsProcessed` entirely with no replacement mechanism described.
 * `recordsProcessed` is what currently prevents a resumed run from
 * re-classifying (and thus re-rejecting/double-counting) a record a prior
 * interrupted run already accepted or rejected — a distinct concern from the
 * byte-offset resume seam this task fixes, and two existing regression
 * tests guard it. Dropping it silently would reopen that regression with no
 * described alternative, so these tests retain `recordsProcessed` as a 4th
 * optional checkpoint field pending confirmation from the design owner.
 */

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

function makeCheckpoint(initial: RunLoadCheckpoint = {}) {
  return {
    read: vi.fn().mockResolvedValue(initial),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

/** Builds a failed-writer stub whose `bytesWritten` grows by 10 per `append` call. */
function makeFailedWriter(initialBytesWritten = 0) {
  let bytes = initialBytesWritten;
  return {
    append: vi.fn(async (_record: Record<string, unknown>) => {
      await Promise.resolve();
      bytes += 10;
    }),
    close: vi.fn().mockResolvedValue(undefined),
    get bytesWritten() {
      return bytes;
    },
  };
}

/** Builds a `createFailedWriter` factory mock that always returns `writer`, recording every call's `resumeFromByte` arg. */
function makeFailedWriterFactory(writer: ReturnType<typeof makeFailedWriter>) {
  return vi.fn((_resumeFromByte: number) => writer);
}

/** Builds an importer whose `importStream()` yields `items` in order. */
function makeImporter(items: readonly Record<string, unknown>[]) {
  function stream() {
    async function* generator() {
      await Promise.resolve();
      for (const item of items) {
        yield item;
      }
      return { processed: items.length, skipped: 0, durationMs: 0 };
    }
    return generator();
  }
  return {
    import: vi.fn(),
    importStream: vi.fn(stream),
  };
}

function batchResult(count: number): AWS.M3LRDSDataBatchResult {
  return {
    updateResults: Array.from({ length: count }, () => ({
      generatedFields: [],
    })),
  };
}

/**
 * A `withTransaction` mock that simply runs `fn`, mirroring a transaction
 * that always commits.
 *
 * `vi.fn()`'s `Mock<T>` wrapper cannot itself express a genuinely
 * polymorphic call signature — `Parameters<T>`/`ReturnType<T>` force `T`'s
 * own type parameter closed to `unknown` — so the mock built from a plain
 * `Promise<unknown>`-typed `fn` parameter is not structurally assignable to
 * `AWS.M3LRDSDataOperations["withTransaction"]`'s generic `<T>` signature
 * (see `.claude/rules/tests.md`'s "Mock a port with generic methods by
 * inference, not `extends`" note). The intersection with `typeof mock`
 * below keeps every `vi.fn` assertion/member (`toHaveBeenCalledTimes`,
 * `.mock`, `mockImplementationOnce`, …) available at the call site while
 * presenting a callable shape compatible with the real generic port.
 */
function passthroughWithTransaction() {
  const mock = vi.fn(
    async (
      _input: AWS.M3LRDSDataBeginTransactionInput,
      fn: (transactionId: string) => Promise<unknown>,
    ) => fn("txn-1"),
  );
  return mock as unknown as AWS.M3LRDSDataOperations["withTransaction"] &
    typeof mock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunLoadCheckpoint", () => {
  test("drops 'failedRecords' and gains 'failedOutputBytes'/'failedCount' (recordsProcessed retained — see DISCREPANCY NOTE above)", () => {
    expectTypeOf<RunLoadCheckpoint>().toEqualTypeOf<{
      readonly chunkIndex?: number;
      readonly failedOutputBytes?: number;
      readonly failedCount?: number;
      readonly recordsProcessed?: number;
    }>();
  });
});

describe("runLoad", () => {
  test("happy path: chunks to batch.size, inserts each chunk via batchExecuteStatement inside withTransaction, and constructs the failed-writer fresh", async () => {
    const items = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
      { id: 4, name: "d" },
    ];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(2));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint();
    const failedWriter = makeFailedWriter();
    const createFailedWriter = makeFailedWriterFactory(failedWriter);

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"users"',
      importer,
      batchSize: 2,
      checkpoint,
      createFailedWriter,
      logger: makeLogger(),
    });

    expect(importer.importStream).toHaveBeenCalledTimes(1);
    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(2);
    expect(createFailedWriter).toHaveBeenCalledTimes(1);
    expect(createFailedWriter).toHaveBeenCalledWith(0);

    const firstInput = batchExecuteStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
    expect(firstInput.sql).toEqual(expect.stringContaining("INSERT INTO"));
    expect(firstInput.sql).toEqual(expect.stringContaining('"users"'));
    expect(firstInput.parameterSets).toHaveLength(2);

    expect(result.inserted).toBe(4);
    expect(result.failed).toBe(0);
    expect(checkpoint.write).toHaveBeenCalledTimes(2);
    expect(checkpoint.delete).toHaveBeenCalledTimes(1);
    expect(failedWriter.append).not.toHaveBeenCalled();
  });

  test("explicit columns: the declared column list wins over the record's own key order", async () => {
    const items = [{ name: "a", id: 1 }];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();

    await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"users"',
      columns: ["id", "name"],
      importer,
      batchSize: 10,
      checkpoint: makeCheckpoint(),
      createFailedWriter: makeFailedWriterFactory(makeFailedWriter()),
      logger: makeLogger(),
    });

    const input = batchExecuteStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
    const idIndex = input.sql.indexOf('"id"');
    const nameIndex = input.sql.indexOf('"name"');
    expect(idIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeGreaterThan(idIndex);

    const parameterNames = input.parameterSets[0]?.map((p) => p.name);
    expect(parameterNames).toEqual(["id", "name"]);
  });

  test("inferred columns: falls back to the first record's own key order when 'columns' is unset", async () => {
    const items = [{ id: 1, name: "a" }];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();

    await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"users"',
      importer,
      batchSize: 10,
      checkpoint: makeCheckpoint(),
      createFailedWriter: makeFailedWriterFactory(makeFailedWriter()),
      logger: makeLogger(),
    });

    const input = batchExecuteStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
    const parameterNames = input.parameterSets[0]?.map((p) => p.name);
    expect(parameterNames).toEqual(["id", "name"]);
  });

  test("a later record whose key set differs from the resolved columns is rejected to the failed-writer, not inserted", async () => {
    const items = [
      { id: 1, name: "a" },
      { id: 2, extra: "x" },
    ];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const failedWriter = makeFailedWriter();
    const createFailedWriter = makeFailedWriterFactory(failedWriter);
    const reportRecovery = vi.fn();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"users"',
      importer,
      batchSize: 10,
      checkpoint: makeCheckpoint(),
      createFailedWriter,
      logger: makeLogger(),
      reportRecovery,
    });

    expect(failedWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, extra: "x" }),
    );
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(1);

    const input = batchExecuteStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
    expect(input.parameterSets).toHaveLength(1);

    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(reportRecovery).toHaveBeenCalledWith({
      item: JSON.stringify({ id: 2, extra: "x" }),
      error: [
        expect.objectContaining({
          name: "M3LError",
          message: "record's keys do not match the resolved column list",
        }),
      ],
      recordedAt: expect.any(String) as string,
    });
  });

  describe("value coercion", () => {
    const acceptedCases: readonly [string, unknown, AWS.M3LRDSDataValue][] = [
      ["null", null, { kind: "null" }],
      ["boolean", true, { kind: "boolean", value: true }],
      ["string", "hello", { kind: "string", value: "hello" }],
      ["safe integer -> long", 42, { kind: "long", value: 42 }],
      ["other finite number -> double", 3.14, { kind: "double", value: 3.14 }],
    ];

    test.each(acceptedCases)(
      "coerces %s to the expected M3LRDSDataValue",
      async (_label, raw, expected) => {
        const importer = makeImporter([{ value: raw }]);
        const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
        const withTransaction = passthroughWithTransaction();

        const result = await runLoad({
          rdsData: { batchExecuteStatement, withTransaction },
          resourceArn: "arn:aws:rds:cluster",
          secretArn: "arn:aws:secretsmanager:secret",
          table: '"t"',
          columns: ["value"],
          importer,
          batchSize: 1,
          checkpoint: makeCheckpoint(),
          createFailedWriter: makeFailedWriterFactory(makeFailedWriter()),
          logger: makeLogger(),
        });

        const input = batchExecuteStatement.mock
          .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
        expect(input.parameterSets[0]?.[0]?.value).toEqual(expected);
        expect(result.failed).toBe(0);
      },
    );

    const rejectedCases: readonly [string, unknown][] = [
      ["non-finite number", Number.POSITIVE_INFINITY],
      ["NaN", Number.NaN],
      ["array", [1, 2, 3]],
      ["nested object", { nested: true }],
      ["undefined", undefined],
    ];

    test.each(rejectedCases)(
      "rejects a record whose value is %s to the failed-writer rather than coercing it",
      async (_label, raw) => {
        const importer = makeImporter([{ value: raw }]);
        const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
        const withTransaction = passthroughWithTransaction();
        const failedWriter = makeFailedWriter();
        const createFailedWriter = makeFailedWriterFactory(failedWriter);

        const result = await runLoad({
          rdsData: { batchExecuteStatement, withTransaction },
          resourceArn: "arn:aws:rds:cluster",
          secretArn: "arn:aws:secretsmanager:secret",
          table: '"t"',
          columns: ["value"],
          importer,
          batchSize: 1,
          checkpoint: makeCheckpoint(),
          createFailedWriter,
          logger: makeLogger(),
        });

        expect(failedWriter.append).toHaveBeenCalledTimes(1);
        expect(batchExecuteStatement).not.toHaveBeenCalled();
        expect(result.inserted).toBe(0);
        expect(result.failed).toBe(1);
      },
    );
  });

  test("resume: constructs the failed-writer from the checkpoint's saved byte offset, and does not re-append records already recorded by a prior interrupted run", async () => {
    // Regression test for the resumed-run data-loss bug: the failed-writer's
    // underlying exporter used to truncate `failed.jsonl` on construction,
    // so a resumed run that skipped re-populating it from
    // `checkpoint.failedRecords` silently lost every reject a prior
    // interrupted run had already recorded. The fix is a byte-offset resume
    // seam instead: the writer resumes from `failedOutputBytes`, so nothing
    // is truncated and nothing needs replaying.
    const skippedGoodRecord = { id: 1 };
    const newlyRejectedRecord = { id: [1, 2, 3] };
    const newlyInsertedRecord = { id: 2 };

    const importer = makeImporter([
      skippedGoodRecord,
      newlyRejectedRecord,
      newlyInsertedRecord,
    ]);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint({
      chunkIndex: 0,
      failedOutputBytes: 500,
      failedCount: 1,
      recordsProcessed: 1,
    });
    const failedWriter = makeFailedWriter();
    const createFailedWriter = makeFailedWriterFactory(failedWriter);
    const reportRecovery = vi.fn();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 1,
      checkpoint,
      createFailedWriter,
      logger: makeLogger(),
      reportRecovery,
    });

    expect(createFailedWriter).toHaveBeenCalledTimes(1);
    expect(createFailedWriter).toHaveBeenCalledWith(500);

    // Only the newly-rejected record this run is appended — nothing
    // re-appended from the checkpoint's prior failedCount.
    expect(failedWriter.append).toHaveBeenCalledTimes(1);
    expect(failedWriter.append).toHaveBeenCalledWith(newlyRejectedRecord);

    // `skippedGoodRecord` (already covered, per `recordsProcessed`) is
    // skipped without a duplicate insert.
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(1);

    // Resume-safety regression contract: exactly ONE reportRecovery call for
    // THIS run's newly-rejected record — never for the checkpoint's carried
    // -over failedCount: 1 from the prior interrupted run. The `message`
    // field is intentionally loosely asserted (`expect.any(String)`) since
    // classifyRecord's two rejection paths (key-mismatch vs. value-coercion
    // failure) share one branch in the current source, and this run's
    // rejection is a value-coercion failure (an array id), not a key
    // mismatch — the implementer's exact message text for that path is not
    // yet fixed by the contract.
    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(reportRecovery).toHaveBeenCalledWith({
      item: JSON.stringify(newlyRejectedRecord),
      error: [
        expect.objectContaining({
          name: "M3LError",
          message: expect.any(String) as string,
        }),
      ],
      recordedAt: expect.any(String) as string,
    });

    // The resolved failed count carries the prior run's failedCount forward
    // plus this run's own newly-rejected record.
    expect(result.failed).toBe(2);
    expect(result.inserted).toBe(1);
  });

  test("resume: a re-streamed record already classified in a prior run (per 'recordsProcessed') is skipped, not reclassified or re-appended", async () => {
    // Regression test for the resumed-run double-rejection bug, adapted to
    // the byte-offset resume seam: with no more replay-from-checkpoint step,
    // a fully-covered resume (recordsProcessed === the whole re-streamed
    // length) must produce ZERO new failed-writer appends and zero new
    // insert attempts — every record is skipped outright.
    const badPositions = new Set([10, 30, 50, 70, 90]);
    const items: Record<string, unknown>[] = [];
    for (let index = 0; index < 100; index += 1) {
      items.push(badPositions.has(index) ? { id: [index] } : { id: index });
    }

    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint({
      chunkIndex: 0,
      failedOutputBytes: 500,
      failedCount: 5,
      recordsProcessed: 100,
    });
    const failedWriter = makeFailedWriter();
    const createFailedWriter = makeFailedWriterFactory(failedWriter);
    const reportRecovery = vi.fn();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 100,
      checkpoint,
      createFailedWriter,
      logger: makeLogger(),
      reportRecovery,
    });

    expect(failedWriter.append).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(batchExecuteStatement).not.toHaveBeenCalled();
    expect(checkpoint.write).not.toHaveBeenCalled();

    // Zero new recovery entries — nothing is newly classified this run, so
    // reportRecovery must never fire (mirrors failedWriter.append above).
    expect(reportRecovery).not.toHaveBeenCalled();

    // The resolved failed count carries forward the checkpoint's own count
    // unchanged — there is nothing new to add.
    expect(result.failed).toBe(5);
    expect(result.inserted).toBe(0);
  });

  test("resume: the first post-resume chunk is numbered resumeFromChunkIndex + 1, not 0, so it is inserted rather than mis-skipped as already-done", async () => {
    const alreadyProcessed = Array.from({ length: 100 }, (_unused, index) => ({
      id: index,
    }));
    const newRecords = Array.from({ length: 100 }, (_unused, index) => ({
      id: 100 + index,
    }));
    const importer = makeImporter([...alreadyProcessed, ...newRecords]);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(100));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint({ chunkIndex: 0, recordsProcessed: 100 });
    const createFailedWriter = makeFailedWriterFactory(makeFailedWriter());

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 100,
      checkpoint,
      createFailedWriter,
      logger: makeLogger(),
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(1);
    const input = batchExecuteStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
    expect(input.parameterSets).toHaveLength(100);
    expect(result.inserted).toBe(100);
    expect(result.failed).toBe(0);
    expect(checkpoint.write).toHaveBeenCalledTimes(1);
    expect(checkpoint.write).toHaveBeenCalledWith(
      expect.objectContaining({ chunkIndex: 1 }),
    );
  });

  test("resume: chunk numbering continues correctly from a mid-run resume point (chunkIndex 3 -> 4)", async () => {
    const alreadyProcessed = Array.from({ length: 400 }, (_unused, index) => ({
      id: index,
    }));
    const newRecords = Array.from({ length: 100 }, (_unused, index) => ({
      id: 400 + index,
    }));
    const importer = makeImporter([...alreadyProcessed, ...newRecords]);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(100));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint({ chunkIndex: 3, recordsProcessed: 400 });
    const createFailedWriter = makeFailedWriterFactory(makeFailedWriter());

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 100,
      checkpoint,
      createFailedWriter,
      logger: makeLogger(),
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(1);
    expect(result.inserted).toBe(100);
    expect(result.failed).toBe(0);
    expect(checkpoint.write).toHaveBeenCalledWith(
      expect.objectContaining({ chunkIndex: 4 }),
    );
  });

  test("checkpoint writes after a chunk include failedOutputBytes reflecting the failed-writer's own bytesWritten, and failedCount as a running total across chunks", async () => {
    const items = [
      { id: [1] }, // rejected (coercion failure)
      { id: 2 }, // accepted -> flushes chunk 0 (batchSize 1)
      { id: [3] }, // rejected
      { id: 4 }, // accepted -> flushes chunk 1
    ];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint();
    const failedWriter = makeFailedWriter();
    const createFailedWriter = makeFailedWriterFactory(failedWriter);

    await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 1,
      checkpoint,
      createFailedWriter,
      logger: makeLogger(),
    });

    expect(checkpoint.write).toHaveBeenCalledTimes(2);
    expect(checkpoint.write).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chunkIndex: 0,
        failedOutputBytes: 10,
        failedCount: 1,
      }),
    );
    expect(checkpoint.write).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chunkIndex: 1,
        failedOutputBytes: 20,
        failedCount: 2,
      }),
    );
  });

  test("close() failure on the failed-writer after an otherwise-successful run throws a coded M3LError chaining the close error, and does not delete the checkpoint", async () => {
    const closeError = new Error("close failed");
    const failedWriter = makeFailedWriter();
    failedWriter.close.mockRejectedValue(closeError);
    const createFailedWriter = makeFailedWriterFactory(failedWriter);
    const items = [{ id: 1 }];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint();

    let thrown: unknown;
    try {
      await runLoad({
        rdsData: { batchExecuteStatement, withTransaction },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        table: '"users"',
        importer,
        batchSize: 10,
        checkpoint,
        createFailedWriter,
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

  test("close() failure on the failed-writer while the import stream already failed is only logged — the original stream error propagates unmodified", async () => {
    const closeError = new Error("close failed");
    const failedWriter = makeFailedWriter();
    failedWriter.close.mockRejectedValue(closeError);
    const createFailedWriter = makeFailedWriterFactory(failedWriter);
    const streamError = new Error("import stream failed");
    const importer = {
      import: vi.fn(),
      importStream: vi.fn(() => {
        // eslint-disable-next-line require-yield -- intentionally never yields; this generator always throws before any record
        async function* generator(): AsyncGenerator<
          Record<string, unknown>,
          Core.M3LImportStreamSummary
        > {
          await Promise.resolve();
          throw streamError;
        }
        return generator();
      }),
    };
    const batchExecuteStatement = vi.fn();
    const withTransaction = passthroughWithTransaction();
    const checkpoint = makeCheckpoint();
    const logger = makeLogger();
    const errorSpy = vi.spyOn(logger, "error");

    let thrown: unknown;
    try {
      await runLoad({
        rdsData: { batchExecuteStatement, withTransaction },
        resourceArn: "arn:aws:rds:cluster",
        secretArn: "arn:aws:secretsmanager:secret",
        table: '"users"',
        importer,
        batchSize: 10,
        checkpoint,
        createFailedWriter,
        logger,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(streamError);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(checkpoint.delete).not.toHaveBeenCalled();
  });

  test("a chunk whose transaction fails is recorded as failed, and later chunks still attempt", async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const chunkFailure = new AWS.M3LRDSDataOperationError("chunk 2 failed");
    const withTransaction = vi
      .fn()
      .mockImplementationOnce(
        async (
          _input: AWS.M3LRDSDataBeginTransactionInput,
          fn: (transactionId: string) => Promise<unknown>,
        ) => fn("txn-1"),
      )
      .mockImplementationOnce(() => {
        throw chunkFailure;
      })
      .mockImplementationOnce(
        async (
          _input: AWS.M3LRDSDataBeginTransactionInput,
          fn: (transactionId: string) => Promise<unknown>,
        ) => fn("txn-3"),
      );
    const failedWriter = makeFailedWriter();
    const createFailedWriter = makeFailedWriterFactory(failedWriter);
    const reportRecovery = vi.fn();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 1,
      checkpoint: makeCheckpoint(),
      createFailedWriter,
      logger: makeLogger(),
      reportRecovery,
    });

    expect(withTransaction).toHaveBeenCalledTimes(3);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(2);
    expect(failedWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
    );
    expect(result.inserted).toBe(2);
    expect(result.failed).toBeGreaterThan(0);

    expect(reportRecovery).toHaveBeenCalledTimes(1);
    expect(reportRecovery).toHaveBeenCalledWith({
      item: JSON.stringify({ id: 2 }),
      error: [
        expect.objectContaining({
          name: "M3LError",
          message: "chunk 2 failed",
        }),
      ],
      recordedAt: expect.any(String) as string,
    });
  });
});
