/**
 * `aws/s3/uri` — parse and format `s3://bucket/key` URIs.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";

/** A parsed `s3://` URI: bucket and key. */
export interface M3LS3Uri {
  /** The bucket name — the URI segment between `s3://` and the first `/`. */
  readonly bucket: string;
  /** The object key — everything after the bucket's `/`. */
  readonly key: string;
}

const S3_URI_PATTERN = /^s3:\/\/([^/]+)\/(.+)$/;

/**
 * Upper bound on how much of a caller-supplied value is echoed into a thrown
 * error's `message`/`context` — keeps a pathological input from bloating a
 * persisted run-report artifact (which embeds both fields).
 */
const MAX_ECHOED_VALUE_LENGTH = 200;

/**
 * Truncates `value` to {@link MAX_ECHOED_VALUE_LENGTH} characters for safe
 * embedding in a thrown error. Local to this module rather than reusing
 * `core/utils/formatting.ts`'s `truncateText` — ADR-0009 restricts `aws/*`
 * imports to `core/errors`/`core/prompt`/`core/polling` only, and a single
 * fixed-length truncate isn't worth widening that zone for.
 */
function truncateForError(value: string): string {
  if (value.length <= MAX_ECHOED_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_ECHOED_VALUE_LENGTH - 1)}…`;
}

/**
 * Parses an `s3://bucket/key` URI into its bucket and key.
 *
 * @param uri - The URI to parse.
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `uri`
 *   does not match the `s3://bucket/key` shape — wrong/missing scheme, an
 *   empty bucket, or a missing/empty key. The offending value is truncated
 *   to {@link MAX_ECHOED_VALUE_LENGTH} characters in the thrown error.
 * @example
 * ```ts
 * import { parseS3Uri } from "@m3l-automation/m3l-common/aws";
 *
 * parseS3Uri("s3://reports/2026/07/summary.json");
 * // { bucket: "reports", key: "2026/07/summary.json" }
 * ```
 */
export function parseS3Uri(uri: string): M3LS3Uri {
  const match = S3_URI_PATTERN.exec(uri);
  if (match === null) {
    const truncated = truncateForError(uri);
    throw new M3LError(
      `parseS3Uri: "${truncated}" is not a valid s3://bucket/key URI`,
      { code: "ERR_INVALID_ARGUMENT", context: { uri: truncated } },
    );
  }
  // match[1]/match[2] are safe: the pattern has exactly two non-optional
  // capture groups, so a non-null match always includes both.
  const bucket = match[1] as string;
  const key = match[2] as string;
  return { bucket, key };
}

/**
 * Formats a bucket/key pair back into an `s3://bucket/key` URI.
 *
 * True inverse of {@link parseS3Uri} only for well-formed pairs: throws
 * {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `bucket` is
 * empty or contains `/`, or when `key` is empty — the same shape
 * {@link parseS3Uri} already guarantees on its own output, so a caller who
 * hand-constructs an {@link M3LS3Uri} gets the same validation a value
 * produced by `parseS3Uri` would already satisfy.
 *
 * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` — see above.
 * @example
 * ```ts
 * import { formatS3Uri } from "@m3l-automation/m3l-common/aws";
 *
 * formatS3Uri({ bucket: "reports", key: "2026/07/summary.json" });
 * // "s3://reports/2026/07/summary.json"
 * ```
 */
export function formatS3Uri(uri: M3LS3Uri): string {
  const { bucket, key } = uri;
  if (bucket.length === 0 || bucket.includes("/") || key.length === 0) {
    const truncatedBucket = truncateForError(bucket);
    const truncatedKey = truncateForError(key);
    throw new M3LError(
      `formatS3Uri: bucket ${JSON.stringify(truncatedBucket)} / key ${JSON.stringify(truncatedKey)} is not a valid s3://bucket/key pair — bucket must be non-empty with no "/"; key must be non-empty`,
      {
        code: "ERR_INVALID_ARGUMENT",
        context: { bucket: truncatedBucket, key: truncatedKey },
      },
    );
  }
  return `s3://${bucket}/${key}`;
}
