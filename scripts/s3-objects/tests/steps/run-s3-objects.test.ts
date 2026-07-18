import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import type { WriteStream } from "node:fs";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make both fs seams configurable so vi.spyOn can intercept individual
// functions — mirrors scripts/dynamodb-crud/tests/run-dynamodb-crud.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import type * as M3LCommon from "@m3l-automation/m3l-common";

// Only the true I/O boundary is mocked — the `AWS.*` S3 functions and
// `node:fs`/`node:fs/promises` — the four sibling step modules
// (list-objects/single-object-ops/delete-batch/destructive-gate) run for
// real, proving the orchestrator's dispatch wiring end to end (mirrors
// scripts/dynamodb-crud/tests/run-dynamodb-crud.test.ts).
vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    AWS: {
      ...actual.AWS,
      listObjects: vi.fn(),
      headObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(),
      copyObject: vi.fn(),
      deleteObject: vi.fn(),
      deleteObjects: vi.fn(),
    },
  };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type { RunS3ObjectsSummary } from "../../src/steps/run-s3-objects.js";
import { runS3Objects } from "../../src/steps/run-s3-objects.js";

/**
 * Contract: docs/reference/scripts/s3-objects.md, `run-s3-objects` row +
 * the full "Behavioral contract" section (run summary, destructive-gate
 * decline soft-landing, error codes). Composes the pipeline: resolve +
 * guard-check config -> (destructive gate if applicable) -> the
 * operation-appropriate step -> the run summary `{ processed, failed }`.
 */

const listObjectsMock = vi.mocked(AWS.listObjects);
const headObjectMock = vi.mocked(AWS.headObject);
const getObjectMock = vi.mocked(AWS.getObject);
const putObjectMock = vi.mocked(AWS.putObject);
const copyObjectMock = vi.mocked(AWS.copyObject);
const deleteObjectMock = vi.mocked(AWS.deleteObject);
const deleteObjectsMock = vi.mocked(AWS.deleteObjects);

// Only the mocked AWS functions are ever invoked on this client in these
// tests; the client value itself is never dereferenced, so an opaque
// placeholder is safe.
const fakeClient = {} as Parameters<typeof AWS.listObjects>[0];

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

function buildDeps(
  configValues: Record<string, unknown>,
  overrides?: { readonly prompt?: Core.M3LPrompt },
): Parameters<typeof runS3Objects>[0] {
  return {
    config: buildConfig(configValues),
    paths: new Core.M3LPaths(),
    logger: new Core.M3LLogger([]),
    correlationId: "run-1",
    s3: fakeClient,
    prompt: overrides?.prompt ?? new Core.M3LPrompt(),
  };
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

/** Stubs the plain single-file write path (`describe`/`get` output). */
function stubWriteFile(): void {
  vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
}

/** Stubs the plain single-file read path (`put`'s input body). */
function stubReadFile(content: string): void {
  vi.spyOn(fsp, "readFile").mockResolvedValue(Buffer.from(content, "utf8"));
}

/** Builds JSONL content of `count` `{"key": "..."}` records (`delete-batch`'s input). */
function keyRecordsJSONL(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    JSON.stringify({ key: `k${String(index)}` }),
  ).join("\n");
}

function confirmingPrompt(confirmed: boolean): Core.M3LPrompt {
  const prompt = new Core.M3LPrompt();
  vi.spyOn(prompt, "confirm").mockResolvedValue(confirmed);
  return prompt;
}

const BASE_CONFIG: Record<string, unknown> = {
  bucket: "reports",
  yes: false,
};

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (fs/fsp + prompt.confirm
  // below); it does not clear the plain vi.fn() AWS.* mocks (created inside
  // the top-level vi.mock() factory), so their call history would otherwise
  // leak into the next test.
  vi.restoreAllMocks();
  vi.mocked(AWS.listObjects).mockReset();
  vi.mocked(AWS.headObject).mockReset();
  vi.mocked(AWS.getObject).mockReset();
  vi.mocked(AWS.putObject).mockReset();
  vi.mocked(AWS.copyObject).mockReset();
  vi.mocked(AWS.deleteObject).mockReset();
  vi.mocked(AWS.deleteObjects).mockReset();
});

describe("runS3Objects — config guards (fire before any AWS call)", () => {
  test("throws ERR_S3_OBJECTS_CONFIG when 'list' is missing 'output'", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "list" });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(listObjectsMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'describe' is missing 'key'", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "describe",
      output: "out.json",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'describe' is missing 'output' (key present)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "describe",
      key: "2026/07/summary.json",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'get' is missing 'key'", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "get",
      output: "out.bin",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'get' is missing 'output' (key present)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "get",
      key: "2026/07/summary.json",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'put' is missing 'key'", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "put",
      input: "in.bin",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'put' is missing 'input' (key present)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "put",
      key: "2026/07/summary.json",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'copy' is missing 'key' (destination)", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "copy",
      sourceBucket: "archive",
      sourceKey: "2026/07/summary.json",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(copyObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'copy' is missing 'sourceBucket'", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "copy",
      key: "2026/07/summary.json",
      sourceKey: "2026/07/summary.json",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(copyObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'copy' is missing 'sourceKey'", async () => {
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "copy",
      key: "2026/07/summary.json",
      sourceBucket: "archive",
    });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(copyObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'delete' is missing 'key'", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "delete" });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'delete-batch' is missing 'input'", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "delete-batch" });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(deleteObjectsMock).not.toHaveBeenCalled();
  });

  test("throws ERR_S3_OBJECTS_CONFIG when 'operation' is stored as a value outside the declared set (defensive)", async () => {
    const deps = buildDeps({ ...BASE_CONFIG, operation: "frobnicate" });

    await expect(runS3Objects(deps)).rejects.toMatchObject({
      code: "ERR_S3_OBJECTS_CONFIG",
    });
    expect(listObjectsMock).not.toHaveBeenCalled();
  });
});

describe("runS3Objects — destructive-gate routing", () => {
  test.each(["put", "copy", "delete", "delete-batch"] as const)(
    "'%s' routes through the destructive gate (prompt.confirm called once)",
    async (operation) => {
      putObjectMock.mockResolvedValue(undefined);
      copyObjectMock.mockResolvedValue(undefined);
      deleteObjectMock.mockResolvedValue(undefined);
      deleteObjectsMock.mockResolvedValue({ deleted: 1, errors: [] });
      stubReadFile("body bytes");
      const prompt = new Core.M3LPrompt();
      const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
      const configByOperation: Record<string, Record<string, unknown>> = {
        put: { key: "k", input: "in.bin" },
        copy: { key: "k", sourceBucket: "archive", sourceKey: "k" },
        delete: { key: "k" },
        "delete-batch": { input: "keys.jsonl" },
      };
      const opConfig = configByOperation[operation];
      if (opConfig === undefined) throw new Error("unreachable");
      const deps = buildDeps(
        { ...BASE_CONFIG, operation, ...opConfig },
        { prompt },
      );

      await runS3Objects(deps);

      expect(confirm).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["list", "describe", "get"] as const)(
    "'%s' does NOT route through the destructive gate (prompt.confirm never called)",
    async (operation) => {
      stubOutputStream();
      stubWriteFile();
      listObjectsMock.mockImplementation(async function* fakeListObjects() {
        await Promise.resolve();
        yield { objects: [], nextContinuationToken: undefined };
      });
      headObjectMock.mockResolvedValue(undefined);
      getObjectMock.mockResolvedValue({
        body: new Uint8Array(),
        metadata: {
          contentLength: 0,
          contentType: undefined,
          eTag: undefined,
          lastModified: undefined,
        },
      });
      const prompt = new Core.M3LPrompt();
      const confirm = vi.spyOn(prompt, "confirm").mockResolvedValue(true);
      const configByOperation: Record<string, Record<string, unknown>> = {
        list: { output: "out.jsonl" },
        describe: { key: "k", output: "out.json" },
        get: { key: "k", output: "out.bin" },
      };
      const opConfig = configByOperation[operation];
      if (opConfig === undefined) throw new Error("unreachable");
      const deps = buildDeps(
        { ...BASE_CONFIG, operation, ...opConfig },
        { prompt },
      );

      await runS3Objects(deps);

      expect(confirm).not.toHaveBeenCalled();
    },
  );
});

describe("runS3Objects — gate-decline soft-lands", () => {
  test("a declined destructive gate returns an all-zero summary and does not throw, logging a warning", async () => {
    const prompt = confirmingPrompt(false);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "delete", key: "2026/07/summary.json" },
      { prompt },
    );
    const warningSpy = vi.spyOn(deps.logger, "warning");

    const summary = await runS3Objects(deps);

    expect(summary).toEqual({ processed: 0, failed: 0 });
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalled();
  });

  test("a gate failure OTHER than ERR_S3_OBJECTS_ABORTED propagates unmodified — it is not soft-landed to an all-zero summary", async () => {
    const prompt = new Core.M3LPrompt();
    const unrelatedError = new Error("prompt backend unavailable");
    vi.spyOn(prompt, "confirm").mockRejectedValue(unrelatedError);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "delete", key: "2026/07/summary.json" },
      { prompt },
    );

    let thrown: unknown;
    try {
      await runS3Objects(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(unrelatedError);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("runS3Objects — operation dispatch routing", () => {
  test("'list' calls AWS.listObjects and streams every summary to output", async () => {
    const output = stubOutputStream();
    listObjectsMock.mockImplementation(async function* fakeListObjects() {
      await Promise.resolve();
      yield {
        objects: [
          { key: "a", size: 1, lastModified: undefined, eTag: undefined },
          { key: "b", size: 2, lastModified: undefined, eTag: undefined },
        ],
        nextContinuationToken: undefined,
      };
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "list",
      output: "out.jsonl",
    });

    const summary = await runS3Objects(deps);

    expect(listObjectsMock).toHaveBeenCalled();
    expect(summary).toEqual({ processed: 2, failed: 0 });
    expect(output.content().trim().split("\n")).toHaveLength(2);
  });

  test("'describe' calls AWS.headObject and writes metadata JSON to output", async () => {
    stubWriteFile();
    headObjectMock.mockResolvedValue({
      contentLength: 10,
      contentType: "application/json",
      eTag: "abc",
      lastModified: undefined,
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "describe",
      key: "2026/07/summary.json",
      output: "out.json",
    });

    const summary = await runS3Objects(deps);

    expect(headObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
    );
    expect(summary).toEqual({ processed: 1, failed: 0 });
  });

  test("'get' calls AWS.getObject and writes raw body bytes to output", async () => {
    stubWriteFile();
    const body = new Uint8Array([9, 9, 9]);
    getObjectMock.mockResolvedValue({
      body,
      metadata: {
        contentLength: 3,
        contentType: undefined,
        eTag: undefined,
        lastModified: undefined,
      },
    });
    const deps = buildDeps({
      ...BASE_CONFIG,
      operation: "get",
      key: "2026/07/summary.json",
      output: "out.bin",
    });

    const summary = await runS3Objects(deps);

    expect(getObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
    );
    expect(summary).toEqual({ processed: 1, failed: 0 });
  });

  test("'put' passes the gate then calls AWS.putObject with the input file's bytes", async () => {
    stubReadFile("hello world");
    putObjectMock.mockResolvedValue(undefined);
    const prompt = confirmingPrompt(true);
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "put",
        key: "2026/07/summary.json",
        input: "in.bin",
        contentType: "text/plain",
      },
      { prompt },
    );

    const summary = await runS3Objects(deps);

    expect(putObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
      expect.anything(),
      { contentType: "text/plain" },
    );
    expect(summary).toEqual({ processed: 1, failed: 0 });
  });

  test("'copy' passes the gate then calls AWS.copyObject with the exact argument shape", async () => {
    copyObjectMock.mockResolvedValue(undefined);
    const prompt = confirmingPrompt(true);
    const deps = buildDeps(
      {
        ...BASE_CONFIG,
        operation: "copy",
        key: "2026/07/summary.json",
        sourceBucket: "archive",
        sourceKey: "2025/old-summary.json",
      },
      { prompt },
    );

    const summary = await runS3Objects(deps);

    expect(copyObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
      { bucket: "archive", key: "2025/old-summary.json" },
    );
    expect(summary).toEqual({ processed: 1, failed: 0 });
  });

  test("'delete' passes the gate then calls AWS.deleteObject", async () => {
    deleteObjectMock.mockResolvedValue(undefined);
    const prompt = confirmingPrompt(true);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "delete", key: "2026/07/summary.json" },
      { prompt },
    );

    const summary = await runS3Objects(deps);

    expect(deleteObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
    );
    expect(summary).toEqual({ processed: 1, failed: 0 });
  });

  test("'delete-batch' passes the gate, calls AWS.deleteObjects, and reports the confirmed-deleted count", async () => {
    stubReadFile(keyRecordsJSONL(3));
    deleteObjectsMock.mockResolvedValue({ deleted: 3, errors: [] });
    const prompt = confirmingPrompt(true);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "delete-batch", input: "keys.jsonl" },
      { prompt },
    );

    const summary = await runS3Objects(deps);

    expect(deleteObjectsMock).toHaveBeenCalled();
    expect(summary).toEqual({ processed: 3, failed: 0 });
  });
});

describe("runS3Objects — a delete-batch run left with failed keys rejects", () => {
  test("'delete-batch' leaving failed > 0 throws Core.M3LError coded ERR_S3_OBJECTS_FAILED_KEYS", async () => {
    stubReadFile(keyRecordsJSONL(2));
    stubOutputStream();
    deleteObjectsMock.mockResolvedValue({
      deleted: 1,
      errors: [{ key: "k1", message: "AccessDenied" }],
    });
    const prompt = confirmingPrompt(true);
    const deps = buildDeps(
      { ...BASE_CONFIG, operation: "delete-batch", input: "keys.jsonl" },
      { prompt },
    );

    let thrown: unknown;
    try {
      await runS3Objects(deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_S3_OBJECTS_FAILED_KEYS");
  });
});

describe("type contract", () => {
  test("RunS3ObjectsSummary's two fields are numbers and runS3Objects resolves it", () => {
    expectTypeOf<RunS3ObjectsSummary["processed"]>().toBeNumber();
    expectTypeOf<RunS3ObjectsSummary["failed"]>().toBeNumber();
    expectTypeOf(runS3Objects).returns.toEqualTypeOf<
      Promise<RunS3ObjectsSummary>
    >();
  });

  test("runS3Objects' deps.s3 is structurally derived from AWS.listObjects, never the SDK, and deps.prompt is Core.M3LPrompt", () => {
    expectTypeOf<Parameters<typeof runS3Objects>[0]["s3"]>().toEqualTypeOf<
      Parameters<typeof AWS.listObjects>[0]
    >();
    expectTypeOf<
      Parameters<typeof runS3Objects>[0]["prompt"]
    >().toEqualTypeOf<Core.M3LPrompt>();
  });
});
