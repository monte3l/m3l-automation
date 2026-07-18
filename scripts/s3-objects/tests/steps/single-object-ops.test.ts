import * as fsp from "node:fs/promises";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make 'node:fs/promises' configurable so vi.spyOn can intercept individual
// functions (ESM namespace objects are non-writable) — mirrors
// scripts/dynamodb-crud/tests/run-dynamodb-crud.test.ts.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

import type * as M3LCommon from "@m3l-automation/m3l-common";

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    AWS: {
      ...actual.AWS,
      headObject: vi.fn(),
      getObject: vi.fn(),
      putObject: vi.fn(),
      copyObject: vi.fn(),
      deleteObject: vi.fn(),
    },
  };
});

import { AWS, Core } from "@m3l-automation/m3l-common";

import type { RunSingleObjectOpSummary } from "../../src/steps/single-object-ops.js";
import { runSingleObjectOp } from "../../src/steps/single-object-ops.js";

/**
 * Contract: docs/reference/scripts/s3-objects.md, `single-object-ops` row +
 * Behavioral contract's "describe on a missing object" / "get on a missing
 * object" bullets. `describe`/`get`/`put`/`copy`/`delete`: one call each via
 * `AWS.headObject`/`getObject`/`putObject`/`copyObject`/`deleteObject`. This
 * step never gates a destructive operation itself — the orchestrator decides.
 *
 * Design choice (this step's own, since the contract doesn't pick a
 * primitive): reads/writes raw file bytes directly via `node:fs/promises`
 * `readFile`/`writeFile` — not the `Core` importer/exporter classes, which
 * are JSONL/CSV-row-shaped and don't fit a single JSON document or raw byte
 * body. Cross-parameter guard checks (e.g. `key` required for `describe`)
 * are NOT this step's job — that's `run-s3-objects`'s responsibility per the
 * contract's "Configuration schema" section, so every call below supplies a
 * complete, valid deps object.
 */

const headObjectMock = vi.mocked(AWS.headObject);
const getObjectMock = vi.mocked(AWS.getObject);
const putObjectMock = vi.mocked(AWS.putObject);
const copyObjectMock = vi.mocked(AWS.copyObject);
const deleteObjectMock = vi.mocked(AWS.deleteObject);

// Only the mocked AWS functions are ever invoked on this client in these
// tests; the client value itself is never dereferenced, so an opaque
// placeholder is safe.
const fakeClient = {} as Parameters<typeof AWS.headObject>[0];

afterEach(() => {
  // restoreAllMocks() only undoes vi.spyOn spies (fsp.* below); it does not
  // clear the plain vi.fn() AWS.* mocks (created inside the top-level
  // vi.mock() factory), so their call history would otherwise leak into the
  // next test.
  vi.restoreAllMocks();
  vi.mocked(AWS.headObject).mockReset();
  vi.mocked(AWS.getObject).mockReset();
  vi.mocked(AWS.putObject).mockReset();
  vi.mocked(AWS.copyObject).mockReset();
  vi.mocked(AWS.deleteObject).mockReset();
});

describe("runSingleObjectOp — describe", () => {
  test("a found object writes its metadata as JSON to output and reports processed: 1", async () => {
    const writeFileSpy = vi.spyOn(fsp, "writeFile").mockResolvedValue();
    const metadata = {
      contentLength: 42,
      contentType: "application/json",
      eTag: "abc",
      lastModified: undefined,
    };
    headObjectMock.mockResolvedValue(metadata);
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");

    const summary = await runSingleObjectOp({
      client: fakeClient,
      operation: "describe",
      bucket: "reports",
      key: "2026/07/summary.json",
      outputPath: "describe-out.json",
      logger,
    });

    expect(headObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
    );
    expect(writeFileSpy).toHaveBeenCalledWith(
      "describe-out.json",
      JSON.stringify(metadata),
    );
    expect(summary).toEqual({ processed: 1 });
    expect(warningSpy).not.toHaveBeenCalled();
  });

  test("a missing object writes null, logs a warning, and still reports processed: 1 (not a failure)", async () => {
    const writeFileSpy = vi.spyOn(fsp, "writeFile").mockResolvedValue();
    headObjectMock.mockResolvedValue(undefined);
    const logger = new Core.M3LLogger([]);
    const warningSpy = vi.spyOn(logger, "warning");

    const summary = await runSingleObjectOp({
      client: fakeClient,
      operation: "describe",
      bucket: "reports",
      key: "missing.json",
      outputPath: "describe-out.json",
      logger,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      "describe-out.json",
      JSON.stringify(null),
    );
    expect(summary).toEqual({ processed: 1 });
    expect(warningSpy).toHaveBeenCalled();
  });

  test("fsp.writeFile rejecting throws Core.M3LError coded ERR_S3_OBJECTS_OUTPUT chaining the original fs error as cause", async () => {
    const fsError = new Error("ENOSPC: no space left on device");
    vi.spyOn(fsp, "writeFile").mockRejectedValue(fsError);
    headObjectMock.mockResolvedValue(undefined);
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await runSingleObjectOp({
        client: fakeClient,
        operation: "describe",
        bucket: "reports",
        key: "2026/07/summary.json",
        outputPath: "describe-out.json",
        logger,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe("ERR_S3_OBJECTS_OUTPUT");
    expect(error.message).toBe("failed writing 'describe-out.json'");
    expect(error.cause).toBe(fsError);
  });
});

describe("runSingleObjectOp — get", () => {
  test("writes the raw body bytes to output verbatim (NOT JSON-stringified) and reports processed: 1", async () => {
    const writeFileSpy = vi.spyOn(fsp, "writeFile").mockResolvedValue();
    const body = new Uint8Array([1, 2, 3, 4]);
    getObjectMock.mockResolvedValue({
      body,
      metadata: {
        contentLength: 4,
        contentType: "application/octet-stream",
        eTag: "xyz",
        lastModified: undefined,
      },
    });
    const logger = new Core.M3LLogger([]);

    const summary = await runSingleObjectOp({
      client: fakeClient,
      operation: "get",
      bucket: "reports",
      key: "2026/07/summary.json",
      outputPath: "get-out.bin",
      logger,
    });

    expect(getObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
    );
    expect(writeFileSpy).toHaveBeenCalledWith("get-out.bin", body);
    const [, writtenPayload] = writeFileSpy.mock.calls[0] ?? [];
    expect(writtenPayload).toBeInstanceOf(Uint8Array);
    expect(typeof writtenPayload).not.toBe("string");
    expect(summary).toEqual({ processed: 1 });
  });

  test("an AWS.getObject rejection propagates unmodified — no soft not-found path for get", async () => {
    vi.spyOn(fsp, "writeFile").mockResolvedValue();
    const operationError = new AWS.M3LS3OperationError("getObject failed", {
      cause: new Error("network blip"),
    });
    getObjectMock.mockRejectedValue(operationError);
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await runSingleObjectOp({
        client: fakeClient,
        operation: "get",
        bucket: "reports",
        key: "missing.json",
        outputPath: "get-out.bin",
        logger,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(operationError);
  });

  test("fsp.writeFile rejecting throws Core.M3LError coded ERR_S3_OBJECTS_OUTPUT chaining the original fs error as cause", async () => {
    const fsError = new Error("EACCES: permission denied");
    vi.spyOn(fsp, "writeFile").mockRejectedValue(fsError);
    getObjectMock.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      metadata: {
        contentLength: 3,
        contentType: undefined,
        eTag: undefined,
        lastModified: undefined,
      },
    });
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await runSingleObjectOp({
        client: fakeClient,
        operation: "get",
        bucket: "reports",
        key: "2026/07/summary.json",
        outputPath: "get-out.bin",
        logger,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe("ERR_S3_OBJECTS_OUTPUT");
    expect(error.message).toBe("failed writing 'get-out.bin'");
    expect(error.cause).toBe(fsError);
  });
});

describe("runSingleObjectOp — put", () => {
  test("reads the input file's raw bytes, calls AWS.putObject with them, and passes contentType through", async () => {
    const bodyBytes = Buffer.from("hello world", "utf8");
    vi.spyOn(fsp, "readFile").mockResolvedValue(bodyBytes);
    putObjectMock.mockResolvedValue(undefined);
    const logger = new Core.M3LLogger([]);

    const summary = await runSingleObjectOp({
      client: fakeClient,
      operation: "put",
      bucket: "reports",
      key: "2026/07/summary.json",
      inputPath: "put-in.bin",
      contentType: "application/json",
      logger,
    });

    expect(fsp.readFile).toHaveBeenCalledWith("put-in.bin");
    expect(putObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
      bodyBytes,
      { contentType: "application/json" },
    );
    expect(summary).toEqual({ processed: 1 });
  });

  test("fsp.readFile rejecting throws Core.M3LError coded ERR_S3_OBJECTS_OUTPUT chaining the original fs error as cause, without calling AWS.putObject", async () => {
    const fsError = new Error("ENOENT: no such file or directory");
    vi.spyOn(fsp, "readFile").mockRejectedValue(fsError);
    const logger = new Core.M3LLogger([]);

    let thrown: unknown;
    try {
      await runSingleObjectOp({
        client: fakeClient,
        operation: "put",
        bucket: "reports",
        key: "2026/07/summary.json",
        inputPath: "put-in.bin",
        logger,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Core.M3LError);
    const error = thrown as Core.M3LError;
    expect(error.code).toBe("ERR_S3_OBJECTS_OUTPUT");
    expect(error.message).toBe("failed reading 'put-in.bin'");
    expect(error.cause).toBe(fsError);
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});

describe("runSingleObjectOp — copy", () => {
  test("calls AWS.copyObject with destination bucket/key first and the source object second", async () => {
    copyObjectMock.mockResolvedValue(undefined);
    const logger = new Core.M3LLogger([]);

    const summary = await runSingleObjectOp({
      client: fakeClient,
      operation: "copy",
      bucket: "archive",
      key: "2026/07/summary.json",
      sourceBucket: "reports",
      sourceKey: "2026/07/summary.json",
      logger,
    });

    expect(copyObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "archive",
      "2026/07/summary.json",
      { bucket: "reports", key: "2026/07/summary.json" },
    );
    expect(summary).toEqual({ processed: 1 });
  });
});

describe("runSingleObjectOp — delete", () => {
  test("calls AWS.deleteObject with bucket and key and reports processed: 1", async () => {
    deleteObjectMock.mockResolvedValue(undefined);
    const logger = new Core.M3LLogger([]);

    const summary = await runSingleObjectOp({
      client: fakeClient,
      operation: "delete",
      bucket: "reports",
      key: "2026/07/summary.json",
      logger,
    });

    expect(deleteObjectMock).toHaveBeenCalledWith(
      fakeClient,
      "reports",
      "2026/07/summary.json",
    );
    expect(summary).toEqual({ processed: 1 });
  });
});

describe("type contract", () => {
  test("RunSingleObjectOpSummary.processed is a number and runSingleObjectOp resolves it", () => {
    expectTypeOf<RunSingleObjectOpSummary["processed"]>().toBeNumber();
    expectTypeOf(runSingleObjectOp).returns.toEqualTypeOf<
      Promise<RunSingleObjectOpSummary>
    >();
  });

  test("runSingleObjectOp's deps.client is structurally derived from AWS.headObject, never the SDK", () => {
    expectTypeOf<
      Parameters<typeof runSingleObjectOp>[0]["client"]
    >().toEqualTypeOf<Parameters<typeof AWS.headObject>[0]>();
  });
});
