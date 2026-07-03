/**
 * `core/files/getDefaultSubdirForPathType` — maps a path type to its default
 * archival subdirectory.
 *
 * @packageDocumentation
 */

import { defaultSubdirFor } from "../../internal/files/subdirs.js";
import type { M3LPathType } from "../utils/index.js";

/**
 * Returns the conventional subdirectory name used to group archived files of
 * `pathType` under {@link M3LFileCopier}'s output directory.
 *
 * @param pathType - The {@link M3LPathType} to map.
 * @returns The default subdirectory name, e.g. `"inputs"` for `"input"`.
 *
 * @example
 * ```ts
 * import { getDefaultSubdirForPathType } from "@m3l-automation/m3l-common/core";
 *
 * const subdir = getDefaultSubdirForPathType("input"); // "inputs"
 * ```
 */
export function getDefaultSubdirForPathType(pathType: M3LPathType): string {
  return defaultSubdirFor(pathType);
}
