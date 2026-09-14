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
 * and a delete added here would break two different rules for two different
 * reasons — the same two forces `docs/reference/console.md`'s "The two
 * rules" section names for the manual archival procedure, and worth keeping
 * straight rather than conflating. **Mechanically**,
 * `internal/storage/append-only-read-plan.ts`'s `assertNoSequenceGap` rejects
 * a gap in a date's sequence numbers — but since ADR-0102 the reader walks
 * the union of the segments on disk and the ones the manifest seals, so a
 * hole the manifest accounts for is not a gap at all, wherever in the date it
 * falls. A hole nothing accounts for still throws exactly as it always did,
 * and permanently — there is no claim left to weigh the absence against.
 * This driver could never tell which case a delete of its own would land in:
 * it only calls `listSegments()`, never `verify()` or the manifest itself.
 * **By policy**, ADR-0070 sanctions whole-date archival and nothing
 * narrower, and ADR-0102 kept that boundary deliberately even though sealing
 * makes the narrower operation mechanically safe — what the manifest
 * establishes is that the bytes are the sealed bytes, not that anyone was
 * entitled to move them. `boot/audit-rebuild.ts`'s rebuild still never
 * throws — a console whose trail it can no longer rebuild from still starts
 * and serves normally — but that is no longer the same as silent: the boot
 * path reports the cause at `error`, choosing a manifest-specific message
 * over the general one when a `Core.M3LAppendOnlyStreamManifestError`
 * appears anywhere in the cause chain, and it logs one `error` per segment
 * the manifest seals but the trail no longer holds. Do not "harmonise" this
 * driver with its siblings by adding deletion; that would reintroduce
 * exactly the damage this module exists to avoid.
 *
 * **This report is the signal that archival is due.** A growing `totalBytes`
 * is not itself actionable from inside this module — the procedure it
 * triggers is `docs/reference/console.md`'s "Archiving the audit trail"
 * section, including what ADR-0102 changed about it being provable. This
 * driver's own posture is unaffected either way: it neither reads nor writes
 * `manifest.jsonl`, and it stays inventory-only — it only counts the segment
 * files `listSegments()` hands back.
 *
 * **A non-zero `skipped` count is worth investigating, but is not proof of
 * tampering by itself — it has two possible causes.** The first is a symlink
 * (or directory/FIFO/etc.) planted at a segment-shaped name:
 * `Core.M3LAppendOnlyStream.listSegments()` uses `lstat` plus a regular-file
 * check, so it refuses to follow one, and that entry is excluded from
 * `segments`/`totalBytes` and counted in `skipped` instead. This closes a
 * disclosure: a symlink at a segment name used to report its *target's*
 * size, leaking the byte count of a file outside the audit root into the
 * total; it can no longer inflate `totalBytes` that way. This first cause
 * IS tampering. The second is an entry vanishing mid-listing because an
 * operator archived whole dates out of band — the supported way to reclaim
 * space under ADR-0070's segment-and-retain class — which can legitimately
 * race a sweep and is not tampering. A non-zero count is a prompt to look,
 * not a verdict.
 *
 * @packageDocumentation
 */

import { Core } from "@monte3l/m3l-common";

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
  /**
   * The combined byte size of every segment file — and ONLY segment files.
   * `listSegments()` does not treat `manifest.jsonl` as a segment (it never
   * appears in `segments`, never raises `skipped`), so its bytes never enter
   * this total. An operator comparing this number against `du` on the audit
   * root will therefore see a difference once the writer has sealed at least
   * one segment, and the sidecar is that difference: it gains roughly one
   * line per sealed segment plus one fixed baseline line, an order of
   * magnitude of a couple hundred bytes per line for the manifest's current
   * record shape (observed, not a guaranteed size), and it is itself never
   * rotated — so the gap grows with the *segment count*, not with the
   * trail's byte size. That is negligible against the default 8 MiB segment
   * ceiling, but it is not zero, and a caller reconciling this field against
   * on-disk usage should expect it.
   */
  readonly totalBytes: number;
  /**
   * Directory entries carrying a valid segment name that could not be
   * inventoried — one vanished mid-listing (an operator archiving whole
   * dates out of band, which can legitimately race a sweep and is not
   * tampering), or a non-regular file (symlink, directory, FIFO, etc.)
   * planted at a segment-shaped name, which IS tampering. A non-zero count
   * is a prompt to look, not proof of tampering by itself.
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
 * `totalBytes` counts segment files only — see
 * {@link M3LAuditTrailUsageOutcome.totalBytes} for why it reads lower than
 * `du` on the same directory.
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
