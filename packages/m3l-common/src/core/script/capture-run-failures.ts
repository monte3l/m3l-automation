/**
 * `core/script/capture-run-failures` — composes a failure-recording `onError`
 * onto a script's declared lifecycle hooks, so a caller driving a run can see
 * what it threw without wrapping the run body.
 *
 * It lives in `core/script`, not `core/cli-contract`, because it names
 * {@link M3LScriptLifecycleHooks} — a type the ADR-0009 layering zone forbids
 * any other `core/**` module from naming, even via `import type`.
 *
 * @packageDocumentation
 */

import type { M3LScriptLifecycleHooks } from "./M3LScriptOptions.js";

/**
 * The hooks bag plus the live failure buffer {@link captureRunFailures}
 * returns.
 *
 * @example
 * ```ts
 * import { captureRunFailures } from "@m3l-automation/m3l-common/core";
 * import type { M3LCapturedRunFailures } from "@m3l-automation/m3l-common/core";
 *
 * const capture: M3LCapturedRunFailures = captureRunFailures(hooks);
 * ```
 */
export interface M3LCapturedRunFailures {
  /** The caller's hooks with a capturing `onError` composed onto them. */
  readonly hooks: M3LScriptLifecycleHooks;
  /**
   * The **live** buffer the composed hook pushes into — not a snapshot. A
   * caller takes this reference before the run starts and reads it after the
   * run finishes, so a defensive copy would always be empty.
   */
  readonly failures: readonly unknown[];
}

/**
 * Wraps `hooks` with an `onError` that records every pipeline failure into the
 * returned {@link M3LCapturedRunFailures.failures} array.
 *
 * The capture MUST go through `onError` rather than a `try`/`catch` around the
 * run body: `mainFn` is stage 7 of `M3LScript`'s nine-stage pipeline, and
 * stages 1-6, 8 and 9 throw outside it — `config-load` (a missing or invalid
 * parameter, by far the most common real failure) most of all.
 * `M3LScript.runWithErrorHandling` invokes `onError` for EVERY stage's error
 * before re-throwing, and isolates it best-effort, so this capture observes
 * exactly the value `runScript` classifies and can never shadow it.
 *
 * Composition, never replacement: the caller's own `onError` is still invoked
 * with the same `(ctx, error)` arguments, and its return value is handed back
 * — so an async error handler is still awaited by the pipeline. The capture
 * runs *first*, so the caller's hook already sees its own failure recorded.
 * The caller's hooks bag is not mutated.
 *
 * @param hooks - The script's own declared hooks, or nothing.
 * @returns The composed hooks and the live failure buffer.
 *
 * @example
 * ```ts
 * import { captureRunFailures, runScript } from "@m3l-automation/m3l-common/core";
 *
 * const capture = captureRunFailures(hooks);
 * const script = new M3LScript({ metadata, hooks: capture.hooks });
 * await runScript(script, () => runMain(script));
 * // `capture.failures` now holds every error the pipeline raised.
 * ```
 */
export function captureRunFailures(
  hooks?: M3LScriptLifecycleHooks,
): M3LCapturedRunFailures {
  const failures: unknown[] = [];
  return {
    failures,
    hooks: {
      ...hooks,
      onError: (ctx, error) => {
        failures.push(error);
        return hooks?.onError?.(ctx, error);
      },
    },
  };
}
