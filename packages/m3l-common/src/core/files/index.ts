/**
 * `core/files` — execution-directory file archival.
 *
 * Register files during a run, then finalize them into the output directory
 * with a per-file report and overall summary. Surfaces exactly the
 * documented public API: {@link M3LFileCopier}, its options and defaults,
 * the report/result/summary types, the skip-reason union, the
 * `getDefaultSubdirForPathType` helper, and {@link M3LFileCopyError}.
 *
 * @packageDocumentation
 */

export { getDefaultSubdirForPathType } from "./getDefaultSubdirForPathType.js";
export { M3L_FILE_COPIER_DEFAULTS, M3LFileCopier } from "./M3LFileCopier.js";
export type {
  M3LFileCopierOptions,
  M3LFileCopyReport,
  M3LFileCopyReportSummary,
  M3LFileCopyResult,
  M3LFileCopySkipReason,
} from "./M3LFileCopier.js";
export { M3LFileCopyError } from "./M3LFileCopyError.js";
