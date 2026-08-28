/**
 * `runs/composition` — `createRunSubsystem`, the X4 run-governor's one-call
 * factory: builds every Round 1 collaborator a real deployment needs (the
 * governor, the confirmation policy, an audit sink, the run-event stream hub
 * and its composite logger+stream sink, both executors) from `config` and
 * `registry` alone, and wires them into a real {@link M3LRunOrchestrator}.
 *
 * This exists so `main.ts` grows by one line of wiring
 * (`createRunSubsystem({ config, logger, registry })`) instead of eight
 * separate factory calls — `main.ts` sits at 21,990 of its 25,000-char
 * budget, and inlining this slice's wiring there would have pushed it over.
 *
 * Slice 7a also makes this factory the run-event stream hub's owner, for the
 * same budget reason plus a better one: `main.ts` has essentially no
 * headroom left, but more importantly the hub's lifecycle (open at boot,
 * `endAll("draining")` at shutdown) genuinely belongs beside the orchestrator
 * that publishes into it, not in the composition root. `main.ts` reaches it
 * at `subsystem.eventHub` to wire the HTTP stream route.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import { createEventStreamHub } from "../stream/event-stream.js";
import type { M3LEventStreamHub } from "../stream/event-stream.js";

import { createLoggerAuditSink } from "./audit.js";
import {
  createCompositeRunEventSink,
  createLoggerRunEventSink,
} from "./events.js";
import type { M3LRunEvent } from "./events.js";
import { createInProcessExecutor, createSpawnExecutor } from "./executor.js";
import { createRunGovernor } from "./governor.js";
import { createRunOrchestrator } from "./orchestrator.js";
import type {
  M3LRunOrchestrator,
  M3LRunOrchestratorConfig,
} from "./orchestrator.js";
import { createConfirmationPolicy } from "./policy.js";
import type { M3LRunRegistry } from "./registry.js";
import { createStreamRunEventSink } from "./stream-events.js";

/**
 * Constructor options for {@link createRunSubsystem}.
 *
 * `config` is deliberately typed as {@link M3LRunOrchestratorConfig} — the
 * orchestrator's own locally-declared, zone-legal shape — and NOT the
 * `config/runs.js` `M3LConsoleRunsConfig` the spec's prose names: `runs/` may
 * never import `config/`, not even type-only (`no-restricted-paths` does not
 * distinguish), so this module reuses the port `orchestrator.ts` already
 * declared rather than adding a second identical local copy. `main.ts`
 * passing the real `M3LConsoleRunsConfig` is the compiler-checked proof that
 * the two shapes conform.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { M3LRunSubsystemOptions } from "@m3l-automation/m3l-console-server/runs/composition.js";
 * import type { M3LRunRegistry } from "@m3l-automation/m3l-console-server/runs/registry.js";
 *
 * declare const registry: M3LRunRegistry;
 *
 * const options: M3LRunSubsystemOptions = {
 *   config: {
 *     scriptsDir: "/opt/scripts",
 *     maxPerScript: 1,
 *     queueCapacity: 16,
 *     streamRetention: 256,
 *     killTimeoutMs: 5000,
 *     maxConcurrency: 4,
 *     queueTimeoutMs: 30_000,
 *   },
 *   logger: new Core.M3LLogger([]),
 *   registry,
 * };
 * ```
 */
export interface M3LRunSubsystemOptions {
  /** The run governor's resolved boot-time configuration. */
  readonly config: M3LRunOrchestratorConfig;
  /** The logger every logger-backed sink and the orchestrator itself log through. */
  readonly logger: Core.M3LLogger;
  /** The run-persistence port — `main.ts` passes the real store's `runs` repository. */
  readonly registry: M3LRunRegistry;
}

/**
 * The wired X4 run subsystem: a working {@link M3LRunOrchestrator} plus a
 * top-level `drain()`.
 *
 * `drain()` is a field on `M3LRunSubsystem` itself, not merely reachable via
 * `orchestrator.drain()`, even though the two delegate to the same
 * implementation — this is deliberate, not redundant. `lifecycle/`'s zone
 * may import only `lifecycle`, `errors`, `net`, so `lifecycle/shutdown.ts`
 * can never import `runs/` to name `M3LRunOrchestrator` or
 * `M3LRunSubsystem` directly. Its `M3LShutdownDrainable` port instead
 * declares `drain(): Promise<void>` structurally, and because that method
 * sits at THIS type's top level, `M3LRunSubsystem` satisfies that port
 * without either module ever importing the other.
 *
 * @example
 * ```ts
 * import type { M3LRunSubsystem } from "@m3l-automation/m3l-console-server/runs/composition.js";
 *
 * declare const subsystem: M3LRunSubsystem;
 * subsystem.orchestrator.activeCount; // 0
 * subsystem.eventHub.openCount; // 0
 * ```
 */
export interface M3LRunSubsystem {
  /** The wired run orchestrator. */
  readonly orchestrator: M3LRunOrchestrator;
  /**
   * The run-event stream hub this subsystem owns: created with
   * `bufferSize: config.streamRetention` and wired as one member of the
   * orchestrator's composite event sink (see {@link createRunSubsystem}'s
   * own TSDoc for why ownership sits here rather than in `main.ts`). The HTTP
   * layer subscribes to it to serve `GET /api/v1/runs/:id/stream`, but never
   * creates or closes it itself.
   */
  readonly eventHub: M3LEventStreamHub<M3LRunEvent>;
  /**
   * Aborts every in-flight run and resolves once they have all settled.
   * Delegates to {@link M3LRunOrchestrator.drain} — see this interface's own
   * TSDoc for why the method is duplicated at this top level rather than
   * left reachable only via `orchestrator.drain()`.
   */
  drain(): Promise<void>;
}

/**
 * Builds a working {@link M3LRunSubsystem} from `options.config` and
 * `options.registry` alone: a governor sized from `config`'s concurrency and
 * queue knobs, the confirmation policy, a logger-backed audit sink, a
 * run-event stream hub sized by `config.streamRetention` plus the composite
 * event sink that fans out to both a logger-backed sink and a
 * stream-backed sink (both over `options.logger` / the new hub), a spawn
 * executor sized from `config.killTimeoutMs`, and an in-process executor —
 * then wires every one of them into a real {@link createRunOrchestrator}.
 *
 * The fan-out is deliberate, not redundant: the logger sink keeps recording
 * lifecycle events so a console with no stream watcher still logs run
 * activity, while the stream sink receives everything — including
 * `run.line`, which the logger sink drops (see `events.ts`'s own TSDoc).
 *
 * @param options - See {@link M3LRunSubsystemOptions}.
 * @returns The wired {@link M3LRunSubsystem}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { createRunSubsystem } from "@m3l-automation/m3l-console-server/runs/composition.js";
 * import type { M3LRunRegistry } from "@m3l-automation/m3l-console-server/runs/registry.js";
 *
 * declare const registry: M3LRunRegistry;
 *
 * const subsystem = createRunSubsystem({
 *   config: {
 *     scriptsDir: "/opt/scripts",
 *     maxPerScript: 1,
 *     queueCapacity: 16,
 *     streamRetention: 256,
 *     killTimeoutMs: 5000,
 *     maxConcurrency: 4,
 *     queueTimeoutMs: 30_000,
 *   },
 *   logger: new Core.M3LLogger([]),
 *   registry,
 * });
 * subsystem.orchestrator.reconcileOnBoot();
 * ```
 */
export function createRunSubsystem(
  options: M3LRunSubsystemOptions,
): M3LRunSubsystem {
  const { config, logger, registry } = options;

  const governor = createRunGovernor({
    maxConcurrency: config.maxConcurrency,
    maxPerScript: config.maxPerScript,
    queueCapacity: config.queueCapacity,
  });
  const policy = createConfirmationPolicy();
  const audit = createLoggerAuditSink(logger);
  const eventHub = createEventStreamHub<M3LRunEvent>({
    bufferSize: config.streamRetention,
  });
  const events = createCompositeRunEventSink(
    [createLoggerRunEventSink(logger), createStreamRunEventSink(eventHub)],
    logger,
  );
  const spawnExecutor = createSpawnExecutor({
    killTimeoutMs: config.killTimeoutMs,
  });
  const inProcessExecutor = createInProcessExecutor();

  const orchestrator = createRunOrchestrator({
    config,
    registry,
    governor,
    policy,
    audit,
    events,
    spawnExecutor,
    inProcessExecutor,
    logger,
  });

  return {
    orchestrator,
    eventHub,
    drain(): Promise<void> {
      return orchestrator.drain();
    },
  };
}
