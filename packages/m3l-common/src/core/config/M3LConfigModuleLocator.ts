/**
 * `core/config/M3LConfigModuleLocator` — dist-first resolution of the
 * on-disk module a script's `configParameters` export should be loaded
 * from.
 *
 * @packageDocumentation
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { M3LError } from "../errors/index.js";

/**
 * Where a script's config module was resolved from. Not exported: nothing
 * outside this module needs to reference the string-literal union by name —
 * only through {@link M3LConfigModuleLocation.source}, which is.
 */
type M3LConfigModuleSource = "dist" | "src";

/** The resolved config module's absolute path and origin. */
export interface M3LConfigModuleLocation {
  /** The absolute path to the resolved config module. */
  readonly path: string;
  /** Whether the resolved module came from `dist/` or `src/`. */
  readonly source: M3LConfigModuleSource;
}

/**
 * Resolves the config module a script's `configParameters` export should be
 * loaded from, preferring the compiled `dist/config.js` over the
 * type-stripped `src/config.ts` whenever the compiled output is at least as
 * fresh (its mtime is `>=` the source's). A stale `dist/` therefore loses to
 * `src/`, so an edit that has not been rebuilt is still introspected
 * correctly.
 *
 * @param scriptDirectory - The script's root directory.
 * @returns The resolved module's path and source.
 * @throws {@link M3LError} with code `ERR_CONFIG_MODULE_NOT_FOUND` when
 *   neither `dist/config.js` nor `src/config.ts` exists.
 *
 * @example
 * ```ts
 * import { resolveConfigModulePath } from "@m3l-automation/m3l-common/core";
 *
 * const { path, source } = resolveConfigModulePath("/repo/scripts/foo");
 * // { path: "/repo/scripts/foo/dist/config.js", source: "dist" }
 * ```
 */
export function resolveConfigModulePath(
  scriptDirectory: string,
): M3LConfigModuleLocation {
  const distPath = join(scriptDirectory, "dist", "config.js");
  const srcPath = join(scriptDirectory, "src", "config.ts");

  const distExists = existsSync(distPath);
  const srcExists = existsSync(srcPath);

  if (
    distExists &&
    (!srcExists || statSync(distPath).mtimeMs >= statSync(srcPath).mtimeMs)
  ) {
    return { path: distPath, source: "dist" };
  }

  if (srcExists) {
    return { path: srcPath, source: "src" };
  }

  throw new M3LError(
    `no config module found for script at '${scriptDirectory}' (checked dist/config.js and src/config.ts)`,
    { code: "ERR_CONFIG_MODULE_NOT_FOUND" },
  );
}
