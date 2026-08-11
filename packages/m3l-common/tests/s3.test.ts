import { describe, test, expect, vi, expectTypeOf } from "vitest";
import type { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import {
  listObjects,
  headObject,
  getObject,
  putObject,
  copyObject,
  deleteObject,
  deleteObjects,
  M3LS3OperationError,
  parseS3Uri,
  formatS3Uri,
  type S3Page,
  type DeleteObjectsResult,
  type M3LS3Uri,
} from "../src/aws/s3/index.js";
import { M3LError } from "../src/core/errors/index.js";

/**
 * TDD seam for `aws/s3` (ADR-0033: `s3-objects` W3 script needs object
 * operations without importing `@aws-sdk/client-s3` directly), per
 * `docs/reference/aws/s3.md`.
 *
 * Scaffold stage: every operation body currently throws
 * {@link M3LS3OperationError} unconditionally, so every happy-path test below
 * is RED until `implementing-submodules` fills in `src/aws/s3/operations.ts`.
 */
describe("aws/s3", () => {
  test("listObjects yields pages shaped as { objects, nextContinuationToken } (type contract)", () => {
    expectTypeOf(listObjects).returns.toEqualTypeOf<AsyncGenerator<S3Page>>();
  });

  test("deleteObjects resolves { deleted, errors } (type contract)", () => {
    expectTypeOf(
      deleteObjects,
    ).returns.resolves.toEqualTypeOf<DeleteObjectsResult>();
  });

  describe("listObjects", () => {
    test("yields one page of object summaries (happy path)", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          Contents: [{ Key: "2026/07/summary.json", Size: 42, ETag: '"abc"' }],
          NextContinuationToken: undefined,
        }),
      } as unknown as S3Client;

      const pages: S3Page[] = [];
      for await (const page of listObjects(client, "reports")) {
        pages.push(page);
      }

      expect(pages).toEqual([
        {
          objects: [
            {
              key: "2026/07/summary.json",
              size: 42,
              eTag: '"abc"',
              lastModified: undefined,
            },
          ],
          nextContinuationToken: undefined,
        },
      ]);
    });

    test("throws M3LS3OperationError with code ERR_S3_OPERATION on SDK rejection", async () => {
      const client = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as S3Client;

      const generator = listObjects(client, "reports");
      await expect(generator.next()).rejects.toThrow(M3LS3OperationError);
      await expect(listObjects(client, "reports").next()).rejects.toMatchObject(
        { code: "ERR_S3_OPERATION" },
      );
    });

    test("completes without error when called with no options and no continuationToken", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          Contents: [],
          NextContinuationToken: undefined,
        }),
      } as unknown as S3Client;

      const pages: S3Page[] = [];
      for await (const page of listObjects(client, "reports")) {
        pages.push(page);
      }

      expect(pages).toEqual([
        { objects: [], nextContinuationToken: undefined },
      ]);
    });

    test("forwards Prefix, MaxKeys, and ContinuationToken to the SDK when all are supplied", async () => {
      const send = vi.fn().mockResolvedValue({
        Contents: [],
        NextContinuationToken: undefined,
      });
      const client = { send } as unknown as S3Client;

      const pages: S3Page[] = [];
      for await (const page of listObjects(
        client,
        "reports",
        { prefix: "2026/07/", pageSize: 10 },
        "resume-token",
      )) {
        pages.push(page);
      }

      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0]?.[0] as ListObjectsV2Command;
      expect(command.input).toMatchObject({
        Bucket: "reports",
        Prefix: "2026/07/",
        MaxKeys: 10,
        ContinuationToken: "resume-token",
      });
    });

    test("yields an empty objects array when the response omits Contents entirely", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({ NextContinuationToken: undefined }),
      } as unknown as S3Client;

      const pages: S3Page[] = [];
      for await (const page of listObjects(client, "reports")) {
        pages.push(page);
      }

      expect(pages).toEqual([
        { objects: [], nextContinuationToken: undefined },
      ]);
    });

    test('defaults a Contents entry\'s missing Key to "" and missing Size to 0', async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          Contents: [{ ETag: '"x"' }],
          NextContinuationToken: undefined,
        }),
      } as unknown as S3Client;

      const pages: S3Page[] = [];
      for await (const page of listObjects(client, "reports")) {
        pages.push(page);
      }

      expect(pages).toEqual([
        {
          objects: [{ key: "", size: 0, eTag: '"x"', lastModified: undefined }],
          nextContinuationToken: undefined,
        },
      ]);
    });

    test("rethrows an already-M3LS3OperationError cause unchanged, without re-wrapping", async () => {
      const inner = new M3LS3OperationError("inner", { context: { x: 1 } });
      const client = {
        send: vi.fn().mockRejectedValue(inner),
      } as unknown as S3Client;

      const generator = listObjects(client, "reports");
      let thrown: unknown;
      try {
        await generator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(inner);
      expect((thrown as M3LS3OperationError).message).toBe("inner");
    });
  });

  describe("headObject", () => {
    test("returns object metadata (happy path)", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          ContentLength: 42,
          ContentType: "application/json",
          ETag: '"abc"',
          LastModified: undefined,
        }),
      } as unknown as S3Client;

      const result = await headObject(
        client,
        "reports",
        "2026/07/summary.json",
      );

      expect(result).toEqual({
        contentLength: 42,
        contentType: "application/json",
        eTag: '"abc"',
        lastModified: undefined,
      });
    });

    test("throws M3LS3OperationError with code ERR_S3_OPERATION on SDK rejection", async () => {
      const client = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as S3Client;

      await expect(
        headObject(client, "reports", "missing.json"),
      ).rejects.toThrow(M3LS3OperationError);
      await expect(
        headObject(client, "reports", "missing.json"),
      ).rejects.toMatchObject({ code: "ERR_S3_OPERATION" });
    });

    test("returns undefined when the object does not exist (404 / NotFound)", async () => {
      const notFound = Object.assign(new Error("NotFound"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
      const client = {
        send: vi.fn().mockRejectedValue(notFound),
      } as unknown as S3Client;

      await expect(
        headObject(client, "reports", "missing.json"),
      ).resolves.toBeUndefined();
    });

    test("defaults contentLength to 0 when the response omits ContentLength", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          ContentType: "application/json",
          ETag: '"abc"',
          LastModified: undefined,
        }),
      } as unknown as S3Client;

      const result = await headObject(
        client,
        "reports",
        "2026/07/summary.json",
      );

      expect(result).toEqual({
        contentLength: 0,
        contentType: "application/json",
        eTag: '"abc"',
        lastModified: undefined,
      });
    });

    test("rethrows an already-M3LS3OperationError cause unchanged, without re-wrapping", async () => {
      const inner = new M3LS3OperationError("inner", { context: { x: 1 } });
      const client = {
        send: vi.fn().mockRejectedValue(inner),
      } as unknown as S3Client;

      let thrown: unknown;
      try {
        await headObject(client, "reports", "2026/07/summary.json");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(inner);
      expect((thrown as M3LS3OperationError).message).toBe("inner");
    });
  });

  describe("getObject", () => {
    test("returns the object body and metadata (happy path)", async () => {
      const body = new Uint8Array([1, 2, 3]);
      const client = {
        send: vi.fn().mockResolvedValue({
          Body: { transformToByteArray: () => Promise.resolve(body) },
          ContentLength: 3,
          ContentType: "application/octet-stream",
          ETag: '"abc"',
          LastModified: undefined,
        }),
      } as unknown as S3Client;

      const result = await getObject(client, "reports", "2026/07/summary.json");

      expect(result.body).toEqual(body);
      expect(result.metadata.contentLength).toBe(3);
    });

    test("throws M3LS3OperationError with code ERR_S3_OPERATION on SDK rejection", async () => {
      const client = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as S3Client;

      await expect(
        getObject(client, "reports", "missing.json"),
      ).rejects.toThrow(M3LS3OperationError);
      await expect(
        getObject(client, "reports", "missing.json"),
      ).rejects.toMatchObject({ code: "ERR_S3_OPERATION" });
    });

    test("throws M3LS3OperationError when the SDK response has no Body", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          Body: undefined,
          ContentLength: 3,
          ContentType: "application/octet-stream",
          ETag: '"abc"',
          LastModified: undefined,
        }),
      } as unknown as S3Client;

      await expect(
        getObject(client, "reports", "2026/07/summary.json"),
      ).rejects.toThrow(M3LS3OperationError);
      await expect(
        getObject(client, "reports", "2026/07/summary.json"),
      ).rejects.toMatchObject({ code: "ERR_S3_OPERATION" });
    });

    test("defaults metadata.contentLength to 0 when the response omits ContentLength", async () => {
      const body = new Uint8Array([1, 2, 3]);
      const client = {
        send: vi.fn().mockResolvedValue({
          Body: { transformToByteArray: () => Promise.resolve(body) },
          ContentType: "application/octet-stream",
          ETag: '"abc"',
          LastModified: undefined,
        }),
      } as unknown as S3Client;

      const result = await getObject(client, "reports", "2026/07/summary.json");

      expect(result.metadata.contentLength).toBe(0);
    });
  });

  describe("putObject", () => {
    test("writes an object (happy path)", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as S3Client;

      await expect(
        putObject(client, "reports", "2026/07/summary.json", "{}", {
          contentType: "application/json",
        }),
      ).resolves.toBeUndefined();
    });

    test("throws M3LS3OperationError with code ERR_S3_OPERATION on SDK rejection", async () => {
      const client = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as S3Client;

      await expect(
        putObject(client, "reports", "2026/07/summary.json", "{}"),
      ).rejects.toThrow(M3LS3OperationError);
      await expect(
        putObject(client, "reports", "2026/07/summary.json", "{}"),
      ).rejects.toMatchObject({ code: "ERR_S3_OPERATION" });
    });

    test("rethrows an already-M3LS3OperationError cause unchanged, without re-wrapping", async () => {
      const inner = new M3LS3OperationError("inner", { context: { x: 1 } });
      const client = {
        send: vi.fn().mockRejectedValue(inner),
      } as unknown as S3Client;

      let thrown: unknown;
      try {
        await putObject(client, "reports", "2026/07/summary.json", "{}");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(inner);
      expect((thrown as M3LS3OperationError).message).toBe("inner");
    });
  });

  describe("copyObject", () => {
    test("copies an object (happy path)", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as S3Client;

      await expect(
        copyObject(client, "archive", "2026/07/summary.json", {
          bucket: "reports",
          key: "2026/07/summary.json",
        }),
      ).resolves.toBeUndefined();
    });

    test("throws M3LS3OperationError with code ERR_S3_OPERATION on SDK rejection", async () => {
      const client = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as S3Client;

      await expect(
        copyObject(client, "archive", "2026/07/summary.json", {
          bucket: "reports",
          key: "2026/07/summary.json",
        }),
      ).rejects.toThrow(M3LS3OperationError);
      await expect(
        copyObject(client, "archive", "2026/07/summary.json", {
          bucket: "reports",
          key: "2026/07/summary.json",
        }),
      ).rejects.toMatchObject({ code: "ERR_S3_OPERATION" });
    });

    test("rethrows an already-M3LS3OperationError cause unchanged, without re-wrapping", async () => {
      const inner = new M3LS3OperationError("inner", { context: { x: 1 } });
      const client = {
        send: vi.fn().mockRejectedValue(inner),
      } as unknown as S3Client;

      let thrown: unknown;
      try {
        await copyObject(client, "archive", "2026/07/summary.json", {
          bucket: "reports",
          key: "2026/07/summary.json",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(inner);
      expect((thrown as M3LS3OperationError).message).toBe("inner");
    });

    test("URL-encodes each CopySource path segment", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as S3Client;

      await copyObject(client, "archive", "2026/07/summary.json", {
        bucket: "reports",
        key: "2026/07/my report.json",
      });

      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0]?.[0] as CopyObjectCommand;
      expect(command).toBeInstanceOf(CopyObjectCommand);
      expect(command.input.CopySource).toBe("reports/2026/07/my%20report.json");
    });
  });

  describe("deleteObject", () => {
    test("deletes a single object (happy path)", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({}),
      } as unknown as S3Client;

      await expect(
        deleteObject(client, "reports", "2026/07/summary.json"),
      ).resolves.toBeUndefined();
    });

    test("throws M3LS3OperationError with code ERR_S3_OPERATION on SDK rejection", async () => {
      const client = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as S3Client;

      await expect(
        deleteObject(client, "reports", "2026/07/summary.json"),
      ).rejects.toThrow(M3LS3OperationError);
      await expect(
        deleteObject(client, "reports", "2026/07/summary.json"),
      ).rejects.toMatchObject({ code: "ERR_S3_OPERATION" });
    });

    test("rethrows an already-M3LS3OperationError cause unchanged, without re-wrapping", async () => {
      const inner = new M3LS3OperationError("inner", { context: { x: 1 } });
      const client = {
        send: vi.fn().mockRejectedValue(inner),
      } as unknown as S3Client;

      let thrown: unknown;
      try {
        await deleteObject(client, "reports", "2026/07/summary.json");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(inner);
      expect((thrown as M3LS3OperationError).message).toBe("inner");
    });
  });

  describe("deleteObjects", () => {
    test("deletes a batch of keys (happy path)", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          Deleted: [{ Key: "a.json" }, { Key: "b.json" }],
          Errors: [],
        }),
      } as unknown as S3Client;

      const result = await deleteObjects(client, "reports", [
        "a.json",
        "b.json",
      ]);

      expect(result).toEqual({ deleted: 2, errors: [] });
    });

    test("short-circuits to a zero-result on an empty key array without calling send", async () => {
      const send = vi.fn();
      const client = { send } as unknown as S3Client;

      const result = await deleteObjects(client, "reports", []);

      expect(result).toEqual({ deleted: 0, errors: [] });
      expect(send).not.toHaveBeenCalled();
    });

    test("rejects a batch larger than the 1000-key S3 cap", async () => {
      const client = { send: vi.fn() } as unknown as S3Client;
      const keys = Array.from(
        { length: 1001 },
        (_, i) => `key-${String(i)}.json`,
      );

      await expect(deleteObjects(client, "reports", keys)).rejects.toThrow(
        M3LS3OperationError,
      );
    });

    test("throws M3LS3OperationError with code ERR_S3_OPERATION on SDK rejection", async () => {
      const client = {
        send: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as S3Client;

      await expect(
        deleteObjects(client, "reports", ["a.json"]),
      ).rejects.toThrow(M3LS3OperationError);
      await expect(
        deleteObjects(client, "reports", ["a.json"]),
      ).rejects.toMatchObject({ code: "ERR_S3_OPERATION" });
    });

    test("defaults deleted to 0 when the response omits Deleted entirely", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({ Errors: [] }),
      } as unknown as S3Client;

      const result = await deleteObjects(client, "reports", ["a.json"]);

      expect(result).toEqual({ deleted: 0, errors: [] });
    });

    test("defaults errors to [] when the response omits Errors entirely", async () => {
      const client = {
        send: vi.fn().mockResolvedValue({ Deleted: [{ Key: "a.json" }] }),
      } as unknown as S3Client;

      const result = await deleteObjects(client, "reports", ["a.json"]);

      expect(result).toEqual({ deleted: 1, errors: [] });
    });

    test('maps each Errors entry, defaulting a missing Key/Message to ""', async () => {
      const client = {
        send: vi.fn().mockResolvedValue({
          Deleted: [],
          Errors: [{ Key: "bad.json", Message: "AccessDenied" }, {}],
        }),
      } as unknown as S3Client;

      const result = await deleteObjects(client, "reports", [
        "bad.json",
        "other.json",
      ]);

      expect(result.errors).toEqual([
        { key: "bad.json", message: "AccessDenied" },
        { key: "", message: "" },
      ]);
    });

    test("rethrows an already-M3LS3OperationError cause unchanged, without re-wrapping", async () => {
      const inner = new M3LS3OperationError("inner", { context: { x: 1 } });
      const client = {
        send: vi.fn().mockRejectedValue(inner),
      } as unknown as S3Client;

      let thrown: unknown;
      try {
        await deleteObjects(client, "reports", ["a.json"]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(inner);
      expect((thrown as M3LS3OperationError).message).toBe("inner");
    });
  });
});

/**
 * TDD seam for `aws/s3`'s `parseS3Uri`/`formatS3Uri` (`src/aws/s3/uri.ts`),
 * per `docs/reference/aws/s3.md`.
 *
 * Scaffold stage: `src/aws/s3/uri.ts` does not exist yet, so the import above
 * fails module resolution (TS2305) until `implementing-submodules` adds it
 * and re-exports it from `src/aws/s3/index.ts`.
 */
describe("parseS3Uri / formatS3Uri", () => {
  describe("parseS3Uri", () => {
    test("parses a bucket and a nested-prefix key (happy path)", () => {
      expect(parseS3Uri("s3://reports/2026/07/summary.json")).toEqual({
        bucket: "reports",
        key: "2026/07/summary.json",
      });
    });

    test("parses a bucket and a single-segment key (happy path)", () => {
      expect(parseS3Uri("s3://bucket/single-key")).toEqual({
        bucket: "bucket",
        key: "single-key",
      });
    });

    test.each([
      ["wrong scheme", "http://bucket/key"],
      ["no scheme at all", "bucket/key"],
      ["missing key entirely", "s3://bucket"],
      ["empty key (trailing slash)", "s3://bucket/"],
      ["empty bucket", "s3:///key"],
      ["empty string", ""],
    ])(
      "throws M3LError(ERR_INVALID_ARGUMENT) on %s",
      (_label, malformedUri) => {
        expect(() => parseS3Uri(malformedUri)).toThrowError(M3LError);
        let thrown: unknown;
        try {
          parseS3Uri(malformedUri);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
      },
    );

    test("returns an M3LS3Uri (type contract)", () => {
      expectTypeOf(parseS3Uri).returns.toEqualTypeOf<M3LS3Uri>();
    });

    test("bounds both the thrown message and context.uri for an oversized malformed uri", () => {
      const malformedUri = "not-s3://" + "a".repeat(300);
      expect(malformedUri.length).toBeGreaterThan(200);

      let thrown: unknown;
      try {
        parseS3Uri(malformedUri);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LError);
      const error = thrown as M3LError;

      expect(error.message.length).toBeLessThan(250);
      expect(error.message).not.toContain("a".repeat(250));

      const context = error.context as Record<string, unknown> | undefined;
      expect(context).toBeDefined();
      const uri = context?.["uri"];
      expect(typeof uri).toBe("string");
      expect((uri as string).length).toBeLessThanOrEqual(200);
    });
  });

  describe("formatS3Uri", () => {
    test("formats a bucket and a nested-prefix key (happy path)", () => {
      expect(
        formatS3Uri({ bucket: "reports", key: "2026/07/summary.json" }),
      ).toBe("s3://reports/2026/07/summary.json");
    });

    test.each([
      "s3://reports/2026/07/summary.json",
      "s3://bucket/key",
      "s3://bucket/single-key",
    ])("round-trips %s through parseS3Uri and back", (uri) => {
      expect(formatS3Uri(parseS3Uri(uri))).toBe(uri);
    });

    test("returns a string (type contract)", () => {
      expectTypeOf(formatS3Uri).returns.toEqualTypeOf<string>();
    });

    test.each([
      ["empty bucket", { bucket: "", key: "key" }],
      ["bucket containing /", { bucket: "a/b", key: "key" }],
      ["empty key", { bucket: "bucket", key: "" }],
    ])("throws M3LError(ERR_INVALID_ARGUMENT) on %s", (_label, input) => {
      expect(() => formatS3Uri(input)).toThrow(M3LError);
      let thrown: unknown;
      try {
        formatS3Uri(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
    });
  });
});
