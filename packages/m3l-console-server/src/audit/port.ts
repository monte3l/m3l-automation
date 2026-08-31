/**
 * `audit/port` — {@link M3LHumanActionAuditPort}, the seam every
 * operator-initiated action is recorded through (X7, slice 3, ADR-0070).
 *
 * Deliberately the inverse of `runs/audit.ts`'s run-lifecycle sink, whose
 * `record` returns `void` and never throws: that sink observes machine
 * transitions and must not become a launch failure mode. This one records
 * what a HUMAN asked for, so an action that cannot be audited is refused —
 * `record` is async and REJECTS on failure, and its caller is expected to
 * let that rejection fail the request.
 *
 * @packageDocumentation
 */

import type { M3LHumanActionRecord } from "./record.js";

/**
 * The human-action audit port.
 *
 * @example
 * ```ts
 * async function audit(
 *   port: M3LHumanActionAuditPort,
 *   record: M3LHumanActionRecord,
 * ): Promise<void> {
 *   // A rejection here fails the action it audits — that is the point.
 *   await port.record(record);
 * }
 * ```
 */
export interface M3LHumanActionAuditPort {
  /**
   * Records `record` durably.
   *
   * @param record - The entry to persist.
   * @returns A promise that resolves once the entry has been written.
   * @throws {@link "../errors/console-error.js".M3LConsoleError}
   * `ERR_CONSOLE_AUDIT_RECORD_INVALID` when `record` is malformed — a
   * container or field the record type forbids, a non-scalar `detail`, a
   * non-finite or `-0` number, an ADR-0068 `inline` reference, or a forged
   * truncation marker. Detected before any filesystem contact; the action was
   * never attempted and no retry will help. Caller fault — maps to a
   * non-retryable 400.
   * @throws {@link "../errors/console-error.js".M3LConsoleError}
   * `ERR_CONSOLE_AUDIT_WRITE_FAILED` when the record is valid but the trail
   * could not be appended to. The action was never attempted; a later attempt
   * may succeed once the trail is writable again. Maps to a retryable 503.
   */
  record(record: M3LHumanActionRecord): Promise<void>;
}
