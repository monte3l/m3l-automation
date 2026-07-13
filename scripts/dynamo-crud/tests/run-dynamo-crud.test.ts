import type { FileHandle } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";
import type * as ScanTableModule from "../src/steps/scan-table.js";

// Make both fs seams configurable so vi.spyOn can intercept individual
// functions — mirrors scripts/json-etl/tests/run-json-etl.test.ts and
// packages/m3l-common/tests/{importers,exporters}.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    AWS: {
      ...actual.AWS,
      getItem: vi.fn(),
      putItem: vi.fn(),
      updateItem: vi.fn(),
      deleteItem: vi.fn(),
      scanSegment: vi.fn(),
      queryItems: vi.fn(),
      batchWriteItems: vi.fn(),
      batchDeleteItems: vi.fn(),
      describeTable: vi.fn(),
    },
  };
});

// One narrow exception to "the sibling steps run for real": wrap (not
// replace) `scan-table.js`'s `scanTable` export in a `vi.fn()` so tests can
// inspect the `checkpointPath` it was actually invoked with (fix #1 —
// `--resume`'s checkpoint file must be keyed to `runName`/`operation`+
// `tableName`, never the fresh-per-invocation `correlationId`). The real
// implementation still runs underneath; this is a spy, not a stub.
vi.mock("../src/steps/scan-table.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScanTableModule>();
  return { ...actual, scanTable: vi.fn(actual.scanTable) };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type { RunDynamoCrudSummary } from "../src/steps/run-dynamo-crud.js";
import { runDynamoCrud } from "../src/steps/run-dynamo-crud.js";
import { scanTable } from "../src/steps/scan-table.js";

/**
 * Contract: docs/reference/scripts/dynamo-crud.md, `run-dynamo-crud` row —
 * the orchestrator. Resolves + guard-checks the 12 declared config
 * parameters, dispatches to the destructive gate (when applicable) and then
 * to whichever of `single-item-ops` / `scan-table` / `batch-write-table`
 * matches `operation`, and returns a `{ read, written, failed, skipped }`
 * summary. Only the true I/O boundary is mocked — the `AWS.*` DynamoDB
 * functions and `node:fs`/`node:fs/promises` — the four sibling step modules
 * run for real, proving the orchestrator's dispatch wiring end to end.
 */

const getItemMock = vi.mocked(AWS.getItem);
const putItemMock = vi.mocked(AWS.putItem);
const updateItemMock = vi.mocked(AWS.updateItem);
const deleteItemMock = vi.mocked(AWS.deleteItem);
const scanSegmentMock = vi.mocked(AWS.scanSegment);
const queryItemsMock = vi.mocked(AWS.queryItems);
const batchWriteItemsMock = vi.mocked(AWS.batchWriteItems);
const batchDeleteItemsMock = vi.mocked(AWS.batchDeleteItems);
const describeTableMock = vi.mocked(AWS.describeTable);
// A spy wrapping the REAL scanTable implementation (see the vi.mock above) —
// used only to inspect what `checkpointPath` a run actually invoked it with.
const scanTableMock = vi.mocked(scanTable);

// Only the mocked AWS functions are ever invoked on these clients in these
// tests; the client values themselves are never dereferenced, so opaque
// placeholders are safe (mirrors the sibling step test files).
const fakeDynamoDBDocument = {} as Parameters<typeof AWS.getItem>[0];
const fakeDynamoDB = {} as Parameters<typeof AWS.describeTable>[0];

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

interface FakeJSONFileHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

function fakeJSONFileHandle(content: string): FileHandle {
  const source = Buffer.from(content, "utf8");
  const handle: FakeJSONFileHandle = {
    read: (buffer, offset, length, position) => {
      const slice = source.subarray(position, position + length);
      slice.copy(buffer, offset);
      return Promise.resolve({ bytesRead: slice.length, buffer });
    },
    stat: () => Promise.resolve({ size: source.length }),
    close: () => Promise.resolve(),
  };
  return handle as unknown as FileHandle;
}

class FakeWriteStream extends EventEmitter {
  chunks: string[] = [];

  write(chunk: string | Buffer, cb?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk.toString());
    queueMicrotask(() => {
      cb?.();
    });
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.chunks.push(chunk.toString());
    }
    queueMicrotask(() => this.emit("finish"));
    return this;
  }

  content(): string {
    return this.chunks.join("");
  }
}

/** Stubs `fs.createWriteStream` (the `M3LJSONListExporter` sink) and returns the fake it produces. */
function stubOutputStream(): FakeWriteStream {
  const output = new FakeWriteStream();
  vi.spyOn(fs, "createWriteStream").mockReturnValue(
    output as unknown as WriteStream,
  );
  return output;
}

/** Stubs the input read path (`M3LJSONListImporter`'s file handle) with `content`. */
function stubInputFile(content: string): void {
  vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(content, "utf8"));
  vi.spyOn(fsp, "open").mockImplementation(() =>
    Promise.resolve(fakeJSONFileHandle(content)),
  );
}

/** Stubs the plain single-line-JSON write path a get/put/update/delete result may use. */
function stubWriteFile(): void {
  vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
}

function readJSONLLines(output: FakeWriteStream): unknown[] {
  return output
    .content()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}

const BASE_CONFIG: Record<string, unknown> = {
  tableName: "orders",
  batchSize: 100,
  totalSegments: 1,
  maxInFlightBatches: 4,
  checkpointEveryPages: 25,
  resume: false,
  progressEveryRecords: 10_000,
};

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: { readonly confirm?: (message: string) => Promise<boolean> },
): Parameters<typeof runDynamoCrud>[0] {
  return {
    config: buildConfig(configValues),
    paths: new Core.M3LPaths(),
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    dynamoDBDocument: fakeDynamoDBDocument,
    dynamoDB: fakeDynamoDB,
    confirm: overrides?.confirm ?? vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (fs primitives below); it
  // does not clear plain vi.fn() mocks (the AWS.* functions, created inside
  // the top-level vi.mock() factory), so their call history and
  // mockImplementation would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(AWS.getItem).mockReset();
  vi.mocked(AWS.putItem).mockReset();
  vi.mocked(AWS.updateItem).mockReset();
  vi.mocked(AWS.deleteItem).mockReset();
  vi.mocked(AWS.scanSegment).mockReset();
  vi.mocked(AWS.queryItems).mockReset();
  vi.mocked(AWS.batchWriteItems).mockReset();
  vi.mocked(AWS.batchDeleteItems).mockReset();
  vi.mocked(AWS.describeTable).mockReset();
  // scanTableMock wraps the REAL implementation (vi.fn(actual.scanTable));
  // only clear call history, never reset (a reset would drop the passthrough
  // implementation and turn every subsequent call into `undefined`).
  scanTableMock.mockClear();
});

/**
 * Drives `promise` to settlement while flushing every pending fake timer, so
 * `Core.M3LRetryRunner`'s real (production, un-injectable from here) default
 * backoff/attempt bound resolves without a real wall-clock wait. Mirrors
 * `packages/m3l-common/tests/polling.test.ts`'s `settleWithTimers`. Callers
 * must wrap the call in `vi.useFakeTimers()`/`vi.useRealTimers()`.
 */
async function settleWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const settledOutcome = Promise.allSettled([promise]).then((results) => {
    settled = true;
    return results[0];
  });
  for (let i = 0; i < 1000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  const outcome = await settledOutcome;
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

describe("runDynamoCrud — config guards (fire before any AWS call)", () => {
  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'get' is missing 'key'", async () => {
    stubWriteFile();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "get",
      output: "out.jsonl",
    });

    let thrown: unknown;
    try {
      await runDynamoCrud(deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect(getItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'delete' is missing 'key'", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "delete" });

    await expect(runDynamoCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(deleteItemMock).not.toHaveBeenCalled();
    expect(describeTableMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'put' is missing 'item'", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "put" });

    await expect(runDynamoCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(putItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'update' is missing 'key' (item present)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "update",
      item: JSON.stringify({ status: "shipped" }),
    });

    await expect(runDynamoCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(updateItemMock).not.toHaveBeenCalled();
    expect(describeTableMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'update' is missing 'item' (key present)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "update",
      key: JSON.stringify({ id: "42" }),
    });

    await expect(runDynamoCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(updateItemMock).not.toHaveBeenCalled();
    expect(describeTableMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'query' is missing 'key' (output present)", async () => {
    stubOutputStream();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "query",
      output: "out.jsonl",
    });

    await expect(runDynamoCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(queryItemsMock).not.toHaveBeenCalled();
  });

  test.each(["get", "query", "scan", "export"])(
    "throws ERR_DYNAMO_CRUD_CONFIG when operation '%s' is missing 'output'",
    async (operation) => {
      const deps = buildDeps({
        ...BASE_CONFIG,
        operation,
        key: JSON.stringify({ id: "42" }),
      });

      await expect(runDynamoCrud(deps)).rejects.toMatchObject({
        code: "ERR_DYNAMO_CRUD_CONFIG",
      });
      expect(getItemMock).not.toHaveBeenCalled();
      expect(queryItemsMock).not.toHaveBeenCalled();
      expect(scanSegmentMock).not.toHaveBeenCalled();
    },
  );

  test.each(["batch-write", "batch-delete", "import"])(
    "throws ERR_DYNAMO_CRUD_CONFIG when operation '%s' is missing 'input'",
    async (operation) => {
      const deps = buildDeps({ ...BASE_CONFIG, operation });

      await expect(runDynamoCrud(deps)).rejects.toMatchObject({
        code: "ERR_DYNAMO_CRUD_CONFIG",
      });
      expect(batchWriteItemsMock).not.toHaveBeenCalled();
      expect(batchDeleteItemsMock).not.toHaveBeenCalled();
      expect(describeTableMock).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_DYNAMO_CRUD_CONFIG chaining the SyntaxError as cause when 'key' is malformed JSON", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "get",
      key: "{not-json",
      output: "out.jsonl",
    });

    let thrown: unknown;
    try {
      await runDynamoCrud(deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect((thrown as Core.M3LError).cause).toBeInstanceOf(SyntaxError);
    expect(getItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG chaining the SyntaxError as cause when 'item' is malformed JSON", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "put",
      item: "not-json-either",
    });

    let thrown: unknown;
    try {
      await runDynamoCrud(deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect((thrown as Core.M3LError).cause).toBeInstanceOf(SyntaxError);
    expect(putItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when 'tableName' is stored as a non-string (defensive)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      tableName: 12345,
      operation: "get",
      key: JSON.stringify({ id: "42" }),
      output: "out.jsonl",
    });

    await expect(runDynamoCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(getItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "frobnicate",
    });

    await expect(runDynamoCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(getItemMock).not.toHaveBeenCalled();
    expect(putItemMock).not.toHaveBeenCalled();
  });
});

describe("runDynamoCrud — destructive-operation gate", () => {
  test("soft-lands on ERR_DYNAMO_CRUD_ABORTED: returns an all-zero summary and does not throw, logging a warning", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 10,
      tableStatus: "ACTIVE",
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "delete",
        key: JSON.stringify({ id: "42" }),
      },
      { confirm },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    const summary = await runDynamoCrud(deps);

    expect(summary).toEqual({ read: 0, written: 0, failed: 0, skipped: 0 });
    expect(deleteItemMock).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalled();
  });

  test("propagates a non-abort gate error (e.g. describeTable failure) instead of soft-landing", async () => {
    const describeError = new AWS.M3LDynamoDBOperationError(
      "describeTable failed",
      { context: { tableName: "orders" } },
    );
    describeTableMock.mockRejectedValue(describeError);
    const confirm = vi.fn().mockResolvedValue(true);
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "update",
        key: JSON.stringify({ id: "42" }),
        item: JSON.stringify({ status: "shipped" }),
      },
      { confirm },
    );

    await expect(runDynamoCrud(deps)).rejects.toThrow();
    expect(updateItemMock).not.toHaveBeenCalled();
  });
});

describe("runDynamoCrud — operation dispatch routing", () => {
  test("'get' calls AWS.getItem and reports it as a read, not a write", async () => {
    stubWriteFile();
    getItemMock.mockResolvedValue({ id: "42", status: "paid" });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "get",
      key: JSON.stringify({ id: "42" }),
      output: "out.jsonl",
    });
    const stepSpy = vi.spyOn(deps.logger, "step");

    const summary = await runDynamoCrud(deps);

    expect(getItemMock).toHaveBeenCalledWith(fakeDynamoDBDocument, "orders", {
      id: "42",
    });
    expect(summary).toEqual({ read: 1, written: 0, failed: 0, skipped: 0 });
    expect(stepSpy).toHaveBeenCalled();
  });

  test("'put' calls AWS.putItem and reports it as a write", async () => {
    stubWriteFile();
    putItemMock.mockResolvedValue(undefined);
    const item = { id: "42", status: "paid" };
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "put",
      item: JSON.stringify(item),
    });

    const summary = await runDynamoCrud(deps);

    expect(putItemMock).toHaveBeenCalledWith(
      fakeDynamoDBDocument,
      "orders",
      item,
    );
    expect(summary).toEqual({ read: 1, written: 1, failed: 0, skipped: 0 });
  });

  test("'update' passes the destructive gate then calls AWS.updateItem, reporting a write", async () => {
    stubWriteFile();
    describeTableMock.mockResolvedValue({
      itemCount: 5,
      tableStatus: "ACTIVE",
    });
    updateItemMock.mockResolvedValue({ id: "42", status: "shipped" });
    const confirm = vi.fn().mockResolvedValue(true);
    const key = { id: "42" };
    const patch = { status: "shipped" };
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "update",
        key: JSON.stringify(key),
        item: JSON.stringify(patch),
      },
      { confirm },
    );

    const summary = await runDynamoCrud(deps);

    expect(describeTableMock).toHaveBeenCalledWith(fakeDynamoDB, "orders");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(updateItemMock).toHaveBeenCalledWith(
      fakeDynamoDBDocument,
      "orders",
      key,
      patch,
    );
    expect(summary).toEqual({ read: 1, written: 1, failed: 0, skipped: 0 });
  });

  test("'delete' passes the destructive gate then calls AWS.deleteItem, reporting a write", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 5,
      tableStatus: "ACTIVE",
    });
    deleteItemMock.mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(true);
    const key = { id: "42" };
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "delete", key: JSON.stringify(key) },
      { confirm },
    );

    const summary = await runDynamoCrud(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteItemMock).toHaveBeenCalledWith(
      fakeDynamoDBDocument,
      "orders",
      key,
    );
    expect(summary).toEqual({ read: 1, written: 1, failed: 0, skipped: 0 });
  });

  test("'query' streams every yielded item to the output JSONL and counts each as a read", async () => {
    const output = stubOutputStream();
    queryItemsMock.mockImplementation(function fakeQueryItems() {
      return (async function* page() {
        await Promise.resolve();
        yield {
          items: [
            { userId: "42", id: "a" },
            { userId: "42", id: "b" },
          ],
          lastEvaluatedKey: undefined,
        };
      })();
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "query",
      key: JSON.stringify({ userId: "42" }),
      output: "out.jsonl",
    });

    const summary = await runDynamoCrud(deps);

    expect(queryItemsMock).toHaveBeenCalled();
    expect(summary).toEqual({ read: 2, written: 0, failed: 0, skipped: 0 });
    expect(readJSONLLines(output)).toEqual([
      { userId: "42", id: "a" },
      { userId: "42", id: "b" },
    ]);
  });

  test("'scan' streams every yielded item to the output JSONL and counts each as a read", async () => {
    const output = stubOutputStream();
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield {
          items: [{ id: "a" }, { id: "b" }, { id: "c" }],
          lastEvaluatedKey: undefined,
        };
      })();
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      output: "out.jsonl",
    });

    const summary = await runDynamoCrud(deps);

    expect(scanSegmentMock).toHaveBeenCalled();
    expect(queryItemsMock).not.toHaveBeenCalled();
    expect(summary).toEqual({ read: 3, written: 0, failed: 0, skipped: 0 });
    expect(readJSONLLines(output)).toHaveLength(3);
  });

  test("'export' also drives AWS.scanSegment (scan mode) and streams to the output JSONL", async () => {
    const output = stubOutputStream();
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "a" }], lastEvaluatedKey: undefined };
      })();
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "export",
      output: "out.jsonl",
    });

    const summary = await runDynamoCrud(deps);

    expect(scanSegmentMock).toHaveBeenCalled();
    expect(summary).toEqual({ read: 1, written: 0, failed: 0, skipped: 0 });
    expect(readJSONLLines(output)).toEqual([{ id: "a" }]);
  });

  test("'batch-write' reads the input file and calls AWS.batchWriteItems, reporting written count", async () => {
    stubInputFile(['{"id":"1"}', '{"id":"2"}', '{"id":"3"}'].join("\n"));
    batchWriteItemsMock.mockImplementation((_client, _table, items) =>
      Promise.resolve({ written: items.length, unprocessed: [] }),
    );
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "batch-write",
      input: "in.jsonl",
    });

    const summary = await runDynamoCrud(deps);

    expect(batchWriteItemsMock).toHaveBeenCalled();
    expect(batchDeleteItemsMock).not.toHaveBeenCalled();
    expect(summary).toEqual({ read: 3, written: 3, failed: 0, skipped: 0 });
  });

  test("'batch-delete' passes the destructive gate then calls AWS.batchDeleteItems, reporting written count", async () => {
    stubInputFile(['{"id":"1"}', '{"id":"2"}'].join("\n"));
    describeTableMock.mockResolvedValue({
      itemCount: 5,
      tableStatus: "ACTIVE",
    });
    batchDeleteItemsMock.mockImplementation((_client, _table, keys) =>
      Promise.resolve({ deleted: keys.length, unprocessed: [] }),
    );
    const confirm = vi.fn().mockResolvedValue(true);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "batch-delete", input: "in.jsonl" },
      { confirm },
    );

    const summary = await runDynamoCrud(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(batchDeleteItemsMock).toHaveBeenCalled();
    expect(batchWriteItemsMock).not.toHaveBeenCalled();
    expect(summary).toEqual({ read: 2, written: 2, failed: 0, skipped: 0 });
  });

  test("'import' passes the destructive gate then calls AWS.batchWriteItems (mode write), reporting written count", async () => {
    stubInputFile(['{"id":"1"}', '{"id":"2"}'].join("\n"));
    describeTableMock.mockResolvedValue({
      itemCount: 5,
      tableStatus: "ACTIVE",
    });
    batchWriteItemsMock.mockImplementation((_client, _table, items) =>
      Promise.resolve({ written: items.length, unprocessed: [] }),
    );
    const confirm = vi.fn().mockResolvedValue(true);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "import", input: "in.jsonl" },
      { confirm },
    );

    const summary = await runDynamoCrud(deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(batchWriteItemsMock).toHaveBeenCalled();
    expect(summary).toEqual({ read: 2, written: 2, failed: 0, skipped: 0 });
  });
});

describe("runDynamoCrud — bad record vs. source failure (batch input)", () => {
  test("a single malformed input line is skipped-and-counted while good records still get written", async () => {
    stubInputFile(
      ['{"id":"1"}', "not-json", '{"id":"2"}', '{"id":"3"}'].join("\n"),
    );
    batchWriteItemsMock.mockImplementation((_client, _table, items) =>
      Promise.resolve({ written: items.length, unprocessed: [] }),
    );
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "batch-write",
      input: "in.jsonl",
    });

    const summary = await runDynamoCrud(deps);

    expect(summary).toEqual({ read: 3, written: 3, failed: 0, skipped: 1 });
    expect(batchWriteItemsMock).toHaveBeenCalled();
  });

  test("an unreadable input source rejects the whole run rather than being folded into 'skipped'", async () => {
    vi.spyOn(fsp, "open").mockRejectedValue(new Error("ENOENT: no such file"));
    vi.spyOn(fsp, "readFile").mockRejectedValue(
      new Error("ENOENT: no such file"),
    );
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "batch-write",
      input: "missing.jsonl",
    });

    await expect(runDynamoCrud(deps)).rejects.toThrow();
    expect(batchWriteItemsMock).not.toHaveBeenCalled();
  });
});

describe("runDynamoCrud — checkpoint path keyed to runName/operation+tableName (fix #1)", () => {
  function mockOnePageScan(): void {
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "a" }], lastEvaluatedKey: undefined };
      })();
    });
  }

  test("checkpointPath is identical across two runs with different correlationId values (no runName set)", async () => {
    mockOnePageScan();
    const configValues = {
      ...BASE_CONFIG,
      operation: "scan",
      output: "out.jsonl",
    };

    stubOutputStream();
    await runDynamoCrud({
      ...buildDeps(configValues),
      correlationId: "run-1",
    });
    stubOutputStream();
    await runDynamoCrud({
      ...buildDeps(configValues),
      correlationId: "run-2",
    });

    expect(scanTableMock).toHaveBeenCalledTimes(2);
    const paths = new Core.M3LPaths();
    const expectedCheckpointPath = paths.resolveOutput(
      "scan-orders.checkpoint.json",
    );
    const firstCallOptions = scanTableMock.mock.calls[0]?.[0];
    const secondCallOptions = scanTableMock.mock.calls[1]?.[0];
    expect(firstCallOptions?.checkpointPath).toBe(expectedCheckpointPath);
    expect(secondCallOptions?.checkpointPath).toBe(expectedCheckpointPath);
    // Both runs used the SAME checkpoint path despite different
    // correlationId values — the bug this guards against tied checkpointPath
    // to correlationId, which would have produced two distinct paths here.
    expect(firstCallOptions?.checkpointPath).toBe(
      secondCallOptions?.checkpointPath,
    );
  });

  test("an explicit 'runName' overrides the operation+tableName fallback", async () => {
    mockOnePageScan();
    stubOutputStream();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      output: "out.jsonl",
      runName: "my-custom-job",
    });

    await runDynamoCrud(deps);

    expect(scanTableMock).toHaveBeenCalledTimes(1);
    const paths = new Core.M3LPaths();
    const expectedCheckpointPath = paths.resolveOutput(
      "my-custom-job.checkpoint.json",
    );
    const unexpectedFallbackPath = paths.resolveOutput(
      "scan-orders.checkpoint.json",
    );
    const callOptions = scanTableMock.mock.calls[0]?.[0];
    expect(callOptions?.checkpointPath).toBe(expectedCheckpointPath);
    expect(callOptions?.checkpointPath).not.toBe(unexpectedFallbackPath);
  });
});

describe("runDynamoCrud — a batch run left with failed items rejects (fix #2)", () => {
  test("'batch-write' leaving items permanently unprocessed after retry rejects with ERR_DYNAMO_CRUD_FAILED_ITEMS", async () => {
    stubInputFile(['{"id":"1"}', '{"id":"2"}', '{"id":"3"}'].join("\n"));
    stubOutputStream();
    // Every attempt leaves one item unprocessed, so the runner's own attempt
    // bound (default maxAttempts) exhausts without ever fully succeeding.
    batchWriteItemsMock.mockImplementation((_client, _table, items) =>
      Promise.resolve({
        written: items.length - 1,
        unprocessed: [{ id: "3" }],
      }),
    );
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "batch-write",
      input: "in.jsonl",
    });

    vi.useFakeTimers();
    let thrown: unknown;
    try {
      await settleWithTimers(runDynamoCrud(deps));
    } catch (error) {
      thrown = error;
    } finally {
      vi.useRealTimers();
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_FAILED_ITEMS");
    expect(batchWriteItemsMock.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("runDynamoCrud — the production retry-classifier composition actually retries (fix #3)", () => {
  test("a chunk with transient unprocessed items succeeds on a later attempt instead of failing on the first", async () => {
    stubInputFile(['{"id":"1"}', '{"id":"2"}'].join("\n"));
    stubOutputStream();
    let callCount = 0;
    batchWriteItemsMock.mockImplementation((_client, _table, items) => {
      callCount += 1;
      if (callCount === 1) {
        // First attempt: one item confirmed, one still unprocessed — this is
        // `batch-write-table`'s internal retry sentinel
        // (`BATCH_RETRY_ERROR_CODE`), not a genuine AWS throttling error, so
        // only the composed classifier (not `Core.awsThrottlingClassifier`
        // alone) recognizes it as retriable.
        return Promise.resolve({ written: 1, unprocessed: [{ id: "2" }] });
      }
      // Second (and any later) attempt: the remaining item is now confirmed.
      return Promise.resolve({ written: items.length, unprocessed: [] });
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "batch-write",
      input: "in.jsonl",
    });

    vi.useFakeTimers();
    let summary: RunDynamoCrudSummary | undefined;
    try {
      summary = await settleWithTimers(runDynamoCrud(deps));
    } finally {
      vi.useRealTimers();
    }

    // Proves the sentinel was classified "retriable" (not "unknown" ->
    // "fatal") and the runner actually looped: without the composed
    // classifier, the first unprocessed result would be classified
    // "unknown" and resolved "fatal" by `unknownDecision: "fatal"`,
    // folding into `failed` on the very first attempt — batchWriteItems
    // would be called exactly once and `failed` would be nonzero.
    expect(batchWriteItemsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(summary).toEqual({ read: 2, written: 2, failed: 0, skipped: 0 });
  });
});

describe("type contract", () => {
  test("RunDynamoCrudSummary's four fields are numbers and runDynamoCrud resolves it", () => {
    expectTypeOf<RunDynamoCrudSummary["read"]>().toBeNumber();
    expectTypeOf<RunDynamoCrudSummary["written"]>().toBeNumber();
    expectTypeOf<RunDynamoCrudSummary["failed"]>().toBeNumber();
    expectTypeOf<RunDynamoCrudSummary["skipped"]>().toBeNumber();
    expectTypeOf(runDynamoCrud).returns.toEqualTypeOf<
      Promise<RunDynamoCrudSummary>
    >();
  });

  test("runDynamoCrud's deps.dynamoDBDocument/dynamoDB are structurally derived from AWS.getItem/describeTable, never the SDK", () => {
    expectTypeOf<
      Parameters<typeof runDynamoCrud>[0]["dynamoDBDocument"]
    >().toEqualTypeOf<Parameters<typeof AWS.getItem>[0]>();
    expectTypeOf<
      Parameters<typeof runDynamoCrud>[0]["dynamoDB"]
    >().toEqualTypeOf<Parameters<typeof AWS.describeTable>[0]>();
  });
});
