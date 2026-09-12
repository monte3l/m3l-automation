/**
 * `core/agent/decision-log` — `M3LAgentDecisionLog`, the append-only
 * segmented writer for the ADR-0061 decision log (V7 slice 2).
 *
 * @packageDocumentation
 */

import path from "node:path";

import {
  AgentDecisionLogWriter,
  validateAgentDecisionLogOptions,
} from "../../internal/agent/decision-log-writer.js";
import type { M3LAppendOnlySealFailure } from "../storage/append-only-manifest-types.js";
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
 * import { M3L_AGENT_LOG_MAX_SEGMENT_BYTES } from "@monte3l/m3l-common/core";
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
 * import { M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS } from "@monte3l/m3l-common/core";
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
 * import type { M3LAgentDecisionLogOptions } from "@monte3l/m3l-common/core";
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
   *
   * Must be a non-blank string when present: `""` and `"   "` are caller
   * mistakes, not directories.
   */
  readonly directory?: string;
  /**
   * Overrides {@link M3L_AGENT_LOG_MAX_SEGMENT_BYTES}.
   *
   * Must be a finite positive integer (`>= 1`) when present. `0` and a
   * negative would rotate on or before every write; a fractional, `NaN`, or
   * `Infinity` ceiling would make the comparison silently never fire.
   */
  readonly maxSegmentBytes?: number;
  /**
   * Overrides {@link M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS}.
   *
   * Must be a finite positive integer number of milliseconds (`>= 1`) when
   * present, on the same reasoning as
   * {@link M3LAgentDecisionLogOptions.maxSegmentBytes}.
   */
  readonly maxSegmentAgeMs?: number;
  /**
   * Told about a segment's manifest seal that was **attempted** and could
   * not be written to the directory's `manifest.jsonl` sidecar.
   *
   * The manifest sidecar and its sealer belong to `core/storage`, not this
   * namespace — {@link M3LAppendOnlySealFailure} is reused here rather than
   * declared a second time under a `core/agent`-local name, because both
   * namespaces sit on the very same `AppendOnlyWriter` and the very same
   * sealer, so a seal failure has exactly one shape. A second,
   * identical type would be two independently-maintained copies of one
   * payload with nothing enforcing that they stay in sync. Both types are
   * reachable from the same `./core` barrel entry, so accepting one here
   * adds no new subpath and no new `exports` entry.
   *
   * Sealing is deliberately best-effort: a seal is metadata *about* bytes
   * that are already durably appended, so a seal that cannot be written
   * never fails the `write()` call it follows — and this is not a
   * weakening of ADR-0061's loud-append rule. That rule governs the
   * *entry*: a failed append still throws
   * {@link M3LAgentDecisionLogWriteError} with its cause chained, never
   * downgraded to a warning. A seal is metadata about an *older* record's
   * bytes, and failing a *new* append to protect a proof about an older
   * one would discard a new auditable record in order to defend an old
   * one. This handler is therefore the **only** channel a seal failure is
   * reported on — there is no throw, no rejected promise, nothing else to
   * observe it by.
   *
   * Receiving one call means a seal was attempted and could not be
   * written, which is **not** the same as a segment simply not having been
   * sealed yet. Either way, the entry the caller just appended is
   * unaffected: it is already appended and durable regardless of whether
   * its segment could be sealed.
   *
   * Called from inside the library's own serialized append chain, so it
   * must not throw and must not block — a slow or blocking handler delays
   * every subsequent `write()` on this instance, and a throwing one is
   * absorbed here rather than being allowed to reach the caller of
   * `write()`.
   *
   * For the same reason, it should not be declared `async`: the handler is
   * called synchronously and its return value is never awaited, so the type
   * permits an `async` handler but the library neither waits for nor
   * observes what it resolves or rejects with. A rejection from a returned
   * promise is discarded rather than left to become an unhandled rejection —
   * a caller whose own reporting can fail must handle that failure inside
   * the handler itself.
   *
   * A truthy non-function is rejected at construction with
   * `ERR_INVALID_ARGUMENT`; a falsy value (including omitting the key)
   * degrades to "no handler" — see
   * `internal/agent/decision-log-writer.js`'s `validateAgentDecisionLogOptions`
   * for the validation.
   */
  readonly onSealFailed?: (failure: M3LAppendOnlySealFailure) => void;
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
 * A directory-wide `manifest.jsonl` sidecar is sealed on rotation (see
 * {@link "../storage/M3LAppendOnlyStream.js".M3LAppendOnlyStream} for the
 * shared mechanism), but three things stay true even with the manifest in
 * the picture: the manifest is never consulted to decide where to
 * append — on its first `write()`, an instance still lists its directory,
 * picks the highest-numbered segment for the current UTC date, and `stat`s
 * it to decide whether to keep appending to it or seal it and open a new
 * one, so a freshly spawned process and a long-lived one still agree; the
 * manifest carries no in-memory state across processes either; and the
 * manifest is not a segment, so it is invisible to segment discovery.
 * Rotation only ever seals the active segment and opens a new one; it
 * never prunes or truncates an existing segment in place.
 *
 * The entry is proven structurally on the way in and re-built as the
 * library's own copy before serialization: what reaches disk is never the
 * object the caller passed, so neither an inherited `toJSON` nor any other
 * accessor can rewrite — or blank out — the persisted record. Segments are
 * opened `O_NOFOLLOW` for the same reason: a segment path replaced by a
 * symlink is refused, not followed out of the log directory.
 *
 * A failed append is always loud: it throws
 * {@link M3LAgentDecisionLogWriteError} with the underlying cause chained,
 * never swallowed or downgraded to a warning, and never carrying caller
 * data (no parameter names, no identity, no reason text) in its message or
 * `context`. A failure also drops the cached active segment, so the next
 * `write()` re-creates the directory and re-discovers its segment rather
 * than failing forever on a directory that has since been removed.
 *
 * @example
 * ```ts
 * import {
 *   M3LAgentDecisionLog,
 *   agentDecisionLogEntry,
 *   evaluateAgentAction,
 *   validateAgentPolicy,
 * } from "@monte3l/m3l-common/core";
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
   * The options bag is validated eagerly, here rather than on the first
   * `write()`, so a misconfiguration fails at construction instead of
   * halfway through a run. Omitting it entirely is legal — every field has a
   * documented default — but a `null` bag is not: it is a caller mistake
   * that optional chaining would silently read as "absent".
   *
   * @param options - Optional options bag; see
   *   {@link M3LAgentDecisionLogOptions}.
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when
   *   `options` is present but is not a plain object, carries an unknown
   *   key, has a blank or non-string `directory`, has a `maxSegmentBytes`
   *   / `maxSegmentAgeMs` that is not a finite positive integer, or has a
   *   truthy non-function `onSealFailed`. The error names the offending
   *   field and the violation kind, never the rejected value — a directory
   *   path can carry tenant or customer identifiers.
   */
  constructor(options?: M3LAgentDecisionLogOptions) {
    const overrides = validateAgentDecisionLogOptions(options);
    const directory =
      overrides.directory ??
      path.join(new M3LPaths().getDataDir(), "agent-log");
    const maxSegmentBytes =
      overrides.maxSegmentBytes ?? M3L_AGENT_LOG_MAX_SEGMENT_BYTES;
    const maxSegmentAgeMs =
      overrides.maxSegmentAgeMs ?? M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS;
    this.writer = new AgentDecisionLogWriter({
      directory,
      maxSegmentBytes,
      maxSegmentAgeMs,
      // Conditional spread, not a direct assignment: `exactOptionalPropertyTypes`
      // forbids setting an optional property to a value typed `T | undefined`.
      ...(overrides.onSealFailed !== undefined && {
        onSealFailed: overrides.onSealFailed,
      }),
    });
  }

  /**
   * Appends one decision-log entry.
   *
   * @remarks
   * Concurrent calls on one instance are serialized: each append awaits the
   * previous one's completion, so the segment bookkeeping that drives
   * byte-ceiling rotation cannot be lost to a last-writer-wins race. A
   * rejected call is reported to its own caller only and does not affect
   * subsequent ones.
   *
   * Resolving means the entry is durable — it does not mean the directory is
   * quiescent: a `manifest.jsonl` seal for a previously rotated segment can
   * still land afterwards (see
   * `internal/storage/append-only-writer.js`'s `sealAfterAppend`). Removing
   * or archiving the log directory immediately after the last `write()`
   * resolves can race that write — an `ENOTEMPTY` on a recursive remove is
   * the symptom, and a caller doing so should retry past it. This is
   * deliberate, not an oversight: a seal is metadata about bytes already
   * durably appended, so waiting on it would invert the best-effort design,
   * and a process exiting before a seal runs is exactly what the sealer's
   * cold-start sweep recovers.
   *
   * @param entry - A frozen {@link M3LAgentDecisionLogEntry}, normally
   *   produced by `agentDecisionLogEntry`.
   * @throws {@link M3LError} with `code: "ERR_INVALID_ARGUMENT"` when `entry`
   *   is not structurally a decision-log entry: not a plain object, carrying
   *   an unknown or dangerous own key, missing a required field, or holding
   *   one of the wrong shape. Such an entry is an argument this writer cannot
   *   represent faithfully — a caller-side violation — so it is not reported
   *   as a write failure. The error names the offending field and the
   *   violation kind, never the rejected value.
   * @throws {@link M3LAgentDecisionLogWriteError} when the appended line
   *   (`JSON.stringify(entry)` plus its newline) exceeds
   *   `M3L_AGENT_MAX_LOG_ENTRY_BYTES` — a well-formed entry that is simply
   *   larger than this writer can durably append in one atomic write — or
   *   when the append itself fails for any reason, including a segment path
   *   that has been replaced by a symlink. Nothing is written to disk in
   *   either case.
   */
  async write(entry: M3LAgentDecisionLogEntry): Promise<void> {
    await this.writer.write(entry);
  }

  /**
   * Drains the write chain as it stands at the moment of the call: waits for
   * every `write()` — and every `manifest.jsonl` seal — that was already in
   * flight when `flush()` was called to settle.
   *
   * @remarks
   * **Does not cover a concurrent or later `write()`.** This is a
   * point-in-time drain, not a barrier and not a close — there is no
   * `close()` on this class. A `write()` started after `flush()` was called
   * (even one still pending when `flush()` resolves) is simply not part of
   * what it waited for.
   *
   * **Never rejects, and is not an error channel.** A `write()` failure
   * still reaches its own caller as a thrown
   * {@link M3LAgentDecisionLogWriteError}, and a seal failure still reaches
   * only the constructor's `onSealFailed` handler (see
   * {@link M3LAgentDecisionLogOptions.onSealFailed}) — `flush()` reports
   * neither. This is not a second chance to learn about a failed append:
   * ADR-0061's loud-write rule is untouched by this method. A failed
   * `write()` has already thrown {@link M3LAgentDecisionLogWriteError} with
   * its cause chained, at its own call site, by the time `flush()` could
   * even be reached.
   *
   * **What it is for:** making the log directory safe to remove, archive, or
   * measure. Without it, a manifest seal for a segment rotated by the last
   * `write()` can still be in flight when that `write()`'s own promise
   * resolves — a caller who removes or archives the directory at that
   * instant races it, which surfaces as `ENOTEMPTY` on a recursive remove
   * (the in-flight seal recreates `manifest.jsonl` partway through). Calling
   * and awaiting `flush()` first closes that window.
   *
   * **Never required for the log's correctness.** A process that exits
   * without calling this loses at most one unsealed segment's manifest
   * entry, never an appended line — and that is exactly what
   * {@link "../../internal/storage/append-only-sealer.js".AppendOnlySealer}'s
   * cold-start sweep recovers on the next `M3LAgentDecisionLog` constructed
   * over the same directory.
   *
   * @example
   * ```ts
   * import { rm } from "node:fs/promises";
   * import {
   *   M3LAgentDecisionLog,
   *   agentDecisionLogEntry,
   *   evaluateAgentAction,
   *   validateAgentPolicy,
   * } from "@monte3l/m3l-common/core";
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
   * const log = new M3LAgentDecisionLog({ directory: "/tmp/agent-log" });
   * await log.write(
   *   agentDecisionLogEntry({
   *     decision,
   *     identity: { name: "release-bot" },
   *     now: Date.now(),
   *   }),
   * );
   *
   * // Safe to remove only after every in-flight write and seal has settled.
   * await log.flush();
   * await rm("/tmp/agent-log", { recursive: true });
   * ```
   */
  async flush(): Promise<void> {
    await this.writer.flush();
  }
}
