/**
 * `runs/audit` — `createLoggerAuditSink`, the run-lifecycle audit trail the
 * orchestrator writes to at every launch/start/finish/cancel/reconcile
 * decision point.
 *
 * V6/V7 (the console's persisted audit log and its retention story) are still
 * open, so this sink is deliberately the escalate-by-default seam rather than
 * a durable audit trail: it logs each record through {@link Core.M3LLogger}
 * at `info`, which every deployment already captures somewhere, instead of
 * silently accumulating in memory until a real store exists.
 *
 * X7 does NOT replace this sink: it adds a SIBLING port, `audit/stream.ts`'s
 * human-action trail, and the two record different things. Everything here is
 * a machine transition — `run.started`/`run.finished` are the runner's own
 * progress, and `run.reconciled` is written with `operator: "system"` — so it
 * must never become a launch failure mode, which is why `record` returns
 * `void` and never throws. The human-action trail records what an operator
 * ASKED for and refuses the action when it cannot be written. This sink stays.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * The closed set of run-lifecycle events an {@link M3LRunAuditSink} records.
 *
 * @example
 * ```ts
 * function isLaunchOutcome(action: M3LRunAuditAction): boolean {
 *   return action.startsWith("run.launch-");
 * }
 * ```
 */
export type M3LRunAuditAction =
  | "run.launch-allowed"
  | "run.launch-denied"
  | "run.launch-rejected"
  | "run.started"
  | "run.finished"
  | "run.cancelled"
  | "run.reconciled";

/**
 * One audit entry. `runId` is `string | undefined` because a denied or
 * rejected launch is recorded before an id has ever been minted — the
 * orchestrator assigns `id` only after the policy and governor both allow
 * the launch to proceed.
 *
 * `detail` is deliberately a closed scalar map (`string | number | boolean`
 * values only), never `unknown`. A run's `parameters` are caller-supplied
 * data — including whatever secrets an operator passes a script — and must
 * never be representable in an audit record at all, not merely redacted
 * after the fact. (`boot/logging.ts`'s `RUNTIME_SECRET_NAMES` already redacts
 * `parameters`/`params`/`values`/`args` on the runtime logger, so a mistake
 * here would be caught by a second layer — but the type is the primary
 * control, not that redaction list.)
 *
 * @example
 * ```ts
 * const entry: M3LRunAuditRecord = {
 *   action: "run.launch-allowed",
 *   runId: "run-1",
 *   scriptName: "sqs-etl",
 *   operator: "ada",
 *   atMs: Date.now(),
 *   detail: {},
 * };
 * ```
 */
export interface M3LRunAuditRecord {
  /** The lifecycle event this entry records. */
  readonly action: M3LRunAuditAction;
  /** The run's id, or `undefined` when the launch was denied/rejected before one was minted. */
  readonly runId: string | undefined;
  /** The script identifier the run invokes. */
  readonly scriptName: string;
  /** The operator who requested the run. */
  readonly operator: string;
  /** Epoch-millisecond timestamp this entry was recorded at. */
  readonly atMs: number;
  /** Closed scalar detail; never caller-supplied run parameters (see above). */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The run-lifecycle audit port.
 *
 * @example
 * ```ts
 * function auditLaunch(sink: M3LRunAuditSink, scriptName: string, operator: string): void {
 *   sink.record({
 *     action: "run.launch-allowed",
 *     runId: "run-1",
 *     scriptName,
 *     operator,
 *     atMs: Date.now(),
 *     detail: {},
 *   });
 * }
 * ```
 */
export interface M3LRunAuditSink {
  /** Records `entry`. Never throws — an audit sink must not become a launch failure mode. */
  record(entry: M3LRunAuditRecord): void;
}

/** The stable, action-only message logged for each {@link M3LRunAuditAction} — never derived from a record's own fields, so two records for the same action always log identical text. */
function messageFor(action: M3LRunAuditAction): string {
  switch (action) {
    case "run.launch-allowed":
      return "run launch allowed";
    case "run.launch-denied":
      return "run launch denied";
    case "run.launch-rejected":
      return "run launch rejected";
    case "run.started":
      return "run started";
    case "run.finished":
      return "run finished";
    case "run.cancelled":
      return "run cancelled";
    case "run.reconciled":
      return "run reconciled";
    default: {
      const exhaustive: never = action;
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `unhandled run audit action: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Creates an {@link M3LRunAuditSink} that logs every record through `logger`
 * at `info`, with a message stable per {@link M3LRunAuditAction} and every
 * other field (including `detail`) carried as structured data.
 *
 * @param logger - The {@link Core.M3LLogger} to record through.
 * @returns A fresh {@link M3LRunAuditSink}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { createLoggerAuditSink } from "@m3l-automation/m3l-console-server/runs/audit.js";
 *
 * const sink = createLoggerAuditSink(new Core.M3LLogger([]));
 * sink.record({
 *   action: "run.started",
 *   runId: "run-1",
 *   scriptName: "sqs-etl",
 *   operator: "ada",
 *   atMs: Date.now(),
 *   detail: {},
 * });
 * ```
 */
export function createLoggerAuditSink(logger: Core.M3LLogger): M3LRunAuditSink {
  return {
    record(entry: M3LRunAuditRecord): void {
      logger.info(messageFor(entry.action), {
        runId: entry.runId,
        scriptName: entry.scriptName,
        operator: entry.operator,
        atMs: entry.atMs,
        ...entry.detail,
      });
    },
  };
}
