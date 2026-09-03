/**
 * `telemetry/no-op` — {@link createNoOpTelemetryRecorder}, the inert
 * {@link "./port.js".M3LTelemetryRecorder} every call site added by PRs
 * 2b–3c is wired against before any store-backed recorder or enable/disable
 * config exists. `M3LConsoleRuntimeOptions.store` is optional, so a
 * storeless console still has to hand its collaborators a recorder that
 * satisfies the port — this is that recorder.
 *
 * @packageDocumentation
 */

import type { M3LTelemetryRecorder } from "./port.js";

/**
 * Creates a {@link M3LTelemetryRecorder} whose five methods are all empty
 * bodies: every call is accepted and immediately discarded.
 *
 * @returns A fresh, independent no-op recorder. Each call returns a new
 * instance; none of the methods mutate any state, so sharing one across
 * callers is safe but never required.
 * @example
 * ```ts
 * import { createNoOpTelemetryRecorder } from "@m3l-automation/m3l-console-server/telemetry/no-op.js";
 *
 * const telemetry = createNoOpTelemetryRecorder();
 * // Safe to call from any code path before a store exists — never throws.
 * telemetry.httpRequest({ route: "/api/v1/runs", outcome: "2xx", latencyMs: 12 });
 * ```
 */
export function createNoOpTelemetryRecorder(): M3LTelemetryRecorder {
  return {
    httpRequest: () => undefined,
    runFinished: () => undefined,
    sseStream: () => undefined,
    policyDecision: () => undefined,
    storeHealth: () => undefined,
  };
}
