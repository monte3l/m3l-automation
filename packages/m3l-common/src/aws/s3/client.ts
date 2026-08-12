/**
 * `aws/s3/client` — {@link M3LS3Operations}, a thin per-instance wrapper over
 * the free functions in `aws/s3/operations` so a caller holding a single
 * provisioned `S3Client` (e.g. `provider.services.s3Operations`) doesn't have
 * to keep re-passing it to every call (ADR-0038 AWS service tier).
 *
 * @packageDocumentation
 */

import type { S3Client } from "@aws-sdk/client-s3";

import type {
  CopyObjectSource,
  DeleteObjectsResult,
  GetObjectResult,
  ListObjectsOptions,
  PutObjectOptions,
  S3ObjectMetadata,
  S3Page,
} from "./operations.js";
import {
  copyObject,
  deleteObject,
  deleteObjects,
  getObject,
  headObject,
  listObjects,
  putObject,
} from "./operations.js";

/**
 * Typed operations over a single, already-provisioned `S3Client`: list, head,
 * get, put, copy, and delete objects — every method thinly delegates to the
 * matching free function in `aws/s3/operations`, forwarding `this.client` as
 * the first argument.
 *
 * @example
 * ```ts
 * import { M3LS3Operations } from "@m3l-automation/m3l-common/aws";
 *
 * const s3Operations = new M3LS3Operations(script.aws.clients.s3);
 * const { body } = await s3Operations.getObject("reports", "2026/07/summary.json");
 * ```
 */
export class M3LS3Operations {
  /**
   * Creates a new `M3LS3Operations` wrapping the given raw SDK client.
   *
   * @param client - A constructed `S3Client` (e.g. `script.aws.clients.s3`).
   */
  constructor(private readonly client: S3Client) {}

  /**
   * Lists objects in a bucket, one page at a time. See {@link listObjects}.
   *
   * @param bucket - Target bucket.
   * @param options - Listing parameters.
   * @param continuationToken - Resume cursor from a prior page (`--resume`).
   * @throws {@link M3LS3OperationError} when the underlying `ListObjectsV2Command` rejects.
   * @example
   * ```ts
   * for await (const page of s3Operations.listObjects("reports", { prefix: "2026/" })) {
   *   for (const object of page.objects) console.log(object.key);
   * }
   * ```
   */
  listObjects(
    bucket: string,
    options?: ListObjectsOptions,
    continuationToken?: string,
  ): AsyncGenerator<S3Page> {
    return listObjects(this.client, bucket, options, continuationToken);
  }

  /**
   * Fetches an object's metadata without downloading its body. See {@link headObject}.
   *
   * @param bucket - Target bucket.
   * @param key - The object's key.
   * @returns The object's metadata, or `undefined` when no object exists at `key`.
   * @throws {@link M3LS3OperationError} when the underlying `HeadObjectCommand` rejects for a reason other than not-found.
   * @example
   * ```ts
   * const metadata = await s3Operations.headObject("reports", "2026/07/summary.json");
   * ```
   */
  headObject(
    bucket: string,
    key: string,
  ): Promise<S3ObjectMetadata | undefined> {
    return headObject(this.client, bucket, key);
  }

  /**
   * Downloads an object's full body and metadata. See {@link getObject}.
   *
   * @param bucket - Target bucket.
   * @param key - The object's key.
   * @throws {@link M3LS3OperationError} when the underlying `GetObjectCommand` rejects.
   * @example
   * ```ts
   * const { body } = await s3Operations.getObject("reports", "2026/07/summary.json");
   * ```
   */
  getObject(bucket: string, key: string): Promise<GetObjectResult> {
    return getObject(this.client, bucket, key);
  }

  /**
   * Writes (creates or fully replaces) an object. See {@link putObject}.
   *
   * @param bucket - Target bucket.
   * @param key - The object's key.
   * @param body - The object's content.
   * @param options - Optional write parameters.
   * @throws {@link M3LS3OperationError} when the underlying `PutObjectCommand` rejects.
   * @example
   * ```ts
   * await s3Operations.putObject("reports", "2026/07/summary.json", jsonBody, {
   *   contentType: "application/json",
   * });
   * ```
   */
  putObject(
    bucket: string,
    key: string,
    body: Uint8Array | string,
    options?: PutObjectOptions,
  ): Promise<void> {
    return putObject(this.client, bucket, key, body, options);
  }

  /**
   * Copies an object, within or across buckets. See {@link copyObject}.
   *
   * @param destinationBucket - Target bucket.
   * @param destinationKey - Target key.
   * @param source - The object to copy from.
   * @throws {@link M3LS3OperationError} when the underlying `CopyObjectCommand` rejects.
   * @example
   * ```ts
   * await s3Operations.copyObject("archive", "2026/07/summary.json", {
   *   bucket: "reports",
   *   key: "2026/07/summary.json",
   * });
   * ```
   */
  copyObject(
    destinationBucket: string,
    destinationKey: string,
    source: CopyObjectSource,
  ): Promise<void> {
    return copyObject(this.client, destinationBucket, destinationKey, source);
  }

  /**
   * Deletes a single object by key. See {@link deleteObject}.
   *
   * @param bucket - Target bucket.
   * @param key - The object's key.
   * @throws {@link M3LS3OperationError} when the underlying `DeleteObjectCommand` rejects.
   * @example
   * ```ts
   * await s3Operations.deleteObject("reports", "2026/07/summary.json");
   * ```
   */
  deleteObject(bucket: string, key: string): Promise<void> {
    return deleteObject(this.client, bucket, key);
  }

  /**
   * Deletes up to 1000 objects in one `DeleteObjects` request. See {@link deleteObjects}.
   *
   * @param bucket - Target bucket.
   * @param keys - At most 1000 keys (the S3 `DeleteObjects` cap).
   * @throws {@link M3LS3OperationError} when the underlying `DeleteObjectsCommand` rejects, or when `keys.length` exceeds 1000.
   * @example
   * ```ts
   * const { deleted, errors } = await s3Operations.deleteObjects("reports", chunk);
   * ```
   */
  deleteObjects(
    bucket: string,
    keys: readonly string[],
  ): Promise<DeleteObjectsResult> {
    return deleteObjects(this.client, bucket, keys);
  }
}
