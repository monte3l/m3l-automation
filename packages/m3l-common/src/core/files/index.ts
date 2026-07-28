/**
 * `core/files` — execution-directory file archival.
 *
 * Register files during a run, then finalize them into the output directory
 * with a per-file report and overall summary; also read an input file back as
 * raw text or parsed/validated JSON. Surfaces exactly the documented public
 * API: {@link M3LFileCopier}, its options and defaults, the
 * report/result/summary types, the skip-reason union, the
 * `getDefaultSubdirForPathType` helper, {@link M3LFileCopyError},
 * {@link M3LInputFileReader}, and its options.
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
export { M3LInputFileReader } from "./M3LInputFileReader.js";
export type { M3LInputFileReaderOptions } from "./M3LInputFileReader.js";
