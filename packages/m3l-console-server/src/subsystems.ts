/**
 * `subsystems` — builds the console server's optional X4/X6 subsystems (run
 * orchestration and workbench sessions), extracted out of `main.ts` (X6
 * workbench-sessions module, slice 4, Part B round 3, issue #554).
 *
 * This module is deliberately zone-free: it sits directly under `src/`, like
 * `main.ts`, rather than inside any `CONSOLE_SERVER_LAYERS` zone directory
 * (`bin/check-eslint-zones.mjs`), so it may import from both `runs/` and
 * `sessions/` — an import combination no single zone directory is allowed to
 * make. It exists purely because `main.ts` ran out of file-budget headroom
 * (`pnpm check:file-budget`, 25,000-byte ceiling) to grow the sessions half
 * of this wiring inline; moving `buildRunSubsystem` here first is what freed
 * the room.
 *
 * The one genuinely tricky piece is a construction-order cycle: the session
 * subsystem needs the run subsystem's orchestrator as its `launcher` (a
 * session step launches a run through that port), but the run subsystem
 * needs to know about the session subsystem's event sink (via
 * `extraEventSinks`) AT CONSTRUCTION TIME, before the session subsystem
 * exists. Neither subsystem can be built strictly before the other. The
 * cycle is broken with a local closure-based forwarding sink: an
 * {@link M3LRunEventSink} built BEFORE either subsystem, passed as the run
 * subsystem's one `extraEventSinks` member, whose target starts `undefined`
 * (so a run event fired before the session subsystem exists is silently
 * dropped) and is mutated to point at the real session event sink the
 * instant it is built, a few lines later in the same synchronous call.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";

import type { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleRunsConfig } from "./config/runs.js";
import { tryLoadRunsConfig } from "./config/runs.js";
import type { M3LConsoleSessionsConfig } from "./config/sessions.js";
import { loadSessionsConfig } from "./config/sessions.js";
import {
  resolveRunsOutputRoot,
  resolveSessionArtifactRoot,
} from "./config/paths.js";
import { createRunSubsystem } from "./runs/composition.js";
import type { M3LRunSubsystem } from "./runs/composition.js";
import type { M3LRunEventSink } from "./runs/events.js";
import type { M3LRunRegistry } from "./runs/registry.js";
import { createSessionSubsystem } from "./sessions/composition.js";
import type { M3LSessionSubsystem } from "./sessions/composition.js";
import type { M3LSessionRunEventSink } from "./sessions/ports.js";
import type { M3LConsoleSessionsRepository } from "./store/sessions-repository.js";

/** The env var naming the X4 scripts directory, named in the run-disabled posture line. */
const RUNS_SCRIPTS_DIR_ENV = "M3L_CONSOLE_RUNS_SCRIPTS_DIR";

/** The env var naming the X6 session artifact storage root; see `config/paths.ts`'s `resolveSessionArtifactRoot`. */
const SESSIONS_ARTIFACT_ROOT_ENV = "M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT";

/** The env var naming the X7d runs output root; see `config/paths.ts`'s `resolveRunsOutputRoot`. */
const RUNS_OUTPUT_ROOT_ENV = "M3L_CONSOLE_RUNS_OUTPUT_ROOT";

/**
 * Constructor options for {@link buildConsoleSubsystems}, mirroring the
 * subset of `main.ts`'s `M3LConsoleRuntimeOptions` each subsystem needs.
 *
 * @example
 * ```ts
 * const options: M3LConsoleSubsystemsOptions = { env: process.env };
 * ```
 */
export interface M3LConsoleSubsystemsOptions {
  /** The environment variable map to resolve subsystem configuration from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The run-persistence port the X4 run subsystem builds from, when supplied. */
  readonly runs?: M3LRunRegistry;
  /** Pre-resolved X4 run-governor config; skips `tryLoadRunsConfig` when supplied. */
  readonly runsConfig?: M3LConsoleRunsConfig;
  /** The workbench-sessions persistence port the X6 session subsystem builds from, when supplied. */
  readonly sessions?: M3LConsoleSessionsRepository;
  /** Pre-resolved X6 workbench-sessions config; skips `loadSessionsConfig` when supplied. */
  readonly sessionsConfig?: M3LConsoleSessionsConfig;
}

/**
 * The console server's optional subsystems, each present only when its own
 * preconditions were met (see {@link buildConsoleSubsystems}).
 *
 * @example
 * ```ts
 * function describe(subsystems: M3LConsoleSubsystems): string {
 *   return subsystems.runs === undefined ? "run orchestration disabled" : "enabled";
 * }
 * ```
 */
export interface M3LConsoleSubsystems {
  /** The wired X4 run subsystem, present only when a runs config resolved AND `options.runs` was supplied. */
  readonly runs?: M3LRunSubsystem;
  /** The wired X6 session subsystem, present only when `options.sessions` was supplied AND the run subsystem built successfully. */
  readonly sessions?: M3LSessionSubsystem;
}

/**
 * Builds the X4 run subsystem when `options.runs` was supplied AND a runs
 * config resolved (`options.runsConfig` verbatim, else `tryLoadRunsConfig`);
 * else `undefined`, logging one `warning` posture line. Checks `options.runs`
 * FIRST — nothing to wire a resolved config to without a registry, and
 * skipping config resolution (and the warning) entirely when no registry was
 * ever supplied is what keeps every existing caller that never mentions
 * `runs` silent; the warning only fires once a caller has actually opted in
 * by supplying one. `extraEventSinks` is threaded straight into
 * `createRunSubsystem`'s own option of the same name — see this module's
 * `@packageDocumentation` for why {@link buildConsoleSubsystems} always
 * passes exactly one entry here (the forwarding sink).
 *
 * Relocated verbatim from `main.ts` (X6 slice 4, Part B round 3) plus the new
 * `extraEventSinks` parameter.
 *
 * X7d additionally resolves the runs output root from
 * `M3L_CONSOLE_RUNS_OUTPUT_ROOT` off the same env map, mirroring
 * {@link buildSessionSubsystem}'s own artifact-root resolution. It is
 * resolved ONCE here and passed down, so the orchestrator (which pins each
 * child's `M3L_OUTPUT_DIR` beneath it) and the report reader (which looks
 * for the report there) can never disagree about where a run's output lives
 * — two independent resolutions would agree today and diverge silently the
 * moment either side's default changed, and the failure mode is a permanent
 * 404 on every run report.
 */
function buildRunSubsystem(
  options: M3LConsoleSubsystemsOptions,
  logger: Core.M3LLogger,
  extraEventSinks: readonly M3LRunEventSink[],
): M3LRunSubsystem | undefined {
  if (options.runs === undefined) return undefined;
  const env = options.env ?? process.env;
  const config: M3LConsoleRunsConfig | undefined =
    options.runsConfig ?? tryLoadRunsConfig(env);
  if (config === undefined) {
    logger.warning("run orchestration disabled: scripts directory unset", {
      variable: RUNS_SCRIPTS_DIR_ENV,
    });
    return undefined;
  }
  return createRunSubsystem({
    config,
    logger,
    registry: options.runs,
    extraEventSinks,
    runsOutputRoot: resolveRunsOutputRoot({
      configuredPath: env[RUNS_OUTPUT_ROOT_ENV],
    }),
  });
}

/**
 * Builds the X6 session subsystem when `options.sessions` was supplied AND
 * `launcher` is defined (i.e. the run subsystem built successfully — a
 * session step launches a run through that port); else `undefined`. Checks
 * `options.sessions` FIRST, mirroring {@link buildRunSubsystem}'s own
 * ordering: a caller who never mentions `sessions` stays silent, and the
 * warning only fires once a caller has actually opted in by supplying a
 * sessions repository but run orchestration is not available to serve it.
 *
 * Resolves `options.sessionsConfig` verbatim if supplied, else
 * `loadSessionsConfig({ env: options.env })`, and the session artifact root
 * from `resolveSessionArtifactRoot` reading
 * `M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT` off the same env map.
 */
function buildSessionSubsystem(
  options: M3LConsoleSubsystemsOptions,
  logger: Core.M3LLogger,
  launcher: M3LRunSubsystem["orchestrator"] | undefined,
): M3LSessionSubsystem | undefined {
  if (options.sessions === undefined) return undefined;
  if (launcher === undefined) {
    logger.warning(
      "session workbench disabled: run orchestration is unavailable",
      { reason: "no run launcher" },
    );
    return undefined;
  }

  const env = options.env ?? process.env;
  const config = options.sessionsConfig ?? loadSessionsConfig({ env });
  const artifactRoot = resolveSessionArtifactRoot({
    configuredPath: env[SESSIONS_ARTIFACT_ROOT_ENV],
  });

  return createSessionSubsystem({
    sessionsRepository: options.sessions,
    artifactRoot,
    artifactCaps: config,
    openSessionsMax: config.openSessionsMax,
    launcher,
    logger,
    newId: randomUUID,
    nowMs: Date.now,
  });
}

/**
 * Builds the console server's optional subsystems: the X4 run subsystem
 * (see {@link buildRunSubsystem}) and the X6 session subsystem (see
 * {@link buildSessionSubsystem}), wired together with a forwarding sink that
 * breaks their construction-order cycle — see this module's own
 * `@packageDocumentation` for the full rationale.
 *
 * @param options - See {@link M3LConsoleSubsystemsOptions}.
 * @param logger - The logger every posture-warning line and session
 *   event-handling failure logs through.
 * @returns The resolved {@link M3LConsoleSubsystems}.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { buildConsoleSubsystems } from "./subsystems.js";
 *
 * const subsystems = buildConsoleSubsystems(
 *   { env: process.env },
 *   new Core.M3LLogger([]),
 * );
 * subsystems.runs?.orchestrator.reconcileOnBoot();
 * ```
 */
export function buildConsoleSubsystems(
  options: M3LConsoleSubsystemsOptions,
  logger: Core.M3LLogger,
): M3LConsoleSubsystems {
  // A mutable BOX (never itself reassigned — only its `.current` property
  // is mutated), not a `let` variable: the closure below must read the
  // latest target on every publish, and `prefer-const` would otherwise
  // reject a `let` that is only ever assigned once after declaration.
  const forwardingTarget: { current: M3LSessionRunEventSink | undefined } = {
    current: undefined,
  };
  const forwardingSink: M3LRunEventSink = {
    publish(event) {
      forwardingTarget.current?.publish(event);
    },
  };

  const runs = buildRunSubsystem(options, logger, [forwardingSink]);
  const sessions = buildSessionSubsystem(options, logger, runs?.orchestrator);
  forwardingTarget.current = sessions?.eventSink;

  return {
    ...(runs !== undefined && { runs }),
    ...(sessions !== undefined && { sessions }),
  };
}
