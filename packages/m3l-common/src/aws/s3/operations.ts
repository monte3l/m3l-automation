import type { S3Client, _Object } from "@aws-sdk/client-s3";
import {
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { M3LS3OperationError } from "./error.js";

/**
 * `aws/s3/operations` — high-level S3 object operations over the `s3` client
 * from `aws/clients`.
 */

/**
 * S3's own `DeleteObjects` cap — the maximum number of keys a single
 * `deleteObjects` call may carry.
 */
const DELETE_OBJECTS_KEY_CAP = 1000;

/** One object entry returned by {@link listObjects}. */
export interface S3ObjectSummary {
  /** The object's key (full path within the bucket). */
  readonly key: string;
  /** Size in bytes. */
  readonly size: number;
  /** Last-modified timestamp, when the SDK reports one. */
  readonly lastModified: Date | undefined;
  /** The object's ETag, when the SDK reports one. */
  readonly eTag: string | undefined;
}

/** Options for {@link listObjects}. */
export interface ListObjectsOptions {
  /** Restrict results to keys beginning with this prefix. */
  readonly prefix?: string;
  /** Page size (`MaxKeys`). */
  readonly pageSize?: number;
}

/** One page yielded by {@link listObjects}. */
export interface S3Page {
  /** Object summaries in this page. */
  readonly objects: readonly S3ObjectSummary[];
  /** Cursor for the next page, or `undefined` when this was the last page. */
  readonly nextContinuationToken: string | undefined;
}

/**
 * Builds the `ListObjectsV2Command` for one {@link listObjects} page — split
 * out of `listObjects` purely to keep the generator's own cyclomatic
 * complexity within the project's lint threshold.
 */
function buildListObjectsCommand(
  bucket: string,
  prefix: string | undefined,
  pageSize: number | undefined,
  token: string | undefined,
): ListObjectsV2Command {
  return new ListObjectsV2Command({
    Bucket: bucket,
    ...(prefix !== undefined && { Prefix: prefix }),
    ...(pageSize !== undefined && { MaxKeys: pageSize }),
    ...(token !== undefined && { ContinuationToken: token }),
  });
}

/** Maps a raw `ListObjectsV2` `Contents` array to {@link S3ObjectSummary}. */
function mapS3ObjectSummaries(
  contents: readonly _Object[] | undefined,
): S3ObjectSummary[] {
  return (contents ?? []).map((object) => ({
    key: object.Key ?? "",
    size: object.Size ?? 0,
    eTag: object.ETag,
    lastModified: object.LastModified,
  }));
}

/**
 * Lists objects in a bucket, one page at a time.
 *
 * Yields pages (not individual objects) so a caller can checkpoint on
 * `nextContinuationToken` between pages without buffering the whole listing —
 * the same pattern as `aws/dynamodb`'s `queryItems`/`scanSegment`.
 *
 * @param client - A provisioned `s3` client.
 * @param bucket - Target bucket.
 * @param options - Listing parameters.
 * @param continuationToken - Resume cursor from a prior page (`--resume`).
 * @throws {@link M3LS3OperationError} when the underlying `ListObjectsV2Command` rejects.
 * @example
 * ```ts
 * import { listObjects } from "@m3l-automation/m3l-common/aws";
 *
 * for await (const page of listObjects(client, "reports", { prefix: "2026/" })) {
 *   for (const object of page.objects) console.log(object.key);
 * }
 * ```
 */
export async function* listObjects(
  client: S3Client,
  bucket: string,
  options?: ListObjectsOptions,
  continuationToken?: string,
): AsyncGenerator<S3Page> {
  const prefix = options?.prefix;
  const pageSize = options?.pageSize;
  let token = continuationToken;
  do {
    try {
      const response = await client.send(
        buildListObjectsCommand(bucket, prefix, pageSize, token),
      );
      token = response.NextContinuationToken;
      yield {
        objects: mapS3ObjectSummaries(response.Contents),
        nextContinuationToken: token,
      };
    } catch (cause) {
      if (cause instanceof M3LS3OperationError) throw cause;
      throw new M3LS3OperationError("listObjects failed", {
        cause,
        context: { bucket, prefix, continuationToken: token },
      });
    }
  } while (token !== undefined);
}

/** Object metadata returned by {@link headObject} and {@link getObject}. */
export interface S3ObjectMetadata {
  /** Size in bytes. */
  readonly contentLength: number;
  /** The object's declared content type, when the SDK reports one. */
  readonly contentType: string | undefined;
  /** The object's ETag, when the SDK reports one. */
  readonly eTag: string | undefined;
  /** Last-modified timestamp, when the SDK reports one. */
  readonly lastModified: Date | undefined;
}

/**
 * Fetches an object's metadata without downloading its body.
 *
 * @param client - A provisioned `s3` client.
 * @param bucket - Target bucket.
 * @param key - The object's key.
 * @returns The object's metadata, or `undefined` when no object exists at `key`.
 * @throws {@link M3LS3OperationError} when the underlying `HeadObjectCommand` rejects for a reason other than not-found.
 * @example
 * ```ts
 * import { headObject } from "@m3l-automation/m3l-common/aws";
 *
 * const metadata = await headObject(client, "reports", "2026/07/summary.json");
 * ```
 */
export async function headObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<S3ObjectMetadata | undefined> {
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
      eTag: response.ETag,
      lastModified: response.LastModified,
    };
  } catch (cause) {
    if (cause instanceof M3LS3OperationError) throw cause;
    const name = (cause as { name?: string }).name;
    if (name === "NotFound") {
      return undefined;
    }
    throw new M3LS3OperationError("headObject failed", {
      cause,
      context: { bucket, key },
    });
  }
}

/** Result of {@link getObject}. */
export interface GetObjectResult {
  /** The object's full body. */
  readonly body: Uint8Array;
  /** The object's metadata. */
  readonly metadata: S3ObjectMetadata;
}

/**
 * Downloads an object's full body and metadata.
 *
 * @param client - A provisioned `s3` client.
 * @param bucket - Target bucket.
 * @param key - The object's key.
 * @throws {@link M3LS3OperationError} when the underlying `GetObjectCommand` rejects.
 * @example
 * ```ts
 * import { getObject } from "@m3l-automation/m3l-common/aws";
 *
 * const { body } = await getObject(client, "reports", "2026/07/summary.json");
 * ```
 */
export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<GetObjectResult> {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (response.Body === undefined) {
      throw new M3LS3OperationError("getObject: response has no Body", {
        context: { bucket, key },
      });
    }
    const body = await response.Body.transformToByteArray();
    return {
      body,
      metadata: {
        contentLength: response.ContentLength ?? 0,
        contentType: response.ContentType,
        eTag: response.ETag,
        lastModified: response.LastModified,
      },
    };
  } catch (cause) {
    if (cause instanceof M3LS3OperationError) throw cause;
    throw new M3LS3OperationError("getObject failed", {
      cause,
      context: { bucket, key },
    });
  }
}

/** Options for {@link putObject}. */
export interface PutObjectOptions {
  /** The object's content type (`Content-Type`). */
  readonly contentType?: string;
}

/**
 * Writes (creates or fully replaces) an object.
 *
 * @param client - A provisioned `s3` client.
 * @param bucket - Target bucket.
 * @param key - The object's key.
 * @param body - The object's content.
 * @param options - Optional write parameters.
 * @throws {@link M3LS3OperationError} when the underlying `PutObjectCommand` rejects.
 * @example
 * ```ts
 * import { putObject } from "@m3l-automation/m3l-common/aws";
 *
 * await putObject(client, "reports", "2026/07/summary.json", jsonBody, {
 *   contentType: "application/json",
 * });
 * ```
 */
export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array | string,
  options?: PutObjectOptions,
): Promise<void> {
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ...(options?.contentType !== undefined && {
          ContentType: options.contentType,
        }),
      }),
    );
  } catch (cause) {
    if (cause instanceof M3LS3OperationError) throw cause;
    throw new M3LS3OperationError("putObject failed", {
      cause,
      context: { bucket, key, contentType: options?.contentType },
    });
  }
}

/** The source object for {@link copyObject} — a bucket/key pair. */
export interface CopyObjectSource {
  /** Source bucket. */
  readonly bucket: string;
  /** Source key. */
  readonly key: string;
}

/**
 * Copies an object, within or across buckets.
 *
 * @param client - A provisioned `s3` client.
 * @param destinationBucket - Target bucket.
 * @param destinationKey - Target key.
 * @param source - The object to copy from.
 * @throws {@link M3LS3OperationError} when the underlying `CopyObjectCommand` rejects.
 * @example
 * ```ts
 * import { copyObject } from "@m3l-automation/m3l-common/aws";
 *
 * await copyObject(client, "archive", "2026/07/summary.json", {
 *   bucket: "reports",
 *   key: "2026/07/summary.json",
 * });
 * ```
 */
export async function copyObject(
  client: S3Client,
  destinationBucket: string,
  destinationKey: string,
  source: CopyObjectSource,
): Promise<void> {
  try {
    const copySource = `${source.bucket}/${source.key}`
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    await client.send(
      new CopyObjectCommand({
        Bucket: destinationBucket,
        Key: destinationKey,
        CopySource: copySource,
      }),
    );
  } catch (cause) {
    if (cause instanceof M3LS3OperationError) throw cause;
    throw new M3LS3OperationError("copyObject failed", {
      cause,
      context: { destinationBucket, destinationKey, source },
    });
  }
}

/**
 * Deletes a single object by key.
 *
 * @param client - A provisioned `s3` client.
 * @param bucket - Target bucket.
 * @param key - The object's key.
 * @throws {@link M3LS3OperationError} when the underlying `DeleteObjectCommand` rejects.
 * @example
 * ```ts
 * import { deleteObject } from "@m3l-automation/m3l-common/aws";
 *
 * await deleteObject(client, "reports", "2026/07/summary.json");
 * ```
 */
export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (cause) {
    if (cause instanceof M3LS3OperationError) throw cause;
    throw new M3LS3OperationError("deleteObject failed", {
      cause,
      context: { bucket, key },
    });
  }
}

/** One per-key failure reported by {@link deleteObjects}. */
export interface S3DeleteError {
  /** The key that failed to delete. */
  readonly key: string;
  /** The SDK-reported failure message. */
  readonly message: string;
}

/** Result of {@link deleteObjects}. */
export interface DeleteObjectsResult {
  /** Count of keys confirmed deleted. */
  readonly deleted: number;
  /** Per-key failures the SDK reported (the caller decides whether to retry). */
  readonly errors: readonly S3DeleteError[];
}

/**
 * Deletes up to 1000 objects in one `DeleteObjects` request (S3's own cap).
 *
 * Does **not** retry failed keys itself — same division of concerns as
 * `aws/dynamodb`'s `batchWriteItems`/`batchDeleteItems`: retry policy stays
 * the caller's concern via `Core.M3LRetryRunner`.
 *
 * @param client - A provisioned `s3` client.
 * @param bucket - Target bucket.
 * @param keys - At most 1000 keys (the S3 `DeleteObjects` cap).
 * @throws {@link M3LS3OperationError} when the underlying `DeleteObjectsCommand` rejects, or when `keys.length` exceeds 1000.
 * @example
 * ```ts
 * import { deleteObjects } from "@m3l-automation/m3l-common/aws";
 *
 * const { deleted, errors } = await deleteObjects(client, "reports", chunk);
 * ```
 */
export async function deleteObjects(
  client: S3Client,
  bucket: string,
  keys: readonly string[],
): Promise<DeleteObjectsResult> {
  if (keys.length > DELETE_OBJECTS_KEY_CAP) {
    throw new M3LS3OperationError(
      "deleteObjects: at most 1000 keys are allowed per batch",
      { context: { bucket, keyCount: keys.length } },
    );
  }
  if (keys.length === 0) {
    return { deleted: 0, errors: [] };
  }

  try {
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.map((key) => ({ Key: key })) },
      }),
    );
    return {
      deleted: response.Deleted?.length ?? 0,
      errors: (response.Errors ?? []).map((error) => ({
        key: error.Key ?? "",
        message: error.Message ?? "",
      })),
    };
  } catch (cause) {
    if (cause instanceof M3LS3OperationError) throw cause;
    throw new M3LS3OperationError("deleteObjects failed", {
      cause,
      context: { bucket, keyCount: keys.length },
    });
  }
}
