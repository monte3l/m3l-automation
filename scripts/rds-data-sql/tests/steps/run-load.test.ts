import { afterEach, describe, expect, test, vi } from "vitest";

import { AWS, Core } from "@m3l-automation/m3l-common";

import { runLoad } from "../../src/steps/run-load.js";

/**
 * Contract: docs/reference/scripts/rds-data-sql.md, `run-load` row + the
 * `columns` config-parameter row (explicit vs. inferred, identifier
 * validation, heterogeneous-row rejection) + `batch.size` row.
 *
 * `run-load`'s injected-deps shape isn't pre-declared — this file defines
 * it as the contract the implementer builds against:
 *
 * ```ts
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
 *     read(): Promise<{ readonly chunkIndex?: number }>;
 *     write(checkpoint: { readonly chunkIndex: number }): Promise<void>;
 *     delete(): Promise<void>;
 *   };
 *   readonly failedWriter: { append(record: Record<string, unknown>): Promise<void>; close(): Promise<void> };
 *   readonly logger: Core.M3LLogger;
 * }
 * function runLoad(deps: RunLoadDeps): Promise<{ readonly inserted: number; readonly failed: number }>;
 * ```
 *
 * `runLoad` itself never throws on a partial failure — it returns a summary
 * with a nonzero `failed` count; `run-rds-data-sql` is the layer that maps
 * that into `ERR_RDS_DATA_SQL_PARTIAL_FAILURE` (covered in its own test file).
 */

function makeLogger(): Core.M3LLogger {
  return new Core.M3LLogger([]);
}

function makeCheckpoint() {
  return {
    read: vi.fn().mockResolvedValue({}),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFailedWriter() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
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

describe("runLoad", () => {
  test("happy path: chunks to batch.size and inserts each chunk via batchExecuteStatement inside withTransaction", async () => {
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

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"users"',
      importer,
      batchSize: 2,
      checkpoint,
      failedWriter,
      logger: makeLogger(),
    });

    expect(importer.importStream).toHaveBeenCalledTimes(1);
    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(2);

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
      failedWriter: makeFailedWriter(),
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
      failedWriter: makeFailedWriter(),
      logger: makeLogger(),
    });

    const input = batchExecuteStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
    const parameterNames = input.parameterSets[0]?.map((p) => p.name);
    expect(parameterNames).toEqual(["id", "name"]);
  });

  test("a later record whose key set differs from the resolved columns is rejected to failedWriter, not inserted", async () => {
    const items = [
      { id: 1, name: "a" },
      { id: 2, extra: "x" },
    ];
    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const failedWriter = makeFailedWriter();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"users"',
      importer,
      batchSize: 10,
      checkpoint: makeCheckpoint(),
      failedWriter,
      logger: makeLogger(),
    });

    expect(failedWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, extra: "x" }),
    );
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(1);

    const input = batchExecuteStatement.mock
      .calls[0]?.[0] as AWS.M3LRDSDataBatchInput;
    expect(input.parameterSets).toHaveLength(1);
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
          failedWriter: makeFailedWriter(),
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
      "rejects a record whose value is %s to failedWriter rather than coercing it",
      async (_label, raw) => {
        const importer = makeImporter([{ value: raw }]);
        const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
        const withTransaction = passthroughWithTransaction();
        const failedWriter = makeFailedWriter();

        const result = await runLoad({
          rdsData: { batchExecuteStatement, withTransaction },
          resourceArn: "arn:aws:rds:cluster",
          secretArn: "arn:aws:secretsmanager:secret",
          table: '"t"',
          columns: ["value"],
          importer,
          batchSize: 1,
          checkpoint: makeCheckpoint(),
          failedWriter,
          logger: makeLogger(),
        });

        expect(failedWriter.append).toHaveBeenCalledTimes(1);
        expect(batchExecuteStatement).not.toHaveBeenCalled();
        expect(result.inserted).toBe(0);
        expect(result.failed).toBe(1);
      },
    );
  });

  test("resume: re-appends the checkpoint's failed records to failedWriter before consuming new records, and the failed count includes both", async () => {
    // Regression test for the resumed-run data-loss bug: `failedWriter`'s
    // underlying exporter truncates `failed.jsonl` on construction, so a
    // resumed run that skipped re-populating it from
    // `checkpoint.failedRecords` silently lost every reject a prior
    // interrupted run had already recorded.
    const seededRecord = { bad: "row-a" };
    // Already classified by the prior interrupted run (per `recordsProcessed:
    // 1`) — re-streamed but skipped without reclassifying, never re-inserted
    // or re-recorded.
    const skippedGoodRecord = { id: 1 };
    // Fails coercion (an array value); rejected immediately regardless of
    // chunk boundary.
    const newlyRejectedRecord = { id: [1, 2, 3] };
    // The first chunk this run actually forms — numbered 1 (resumeFromChunkIndex
    // 0 + 1), past the resume point; actually inserted.
    const newlyInsertedRecord = { id: 2 };

    const importer = makeImporter([
      skippedGoodRecord,
      newlyRejectedRecord,
      newlyInsertedRecord,
    ]);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = {
      read: vi.fn().mockResolvedValue({
        chunkIndex: 0,
        failedRecords: [seededRecord],
        // `skippedGoodRecord` is the only record the prior interrupted run
        // classified before it stopped — a real checkpoint always persists
        // `chunkIndex` and `recordsProcessed` together (`flushChunk`'s single
        // `checkpoint.write` call), so a checkpoint with `chunkIndex` set but
        // no `recordsProcessed` can never occur in practice.
        recordsProcessed: 1,
      }),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const failedWriter = makeFailedWriter();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 1,
      checkpoint,
      failedWriter,
      logger: makeLogger(),
    });

    // The seeded (resumed) rejected record is re-appended to failedWriter
    // before any newly-rejected record from this run.
    expect(failedWriter.append).toHaveBeenCalledTimes(2);
    expect(failedWriter.append).toHaveBeenNthCalledWith(1, seededRecord);
    expect(failedWriter.append).toHaveBeenNthCalledWith(2, newlyRejectedRecord);

    // `skippedGoodRecord` (already covered, per `recordsProcessed`) is
    // skipped without a duplicate insert; only the newly-formed chunk past
    // the resume point (index 1) is actually inserted.
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(1);

    // The resolved failed count reflects both the seeded and the newly
    // rejected record, not just this run's new rejection — the direct
    // proof the old truncate-and-lose-history bug is closed.
    expect(result.failed).toBe(2);
    expect(result.inserted).toBe(1);
  });

  test("resume: a re-streamed record already classified in a prior run (per 'recordsProcessed') is skipped, not reclassified — closing the double-rejection regression", async () => {
    // Regression test for the resumed-run double-rejection bug: the prior
    // round's resume test seeded `checkpoint.failedRecords` with a record
    // that never actually reappeared in the importer's re-streamed output,
    // so it could never exercise reclassification — it passed whether or
    // not the `recordsProcessed`-based skip worked at all. This test seeds
    // `failedRecords` with objects that ARE (by reference) part of the
    // importer's yielded stream, mirroring the reported reproduction: 100
    // records, 5 fail coercion, batch.size=100, run 1 ends with
    // `{chunkIndex: 0, failedRecords: [5 records], recordsProcessed: 100}`;
    // run 2 must report `failed: 5`, not `10`.
    const badPositions = new Set([10, 30, 50, 70, 90]);
    const items: Record<string, unknown>[] = [];
    const badRecords: Record<string, unknown>[] = [];
    for (let index = 0; index < 100; index += 1) {
      if (badPositions.has(index)) {
        // Fails coercion: an array value never coerces to M3LRDSDataValue.
        const bad = { id: [index] };
        items.push(bad);
        badRecords.push(bad);
      } else {
        items.push({ id: index });
      }
    }

    const importer = makeImporter(items);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(1));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = {
      read: vi.fn().mockResolvedValue({
        chunkIndex: 0,
        failedRecords: badRecords,
        recordsProcessed: 100,
      }),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const failedWriter = makeFailedWriter();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 100,
      checkpoint,
      failedWriter,
      logger: makeLogger(),
    });

    // (a) One specific re-streamed bad record is appended exactly once —
    // from the seed replay only, never again from reclassification, even
    // though the identical object is re-yielded by the importer.
    const targetBadRecord = badRecords[2];
    if (targetBadRecord === undefined) {
      throw new Error("expected at least 3 seeded bad records");
    }
    const appendCallsForTarget = failedWriter.append.mock.calls.filter(
      ([record]) => record === targetBadRecord,
    );
    expect(appendCallsForTarget).toHaveLength(1);

    // Total append calls match the seed count exactly (5), not double (10).
    expect(failedWriter.append).toHaveBeenCalledTimes(5);

    // (b) The resolved failed count reflects one instance of each seeded
    // record, not two.
    expect(result.failed).toBe(5);
    expect(result.inserted).toBe(0);

    // (c) None of the re-streamed records — good or bad — were reclassified:
    // no insert attempt (every good record was already accepted/inserted by
    // the interrupted prior run, so this run must not re-attempt them) and
    // no checkpoint re-write, proving classifyRecord's effects never ran for
    // any record covered by the resume skip.
    expect(withTransaction).not.toHaveBeenCalled();
    expect(batchExecuteStatement).not.toHaveBeenCalled();
    expect(checkpoint.write).not.toHaveBeenCalled();
  });

  test("resume: the first post-resume chunk is numbered resumeFromChunkIndex + 1, not 0, so it is inserted rather than mis-skipped as already-done", async () => {
    // Regression test for the chunk-mis-numbering bug: seeding `nextChunkIndex`
    // at `0` on every run (rather than from `resumeFromChunkIndex + 1`) made
    // the first chunk a resumed run actually forms collide with chunk `0`
    // from the prior interrupted run, so `flushChunk`'s
    // `chunkIndex <= resumeFromChunkIndex` guard silently skipped it as
    // already-done instead of inserting it.
    const alreadyProcessed = Array.from({ length: 100 }, (_unused, index) => ({
      id: index,
    }));
    const newRecords = Array.from({ length: 100 }, (_unused, index) => ({
      id: 100 + index,
    }));
    const importer = makeImporter([...alreadyProcessed, ...newRecords]);
    const batchExecuteStatement = vi.fn().mockResolvedValue(batchResult(100));
    const withTransaction = passthroughWithTransaction();
    const checkpoint = {
      read: vi.fn().mockResolvedValue({ chunkIndex: 0, recordsProcessed: 100 }),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const failedWriter = makeFailedWriter();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 100,
      checkpoint,
      failedWriter,
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
    const checkpoint = {
      read: vi.fn().mockResolvedValue({ chunkIndex: 3, recordsProcessed: 400 }),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const failedWriter = makeFailedWriter();

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 100,
      checkpoint,
      failedWriter,
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

    const result = await runLoad({
      rdsData: { batchExecuteStatement, withTransaction },
      resourceArn: "arn:aws:rds:cluster",
      secretArn: "arn:aws:secretsmanager:secret",
      table: '"t"',
      columns: ["id"],
      importer,
      batchSize: 1,
      checkpoint: makeCheckpoint(),
      failedWriter,
      logger: makeLogger(),
    });

    expect(withTransaction).toHaveBeenCalledTimes(3);
    expect(batchExecuteStatement).toHaveBeenCalledTimes(2);
    expect(failedWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
    );
    expect(result.inserted).toBe(2);
    expect(result.failed).toBeGreaterThan(0);
  });
});
