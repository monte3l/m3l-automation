/**
 * `internal/files/atomicWrite` — write-temp-then-rename primitive shared by
 * any future caller that needs a torn-write-proof file replace.
 *
 * Not re-exported from any public barrel: this is a low-level filesystem
 * primitive, error-hierarchy-agnostic on purpose (it throws whatever
 * `fsp.writeFile`/`fsp.rename` throw, unwrapped) so a caller maps the failure
 * into its own typed `M3LError` subclass. `M3LCheckpointStore.write()` is the
 * first consumer; the checkpoint contract doc notes this could eventually be
 * promoted into a public `core/files` guard if a second caller emerges.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Writes `contents` to `targetPath` atomically: `contents` is first written
 * to a uniquely-named temporary sibling file (same directory as
 * `targetPath`, so the subsequent `rename` is atomic on the same
 * filesystem), then renamed onto `targetPath`.
 *
 * Does **not** create `targetPath`'s parent directory — a missing parent
 * surfaces as `fsp.writeFile`'s own `ENOENT`. On any failure (the write or
 * the rename), the temp file is removed on a best-effort basis (a failing
 * cleanup never masks the original error) and the original error is
 * re-thrown unchanged — this function throws plain/errno errors, never a
 * library `M3LError`.
 *
 * @param targetPath - Absolute path of the file to replace.
 * @param contents - The full file contents to write.
 * @throws Whatever `fsp.writeFile` or `fsp.rename` throw (e.g. `ENOENT`,
 *   `EACCES`, `EPERM`), unwrapped.
 *
 * @example
 * ```ts
 * import { writeFileAtomic } from "./atomicWrite.js";
 *
 * await writeFileAtomic("/tmp/example/state.json", JSON.stringify({ n: 1 }));
 * ```
 */
export async function writeFileAtomic(
  targetPath: string,
  contents: string,
): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tempPath = path.join(dir, `.${base}.${randomUUID()}.tmp`);

  try {
    await fsp.writeFile(tempPath, contents, "utf8");
    await fsp.rename(tempPath, targetPath);
  } catch (error) {
    // Best-effort cleanup: a failure removing the temp file must never
    // shadow the real error that triggered this catch block.
    try {
      await fsp.rm(tempPath, { force: true });
    } catch {
      /* ignore — the original error below is what matters */
    }
    throw error;
  }
}
