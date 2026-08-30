/**
 * `core/agent/decision-log-types` — the decision-log entry vocabulary
 * (ADR-0061, V7 slice 1): the caller-supplied identity, the post-run outcome,
 * the flat entry itself, and the projector's options bag.
 *
 * @packageDocumentation
 */

import type {
  M3LAgentActionKind,
  M3LAgentActionRecord,
} from "./action-types.js";
import type {
  M3LAgentDecision,
  M3LAgentPolicyRuleId,
  M3LAgentVerdict,
} from "./verdict-types.js";

/**
 * The ceiling on one serialized {@link M3LAgentDecisionLogEntry} line's
 * UTF-8 byte length.
 *
 * @remarks
 * Exported in this slice but **enforced in slice 2**, by the writer, where it
 * belongs: the reason for a ceiling is that a single oversized `write()` is
 * where a line-delimited append can tear, and only the writer performs one.
 * {@link serializeAgentDecisionLogEntry} deliberately does not enforce it — a
 * caller that wants to check can measure the string it just received.
 *
 * @example
 * ```ts
 * import {
 *   M3L_AGENT_MAX_LOG_ENTRY_BYTES,
 *   serializeAgentDecisionLogEntry,
 * } from "@m3l-automation/m3l-common/core";
 * import type { M3LAgentDecisionLogEntry } from "@m3l-automation/m3l-common/core";
 *
 * function isOversized(entry: M3LAgentDecisionLogEntry): boolean {
 *   const line = serializeAgentDecisionLogEntry(entry);
 *   return Buffer.byteLength(line, "utf8") > M3L_AGENT_MAX_LOG_ENTRY_BYTES;
 * }
 * ```
 */
export const M3L_AGENT_MAX_LOG_ENTRY_BYTES = 65536;

/**
 * The caller-supplied identity of the acting agent.
 *
 * @remarks
 * The library resolves **none** of this: no principal resolver exists in
 * `core/`, and `aws/` is unreachable from here. `modelId` and `awsPrincipal`
 * are typed `?: string` — the narrow, omit-only form — rather than
 * `?: string | undefined`: the runtime validator
 * (`internal/agent/decision-log.ts`) reads presence with `Object.hasOwn`, so
 * a present key holding `undefined` is malformed input and throws, never
 * "absent". The projector likewise **omits** an absent field from its
 * returned identity rather than emitting it holding `undefined`, so the
 * narrow spelling serves both directions: a caller can re-pass a returned
 * identity unchanged, and `{ name: "bot", modelId: undefined }` is now a
 * compile error instead of a runtime throw.
 *
 * @example
 * ```ts
 * import type { M3LAgentIdentity } from "@m3l-automation/m3l-common/core";
 *
 * const identity: M3LAgentIdentity = {
 *   name: "release-bot",
 *   modelId: "anthropic.claude-tool-use-v1",
 * };
 * ```
 */
export interface M3LAgentIdentity {
  /** The acting agent's logical name. */
  readonly name: string;
  /** The model identifier that produced the decision, when known. */
  readonly modelId?: string;
  /** The AWS principal the agent assumed, when known. */
  readonly awsPrincipal?: string;
}

/**
 * What happened after an approved action ran.
 *
 * @remarks
 * Absent from a {@link M3LAgentDecisionLogEntry} when nothing ran — which is
 * most of what the log is for: an `auto-approved` verdict is the usual source
 * of one. A `denied` or `escalate` verdict is not run by this library and so
 * typically carries none, but the type does not forbid it: an `escalate` a
 * human later approves and runs out-of-band, or a `denied` action a caller
 * ran anyway, are exactly the pairings an audit log must be able to record.
 *
 * @example
 * ```ts
 * import type { M3LAgentDecisionOutcome } from "@m3l-automation/m3l-common/core";
 *
 * const outcome: M3LAgentDecisionOutcome = { dryRun: false, exitCode: 0 };
 * ```
 */
export interface M3LAgentDecisionOutcome {
  /** Whether the run that produced this outcome was a dry run. */
  readonly dryRun: boolean;
  /** The process exit code, when the run produced one. */
  readonly exitCode?: number;
  /** The registry name the run targeted, when applicable. */
  readonly registryName?: string;
}

/**
 * One audit record: the decision, the identity, and the outcome, flat and
 * plain-JSON.
 *
 * @remarks
 * Produced only by {@link agentDecisionLogEntry}. `script` / `operation` /
 * `kind` / `target` / `parameterNames` / `shapeKey` are copied from the
 * decision's frozen `M3LAgentActionRecord`; `verdict` / `rule` / `reason` are
 * copied from the decision itself. `outcome` / `tokens` / `cost` are present
 * only when the caller supplied them — never emitted holding `undefined` or
 * `null`.
 *
 * `kind` and `reason` are recorded deliberately: `kind` is the module's one
 * trust boundary, and `reason` is library-authored prose ADR-0060 already
 * documents as safe for a log sink.
 *
 * @example
 * ```ts
 * import type { M3LAgentDecisionLogEntry } from "@m3l-automation/m3l-common/core";
 *
 * function summarize(entry: M3LAgentDecisionLogEntry): string {
 *   return `${entry.timestamp} ${entry.identity.name} ${entry.verdict} ${entry.script}`;
 * }
 * ```
 */
export interface M3LAgentDecisionLogEntry {
  /** ISO-8601 UTC, derived from the caller's `now`. */
  readonly timestamp: string;
  /** A frozen copy of the supplied {@link M3LAgentIdentity}. */
  readonly identity: M3LAgentIdentity;
  /** Copied from the decision's frozen `M3LAgentActionRecord`. */
  readonly script: string;
  /** Copied from the decision's frozen `M3LAgentActionRecord`. */
  readonly operation: string | undefined;
  /** Copied from the decision's frozen `M3LAgentActionRecord`. */
  readonly kind: M3LAgentActionKind;
  /**
   * A fresh frozen copy carrying only `profile` / `region` / `accountId` —
   * the coordinates the verdict `reason` already names in prose.
   */
  readonly target: M3LAgentActionRecord["target"];
  /** A fresh frozen copy of the decision's parameter names. */
  readonly parameterNames: readonly string[];
  /** Copied from the decision's frozen `M3LAgentActionRecord`. */
  readonly shapeKey: string;
  /** The decision's verdict. */
  readonly verdict: M3LAgentVerdict;
  /** The decision's rule id. */
  readonly rule: M3LAgentPolicyRuleId;
  /** The decision's library-authored reason. */
  readonly reason: string;
  /** Present only when the caller reported an outcome. */
  readonly outcome?: M3LAgentDecisionOutcome;
  /** Present only when the caller reported a token count. */
  readonly tokens?: number;
  /** Present only when the caller reported a cost. */
  readonly cost?: number;
}

/**
 * The options bag {@link agentDecisionLogEntry} takes.
 *
 * @remarks
 * An options bag rather than positional parameters, for the reason
 * `M3LAgentEvaluationOptions` already records: slice 2 needs to add fields,
 * and on a bag that is additive.
 *
 * @example
 * ```ts
 * import type { M3LAgentDecisionLogEntryOptions } from "@m3l-automation/m3l-common/core";
 * import { evaluateAgentAction, validateAgentPolicy } from "@m3l-automation/m3l-common/core";
 *
 * const policy = validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 * });
 *
 * const options: M3LAgentDecisionLogEntryOptions = {
 *   decision: evaluateAgentAction({
 *     policy,
 *     action: { script: "s3-report", kind: "read-only" },
 *   }),
 *   identity: { name: "release-bot" },
 *   now: Date.now(),
 * };
 * ```
 */
export interface M3LAgentDecisionLogEntryOptions {
  /** The decision to record. */
  readonly decision: M3LAgentDecision;
  /** The acting agent. */
  readonly identity: M3LAgentIdentity;
  /**
   * The caller-sampled instant, epoch milliseconds. Must be a finite integer
   * within `Date`'s representable range.
   */
  readonly now: number;
  /** What happened after an approved action ran, when something ran. */
  readonly outcome?: M3LAgentDecisionOutcome;
  /** The tokens spent producing this decision, when known. */
  readonly tokens?: number;
  /** The cost incurred producing this decision, when known. */
  readonly cost?: number;
}
