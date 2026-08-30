/**
 * `core/agent/decision-log` — `M3LAgentDecisionLog`, the append-only
 * segmented writer for the ADR-0061 decision log (V7 slice 2).
 *
 * @packageDocumentation
 */

import path from "node:path";

import { AgentDecisionLogWriter } from "../../internal/agent/decision-log-writer.js";
import { M3LPaths } from "../utils/M3LPaths.js";
import type { M3LAgentDecisionLogEntry } from "./decision-log-types.js";

/**
 * The default rotation ceiling on one segment's size, in bytes: 8 MiB.
 *
 * @remarks
 * Caller-overridable via {@link M3LAgentDecisionLogOptions.maxSegmentBytes}.
 * A segment already at or past this ceiling when the next `write()` arrives
 * is sealed and a new one opened before that entry is appended — rotation
 * never happens mid-write, so a sealed segment is never truncated or torn.
 *
 * @example
 * ```ts
 * import { M3L_AGENT_LOG_MAX_SEGMENT_BYTES } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_AGENT_LOG_MAX_SEGMENT_BYTES); // 8388608
 * ```
 */
export const M3L_AGENT_LOG_MAX_SEGMENT_BYTES = 8_388_608;

/**
 * The default rotation ceiling on one segment's age, in milliseconds: 24
 * hours.
 *
 * @remarks
 * Caller-overridable via {@link M3LAgentDecisionLogOptions.maxSegmentAgeMs}.
 * Age is measured from the active segment's own creation — a long-lived
 * process that opened a segment yesterday still rotates it once this
 * ceiling is crossed, on the next `write()`.
 *
 * @example
 * ```ts
 * import { M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS); // 86400000
 * ```
 */
export const M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS = 86_400_000;

/**
 * Constructor options for {@link M3LAgentDecisionLog}.
 *
 * @example
 * ```ts
 * import type { M3LAgentDecisionLogOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LAgentDecisionLogOptions = {
 *   directory: "/var/lib/my-agent/agent-log",
 *   maxSegmentBytes: 1_048_576,
 * };
 * ```
 */
export interface M3LAgentDecisionLogOptions {
  /**
   * Overrides the resolved target directory entirely. Defaults to
   * `new M3LPaths().getDataDir()` joined with `"agent-log"`.
   */
  readonly directory?: string;
  /** Overrides {@link M3L_AGENT_LOG_MAX_SEGMENT_BYTES}. */
  readonly maxSegmentBytes?: number;
  /** Overrides {@link M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS}. */
  readonly maxSegmentAgeMs?: number;
}

/**
 * The append-only segmented writer for the ADR-0061 decision log.
 *
 * @remarks
 * Creates its target directory itself, on the first `write()` — there is no
 * separate setup step. Each entry is appended as one
 * `JSON.stringify(entry) + "\n"` line, opened with the `"a"` (`O_APPEND`)
 * flag: seeking to the end of the file and writing are one atomic step from
 * the kernel's point of view, so two processes appending to the same
 * segment concurrently on a local filesystem interleave whole lines rather
 * than corrupting one another. That guarantee has two limits a caller must
 * respect: it does **not** hold across NFS (POSIX `O_APPEND` atomicity is
 * not guaranteed by every network filesystem), and it does not cover a
 * single `write()` whose byte length exceeds the OS pipe/write buffer —
 * which is exactly why {@link M3LAgentDecisionLog.write} rejects an
 * oversized entry (over `M3L_AGENT_MAX_LOG_ENTRY_BYTES`) before writing
 * anything, rather than emitting a line that might tear.
 *
 * Segment discovery is cold-start only: there is no index file, and no
 * state is carried across processes. On its first `write()`, an instance
 * lists its directory, picks the highest-numbered segment for the current
 * UTC date, and `stat`s it to decide whether to keep appending to it or
 * seal it and open a new one — so a freshly spawned process and a
 * long-lived one always agree. Rotation only ever seals the active segment
 * and opens a new one; it never prunes or truncates an existing segment in
 * place.
 *
 * A failed append is always loud: it throws
 * {@link M3LAgentDecisionLogWriteError} with the underlying cause chained,
 * never swallowed or downgraded to a warning, and never carrying caller
 * data (no parameter names, no identity, no reason text) in its message or
 * `context`.
 *
 * @example
 * ```ts
 * import {
 *   M3LAgentDecisionLog,
 *   agentDecisionLogEntry,
 *   evaluateAgentAction,
 *   validateAgentPolicy,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const policy = validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 * });
 * const decision = evaluateAgentAction({
 *   policy,
 *   action: { script: "s3-report", kind: "read-only" },
 * });
 *
 * const log = new M3LAgentDecisionLog();
 * await log.write(
 *   agentDecisionLogEntry({
 *     decision,
 *     identity: { name: "release-bot" },
 *     now: Date.now(),
 *   }),
 * );
 * ```
 */
export class M3LAgentDecisionLog {
  private readonly writer: AgentDecisionLogWriter;

  /**
   * Creates a new `M3LAgentDecisionLog`.
   *
   * @param options - Optional options bag; see
   *   {@link M3LAgentDecisionLogOptions}.
   */
  constructor(options?: M3LAgentDecisionLogOptions) {
    const directory =
      options?.directory ?? path.join(new M3LPaths().getDataDir(), "agent-log");
    const maxSegmentBytes =
      options?.maxSegmentBytes ?? M3L_AGENT_LOG_MAX_SEGMENT_BYTES;
    const maxSegmentAgeMs =
      options?.maxSegmentAgeMs ?? M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS;
    this.writer = new AgentDecisionLogWriter(
      directory,
      maxSegmentBytes,
      maxSegmentAgeMs,
    );
  }

  /**
   * Appends one decision-log entry.
   *
   * @param entry - A frozen {@link M3LAgentDecisionLogEntry}, normally
   *   produced by `agentDecisionLogEntry`.
   * @throws M3LAgentDecisionLogWriteError When the serialized entry exceeds
   *   `M3L_AGENT_MAX_LOG_ENTRY_BYTES`, or when the append itself fails for
   *   any reason.
   */
  async write(entry: M3LAgentDecisionLogEntry): Promise<void> {
    await this.writer.write(entry);
  }
}
