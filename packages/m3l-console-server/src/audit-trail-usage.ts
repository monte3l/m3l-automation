/**
 * `audit-trail-usage` — {@link reportAuditTrailUsage}, the X8 fourth
 * retention-sweep driver (ADR-0070 slice 5c continuation): audit-trail
 * OBSERVATION, not retention.
 *
 * This module is deliberately zone-free: it sits directly under `src/`, like
 * `main.ts`, `telemetry-retention.ts`, `run-output-retention.ts`, and
 * `session-artifact-retention.ts`, rather than inside `audit/`
 * (`bin/check-eslint-zones.mjs`'s zone rule). `audit/` may import only
 * `audit` and `errors`, but this driver is wired from `cleanup.ts` alongside
 * `config/paths.ts`'s `resolveAuditStreamRoot` — an import combination no
 * single zone directory is allowed to make.
 *
 * **This driver deletes nothing, truncates nothing, creates nothing.**
 * Unlike its three sibling retention drivers (`telemetry-retention.ts`,
 * `run-output-retention.ts`, `session-artifact-retention.ts`), this is the
 * one section of the cleanup sweep that does not sweep — it only
 * inventories. ADR-0070 declares the audit-trail class as segment-and-retain,
 * and `internal/storage/append-only-reader.ts`'s `assertNoSequenceGap` makes
 * intra-date deletion destroy the trail's readability rather than reclaim
 * space — while `boot/audit-rebuild.ts`'s rebuild never throws, so that
 * damage would be invisible at boot. Do not "harmonise" this driver with its
 * siblings by adding deletion; that would reintroduce exactly the damage this
 * module exists to avoid.
 *
 * **A non-zero `skipped` count means the audit directory is not what this
 * console wrote.** `Core.M3LAppendOnlyStream.listSegments()` uses `lstat`
 * plus a regular-file check, so it refuses to follow a symlink (or inventory
 * a directory/FIFO/etc.) planted at a segment-shaped name — such an entry is
 * excluded from `segments`/`totalBytes` and counted in `skipped` instead.
 * This closes a disclosure: a symlink at a segment name used to report its
 * *target's* size, leaking the byte count of a file outside the audit root
 * into the total; it can no longer inflate `totalBytes` that way.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "./errors/console-error.js";

/**
 * The result of one {@link reportAuditTrailUsage} run: how many audit-stream
 * segment files exist on disk, their combined byte size, and how many
 * segment-shaped entries could not be inventoried.
 *
 * @example
 * ```ts
 * function describe(outcome: M3LAuditTrailUsageOutcome): string {
 *   return `${String(outcome.segments)} segments, ${String(outcome.totalBytes)} bytes, ${String(outcome.skipped)} skipped`;
 * }
 * ```
 */
export interface M3LAuditTrailUsageOutcome {
  /** The number of audit-stream segment files found on disk. */
  readonly segments: number;
  /** The combined byte size of every segment file. */
  readonly totalBytes: number;
  /**
   * Directory entries carrying a valid segment name that could not be
   * inventoried — one vanished mid-listing, or a non-regular file planted at
   * a segment name. Non-zero means the trail is not what this console wrote.
   */
  readonly skipped: number;
}

/**
 * Options for {@link reportAuditTrailUsage}.
 *
 * @example
 * ```ts
 * const options: ReportAuditTrailUsageOptions = {
 *   auditRoot: "/var/lib/m3l/console/audit",
 * };
 * ```
 */
export interface ReportAuditTrailUsageOptions {
  /**
   * The audit stream's root directory, typically resolved via
   * `resolveAuditStreamRoot` (`config/paths.ts`).
   */
  readonly auditRoot: string;
}

/**
 * Inventories `options.auditRoot`'s `Core.M3LAppendOnlyStream` segments and
 * reports a count and combined byte size — never deletes, truncates, or
 * creates anything on disk.
 *
 * A missing `auditRoot` (never created yet, or already empty) is reported as
 * `{ segments: 0, totalBytes: 0 }` rather than an error — `listSegments()`
 * itself treats a missing directory this way, and there is nothing else to
 * distinguish here since this driver has no `rootExisted`-style flag: unlike
 * the retention drivers, an absent audit root is not an operator
 * misconfiguration signal this report needs to surface.
 *
 * @param options - See {@link ReportAuditTrailUsageOptions}.
 * @returns The {@link M3LAuditTrailUsageOutcome}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` when
 *   listing the audit root's segments fails for a reason other than it not
 *   existing. Carries the caught value as `cause`; no `context` is attached
 *   — the only thing worth naming is `auditRoot` itself, an absolute path,
 *   and the sibling retention modules all hold the line that `context` never
 *   carries one.
 *
 * @example
 * ```ts
 * import { reportAuditTrailUsage } from "@m3l-automation/m3l-console-server/audit-trail-usage";
 *
 * const outcome = await reportAuditTrailUsage({
 *   auditRoot: "/var/lib/m3l/console/audit",
 * });
 * console.log(`${String(outcome.segments)} segments, ${String(outcome.totalBytes)} bytes, ${String(outcome.skipped)} skipped`);
 * ```
 */
export async function reportAuditTrailUsage(
  options: ReportAuditTrailUsageOptions,
): Promise<M3LAuditTrailUsageOutcome> {
  const stream = new Core.M3LAppendOnlyStream({
    directory: options.auditRoot,
  });

  let segments: readonly Core.M3LAppendOnlySegment[];
  let skipped: number;
  try {
    const listing = await stream.listSegments();
    segments = listing.segments;
    skipped = listing.skipped;
  } catch (cause) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "failed to list audit-trail segments",
      { cause },
    );
  }

  return {
    segments: segments.length,
    totalBytes: segments.reduce((sum, segment) => sum + segment.byteLength, 0),
    skipped,
  };
}
