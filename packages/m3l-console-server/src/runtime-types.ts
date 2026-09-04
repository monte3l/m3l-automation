/**
 * `runtime-types` — the composition root's public shape:
 * {@link M3LConsoleRuntimeOptions} (what a caller may inject) and
 * {@link M3LConsoleRuntime} (what it gets back).
 *
 * Kept as its own module rather than inline in `main.ts` because these two
 * interfaces ARE the console server's programmatic contract — every
 * subsystem and test reads them — and that contract is worth reading on its
 * own, without the several hundred lines of socket binding, signal
 * registration and drain wiring that surround it in the composition root.
 * Splitting them out also clears headroom under `main.ts`'s per-file size
 * budget, which it had all but exhausted. `main.ts` re-exports both, so the
 * split is invisible to importers.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import type { M3LHumanActionAuditPort } from "./audit/port.js";
import type {
  M3LOperatorProfile,
  M3LOperatorProvider,
} from "./auth/identity.js";
import type { M3LConsoleConfig } from "./config/env.js";
import type { M3LConsoleRunsConfig } from "./config/runs.js";
import type { M3LConsoleSessionsConfig } from "./config/sessions.js";
import type { M3LConsoleRequestListener } from "./http/handler.js";
import type { M3LRoute, M3LRouter } from "./http/router.js";
import type { M3LDrainController } from "./lifecycle/drain.js";
import type { M3LRunSubsystem } from "./runs/composition.js";
import type { M3LRunRegistry } from "./runs/registry.js";
import type { M3LSessionSubsystem } from "./sessions/composition.js";
import type { M3LConsoleAuditRepository } from "./store/audit-repository.js";
import type { M3LConsoleSessionsRepository } from "./store/sessions-repository.js";
import type {
  M3LConsoleStoreHandle,
  M3LConsoleStoreLifecycle,
} from "./store/store.js";
import type { M3LConsoleTelemetryRepository } from "./store/telemetry-repository.js";
import type { M3LTelemetryRecorder } from "./telemetry/port.js";

/**
 * Constructor options for {@link createConsoleRuntime}.
 *
 * @example
 * ```ts
 * const options: M3LConsoleRuntimeOptions = { env: process.env };
 * ```
 */
export interface M3LConsoleRuntimeOptions {
  /** The environment variable map to resolve configuration from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Log sinks the runtime's logger fans events out to; defaults to a single
   * {@link Core.M3LJsonLoggerHandler} floored at the resolved
   * {@link M3LConsoleConfig.logLevel} — a daemon's output is machine-read,
   * so JSON lines rather than the pretty console handler.
   */
  readonly handlers?: readonly Core.M3LLoggerHandler[];
  /**
   * Additional routes registered alongside the built-in health routes (see
   * {@link createConsoleRuntime}). Defaults to an empty table. Exposed so
   * tests can drive the request listener without a live server.
   *
   * **A route supplied here is NOT audited.** `boot/dispatch-router.ts`
   * applies the ADR-0070 human-action audit gate to the console's OWN routes
   * and then appends this table verbatim, so no entry is recorded for a route
   * registered through this option — not even a write. That is deliberate,
   * not an oversight: `applyHumanActionAudit`'s spec table is keyed by this
   * console's own path templates, so it can never hold a spec for a route a
   * caller invented, and enforcing its exhaustiveness guard against those
   * would make this seam unusable — every caller route would fail boot. The
   * console's own write routes are all audited, and adding an unaudited one
   * still fails at boot. See `boot/human-action-audit.ts`'s
   * `applyHumanActionAudit` for the full boundary.
   */
  readonly routes?: readonly M3LRoute[];
  /** Pre-resolved config; when supplied, `loadConsoleConfig` is skipped (see {@link startConsole}). */
  readonly config?: M3LConsoleConfig;
  /** The opened console store (ADR-0069), when the caller already has one. */
  readonly store?: M3LConsoleStoreHandle;
  /** Pre-resolved X4 run-governor config; skips `loadRunsConfig` (mirrors {@link config}). */
  readonly runsConfig?: M3LConsoleRunsConfig;
  /** The run-persistence port the X4 run subsystem builds from; see {@link createConsoleRuntime}. */
  readonly runs?: M3LRunRegistry;
  /** Pre-resolved X6 workbench-sessions config; skips `loadSessionsConfig` (mirrors {@link runsConfig}). */
  readonly sessionsConfig?: M3LConsoleSessionsConfig;
  /** The workbench-sessions persistence port the X6 session subsystem builds from; see {@link createConsoleRuntime}. */
  readonly sessions?: M3LConsoleSessionsRepository;
  /**
   * The ADR-0070 SQLite audit INDEX every trail entry is additionally
   * projected into (X7c). Supplied as a sibling of `runs`/`sessions` rather
   * than reached through {@link store}, which is typed
   * {@link M3LConsoleStoreHandle} and carries no repositories.
   *
   * When absent — a storeless console, which {@link store} being optional
   * makes a supported state — {@link auditPort} stays the bare JSONL stream
   * and no index row is written. The trail is unaffected either way: it is
   * the source of truth, and the index is a derived projection of it (see
   * `boot/audit-index.ts`).
   */
  readonly audit?: M3LConsoleAuditRepository;
  /**
   * The ADR-0070 human-action audit port. Defaults to a JSONL stream rooted
   * at `M3L_CONSOLE_AUDIT_ROOT` (or the data dir's `console/audit`), wrapped
   * by `boot/audit-index.ts`'s dual-write port when {@link audit} is
   * supplied.
   *
   * Injectable purely as a test seam, mirroring the existing
   * `store`/`runs`/`sessions` convention — auditing itself is not optional,
   * and there is no configuration that turns it off. Supplying this REPLACES
   * the default entirely, index half included: a caller handing in its own
   * port owns what that port writes.
   */
  readonly auditPort?: M3LHumanActionAuditPort;
  /**
   * The X8 telemetry rollup port (mirrors {@link audit}). When absent,
   * {@link M3LConsoleRuntime.telemetry} falls back to the no-op recorder.
   */
  readonly telemetry?: M3LConsoleTelemetryRepository;
}

/**
 * The console server's resolved runtime: its boot-time configuration, the
 * logger every other layer writes through, and the composed request
 * listener.
 *
 * @example
 * ```ts
 * function describe(runtime: M3LConsoleRuntime): string {
 *   return `operator: ${runtime.config.operatorName}`;
 * }
 * ```
 */
export interface M3LConsoleRuntime {
  /** The resolved boot-time configuration. */
  readonly config: M3LConsoleConfig;
  /** The logger the rest of the server writes through. */
  readonly logger: Core.M3LLogger;
  /** The single operator profile resolved from configuration at boot. */
  readonly operator: M3LOperatorProfile;
  /** The ADR-0071 auth seam, resolved to {@link operator} for every request. */
  readonly operatorProvider: M3LOperatorProvider;
  /**
   * The compiled router built from `options.routes` verbatim — reflects
   * exactly what the caller registered, for introspection. The built-in
   * health routes are dispatched by {@link requestListener} but are
   * deliberately NOT reflected here (see `buildDispatchRouter`'s TSDoc).
   */
  readonly router: M3LRouter;
  /** The `node:http` request listener; dispatches through the built-in health routes plus {@link router}'s routes. */
  readonly requestListener: M3LConsoleRequestListener;
  /**
   * The ADR-0049 drain controller every in-flight request is tracked
   * against. Exposed so a caller (or `/ready`) can read its `state` without
   * threading a second reference through.
   */
  readonly drain: M3LDrainController;
  /**
   * The drain signal threaded into every in-flight request context
   * (ADR-0049). Equivalent to `drain.signal`.
   */
  readonly signal: AbortSignal;
  /**
   * The ADR-0071 deferred readiness grace period, threaded verbatim from
   * {@link M3LConsoleConfig.readinessGraceMs} into `lifecycle/shutdown.ts`'s
   * `M3LShutdownRuntime`, which this interface structurally satisfies.
   */
  readonly readinessGraceMs: number;
  /**
   * The opened console store (ADR-0069), when `options.store` supplied one
   * — narrowed to its {@link M3LConsoleStoreLifecycle} view: this composition
   * root has no business issuing queries itself, so the full
   * {@link M3LConsoleStoreHandle} (which carries the SQL query surface) never
   * republishes past this field.
   */
  readonly store?: M3LConsoleStoreLifecycle;
  /**
   * The wired X4 run subsystem, present only when a runs config resolved AND
   * {@link M3LConsoleRuntimeOptions.runs} was supplied. Satisfies
   * `lifecycle/shutdown.ts`'s `M3LShutdownDrainable` structurally, so its
   * `drain()` runs alongside the HTTP drain with no `runs/` import there.
   */
  readonly runs?: M3LRunSubsystem;
  /**
   * The wired X6 session subsystem, present only when
   * {@link M3LConsoleRuntimeOptions.sessions} was supplied AND {@link runs}
   * built successfully (a session step launches a run through
   * `runs.orchestrator`). Mirrors {@link runs}'s own "present only when its
   * own preconditions were met" semantics.
   */
  readonly sessions?: M3LSessionSubsystem;
  /**
   * The X8 telemetry recorder — ALWAYS present, so callers never need an
   * `undefined` check. Store-backed when
   * {@link M3LConsoleRuntimeOptions.telemetry} was supplied, else no-op.
   */
  readonly telemetry: M3LTelemetryRecorder;
}
