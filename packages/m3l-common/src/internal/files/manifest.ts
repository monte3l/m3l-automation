/**
 * `internal/files/manifest` — optional manifest JSON writer for
 * `M3LFileCopier`.
 *
 * @packageDocumentation
 */

import { writeFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * Writes `report` as JSON to `path.join(outputDir, manifestFileName)`.
 *
 * Any failure here is batch-fatal by contract (the manifest is the durable
 * record of what a run archived) — the caller wraps this in the shared
 * `M3LFileCopyError` catch alongside the rest of the copy lifecycle.
 */
export async function writeManifestFile(
  outputDir: string,
  manifestFileName: string,
  report: unknown,
): Promise<void> {
  const manifestPath = path.join(outputDir, manifestFileName);
  await writeFile(manifestPath, JSON.stringify(report));
}
