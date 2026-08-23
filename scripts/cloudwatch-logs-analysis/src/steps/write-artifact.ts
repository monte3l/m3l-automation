import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { Core } from "@m3l-automation/m3l-common";

/**
 * Writes one JSON artifact under `M3L_OUTPUT_DIR`, creating the destination
 * directory first.
 *
 * `Core.M3LJSONFileExporter` writes the file but does not create its parent,
 * and this script's documented workflow points `M3L_OUTPUT_DIR` at an
 * operator's **own** preset store rather than the repo's `data/output` tree
 * (which exists already). A missing directory would otherwise surface
 * mid-incident as a bare write failure instead of just working.
 *
 * @param paths - The run's `M3LPaths`, anchoring the output directory.
 * @param name - The artifact's path, relative to the output directory.
 * @param value - The JSON-serialisable value to write.
 * @returns A promise resolving once the file is on disk.
 * @throws {@link Core.M3LPathResolutionError} When `name` escapes the output
 *   directory — propagated unchanged.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { writeJsonArtifact } from "./write-artifact.js";
 *
 * await writeJsonArtifact(new Core.M3LPaths(), "verdict.json", { ok: true });
 * ```
 */
export async function writeJsonArtifact(
  paths: Core.M3LPaths,
  name: string,
  value: unknown,
): Promise<void> {
  const filePath = paths.resolveOutput(name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await new Core.M3LJSONFileExporter({ filePath }).export(value);
}
