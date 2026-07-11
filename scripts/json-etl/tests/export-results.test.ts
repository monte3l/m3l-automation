import type { WriteStream } from "node:fs";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept createWriteStream —
// mirrors packages/m3l-common/tests/exporters.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { exportResults } from "../src/steps/export-results.js";

/**
 * Contract: docs/reference/scripts/json-etl.md, `export-results` row.
 * Dispatches on `format` to the exporter CLASS (json/jsonl -> M3LJSONListExporter;
 * csv -> M3LCSVListExporter; html -> M3LHTMLListExporter) and drives
 * exportStream() -> append()/close(). CSV column order comes from the FIRST
 * appended record's keys; HTML uses the injected `columns` option (not the
 * first record's key order).
 */

/** A minimal fake fs.WriteStream: records every chunk written to it. */
class FakeWriteStream extends EventEmitter {
  chunks: string[] = [];
  #shouldFailWrite: boolean;

  constructor(options: { failWrite?: boolean } = {}) {
    super();
    this.#shouldFailWrite = options.failWrite ?? false;
  }

  write(chunk: string | Buffer, cb?: (error?: Error | null) => void): boolean {
    if (this.#shouldFailWrite) {
      const writeError = new Error("write failed");
      queueMicrotask(() => {
        this.emit("error", writeError);
        cb?.(writeError);
      });
      return false;
    }
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

/** Installs a fake fs.createWriteStream that records writes. */
function stubWriteStream(
  options: { failWrite?: boolean } = {},
): FakeWriteStream {
  const fake = new FakeWriteStream(options);
  vi.spyOn(fs, "createWriteStream").mockReturnValue(
    fake as unknown as WriteStream,
  );
  return fake;
}

async function* recordsOf(
  ...records: readonly Record<string, unknown>[]
): AsyncGenerator<Record<string, unknown>> {
  await Promise.resolve();
  yield* records;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportResults", () => {
  test("format 'json' writes a JSON array via M3LJSONListExporter", async () => {
    const stream = stubWriteStream();

    await exportResults({
      records: recordsOf({ id: "1" }, { id: "2" }),
      format: "json",
      outputPath: "out.json",
      columns: ["id"],
    });

    expect(JSON.parse(stream.content())).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("format 'jsonl' writes newline-delimited JSON via M3LJSONListExporter", async () => {
    const stream = stubWriteStream();

    await exportResults({
      records: recordsOf({ id: "1" }, { id: "2" }),
      format: "jsonl",
      outputPath: "out.jsonl",
      columns: ["id"],
    });

    const lines = stream.content().trim().split("\n");
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
      { id: "1" },
      { id: "2" },
    ]);
  });

  test("format 'csv' derives column order from the first appended record's keys", async () => {
    const stream = stubWriteStream();

    await exportResults({
      records: recordsOf({ b: "2", a: "1" }, { b: "4", a: "3" }),
      format: "csv",
      outputPath: "out.csv",
      columns: ["a", "b"],
    });

    const [header] = stream.content().split("\n");
    expect(header?.trim()).toBe("b,a");
  });

  test("format 'html' renders rows using the injected columns option, not the first record's key order", async () => {
    const stream = stubWriteStream();

    await exportResults({
      records: recordsOf({ b: "2", a: "1" }),
      format: "html",
      outputPath: "out.html",
      columns: ["a", "b"],
    });

    const document = stream.content();
    const cellMatch = /<tr><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/.exec(document);
    expect(cellMatch?.[1]).toBe("1");
    expect(cellMatch?.[2]).toBe("2");
  });

  test("a write failure rejects with the wrapped M3LError", async () => {
    stubWriteStream({ failWrite: true });

    await expect(
      exportResults({
        records: recordsOf({ id: "1" }),
        format: "json",
        outputPath: "out.json",
        columns: ["id"],
      }),
    ).rejects.toMatchObject({ code: "ERR_JSON_LIST_EXPORT" });
  });
});
