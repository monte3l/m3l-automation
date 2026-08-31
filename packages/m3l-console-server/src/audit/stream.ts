/**
 * `audit/stream` — {@link createHumanActionAuditStream}, the file-backed
 * {@link M3LHumanActionAuditPort} (X7, slice 3, ADR-0070).
 *
 * A thin adapter over `Core.M3LAppendOnlyStream`: the segmented JSONL
 * format, its rotation, the `O_APPEND` write and the entry projection all
 * belong to that Core primitive. What this module adds is the console's own
 * two guarantees — every record is rebuilt as a detached copy before it is
 * handed over (`projectHumanActionRecord`), and a failed append becomes a
 * loud refusal rather than a silently missing line.
 *
 * That refusal is classified, not collapsed: a trail the filesystem will not
 * accept raises `ERR_CONSOLE_AUDIT_WRITE_FAILED` (retryable), while a record
 * the stream cannot represent raises `ERR_CONSOLE_AUDIT_RECORD_INVALID`
 * (caller fault, no retry will fix it). Core keeps the two apart on purpose
 * (`M3LAppendOnlyStream.ts:393-397`); folding them into one code would tell
 * an operator the filesystem is unhealthy when the argument was.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";
import type { M3LHumanActionAuditPort } from "./port.js";
import type { M3LHumanActionRecord } from "./record.js";
import { projectHumanActionRecord } from "./record.js";

/**
 * The failure message every refused append raises.
 *
 * Fixed text, never derived from the record: the record carries an
 * operator's name, a correlation id and parameter names, and an error
 * message travels further (logs, responses, tickets) than the audit segment
 * it describes. The `cause` carries the underlying diagnostic.
 */
const WRITE_FAILED_MESSAGE =
  "failed to append a human-action audit entry to the audit stream";

/**
 * The failure message every refused RECORD raises.
 *
 * Fixed text for the same reason as {@link WRITE_FAILED_MESSAGE}: the
 * offending value is exactly the caller data that must not travel. The
 * `cause` — Core's own `ERR_INVALID_ARGUMENT`, whose `context` names the
 * field and the violation — carries the diagnostic.
 */
const RECORD_INVALID_MESSAGE =
  "refused a human-action audit entry the audit stream cannot represent";

/**
 * Core's caller-fault code, raised by `M3LAppendOnlyStream` when the ENTRY is
 * malformed rather than the destination unwritable.
 */
const CORE_INVALID_ARGUMENT_CODE = "ERR_INVALID_ARGUMENT";

/**
 * Classifies a failure raised while projecting or appending a record.
 *
 * Core signals a bad argument as a plain `M3LError` carrying
 * `ERR_INVALID_ARGUMENT` and reserves `M3LAppendOnlyStreamError` for a
 * genuinely unhealthy destination, so the code — not the class — is the
 * discriminator.
 */
function isRefusedRecord(cause: unknown): boolean {
  return (
    cause instanceof Core.M3LError && cause.code === CORE_INVALID_ARGUMENT_CODE
  );
}

/**
 * Options for {@link createHumanActionAuditStream}.
 *
 * @example
 * ```ts
 * const options: CreateHumanActionAuditStreamOptions = {
 *   directory: "/var/lib/m3l/console/audit",
 * };
 * ```
 */
export interface CreateHumanActionAuditStreamOptions {
  /**
   * The directory the segments live in, typically from
   * `resolveAuditStreamRoot`. Created on the first append, not here.
   */
  readonly directory: string;
}

/**
 * Creates a {@link M3LHumanActionAuditPort} backed by an append-only
 * segmented JSONL stream under `options.directory`.
 *
 * The directory is validated immediately (by `Core.M3LAppendOnlyStream`'s
 * own constructor) but not touched: nothing reaches the filesystem until the
 * first `record`. A rejected append is wrapped with the Core failure chained
 * as `cause`, under `ERR_CONSOLE_AUDIT_RECORD_INVALID` when the RECORD was
 * refused and `ERR_CONSOLE_AUDIT_WRITE_FAILED` when the TRAIL was unwritable;
 * the port stays usable afterwards, so a trail that becomes writable again
 * resumes without being recreated.
 *
 * @param options - See {@link CreateHumanActionAuditStreamOptions}.
 * @returns A fresh port writing into `options.directory`.
 * @throws {@link Core.M3LError} `ERR_INVALID_ARGUMENT` — when `directory` is
 * blank or otherwise unusable.
 *
 * @example
 * ```ts
 * import { createHumanActionAuditStream } from "./audit/stream.js";
 *
 * const port = createHumanActionAuditStream({
 *   directory: resolveAuditStreamRoot(),
 * });
 * await port.record(record);
 * ```
 */
export function createHumanActionAuditStream(
  options: CreateHumanActionAuditStreamOptions,
): M3LHumanActionAuditPort {
  const stream = new Core.M3LAppendOnlyStream({
    directory: options.directory,
  });

  return {
    async record(record: M3LHumanActionRecord): Promise<void> {
      try {
        // Projection is inside the guarded region on purpose: a record the
        // projection itself refuses is the same caller fault a rejected
        // append reports, and both must reach the caller classified.
        await stream.append(projectHumanActionRecord(record));
      } catch (cause) {
        if (cause instanceof M3LConsoleError) throw cause;
        const refusedRecord = isRefusedRecord(cause);
        throw new M3LConsoleError(
          refusedRecord
            ? "ERR_CONSOLE_AUDIT_RECORD_INVALID"
            : "ERR_CONSOLE_AUDIT_WRITE_FAILED",
          refusedRecord ? RECORD_INVALID_MESSAGE : WRITE_FAILED_MESSAGE,
          { cause },
        );
      }
    },
  };
}
