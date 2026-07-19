import { Core } from "@m3l-automation/m3l-common";

/**
 * The correlation id captured by `onBeforeRun`, module-local to this file.
 *
 * `M3LScript.run`'s `mainFn` takes no arguments (it has no `ctx`), so the
 * per-run correlation id — always resolved by the time `onBeforeRun`
 * fires — is captured here and read back by `main.ts` via
 * {@link getCorrelationId}. `onBeforeRun` always runs (and re-resolves this
 * value) before `mainFn` on every `run()` call, including a warm Lambda
 * invocation reusing this module.
 */
let capturedCorrelationId: string | undefined;

/**
 * Returns the correlation id captured by the most recent `onBeforeRun`
 * invocation.
 *
 * @returns The current run's correlation id.
 * @throws {@link Core.M3LError} When called before `onBeforeRun` has run
 *   (a composition-root wiring bug, not a runtime condition).
 *
 * @example
 * ```typescript
 * import { getCorrelationId } from "./hooks.js";
 *
 * // called from main.ts inside `script.run(async () => { ... })`,
 * // after `onBeforeRun` has already fired
 * const correlationId = getCorrelationId();
 * ```
 */
export function getCorrelationId(): string {
  if (capturedCorrelationId === undefined) {
    throw new Core.M3LError(
      "correlationId not yet captured — onBeforeRun has not run",
      { code: "ERR_EVENTBRIDGE_SCHEDULES_NO_CORRELATION_ID" },
    );
  }
  return capturedCorrelationId;
}

/**
 * Lifecycle hooks for `eventbridge-schedules`. All eight hooks are optional
 * and run in the fixed order documented in `docs/reference/core/script.md`.
 * `onBeforeRun` captures `ctx.correlationId` into this module's holder so
 * the composition root (`main.ts`) can thread it into
 * `runEventbridgeSchedules`, since `mainFn` itself receives no hook context.
 */
export const hooks: Core.M3LScriptLifecycleHooks = {
  onBeforeRun: (ctx) => {
    capturedCorrelationId = ctx.correlationId;
  },
};
