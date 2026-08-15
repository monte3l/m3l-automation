import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import type * as M3LCommonModule from "@m3l-automation/m3l-common";

// Mock AWS.scanSegment/queryItems (async generators) and Core.M3LCheckpointStore
// (a fresh, independently-mocked instance per `new`), keeping every other
// Core/AWS export real (Core.M3LLogger, Core.M3LError, and
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
    Core: {
      ...actual.Core,
      // A plain `function` (not an arrow) — `new Core.M3LCheckpointStore(...)`
      // below requires a constructible mock implementation; an arrow function
      // is never constructible and throws "is not a constructor" at runtime.
      M3LCheckpointStore: vi.fn().mockImplementation(function FakeStore() {
        return {
          read: vi.fn(),
          write: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          path: "run.checkpoint.json",
        };
      }),
    },
  };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type {
  ScanCheckpoint,
  ScanTableOptions,
} from "../src/steps/scan-table.js";
import { isScanCheckpoint, scanTable } from "../src/steps/scan-table.js";

/**
 * Contract: docs/reference/scripts/dynamodb-crud.md, `scan-table` row, plus
 * docs/reference/core/checkpoint.md for the injected `Core.M3LCheckpointStore`
 * collaborator. `Core.M3LCheckpointStore` is mocked as a constructor that
 * returns a fresh fake `{read,write,delete,path}` instance on every `new` —
 * checkpoint I/O is entirely the library's concern (already tested there);
 * `scan-table.ts` only calls through the store's methods.
 */

type DynamoDBDocumentClient = Parameters<typeof AWS.scanSegment>[0];
// Never exercised for real (scanSegment/queryItems are fully mocked below),
// so an opaque stand-in cast through `unknown` is sufficient and safe.
const fakeClient = {} as unknown as DynamoDBDocumentClient;

const logger = new Core.M3LLogger([]);

function alwaysScanCheckpoint(_value: unknown): _value is ScanCheckpoint {
  return true;
}

function buildCheckpointStore(): Core.M3LCheckpointStore<ScanCheckpoint> {
  return new Core.M3LCheckpointStore<ScanCheckpoint>({
    paths: new Core.M3LPaths(),
    name: "run",
    validate: alwaysScanCheckpoint,
    missing: { kind: "empty", value: { segments: {}, outputBytes: 0 } },
  });
}

let checkpointStore: Core.M3LCheckpointStore<ScanCheckpoint>;

beforeEach(() => {
  checkpointStore = buildCheckpointStore();
});

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
    checkpointStore,
    logger,
    // Resume-seam threading (dynamodb-crud data-loss fix): `dispatchScan`
    // owns the actual `M3LListExporterStreamWriter`'s `bytesWritten`;
    // `scan-table.ts` only learns the current value through this callback so
    // its checkpoint writes can carry `outputBytes` alongside `segments`. `0`
    // is a safe default for every test that does not care about the exact
    // value threaded through.
    getOutputBytes: () => 0,
    ...overrides,
  };
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies; it does not clear plain
  // vi.fn() mocks (AWS.scanSegment/queryItems, created inside the top-level
  // vi.mock() factory), so their call history and mockImplementation would
  // otherwise leak into the next test.
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
  test("writes the checkpoint every checkpointEveryPages pages, keyed by segment index, carrying outputBytes from getOutputBytes", async () => {
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: 1 }], lastEvaluatedKey: { id: 1 } };
      yield { items: [{ id: 2 }], lastEvaluatedKey: undefined };
    });

    await drain(
      scanTable(
        baseOptions({ checkpointEveryPages: 1, getOutputBytes: () => 42 }),
      ),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.write).toHaveBeenCalledWith({
      segments: { "0": { id: 1 } },
      outputBytes: 42,
    });
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
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.write).not.toHaveBeenCalled();

    const second = await iterator.next();
    expect(second.value).toEqual({ id: 2 });
    // The last item of the page has just been handed to the consumer, but
    // `driveSegment` has not yet resumed past `yield* page.items` to advance
    // the checkpoint — a crash right here must not have already persisted a
    // cursor past items the consumer hasn't necessarily finished writing.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.write).not.toHaveBeenCalled();

    // Pulling once more resumes `driveSegment` past `yield*`, which is where
    // the checkpoint now advances — proving it only does so once every item
    // in the page has actually been yielded out.
    await iterator.next();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.write).toHaveBeenCalled();
  });

  test("deletes the checkpoint after the generator fully drains", async () => {
    vi.mocked(AWS.scanSegment).mockImplementation(async function* () {
      await Promise.resolve();
      yield { items: [{ id: 1 }], lastEvaluatedKey: undefined };
    });

    const items = await drain(
      scanTable(baseOptions({ checkpointEveryPages: 100 })),
    );

    expect(items).toEqual([{ id: 1 }]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.delete).toHaveBeenCalledTimes(1);
  });

  test("propagates a checkpoint write failure unmodified (no local re-wrapping)", async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    vi.mocked(checkpointStore.write).mockRejectedValue(
      new Core.M3LCheckpointError("boom", { code: "ERR_CHECKPOINT_IO" }),
    );
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

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe("ERR_CHECKPOINT_IO");
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

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.write).toHaveBeenLastCalledWith({
      segments: { "0": null, "1": null },
      outputBytes: 0,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.delete).toHaveBeenCalledTimes(1);
  });
});

describe("scanTable — resume", () => {
  test("resumes a segment from its saved checkpoint cursor", async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    vi.mocked(checkpointStore.read).mockResolvedValue({
      segments: { "0": { cursorId: "abc" } },
      outputBytes: 128,
    });
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
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    vi.mocked(checkpointStore.read).mockResolvedValue({
      segments: { "0": null },
      outputBytes: 256,
    });

    const items = await drain(
      scanTable(baseOptions({ resume: true, totalSegments: 1 })),
    );

    expect(items).toEqual([]);
    expect(AWS.scanSegment).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    expect(checkpointStore.delete).toHaveBeenCalledTimes(1);
  });

  test("resume: true propagates the checkpoint store's ERR_CHECKPOINT_MISSING rejection before any AWS call", async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mocked store property is a vi.fn(), never called unbound
    vi.mocked(checkpointStore.read).mockRejectedValue(
      new Core.M3LCheckpointError("checkpoint missing", {
        code: "ERR_CHECKPOINT_MISSING",
      }),
    );

    let thrown: unknown;
    try {
      await drain(scanTable(baseOptions({ resume: true, checkpointStore })));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LCheckpointError);
    expect((thrown as Core.M3LCheckpointError).code).toBe(
      "ERR_CHECKPOINT_MISSING",
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
      Readonly<Record<string, Record<string, unknown> | null>>
    >();
  });

  test("ScanCheckpoint.segments is readonly — a caller cannot mutate the returned checkpoint's segments map", () => {
    // toEqualTypeOf is strict about the readonly modifier: a mutable
    // Record<...> is NOT equal to Readonly<Record<...>>, so this assertion
    // only passes once ScanCheckpoint.segments is genuinely readonly (a
    // caller holding a ScanCheckpoint can read but not assign into
    // `.segments[key]` — that would be a compile error, TS2542).
    expectTypeOf<ScanCheckpoint["segments"]>().not.toEqualTypeOf<
      Record<string, Record<string, unknown> | null>
    >();
  });

  test("ScanCheckpoint gains a required outputBytes: number field (resume seam)", () => {
    expectTypeOf<ScanCheckpoint["outputBytes"]>().toBeNumber();
  });

  test("ScanTableOptions requires getOutputBytes: () => number (resume seam)", () => {
    expectTypeOf<ScanTableOptions["getOutputBytes"]>().toEqualTypeOf<
      () => number
    >();
  });
});

describe("isScanCheckpoint", () => {
  test.each<[string, unknown]>([
    ["a non-object", "not-an-object"],
    ["an object with a non-object segments", { segments: "nope" }],
    ["an object whose segments is an array", { segments: [] }],
    [
      "an object whose segments has an array-valued entry",
      { segments: { "0": [] } },
    ],
    ["an object missing outputBytes entirely", { segments: { "0": null } }],
    [
      "an object whose outputBytes is negative",
      { segments: { "0": null }, outputBytes: -1 },
    ],
    [
      "an object whose outputBytes is a non-number (string)",
      { segments: { "0": null }, outputBytes: "5" },
    ],
    [
      "an object whose outputBytes is NaN",
      { segments: { "0": null }, outputBytes: Number.NaN },
    ],
    [
      "an object whose outputBytes is Infinity",
      { segments: { "0": null }, outputBytes: Number.POSITIVE_INFINITY },
    ],
    [
      "an object whose outputBytes is a non-integer (3.5)",
      { segments: { "0": null }, outputBytes: 3.5 },
    ],
  ])("rejects %s", (_description, candidate) => {
    expect(isScanCheckpoint(candidate)).toBe(false);
  });

  test("accepts a well-formed checkpoint with outputBytes: 0", () => {
    expect(
      isScanCheckpoint({
        segments: { "0": null, "1": { key: "x" } },
        outputBytes: 0,
      }),
    ).toBe(true);
  });

  test("accepts a well-formed checkpoint with a positive outputBytes", () => {
    expect(
      isScanCheckpoint({
        segments: { "0": null, "1": { key: "x" } },
        outputBytes: 4096,
      }),
    ).toBe(true);
  });
});
