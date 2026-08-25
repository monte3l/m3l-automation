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
// inspect the `checkpointStore` it was actually invoked with (fix #1 —
// `--resume`'s checkpoint identity must be keyed to `runName`/`operation`+
// `tableName`, never the fresh-per-invocation `correlationId`). The real
// implementation still runs underneath; this is a spy, not a stub.
vi.mock("../src/steps/scan-table.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScanTableModule>();
  return { ...actual, scanTable: vi.fn(actual.scanTable) };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type { RunDynamodbCrudSummary } from "../src/steps/run-dynamodb-crud.js";
import { runDynamodbCrud } from "../src/steps/run-dynamodb-crud.js";
import { scanTable } from "../src/steps/scan-table.js";

/**
 * Contract: docs/reference/scripts/dynamodb-crud.md, `run-dynamodb-crud` row —
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
// used only to inspect what `checkpointStore` a run actually invoked it with.
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
  /**
   * Mirrors real `fs.WriteStream#bytesWritten`: the running total of bytes
   * pushed through `write()`/`end(chunk)` — backs the resume-seam
   * (`M3LListExporterStreamWriter#bytesWritten`) tests below, mirroring
   * `packages/m3l-common/tests/exporters.test.ts`'s own `FakeWriteStream`.
   */
  bytesWritten = 0;

  write(chunk: string | Buffer, cb?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk.toString());
    this.bytesWritten += Buffer.byteLength(chunk.toString());
    queueMicrotask(() => {
      cb?.();
    });
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.chunks.push(chunk.toString());
      this.bytesWritten += Buffer.byteLength(chunk.toString());
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

/**
 * Same as {@link stubOutputStream}, but also returns the `createWriteStream`
 * spy so a test can assert on the exact arguments the exporter opened the
 * stream with (plain `filePath` vs. `(filePath, { flags, start })`) — the
 * resume-seam regression coverage (fix #4) needs this to prove a resumed run
 * never truncates prior output.
 */
function stubOutputStreamWithSpy() {
  const output = new FakeWriteStream();
  const spy = vi
    .spyOn(fs, "createWriteStream")
    .mockReturnValue(output as unknown as WriteStream);
  return { output, spy };
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
  // Required (Core.AWS_PROFILE_PARAM_NAME, declared `required: true` in
  // config.ts) — set here so every test in this file keeps exercising its
  // OWN intended config-guard scenario once `resolveSettings` starts
  // requiring `aws.profile` too (issue #497 gap 1); without this, every
  // test that omits it would start failing on a missing-profile guard
  // instead of the field each test actually means to cover. Tests that need
  // a specific/distinct profile value (the checkpoint-definition
  // `awsProfile` projection tests) override it explicitly.
  [Core.AWS_PROFILE_PARAM_NAME]: "test-profile",
  tableName: "orders",
  batchSize: 100,
  totalSegments: 1,
  maxInFlightBatches: 4,
  checkpointEveryPages: 25,
  resume: false,
  progressEveryRecords: 10_000,
};

/**
 * Builds a mock `M3LPromptAdapter` as an object of `vi.fn()`s — mirrors
 * `packages/m3l-common/tests/prompt.test.ts`'s `makeMockAdapter`. Left
 * inferred (not annotated as `M3LPromptAdapter`): several adapter methods are
 * generic over `Value`, and a non-generic `vi.fn()` mock is not a valid
 * override of a generic method signature under an explicit interface
 * annotation.
 */
function makeMockPromptAdapter() {
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

/** Builds a real `Core.M3LPrompt` over a mock adapter whose `confirm` resolves `outcome`. */
function buildPrompt(outcome = true): {
  readonly prompt: Core.M3LPrompt;
  readonly adapter: ReturnType<typeof makeMockPromptAdapter>;
} {
  const adapter = makeMockPromptAdapter();
  adapter.confirm.mockResolvedValue(outcome);
  return { prompt: new Core.M3LPrompt({ adapter }), adapter };
}

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: {
    readonly prompt?: Core.M3LPrompt;
    readonly reportRecovery?: (entry: Core.M3LRunRecoveryEntry) => void;
  },
): Parameters<typeof runDynamodbCrud>[0] {
  return {
    config: buildConfig(configValues),
    paths: new Core.M3LPaths(),
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    dynamoDBDocument: fakeDynamoDBDocument,
    dynamoDB: fakeDynamoDB,
    prompt: overrides?.prompt ?? buildPrompt(true).prompt,
    reportRecovery: overrides?.reportRecovery ?? vi.fn(),
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

describe("runDynamodbCrud — config guards (fire before any AWS call)", () => {
  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'get' is missing 'key'", async () => {
    stubWriteFile();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "get",
      output: "out.jsonl",
    });

    let thrown: unknown;
    try {
      await runDynamodbCrud(deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect(getItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'delete' is missing 'key'", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "delete" });

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(deleteItemMock).not.toHaveBeenCalled();
    expect(describeTableMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when operation 'put' is missing 'item'", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "put" });

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
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

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
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

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
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

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
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

      await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
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

      await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
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
      await runDynamodbCrud(deps);
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
      await runDynamodbCrud(deps);
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

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(getItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "frobnicate",
    });

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(getItemMock).not.toHaveBeenCalled();
    expect(putItemMock).not.toHaveBeenCalled();
  });

  test("throws ERR_DYNAMO_CRUD_CONFIG when 'tableName' is stored as an empty string (required-variant empty rejection)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      tableName: "",
      operation: "get",
      key: JSON.stringify({ id: "42" }),
      output: "out.jsonl",
    });

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(getItemMock).not.toHaveBeenCalled();
  });

  test.each([
    "batchSize",
    "totalSegments",
    "maxInFlightBatches",
    "checkpointEveryPages",
    "progressEveryRecords",
  ])(
    "throws ERR_DYNAMO_CRUD_CONFIG when '%s' is stored as a non-number (defensive)",
    async (field) => {
      const deps = buildDeps({
        ...BASE_CONFIG,
        [field]: "not-a-number",
        operation: "get",
        key: JSON.stringify({ id: "42" }),
        output: "out.jsonl",
      });

      await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
        code: "ERR_DYNAMO_CRUD_CONFIG",
      });
      expect(getItemMock).not.toHaveBeenCalled();
    },
  );

  test("throws ERR_DYNAMO_CRUD_CONFIG when 'resume' is stored as a non-boolean (defensive)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      resume: "yes",
      operation: "get",
      key: JSON.stringify({ id: "42" }),
      output: "out.jsonl",
    });

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
      code: "ERR_DYNAMO_CRUD_CONFIG",
    });
    expect(getItemMock).not.toHaveBeenCalled();
  });
});

describe("runDynamodbCrud — destructive-operation gate", () => {
  test("soft-lands on ERR_DYNAMO_CRUD_ABORTED: returns an all-zero summary and does not throw, logging a warning", async () => {
    describeTableMock.mockResolvedValue({
      itemCount: 10,
      tableStatus: "ACTIVE",
    });
    const { prompt } = buildPrompt(false);
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "delete",
        key: JSON.stringify({ id: "42" }),
      },
      { prompt },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    const summary = await runDynamodbCrud(deps);

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
    const { prompt } = buildPrompt(true);
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "update",
        key: JSON.stringify({ id: "42" }),
        item: JSON.stringify({ status: "shipped" }),
      },
      { prompt },
    );

    await expect(runDynamodbCrud(deps)).rejects.toThrow();
    expect(updateItemMock).not.toHaveBeenCalled();
  });
});

describe("runDynamodbCrud — operation dispatch routing", () => {
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

    const summary = await runDynamodbCrud(deps);

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

    const summary = await runDynamodbCrud(deps);

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
    const { prompt, adapter } = buildPrompt(true);
    const key = { id: "42" };
    const patch = { status: "shipped" };
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "update",
        key: JSON.stringify(key),
        item: JSON.stringify(patch),
      },
      { prompt },
    );

    const summary = await runDynamodbCrud(deps);

    expect(describeTableMock).toHaveBeenCalledWith(fakeDynamoDB, "orders");
    expect(adapter.confirm).toHaveBeenCalledTimes(1);
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
    const { prompt, adapter } = buildPrompt(true);
    const key = { id: "42" };
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "delete", key: JSON.stringify(key) },
      { prompt },
    );

    const summary = await runDynamodbCrud(deps);

    expect(adapter.confirm).toHaveBeenCalledTimes(1);
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

    const summary = await runDynamodbCrud(deps);

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

    const summary = await runDynamodbCrud(deps);

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

    const summary = await runDynamodbCrud(deps);

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

    const summary = await runDynamodbCrud(deps);

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
    const { prompt, adapter } = buildPrompt(true);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "batch-delete", input: "in.jsonl" },
      { prompt },
    );

    const summary = await runDynamodbCrud(deps);

    expect(adapter.confirm).toHaveBeenCalledTimes(1);
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
    const { prompt, adapter } = buildPrompt(true);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "import", input: "in.jsonl" },
      { prompt },
    );

    const summary = await runDynamodbCrud(deps);

    expect(adapter.confirm).toHaveBeenCalledTimes(1);
    expect(batchWriteItemsMock).toHaveBeenCalled();
    expect(summary).toEqual({ read: 2, written: 2, failed: 0, skipped: 0 });
  });
});

describe("runDynamodbCrud — export writer close() failure attribution (mirrors run-query.ts's closeWriterAfterRun)", () => {
  /**
   * Same as {@link stubOutputStream}, but the underlying stream emits an
   * 'error' instead of 'finish' when `end()` is called — simulates a
   * `close()` failure (e.g. a resumed run whose checkpoint claims more
   * output bytes than the file actually has, a failure the writer defers
   * until its first `write()`/`end()` call) for the tests below.
   */
  function stubOutputStreamFailingClose(closeError: Error): void {
    const output = new FakeWriteStream();
    output.end = (chunk?: string | Buffer): FakeWriteStream => {
      if (chunk !== undefined) {
        output.chunks.push(chunk.toString());
        output.bytesWritten += Buffer.byteLength(chunk.toString());
      }
      queueMicrotask(() => {
        output.emit("error", closeError);
      });
      return output;
    };
    vi.spyOn(fs, "createWriteStream").mockReturnValue(
      output as unknown as WriteStream,
    );
  }

  test("scan completes successfully but the writer's close() then fails: throws ERR_DYNAMO_CRUD_OUTPUT_WRITER chaining the close error", async () => {
    const closeError = new Error("disk full");
    stubOutputStreamFailingClose(closeError);
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "a" }], lastEvaluatedKey: undefined };
      })();
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      output: "out.jsonl",
    });

    let thrown: unknown;
    try {
      await runDynamodbCrud(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe(
      "ERR_DYNAMO_CRUD_OUTPUT_WRITER",
    );
    // The exporter's writer.close() already wraps the raw stream 'error' as
    // its own M3LError (code ERR_JSON_LIST_EXPORT) before rejecting — the
    // dynamodb-crud wrapper chains THAT as its cause, which in turn chains
    // the original raw close failure.
    const chained = (thrown as Core.M3LError).cause;
    expect(chained).toBeInstanceOf(Core.M3LError);
    expect((chained as Core.M3LError).code).toBe("ERR_JSON_LIST_EXPORT");
    expect((chained as Core.M3LError).cause).toBe(closeError);
  });

  test("a source failure mid-scan whose best-effort close() also fails still throws the original wrapped error, only logging the close failure", async () => {
    const closeError = new Error("close also failed");
    stubOutputStreamFailingClose(closeError);
    const scanError = new Error("scanSegment failed");
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      // eslint-disable-next-line require-yield -- intentionally never yields; this generator always throws before any record
      return (async function* page() {
        await Promise.resolve();
        throw scanError;
      })();
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      output: "out.jsonl",
    });
    const warningSpy = vi.spyOn(deps.logger, "warning");

    let thrown: unknown;
    try {
      await runDynamodbCrud(deps);
    } catch (error) {
      thrown = error;
    }

    // scanSegment's raw failure (not already an M3LError) gets wrapped by
    // streamToExporter as ERR_DYNAMO_CRUD_OUTPUT, chaining the original —
    // NOT replaced by the also-failing close() call, which is only logged.
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_OUTPUT");
    expect((thrown as Core.M3LError).cause).toBe(scanError);
    expect(warningSpy).toHaveBeenCalled();
  });
});

describe("runDynamodbCrud — bad record vs. source failure (batch input)", () => {
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

    const summary = await runDynamodbCrud(deps);

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

    await expect(runDynamodbCrud(deps)).rejects.toThrow();
    expect(batchWriteItemsMock).not.toHaveBeenCalled();
  });
});

describe("runDynamodbCrud — checkpoint identity keyed to runName/operation+tableName (fix #1)", () => {
  function mockOnePageScan(): void {
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "a" }], lastEvaluatedKey: undefined };
      })();
    });
  }

  /**
   * `Core` is never mocked in this file (see the top-of-file `vi.mock`
   * factory), so `scanTable`'s real, unmocked completion path constructs a
   * real `Core.M3LCheckpointStore` and calls its real `.write()`/`.delete()`
   * — which would otherwise perform real `fsp.writeFile`/`fsp.rename`/
   * `fsp.unlink` calls against the real `data/output/` directory
   * (`M3LCheckpointStore.write()` uses `internal/files/atomicWrite`'s
   * write-temp-then-rename; `.delete()` uses `fsp.unlink` directly — see
   * `packages/m3l-common/src/core/checkpoint/M3LCheckpointStore.ts`).
   * `Core.M3LPaths.resolveOutput` itself performs no filesystem I/O (it is a
   * pure path computation, per its own TSDoc), so stubbing only the three
   * fs primitives below — not `resolveOutput` — keeps both tests' real,
   * deterministic `paths.resolveOutput(...)` equality/inequality assertions
   * intact while guaranteeing no real file is ever written, renamed, or
   * unlinked.
   */
  function stubCheckpointFs(): void {
    vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsp, "rename").mockResolvedValue(undefined);
    vi.spyOn(fsp, "unlink").mockResolvedValue(undefined);
  }

  test("checkpointStore.path is identical across two runs with different correlationId values (no runName set)", async () => {
    mockOnePageScan();
    stubCheckpointFs();
    const configValues = {
      ...BASE_CONFIG,
      operation: "scan",
      output: "out.jsonl",
    };

    stubOutputStream();
    await runDynamodbCrud({
      ...buildDeps(configValues),
      correlationId: "run-1",
    });
    stubOutputStream();
    await runDynamodbCrud({
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
    expect(firstCallOptions?.checkpointStore.path).toBe(expectedCheckpointPath);
    expect(secondCallOptions?.checkpointStore.path).toBe(
      expectedCheckpointPath,
    );
    // Both runs used the SAME checkpoint identity despite different
    // correlationId values — the bug this guards against tied the checkpoint
    // identity to correlationId, which would have produced two distinct
    // paths here.
    expect(firstCallOptions?.checkpointStore.path).toBe(
      secondCallOptions?.checkpointStore.path,
    );
  });

  test("an explicit 'runName' overrides the operation+tableName fallback", async () => {
    mockOnePageScan();
    stubCheckpointFs();
    stubOutputStream();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      output: "out.jsonl",
      runName: "my-custom-job",
    });

    await runDynamodbCrud(deps);

    expect(scanTableMock).toHaveBeenCalledTimes(1);
    const paths = new Core.M3LPaths();
    const expectedCheckpointPath = paths.resolveOutput(
      "my-custom-job.checkpoint.json",
    );
    const unexpectedFallbackPath = paths.resolveOutput(
      "scan-orders.checkpoint.json",
    );
    const callOptions = scanTableMock.mock.calls[0]?.[0];
    expect(callOptions?.checkpointStore.path).toBe(expectedCheckpointPath);
    expect(callOptions?.checkpointStore.path).not.toBe(unexpectedFallbackPath);
  });
});

describe("runDynamodbCrud — resumed scan opens output for r+ append, never truncates prior output (fix #4, data-loss bug)", () => {
  /**
   * Same rationale as `stubCheckpointFs` above (checkpoint I/O is real,
   * unmocked `Core.M3LCheckpointStore` machinery in this file) — stubs the
   * three fs primitives its write/delete paths use so no real file is ever
   * written, renamed, or unlinked.
   */
  function stubCheckpointWrites(): void {
    vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fsp, "rename").mockResolvedValue(undefined);
    vi.spyOn(fsp, "unlink").mockResolvedValue(undefined);
  }

  test("resume: true threads the checkpointed outputBytes into the exporter — createWriteStream opens r+ at that offset, not a truncating write", async () => {
    stubCheckpointWrites();
    const resumeOutputBytes = 512;
    // The exporter's resume guard reads fs.statSync before fs.truncateSync
    // to refuse resuming onto a file shorter than the checkpointed offset —
    // stub it to report a large-enough on-disk size so the happy-path
    // resume actually reaches truncateSync.
    vi.spyOn(fs, "statSync").mockReturnValue({
      size: resumeOutputBytes,
    } as fs.Stats);
    vi.spyOn(fs, "truncateSync").mockImplementation(() => undefined);
    // Bare (non-enveloped) checkpoint content: `M3LCheckpointStore.read()`
    // accepts a pre-existing bare-format file with no integrity check, which
    // keeps this fixture a plain JSON literal instead of a computed
    // checksum envelope. Segment "0" is already fully drained (`null`);
    // segment "1" is still in progress — the mixed-state case the fix must
    // handle correctly.
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      JSON.stringify({
        segments: { "0": null, "1": { cursorId: "abc" } },
        outputBytes: resumeOutputBytes,
      }),
    );
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "resumed" }], lastEvaluatedKey: undefined };
      })();
    });
    const { spy: createWriteStreamSpy } = stubOutputStreamWithSpy();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      totalSegments: 2,
      resume: true,
      output: "out.jsonl",
    });

    await runDynamodbCrud(deps);

    const paths = new Core.M3LPaths();
    const expectedOutputPath = paths.resolveOutput("out.jsonl");
    // This is the regression assertion: the bug this test guards against
    // constructed a fresh, truncating exporter on every `--resume` run at
    // the same `outputPath`, silently destroying every record a prior
    // interrupted run had already written. A plain
    // `createWriteStream(expectedOutputPath)` call here (no options object)
    // would reproduce that data loss.
    expect(createWriteStreamSpy).toHaveBeenCalledWith(expectedOutputPath, {
      flags: "r+",
      start: resumeOutputBytes,
    });
  });

  test("a fresh (non-resume) 'scan' run still opens the output with a plain truncating createWriteStream(filePath) call", async () => {
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "a" }], lastEvaluatedKey: undefined };
      })();
    });
    const { spy: createWriteStreamSpy } = stubOutputStreamWithSpy();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      resume: false,
      output: "out.jsonl",
    });

    await runDynamodbCrud(deps);

    const paths = new Core.M3LPaths();
    const expectedOutputPath = paths.resolveOutput("out.jsonl");
    expect(createWriteStreamSpy).toHaveBeenCalledWith(expectedOutputPath);
    expect(createWriteStreamSpy.mock.calls[0]).toHaveLength(1);
  });
});

describe("runDynamodbCrud — a batch run left with failed items reports recovery (fix #2)", () => {
  test("'batch-write' leaving items permanently unprocessed after retry resolves and reports recovery, not a throw", async () => {
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
    const reportRecovery = vi.fn();
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "batch-write",
        input: "in.jsonl",
      },
      { reportRecovery },
    );

    vi.useFakeTimers();
    try {
      const summary = await settleWithTimers(runDynamodbCrud(deps));

      expect(summary).toEqual({ read: 3, written: 2, failed: 1, skipped: 0 });
      expect(batchWriteItemsMock.mock.calls.length).toBeGreaterThan(1);
      expect(reportRecovery).toHaveBeenCalledTimes(1);
      expect(reportRecovery).toHaveBeenCalledWith({
        item: JSON.stringify({ id: "3" }),
        error: [
          expect.objectContaining({
            name: "M3LError",
            message: "item remained unprocessed after retry",
          }),
        ],
        recordedAt: expect.any(String) as string,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runDynamodbCrud — the production retry-classifier composition actually retries (fix #3)", () => {
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
    let summary: RunDynamodbCrudSummary | undefined;
    try {
      summary = await settleWithTimers(runDynamodbCrud(deps));
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

describe("runDynamodbCrud — cooperative cancellation via deps.signal (ADR-0049)", () => {
  /**
   * `Core.M3LRetryRunner` checks `signal.aborted` before its first attempt
   * AND as the first action inside `catch` — before the classifier runs —
   * so an already-aborted signal always wins over "is this retriable" (see
   * `packages/m3l-common/src/core/polling/M3LRetryRunner.ts`). `dispatchBatch`
   * is expected to forward `deps.signal` into the `Core.M3LRetryRunner`
   * constructor it builds for `batch-write-table`; until it does, this
   * signal is silently ignored and the real (unmocked) retry runner runs the
   * batch to a normal success, so this proves the wiring rather than
   * `M3LRetryRunner`'s own abort behavior (already covered in
   * `packages/m3l-common/tests/polling.test.ts`).
   */
  test("'batch-write' rejects with M3LOperationAbortedError, never calling AWS.batchWriteItems, when the signal is already aborted", async () => {
    stubInputFile(['{"id":"1"}', '{"id":"2"}'].join("\n"));
    batchWriteItemsMock.mockImplementation((_client, _table, items) =>
      Promise.resolve({ written: items.length, unprocessed: [] }),
    );
    const controller = new AbortController();
    controller.abort();
    const deps = {
      ...buildDeps({
        ...BASE_CONFIG,
        operation: "batch-write",
        input: "in.jsonl",
      }),
      signal: controller.signal,
    };

    let thrown: unknown;
    try {
      await runDynamodbCrud(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LOperationAbortedError);
    expect(batchWriteItemsMock).not.toHaveBeenCalled();
  });

  /**
   * `dispatchSingleItem`/`dispatchScan` never construct an
   * `M3LRetryRunner` themselves and are out of scope for #481's
   * `dynamodb-crud` retrofit — only `dispatchBatch` forwards `signal`. A
   * `get` on an already-aborted signal must therefore still resolve
   * normally: this pins that the cancellation seam is scoped to the batch
   * family and does not accidentally leak into the single-item path.
   */
  test("'get' ignores an already-aborted signal and still resolves normally (out of scope for #481's batch-only retrofit)", async () => {
    stubWriteFile();
    getItemMock.mockResolvedValue({ id: "42" });
    const controller = new AbortController();
    controller.abort();
    const deps = {
      ...buildDeps({
        ...BASE_CONFIG,
        operation: "get",
        key: JSON.stringify({ id: "42" }),
        output: "out.jsonl",
      }),
      signal: controller.signal,
    };

    const summary = await runDynamodbCrud(deps);

    expect(summary).toEqual({ read: 1, written: 0, failed: 0, skipped: 0 });
    expect(getItemMock).toHaveBeenCalled();
  });
});

describe("runDynamodbCrud — scan/query/export checkpoint 'definition' projection (issue #497)", () => {
  /**
   * `Core.M3LCheckpointStore` is the REAL, unmocked class in this file — the
   * top-of-file `vi.mock("@m3l-automation/m3l-common", ...)` factory only
   * overrides `AWS.*`, never `Core` (confirmed by reading the factory above;
   * the task brief that prompted this describe block assumed a constructor
   * spy already existed here, which is not the case). So these tests prove
   * what `definition` `dispatchScan` supplies to the store the same way any
   * other caller could observe it: through the store's own documented,
   * PUBLIC behavior — the `fingerprint` it stamps onto the checkpoint
   * envelope on `write()`, and the `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"` it
   * throws from `read()` when a definition changes between runs — rather
   * than by reaching into a private field or reassigning a frozen ES module
   * namespace binding (`Core.M3LCheckpointStore` cannot be `vi.spyOn`-ed
   * directly; it is non-configurable).
   *
   * `write()`'s envelope is persisted via `internal/files/atomicWrite`'s
   * `fsp.writeFile(tempPath, contents, "utf8")` (see
   * `packages/m3l-common/src/internal/files/atomicWrite.ts`), so spying on
   * `fsp.writeFile` and parsing the captured JSON body is how the fingerprint
   * is observed without ever reading a private field.
   *
   * The "key must be gated to query mode" tests below (issue #497 gap 2)
   * likewise prove the omission through fingerprint divergence rather than a
   * literal `Object.hasOwn` on the raw definition object: reading
   * `packages/m3l-common/src/core/checkpoint/M3LCheckpointStore.ts` confirms
   * the fingerprint is computed inside the constructor from a module-private
   * `canonicalJsonHash` import (`../json/index.js`), never through the
   * `Core.canonicalJsonHash` barrel binding this file's `vi.mock(...)`
   * factory could intercept — so there is no seam to capture the raw
   * definition object short of wrapping the class itself (an approach the
   * comment above already rejects as too invasive for this file's shared
   * mock factory). `M3LCheckpointStore`'s own documented projection
   * semantics make the hash a faithful proxy for `Object.hasOwn` in exactly
   * this scenario: an *omitted* key and a key explicitly set to `undefined`
   * fingerprint identically by design, but `settings.key` in every test below
   * is real, defined data (never `undefined`) — so a definition that leaks
   * `key` in produces a different hash than one that correctly omits it.
   */
  function stubCheckpointWritesCapturing() {
    const writeFileSpy = vi
      .spyOn(fsp, "writeFile")
      .mockResolvedValue(undefined);
    vi.spyOn(fsp, "rename").mockResolvedValue(undefined);
    vi.spyOn(fsp, "unlink").mockResolvedValue(undefined);
    return writeFileSpy;
  }

  /** One page, one item, fully drains every segment on the first pass. */
  function mockOnePageScan(): void {
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "a" }], lastEvaluatedKey: undefined };
      })();
    });
  }

  /** One page, one item, fully drains every segment on the first pass (query mode). */
  function mockOnePageQuery(): void {
    queryItemsMock.mockImplementation(function fakeQueryItems() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [{ id: "a" }], lastEvaluatedKey: undefined };
      })();
    });
  }

  /** One empty page — fully drains every segment without yielding any item. */
  function mockOneEmptyPageScan(): void {
    scanSegmentMock.mockImplementation(function fakeScanSegment() {
      return (async function* page() {
        await Promise.resolve();
        yield { items: [], lastEvaluatedKey: undefined };
      })();
    });
  }

  /** Narrows a JSON-parsed checkpoint envelope body to its `fingerprint` field. */
  function readEnvelopeFingerprint(body: unknown): string | undefined {
    if (typeof body !== "string") return undefined;
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const fingerprint = (parsed as Record<string, unknown>)["fingerprint"];
    return typeof fingerprint === "string" ? fingerprint : undefined;
  }

  /**
   * Finds the checkpoint envelope among every captured `fsp.writeFile` call
   * (identified by the `__m3lCheckpointFormat` marker, so an unrelated write
   * can never be mistaken for it) and returns its `fingerprint` field —
   * `undefined` when the envelope carries no `fingerprint` at all (the
   * pre-#497 shape: no `definition` was ever supplied to the constructor, so
   * `write()` omits the field entirely rather than persisting `undefined`).
   */
  function capturedFingerprint(
    writeFileSpy: ReturnType<typeof stubCheckpointWritesCapturing>,
  ): string | undefined {
    for (const call of writeFileSpy.mock.calls) {
      const body = call[1];
      if (typeof body === "string" && body.includes("__m3lCheckpointFormat")) {
        return readEnvelopeFingerprint(body);
      }
    }
    throw new Error("expected a checkpoint envelope to have been written");
  }

  test("a fresh query's written checkpoint fingerprints mode/tableName/totalSegments/indexName/key/output/awsProfile, excluding runName/batchSize/checkpointEveryPages/item (indexName & key present, mode derived not raw operation)", async () => {
    mockOnePageQuery();
    const writeFileSpy = stubCheckpointWritesCapturing();
    stubOutputStream();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "query",
      tableName: "widgets",
      totalSegments: 2,
      checkpointEveryPages: 1,
      indexName: "byStatus",
      key: JSON.stringify({ status: "paid" }),
      item: JSON.stringify({ status: "shipped" }),
      runName: "definition-test-run",
      output: "out.jsonl",
      [Core.AWS_PROFILE_PARAM_NAME]: "acct-query",
    });

    await runDynamodbCrud(deps);

    const actualFingerprint = capturedFingerprint(writeFileSpy);
    const expectedDefinition = {
      mode: "query",
      tableName: "widgets",
      totalSegments: 2,
      indexName: "byStatus",
      key: { status: "paid" },
      output: "out.jsonl",
      awsProfile: "acct-query",
    };
    expect(actualFingerprint).toBe(Core.canonicalJsonHash(expectedDefinition));
    // Representative excluded fields (runName, batchSize, checkpointEveryPages,
    // item): each is set to a real, defined value above, so a mistaken
    // inclusion would change the fingerprint away from the expected value —
    // the `toBe` assertion above is already the primary proof; these
    // `not.toBe` checks name the specific mistakes independently for
    // readability when a failure is triaged.
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash({
        ...expectedDefinition,
        runName: "definition-test-run",
      }),
    );
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash({ ...expectedDefinition, batchSize: 100 }),
    );
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash({
        ...expectedDefinition,
        checkpointEveryPages: 1,
      }),
    );
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash({
        ...expectedDefinition,
        item: { status: "shipped" },
      }),
    );
    // The pre-#497 raw-operation shape must NOT be what was actually
    // fingerprinted — pins that "operation" (not "mode") is not silently
    // still present alongside/instead of the derived value.
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash({
        ...expectedDefinition,
        mode: undefined,
        operation: "query",
      }),
    );
  });

  test("a fresh export's written checkpoint fingerprint matches a definition with mode 'scan' (not raw operation 'export') and indexName/key/awsProfile, when indexName/key are unset (indexName & key absent)", async () => {
    mockOnePageScan();
    const writeFileSpy = stubCheckpointWritesCapturing();
    stubOutputStream();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "export",
      tableName: "widgets",
      totalSegments: 1,
      checkpointEveryPages: 1,
      output: "out.jsonl",
      [Core.AWS_PROFILE_PARAM_NAME]: "acct-export",
    });

    await runDynamodbCrud(deps);

    const actualFingerprint = capturedFingerprint(writeFileSpy);
    const expectedDefinition = {
      mode: "scan",
      tableName: "widgets",
      totalSegments: 1,
      output: "out.jsonl",
      awsProfile: "acct-export",
    };
    expect(actualFingerprint).toBe(Core.canonicalJsonHash(expectedDefinition));
  });

  test("issue #497 gap 1: the definition's awsProfile reflects the resolved aws.profile config value, not a hardcoded/omitted one", async () => {
    mockOnePageScan();
    const writeFileSpy = stubCheckpointWritesCapturing();
    stubOutputStream();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      tableName: "widgets",
      totalSegments: 1,
      checkpointEveryPages: 1,
      output: "out.jsonl",
      [Core.AWS_PROFILE_PARAM_NAME]: "acct-dev",
    });

    await runDynamodbCrud(deps);

    const actualFingerprint = capturedFingerprint(writeFileSpy);
    const definitionWithResolvedProfile = {
      mode: "scan",
      tableName: "widgets",
      totalSegments: 1,
      output: "out.jsonl",
      awsProfile: "acct-dev",
    };
    expect(actualFingerprint).toBe(
      Core.canonicalJsonHash(definitionWithResolvedProfile),
    );
    // Proves awsProfile is genuinely incorporated (not coincidentally
    // matching): a definition omitting it entirely, and one carrying a
    // DIFFERENT profile value, must both fingerprint differently from the
    // actual run's fingerprint.
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash({
        mode: "scan",
        tableName: "widgets",
        totalSegments: 1,
        output: "out.jsonl",
      }),
    );
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash({
        ...definitionWithResolvedProfile,
        awsProfile: "acct-prod",
      }),
    );
  });

  test("issue #497 gap 2: a 'scan' run and an 'export' run under the same settings (same runName, same table) produce a checkpoint with the SAME fingerprint — mode consolidates scan/export so switching between them never trips ERR_CHECKPOINT_FINGERPRINT_MISMATCH on --resume", async () => {
    const sharedConfig = {
      ...BASE_CONFIG,
      tableName: "widgets",
      totalSegments: 1,
      checkpointEveryPages: 1,
      runName: "same-run",
      output: "out.jsonl",
      [Core.AWS_PROFILE_PARAM_NAME]: "acct-shared",
    };
    mockOnePageScan();
    const writeFileSpy = stubCheckpointWritesCapturing();

    stubOutputStream();
    await runDynamodbCrud(buildDeps({ ...sharedConfig, operation: "scan" }));
    const scanFingerprint = capturedFingerprint(writeFileSpy);

    writeFileSpy.mockClear();
    stubOutputStream();
    await runDynamodbCrud(buildDeps({ ...sharedConfig, operation: "export" }));
    const exportFingerprint = capturedFingerprint(writeFileSpy);

    expect(scanFingerprint).toBe(exportFingerprint);
    // Pin the actual shared value too, so a future regression that
    // reintroduces raw `operation` into the definition (which would make the
    // two diverge, since "scan" !== "export") is caught even if some other
    // unrelated field change happened to make them coincidentally equal.
    const expectedSharedDefinition = {
      mode: "scan",
      tableName: "widgets",
      totalSegments: 1,
      output: "out.jsonl",
      awsProfile: "acct-shared",
    };
    expect(scanFingerprint).toBe(
      Core.canonicalJsonHash(expectedSharedDefinition),
    );
  });

  test("issue #497 gap 2: a 'scan' run's checkpoint fingerprint is unaffected by a 'key' config value happening to be set — key is gated to query mode and never leaks into a scan/export definition", async () => {
    mockOnePageScan();
    const writeFileSpy = stubCheckpointWritesCapturing();
    stubOutputStream();
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      tableName: "widgets",
      totalSegments: 1,
      checkpointEveryPages: 1,
      output: "out.jsonl",
      // Set, but must be ignored for a scan definition — scan-table.ts only
      // consumes `key` when mode is "query" (guarded there); the config
      // parameter itself has no operation-scoped restriction.
      key: JSON.stringify({ status: "paid" }),
      [Core.AWS_PROFILE_PARAM_NAME]: "acct-shared",
    });

    await runDynamodbCrud(deps);

    const actualFingerprint = capturedFingerprint(writeFileSpy);
    const definitionWithoutKey = {
      mode: "scan",
      tableName: "widgets",
      totalSegments: 1,
      output: "out.jsonl",
      awsProfile: "acct-shared",
    };
    const definitionWithKeyLeaked = {
      ...definitionWithoutKey,
      key: { status: "paid" },
    };
    expect(actualFingerprint).toBe(
      Core.canonicalJsonHash(definitionWithoutKey),
    );
    expect(actualFingerprint).not.toBe(
      Core.canonicalJsonHash(definitionWithKeyLeaked),
    );
  });

  test("[precedence] --resume rejects ERR_CHECKPOINT_FINGERPRINT_MISMATCH when the on-disk fingerprint disagrees with the current settings' projected definition", async () => {
    stubOutputStream();
    mockOneEmptyPageScan();
    const payload = { segments: {}, outputBytes: 0 };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: Core.canonicalJsonHash(payload),
      // Deliberately wrong: a well-formed but definitely-incorrect
      // fingerprint — never the real SHA-256 of the settings-derived
      // definition below. Pre-#497, this run resolves normally regardless of
      // this field (no `definition` is ever supplied to the constructor, so
      // `read()` never checks it) — exactly the difference this test exists
      // to pin (mirrors the "integrity vs. meaning" precedence shape from
      // `docs/logs/2026-08-19-a4-checkpoint-fingerprint.md`: both arms —
      // "fingerprints checked" and "fingerprints mismatch" — must be
      // reachable, which is why `mockOneEmptyPageScan` lets a pre-#497 run
      // complete successfully instead of erroring for an unrelated reason).
      fingerprint: "0".repeat(64),
      payload,
    };
    vi.spyOn(fsp, "readFile").mockResolvedValue(JSON.stringify(envelope));
    vi.spyOn(fsp, "unlink").mockResolvedValue(undefined);
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      tableName: "widgets",
      totalSegments: 1,
      resume: true,
      indexName: "byStatus",
      key: JSON.stringify({ status: "paid" }),
      output: "out.jsonl",
    });

    await expect(runDynamodbCrud(deps)).rejects.toMatchObject({
      code: "ERR_CHECKPOINT_FINGERPRINT_MISMATCH",
    });
  });

  test("--resume succeeds when the on-disk fingerprint matches the current settings' projected definition (fresh and resume construction paths agree on the same definition shape)", async () => {
    stubOutputStream();
    mockOneEmptyPageScan();
    const payload = { segments: {}, outputBytes: 0 };
    // Post-#497 shape: mode (derived, not raw operation), no `key` (scan
    // mode gates it out even though settings.key below is set), and the
    // resolved awsProfile — matching BASE_CONFIG's aws.profile since this
    // test does not override it.
    const expectedDefinition = {
      mode: "scan",
      tableName: "widgets",
      totalSegments: 1,
      indexName: "byStatus",
      output: "out.jsonl",
      awsProfile: "test-profile",
    };
    const envelope = {
      __m3lCheckpointFormat: 1,
      checksum: Core.canonicalJsonHash(payload),
      fingerprint: Core.canonicalJsonHash(expectedDefinition),
      payload,
    };
    vi.spyOn(fsp, "readFile").mockResolvedValue(JSON.stringify(envelope));
    vi.spyOn(fsp, "unlink").mockResolvedValue(undefined);
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "scan",
      tableName: "widgets",
      totalSegments: 1,
      resume: true,
      indexName: "byStatus",
      key: JSON.stringify({ status: "paid" }),
      output: "out.jsonl",
    });

    await expect(runDynamodbCrud(deps)).resolves.toMatchObject({ read: 0 });
  });
});

describe("type contract", () => {
  test("RunDynamodbCrudSummary's four fields are numbers and runDynamodbCrud resolves it", () => {
    expectTypeOf<RunDynamodbCrudSummary["read"]>().toBeNumber();
    expectTypeOf<RunDynamodbCrudSummary["written"]>().toBeNumber();
    expectTypeOf<RunDynamodbCrudSummary["failed"]>().toBeNumber();
    expectTypeOf<RunDynamodbCrudSummary["skipped"]>().toBeNumber();
    expectTypeOf(runDynamodbCrud).returns.toEqualTypeOf<
      Promise<RunDynamodbCrudSummary>
    >();
  });

  test("runDynamodbCrud's deps.dynamoDBDocument/dynamoDB are structurally derived from AWS.getItem/describeTable, never the SDK", () => {
    expectTypeOf<
      Parameters<typeof runDynamodbCrud>[0]["dynamoDBDocument"]
    >().toEqualTypeOf<Parameters<typeof AWS.getItem>[0]>();
    expectTypeOf<
      Parameters<typeof runDynamodbCrud>[0]["dynamoDB"]
    >().toEqualTypeOf<Parameters<typeof AWS.describeTable>[0]>();
  });

  test("runDynamodbCrud's deps.prompt is a Core.M3LPrompt, not a bare confirm callback", () => {
    expectTypeOf<
      Parameters<typeof runDynamodbCrud>[0]["prompt"]
    >().toEqualTypeOf<Core.M3LPrompt>();
  });
});
