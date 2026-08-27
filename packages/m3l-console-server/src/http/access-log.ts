/**
 * `http/access-log` — owns the console's single-outcome-line-per-request
 * access log and the fault diagnostic line that accompanies a genuine
 * failure (ADR-0070's display-vs-persist split: only the fixed generic
 * envelope message ever reaches the caller, so the real cause is recorded
 * here instead).
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import { isFaultError } from "./envelope.js";
import type { M3LRouteAuth } from "./router.js";

/** The status below which a response is logged at `info`. */
const STATUS_CLIENT_ERROR_THRESHOLD = 400;
/** The status at and above which a response is logged at `error`. */
const STATUS_SERVER_ERROR_THRESHOLD = 500;

/** The three log levels a request outcome is ever recorded at. */
function logLevelForStatus(status: number): "error" | "warning" | "info" {
  if (status >= STATUS_SERVER_ERROR_THRESHOLD) return "error";
  if (status >= STATUS_CLIENT_ERROR_THRESHOLD) return "warning";
  return "info";
}

/** Fields logged for exactly one line per request — never headers, query, or body. */
export interface RequestOutcome {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly correlationId: string;
  readonly accessMode: M3LRouteAuth | undefined;
}

/** Logs the single outcome line for a request, at the level its status implies. */
export function logOutcome(
  logger: Core.M3LLogger,
  outcome: RequestOutcome,
): void {
  const message = `${outcome.method} ${outcome.path} -> ${String(outcome.status)}`;
  const data = {
    method: outcome.method,
    path: outcome.path,
    status: outcome.status,
    durationMs: outcome.durationMs,
    correlationId: outcome.correlationId,
    ...(outcome.accessMode !== undefined && { accessMode: outcome.accessMode }),
  };

  const level = logLevelForStatus(outcome.status);
  if (level === "error") {
    logger.error(message, data);
  } else if (level === "warning") {
    logger.warning(message, data);
  } else {
    logger.info(message, data);
  }
}

/** Context for {@link logDiagnosticIfFault} — never the query string, headers, or body. */
export interface RequestFaultContext {
  readonly method: string;
  readonly path: string;
  readonly correlationId: string;
}

/**
 * Emits a diagnostic `ERROR` line via {@link Core.M3LLogger.errorFrom} for a
 * genuine fault — but never for a routine non-fault outcome (a bad request,
 * an unauthenticated/not-found/method-not-allowed lookup, or a drain
 * refusal) — so the real cause behind a handler/middleware throw is
 * recorded somewhere, even though only the fixed generic envelope message
 * ever reaches the caller (ADR-0070's display-vs-persist split; see
 * {@link isFaultError}). The gate is "is this a fault", not "is this
 * caller-origin": a drain refusal (`ERR_CONSOLE_UNAVAILABLE`) is
 * `origin: "library"` yet not a fault, so gating on origin alone would emit
 * a spurious error-level line for every request refused during an ordinary
 * shutdown. Gating on fault also keeps a caller from remotely steering log
 * severity by choosing which routine error to trigger. The message carries
 * only the correlation id, method, and normalized path — never the query
 * string, headers, or body.
 */
export function logDiagnosticIfFault(
  logger: Core.M3LLogger,
  error: unknown,
  context: RequestFaultContext,
): void {
  if (!isFaultError(error)) return;
  logger.errorFrom(
    error,
    `unhandled failure handling ${context.method} ${context.path} (correlationId=${context.correlationId})`,
  );
}
