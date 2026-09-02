/**
 * `runs/orchestrator-cancel` — the run-cancellation path (X7d, ADR-0070):
 * `cancelRun` for an operator's `POST /api/v1/runs/:id/cancel`, and the
 * shared queued-run eviction {@link onQueueTimeout} reuses.
 *
 * Split out of `runs/orchestrator.ts` on ADR-0072's byte budget — that file
 * reached 24,947 of its 25,000-char ceiling once cancellation grew a queued
 * branch. It is a coherent split as well as a forced one: this is the only
 * place a run ends WITHOUT having executed, which is the whole reason it must
 * never go near `claimForStart`.
 *
 * `orchestrator.ts` imports this module; this module imports only
 * `orchestrator-context.ts`. That direction is deliberate — the reverse would
 * be a cycle, which `bin/check-eslint-zones.mjs`'s no-cycle guard forbids.
 *
 * @packageDocumentation
 */

import type { M3LOrchestratorContext } from "./orchestrator-context.js";

/**
 * Clears a queued run's armed queue-timeout timer, if one exists. A no-op for
 * a run that was never queued (started immediately) or already cleared.
 *
 * Exported because `orchestrator.ts`'s `pumpQueue` needs it too, and this
 * module is already an edge it has — the reverse import would be a cycle.
 *
 * @param ctx - The orchestrator's shared state bag.
 * @param id - The run whose timer to clear.
 *
 * @example
 * ```ts
 * import { clearQueueTimeout } from "@m3l-automation/m3l-console-server/runs/orchestrator-cancel.js";
 *
 * declare const ctx: Parameters<typeof clearQueueTimeout>[0];
 * clearQueueTimeout(ctx, "run-1");
 * ```
 */
export function clearQueueTimeout(
  ctx: M3LOrchestratorContext,
  id: string,
): void {
  const handle = ctx.queueTimers.get(id);
  if (handle === undefined) return;
  ctx.queueTimers.delete(id);
  clearTimeout(handle);
}

/**
 * Evicts a still-`queued` run to the terminal `interrupted` status, returning
 * `true` when this call's own write applied.
 *
 * The shared tail of the TWO paths that end a run before it ever started:
 * {@link onQueueTimeout} (its `queueTimeoutMs` elapsed) and
 * {@link cancelRun}'s queued branch (X7d — an operator asked). They are the
 * same sequence, and one implementation is what keeps them from drifting
 * into two different answers for the same registry state.
 *
 * Writes via `registry.abandonQueued`'s guarded `queued` to `interrupted`
 * transition, never `claimForStart`-then-`finish`: a run that ended while
 * queued never executed, so `started_at_ms` must never be fabricated
 * (`store/runs-repository.ts`'s TSDoc has the full rationale). A lost race —
 * `abandonQueued` returning `false` because another caller already started
 * or ended this run — is logged at `warning` and reported as `false`: that
 * run's own completion path already owns its finish record.
 *
 * Deliberately does NOT pump the queue: a run evicted from the queue never
 * held a governor slot (it was `enqueue`d, never `accept`ed), so no slot was
 * freed for anyone to fill. `governor.dequeue()` releases the QUEUE
 * reservation, which is a different accounting line.
 *
 * `reason` appears only in the lost-race warning, so an operator reading the
 * log can tell a timeout from a cancellation.
 *
 * @param ctx - The orchestrator's shared state bag.
 * @param id - The run's id.
 * @param scriptName - The run's script, for the audit entry and the warning.
 * @param operator - Who the resulting `run.finished` entry is attributed to.
 * @param reason - Named in the lost-race warning only.
 * @returns `true` when this call's own write applied.
 *
 * @example
 * ```ts
 * import { abandonQueuedRun } from "@m3l-automation/m3l-console-server/runs/orchestrator-cancel.js";
 *
 * declare const ctx: Parameters<typeof abandonQueuedRun>[0];
 * abandonQueuedRun(ctx, "run-1", "sqs-etl", "ada", "queue-timeout");
 * ```
 */
export function abandonQueuedRun(
  ctx: M3LOrchestratorContext,
  id: string,
  scriptName: string,
  operator: string,
  reason: string,
): boolean {
  const row = ctx.registry.get(id);
  if (row === undefined || row.status !== "queued") return false;
  const endedAtMs = ctx.nowMs();
  if (!ctx.registry.abandonQueued(id, endedAtMs)) {
    ctx.logger.warning(
      `lost the abandon-queued race for run '${id}' of script '${scriptName}'; it was started or ended before this ${reason} could apply`,
      { runId: id, scriptName },
    );
    return false;
  }
  ctx.events.publish({
    event: "run.ended",
    runId: id,
    outcome: "interrupted",
    exitCode: undefined,
  });
  ctx.audit.record({
    action: "run.finished",
    runId: id,
    scriptName,
    operator,
    atMs: endedAtMs,
    detail: { outcome: "interrupted" },
  });
  ctx.governor.dequeue();
  return true;
}

/** Records the operator's `run.cancelled` act, shared by both cancel branches. */
function recordCancellation(
  ctx: M3LOrchestratorContext,
  id: string,
  scriptName: string,
  operator: string,
): void {
  ctx.audit.record({
    action: "run.cancelled",
    runId: id,
    scriptName,
    operator,
    atMs: ctx.nowMs(),
    detail: {},
  });
}

/**
 * Cancels a run — active or queued. See {@link M3LRunOrchestrator.cancel}'s
 * own TSDoc for the contract.
 *
 * The ACTIVE branch only aborts: the run's own `executeAndSettle`
 * continuation still owns its terminal write, and racing it here would
 * produce two finish records for one run. The QUEUED branch, by contrast,
 * IS the terminal write — a queued run has no continuation waiting to run.
 *
 * `run.cancelled` is recorded on both branches BEFORE the state change, and
 * is the operator's act; the run's own terminal `run.finished` is a separate
 * entry written by whichever path settles it. Keeping them distinct is what
 * lets an auditor tell "an operator asked" from "the run ended", which for a
 * cancellation are two facts, not one.
 *
 * @param ctx - The orchestrator's shared state bag.
 * @param id - The run's id.
 * @returns `true` when a run was cancelled, `false` when there was nothing to
 *   cancel (unknown id, or already terminal).
 *
 * @example
 * ```ts
 * import { cancelRun } from "@m3l-automation/m3l-console-server/runs/orchestrator-cancel.js";
 *
 * declare const ctx: Parameters<typeof cancelRun>[0];
 * cancelRun(ctx, "run-1");
 * ```
 */
export function cancelRun(ctx: M3LOrchestratorContext, id: string): boolean {
  const entry = ctx.active.get(id);
  if (entry !== undefined) {
    recordCancellation(ctx, id, entry.scriptName, entry.operator);
    entry.controller.abort();
    return true;
  }

  const pending = ctx.pendingQueued.get(id);
  if (pending === undefined) return false;

  const scriptName = pending.resolved.name;
  const { operator } = pending;
  // Cleared BEFORE the eviction, not after: `abandonQueuedRun` publishes and
  // audits, and an armed timer surviving that window could fire against a
  // run this call already ended.
  clearQueueTimeout(ctx, id);
  ctx.pendingQueued.delete(id);
  recordCancellation(ctx, id, scriptName, operator);
  return abandonQueuedRun(ctx, id, scriptName, operator, "cancellation");
}
