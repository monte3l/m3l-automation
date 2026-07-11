import type { FileHandle } from "node:fs/promises";
import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, test, vi } from "vitest";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable) — mirrors
// packages/m3l-common/tests/importers.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";

import { importRecords } from "../src/steps/import-records.js";

/**
 * Contract: docs/reference/scripts/json-etl.md, `import-records` row.
 * `importRecords({ importer, onSkip })` subscribes `import:error` -> onSkip,
 * then yield* importer.importStream(). Malformed JSONL LINES are tolerated
 * (skip + onSkip); a malformed whole-document JSON ARRAY aborts with
 * `ERR_IMPORT_PARSE` (a source-level failure, not a countable skip).
 */

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

/** Fakes the FileHandle M3LJSONFormatDetector opens via node:fs/promises.open. */
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

/** Stubs both fs read paths the JSON importer uses for a string source. */
function stubSource(content: string): void {
  vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(content, "utf8"));
  vi.spyOn(fsp, "open").mockImplementation(() =>
    Promise.resolve(fakeJSONFileHandle(content)),
  );
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("importRecords", () => {
  test("yields every record from a clean JSONL source, in order", async () => {
    stubSource(['{"id":1}', '{"id":2}', '{"id":3}'].join("\n"));
    const importer = new Core.M3LJSONListImporter<unknown>({
      filePath: "records.jsonl",
    });
    const onSkip = vi.fn();

    const items = await drain(importRecords({ importer, onSkip }));

    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(onSkip).not.toHaveBeenCalled();
  });

  test("skips malformed JSONL lines, still yields the surviving good records, and reports each skip via onSkip", async () => {
    const content = [
      '{"id":1}',
      "not-json",
      '{"id":2}',
      '{"id":3',
      '{"id":4}',
    ].join("\n");
    stubSource(content);
    const importer = new Core.M3LJSONListImporter<unknown>({
      filePath: "records.jsonl",
    });
    const onSkip = vi.fn();

    const items = await drain(importRecords({ importer, onSkip }));

    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }]);
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(onSkip).toHaveBeenNthCalledWith(1, expect.any(Core.M3LError), 1);
    expect(onSkip).toHaveBeenNthCalledWith(2, expect.any(Core.M3LError), 3);
  });

  test("aborts (does not report a skip) on a malformed whole-document JSON array", async () => {
    stubSource('[{"id":1},');
    const importer = new Core.M3LJSONListImporter<unknown>({
      filePath: "records.json",
    });
    const onSkip = vi.fn();

    let thrown: unknown;
    try {
      await drain(importRecords({ importer, onSkip }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_IMPORT_PARSE");
    expect(onSkip).not.toHaveBeenCalled();
  });
});
