/**
 * `internal/files/subdirs` — default subdirectory naming for each
 * `M3LPathType` (see `core/utils/M3LPaths`).
 *
 * Kept as a plain lookup table so adding a new `M3LPathType` member forces a
 * compile-time update here — `Record<M3LPathType, string>` requires every
 * union member to have an entry, so an omission is a compile error rather
 * than a silent fall-through. Deliberately imports nothing from
 * `core/files` — `getDefaultSubdirForPathType` (in `core/files`) imports
 * this module, so an import in the other direction would create a cycle.
 *
 * @packageDocumentation
 */

import type { M3LPathType } from "../../core/utils/index.js";

/**
 * The conventional subdirectory name for each {@link M3LPathType}. Typed as
 * `Record<M3LPathType, string>` so the closed 5-member union is the
 * exhaustiveness guard: adding a new `M3LPathType` member without adding its
 * entry here is a compile-time error.
 */
const DEFAULT_SUBDIR_BY_PATH_TYPE: Readonly<Record<M3LPathType, string>> = {
  data: "data",
  config: "configs",
  input: "inputs",
  output: "outputs",
  cache: "cache",
};

/**
 * Maps an {@link M3LPathType} to the conventional subdirectory name used to
 * group archived files of that kind under the copier's output directory.
 */
export function defaultSubdirFor(pathType: M3LPathType): string {
  return DEFAULT_SUBDIR_BY_PATH_TYPE[pathType];
}
