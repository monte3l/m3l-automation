/**
 * `sessions/composition` — `createSessionSubsystem`, the X6
 * workbench-sessions module's one-call factory (slice 4, Part B round 1,
 * issue #554): builds a real {@link M3LSessionArtifactStore} from
 * `options.artifactRoot`/`options.artifactCaps`, wires it and the other
 * injected collaborators into a real {@link M3LSessionService}, and adapts
 * that service's `handleRunEvent` into a fire-and-forget
 * {@link M3LSessionRunEventSink} the `runs/` composition root's
 * `extraEventSinks` hook can accept without `sessions/` and `runs/` ever
 * importing each other (see `runs/composition.ts`'s own TSDoc on
 * `extraEventSinks` for the zone-allowance rationale).
 *
 * This exists for the same reason `runs/composition.ts` exists: so `main.ts`
 * grows by one wiring call (`createSessionSubsystem({ ... })`) instead of a
 * separate `createSessionArtifactStore` call plus a separate
 * `createSessionService` call plus hand-rolling the event-sink adapter
 * itself — three call sites collapsed into one, all three of which the
 * `sessions` zone's own allowance (`sessions`, `errors`, `store` —
 * `bin/check-eslint-zones.mjs`'s `CONSOLE_SERVER_LAYERS`) permits this
 * module to make directly.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import { createSessionArtifactStore } from "./artifacts.js";
import type { CreateSessionArtifactStoreOptions } from "./artifacts.js";
import type {
  M3LSessionRunEvent,
  M3LSessionRunEventSink,
  M3LSessionRunLauncherPort,
} from "./ports.js";
import { createSessionService } from "./service.js";
import type { M3LSessionService } from "./service.js";
import type { M3LConsoleSessionsRepository } from "../store/sessions-repository.js";

/**
 * Constructor options for {@link createSessionSubsystem}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { M3LSessionSubsystemOptions } from "@m3l-automation/m3l-console-server/sessions/composition.js";
 * import type { M3LConsoleSessionsRepository } from "@m3l-automation/m3l-console-server/store/sessions-repository.js";
 * import type { M3LSessionRunLauncherPort } from "@m3l-automation/m3l-console-server/sessions/ports.js";
 *
 * declare const sessionsRepository: M3LConsoleSessionsRepository;
 * declare const launcher: M3LSessionRunLauncherPort;
 *
 * const options: M3LSessionSubsystemOptions = {
 *   sessionsRepository,
 *   artifactRoot: "/var/lib/m3l/console/artifacts",
 *   artifactCaps: {
 *     artifactInlineMaxBytes: 65_536,
 *     artifactMaxBytes: 33_554_432,
 *     sessionTotalMaxBytes: 268_435_456,
 *   },
 *   openSessionsMax: 10,
 *   launcher,
 *   logger: new Core.M3LLogger([]),
 *   newId: () => crypto.randomUUID(),
 *   nowMs: () => Date.now(),
 * };
 * ```
 */
export interface M3LSessionSubsystemOptions {
  /** The workbench-sessions repository — `main.ts` passes the real store's `sessions` repository. */
  readonly sessionsRepository: M3LConsoleSessionsRepository;
  /** The directory file-backed artifacts are written under — see `sessions/artifacts.ts`'s `CreateSessionArtifactStoreOptions.root`. */
  readonly artifactRoot: string;
  /** The byte-size caps the constructed artifact store enforces — an alias of `sessions/artifacts.ts`'s `CreateSessionArtifactStoreOptions.config` (its own `M3LSessionArtifactCaps` type is private), so this field can never drift from what the constructed store actually accepts. */
  readonly artifactCaps: CreateSessionArtifactStoreOptions["config"];
  /** The maximum number of sessions allowed open at once. */
  readonly openSessionsMax: number;
  /** The run-launching port — `main.ts` passes the real `M3LRunOrchestrator`, which satisfies this structurally. */
  readonly launcher: M3LSessionRunLauncherPort;
  /** The logger the constructed event sink's failure path logs through. */
  readonly logger: Core.M3LLogger;
  /** Generates a fresh id for a newly created session/step/decision. */
  readonly newId: () => string;
  /** The current time, in epoch milliseconds — injected for determinism. */
  readonly nowMs: () => number;
}

/**
 * The wired X6 workbench-sessions subsystem: a working
 * {@link M3LSessionService} plus the {@link M3LSessionRunEventSink} adapter
 * that drives it from run-lifecycle events.
 *
 * @example
 * ```ts
 * import type { M3LSessionSubsystem } from "@m3l-automation/m3l-console-server/sessions/composition.js";
 *
 * declare const subsystem: M3LSessionSubsystem;
 * subsystem.service.createSession("alice", "corr-1");
 * ```
 */
export interface M3LSessionSubsystem {
  /** The wired session service. */
  readonly service: M3LSessionService;
  /**
   * Adapts `service.handleRunEvent` into a never-throws-synchronously
   * {@link M3LSessionRunEventSink}, suitable for passing directly into
   * `runs/composition.ts`'s `createRunSubsystem`'s own
   * `options.extraEventSinks` — that hook exists specifically so the real
   * run subsystem can fan every run event out to this sink without `runs/`
   * ever importing `sessions/`.
   */
  readonly eventSink: M3LSessionRunEventSink;
}

/**
 * Builds a working {@link M3LSessionSubsystem} from `options` alone: a real
 * {@link M3LSessionArtifactStore} constructed from `options.artifactRoot`/
 * `options.artifactCaps`, a real {@link M3LSessionService} wired over it and
 * `options.sessionsRepository`/`options.launcher`/`options.openSessionsMax`/
 * `options.newId`/`options.nowMs`, and a fire-and-forget event-sink adapter
 * over that service's `handleRunEvent`.
 *
 * The adapter's `publish` never throws and never returns a `Promise` — it
 * fires `service.handleRunEvent(event)` and attaches a `.catch()` that logs
 * any rejection through `options.logger` rather than letting it surface as
 * an unhandled rejection, mirroring `http/handler.ts`'s
 * `requestListener`/`runs/events.ts`'s composite sink's own established
 * fire-and-forget idiom for a port that documents "never throws" as its
 * contract.
 *
 * @param options - See {@link M3LSessionSubsystemOptions}.
 * @returns The wired {@link M3LSessionSubsystem}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { createSessionSubsystem } from "@m3l-automation/m3l-console-server/sessions/composition.js";
 * import type { M3LConsoleSessionsRepository } from "@m3l-automation/m3l-console-server/store/sessions-repository.js";
 * import type { M3LSessionRunLauncherPort } from "@m3l-automation/m3l-console-server/sessions/ports.js";
 *
 * declare const sessionsRepository: M3LConsoleSessionsRepository;
 * declare const launcher: M3LSessionRunLauncherPort;
 *
 * const subsystem = createSessionSubsystem({
 *   sessionsRepository,
 *   artifactRoot: "/var/lib/m3l/console/artifacts",
 *   artifactCaps: {
 *     artifactInlineMaxBytes: 65_536,
 *     artifactMaxBytes: 33_554_432,
 *     sessionTotalMaxBytes: 268_435_456,
 *   },
 *   openSessionsMax: 10,
 *   launcher,
 *   logger: new Core.M3LLogger([]),
 *   newId: () => crypto.randomUUID(),
 *   nowMs: () => Date.now(),
 * });
 * subsystem.service.createSession("alice", "corr-1");
 * ```
 */
export function createSessionSubsystem(
  options: M3LSessionSubsystemOptions,
): M3LSessionSubsystem {
  const artifactStore = createSessionArtifactStore({
    root: options.artifactRoot,
    config: options.artifactCaps,
  });
  const service = createSessionService({
    sessionsRepository: options.sessionsRepository,
    artifactStore,
    launcher: options.launcher,
    openSessionsMax: options.openSessionsMax,
    newId: options.newId,
    nowMs: options.nowMs,
  });

  const eventSink: M3LSessionRunEventSink = {
    publish(event: M3LSessionRunEvent): void {
      service.handleRunEvent(event).catch((cause: unknown) => {
        options.logger.error("session run-event handling failed", {
          cause,
          runId: event.runId,
        });
      });
    },
  };

  return { service, eventSink };
}
