/**
 * `boot/logging` — how the composition root builds its logger, and the fixed
 * set of lines a boot and a shutdown emit through it.
 *
 * Extracted verbatim from `main.ts` so the composition root stays readable as
 * a wiring narrative rather than a mix of wiring and log-line plumbing
 * (the same extraction shape `sessions/launch-parameters.ts` applied to the
 * session service). Nothing here binds a socket, reads the environment, or
 * decides policy: every function takes already-resolved values and writes one
 * line.
 *
 * {@link createRuntimeLogger} is the security-relevant one — it is the single
 * place the console's extra secret-name vocabulary is attached to a logger, so
 * every later layer that writes through the runtime's logger inherits that
 * redaction structurally.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LConsoleConfig } from "../config/env.js";
import type { M3LDrainOutcome } from "../lifecycle/drain.js";
import type { M3LListeningServer } from "../lifecycle/http-server.js";
import type { M3LConsoleStoreHandle } from "../store/store.js";

/**
 * Builds this runtime's default log sinks: a single JSON-lines handler
 * floored at `logLevel`.
 */
function buildDefaultHandlers(
  logLevel: Core.M3LLogLevelFloor,
): readonly Core.M3LLoggerHandler[] {
  return [new Core.M3LJsonLoggerHandler({ minLevel: logLevel })];
}

/**
 * Names the config/context fields this runtime's logger treats as secret, on
 * top of `M3LLogger`'s built-in key-name heuristic. `operatorEmail`/`email`
 * is NOT in the library's built-in `SENSITIVE_KEY_NAMES` set
 * (`core/logging/redact.ts`), so without this port, a later layer doing
 * something as ordinary as `logger.info(msg, { ...runtime.config })` would
 * print the operator's email verbatim — {@link M3LConsoleConfig.operatorEmail}'s
 * "Never logged" TSDoc would then be convention, not a control. Wiring this
 * once here, at the logger's construction, makes the guarantee structural
 * for every later slice that writes through this logger, not just the
 * boot-line log call in {@link logPosture}.
 *
 * `headers`/`cookie` are the same structural fix applied to a second leak:
 * `M3LRequestContext` (`http/context.ts`) now carries the inbound request
 * headers, and MEASURED behavior of `M3LLogger`'s redaction is that it
 * recurses and DOES redact a nested `authorization` header (it is in the
 * library's `SENSITIVE_KEY_NAMES`), but `cookie` is NOT in that set and
 * would leak an operator's session cookie verbatim. Naming `"headers"`
 * redacts the whole object regardless of which keys it happens to contain;
 * naming `"cookie"` also catches a cookie value hoisted to a top-level field
 * by some future call site. The library's key-name heuristic cannot know a
 * consumer's vocabulary — which is exactly what `M3LSecretNamesPort` exists
 * for.
 *
 * `sql`/`parameters`/`bindings`/`expandedSQL` are the same structural fix
 * for the ADR-0069 store: a repository logging a failed query's context as
 * ordinary as `logger.error(msg, { sql, parameters })` must never print the
 * raw SQL, its bound parameters/bindings, or its interpolated `expandedSQL`
 * form — the sqlite driver's own TSDoc documents `expandedSQL` as
 * interpolating bound values, so it is never loggable. `query`/`statement`
 * (near-synonyms for `sql`) and `params`/`values`/`args` (near-synonyms for
 * `parameters`/`bindings`) round out the same store vocabulary: a security
 * probe measured all five leaking verbatim through the real logger, and
 * `params` in particular is an entirely ordinary shorthand at a real call
 * site, not an exotic one this port can afford to skip.
 */
const RUNTIME_SECRET_NAMES: ReadonlySet<string> = new Set([
  "operatorEmail",
  "email",
  "headers",
  "cookie",
  "sql",
  "parameters",
  "bindings",
  "expandedSQL",
  "query",
  "statement",
  "params",
  "values",
  "args",
]);

const runtimeSecrets: Core.M3LSecretNamesPort = {
  isSecret: (name) => RUNTIME_SECRET_NAMES.has(name),
};

/**
 * Builds the logger the rest of the console server writes through: floored at
 * the resolved {@link M3LConsoleConfig.logLevel} and carrying the console's
 * own secret-name vocabulary (see {@link RUNTIME_SECRET_NAMES}).
 *
 * @param config - The resolved boot configuration.
 * @param handlers - Log sinks to fan out to; defaults to a single
 *   {@link Core.M3LJsonLoggerHandler} floored at `config.logLevel` — a
 *   daemon's output is machine-read, so JSON lines rather than the pretty
 *   console handler.
 * @returns The runtime logger.
 *
 * @example
 * ```ts
 * const logger = createRuntimeLogger(config);
 * logger.info("ready");
 * ```
 */
export function createRuntimeLogger(
  config: M3LConsoleConfig,
  handlers?: readonly Core.M3LLoggerHandler[],
): Core.M3LLogger {
  return new Core.M3LLogger(handlers ?? buildDefaultHandlers(config.logLevel), {
    minLevel: config.logLevel,
    secrets: runtimeSecrets,
  });
}

/**
 * Emits the one posture line every boot logs: the resolved host, port,
 * operator name, drain timeout, log level, and telemetry recorder backend.
 * The operator email is deliberately never included — it is caller PII, and
 * the library does not log caller data by default.
 *
 * The telemetry backend rides on this same line rather than a second event:
 * unlike `runs`/`sessions`, whose absence surfaces as missing routes, a
 * no-op recorder is behaviourally invisible — nothing else distinguishes
 * "recording" from "silently discarding forever" — so this is the only
 * boot-time signal that a caller who supplied `store` but forgot
 * `telemetry: store.telemetry` has lost telemetry permanently.
 *
 * @param logger - The runtime logger.
 * @param config - The resolved boot configuration.
 * @param telemetryBackend - Which recorder implementation was resolved:
 *   `"store"` when a telemetry repository was wired, `"no-op"` otherwise.
 *
 * @example
 * ```ts
 * logPosture(logger, config, "no-op");
 * ```
 */
export function logPosture(
  logger: Core.M3LLogger,
  config: M3LConsoleConfig,
  telemetryBackend: "store" | "no-op",
): void {
  logger.info("console server configuration resolved", {
    host: config.host,
    port: config.port,
    operatorName: config.operatorName,
    drainTimeoutMs: config.drainTimeoutMs,
    logLevel: config.logLevel,
    telemetryBackend,
  });
}

/**
 * Logs the one line every boot emits once the listener is verified. Never the
 * operator email.
 *
 * @param logger - The runtime logger.
 * @param server - The verified listening server.
 *
 * @example
 * ```ts
 * logListening(logger, server);
 * ```
 */
export function logListening(
  logger: Core.M3LLogger,
  server: M3LListeningServer,
): void {
  logger.info("console server listening", {
    host: server.host,
    port: server.port,
  });
}

/**
 * Logs the one line every shutdown emits once the drain has settled.
 *
 * @param logger - The runtime logger.
 * @param outcome - The settled drain outcome.
 *
 * @example
 * ```ts
 * logDrainCompletion(logger, outcome);
 * ```
 */
export function logDrainCompletion(
  logger: Core.M3LLogger,
  outcome: M3LDrainOutcome,
): void {
  logger.info("console server drain completed", {
    graceful: outcome.graceful,
    abandoned: outcome.abandoned,
    durationMs: outcome.durationMs,
  });
}

/**
 * Logs the one line every boot emits once the console store is confirmed open.
 *
 * @param logger - The runtime logger.
 * @param store - The opened console store.
 *
 * @example
 * ```ts
 * logStoreReady(logger, store);
 * ```
 */
export function logStoreReady(
  logger: Core.M3LLogger,
  store: M3LConsoleStoreHandle,
): void {
  logger.info("console store ready", {
    location: store.location,
    schemaVersion: store.schemaVersion,
  });
}
