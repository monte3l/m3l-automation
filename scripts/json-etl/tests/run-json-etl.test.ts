import type { FileHandle } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

// Make both fs seams configurable so vi.spyOn can intercept individual
// functions — mirrors packages/m3l-common/tests/{importers,exporters}.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { Core } from "@m3l-automation/m3l-common";

import { runJsonEtl } from "../src/steps/run-json-etl.js";

/**
 * Contract: docs/reference/scripts/json-etl.md, `run-json-etl` row + the
 * "sort requires limit" / required-parameter run-start guards. Composes
 * import -> extract -> filter -> (sort -> limit) -> export and returns
 * `{ read, written, skipped }`. `paths`/`config`/`logger` are injected real
 * instances (M3LConfig/M3LPaths/M3LLogger are concrete, mockable-by-injection
 * classes) — no M3LScript lifecycle is booted.
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

/** Stubs the input read path and captures every chunk written to the output. */
function stubPipeline(inputContent: string): FakeWriteStream {
  vi.spyOn(fsp, "readFile").mockResolvedValue(
    Buffer.from(inputContent, "utf8"),
  );
  vi.spyOn(fsp, "open").mockImplementation(() =>
    Promise.resolve(fakeJSONFileHandle(inputContent)),
  );
  const output = new FakeWriteStream();
  vi.spyOn(fs, "createWriteStream").mockReturnValue(
    output as unknown as WriteStream,
  );
  return output;
}

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

function writtenRecords(output: FakeWriteStream): unknown[] {
  return output
    .content()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}

const REQUIRED_BASE: Record<string, unknown> = {
  input: "in.jsonl",
  fields: ["id=id"],
  filters: [],
  format: "jsonl",
  output: "out.jsonl",
  multiValue: "join",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runJsonEtl", () => {
  test("throws before reading any record when sort is set without limit", async () => {
    stubPipeline("");
    const config = buildConfig({ ...REQUIRED_BASE, sort: "id:asc" });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      runJsonEtl({ config, paths, logger, correlationId: "run-1" }),
    ).rejects.toBeInstanceOf(Core.M3LError);
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("throws before reading any record when 'input' is missing", async () => {
    stubPipeline("");
    const config = buildConfig({
      fields: ["id=id"],
      filters: [],
      format: "jsonl",
      output: "out.jsonl",
      multiValue: "join",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      runJsonEtl({ config, paths, logger, correlationId: "run-2a" }),
    ).rejects.toBeInstanceOf(Core.M3LError);
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("throws before reading any record when 'fields' is missing", async () => {
    stubPipeline("");
    const config = buildConfig({
      input: "in.jsonl",
      filters: [],
      format: "jsonl",
      output: "out.jsonl",
      multiValue: "join",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      runJsonEtl({ config, paths, logger, correlationId: "run-2b" }),
    ).rejects.toBeInstanceOf(Core.M3LError);
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("throws before reading any record when 'output' is missing", async () => {
    stubPipeline("");
    const config = buildConfig({
      input: "in.jsonl",
      fields: ["id=id"],
      filters: [],
      format: "jsonl",
      multiValue: "join",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    await expect(
      runJsonEtl({ config, paths, logger, correlationId: "run-2c" }),
    ).rejects.toBeInstanceOf(Core.M3LError);
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  test("runs the full pipeline and reports read/written/skipped counts", async () => {
    const content = ['{"id":1}', "not-json", '{"id":2}', '{"id":3}'].join("\n");
    const output = stubPipeline(content);
    const config = buildConfig({ ...REQUIRED_BASE });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const summary = await runJsonEtl({
      config,
      paths,
      logger,
      correlationId: "run-3",
    });

    expect(summary).toEqual({ read: 3, written: 3, skipped: 1 });
    expect(writtenRecords(output)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test("sort buffers up to limit and slices the sorted result", async () => {
    const content = ['{"id":1}', '{"id":2}', '{"id":3}', '{"id":4}'].join("\n");
    const output = stubPipeline(content);
    const config = buildConfig({
      ...REQUIRED_BASE,
      sort: "id:desc",
      limit: 2,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const summary = await runJsonEtl({
      config,
      paths,
      logger,
      correlationId: "run-4",
    });

    expect(summary).toEqual({ read: 4, written: 2, skipped: 0 });
    expect(writtenRecords(output)).toEqual([{ id: 4 }, { id: 3 }]);
  });

  test("a bare limit (no sort) truncates the exported stream to the first records, in document order", async () => {
    const content = ['{"id":1}', '{"id":2}', '{"id":3}', '{"id":4}'].join("\n");
    const output = stubPipeline(content);
    const config = buildConfig({ ...REQUIRED_BASE, limit: 2 });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    const summary = await runJsonEtl({
      config,
      paths,
      logger,
      correlationId: "run-5",
    });

    expect(summary.written).toBe(2);
    expect(writtenRecords(output)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("throws before reading any record when 'input' escapes the input base directory", async () => {
    stubPipeline("");
    const config = buildConfig({
      ...REQUIRED_BASE,
      input: "../../../etc/passwd",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await runJsonEtl({ config, paths, logger, correlationId: "run-6a" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_JSON_ETL_PATH");
    expect(fsp.readFile).not.toHaveBeenCalled();
    expect(fsp.open).not.toHaveBeenCalled();
  });

  test("throws before reading any record when 'output' escapes the output base directory", async () => {
    stubPipeline("");
    const config = buildConfig({
      ...REQUIRED_BASE,
      output: "../../x",
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await runJsonEtl({ config, paths, logger, correlationId: "run-6b" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_JSON_ETL_PATH");
    expect(fsp.readFile).not.toHaveBeenCalled();
    expect(fsp.open).not.toHaveBeenCalled();
  });

  test("throws before reading any record when 'sort' names a field outside 'fields' output columns", async () => {
    stubPipeline("");
    const config = buildConfig({
      ...REQUIRED_BASE,
      sort: "unknownfield:asc",
      limit: 2,
    });
    const paths = new Core.M3LPaths();
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await runJsonEtl({ config, paths, logger, correlationId: "run-7" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_JSON_ETL_CONFIG");
    expect(fsp.readFile).not.toHaveBeenCalled();
  });
});
