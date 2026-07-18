import { AWS, Core } from "@m3l-automation/m3l-common";

/**
 * `list`: paginated `AWS.listObjects`, streaming every `S3ObjectSummary` from
 * every page to `output` as JSONL (`Core.M3LJSONListExporter`, format
 * `"jsonl"`) — matches the fleet's existing scan/query streaming pattern in
 * `dynamodb-crud`. `processed` counts every object summary listed across
 * every page. An `AWS.listObjects` rejection is already a typed
 * `AWS.M3LS3OperationError`; this step neither catches nor re-wraps it.
 */

/** The run summary `runListObjects` reports: objects listed. */
export interface RunListObjectsSummary {
  /** Total object summaries listed across every page. */
  readonly processed: number;
}

/**
 * Lists every object in `bucket` (optionally restricted to `prefix`),
 * streaming each `S3ObjectSummary` to `outputPath` as JSONL.
 *
 * @param deps - Injected dependencies: the provisioned `s3` client, the
 *   target bucket, optional `prefix`/`pageSize`, the resolved output file
 *   path, and a logger.
 * @returns The run summary — total objects listed.
 * @throws {@link AWS.M3LS3OperationError} when the underlying
 *   `AWS.listObjects` call rejects (propagated unmodified).
 * @throws {@link Core.M3LError} coded `ERR_S3_OBJECTS_OUTPUT` when writing
 *   `outputPath` fails.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runListObjects } from "./list-objects.js";
 *
 * const summary = await runListObjects({
 *   client: script.aws?.clients.s3,
 *   bucket: "reports",
 *   outputPath: "listing.jsonl",
 *   logger: new Core.M3LLogger([]),
 * });
 * console.log(summary.processed);
 * ```
 */
export async function runListObjects(deps: {
  readonly client: Parameters<typeof AWS.listObjects>[0];
  readonly bucket: string;
  readonly prefix?: string;
  readonly pageSize?: number;
  readonly outputPath: string;
  readonly logger: Core.M3LLogger;
}): Promise<RunListObjectsSummary> {
  const exporter = new Core.M3LJSONListExporter<AWS.S3ObjectSummary>({
    filePath: deps.outputPath,
    format: "jsonl",
  });
  const writer = exporter.exportStream();

  let processed = 0;
  let closed = false;
  try {
    // `AWS.ListObjectsOptions` declares `prefix?: string` (no explicit
    // `| undefined`), so under `exactOptionalPropertyTypes` a literal
    // `{ prefix: deps.prefix }` (deps.prefix: string | undefined) can't be
    // assigned directly — cast the always-both-keys-present object (matching
    // what a plain options pass-through looks like) rather than conditionally
    // omitting keys, which would change the object's own identity/shape.
    const options = {
      prefix: deps.prefix,
      pageSize: deps.pageSize,
    } as AWS.ListObjectsOptions;
    for await (const page of AWS.listObjects(
      deps.client,
      deps.bucket,
      options,
      undefined,
    )) {
      for (const object of page.objects) {
        await writer.append(object);
        processed += 1;
      }
    }
    await writer.close();
    closed = true;
  } catch (cause) {
    // Best-effort cleanup only: a second close() failure here must not mask
    // the primary listing/append failure being re-thrown below.
    if (!closed) {
      try {
        await writer.close();
      } catch (closeError) {
        deps.logger.warning("output close after failure also failed", {
          cause: closeError,
        });
      }
    }
    if (cause instanceof AWS.M3LS3OperationError) throw cause;
    if (cause instanceof Core.M3LError) throw cause;
    throw new Core.M3LError(`failed writing '${deps.outputPath}'`, {
      code: "ERR_S3_OBJECTS_OUTPUT",
      cause,
    });
  }

  return { processed };
}
