/**
 * `runs/orchestrator-context` — the internal state bag `runs/orchestrator.ts`
 * threads through every one of its helpers.
 *
 * TYPES ONLY, deliberately. An earlier revision also parked
 * `clearQueueTimeout` here, which made this the one module whose entire
 * executable surface was a single no-op guard — it failed the per-file
 * coverage gate, and the "fix" would have been a test asserting that calling
 * a no-op twice does nothing. The helper moved to
 * `runs/orchestrator-cancel.ts`, beside its main caller, and this file went
 * back to carrying no behaviour at all.
 *
 * A BYTE-BUDGET split, exactly like `runs/orchestrator-types.ts`: there is no
 * layering decision here. `orchestrator.ts` reached ADR-0072's 25,000-char
 * ceiling when X7d extended cancellation, and this is the part with no
 * behaviour in it. Nothing outside `runs/` names these types.
 *
 * It exists as its own module rather than living in `orchestrator-types.ts`
 * for one concrete reason: `runs/orchestrator-cancel.ts` needs
 * {@link M3LOrchestratorContext}, and `orchestrator.ts` needs
 * `orchestrator-cancel.ts` — putting the context anywhere `orchestrator.ts`
 * owns would make that a cycle, which `bin/check-eslint-zones.mjs`'s no-cycle
 * guard forbids.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import type { M3LRunAuditSink } from "./audit.js";
import type { M3LRunEventSink } from "./events.js";
import type { M3LRunExecutor } from "./executor.js";
import type { M3LRunGovernor } from "./governor.js";
import type { M3LRunOrchestratorConfig } from "./orchestrator-types.js";
import type { M3LRunRequestBody } from "./parameters.js";
import type { M3LRunPolicy } from "./policy.js";
import type { M3LRunRegistry } from "./registry.js";
import type { M3LResolvedScript } from "./resolver.js";
import type { M3LTelemetryRecorder } from "../telemetry/port.js";

/** One currently-active (started, not yet settled) run. */
export interface M3LActiveRun {
  readonly controller: AbortController;
  readonly scriptName: string;
  readonly operator: string;
  readonly promise: Promise<void>;
}

/** A queued run's originally-resolved script and request, kept so a later pump or timeout never has to re-derive them. */
export interface M3LPendingQueuedRun {
  readonly resolved: M3LResolvedScript;
  readonly body: M3LRunRequestBody;
  readonly operator: string;
  /**
   * The launching request's correlation id, carried through the queue.
   *
   * This is why correlation is threaded EXPLICITLY rather than through an
   * `AsyncLocalStorage`. {@link pumpQueue} starts a queued run from inside a
   * DIFFERENT run's completion continuation ({@link finishActiveRun}), so an
   * ambient store would attribute this run's work to whichever request
   * happened to finish first. `onQueueTimeout` and `reconcileOnBoot` have no
   * ambient context at all. Only a value stored with the queued run survives
   * the queue.
   */
  readonly correlationId: string;
}

/**
 * Everything {@link startRun} needs to begin one run.
 *
 * A bag rather than a sixth positional parameter: {@link executeAndSettle}
 * already took six, and the two share every field but the abort controller.
 */
export interface M3LRunStartInput {
  readonly id: string;
  readonly resolved: M3LResolvedScript;
  readonly body: M3LRunRequestBody;
  readonly operator: string;
  readonly correlationId: string;
}

/**
 * Every collaborator and piece of mutable state the orchestrator's helper
 * functions share, bundled so each helper takes one argument instead of
 * eight. Exported only so the sibling modules named in this file's header
 * can name it; nothing outside `runs/` does.
 */
export interface M3LOrchestratorContext {
  readonly config: M3LRunOrchestratorConfig;
  readonly registry: M3LRunRegistry;
  readonly governor: M3LRunGovernor;
  readonly policy: M3LRunPolicy;
  readonly audit: M3LRunAuditSink;
  readonly events: M3LRunEventSink;
  readonly spawnExecutor: M3LRunExecutor;
  readonly inProcessExecutor: M3LRunExecutor;
  readonly logger: Core.M3LLogger;
  /** See {@link M3LRunOrchestratorOptions.runsOutputRoot}. */
  readonly runsOutputRoot: string;
  /**
   * The telemetry recorder `recordFinish` reports one `runFinished` sample
   * to per ACTIVE-run terminal write. Always present here — the optionality
   * lives at the `M3LRunOrchestratorOptions.telemetry` boundary, resolved to
   * the no-op recorder by {@link createRunOrchestrator} the same way
   * `nowMs`/`timerImpl` are resolved from `internals`.
   */
  readonly telemetry: M3LTelemetryRecorder;
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
export interface M3LFinishExtra {
  readonly exitCode?: number;
  readonly failureMessage?: string;
}
