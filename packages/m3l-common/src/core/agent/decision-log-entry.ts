/**
 * `core/agent/decision-log-entry` — `agentDecisionLogEntry` and
 * `serializeAgentDecisionLogEntry`: the pure projector from a decision to one
 * decision-log entry, and its JSONL serializer (ADR-0061, V7 slice 1).
 *
 * @packageDocumentation
 */

import { buildAgentDecisionLogEntry } from "../../internal/agent/decision-log.js";
import type {
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionLogEntryOptions,
} from "./decision-log-types.js";

/**
 * Projects one {@link M3LAgentDecision} into a flat, frozen decision-log
 * entry.
 *
 * @remarks
 * Pure — no I/O, no clock read. `agentDecisionLogEntry` takes **any**
 * `M3LAgentDecision` and filters nothing: recording only what ran would
 * reproduce exactly the gap ADR-0061 exists to close. The projector never
 * sees the caller's action object — its input is `decision.action`, which is
 * already this library's own frozen `M3LAgentActionRecord`, so
 * `parameterNames` is names only; there is nothing in its reach to redact.
 *
 * The returned entry is deep-frozen and shares no object by reference with
 * either argument, so a caller mutating its identity afterwards cannot make
 * two entries disagree.
 *
 * @param options - `decision`, `identity`, and `now` (epoch milliseconds),
 *   plus the optional `outcome` / `tokens` / `cost` — omitted fields are
 *   omitted from the entry rather than written as `undefined` or `null`.
 * @returns The frozen decision-log entry.
 * @throws M3LAgentActionValidationError When the options bag is
 *   structurally malformed — a malformed `decision` (a non-object decision
 *   or action, a blank `script` / `kind` / `shapeKey`, a non-array-of-strings
 *   `parameterNames`, a non-boolean `dryRun`, or a blank `verdict` / `rule` /
 *   `reason`), a blank `identity.name`, a non-string `modelId` or
 *   `awsPrincipal`, a missing or out-of-range `now`, a negative or
 *   non-finite `tokens` or `cost`, a non-integer `exitCode`, or any unknown
 *   key. Its `context` names the offending field and the violation kind,
 *   never a value.
 *
 * @example
 * ```ts
 * import {
 *   agentDecisionLogEntry,
 *   evaluateAgentAction,
 *   validateAgentPolicy,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const policy = validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 * });
 *
 * const decision = evaluateAgentAction({
 *   policy,
 *   action: { script: "s3-report", kind: "read-only" },
 * });
 *
 * const entry = agentDecisionLogEntry({
 *   decision,
 *   identity: { name: "release-bot" },
 *   now: Date.now(),
 * });
 * // entry.verdict === decision.verdict
 * ```
 */
export function agentDecisionLogEntry(
  options: M3LAgentDecisionLogEntryOptions,
): M3LAgentDecisionLogEntry {
  return buildAgentDecisionLogEntry(options);
}

/**
 * Serializes one decision-log entry to a single JSONL line.
 *
 * @remarks
 * One entry to one line, **without** a trailing newline — the writer owns
 * the separator, so a caller composing lines cannot end up with a blank
 * record between them. Absent optional fields are omitted from the JSON, not
 * emitted as `null`.
 *
 * `M3L_AGENT_MAX_LOG_ENTRY_BYTES` is exported alongside this function but
 * deliberately **not enforced here** — it is enforced by slice 2's writer,
 * where an oversized `write()` is the actual tear risk.
 *
 * @param entry - A frozen {@link M3LAgentDecisionLogEntry}, normally produced
 *   by {@link agentDecisionLogEntry}.
 * @returns The single-line JSON serialization.
 *
 * @example
 * ```ts
 * import { serializeAgentDecisionLogEntry } from "@m3l-automation/m3l-common/core";
 * import type { M3LAgentDecisionLogEntry } from "@m3l-automation/m3l-common/core";
 *
 * function toLogLine(entry: M3LAgentDecisionLogEntry): string {
 *   return `${serializeAgentDecisionLogEntry(entry)}\n`;
 * }
 * ```
 */
export function serializeAgentDecisionLogEntry(
  entry: M3LAgentDecisionLogEntry,
): string {
  return JSON.stringify(entry);
}
