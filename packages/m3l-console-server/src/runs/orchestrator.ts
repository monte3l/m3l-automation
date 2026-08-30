/**
 * `runs/orchestrator` — `createRunOrchestrator`, the X4 run-governor's single
 * write path for launching, starting, cancelling, and reconciling a script
 * run. It composes every Round 1 port (`registry`, `policy`, `audit`,
 * `events`, `governor`, both `executor`s) plus the resolver and outcome
 * mapper into the one place that knows the full launch → start → finish
 * lifecycle and its two failure detours (a denied policy, a full queue).
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";

import { Core } from "@m3l-automation/m3l-common";

import type { RunExecutionMode } from "../store/runs-repository.js";

import { admitRun } from "./admission.js";
import type { M3LRunAuditSink } from "./audit.js";
import type { M3LRunEventSink } from "./events.js";
import type { M3LRunExecutor } from "./executor.js";
import type { M3LRunGovernor } from "./governor.js";
import type {
  M3LRunHandle,
  M3LRunLaunchRequest,
  M3LRunOrchestrator,
  M3LRunOrchestratorConfig,
  M3LRunOrchestratorOptions,
} from "./orchestrator-types.js";
import { mapSpawnOutcome } from "./outcome.js";
import type { M3LRunRequestBody } from "./parameters.js";
import type { M3LRunPolicy } from "./policy.js";
import type { M3LRunRegistry } from "./registry.js";
import { executionModeForScript } from "./resolver.js";
import type { M3LResolvedScript } from "./resolver.js";

export type {
  M3LRunHandle,
  M3LRunLaunchRequest,
  M3LRunOrchestrator,
  M3LRunOrchestratorConfig,
  M3LRunOrchestratorOptions,
} from "./orchestrator-types.js";

/**
 * The test-only injection seam for {@link createRunOrchestrator}. Deliberately
 * NOT exported — knip flags an exported type with no `src/**` consumer, and
 * `tests/**` sits outside its `project` glob, so a test-only import would not
 * count as one anyway.
 */
interface M3LRunOrchestratorInternals {
  /** Replaces `crypto.randomUUID` for a deterministic run id. */
  readonly newId?: () => string;
  /** Replaces `Date.now` for a deterministic clock. */
  readonly nowMs?: () => number;
  /** Replaces `setTimeout` for a deterministic queue-timeout timer. */
  readonly timerImpl?: typeof setTimeout;
}

/** One currently-active (started, not yet settled) run. */
interface M3LActiveRun {
  readonly controller: AbortController;
  readonly scriptName: string;
  readonly operator: string;
  readonly promise: Promise<void>;
}

/** A queued run's originally-resolved script and request, kept so a later pump or timeout never has to re-derive them. */
interface M3LPendingQueuedRun {
  readonly resolved: M3LResolvedScript;
  readonly body: M3LRunRequestBody;
  readonly operator: string;
}

/**
 * Every collaborator and piece of mutable state the orchestrator's helper
 * functions share, bundled so each helper takes one argument instead of
 * eight. Not exported — purely an internal wiring detail.
 */
interface M3LOrchestratorContext {
  readonly config: M3LRunOrchestratorConfig;
  readonly registry: M3LRunRegistry;
  readonly governor: M3LRunGovernor;
  readonly policy: M3LRunPolicy;
  readonly audit: M3LRunAuditSink;
  readonly events: M3LRunEventSink;
  readonly spawnExecutor: M3LRunExecutor;
  readonly inProcessExecutor: M3LRunExecutor;
  readonly logger: Core.M3LLogger;
  readonly newId: () => string;
  readonly nowMs: () => number;
  readonly timerImpl: typeof setTimeout;
  readonly active: Map<string, M3LActiveRun>;
  readonly queueTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly pendingQueued: Map<string, M3LPendingQueuedRun>;
  /**
   * The drain flag, as a closure-backed pair rather than a mutable context
   * field: `M3LOrchestratorContext` is deeply `readonly`, and
   * `no-param-reassign` correctly forbids mutating it through a parameter, so
   * the flag itself lives in {@link createRunOrchestrator}'s closure and
   * these two functions are its only access. `markDraining` is never
   * reversible — once called, `isDraining` never reports `false` again, a
   * drained orchestrator being terminal, matching the shutdown-sequence
   * lifecycle (there is no "un-drain" to support).
   */
  readonly isDraining: () => boolean;
  /** See {@link M3LOrchestratorContext.isDraining}'s TSDoc. */
  readonly markDraining: () => void;
}

/** The optional fields a terminal `finish` write carries, on top of `outcome`/`endedAtMs`. */
interface M3LFinishExtra {
  readonly exitCode?: number;
  readonly failureMessage?: string;
}

/**
 * Writes an ACTIVE run's terminal outcome via `registry.finish`, publishes
 * `run.ended`, and audits `run.finished`. The queue-timeout path finishes via
 * `registry.abandonQueued` instead and does not call this.
 */
function recordFinish(
  ctx: M3LOrchestratorContext,
  id: string,
  scriptName: string,
  operator: string,
  outcome: Core.M3LRunOutcome,
  extra: M3LFinishExtra,
): void {
  const endedAtMs = ctx.nowMs();
  ctx.registry.finish(id, { outcome, endedAtMs, ...extra });
  ctx.events.publish({
    event: "run.ended",
    runId: id,
    outcome,
    exitCode: extra.exitCode,
  });
  ctx.audit.record({
    action: "run.finished",
    runId: id,
    scriptName,
    operator,
    atMs: endedAtMs,
    detail: { outcome },
  });
}

/**
 * Finishes an ACTIVE run: records the outcome, frees the active-map entry
 * and the governor slot it occupied, then pumps the queue — the completion
 * of one run is exactly what makes room for the next.
 */
function finishActiveRun(
  ctx: M3LOrchestratorContext,
  id: string,
  scriptName: string,
  operator: string,
  outcome: Core.M3LRunOutcome,
  extra: M3LFinishExtra,
): void {
  recordFinish(ctx, id, scriptName, operator, outcome, extra);
  ctx.active.delete(id);
  ctx.governor.release(scriptName);
  pumpQueue(ctx);
}

/** Clears a queued run's armed queue-timeout timer, if one exists. A no-op for a run that was never queued (started immediately) or already cleared. */
function clearQueueTimeout(ctx: M3LOrchestratorContext, id: string): void {
  const handle = ctx.queueTimers.get(id);
  if (handle === undefined) return;
  ctx.queueTimers.delete(id);
  clearTimeout(handle);
}

/**
 * Fires when a queued run's `queueTimeoutMs` elapses. A run already started
 * or cancelled by then is left alone — this checks the registry's own
 * status rather than trusting the timer fired "in time". Deliberately does
 * NOT pump the queue afterward: a timed-out run never held a governor slot
 * (it was `enqueue`d, never `accept`ed), so no slot was freed for anyone to
 * fill.
 *
 * Writes via `registry.abandonQueued`'s guarded `queued` to `interrupted`
 * transition, never `claimForStart`-then-`finish`: a run timed out while
 * queued never executed, so `started_at_ms` must never be fabricated
 * (`store/runs-repository.ts`'s TSDoc has the full rationale). A lost race —
 * `abandonQueued` returning `false` because another caller already started
 * or ended this run — is logged and left alone: that run's own completion
 * path already owns its finish record.
 */
function onQueueTimeout(
  ctx: M3LOrchestratorContext,
  id: string,
  scriptName: string,
  operator: string,
): void {
  ctx.queueTimers.delete(id);
  ctx.pendingQueued.delete(id);
  const row = ctx.registry.get(id);
  if (row === undefined || row.status !== "queued") return;
  const endedAtMs = ctx.nowMs();
  if (!ctx.registry.abandonQueued(id, endedAtMs)) {
    ctx.logger.warning(
      `lost the abandon-queued race for run '${id}' of script '${scriptName}'; it was started or ended before this queue-timeout could apply`,
      { runId: id, scriptName },
    );
    return;
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
}

/**
 * Arms `queueTimeoutMs` for a just-queued run. The returned handle is
 * `unref()`'d immediately when the method exists — an injected test
 * `timerImpl` may hand back a bare object without one, and an unfired timer
 * must never be what keeps a real process alive.
 */
function armQueueTimeout(
  ctx: M3LOrchestratorContext,
  id: string,
  scriptName: string,
  operator: string,
): void {
  const handle = ctx.timerImpl((): void => {
    onQueueTimeout(ctx, id, scriptName, operator);
  }, ctx.config.queueTimeoutMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }
  ctx.queueTimers.set(id, handle);
}

/**
 * Executes a claimed run to completion and records its outcome — every
 * settle path (fulfilled or rejected) funnels through {@link finishActiveRun},
 * so the executor's rejection is never swallowed: it is logged at `error`
 * with the cause's own message and recorded as a `'failure'` finish rather
 * than left as an unhandled rejection. Extracted out of {@link startRun} to
 * keep that function under the line-count limit.
 */
function executeAndSettle(
  ctx: M3LOrchestratorContext,
  id: string,
  resolved: M3LResolvedScript,
  body: M3LRunRequestBody,
  operator: string,
  controller: AbortController,
): Promise<void> {
  const executor = resolved.hasCommandModule
    ? ctx.inProcessExecutor
    : ctx.spawnExecutor;

  return executor
    .execute({
      scriptDir: resolved.scriptDir,
      parameters: body.parameters,
      dryRun: body.dryRun,
      signal: controller.signal,
      onLine: (line: string): void => {
        ctx.events.publish({ event: "run.line", runId: id, line });
      },
    })
    .then(
      (info) => {
        finishActiveRun(
          ctx,
          id,
          resolved.name,
          operator,
          mapSpawnOutcome(info),
          { exitCode: info.exitCode },
        );
      },
      (cause: unknown) => {
        const message = Core.getErrorMessage(cause);
        ctx.logger.error(`run '${id}' of script '${resolved.name}' failed`, {
          runId: id,
          scriptName: resolved.name,
          cause: message,
        });
        finishActiveRun(ctx, id, resolved.name, operator, "failure", {
          failureMessage: message,
        });
      },
    );
}

/**
 * Starts a run that has already been persisted as `'queued'` — either
 * immediately (the accept path of `launch`) or later (a queue pump).
 * `claimForStart` losing the race (returns `false`) means another caller
 * already transitioned this run away from `'queued'`; that is logged loudly
 * at `warning` rather than treated as a silent no-op, and this function
 * returns WITHOUT starting an executor or releasing the governor slot a
 * second time — the slot was already accounted for by whichever caller won
 * the race.
 */
function startRun(
  ctx: M3LOrchestratorContext,
  id: string,
  resolved: M3LResolvedScript,
  body: M3LRunRequestBody,
  operator: string,
): void {
  const startedAtMs = ctx.nowMs();
  if (!ctx.registry.claimForStart(id, startedAtMs)) {
    ctx.logger.warning(
      `lost the claim-for-start race for run '${id}' of script '${resolved.name}'; another caller already transitioned it away from 'queued'`,
      { runId: id, scriptName: resolved.name },
    );
    return;
  }

  ctx.events.publish({ event: "run.started", runId: id, atMs: startedAtMs });
  ctx.audit.record({
    action: "run.started",
    runId: id,
    scriptName: resolved.name,
    operator,
    atMs: startedAtMs,
    detail: {},
  });

  const controller = new AbortController();
  const promise = executeAndSettle(
    ctx,
    id,
    resolved,
    body,
    operator,
    controller,
  );
  ctx.active.set(id, {
    controller,
    scriptName: resolved.name,
    operator,
    promise,
  });
}

/**
 * Starts at most one queued run per call — the completion of that run pumps
 * again via {@link finishActiveRun}. Iterates every `'queued'` row
 * oldest-first and starts the FIRST one the governor accepts, skipping past
 * (never removing from the queue) any row the governor rejects.
 *
 * This is deliberately skip-on-busy rather than strict FIFO. At
 * `maxPerScript: 1`, a strict FIFO would head-of-line-block the entire queue
 * behind whichever script happens to be busy — every other queued run,
 * regardless of script, would wait for that one script to free up before
 * any of them could ever be considered.
 *
 * Returns immediately, before ever consulting the registry, once
 * `ctx.isDraining()` reports `true`. A drain in progress (or already
 * completed — the flag is never reset) must never start a queued run; queued
 * rows are left `'queued'` for the next boot's `reconcileOnBoot` to
 * reconcile.
 */
function pumpQueue(ctx: M3LOrchestratorContext): void {
  if (ctx.isDraining()) return;
  const limit = ctx.config.queueCapacity + ctx.config.maxConcurrency;
  const queuedRows = ctx.registry.list({ status: "queued", limit });
  for (const row of queuedRows) {
    const decision = ctx.governor.decide(row.script);
    if (decision.kind !== "accept") continue;
    const pending = ctx.pendingQueued.get(row.id);
    if (pending === undefined) continue;
    ctx.governor.accept(row.script);
    ctx.governor.dequeue();
    ctx.pendingQueued.delete(row.id);
    clearQueueTimeout(ctx, row.id);
    startRun(ctx, row.id, pending.resolved, pending.body, pending.operator);
    return;
  }
}

/**
 * Persists the `'queued'` row an admitted launch just decided on, then
 * publishes `run.queued` and audits `run.launch-allowed`. On an
 * `insertQueued` failure, undoes the governor commitment `admitRun` already
 * made (`release` for an accepted run, `dequeue` for a queued one) before
 * rethrowing the original error unchanged — extracted out of
 * {@link launchRun} to keep that function under the line-count limit.
 */
function persistQueuedRow(
  ctx: M3LOrchestratorContext,
  id: string,
  resolved: M3LResolvedScript,
  body: M3LRunRequestBody,
  operator: string,
  correlationId: string,
  executionMode: RunExecutionMode,
  accepted: boolean,
  attemptAtMs: number,
): void {
  try {
    ctx.registry.insertQueued({
      id,
      script: resolved.name,
      dryRun: body.dryRun,
      executionMode,
      parameters: body.parameters,
      operator,
      correlationId,
      queuedAtMs: attemptAtMs,
    });
  } catch (cause) {
    // A leaked slot is permanent: nothing else will ever call `release`/
    // `dequeue` for a run whose row was never written, so the governor's
    // commitment made just above MUST be undone here before the error
    // propagates, or this script's capacity silently shrinks forever.
    if (accepted) {
      ctx.governor.release(resolved.name);
    } else {
      ctx.governor.dequeue();
    }
    throw cause;
  }

  ctx.events.publish({
    event: "run.queued",
    runId: id,
    scriptName: resolved.name,
    dryRun: body.dryRun,
  });
  ctx.audit.record({
    action: "run.launch-allowed",
    runId: id,
    scriptName: resolved.name,
    operator,
    atMs: attemptAtMs,
    detail: { dryRun: body.dryRun, executionMode },
  });
}

/**
 * Validates the requested script, applies the confirmation policy and the
 * admission-control governor (via `runs/admission.ts`'s {@link admitRun}, in
 * that order), persists a `'queued'` row, and either starts it immediately
 * or arms its queue-timeout timer. See this module's own
 * {@link M3LRunOrchestrator.launch} TSDoc for the exact ordering and
 * failure-mode contract.
 */
function launchRun(
  ctx: M3LOrchestratorContext,
  request: M3LRunLaunchRequest,
): M3LRunHandle {
  const { body, operator, correlationId } = request;
  const attemptAtMs = ctx.nowMs();
  const admission = admitRun(
    {
      policy: ctx.policy,
      governor: ctx.governor,
      audit: ctx.audit,
      scriptsDir: ctx.config.scriptsDir,
    },
    body,
    operator,
    attemptAtMs,
  );
  const { resolved } = admission;
  const accepted = admission.kind === "accept";
  const id = ctx.newId();
  const executionMode = executionModeForScript(resolved);

  persistQueuedRow(
    ctx,
    id,
    resolved,
    body,
    operator,
    correlationId,
    executionMode,
    accepted,
    attemptAtMs,
  );

  if (accepted) {
    startRun(ctx, id, resolved, body, operator);
  } else {
    ctx.pendingQueued.set(id, { resolved, body, operator });
    armQueueTimeout(ctx, id, resolved.name, operator);
  }

  return {
    id,
    scriptName: resolved.name,
    status: accepted ? "running" : "queued",
    dryRun: body.dryRun,
    executionMode,
  };
}

/** Cancels an active run — see {@link M3LRunOrchestrator.cancel}'s own TSDoc for the "queued/finished always returns false" contract. */
function cancelRun(ctx: M3LOrchestratorContext, id: string): boolean {
  const entry = ctx.active.get(id);
  if (entry === undefined) return false;
  entry.controller.abort();
  ctx.audit.record({
    action: "run.cancelled",
    runId: id,
    scriptName: entry.scriptName,
    operator: entry.operator,
    atMs: ctx.nowMs(),
    detail: {},
  });
  return true;
}

/** The script/operator recorded on the boot-reconciliation audit entry, which is a bulk operation over every orphaned row rather than one run. */
const RECONCILE_AUDIT_SCRIPT = "*";
const RECONCILE_AUDIT_OPERATOR = "system";

/** Reconciles orphaned rows at boot — see {@link M3LRunOrchestrator.reconcileOnBoot}'s own TSDoc. */
function reconcileOnBoot(ctx: M3LOrchestratorContext): number {
  const endedAtMs = ctx.nowMs();
  const count = ctx.registry.reconcileOrphaned(endedAtMs);
  ctx.logger.info(`reconciled ${String(count)} orphaned run(s) at boot`, {
    count,
  });
  if (count > 0) {
    ctx.audit.record({
      action: "run.reconciled",
      runId: undefined,
      scriptName: RECONCILE_AUDIT_SCRIPT,
      operator: RECONCILE_AUDIT_OPERATOR,
      atMs: endedAtMs,
      detail: { count },
    });
  }
  return count;
}

/**
 * Aborts every active run's signal, then awaits every one of them settling —
 * see {@link M3LRunOrchestrator.drain}'s own TSDoc.
 *
 * Calls `ctx.markDraining()` first, which permanently closes {@link pumpQueue}
 * (never reset — a drained orchestrator is terminal). Then loops rather than
 * snapshotting `ctx.active` once: aborting the current snapshot can itself
 * cause a new entry to appear (a straggler from any source, not only a
 * `pumpQueue` start — `pumpQueue` is closed by the flag above, but e.g. a
 * `launch()` racing in during drain is not), so each iteration re-snapshots
 * and re-awaits until the active map is empty.
 */
async function drainActive(ctx: M3LOrchestratorContext): Promise<void> {
  ctx.markDraining();
  while (ctx.active.size > 0) {
    const entries = [...ctx.active.values()];
    for (const entry of entries) {
      entry.controller.abort();
    }
    await Promise.allSettled(entries.map((entry) => entry.promise));
  }
}

/**
 * Creates a {@link M3LRunOrchestrator}.
 *
 * @param options - See {@link M3LRunOrchestratorOptions}.
 * @param internals - Test-only injection seam; omit in production code.
 * @returns A fresh orchestrator with no active or queued runs.
 *
 * @example
 * ```ts
 * import { createRunOrchestrator } from "@m3l-automation/m3l-console-server/runs/orchestrator.js";
 *
 * // See composition.ts (Round 3) for the one-call factory main.ts uses.
 * declare const options: Parameters<typeof createRunOrchestrator>[0];
 * const orchestrator = createRunOrchestrator(options);
 * ```
 */
export function createRunOrchestrator(
  options: M3LRunOrchestratorOptions,
  internals: M3LRunOrchestratorInternals = {},
): M3LRunOrchestrator {
  // Backs `ctx.isDraining`/`ctx.markDraining` — see
  // `M3LOrchestratorContext.isDraining`'s TSDoc for why this lives in the
  // closure rather than as a mutable field on the (deeply readonly) context.
  let draining = false;
  const ctx: M3LOrchestratorContext = {
    config: options.config,
    registry: options.registry,
    governor: options.governor,
    policy: options.policy,
    audit: options.audit,
    events: options.events,
    spawnExecutor: options.spawnExecutor,
    inProcessExecutor: options.inProcessExecutor,
    logger: options.logger,
    newId: internals.newId ?? randomUUID,
    nowMs: internals.nowMs ?? Date.now,
    timerImpl: internals.timerImpl ?? setTimeout,
    active: new Map<string, M3LActiveRun>(),
    queueTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    pendingQueued: new Map<string, M3LPendingQueuedRun>(),
    isDraining: () => draining,
    markDraining: () => {
      draining = true;
    },
  };

  return {
    launch(request: M3LRunLaunchRequest): M3LRunHandle {
      return launchRun(ctx, request);
    },
    cancel(id: string): boolean {
      return cancelRun(ctx, id);
    },
    reconcileOnBoot(): number {
      return reconcileOnBoot(ctx);
    },
    get activeCount(): number {
      return ctx.active.size;
    },
    drain(): Promise<void> {
      return drainActive(ctx);
    },
  };
}
