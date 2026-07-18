import * as fs from "node:fs";
import type { WriteStream } from "node:fs";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type * as M3LCommon from "@m3l-automation/m3l-common";

// Make 'node:fs' configurable so vi.spyOn can intercept createWriteStream —
// mirrors scripts/dynamodb-crud/tests/run-dynamodb-crud.test.ts. This is the
// real write primitive Core.M3LJSONListExporter uses internally
// (M3LWriteStreamLifecycle -> fs.createWriteStream), never fs/promises.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return { ...actual, AWS: { ...actual.AWS, listObjects: vi.fn() } };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type { RunListObjectsSummary } from "../../src/steps/list-objects.js";
import { runListObjects } from "../../src/steps/list-objects.js";

/**
 * Contract: docs/reference/scripts/s3-objects.md, `list-objects` row +
 * Behavioral contract's "Run summary" bullet. `list`: paginated
 * `AWS.listObjects`, streaming every `S3ObjectSummary` from every page to
 * `output` as JSONL; `processed` counts total object summaries listed across
 * every page.
 *
 * Design choice (this step's own, since the contract doesn't pick a sink):
 * streams via `Core.M3LJSONListExporter` (format "jsonl") rather than
 * hand-rolled fs writes, matching the fleet's existing scan/query streaming
 * pattern in dynamodb-crud. An `AWS.listObjects` rejection propagates
 * unmodified (it is already a typed `AWS.M3LS3OperationError`; this step
 * neither catches nor re-wraps it).
 */

const listObjectsMock = vi.mocked(AWS.listObjects);

// Only the mocked AWS.listObjects is ever invoked on this client in these
// tests; the client value itself is never dereferenced, so an opaque
// placeholder is safe.
const fakeClient = {} as Parameters<typeof AWS.listObjects>[0];

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

function readJSONLLines(output: FakeWriteStream): unknown[] {
  return output
    .content()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (fs.createWriteStream
  // below); it does not clear the plain vi.fn() AWS.listObjects mock
  // (created inside the top-level vi.mock() factory), so its call history
  // and mockImplementation would otherwise leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(AWS.listObjects).mockReset();
});

describe("runListObjects", () => {
  test("flattens multiple pages into JSONL and counts every object as processed", async () => {
    const output = stubOutputStream();
    listObjectsMock.mockImplementation(async function* fakeListObjects() {
      await Promise.resolve();
      yield {
        objects: [
          { key: "a", size: 1, lastModified: undefined, eTag: undefined },
          { key: "b", size: 2, lastModified: undefined, eTag: undefined },
        ],
        nextContinuationToken: "token-1",
      };
      yield {
        objects: [
          { key: "c", size: 3, lastModified: undefined, eTag: undefined },
        ],
        nextContinuationToken: undefined,
      };
    });

    const summary = await runListObjects({
      client: fakeClient,
      bucket: "reports",
      outputPath: "listing.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(summary).toEqual({ processed: 3 });
    expect(readJSONLLines(output)).toEqual([
      { key: "a", size: 1, lastModified: undefined, eTag: undefined },
      { key: "b", size: 2, lastModified: undefined, eTag: undefined },
      { key: "c", size: 3, lastModified: undefined, eTag: undefined },
    ]);
    expect(listObjectsMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      { prefix: undefined, pageSize: undefined },
      undefined,
    );
  });

  test("passes prefix/pageSize through to AWS.listObjects", async () => {
    stubOutputStream();
    listObjectsMock.mockImplementation(async function* fakeListObjects() {
      await Promise.resolve();
      yield { objects: [], nextContinuationToken: undefined };
    });

    await runListObjects({
      client: fakeClient,
      bucket: "reports",
      prefix: "2026/",
      pageSize: 50,
      outputPath: "listing.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(listObjectsMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      { prefix: "2026/", pageSize: 50 },
      undefined,
    );
  });

  test("an empty listing (a single empty page) yields processed: 0 and writes no lines", async () => {
    const output = stubOutputStream();
    listObjectsMock.mockImplementation(async function* fakeListObjects() {
      await Promise.resolve();
      yield { objects: [], nextContinuationToken: undefined };
    });

    const summary = await runListObjects({
      client: fakeClient,
      bucket: "empty-bucket",
      outputPath: "listing.jsonl",
      logger: new Core.M3LLogger([]),
    });

    expect(summary).toEqual({ processed: 0 });
    expect(readJSONLLines(output)).toEqual([]);
  });

  test("an AWS.listObjects rejection propagates unmodified, not caught/rewrapped", async () => {
    stubOutputStream();
    const operationError = new AWS.M3LS3OperationError("listObjects failed", {
      cause: new Error("network blip"),
    });
    listObjectsMock.mockImplementation(
      // eslint-disable-next-line require-yield -- intentionally throws before any page, simulating a mid-run AWS failure with no successful pages
      async function* fakeListObjects() {
        await Promise.resolve();
        throw operationError;
      },
    );

    let thrown: unknown;
    try {
      await runListObjects({
        client: fakeClient,
        bucket: "reports",
        outputPath: "listing.jsonl",
        logger: new Core.M3LLogger([]),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(operationError);
  });
});

describe("type contract", () => {
  test("RunListObjectsSummary.processed is a number and runListObjects resolves it", () => {
    expectTypeOf<RunListObjectsSummary["processed"]>().toBeNumber();
    expectTypeOf(runListObjects).returns.toEqualTypeOf<
      Promise<RunListObjectsSummary>
    >();
  });

  test("runListObjects' deps.client is structurally derived from AWS.listObjects, never the SDK", () => {
    expectTypeOf<
      Parameters<typeof runListObjects>[0]["client"]
    >().toEqualTypeOf<Parameters<typeof AWS.listObjects>[0]>();
  });
});
