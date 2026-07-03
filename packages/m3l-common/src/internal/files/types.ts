/**
 * `internal/files/types` — canonical shapes shared by `M3LFileCopier`'s
 * internal execution modules and its public barrel.
 *
 * This module intentionally imports nothing from `core/files` (or anywhere
 * else under `core/`) — it is the single source of truth for the
 * skip-reason union and the result/summary shapes, so both the internal
 * execution code and the public `core/files` re-exports resolve to the same
 * declaration rather than three hand-retyped copies drifting apart.
 *
 * @packageDocumentation
 */

/**
 * Why a queued file was skipped rather than copied. Defined once here and
 * re-exported publicly as `M3LFileCopySkipReason` from `core/files`.
 */
export type FileCopySkipReason =
  | "size-too-large"
  | "already-exists"
  | "source-unreadable"
  | "declined-by-prompt";

/**
 * The outcome of a single queued file, discriminated on `skipped`. Defined
 * once here and re-exported publicly as `M3LFileCopyResult` from
 * `core/files`.
 */
export type FileCopyOutcome =
  | {
      readonly skipped: false;
      readonly source: string;
      readonly destination: string;
      readonly size: number;
      readonly timestamp: string;
    }
  | {
      readonly skipped: true;
      readonly source: string;
      readonly destination: string;
      readonly reason: FileCopySkipReason;
      readonly timestamp: string;
    };

/**
 * The aggregate portion of a copy report. Defined once here and re-exported
 * publicly as `M3LFileCopyReportSummary` from `core/files`.
 */
export interface CopyReportSummary {
  readonly totalRegistered: number;
  readonly copied: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<FileCopySkipReason, number>>;
  readonly totalBytesCopied: number;
}

/**
 * The full report produced by a finalize run. Defined once here and
 * re-exported publicly as `M3LFileCopyReport` from `core/files`.
 */
export interface CopyReport {
  readonly results: readonly FileCopyOutcome[];
  readonly summary: CopyReportSummary;
}
