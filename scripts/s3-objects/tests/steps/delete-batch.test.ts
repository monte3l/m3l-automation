import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import type { WriteStream } from "node:fs";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make both fs seams configurable so vi.spyOn can intercept individual
// functions — mirrors scripts/dynamodb-crud/tests/run-dynamodb-crud.test.ts.
// `Core.M3LJSONListImporter` reads via `node:fs/promises` `readFile`
// (internal/importers/resolveSource.ts); `Core.M3LJSONListExporter` writes
// via `node:fs` `createWriteStream` (M3LWriteStreamLifecycle).
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import type * as M3LCommon from "@m3l-automation/m3l-common";

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return { ...actual, AWS: { ...actual.AWS, deleteObjects: vi.fn() } };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type { RunDeleteBatchResult } from "../../src/steps/delete-batch.js";
import { runDeleteBatch } from "../../src/steps/delete-batch.js";

/**
 * Contract: docs/reference/scripts/s3-objects.md, `delete-batch` row +
 * Behavioral contract's "delete-batch's failed.jsonl" bullet. Reads keys via
 * `Core.M3LJSONListImporter`, chunks into <=1000-key groups (S3's own
 * `DeleteObjects` cap), calls `AWS.deleteObjects` per chunk, aggregates
 * `deleted`/`errors` across every chunk, and writes the aggregated failures
 * ONCE (overwrite, not incremental) as `{ key, message }` records.
 *
 * Design choice (this step's own): `failed.jsonl` is written only when
 * `errors.length > 0` — mirrors dynamodb-crud's `writeFailedRecords`
 * ("if (result.failed.length > 0)"), so a clean batch never touches the
 * failure sink at all.
 */

const deleteObjectsMock = vi.mocked(AWS.deleteObjects);

// Only the mocked AWS.deleteObjects is ever invoked on this client in these
// tests; the client value itself is never dereferenced, so an opaque
// placeholder is safe.
const fakeClient = {} as Parameters<typeof AWS.deleteObjects>[0];

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

/** Stubs the input read path (`M3LJSONListImporter`'s `readFile` primitive) with `content`. */
function stubInputFile(content: string): void {
  vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(content, "utf8"));
}

/** Builds JSONL content of `count` `{"key": "..."}` records. */
function keyRecordsJSONL(count: number, prefix = "k"): string {
  return Array.from({ length: count }, (_, index) =>
    JSON.stringify({ key: `${prefix}${String(index)}` }),
  ).join("\n");
}

function readJSONLLines(output: FakeWriteStream): unknown[] {
  return output
    .content()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (fsp.readFile,
  // fs.createWriteStream below); it does not clear the plain vi.fn()
  // AWS.deleteObjects mock (created inside the top-level vi.mock() factory),
  // so its call history would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(AWS.deleteObjects).mockReset();
});

describe("runDeleteBatch", () => {
  test("a single chunk under 1000 keys calls AWS.deleteObjects once and aggregates the result", async () => {
    stubInputFile(keyRecordsJSONL(3));
    deleteObjectsMock.mockResolvedValue({ deleted: 3, errors: [] });

    const result = await runDeleteBatch({
      client: fakeClient,
      bucket: "reports",
      inputPath: "keys.jsonl",
      failedOutputPath: "failed.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(deleteObjectsMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectsMock).toHaveBeenCalledWith(fakeClient, "reports", [
      "k0",
      "k1",
      "k2",
    ]);
    expect(result).toEqual({ deleted: 3, errors: [] });
  });

  test("a key list over 1000 keys is chunked into groups of at most 1000", async () => {
    stubInputFile(keyRecordsJSONL(2500));
    const chunkSizes: number[] = [];
    deleteObjectsMock.mockImplementation((_client, _bucket, keys) => {
      chunkSizes.push(keys.length);
      return Promise.resolve({ deleted: keys.length, errors: [] });
    });

    const result = await runDeleteBatch({
      client: fakeClient,
      bucket: "reports",
      inputPath: "keys.jsonl",
      failedOutputPath: "failed.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(deleteObjectsMock).toHaveBeenCalledTimes(3);
    expect(chunkSizes).toEqual([1000, 1000, 500]);
    expect(result.deleted).toBe(2500);
    expect(result.errors).toEqual([]);
  });

  test("a chunk returning partial errors aggregates them and writes failed.jsonl once", async () => {
    stubInputFile(keyRecordsJSONL(4));
    deleteObjectsMock.mockResolvedValue({
      deleted: 2,
      errors: [
        { key: "k1", message: "AccessDenied" },
        { key: "k3", message: "InternalError" },
      ],
    });
    const output = new FakeWriteStream();
    const createWriteStreamSpy = vi
      .spyOn(fs, "createWriteStream")
      .mockReturnValue(output as unknown as WriteStream);

    const result = await runDeleteBatch({
      client: fakeClient,
      bucket: "reports",
      inputPath: "keys.jsonl",
      failedOutputPath: "failed.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(result).toEqual({
      deleted: 2,
      errors: [
        { key: "k1", message: "AccessDenied" },
        { key: "k3", message: "InternalError" },
      ],
    });
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);
    expect(createWriteStreamSpy).toHaveBeenCalledWith("failed.jsonl");
    expect(readJSONLLines(output)).toEqual([
      { key: "k1", message: "AccessDenied" },
      { key: "k3", message: "InternalError" },
    ]);
  });

  test("errors spanning multiple chunks are written to failed.jsonl exactly once, not incrementally", async () => {
    stubInputFile(keyRecordsJSONL(1500));
    let callCount = 0;
    deleteObjectsMock.mockImplementation((_client, _bucket, keys) => {
      callCount += 1;
      const failingKey = keys[0];
      return Promise.resolve({
        deleted: keys.length - 1,
        errors:
          failingKey === undefined
            ? []
            : [
                {
                  key: failingKey,
                  message: `chunk ${String(callCount)} error`,
                },
              ],
      });
    });
    const output = new FakeWriteStream();
    const createWriteStreamSpy = vi
      .spyOn(fs, "createWriteStream")
      .mockReturnValue(output as unknown as WriteStream);

    const result = await runDeleteBatch({
      client: fakeClient,
      bucket: "reports",
      inputPath: "keys.jsonl",
      failedOutputPath: "failed.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(deleteObjectsMock).toHaveBeenCalledTimes(2);
    expect(result.errors).toHaveLength(2);
    // Exactly one write-stream open despite two chunks each contributing a
    // failure — the aggregation is collected in memory and flushed once at
    // the end, never appended chunk-by-chunk.
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);
    expect(readJSONLLines(output)).toHaveLength(2);
  });

  test("zero keys short-circuits: no AWS call, deleted: 0, errors: [], no failed.jsonl write", async () => {
    stubInputFile("");
    const createWriteStreamSpy = vi.spyOn(fs, "createWriteStream");

    const result = await runDeleteBatch({
      client: fakeClient,
      bucket: "reports",
      inputPath: "keys.jsonl",
      failedOutputPath: "failed.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(deleteObjectsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, errors: [] });
    expect(createWriteStreamSpy).not.toHaveBeenCalled();
  });
});

describe("type contract", () => {
  test("RunDeleteBatchResult mirrors AWS.deleteObjects's own DeleteObjectsResult shape", () => {
    expectTypeOf<RunDeleteBatchResult["deleted"]>().toBeNumber();
    expectTypeOf(runDeleteBatch).returns.toEqualTypeOf<
      Promise<RunDeleteBatchResult>
    >();
  });

  test("runDeleteBatch's deps.client is structurally derived from AWS.deleteObjects, never the SDK", () => {
    expectTypeOf<
      Parameters<typeof runDeleteBatch>[0]["client"]
    >().toEqualTypeOf<Parameters<typeof AWS.deleteObjects>[0]>();
  });
});
