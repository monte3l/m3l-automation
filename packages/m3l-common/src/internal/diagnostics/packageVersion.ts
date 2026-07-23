/**
 * `internal/diagnostics/packageVersion` — reads the package's own declared
 * version for use in diagnostic output (e.g. a run report's environment
 * snapshot).
 *
 * Private: not re-exported through any public barrel. Consumers reach this
 * indirectly, through whatever public diagnostics symbol embeds the version.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Memoized result of the first {@link readPackageVersion} call. `undefined`
 * until that first call runs; never re-computed afterward.
 */
let cachedVersion: string | undefined;

/**
 * Reads `packages/m3l-common/package.json`'s `version` field relative to
 * this module's own location.
 *
 * The `../../../package.json` traversal is load-bearing: this file sits
 * exactly three directories below the package root in both the source tree
 * (`src/internal/diagnostics/`) and the compiled tree (`dist/internal/diagnostics/`,
 * since `rootDir`/`outDir` mirror `src`/`dist` 1:1), so the same relative
 * path resolves correctly whether this module runs from source (Vitest) or
 * from `dist/` (a built consumer).
 */
function computeVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(
      new URL("../../../package.json", import.meta.url),
    );
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) return "unknown";
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === "string" && version.length > 0
      ? version
      : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Returns the version declared in `packages/m3l-common/package.json`.
 *
 * Lazy and memoized: the file is read only on the first call (never at
 * module load, preserving the no-top-level-side-effects rule), and every
 * subsequent call returns the identical cached string. Never throws — any
 * read/parse failure (missing file, malformed JSON, missing/non-string
 * `version` field) yields the sentinel `"unknown"` rather than propagating.
 *
 * @returns The declared package version, or `"unknown"` on any failure.
 *
 * @example
 * ```ts
 * // Internal-only: illustrative shape, not part of the public API.
 * const version = readPackageVersion();
 * console.log(`m3l-common ${version}`);
 * ```
 */
export function readPackageVersion(): string {
  cachedVersion ??= computeVersion();
  return cachedVersion;
}
