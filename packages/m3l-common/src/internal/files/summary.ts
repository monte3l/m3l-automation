/**
 * `internal/files/summary` — aggregate summary builder for `M3LFileCopier`.
 *
 * @packageDocumentation
 */

import type { CopyReportSummary, FileCopyOutcome } from "./types.js";

/**
 * Reduces a batch of per-file {@link FileCopyOutcome} results into a
 * {@link CopyReportSummary}. All four skip-reason keys are always present
 * (zeroed when unused) so callers can safely index any reason without an
 * `undefined` check.
 */
export function buildSummary(
  results: readonly FileCopyOutcome[],
): CopyReportSummary {
  const skippedByReason = {
    "size-too-large": 0,
    "already-exists": 0,
    "source-unreadable": 0,
    "declined-by-prompt": 0,
  };
  let copied = 0;
  let totalBytesCopied = 0;

  for (const result of results) {
    if (result.skipped) {
      skippedByReason[result.reason] += 1;
    } else {
      copied += 1;
      totalBytesCopied += result.size;
    }
  }

  const skipped = results.length - copied;

  return {
    totalRegistered: results.length,
    copied,
    skipped,
    skippedByReason,
    totalBytesCopied,
  };
}
