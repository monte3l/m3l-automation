import * as fsp from "node:fs/promises";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable) — mirrors
// scripts/json-etl/tests/import-records.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import type * as M3LCommonModule from "@m3l-automation/m3l-common";

// Mock only AWS.scanSegment/queryItems (async generators), keeping every
// other Core/AWS export real (Core.M3LLogger, Core.M3LError, and
// AWS.M3LDynamoDBOperationError are used verbatim below).
vi.mock("@m3l-automation/m3l-common", async () => {
  const actual = await vi.importActual<typeof M3LCommonModule>(
    "@m3l-automation/m3l-common",
  );
  return {
    ...actual,
    AWS: {
      ...actual.AWS,
      scanSegment: vi.fn(),
      queryItems: vi.fn(),
    },
  };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type {
  ScanCheckpoint,
  ScanTableOptions,
} from "../src/steps/scan-table.js";
import { scanTable } from "../src/steps/scan-table.js";

/**
 * Contract: docs/reference/scripts/dynamodb-crud.md, `scan-table` row, plus the
 * verbatim `ScanCheckpoint`/`ScanTableOptions`/`scanTable` shapes handed down
 * for this RED phase.
 *
 * Design choice (documented per the task instructions, since the contract
 * says "fs.rm or unlink" without picking one): these tests mock `fs.rm` as
 * the checkpoint-delete primitive. If the implementer chooses `unlink`
 * instead, the relevant tests need a matching update — flagged to the hub.
 */

type DynamoDBDocumentClient = Parameters<typeof AWS.scanSegment>[0];
// Never exercised for real (scanSegment/queryItems are fully mocked below),
// so an opaque stand-in cast through `unknown` is sufficient and safe.
const fakeClient = {} as unknown as DynamoDBDocumentClient;

const logger = new Core.M3LLogger([]);

function baseOptions(
  overrides: Partial<ScanTableOptions> = {},
): ScanTableOptions {
  return {
    dynamoDBDocument: fakeClient,
    mode: "scan",
    tableName: "orders",
    totalSegments: 1,
    pageSize: 50,
    indexName: undefined,
    keyCondition: undefined,
    checkpointEveryPages: 100,
    resume: false,
    checkpointPath: "run.checkpoint.json",
    logger,
    ...overrides,
  };
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function enoentError(): NodeJS.ErrnoException {
  return Object.assign(new Error("no such file or directory"), {
    code: "ENOENT",
  });
}

beforeEach(() => {
  vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
  vi.spyOn(fsp, "rm").mockResolvedValue(undefined);
});

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (fsp.writeFile/rm below); it
  // does not clear plain vi.fn() mocks (AWS.scanSegment/queryItems, created
  // inside the top-level vi.mock() factory), so their call history and
  // mockImplementation would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(AWS.scanSegment).mockReset();
  vi.mocked(AWS.queryItems).mockReset();
});

describe("scanTable — scan mode", () => {
  test("yields every item across every page for a single-segment scan", async () => {
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: 1 }, { id: 2 }], lastEvaluatedKey: { id: 2 } };
      yield { items: [{ id: 3 }], lastEvaluatedKey: undefined };
    });

    const items = await drain(scanTable(baseOptions()));

    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test("passes parallel: undefined to scanSegment for an unsegmented single-segment scan", async () => {
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [], lastEvaluatedKey: undefined };
    });

    await drain(scanTable(baseOptions({ totalSegments: 1, pageSize: 25 })));

    expect(AWS.scanSegment).toHaveBeenCalledWith(
      fakeClient,
      { tableName: "orders", parallel: undefined, pageSize: 25 },
      undefined,
    );
  });

  test("propagates an AWS.scanSegment failure unmodified through the async generator", async () => {
    const awsError = new AWS.M3LDynamoDBOperationError("scanSegment failed", {
      cause: new Error("boom"),
    });
    vi.mocked(AWS.scanSegment).mockImplementation(
      // eslint-disable-next-line require-yield -- intentionally throws before any page, simulating a mid-run AWS failure with no successful pages
      async function* () {
        await Promise.resolve();
        throw awsError;
      },
    );

    let thrown: unknown;
    try {
      await drain(scanTable(baseOptions()));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(awsError);
  });
});

describe("scanTable — query mode", () => {
  test("drives AWS.queryItems with keyCondition and indexName", async () => {
    vi.mocked(AWS.queryItems).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: "q1" }], lastEvaluatedKey: undefined };
    });

    const items = await drain(
      scanTable(
        baseOptions({
          mode: "query",
          keyCondition: { userId: "42" },
          indexName: "byUser",
        }),
      ),
    );

    expect(items).toEqual([{ id: "q1" }]);
    expect(AWS.queryItems).toHaveBeenCalledWith(
      fakeClient,
      {
        tableName: "orders",
        keyCondition: { userId: "42" },
        indexName: "byUser",
        pageSize: 50,
      },
      undefined,
    );
    expect(AWS.scanSegment).not.toHaveBeenCalled();
  });

  test("throws a typed config error before any AWS call when keyCondition is missing", async () => {
    let thrown: unknown;
    try {
      await drain(
        scanTable(
          baseOptions({
            mode: "query",
            keyCondition: undefined,
            indexName: "byUser",
          }),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect(AWS.queryItems).not.toHaveBeenCalled();
    expect(AWS.scanSegment).not.toHaveBeenCalled();
  });
});

describe("scanTable — checkpointing", () => {
  test("writes the checkpoint file every checkpointEveryPages pages, keyed by segment index", async () => {
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: 1 }], lastEvaluatedKey: { id: 1 } };
      yield { items: [{ id: 2 }], lastEvaluatedKey: undefined };
    });

    await drain(scanTable(baseOptions({ checkpointEveryPages: 1 })));

    expect(fsp.writeFile).toHaveBeenCalled();
    const firstCall = vi.mocked(fsp.writeFile).mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) throw new Error("unreachable");
    const [path, payload] = firstCall;
    expect(path).toBe("run.checkpoint.json");
    if (typeof payload !== "string")
      throw new Error("expected a string payload");
    const parsed = JSON.parse(payload) as ScanCheckpoint;
    expect(parsed.segments).toEqual({ "0": { id: 1 } });
  });

  test("does not advance the checkpoint until every item in the page has been yielded to the consumer", async () => {
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: 1 }, { id: 2 }], lastEvaluatedKey: { id: 2 } };
    });

    const iterator = scanTable(baseOptions({ checkpointEveryPages: 1 }))[
      Symbol.asyncIterator
    ]();

    const first = await iterator.next();
    expect(first.value).toEqual({ id: 1 });
    expect(fsp.writeFile).not.toHaveBeenCalled();

    const second = await iterator.next();
    expect(second.value).toEqual({ id: 2 });
    // The last item of the page has just been handed to the consumer, but
    // `driveSegment` has not yet resumed past `yield* page.items` to advance
    // the checkpoint — a crash right here must not have already persisted a
    // cursor past items the consumer hasn't necessarily finished writing.
    expect(fsp.writeFile).not.toHaveBeenCalled();

    // Pulling once more resumes `driveSegment` past `yield*`, which is where
    // the checkpoint now advances — proving it only does so once every item
    // in the page has actually been yielded out.
    await iterator.next();
    expect(fsp.writeFile).toHaveBeenCalled();
  });

  test("deletes the checkpoint file after the generator fully drains, ignoring an ENOENT on delete", async () => {
    vi.mocked(fsp.rm).mockRejectedValueOnce(enoentError());
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: 1 }], lastEvaluatedKey: undefined };
    });

    const items = await drain(
      scanTable(baseOptions({ checkpointEveryPages: 100 })),
    );

    expect(items).toEqual([{ id: 1 }]);
    expect(fsp.rm).toHaveBeenCalledWith("run.checkpoint.json");
  });

  test("wraps a non-ENOENT checkpoint write failure in a typed checkpoint error, chaining the cause", async () => {
    const writeError = new Error("EACCES: permission denied");
    vi.mocked(fsp.writeFile).mockRejectedValue(writeError);
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: 1 }], lastEvaluatedKey: { id: 1 } };
      yield { items: [{ id: 2 }], lastEvaluatedKey: undefined };
    });

    let thrown: unknown;
    try {
      await drain(scanTable(baseOptions({ checkpointEveryPages: 1 })));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CHECKPOINT");
    expect((thrown as Core.M3LError).cause).toBe(writeError);
  });

  test("totalSegments: 2 aggregates item counts and marks both segments done in the final checkpoint (interleaving itself is not asserted)", async () => {
    vi.mocked(AWS.scanSegment).mockImplementation(
      async function* (_client, options) {
        await Promise.resolve();
        if (options.parallel?.segment === 0) {
          yield {
            items: [{ id: "a1" }, { id: "a2" }],
            lastEvaluatedKey: undefined,
          };
        } else {
          yield {
            items: [{ id: "b1" }, { id: "b2" }],
            lastEvaluatedKey: undefined,
          };
        }
      },
    );

    const items = await drain(
      scanTable(baseOptions({ totalSegments: 2, checkpointEveryPages: 1 })),
    );

    expect(items).toHaveLength(4);
    expect(new Set(items.map((item) => item["id"]))).toEqual(
      new Set(["a1", "a2", "b1", "b2"]),
    );

    const lastCall = vi.mocked(fsp.writeFile).mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    if (lastCall === undefined) throw new Error("unreachable");
    const [, lastPayload] = lastCall;
    if (typeof lastPayload !== "string")
      throw new Error("expected a string payload");
    const parsed = JSON.parse(lastPayload) as ScanCheckpoint;
    expect(parsed.segments).toEqual({ "0": null, "1": null });
    expect(fsp.rm).toHaveBeenCalledWith("run.checkpoint.json");
  });
});

describe("scanTable — resume", () => {
  test("resumes a segment from its saved checkpoint cursor", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      JSON.stringify({ segments: { "0": { cursorId: "abc" } } }),
    );
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: "resumed" }], lastEvaluatedKey: undefined };
    });

    const items = await drain(scanTable(baseOptions({ resume: true })));

    expect(items).toEqual([{ id: "resumed" }]);
    expect(AWS.scanSegment).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ tableName: "orders" }),
      { cursorId: "abc" },
    );
  });

  test("skips a segment already recorded as done (null) — no further AWS call for it", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(
      JSON.stringify({ segments: { "0": null } }),
    );

    const items = await drain(
      scanTable(baseOptions({ resume: true, totalSegments: 1 })),
    );

    expect(items).toEqual([]);
    expect(AWS.scanSegment).not.toHaveBeenCalled();
    expect(fsp.rm).toHaveBeenCalledWith("run.checkpoint.json");
  });

  test("resume: true with a missing checkpoint file throws a typed config error naming the path, before any AWS call", async () => {
    vi.spyOn(fsp, "readFile").mockRejectedValue(enoentError());

    let thrown: unknown;
    try {
      await drain(
        scanTable(
          baseOptions({
            resume: true,
            checkpointPath: "missing.checkpoint.json",
          }),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_DYNAMO_CRUD_CONFIG");
    expect((thrown as Core.M3LError).message).toContain(
      "missing.checkpoint.json",
    );
    expect(AWS.scanSegment).not.toHaveBeenCalled();
  });
});

describe("scanTable — type contract", () => {
  test("returns an AsyncGenerator of plain records", () => {
    expectTypeOf(scanTable).returns.toEqualTypeOf<
      AsyncGenerator<Record<string, unknown>>
    >();
  });

  test("ScanCheckpoint.segments accepts null per-segment values", () => {
    expectTypeOf<ScanCheckpoint["segments"]>().toEqualTypeOf<
      Record<string, Record<string, unknown> | null>
    >();
  });
});
